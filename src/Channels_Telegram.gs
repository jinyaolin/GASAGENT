/**
 * @fileoverview Telegram 通道（M6）：webhook（部署 B）入口 doPost、驗證、指令、排隊、回覆、審批 inline button。
 *
 * 部署 B 是「以我執行 / 任何人」的 Web App；Telegram 打 `<部署 B /exec>?src=telegram&key=<secret>`。
 * GAS 的 doPost 拿不到 HTTP header（Telegram 的 secret_token header 用不上），所以 secret 放 query string，
 * 再比對 message.from.id 白名單（Config telegram_allowed_user_ids）。回應一律 HtmlService 'ok'（ContentService 會 302，
 * Telegram 會一直重送）。doPost 只做：驗證 → 指令或排 Queue job → 立刻回「收到」。agent 由 queueTick 跑，
 * 結果經 deliverTurnToTelegram_ 送回；待審批的動作附「批准 / 拒絕」按鈕，按下走 callback_query → decideApproval_。
 *
 * 指令：/new（新 session）/status /model [provider id] /skills /white [list|add|delete <email>]（M7 寄信白名單）/help；
 * 其他文字（含 /<技能名>）原樣交給 runSessionTurn_。
 * 群組：只在「@bot 提到它」「回覆它的訊息」或「/指令」時反應（私聊不變）。白名單成員在群組裡用 /group 切模式：
 *   /group on    群聊模式（Config telegram_open_groups）：全群共用一個 session，非白名單成員 @bot 也能用工具，但那一輪
 *                是 principal group_member（M7-A）：只能用 Config telegram_member_toolsets（預設 web / skill / session）的 R 工具、
 *                owner 的 Workspace 一律不可讀，R 以外的工具一律送審批、不注入 owner 記憶快照、不 curation（payload.member → Sessions.gs）
 *   /group guest 訪客模式（Config telegram_guest_groups）：非白名單成員獨立 session（<chat id>:guest）、沒有工具、不注入記憶 / 技能
 *   /group off   只有白名單成員叫得到
 * 成員（非白名單）的 /指令一律忽略；訪客的附件不處理，群聊成員的附件照常存 Drive。
 * **隱私模式**：Telegram 預設的 bot 隱私模式下，群組裡的 @bot 一般訊息**不會送到 bot**（只有 /指令、回覆 bot、服務訊息會到），
 * 所以要在 BotFather `/setprivacy` → Disable 後把 bot 退群再加回（或把 bot 設成群組管理員）。getMe 的
 * `can_read_all_group_messages` 就是這個狀態；/group 指令與 Doctor 會檢查並提醒（telegramPrivacyWarning_）。
 * 審批按鈕任何人都看得到，但 callback 仍要過白名單。bot username 由 getMe 取得存 Config telegram_bot_username。
 * 附件：照片 / 檔案（document / photo / video / audio / voice）用 getFile 下載存到 Drive `GAS Agent/attachments/telegram/`，
 * 訊息 = caption（沒有就預設一句）+ 附件註記（名稱 / 類型 / Drive file_id / 網址），agent 用 drive_read_text（PDF / 圖片 OCR）、
 * drive_move、gmail_send attachment_file_ids 等既有工具處理。Bot API 單檔下載上限 20 MB。
 * 全部外部依賴（fetch、store、enqueue、decide）可注入，測試不打網路。
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** 單則訊息上限 4096；留餘裕。 */
const TELEGRAM_MESSAGE_MAX = 3900;
/** 每分鐘最多處理幾個 update（CacheService 計數，粗略即可）。 */
const TELEGRAM_RATE_PER_MINUTE = 30;
/** Config telegram_ack 開著時，收到訊息先回這句再排隊（預設關：直接等結果）。 */
const TELEGRAM_ACK_TEXT = '收到，處理中…';
/** 審批按鈕的 callback_data：apr:<approval id>:approve|deny（≤ 64 bytes）。 */
const TELEGRAM_CALLBACK_RE = /^apr:([A-Za-z0-9_-]+):(approve|deny)$/;
/** Bot API getFile 的單檔上限。 */
const TELEGRAM_FILE_MAX_BYTES = 20 * 1024 * 1024;
/** 附件存放的 Drive 資料夾。 */
const TELEGRAM_ATTACHMENT_FOLDER_PATH = Object.freeze(['GAS Agent', 'attachments', 'telegram']);
/** 只有附件、沒有 caption 時給 agent 的訊息。 */
const TELEGRAM_ATTACHMENT_DEFAULT_MESSAGE = '請看這個附件，說明內容重點；若明顯是收據、合約、名片之類的文件，順便建議怎麼歸檔。';
/** Telegram 專用的保留指令（其餘 /xxx 交給 runSessionTurn_，例如 /<技能名>）。 */
const TELEGRAM_COMMANDS = Object.freeze(['start', 'help', 'new', 'status', 'model', 'skills', 'group', 'white']);
/** 訪客在群組只 @bot 沒說話時的訊息。 */
const TELEGRAM_GUEST_DEFAULT_MESSAGE = '你好';
/** setWebhook 要收的 update 類型。 */
const TELEGRAM_ALLOWED_UPDATES = Object.freeze(['message', 'edited_message', 'callback_query']);
/** 隱私模式開著時 /group 與 Doctor 的提醒。 */
const TELEGRAM_PRIVACY_WARNING = '⚠️ 這個 bot 的「隱私模式」還開著：Telegram 不會把群組裡 @bot 的一般訊息送給它（只有 /指令和回覆 bot 的訊息會到），所以 @bot 不會有反應。請到 @BotFather → /setprivacy → 選這個 bot → Disable，然後把 bot 退出群組再加回來（或直接把 bot 設成群組管理員）。';

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
 * @typedef {{fileId: string, fileName: string, mimeType: string, fileSize: number, kind: string}} TelegramAttachment
 */

