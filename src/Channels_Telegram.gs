/**
 * @fileoverview Telegram 通道（M6）：webhook（部署 B）入口 doPost、驗證、指令、排隊、回覆、審批 inline button。
 *
 * 部署 B 是「以我執行 / 任何人」的 Web App；Telegram 打 `<部署 B /exec>?src=telegram&key=<secret>`。
 * GAS 的 doPost 拿不到 HTTP header（Telegram 的 secret_token header 用不上），所以 secret 放 query string，
 * 再比對 message.from.id 白名單（Config telegram_allowed_user_ids）。回應一律 HtmlService 'ok'（ContentService 會 302，
 * Telegram 會一直重送）。doPost 只做：驗證 → 指令或排 Queue job → 立刻回「收到」。agent 由 queueTick 跑，
 * 結果經 deliverTurnToTelegram_ 送回；待審批的動作附「批准 / 拒絕」按鈕，按下走 callback_query → decideApproval_。
 *
 * 指令：/new（新 session）/status /model [provider id] /skills /help；其他文字（含 /<技能名>）原樣交給 runSessionTurn_。
 * 全部外部依賴（fetch、store、enqueue、decide）可注入，測試不打網路。
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** 單則訊息上限 4096；留餘裕。 */
const TELEGRAM_MESSAGE_MAX = 3900;
/** 每分鐘最多處理幾個 update（CacheService 計數，粗略即可）。 */
const TELEGRAM_RATE_PER_MINUTE = 30;
/** 收到訊息先回這句，再排隊。 */
const TELEGRAM_ACK_TEXT = '收到，處理中…（每分鐘排程會接手，結果回在這裡）';
/** 審批按鈕的 callback_data：apr:<approval id>:approve|deny（≤ 64 bytes）。 */
const TELEGRAM_CALLBACK_RE = /^apr:([A-Za-z0-9_-]+):(approve|deny)$/;
/** Telegram 專用的保留指令（其餘 /xxx 交給 runSessionTurn_，例如 /<技能名>）。 */
const TELEGRAM_COMMANDS = Object.freeze(['start', 'help', 'new', 'status', 'model', 'skills']);

// ---- Properties -------------------------------------------------------------------------------------

/** @return {string} */
function getTelegramToken_() { return getProp_(PROP.TELEGRAM_BOT_TOKEN); }

/** @param {string} token 空 = 刪除 */
function setTelegramToken_(token) {
  const t = String(token || '').trim();
  if (t && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(t)) throw new Error('Telegram bot token 格式不對（應像 123456789:AAH…）。');
  setProp_(PROP.TELEGRAM_BOT_TOKEN, t);
}

/** @return {string} */
function getTelegramSecret_() { return getProp_(PROP.TELEGRAM_WEBHOOK_SECRET); }

/** @return {string} 32 字元隨機 secret（a-z0-9） */
function newWebhookSecret_() {
  let s = '';
  try { s = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''); } catch (err) { s = ''; }
  while (s.length < 32) s += Math.random().toString(36).slice(2);
  return s.slice(0, 32).toLowerCase();
}

// ---- Telegram Bot API ---------------------------------------------------------------------------------

/**
 * 呼叫 Bot API。
 * @param {string} method 例 sendMessage
 * @param {!Object} payload
 * @param {{fetch: (Function|undefined), token: (string|undefined)}=} deps
 * @return {*} result 欄
 * @throws {Error} token 未設、HTTP 錯、ok=false
 */
function telegramApi_(method, payload, deps) {
  deps = deps || {};
  const token = deps.token !== undefined ? deps.token : getTelegramToken_();
  if (!token) throw new Error('Telegram bot token 未設定（管理頁「通道」分頁）。');
  const fetch = deps.fetch || ((url, opts) => UrlFetchApp.fetch(url, opts));
  const res = fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  let body = null;
  try { body = JSON.parse(res.getContentText()); } catch (err) { body = null; }
  if (code >= 300 || !body || !body.ok) {
    throw new Error(`Telegram ${method} 失敗（HTTP ${code}）：${body && body.description ? body.description : String(res.getContentText()).slice(0, 200)}`);
  }
  return body.result;
}

