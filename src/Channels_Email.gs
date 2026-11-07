/**
 * @fileoverview Email 指令信（M6）：owner 寄給自己、貼上標籤 agent/inbox 的信視為指令；回覆進同一 thread；thread id = session。
 *
 * 掃描由 queueTick 帶動：Script Property EMAIL_NEXT_SCAN 記下次掃描時間（Config email_scan_every_minutes，預設 5 分鐘），
 * 沒到就不開 Gmail（維持閒置零成本）。掃描：search `label:<inbox> from:<owner> newer_than:7d -is:starred`，
 * 每個 thread 裡「owner 寄的、尚未加星、不是 agent 自己回的」訊息各排一個 turn job，排完就加星（★ = 已處理）。
 * agent 的回覆用 thread.reply（寄件者是 owner 本人，顯示名稱 Config email_sender_name，預設 GAS Agent），送出後也加星，避免被當成指令；
 * 沒有文字結果也沒有待審批 / 續跑要講的輪次不回信。
 * 指令內文會去掉引用（> 開頭、On … wrote:）與簽名檔（-- 之後）。全部 Gmail 依賴可注入，測試不碰 Gmail。
 *
 * 委託寄件者（Telegram /owner <email> <passkey>）：Script Property EMAIL_DELEGATE_KEYS 存 JSON {email: passkey}。
 * 掃描時每位委託者另搜 `from:<email> newer_than:7d -is:starred`（不要求標籤，對方貼不到 owner 的標籤），
 * 只有主旨或內文含 passkey 的信才算指令：去掉 passkey 後等同 owner 的指令排進 Queue（payload 帶 email_delegate），
 * 回覆仍回同一 thread（對方會收到）。沒帶 passkey 的信不理也不加星（From 可偽造，passkey 才是驗證）。
 */

/** 指令信內文上限（避免整串引用塞爆 context）。 */
const EMAIL_COMMAND_MAX_CHARS = 8000;
/** 搜尋範圍。 */
const EMAIL_SEARCH_NEWER_THAN = '7d';
/** 一次掃描最多處理幾串。 */
const EMAIL_SCAN_MAX_THREADS = 20;
/** agent 回信的顯示名稱；掃描時用它排除自己的回覆。 */
/** 預設寄件者顯示名稱；實際用 Config email_sender_name（cfg.emailSenderName）。 */
const EMAIL_AGENT_SENDER_NAME = 'GAS Agent';
/** 委託寄件者 passkey 長度限制。 */
const EMAIL_DELEGATE_PASSKEY_MIN = 6;
const EMAIL_DELEGATE_PASSKEY_MAX = 64;
/** 自動產生的 passkey 長度。 */
const EMAIL_DELEGATE_PASSKEY_GEN = 12;

/**
 * 委託寄件者表：{email(小寫): passkey}。壞 JSON 當空。
 * @return {!Object<string, string>}
 */
function getEmailDelegates_() {
  const raw = getProp_(PROP.EMAIL_DELEGATE_KEYS);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out = {};
    Object.keys(o).forEach((k) => { const e = normalizeEmail_(k); if (e && typeof o[k] === 'string' && o[k]) out[e] = o[k]; });
    return out;
  } catch (err) { return {}; }
}

/**
 * 寫回委託寄件者表；空表 = 刪掉 property。
 * @param {!Object<string, string>} map
 */
function setEmailDelegates_(map) {
  const tmp = {};
  Object.keys(map || {}).forEach((k) => { const e = normalizeEmail_(k); if (e && map[k]) tmp[e] = String(map[k]); });
  const out = {};
  Object.keys(tmp).sort().forEach((e) => { out[e] = tmp[e]; });
  setProp_(PROP.EMAIL_DELEGATE_KEYS, Object.keys(out).length ? JSON.stringify(out) : '');
}

/**
 * 檢查 passkey：6–64 字元、不含空白（信裡要能整段比對）。
 * @param {string} passkey
 * @return {string} 正規化後的 passkey
 */
function validateDelegatePasskey_(passkey) {
  const p = String(passkey || '').trim();
  if (p.length < EMAIL_DELEGATE_PASSKEY_MIN || p.length > EMAIL_DELEGATE_PASSKEY_MAX) throw new Error(`passkey 需 ${EMAIL_DELEGATE_PASSKEY_MIN}–${EMAIL_DELEGATE_PASSKEY_MAX} 字元。`);
  if (/\s/.test(p)) throw new Error('passkey 不能含空白。');
  return p;
}