/**
 * @typedef {{
 *   kind: ('message'|'callback'|'other'), updateId: number, chatId: string, userId: string, username: string,
 *   text: string, messageId: number, callbackId: string, callbackData: string, callbackMessageId: number,
 *   attachments: !Array<TelegramAttachment>, chatType: string, mentions: !Array<string>, replyToUserId: string, replyToIsBot: boolean
 * }} TelegramUpdate
 * chatType：private / group / supergroup / channel；mentions：訊息裡 @xxx 的 xxx（小寫）；replyTo*：回覆的那則訊息的作者。
 */

/**
 * 訊息裡的附件：document / photo（取最大尺寸）/ video / audio / voice / animation。純函式。
 * @param {!Object} msg Telegram message
 * @return {!Array<TelegramAttachment>}
 */
function telegramAttachments_(msg) {
  const out = [];
  const push = (kind, f, name, mime) => {
    if (!f || !f.file_id) return;
    out.push({ fileId: String(f.file_id), fileName: String(name || f.file_name || `${kind}_${f.file_unique_id || f.file_id}`), mimeType: String(mime || f.mime_type || ''), fileSize: toNumber_(f.file_size, 0), kind });
  };
  if (msg.document) push('document', msg.document);
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const best = msg.photo.slice().sort((a, b) => toNumber_(b.file_size, 0) - toNumber_(a.file_size, 0))[0];
    push('photo', best, `photo_${best.file_unique_id || best.file_id}.jpg`, 'image/jpeg');
  }
  if (msg.video) push('video', msg.video);
  if (msg.audio) push('audio', msg.audio);
  if (msg.voice) push('voice', msg.voice, `voice_${msg.voice.file_unique_id || ''}.ogg`, msg.voice.mime_type || 'audio/ogg');
  if (msg.animation) push('animation', msg.animation);
  return out;
}

/**
 * Telegram update JSON → 精簡結構。純函式；非文字訊息（貼圖、照片…）kind='message' 但 text 為空。
 * @param {*} update
 * @return {TelegramUpdate}
 */