/**
 * 長文切成多則（先依空行 / 換行，再硬切）。純函式。
 * @param {string} text
 * @param {number=} max
 * @return {!Array<string>}
 */
function splitTelegramText_(text, max) {
  max = max || TELEGRAM_MESSAGE_MAX;
  const s = String(text || '').trim();
  if (!s) return ['（空）'];
  const out = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * 送文字（自動切段；按鈕只掛在最後一則）。
 * @param {string} chatId
 * @param {string} text
 * @param {{replyMarkup: (Object|undefined), replyTo: (number|undefined)}=} opts
 * @param {Object=} deps telegramApi_ 的 deps
 * @return {{messages: number}}
 */
function telegramSend_(chatId, text, opts, deps) {
  opts = opts || {};
  const chunks = splitTelegramText_(text);
  chunks.forEach((chunk, i) => {
    const payload = { chat_id: chatId, text: chunk, disable_web_page_preview: true };
    if (i === 0 && opts.replyTo) payload.reply_to_message_id = opts.replyTo;
    if (i === chunks.length - 1 && opts.replyMarkup) payload.reply_markup = opts.replyMarkup;
    telegramApi_('sendMessage', payload, deps);
  });
  return { messages: chunks.length };
}

/**
 * 待審批動作的 inline keyboard：每個 approval 一列「批准 / 拒絕」。純函式。
 * @param {!Array<{tool: string, approvalId: string}>} pending
 * @return {?Object} 沒有待審批回 null
 */
function telegramApprovalKeyboard_(pending) {
  const rows = (pending || []).filter((p) => p.approvalId).map((p) => [
    { text: `✅ 批准 ${p.tool}`, callback_data: `apr:${p.approvalId}:approve` },
    { text: `❌ 拒絕`, callback_data: `apr:${p.approvalId}:deny` },
  ]);
  return rows.length ? { inline_keyboard: rows } : null;
}

// ---- update 解析與驗證 ----------------------------------------------------------------------------------

/**
 * @typedef {{
 *   kind: ('message'|'callback'|'other'), updateId: number, chatId: string, userId: string, username: string,
 *   text: string, messageId: number, callbackId: string, callbackData: string, callbackMessageId: number
 * }} TelegramUpdate
 */

/**
 * Telegram update JSON → 精簡結構。純函式；非文字訊息（貼圖、照片…）kind='message' 但 text 為空。
 * @param {*} update
 * @return {TelegramUpdate}
 */
function parseTelegramUpdate_(update) {
  const u = update || {};
  const out = { kind: 'other', updateId: toNumber_(u.update_id, 0), chatId: '', userId: '', username: '', text: '', messageId: 0, callbackId: '', callbackData: '', callbackMessageId: 0 };
  const msg = u.message || u.edited_message || null;
  if (u.callback_query) {
    const cq = u.callback_query;
    out.kind = 'callback';
    out.callbackId = String(cq.id || '');
    out.callbackData = String(cq.data || '');
    out.userId = cq.from ? String(cq.from.id || '') : '';
    out.username = cq.from ? String(cq.from.username || '') : '';
    if (cq.message) { out.chatId = cq.message.chat ? String(cq.message.chat.id || '') : ''; out.callbackMessageId = toNumber_(cq.message.message_id, 0); }
    return out;
  }
  if (msg) {
    out.kind = 'message';
    out.chatId = msg.chat ? String(msg.chat.id || '') : '';
    out.userId = msg.from ? String(msg.from.id || '') : '';
    out.username = msg.from ? String(msg.from.username || '') : '';
    out.text = String(msg.text || msg.caption || '').trim();
    out.messageId = toNumber_(msg.message_id, 0);
  }
  return out;
}

/**
 * 驗證：query secret 相符、使用者在白名單。純函式。
 * @param {{key: string, secret: string, userId: string, allowed: !Array<string>, enabled: boolean}} p
 * @return {string} 空 = 通過；否則拒絕原因
 */
function telegramAuthorize_(p) {
  if (!p.enabled) return 'telegram_disabled';
  if (!p.secret || String(p.key || '') !== p.secret) return 'bad_secret';
  if (!p.userId) return 'no_user';
  if ((p.allowed || []).indexOf(String(p.userId)) === -1) return 'user_not_allowed';
  return '';
}

/**
 * 解析 Telegram 保留指令；其他（含 /<技能名>）回 command=''。純函式。
 * @param {string} text
 * @return {{command: string, rest: string}}
 */
function parseTelegramCommand_(text) {
  const m = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m || TELEGRAM_COMMANDS.indexOf(m[1].toLowerCase()) === -1) return { command: '', rest: String(text || '').trim() };
  return { command: m[1].toLowerCase(), rest: String(m[2] || '').trim() };
}

