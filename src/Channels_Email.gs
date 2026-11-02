/**
 * @fileoverview Email 指令信（M6）：owner 寄給自己、貼上標籤 agent/inbox 的信視為指令；回覆進同一 thread；thread id = session。
 *
 * 掃描由 queueTick 帶動：Script Property EMAIL_NEXT_SCAN 記下次掃描時間（Config email_scan_every_minutes，預設 5 分鐘），
 * 沒到就不開 Gmail（維持閒置零成本）。掃描：search `label:<inbox> from:<owner> newer_than:7d -is:starred`，
 * 每個 thread 裡「owner 寄的、尚未加星、不是 agent 自己回的」訊息各排一個 turn job，排完就加星（★ = 已處理）。
 * agent 的回覆用 thread.reply（寄件者是 owner 本人，顯示名稱 GAS Agent），送出後也加星，避免被當成指令。
 * 指令內文會去掉引用（> 開頭、On … wrote:）與簽名檔（-- 之後）。全部 Gmail 依賴可注入，測試不碰 Gmail。
 */

/** 指令信內文上限（避免整串引用塞爆 context）。 */
const EMAIL_COMMAND_MAX_CHARS = 8000;
/** 搜尋範圍。 */
const EMAIL_SEARCH_NEWER_THAN = '7d';
/** 一次掃描最多處理幾串。 */
const EMAIL_SCAN_MAX_THREADS = 20;
/** agent 回信的顯示名稱；掃描時用它排除自己的回覆。 */
const EMAIL_AGENT_SENDER_NAME = 'GAS Agent';

/**
 * 內文 → 指令：去引用、去簽名、截長。純函式。
 * @param {string} body getPlainBody()
 * @return {string}
 */
function extractEmailCommand_(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^--\s*$/.test(line)) break; // 簽名檔
    if (/^(On .+wrote:|.+於 .+寫道：|-----Original Message-----|---------- Forwarded message ---------)/.test(line.trim())) break;
    if (/^\s*>/.test(line)) continue; // 引用
    out.push(line);
  }
  return truncateText_(out.join('\n').trim(), EMAIL_COMMAND_MAX_CHARS).text;
}

/**
 * 下次掃描時間旗標：enabled 且給 from 時寫 from（或現在）+ 間隔；from 為 null 表示停用 → 清掉。
 * @param {ChannelConfig} cfg
 * @param {?Date} from 以此為基準加間隔；傳 new Date(0) 可讓下一個 tick 立刻掃
 * @return {string} 寫入的 ISO（空 = 清掉）
 */
function refreshEmailNextScanProp_(cfg, from) {
  if (!cfg.emailEnabled || !from) { setProp_(PROP.EMAIL_NEXT_SCAN, ''); return ''; }
  const iso = from.toISOString();
  setProp_(PROP.EMAIL_NEXT_SCAN, iso);
  return iso;
}

/**
 * 確保標籤存在。
 * @param {string} name
 * @return {GoogleAppsScript.Gmail.GmailLabel}
 */
function ensureGmailLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/**
 * 預設的 Gmail 存取（可注入）。
 * @param {ChannelConfig} cfg
 * @return {{search: Function, star: Function}}
 */
function defaultEmailGmail_(cfg) {
  return {
    /** @return {!Array<{id: string, subject: string, messages: !Array<{id: string, from: string, date: Date, starred: boolean, body: string}>}>} */
    search: (query, max) => GmailApp.search(query, 0, max).map((t) => ({
      id: t.getId(), subject: t.getFirstMessageSubject(),
      messages: t.getMessages().map((m) => ({ id: m.getId(), from: m.getFrom(), date: m.getDate(), starred: m.isStarred(), body: m.getPlainBody() })),
    })),
    star: (messageId) => GmailApp.getMessageById(messageId).star(),
  };
}

/**
 * 該 thread 目前 active 的 email session。
 * @param {string} threadId
 * @param {!Object} store
 * @return {?SessionRow}
 */
function emailSession_(threadId, store) {
  return store.listRecent(200, 'email').find((s) => s.status === 'active' && s.external_id === String(threadId)) || null;
}