function parseTelegramUpdate_(update) {
  const u = update || {};
  const out = { kind: 'other', updateId: toNumber_(u.update_id, 0), chatId: '', userId: '', username: '', text: '', messageId: 0, callbackId: '', callbackData: '', callbackMessageId: 0, attachments: [], chatType: '', mentions: [], replyToUserId: '', replyToIsBot: false };
  const msg = u.message || u.edited_message || null;
  if (u.callback_query) {
    const cq = u.callback_query;
    out.kind = 'callback';
    out.callbackId = String(cq.id || '');
    out.callbackData = String(cq.data || '');
    out.userId = cq.from ? String(cq.from.id || '') : '';
    out.username = cq.from ? String(cq.from.username || '') : '';
    if (cq.message) { out.chatId = cq.message.chat ? String(cq.message.chat.id || '') : ''; out.chatType = cq.message.chat ? String(cq.message.chat.type || '') : ''; out.callbackMessageId = toNumber_(cq.message.message_id, 0); }
    return out;
  }
  if (msg) {
    out.kind = 'message';
    out.chatId = msg.chat ? String(msg.chat.id || '') : '';
    out.userId = msg.from ? String(msg.from.id || '') : '';
    out.username = msg.from ? String(msg.from.username || '') : '';
    out.text = String(msg.text || msg.caption || '').trim();
    out.messageId = toNumber_(msg.message_id, 0);
    out.attachments = telegramAttachments_(msg);
    out.chatType = msg.chat ? String(msg.chat.type || '') : '';
    const m = out.text.match(/@([A-Za-z0-9_]{3,})/g) || [];
    out.mentions = m.map((x) => x.slice(1).toLowerCase());
    if (msg.reply_to_message && msg.reply_to_message.from) {
      out.replyToUserId = String(msg.reply_to_message.from.id || '');
      out.replyToIsBot = !!msg.reply_to_message.from.is_bot;
    }
  }
  return out;
}

/**
 * 隱私模式提醒：getMe 的 can_read_all_group_messages 為 false 時回提醒文字，否則空字串。api 失敗也回空字串（不擋流程）。
 * @param {Function} api (method, payload) → result
 * @return {string}
 */
function telegramPrivacyWarning_(api) {
  let me = null;
  try { me = api('getMe', {}); } catch (err) { return ''; }
  if (!me || me.can_read_all_group_messages !== false) return '';
  return TELEGRAM_PRIVACY_WARNING;
}

/**
 * 群組訊息是不是在叫這個 bot：@username、回覆 bot 的訊息、或 /指令。純函式。
 * @param {TelegramUpdate} u
 * @param {string} botUsername 不含 @（可空）
 * @param {string} botId token 冒號前的數字（可空）
 * @return {boolean}
 */