/**
 * 該 chat 目前 active 的 telegram session。
 * @param {string} chatId
 * @param {!Object} store session store
 * @return {?SessionRow}
 */
function telegramSession_(chatId, store) {
  return store.listRecent(200, 'telegram').find((s) => s.status === 'active' && s.external_id === String(chatId)) || null;
}

/**
 * 粗略速率限制：每分鐘 TELEGRAM_RATE_PER_MINUTE 個 update。CacheService 不可用時不限。
 * @return {boolean} true = 超量
 */
function telegramRateExceeded_() {
  try {
    const c = CacheService.getScriptCache();
    const key = 'tg:rate:' + Math.floor(Date.now() / 60000);
    const n = toNumber_(c.get(key), 0) + 1;
    c.put(key, String(n), 120);
    return n > TELEGRAM_RATE_PER_MINUTE;
  } catch (err) {
    return false;
  }
}

// ---- 主流程 ------------------------------------------------------------------------------------------

/**
 * 處理一個 update：驗證 → 指令 / 排隊 / 審批按鈕。所有副作用走 deps。
 * @param {*} rawUpdate Telegram update JSON
 * @param {{key: string, cfg: ChannelConfig, secret: string, sessionStore: Object, queueStore: Object, agentCfg: AgentConfig,
 *   send: Function, api: Function, enqueue: Function, decide: Function, providers: !Array<!Object>, skills: (Function|undefined),
 *   setConfig: (Function|undefined), now: (Function|undefined), rateExceeded: (Function|undefined)}} deps
 *   send(chatId, text, opts) / api(method, payload) / enqueue(type, payload, sessionId) / decide(approvalId, approve)
 * @return {{action: string, reason: string, jobId: string, sessionId: string, text: string}}
 */