/** @return {string} 隨機 passkey（小寫字母數字）。 */
function newDelegatePasskey_() {
  return newWebhookSecret_().slice(0, EMAIL_DELEGATE_PASSKEY_GEN);
}

/**
 * 委託寄件者 email 檢查：完整 email（不接受 *@domain）、不能是 owner。
 * @param {string} email
 * @param {string=} ownerEmail
 * @return {string} 小寫 email
 */
function validateDelegateEmail_(email, ownerEmail) {
  const e = normalizeEmail_(String(email || '').replace(/^<|>$/g, ''));
  if (!EMAIL_RE.test(e) || e.indexOf('*') !== -1) throw new Error(`「${email}」不是合法的 email（要完整信箱，不接受 *@domain）。`);
  if (ownerEmail && e === normalizeEmail_(ownerEmail)) throw new Error('owner 自己寄的信本來就是指令（貼標籤即可），不必設為委託寄件者。');
  return e;
}

/**
 * 新增 / 更換委託寄件者。passkey 空 → 自動產生。
 * @param {string} email
 * @param {string=} passkey
 * @param {{ownerEmail: (string|undefined), get: (Function|undefined), set: (Function|undefined), audit: (Function|undefined), by: (string|undefined)}=} deps
 * @return {{email: string, passkey: string, generated: boolean, existed: boolean, total: number}}
 */
function upsertEmailDelegate_(email, passkey, deps) {
  deps = deps || {};
  const e = validateDelegateEmail_(email, deps.ownerEmail);
  const generated = !String(passkey || '').trim();
  const p = generated ? newDelegatePasskey_() : validateDelegatePasskey_(passkey);
  const map = (deps.get || getEmailDelegates_)();
  const existed = !!map[e];
  map[e] = p;
  (deps.set || setEmailDelegates_)(map);
  const total = Object.keys(map).length;
  securityAudit_(`email_delegate:${existed ? 'update' : 'add'}`, `委託寄件者 ${e}${generated ? '（自動產生 passkey）' : ''}${deps.by ? '（' + deps.by + '）' : ''}→ 共 ${total} 位`, deps.audit);
  return { email: e, passkey: p, generated, existed, total };
}

/**
 * 移除委託寄件者。
 * @param {string} email
 * @param {{get: (Function|undefined), set: (Function|undefined), audit: (Function|undefined), by: (string|undefined)}=} deps
 * @return {{email: string, removed: boolean, total: number}}
 */
function deleteEmailDelegate_(email, deps) {
  deps = deps || {};
  const e = normalizeEmail_(String(email || '').replace(/^<|>$/g, ''));
  const map = (deps.get || getEmailDelegates_)();
  const removed = !!map[e];
  if (removed) {
    delete map[e];
    (deps.set || setEmailDelegates_)(map);
    securityAudit_('email_delegate:delete', `移除委託寄件者 ${e}${deps.by ? '（' + deps.by + '）' : ''}→ 共 ${Object.keys(map).length} 位`, deps.audit);
  }
  return { email: e, removed, total: Object.keys(map).length };
}

/**
 * 把 passkey 從文字中去掉（所有出現處），順手收掉多餘空行。純函式。
 * @param {string} text
 * @param {string} passkey
 * @return {string}
 */
