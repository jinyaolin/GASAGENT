/**
 * @fileoverview 投遞（M4）：cron job 結束後把結果依 deliver_to 送出。
 *
 * - doc：在 Drive「GAS Agent/reports」建一份 Google 文件，標題「<name> YYYY-MM-DD」，內文用 Docs 輕量 markdown（Tools_Docs.gs 的 appendLiteMarkdown_）。
 * - email：寄給 OWNER_EMAIL。只寄給 owner 自己不算外發，不走審批、不經 gmail_send 工具。
 * - none：不投遞（結果仍在 Queue job 的 payload.result 與 session 裡）。
 * - telegram（M6）：送到 owner 的 Telegram chat（Config telegram_owner_chat_id，沒有就用白名單第一個 user id）。內容組裝（buildDeliveryContent_）是純函式；實際送出的 handler 可注入供測試。
 */

/** 投遞文件放的資料夾。 */
const REPORT_FOLDER_PATH = Object.freeze(['GAS Agent', 'reports']);
/** 投遞內容的文字上限（Docs / 郵件都夠用）。 */
const DELIVERY_TEXT_MAX_CHARS = 30000;

/**
 * yyyy-MM-dd（Script 時區）；測試環境沒有 Utilities 時用本地時間。
 * @param {!Date} d
 * @return {string}
 */