function handleTelegramUpdate_(rawUpdate, deps) {
  const u = parseTelegramUpdate_(rawUpdate);
  const report = { action: '', reason: '', jobId: '', sessionId: '', text: '' };
  const denied = telegramAuthorize_({ key: deps.key, secret: deps.secret, userId: u.userId, allowed: deps.cfg.telegramAllowedUserIds, enabled: deps.cfg.telegramEnabled });
  if (denied) {
    // 不回任何訊息給非白名單的人（避免被拿來探測）；secret 錯直接忽略。
    report.action = 'rejected';
    report.reason = denied + (u.userId ? ` (user ${u.userId}${u.username ? ' @' + u.username : ''})` : '');
    return report;
  }
  if (u.kind === 'other') { report.action = 'ignored'; report.reason = 'unsupported_update'; return report; }
  if ((deps.rateExceeded || telegramRateExceeded_)()) { report.action = 'rejected'; report.reason = 'rate_limited'; return report; }
  if (!deps.cfg.telegramOwnerChatId && deps.setConfig && u.chatId) {
    try { deps.setConfig({ telegram_owner_chat_id: u.chatId }); } catch (err) { /* 忽略 */ }
  }
  const store = deps.sessionStore;
  const send = (text, opts) => deps.send(u.chatId, text, opts);

  // 審批按鈕
  if (u.kind === 'callback') {
    const m = TELEGRAM_CALLBACK_RE.exec(u.callbackData);
    if (!m) {
      try { deps.api('answerCallbackQuery', { callback_query_id: u.callbackId, text: '不認得這個按鈕' }); } catch (err) { /* 忽略 */ }
      report.action = 'ignored'; report.reason = 'bad_callback'; return report;
    }
    const approve = m[2] === 'approve';
    let text;
    try {
      const r = deps.decide(m[1], approve);
      text = approve
        ? `✅ 已批准 ${m[1]}${r.outcome ? (r.outcome.ok ? `，已執行（${r.outcome.ms} ms）` : `，但執行失敗：${r.outcome.status}`) : ''}${r.continuation ? '；agent 會接續回覆。' : '。'}`
        : `❌ 已拒絕 ${m[1]}${r.continuation ? '；agent 會接續回覆。' : '。'}`;
      report.action = approve ? 'approved' : 'denied';
    } catch (err) {
      text = `審批 ${m[1]} 失敗：${err && err.message || err}`;
      report.action = 'decide_failed'; report.reason = String(err && err.message || err);
    }
    try { deps.api('answerCallbackQuery', { callback_query_id: u.callbackId, text: text.slice(0, 180) }); } catch (err) { /* 忽略 */ }
    // 把原訊息的按鈕拿掉，避免重按。
    if (u.callbackMessageId) {
      try { deps.api('editMessageReplyMarkup', { chat_id: u.chatId, message_id: u.callbackMessageId, reply_markup: { inline_keyboard: [] } }); } catch (err) { /* 忽略 */ }
    }
    send(text);
    report.text = text;
    return report;
  }

  // 文字訊息
  if (!u.text) { send('目前只接受文字訊息。'); report.action = 'ignored'; report.reason = 'no_text'; return report; }
  const cmd = parseTelegramCommand_(u.text);
  const current = telegramSession_(u.chatId, store);
  report.sessionId = current ? current.id : '';

  if (cmd.command === 'start' || cmd.command === 'help') {
    const lines = ['GAS Agent 已連線。直接輸入任務即可，例如「找出本週收到關於 X 的信並整理成 Doc」。', '',
      '/new — 開新對話（session）', '/status — 目前 session', '/model [provider id] — 查看 / 指定這個 session 用的模型', '/skills — 列出可用技能；/<技能名> 訊息 直接套用技能', '/help — 這份說明',
      '', '待審批的動作會附「批准 / 拒絕」按鈮；其餘設定在管理頁。'];
    report.text = lines.join('\n'); send(report.text); report.action = 'help'; return report;
  }
  if (cmd.command === 'skills') {
    let names = [];
    try { names = deps.skills ? deps.skills() : []; } catch (err) { names = []; }
    report.text = names.length ? '可用技能：\n' + names.map((s) => `/${s.name} — ${s.description}`).join('\n') : '目前沒有啟用的技能（管理頁「技能」分頁）。';
    send(report.text); report.action = 'skills'; return report;
  }
  if (cmd.command === 'new') {
    if (current) closeSession_(current, { store, cfg: deps.agentCfg });
    const fresh = store.create({ channel: 'telegram', external_id: u.chatId, title: '' });
    report.sessionId = fresh.id;
    if (cmd.rest) {
      const job = deps.enqueue('turn', telegramTurnPayload_(cmd.rest, u), fresh.id);
      report.jobId = job.id;
      report.text = `已開新 session（${fresh.id}）。${TELEGRAM_ACK_TEXT}`;
    } else {
      report.text = `已開新 session（${fresh.id}）。`;
    }
    send(report.text); report.action = 'new'; return report;
  }
  if (cmd.command === 'status') {
    report.text = current
      ? `session ${current.id}：${current.turns} 輪，約 ${current.token_est} tokens，模型 ${current.model_override || '自動（main 備援鏈）'}，上次活動 ${fmtDate_(current.last_active)}。`
      : '目前沒有 session，送出第一則訊息就會建立。';
    send(report.text); report.action = 'status'; return report;
  }
  if (cmd.command === 'model') {
    const providers = (deps.providers || []).filter((p) => p.enabled && p.role !== 'embed');
    if (!cmd.rest) {
      report.text = `目前：${current && current.model_override ? current.model_override : '自動（main 備援鏈）'}\n可選：\n` + providers.map((p) => `• ${p.id}（${p.role} · ${p.model}）`).join('\n') + '\n\n/model <id> 指定，/model auto 回自動。';
      send(report.text); report.action = 'model'; return report;
    }
    const want = cmd.rest.trim().toLowerCase();
    if (want !== 'auto' && !providers.some((p) => p.id === want)) {
      report.text = `沒有 provider「${want}」。可選：${providers.map((p) => p.id).join(', ') || '（無）'}`;
      send(report.text); report.action = 'model_invalid'; return report;
    }
    const s = current || store.create({ channel: 'telegram', external_id: u.chatId });
    s.model_override = want === 'auto' ? '' : want;
    store.update(s);
    report.sessionId = s.id;
    report.text = `這個 session 的模型改為 ${want === 'auto' ? '自動（main 備援鏈）' : want}。`;
    send(report.text); report.action = 'model_set'; return report;
  }

  // 一般訊息（含 /<技能名>）：先回收到，再排隊
  send(TELEGRAM_ACK_TEXT, { replyTo: u.messageId });
  const job = deps.enqueue('turn', telegramTurnPayload_(u.text, u), current ? current.id : '');
  report.action = 'enqueued'; report.jobId = job.id; report.text = TELEGRAM_ACK_TEXT;
  return report;
}