function stripEmailPasskey_(text, passkey) {
  let s = String(text || '');
  if (passkey) s = s.split(passkey).join('');
  return s.split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

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
 * @param {{cfg: ChannelConfig, ownerEmail: string, gmail: Object, sessionStore: Object, enqueue: Function, now: (Function|undefined), delegates: (Object|undefined)}} deps
 *   delegates：{email: passkey}，未給則讀 Script Property；傳 {} 可停用委託掃描
 *   gmail = defaultEmailGmail_ 介面；enqueue(type, payload, sessionId)
 * @return {{scanned: number, enqueued: !Array<{jobId: string, threadId: string, subject: string}>, skipped: number}}
 */
function scanEmailInbox_(deps) {
  const cfg = deps.cfg;
  const owner = normalizeEmail_(deps.ownerEmail);
  const report = { scanned: 0, enqueued: [], skipped: 0, delegates: 0 };
  if (!cfg.emailEnabled || !owner) return report;
  const delegates = deps.delegates === undefined ? getEmailDelegates_() : (deps.delegates || {});
  const senderOf = (m) => normalizeEmail_(/<([^>]+)>/.exec(m.from) ? /<([^>]+)>/.exec(m.from)[1] : m.from);
  const senderName = (cfg.emailSenderName || EMAIL_AGENT_SENDER_NAME).trim();
  const isAgent = (m) => String(m.from || '').indexOf(senderName) !== -1;
  // sender：要處理的寄件者；passkey 非空 = 委託者，主旨或內文必須含 passkey 才算指令（去掉後排隊）。
  const processThreads = (threads, sender, passkey) => {
    threads.forEach((t) => {
      report.scanned++;
      const todo = t.messages.filter((m) => !m.starred && senderOf(m) === sender && !isAgent(m)).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      if (!todo.length) { report.skipped++; return; }
      let session = null;
      let sessionLooked = false;
      todo.forEach((m) => {
        const subject = String(t.subject || '').trim();
        let body = extractEmailCommand_(m.body);
        if (passkey) {
          if (body.indexOf(passkey) === -1 && subject.indexOf(passkey) === -1) { report.skipped++; return; } // 沒帶 passkey：不理、不加星
          body = stripEmailPasskey_(body, passkey);
        }
        const message = body || stripEmailPasskey_(subject, passkey);
        deps.gmail.star(m.id); // 先加星再排隊：就算 enqueue 失敗也不會重複處理
        if (!message) { report.skipped++; return; }
        if (!sessionLooked) { session = emailSession_(t.id, deps.sessionStore); sessionLooked = true; }
        const payload = { message, channel: 'email', mode: 'interactive', external_id: t.id, email_thread_id: t.id, email_message_id: m.id, email_subject: stripEmailPasskey_(subject, passkey), email_from: sender };
        if (passkey) payload.email_delegate = sender;
        const job = deps.enqueue('turn', payload, session ? session.id : '');
        report.enqueued.push({ jobId: job.id, threadId: t.id, subject: payload.email_subject, from: sender });
      });
    });
  };
  const label = cfg.emailInboxLabel.replace(/\s/g, '-');
  processThreads(deps.gmail.search(`label:${label} from:${owner} newer_than:${EMAIL_SEARCH_NEWER_THAN} -is:starred`, EMAIL_SCAN_MAX_THREADS), owner, '');
  Object.keys(delegates).sort().forEach((email) => {
    if (email === owner || !delegates[email]) return;
    report.delegates++;
    processThreads(deps.gmail.search(`from:${email} newer_than:${EMAIL_SEARCH_NEWER_THAN} -is:starred`, EMAIL_SCAN_MAX_THREADS), email, delegates[email]);
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
 * Queue job 結束後回覆到同一 thread（寄件者 owner、顯示名稱 Config email_sender_name），送出後把自己的回覆加星。
 * 沒有文字也沒有待審批 / 續跑 / 技能提案 → 不寄（回 skipped=true）。
 * @param {string} threadId
 * @param {!Object} result summarizeTurnResult_ 摘要
 * @param {{replyEmail: (Function|undefined)}=} deps replyEmail(threadId, text)
 * @return {{ok: boolean}}
 */
function deliverTurnToEmail_(threadId, result, deps) {
  deps = deps || {};
  const text = channelReplyText_(result, { approvalHint: '請到管理頁「紀錄 → 審批」批准或拒絕。', skipEmpty: true });
  if (!text) return { ok: true, skipped: true };
  const reply = deps.replyEmail || ((tid, body) => {
    const cfg = deps.cfg || getChannelConfig_();
    const thread = GmailApp.getThreadById(tid);
    if (!thread) throw new Error(`找不到 thread ${tid}`);
    thread.reply(body, { name: cfg.emailSenderName || EMAIL_AGENT_SENDER_NAME });
    const msgs = thread.getMessages();
    if (msgs.length) msgs[msgs.length - 1].star();
  });
  reply(threadId, text);
  return { ok: true, skipped: false };
}