function fmtYmd_(d) {
  try {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  } catch (err) {
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}

/**
 * 組投遞內容。純函式。
 * @param {{name: string, id: (string|undefined), schedule: (string|undefined)}} cron
 * @param {{text: string, sessionId: (string|undefined), steps: (Array|undefined), stopped: (string|undefined),
 *   llmCalls: (number|undefined), provider: (string|undefined), model: (string|undefined), continuation_exhausted: (boolean|undefined)}} result
 * @param {!Date} now
 * @return {{title: string, subject: string, body: string}}
 */
function buildDeliveryContent_(cron, result, now) {
  const title = `${cron.name || '排程'} ${fmtYmd_(now)}`;
  const steps = result.steps || [];
  const text = truncateText_(result.text || '（這次執行沒有文字結果）', DELIVERY_TEXT_MAX_CHARS).text;
  const lines = [text, '', '---', '## 執行資訊'];
  lines.push(`- 排程：${cron.name || ''}${cron.id ? `（${cron.id}）` : ''}${cron.schedule ? `，schedule ${cron.schedule}` : ''}`);
  if (result.sessionId) lines.push(`- session：${result.sessionId}`);
  lines.push(`- 模型：${result.provider || '-'}${result.model ? ' / ' + result.model : ''}，呼叫 ${result.llmCalls || 0} 次；工具 ${steps.length} 步`);
  if (result.stopped) lines.push(`- 中止原因：${result.stopped}${result.continuation_exhausted ? '（已達續跑上限，未完成）' : ''}`);
  const pending = steps.filter((s) => s.status === 'pending_approval');
  if (pending.length) lines.push(`- 待 owner 審批：${pending.map((s) => s.tool).join(', ')}（管理頁「紀錄 → 審批」）`);
  if (result.skills && result.skills.loaded && result.skills.loaded.length) lines.push(`- 載入技能：${result.skills.loaded.join(', ')}${result.skills.missing && result.skills.missing.length ? `（找不到：${result.skills.missing.join(', ')}）` : ''}`);
  if (result.skillProposal && result.skillProposal.proposed) lines.push(`- 技能提案待審批：${result.skillProposal.approvalId}（管理頁「紀錄 → 審批」）`);
  steps.slice(0, 40).forEach((s) => lines.push(`- ${s.tool}：${s.status}${s.ms ? `，${s.ms} ms` : ''}`));
  return { title, subject: `[GAS Agent] ${title}`, body: lines.join('\n') };
}

/**
 * 取得（或建立）Drive 路徑資料夾。
 * @param {!Array<string>} path
 * @return {GoogleAppsScript.Drive.Folder}
 */
function folderByPath_(path) {
  let folder = DriveApp.getRootFolder();
  path.forEach((name) => {
    const it = folder.getFoldersByName(name);
    folder = it.hasNext() ? it.next() : folder.createFolder(name);
  });
  return folder;
}

/**
 * 預設的 doc 投遞：建文件、寫輕量 markdown、搬到 reports 資料夾。
 * @param {string} title
 * @param {string} body
 * @return {{id: string, url: string}}
 */
function createReportDoc_(title, body) {
  const doc = DocumentApp.create(title);
  const docBody = doc.getBody();
  appendLiteMarkdown_(docBody, body);
  if (docBody.getNumChildren() > 1) {
    const first = docBody.getChild(0);
    if (first.getType() === DocumentApp.ElementType.PARAGRAPH && !first.asParagraph().getText()) docBody.removeChild(first);
  }
  doc.saveAndClose();
  try { DriveApp.getFileById(doc.getId()).moveTo(folderByPath_(REPORT_FOLDER_PATH)); } catch (err) { /* 搬不動就留在根目錄 */ }
  return { id: doc.getId(), url: doc.getUrl() };
}

/**
 * 預設的 email 投遞：純文字寄給 owner。
 * @param {string} to
 * @param {string} subject
 * @param {string} body
 */
function sendOwnerEmail_(to, subject, body) {
  GmailApp.sendEmail(to, subject, body, { name: 'GAS Agent' });
}

/**
 * 依 deliver_to 投遞。不 throw：失敗回 ok=false 讓呼叫端記進 last_status。
 * @param {{name: string, id: (string|undefined), schedule: (string|undefined), deliver_to: string}} cron
 * @param {!Object} result runTurn 摘要（見 buildDeliveryContent_）
 * @param {{createDoc: (Function|undefined), sendEmail: (Function|undefined), sendTelegram: (Function|undefined), telegramChatId: (string|undefined), ownerEmail: (string|undefined), now: (Function|undefined)}=} deps
 * @return {{channel: string, ok: boolean, ref: string, id: string, summary: string, error: string}}
 */
function deliverResult_(cron, result, deps) {
  deps = deps || {};
  const target = String(cron.deliver_to || 'none').toLowerCase();
  const content = buildDeliveryContent_(cron, result, new Date(deps.now ? deps.now() : Date.now()));
  try {
    if (target === 'none') return { channel: 'none', ok: true, ref: '', id: '', summary: '不投遞', error: '' };
    if (target === 'doc') {
      const doc = (deps.createDoc || createReportDoc_)(content.title, content.body);
      return { channel: 'doc', ok: true, ref: doc.url, id: doc.id, summary: `Doc「${content.title}」 ${doc.url}`, error: '' };
    }
    if (target === 'email') {
      const to = deps.ownerEmail || getOwnerEmail_();
      if (!to) throw new Error('OWNER_EMAIL 未設定。');
      (deps.sendEmail || sendOwnerEmail_)(to, content.subject, content.body);
      return { channel: 'email', ok: true, ref: to, id: '', summary: `已寄到 ${to}（${content.subject}）`, error: '' };
    }
    if (target === 'telegram') {
      let chatId = deps.telegramChatId;
      if (chatId === undefined) {
        const ccfg = getChannelConfig_();
        chatId = ccfg.telegramOwnerChatId || ccfg.telegramAllowedUserIds[0] || '';
      }
      if (!chatId) throw new Error('沒有 Telegram chat id：先在 Telegram 對 bot 說一句話，或在「通道」分頁填白名單 user id。');
      (deps.sendTelegram || ((c, t) => telegramSend_(c, t)))(String(chatId), `📋 ${content.title}\n\n${content.body}`);
      return { channel: 'telegram', ok: true, ref: String(chatId), id: '', summary: `已送到 Telegram chat ${chatId}`, error: '' };
    }
    throw new Error(`未知的 deliver_to：${target}`);
  } catch (err) {
    const message = String(err && err.message || err);
    return { channel: target, ok: false, ref: '', id: '', summary: `投遞失敗：${message}`, error: message };
  }
}