/**
 * Telegram 來的 turn job payload。
 * @param {string} message
 * @param {TelegramUpdate} u
 * @return {!Object}
 */
function telegramTurnPayload_(message, u) {
  return { message, channel: 'telegram', mode: 'interactive', external_id: u.chatId, telegram_chat_id: u.chatId, telegram_message_id: u.messageId, telegram_user: u.username || u.userId };
}

/**
 * webhook 入口（部署 B）。永遠回 'ok'（HtmlService），錯誤記 AuditLog，避免 Telegram 重送。
 * @param {GoogleAppsScript.Events.DoPost} e
 * @return {GoogleAppsScript.HTML.HtmlOutput}
 */
function telegramWebhook_(e) {
  let report = null;
  try {
    const raw = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    const cfg = getChannelConfig_();
    report = handleTelegramUpdate_(raw, {
      key: (e && e.parameter && e.parameter.key) || '',
      cfg,
      secret: getTelegramSecret_(),
      sessionStore: sheetSessionStore_(),
      queueStore: sheetQueueStore_(),
      agentCfg: getAgentConfig_(),
      send: (chatId, text, opts) => telegramSend_(chatId, text, opts),
      api: (method, payload) => telegramApi_(method, payload),
      enqueue: (type, payload, sessionId) => enqueue_(type, payload, sessionId),
      decide: (id, approve) => decideApproval_(id, approve),
      providers: listProviders_(),
      skills: () => enabledSkills_(getSkillIndex_()),
      setConfig: (values) => setConfigValues_(values),
    });
  } catch (err) {
    report = { action: 'error', reason: String(err && err.stack || err && err.message || err) };
  }
  if (report && report.action !== 'enqueued' && report.action !== 'help' && report.action !== 'status') {
    try {
      appendTableRow_('AuditLog', { ts: new Date(), session_id: report.sessionId || '', tool: 'telegram:webhook', args_preview: report.action, result_preview: truncateText_(report.reason || report.text || '', AUDIT_PREVIEW_CHARS).text, ok: report.action !== 'error' && report.action !== 'rejected', ms: 0 });
    } catch (err) { /* 忽略 */ }
  }
  return HtmlService.createHtmlOutput('ok');
}

/**
 * Web App POST 入口：目前只有 Telegram（?src=telegram）。其他來源回一行文字。
 * @param {GoogleAppsScript.Events.DoPost} e
 * @return {GoogleAppsScript.HTML.HtmlOutput}
 */
function doPost(e) {
  const params = (e && e.parameter) || {};
  if (params.src === 'telegram') return telegramWebhook_(e);
  return HtmlService.createHtmlOutput('GAS Agent');
}

// ---- 回覆投遞 ------------------------------------------------------------------------------------------

/**
 * Queue job 結束後把結果送回 Telegram：文字 + 待審批按鈕。
 * @param {string} chatId
 * @param {!Object} result summarizeTurnResult_ 摘要
 * @param {{sendTelegram: (Function|undefined)}=} deps sendTelegram(chatId, text, opts)
 * @return {{messages: number}}
 */