/**
 * 掃一次收件匣：把未處理的指令信各排一個 turn job 並加星。
 * @param {{cfg: ChannelConfig, ownerEmail: string, gmail: Object, sessionStore: Object, enqueue: Function, now: (Function|undefined)}} deps
 *   gmail = defaultEmailGmail_ 介面；enqueue(type, payload, sessionId)
 * @return {{scanned: number, enqueued: !Array<{jobId: string, threadId: string, subject: string}>, skipped: number}}
 */
function scanEmailInbox_(deps) {
  const cfg = deps.cfg;
  const owner = normalizeEmail_(deps.ownerEmail);
  const report = { scanned: 0, enqueued: [], skipped: 0 };
  if (!cfg.emailEnabled || !owner) return report;
  const query = `label:${cfg.emailInboxLabel.replace(/\s/g, '-')} from:${owner} newer_than:${EMAIL_SEARCH_NEWER_THAN} -is:starred`;
  const threads = deps.gmail.search(query, EMAIL_SCAN_MAX_THREADS);
  threads.forEach((t) => {
    report.scanned++;
    const fromOwner = (m) => normalizeEmail_(/<([^>]+)>/.exec(m.from) ? /<([^>]+)>/.exec(m.from)[1] : m.from) === owner;
    const isAgent = (m) => String(m.from || '').indexOf(EMAIL_AGENT_SENDER_NAME) !== -1;
    const todo = t.messages.filter((m) => !m.starred && fromOwner(m) && !isAgent(m)).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    if (!todo.length) { report.skipped++; return; }
    const session = emailSession_(t.id, deps.sessionStore);
    todo.forEach((m) => {
      const message = extractEmailCommand_(m.body) || String(t.subject || '').trim();
      // 先加星再排隊：就算 enqueue 失敗也不會每分鐘重送同一封。
      deps.gmail.star(m.id);
      if (!message) { report.skipped++; return; }
      const job = deps.enqueue('turn', {
        message, channel: 'email', mode: 'interactive', external_id: t.id, email_thread_id: t.id, email_message_id: m.id,
        email_subject: String(t.subject || ''),
      }, session ? session.id : '');
      report.enqueued.push({ jobId: job.id, threadId: t.id, subject: String(t.subject || '') });
    });
  });
  return report;
}

/**
 * queueTick 用：到期就掃一次並把旗標推到下一次。
 * @param {{now: (Function|undefined), cfg: (ChannelConfig|undefined), gmail: (Object|undefined), sessionStore: (Object|undefined), enqueue: (Function|undefined), ownerEmail: (string|undefined)}} deps
 * @return {?Object} scanEmailInbox_ 的報告；未到期回 null
 */
function emailScanIfDue_(deps) {
  deps = deps || {};
  const nowMs = deps.now ? deps.now() : Date.now();
  const next = getProp_(PROP.EMAIL_NEXT_SCAN);
  if (!next || new Date(next).getTime() > nowMs) return null;
  const cfg = deps.cfg || getChannelConfig_();
  let report;
  try {
    report = scanEmailInbox_({
      cfg, ownerEmail: deps.ownerEmail || getOwnerEmail_(), gmail: deps.gmail || defaultEmailGmail_(cfg),
      sessionStore: deps.sessionStore || sheetSessionStore_(), enqueue: deps.enqueue || ((type, payload, sid) => enqueue_(type, payload, sid)),
    });
  } finally {
    refreshEmailNextScanProp_(cfg, new Date(nowMs + cfg.emailScanEveryMinutes * 60000));
  }
  return report;
}

/**
 * Queue job 結束後回覆到同一 thread（寄件者 owner、顯示名稱 GAS Agent），送出後把自己的回覆加星。
 * @param {string} threadId
 * @param {!Object} result summarizeTurnResult_ 摘要
 * @param {{replyEmail: (Function|undefined)}=} deps replyEmail(threadId, text)
 * @return {{ok: boolean}}
 */
function deliverTurnToEmail_(threadId, result, deps) {
  deps = deps || {};
  const text = channelReplyText_(result, { approvalHint: '請到管理頁「紀錄 → 審批」批准或拒絕。' });
  const reply = deps.replyEmail || ((tid, body) => {
    const thread = GmailApp.getThreadById(tid);
    if (!thread) throw new Error(`找不到 thread ${tid}`);
    thread.reply(body, { name: EMAIL_AGENT_SENDER_NAME });
    const msgs = thread.getMessages();
    if (msgs.length) msgs[msgs.length - 1].star();
  });
  reply(threadId, text);
  return { ok: true };
}