function telegramAddressedToBot_(u, botUsername, botId) {
  if (botUsername && u.mentions.indexOf(String(botUsername).toLowerCase()) !== -1) return true;
  if (u.replyToIsBot && (!botId || u.replyToUserId === String(botId))) return true;
  if (/^\//.test(u.text)) return true;
  return false;
}

/**
 * 把 @bot 從文字拿掉。純函式。
 * @param {string} text
 * @param {string} botUsername
 * @return {string}
 */
function stripBotMention_(text, botUsername) {
  if (!botUsername) return String(text || '').trim();
  return String(text || '').replace(new RegExp('@' + escapeRegex_(botUsername) + '\\b', 'ig'), '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 群組的訪客 session（與 owner 的群組 session 分開，避免訪客看到 owner 的工具結果）。
 * @param {string} chatId
 * @param {!Object} store
 * @return {?SessionRow}
 */
function telegramGuestSession_(chatId, store) {
  return telegramSession_(`${chatId}:guest`, store);
}

/**
 * 下載 Telegram 檔案存到 Drive。
 * @param {TelegramAttachment} att
 * @param {{api: (Function|undefined), fetch: (Function|undefined), token: (string|undefined), folder: (Object|undefined)}=} deps
 * @return {{id: string, name: string, mime_type: string, size: number, url: string}}
 * @throws {Error} 太大、getFile 失敗
 */
function telegramSaveAttachment_(att, deps) {
  deps = deps || {};
  if (att.fileSize > TELEGRAM_FILE_MAX_BYTES) throw new Error(`${att.fileName} 太大（${Math.round(att.fileSize / 1048576)} MB），Telegram Bot API 下載上限 20 MB。`);
  const api = deps.api || ((m, p) => telegramApi_(m, p, deps));
  const info = api('getFile', { file_id: att.fileId });
  if (!info || !info.file_path) throw new Error(`Telegram getFile 沒有回 file_path（${att.fileName}）。`);
  const token = deps.token !== undefined ? deps.token : getTelegramToken_();
  const fetch = deps.fetch || ((url, opts) => UrlFetchApp.fetch(url, opts));
  const res = fetch(`${TELEGRAM_API_BASE}/file/bot${token}/${info.file_path}`, { muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error(`下載 ${att.fileName} 失敗（HTTP ${res.getResponseCode()}）。`);
  const blob = res.getBlob().setName(att.fileName);
  if (att.mimeType) { try { blob.setContentType(att.mimeType); } catch (err) { /* 忽略 */ } }
  const folder = deps.folder || folderByPath_(TELEGRAM_ATTACHMENT_FOLDER_PATH);
  const file = folder.createFile(blob);
  return { id: file.getId(), name: file.getName(), mime_type: file.getMimeType(), size: file.getSize(), url: file.getUrl() };
}

/**
 * 附件存好後附在使用者訊息後面的註記（agent 看得到 file_id 才能用工具處理）。純函式。
 * @param {!Array<{id: string, name: string, mime_type: string, size: number, url: string}>} saved
 * @param {!Array<string>} failed 失敗說明
 * @return {string}
 */
function telegramAttachmentNote_(saved, failed) {
  const lines = ['', '', '（使用者從 Telegram 附了檔案，已存到 Drive「GAS Agent/attachments/telegram」：'];
  saved.forEach((f) => lines.push(`- ${f.name}｜${f.mime_type || '?'}｜${Math.max(1, Math.round(f.size / 1024))} KB｜file_id=${f.id}｜${f.url}`));
  (failed || []).forEach((m) => lines.push(`- 存檔失敗：${m}`));
  lines.push('可用 drive_read_text 讀內容（PDF / 圖片會 OCR 成文字）、drive_move / drive_rename 歸檔、gmail_send 或 gmail_create_draft 的 attachment_file_ids 轉寄。）');
  return lines.join('\n');
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
  const report = { action: '', reason: '', jobId: '', sessionId: '', text: '', guest: false };
  const isGroup = u.chatType === 'group' || u.chatType === 'supergroup';
  const whitelisted = !!u.userId && deps.cfg.telegramAllowedUserIds.indexOf(String(u.userId)) !== -1;
  const groupMode = !isGroup ? '' : deps.cfg.telegramOpenGroups.indexOf(String(u.chatId)) !== -1 ? 'chat' : deps.cfg.telegramGuestGroups.indexOf(String(u.chatId)) !== -1 ? 'guest' : '';
  // 群組開放：非白名單成員「@bot 叫到」的一般訊息可以進來——群聊模式（member）或訪客模式（guest）；其餘仍走白名單。
  const member = groupMode === 'chat' && !whitelisted && u.kind === 'message';
  const guest = groupMode === 'guest' && !whitelisted && u.kind === 'message';
  const denied = telegramAuthorize_({ key: deps.key, secret: deps.secret, userId: u.userId, allowed: (guest || member) ? [String(u.userId)] : deps.cfg.telegramAllowedUserIds, enabled: deps.cfg.telegramEnabled });
  if (denied) {
    // 不回任何訊息給非白名單的人（避免被拿來探測）；secret 錯直接忽略。
    report.action = 'rejected';
    report.reason = denied + (u.userId ? ` (user ${u.userId}${u.username ? ' @' + u.username : ''}${isGroup ? ' in group ' + u.chatId : ''})` : '');
    return report;
  }
  if (u.kind === 'other') { report.action = 'ignored'; report.reason = 'unsupported_update'; return report; }
  // 群組：沒叫到 bot 的訊息安靜略過（Telegram 隱私模式開著時本來就收不到，這裡是第二道）
  if (isGroup && u.kind === 'message' && !telegramAddressedToBot_(u, deps.botUsername || deps.cfg.telegramBotUsername, deps.botId || '')) {
    report.action = 'ignored'; report.reason = 'not_addressed'; return report;
  }
  if (isGroup && u.kind === 'message') u.text = stripBotMention_(u.text, deps.botUsername || deps.cfg.telegramBotUsername);
  report.guest = guest;
  report.member = member;
  if ((deps.rateExceeded || telegramRateExceeded_)()) { report.action = 'rejected'; report.reason = 'rate_limited'; return report; }
  if (!deps.cfg.telegramOwnerChatId && deps.setConfig && u.chatId && !isGroup && whitelisted) {
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

  // 群聊模式的成員：不吃指令；其餘與白名單成員相同，但 payload.member 讓那一輪 R 以外的工具送審、不帶記憶
  if (member && /^\//.test(u.text) && !u.attachments.length) { report.action = 'ignored'; report.reason = 'member_command'; return report; }
  // 訪客（訪客模式群組的非白名單成員）：不處理指令與附件，純文字進訪客 session
  if (guest) {
    if (/^\//.test(u.text)) { report.action = 'ignored'; report.reason = 'guest_command'; return report; }
    const gs = telegramGuestSession_(u.chatId, store);
    const payload = telegramTurnPayload_(u.text || TELEGRAM_GUEST_DEFAULT_MESSAGE, u);
    payload.external_id = `${u.chatId}:guest`;
    payload.guest = true;
    const job = deps.enqueue('turn', payload, gs ? gs.id : '');
    report.action = 'enqueued'; report.jobId = job.id; report.sessionId = gs ? gs.id : '';
    return report;
  }

  // 附件：先存 Drive，再把註記接在訊息後面
  let messageText = u.text;
  const savedFiles = [];
  if (u.attachments.length) {
    const failed = [];
    u.attachments.forEach((att) => {
      try { savedFiles.push((deps.saveAttachment || telegramSaveAttachment_)(att)); } catch (err) { failed.push(`${att.fileName}：${err && err.message || err}`); }
    });
    if (!savedFiles.length) { send(`附件存檔失敗：${failed.join('；')}`); report.action = 'attachment_failed'; report.reason = failed.join('；'); return report; }
    messageText = (u.text || TELEGRAM_ATTACHMENT_DEFAULT_MESSAGE) + telegramAttachmentNote_(savedFiles, failed);
  }
  // 文字訊息
  if (!messageText) { send('目前只接受文字與檔案（照片 / 文件 / 語音），貼圖等不處理。'); report.action = 'ignored'; report.reason = 'no_text'; return report; }
  const cmd = (u.attachments.length || member) ? { command: '', rest: messageText } : parseTelegramCommand_(u.text);
  const current = telegramSession_(u.chatId, store);
  report.sessionId = current ? current.id : '';

  if (cmd.command === 'start' || cmd.command === 'help') {
    const lines = ['GAS Agent 已連線。直接輸入任務即可，例如「找出本週收到關於 X 的信並整理成 Doc」。', '',
      '/new — 開新對話（session）', '/status — 目前 session', '/model [provider id] — 查看 / 指定這個 session 用的模型', '/skills — 列出可用技能；/<技能名> 訊息 直接套用技能', '/white [list | add <email> | delete <email>] — 寄信白名單：收件人全在名單內的信免審批直接寄（*@domain.com 代表整個網域）', '/help — 這份說明',
      '', '也可以直接傳照片 / PDF / 文件（≤ 20 MB），會先存進 Drive「GAS Agent/attachments/telegram」，caption 當指令（例：「這是收據，歸到 2026 報帳」「摘要這份合約並寄給我」）。',
      '', '群組：把 bot 加進群組後，只在 @bot、回覆 bot 或 /指令時反應。/group on 群聊模式（成員只能用公開工具如網頁 / 技能，看不到 owner 的 Gmail / Drive / 行事曆；寫入送 owner 審批）、/group guest 訪客模式（成員無工具）、/group off 關閉。',
      '', '待審批的動作會附「批准 / 拒絕」按鈮；其餘設定在管理頁。'];
    report.text = lines.join('\n'); send(report.text); report.action = 'help'; return report;
  }
  if (cmd.command === 'group') {
    if (!isGroup) { report.text = '/group 只在群組裡有用：把 bot 加進群組後，在群組輸入 /group on 開放其他成員 @bot 提問。'; send(report.text); report.action = 'group'; return report; }
    const want = cmd.rest.trim().toLowerCase();
    const here = String(u.chatId);
    const bot = deps.botUsername || deps.cfg.telegramBotUsername || 'bot';
    const without = (arr) => arr.filter((x) => x !== here);
    if (want === 'on' || want === 'guest' || want === 'off') {
      const open = want === 'on' ? without(deps.cfg.telegramOpenGroups).concat([here]) : without(deps.cfg.telegramOpenGroups);
      const guestList = want === 'guest' ? without(deps.cfg.telegramGuestGroups).concat([here]) : without(deps.cfg.telegramGuestGroups);
      if (deps.setConfig) deps.setConfig({ telegram_open_groups: open.join(','), telegram_guest_groups: guestList.join(',') });
      deps.cfg.telegramOpenGroups = open;
      deps.cfg.telegramGuestGroups = guestList;
      report.text = want === 'on'
        ? `此群組已切成群聊模式：全群共用一個對話，任何成員 @${bot} 都能請它幫忙。非 owner 觸發時只能用公開工具（${(deps.cfg.telegramMemberToolsets || PRINCIPAL_DEFAULT_TOOLSETS.group_member).join(' / ') || '無'}），owner 的 Gmail / Drive / 行事曆等資料不會在群組裡讀取；寫入 / 寄信 / 分享會先送審批（按鈕只有白名單能按），且那一輪不帶 owner 的記憶。owner 可在管理頁「通道」放寬工具。/group guest 改訪客模式、/group off 關閉。`
        : want === 'guest'
          ? `此群組已切成訪客模式：任何成員 @${bot} 都會得到回答，但不帶工具、不會透露 owner 的資料。/group on 改群聊模式、/group off 關閉。`
          : '此群組已關閉開放：只有白名單成員 @bot 或回覆 bot 時會回答。';
      report.action = 'group_' + want;
      const warn = telegramPrivacyWarning_(deps.api);
      if (warn && want !== 'off') report.text += '\n\n' + warn;
    } else {
      const mode = deps.cfg.telegramOpenGroups.indexOf(here) !== -1 ? '群聊模式（成員只能用公開工具，寫入送審）' : deps.cfg.telegramGuestGroups.indexOf(here) !== -1 ? '訪客模式（成員無工具）' : '未開放（只有白名單）';
      report.text = `此群組目前：${mode}。/group on 群聊、/group guest 訪客、/group off 關閉。bot 只在被 @ 提到、被回覆或收到 /指令時反應。`;
      const warn = telegramPrivacyWarning_(deps.api);
      if (warn) report.text += '\n\n' + warn;
      report.action = 'group';
    }
    send(report.text); return report;
  }
  if (cmd.command === 'white') {
    report.text = telegramWhitelistCommand_(cmd.rest, u, deps);
    send(report.text); report.action = 'white'; return report;
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
      report.text = `已開新 session（${fresh.id}），任務已排入。`;
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

  // 一般訊息（含 /<技能名> 與附件）：排隊；Config telegram_ack 開著才先回「收到」
  if (deps.cfg.telegramAck) send(TELEGRAM_ACK_TEXT, { replyTo: u.messageId });
  const payload = telegramTurnPayload_(messageText, u);
  if (member) payload.member = true;
  if (savedFiles.length) payload.attachments = savedFiles.map((f) => ({ id: f.id, name: f.name, mime_type: f.mime_type }));
  const job = deps.enqueue('turn', payload, current ? current.id : '');
  report.action = 'enqueued'; report.jobId = job.id; report.text = deps.cfg.telegramAck ? TELEGRAM_ACK_TEXT : '';
  report.attachments = savedFiles.length;
  return report;
}

/**
 * /white 指令（M7 寄信白名單）：list / add <email…> / delete <email…>。只有白名單成員會走到這裡（成員 / 訪客的指令已被忽略）。
 * 讀 deps.toolCfg.gmailSendWhitelist、寫 deps.setConfig({gmail_send_whitelist})、記 AuditLog security:whitelist:<sub>（deps.audit 可注入）。純邏輯，回覆文字。
 * @param {string} rest 指令後面的文字
 * @param {TelegramUpdate} u
 * @param {!Object} deps
 * @return {string}
 */
function telegramWhitelistCommand_(rest, u, deps) {
  const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || 'list').toLowerCase();
  const current = (deps.toolCfg && Array.isArray(deps.toolCfg.gmailSendWhitelist)) ? deps.toolCfg.gmailSendWhitelist.slice() : [];
  const usage = '/white list — 看目前名單\n/white add a@b.com [c@d.com …] — 加入（*@domain.com 代表整個網域）\n/white delete a@b.com — 移除\n收件人（含 cc / bcc）全部在名單內的 gmail_send / gmail_forward 會直接寄出、不送審批。';
  if (sub === 'list' || sub === 'ls') {
    return current.length ? `寄信白名單（${current.length} 筆，收件人全在名單內的信免審批）：\n${current.map((e) => '• ' + e).join('\n')}\n\n${usage}` : `寄信白名單目前是空的：所有外寄都要審批。\n\n${usage}`;
  }
  const isAdd = sub === 'add';
  const isDel = sub === 'delete' || sub === 'del' || sub === 'remove' || sub === 'rm';
  if (!isAdd && !isDel) return `不認得「${sub}」。\n${usage}`;
  const entries = parseEmailWhitelist_(parts.slice(1).join(' '));
  if (!entries.length) return `請給合法的 email（可多個，用空格或逗號分隔；*@domain.com 代表整個網域）。\n${usage}`;
  let next;
  let changed;
  if (isAdd) {
    changed = entries.filter((e) => current.indexOf(e) === -1);
    next = current.concat(changed);
  } else {
    changed = entries.filter((e) => current.indexOf(e) !== -1);
    next = current.filter((e) => entries.indexOf(e) === -1);
  }
  if (!changed.length) return isAdd ? `已經在名單內：${entries.join(', ')}（共 ${current.length} 筆）。` : `名單裡沒有：${entries.join(', ')}（共 ${current.length} 筆）。`;
  if (deps.setConfig) deps.setConfig({ [TOOL_CONFIG_KEYS.GMAIL_SEND_WHITELIST]: next.join('\n') });
  if (deps.toolCfg) deps.toolCfg.gmailSendWhitelist = next;
  securityAudit_('whitelist:' + (isAdd ? 'add' : 'delete'), `寄信白名單${isAdd ? '加入' : '移除'} ${changed.join(', ')}（Telegram user ${u.userId}${u.username ? ' @' + u.username : ''}）→ 共 ${next.length} 筆`, deps.audit);
  return `${isAdd ? '已加入' : '已移除'}：${changed.join(', ')}\n目前名單（${next.length} 筆）：${next.join(', ') || '（空）'}`;
}

/**
 * Telegram 來的 turn job payload。
 * @param {string} message
 * @param {TelegramUpdate} u
 * @return {!Object}
 */
function telegramTurnPayload_(message, u) {
  return { message, channel: 'telegram', mode: 'interactive', external_id: u.chatId, telegram_chat_id: u.chatId, telegram_chat_type: u.chatType || 'private', telegram_message_id: u.messageId, telegram_user: u.username || u.userId };
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
    const token = getTelegramToken_();
    let botUsername = cfg.telegramBotUsername;
    if (!botUsername && token) {
      try { botUsername = String(telegramApi_('getMe', {}).username || ''); if (botUsername) setConfigValues_({ telegram_bot_username: botUsername }); } catch (err) { botUsername = ''; }
    }
    report = handleTelegramUpdate_(raw, {
      key: (e && e.parameter && e.parameter.key) || '',
      cfg,
      botUsername,
      botId: token.split(':')[0] || '',
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
      toolCfg: getToolConfig_(),
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
  return send(chatId, text, { replyMarkup: telegramApprovalKeyboard_(pending), replyTo: deps.replyTo || 0 }) || { messages: 1 };
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
 * @param {{cfg: (ChannelConfig|undefined), secret: (string|undefined), api: (Function|undefined), token: (string|undefined), fetch: (Function|undefined)}=} deps
 *   cfg / secret 省略時讀目前設定；api(method, payload) 省略時用 telegramApi_（可帶 token / fetch）
 * @return {{url: string, result: *}}
 */
function telegramSetWebhook_(deps) {
  deps = deps || {};
  const cfg = deps.cfg || getChannelConfig_();
  const secret = deps.secret !== undefined ? deps.secret : getTelegramSecret_();
  if (!secret) throw new Error('webhook secret 尚未產生：先在「通道」分頁儲存一次。');
  const url = telegramWebhookUrl_(cfg.telegramWebhookUrl, secret);
  const api = deps.api || ((method, payload) => telegramApi_(method, payload, deps));
  const result = api('setWebhook', { url, allowed_updates: TELEGRAM_ALLOWED_UPDATES.slice(), drop_pending_updates: false });
  return { url, result };
}

/**
 * 遮掉 webhook URL 裡的 secret（給 UI / AuditLog）。純函式。
 * @param {string} url
 * @return {string}
 */
function maskWebhookUrl_(url) {
  return String(url || '').replace(/key=[^&]+/, 'key=…');
}

// ---- 秘密輪替（M7-A）------------------------------------------------------------------------------------

/**
 * 重新產生 webhook secret：寫新 TELEGRAM_WEBHOOK_SECRET（舊的隨即作廢）→ 已填部署 B 網址就立刻重打 setWebhook → AuditLog（不記值）。
 * 重登失敗不回滾（新 secret 已生效，舊 URL 的請求會被 bad_secret 擋掉），回傳 webhookError 讓 UI 提示再按一次「設定 webhook」。
 * @param {{cfg: (ChannelConfig|undefined), api: (Function|undefined), setSecret: (Function|undefined), audit: (Function|undefined)}=} deps
 * @return {{secretHint: string, webhook: ?{url: string, result: *}, webhookError: string}} webhook.url 已遮 secret
 */
function telegramRotateSecret_(deps) {
  deps = deps || {};
  const cfg = deps.cfg || getChannelConfig_();
  const secret = newWebhookSecret_();
  (deps.setSecret || ((s) => setProp_(PROP.TELEGRAM_WEBHOOK_SECRET, s)))(secret);
  const out = { secretHint: secret.slice(0, 4) + '…' + secret.slice(-4), webhook: null, webhookError: '' };
  if (cfg.telegramWebhookUrl) {
    try {
      const r = telegramSetWebhook_({ cfg, secret, api: deps.api });
      out.webhook = { url: maskWebhookUrl_(r.url), result: r.result };
    } catch (err) {
      out.webhookError = String(err && err.message || err);
    }
  }
  securityAudit_('telegram:rotate_secret',
    out.webhook ? 'webhook secret 已更換並重新登記 webhook' : out.webhookError ? `webhook secret 已更換；重新登記 webhook 失敗：${out.webhookError}` : 'webhook secret 已更換（尚未填部署 B 網址，未登記 webhook）',
    deps.audit);
  return out;
}

/**
 * 更換 bot token：先用**新 token** 打 getMe，成功才寫入 Script Properties（舊 token 隨即不再使用）、更新 Config telegram_bot_username、
 * 已填部署 B 網址且有 secret 就重打 setWebhook。驗證失敗 throw，舊 token 完全不動。AuditLog 只記 bot username，不記 token。
 * @param {string} token
 * @param {{cfg: (ChannelConfig|undefined), api: (Function|undefined), fetch: (Function|undefined), getToken: (Function|undefined),
 *   setToken: (Function|undefined), getSecret: (Function|undefined), setConfig: (Function|undefined), audit: (Function|undefined)}=} deps
 *   api(method, payload) 省略時用新 token 打 telegramApi_
 * @return {{username: string, botId: string, replaced: boolean, webhook: ?{url: string, result: *}, webhookError: string}}
 * @throws {Error} 格式不對或 getMe 失敗
 */
function telegramReplaceToken_(token, deps) {
  deps = deps || {};
  const t = String(token || '').trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(t)) throw new Error('Telegram bot token 格式不對（應像 123456789:AAH…）。');
  const api = deps.api || ((method, payload) => telegramApi_(method, payload, { token: t, fetch: deps.fetch }));
  let me = null;
  try {
    me = api('getMe', {});
  } catch (err) {
    throw new Error(`新 token 驗證失敗（getMe）：${err && err.message || err}。舊 token 未更動。`);
  }
  if (!me || !me.id) throw new Error('新 token 驗證失敗：getMe 沒有回 bot 資料。舊 token 未更動。');
  const previous = (deps.getToken || getTelegramToken_)();
  (deps.setToken || setTelegramToken_)(t);
  const username = String(me.username || '');
  try { (deps.setConfig || setConfigValues_)({ telegram_bot_username: username }); } catch (err) { /* 忽略：username 只影響群組 @mention 判斷 */ }
  const out = { username, botId: String(me.id), replaced: !!previous && previous !== t, webhook: null, webhookError: '' };
  const cfg = deps.cfg || getChannelConfig_();
  const secret = (deps.getSecret || getTelegramSecret_)();
  if (cfg.telegramWebhookUrl && secret) {
    try {
      const r = telegramSetWebhook_({ cfg, secret, api });
      out.webhook = { url: maskWebhookUrl_(r.url), result: r.result };
    } catch (err) {
      out.webhookError = String(err && err.message || err);
    }
  }
  securityAudit_('telegram:replace_token',
    `bot @${username || '?'}（${out.replaced ? '更換 token' : '設定 token'}）${out.webhook ? '；已重新登記 webhook' : out.webhookError ? `；重新登記 webhook 失敗：${out.webhookError}` : ''}`,
    deps.audit);
  return out;
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