function deliverTurnToTelegram_(chatId, result, deps) {
  deps = deps || {};
  const pending = (result.steps || []).filter((s) => s.status === 'pending_approval' && s.approvalId);
  const text = channelReplyText_(result, { approvalHint: pending.length ? '用下方按鈕決定，或到管理頁「紀錄 → 審批」。' : '' });
  const send = deps.sendTelegram || ((c, t, o) => telegramSend_(c, t, o));
  return send(chatId, text, { replyMarkup: telegramApprovalKeyboard_(pending) }) || { messages: 1 };
}

/**
 * 任何通道（聊天台 / Email / 排程）停在審批時，推一則帶「批准 / 拒絕」按鈕的通知到 owner 的 Telegram。
 * Telegram 自己來的任務不用（回覆本身就帶按鈕）。不 throw。
 * @param {{channel: string, sessionId: string, steps: !Array<TurnStep>, message: (string|undefined)}} info
 * @param {{cfg: (ChannelConfig|undefined), send: (Function|undefined)}=} deps
 * @return {{ok: boolean, chatId: string, skipped: string, error: string}}
 */
function notifyApprovalsTelegram_(info, deps) {
  deps = deps || {};
  const out = { ok: false, chatId: '', skipped: '', error: '' };
  try {
    const cfg = deps.cfg || getChannelConfig_();
    if (!cfg.telegramEnabled || !cfg.telegramNotifyApprovals) { out.skipped = 'disabled'; return out; }
    const chatId = cfg.telegramOwnerChatId || cfg.telegramAllowedUserIds[0] || '';
    if (!chatId) { out.skipped = 'no_chat_id'; return out; }
    const pending = (info.steps || []).filter((s) => s.status === 'pending_approval' && s.approvalId);
    if (!pending.length) { out.skipped = 'nothing_pending'; return out; }
    const source = { admin: '管理頁聊天台', email: 'Email 指令信', cron: '排程' }[info.channel] || info.channel;
    const lines = [`⏸ 來自${source}的任務需要你審批${info.message ? `：「${truncateText_(String(info.message).replace(/\s+/g, ' '), 80).text}」` : ''}`, ''];
    pending.forEach((s) => lines.push(`• ${s.tool} ${truncateText_(s.argsPreview || '', 200).text}`));
    lines.push('', `session ${info.sessionId}。按按鈕決定，或到管理頁「紀錄 → 審批」。`);
    (deps.send || ((c, t, o) => telegramSend_(c, t, o)))(String(chatId), lines.join('\n'), { replyMarkup: telegramApprovalKeyboard_(pending) });
    out.ok = true;
    out.chatId = String(chatId);
  } catch (err) {
    out.error = String(err && err.message || err);
  }
  return out;
}

// ---- 管理頁用 -------------------------------------------------------------------------------------------

/**
 * 部署 B 的 webhook URL（含 src 與 secret）。
 * @param {string} execUrl 部署 B 的 /exec 網址
 * @param {string} secret
 * @return {string}
 */
function telegramWebhookUrl_(execUrl, secret) {
  const base = String(execUrl || '').trim().split('?')[0];
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(base)) {
    throw new Error('部署 B 的網址應像 https://script.google.com/macros/s/<部署ID>/exec（在「部署 → 管理部署作業」複製，存取權必須是「任何人」）。');
  }
  return `${base}?src=telegram&key=${encodeURIComponent(secret)}`;
}

/**
 * 向 Telegram 登記 webhook。
 * @param {Object=} deps telegramApi_ deps
 * @return {{url: string, result: *}}
 */
function telegramSetWebhook_(deps) {
  const cfg = getChannelConfig_();
  const secret = getTelegramSecret_();
  if (!secret) throw new Error('webhook secret 尚未產生：先在「通道」分頁儲存一次。');
  const url = telegramWebhookUrl_(cfg.telegramWebhookUrl, secret);
  const result = telegramApi_('setWebhook', { url, allowed_updates: ['message', 'edited_message', 'callback_query'], drop_pending_updates: false }, deps);
  return { url, result };
}

/**
 * @param {Object=} deps
 * @return {*} getWebhookInfo 的 result
 */
function telegramGetWebhookInfo_(deps) {
  return telegramApi_('getWebhookInfo', {}, deps);
}

/**
 * @param {Object=} deps
 * @return {*}
 */
function telegramDeleteWebhook_(deps) {
  return telegramApi_('deleteWebhook', { drop_pending_updates: false }, deps);
}
