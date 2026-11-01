/**
 * @fileoverview 管理頁：doGet 路由 + google.script.run 後端入口。
 *
 * 部署 A（「以我執行 / 只限我」）負責管理頁。
 * 部署 B（M6；「以我執行 / 任何人」）給 Telegram webhook，URL 帶 ?src=telegram&key=...；
 * 同一份程式碼在 doGet 依 src 參數分流，部署 B 永遠不會拿到管理頁 HTML。
 *
 * 規則：每個可被前端呼叫的入口（admin*）第一行都是 assertOwner()。
 * 私有 helper 一律以 `_` 結尾，google.script.run 無法呼叫。
 */

/**
 * Web App GET 入口。
 * @param {GoogleAppsScript.Events.DoGet} e
 * @return {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  const params = (e && e.parameter) || {};

  // Telegram webhook 部署：只回一行文字，不回管理頁。用 HtmlService 而非 ContentService 以免 302。
  if (params.src === 'telegram') {
    return HtmlService.createHtmlOutput('GAS Agent webhook endpoint');
  }

  if (!getOwnerEmail_()) {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:system-ui,sans-serif;padding:2rem">GAS Agent 尚未安裝：' +
      '請先在 Apps Script 編輯器執行 <code>installAgent()</code> 並完成授權，再重新整理此頁。</p>'
    ).setTitle('GAS Agent');
  }

  try {
    assertOwner();
  } catch (err) {
    // 匿名或非 owner：回一頁乾淨的拒絕訊息，不洩漏堆疊。
    return HtmlService.createHtmlOutput(
      '<p style="font-family:system-ui,sans-serif;padding:2rem">' + escapeHtml_(String(err.message || err)) + '</p>'
    ).setTitle('GAS Agent');
  }

  const template = HtmlService.createTemplateFromFile('AdminPage');
  template.bootstrap = JSON.stringify({
    version: APP_VERSION,
    owner: getOwnerEmail_(),
  });
  return template.evaluate()
    .setTitle('GAS Agent 管理頁')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 模板用：把 admin_css.html / admin_js.html 內容嵌進 AdminPage.html。
 * @param {string} name 檔名（不含 .html）
 * @return {string}
 */
function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * 儀表板資料。
 * @return {{version: string, owner: string, timeZone: string, db: {id: string, url: string}, triggerCount: number, webAppUrl: string}}
 */
function adminGetOverview() {
  assertOwner();
  let webAppUrl = '';
  try {
    webAppUrl = ScriptApp.getService().getUrl() || '';
  } catch (err) {
    webAppUrl = '';
  }
  return {
    version: APP_VERSION,
    owner: getOwnerEmail_(),
    timeZone: Session.getScriptTimeZone(),
    db: { id: getDbSpreadsheetId_(), url: getDbUrl_() },
    triggerCount: listQueueTriggers_().length,
    webAppUrl,
  };
}

/**
 * Doctor 分頁：跑全部健檢。
 * @return {Object} runDoctor() 的結果
 */
function adminRunDoctor() {
  assertOwner();
  return runDoctor();
}

/**
 * Doctor 分頁：跑 smoke tests。
 * @return {Object} runSmokeTests() 的結果
 */
function adminRunSmokeTests() {
  assertOwner();
  return runSmokeTests();
}

/**
 * Doctor 分頁：重新安裝（補 tabs、補 trigger）。
 * @return {Object} installAgent() 的結果
 */
function adminReinstall() {
  assertOwner();
  return installAgent();
}

// ---- M1：模型分頁 ------------------------------------------------------------------

/**
 * 模型分頁：全部 provider（含停用），key 只回 hasKey 與末 4 碼。
 * @return {!Array<!Object>}
 */
function adminListProviders() {
  assertOwner();
  return listProviders_().map(publicProvider_);
}

/**
 * 模型分頁：新增 / 編輯 provider。若 input.apiKey 非空，同時寫入 Script Properties；key 不會回傳。
 * @param {!Object} input 表單欄位（extra_headers / extra_body 為 JSON 字串）+ 可選 apiKey
 * @return {!Object} publicProvider_
 */
function adminSaveProvider(input) {
  assertOwner();
  const p = saveProvider_(input || {});
  if (input && typeof input.apiKey === 'string' && input.apiKey.trim()) {
    setProviderKey_(p.id, input.apiKey);
  }
  return publicProvider_(p);
}

/**
 * 模型分頁：啟用 / 停用。
 * @param {string} id
 * @param {boolean} enabled
 * @return {!Object} publicProvider_
 */
function adminSetProviderEnabled(id, enabled) {
  assertOwner();
  const p = getProvider_(id);
  if (!p) throw new Error(`找不到 provider「${id}」。`);
  p.enabled = !!enabled;
  return publicProvider_(saveProvider_(p));
}

/**
 * 模型分頁：清除 API key（provider 保留）。
 * @param {string} id
 * @return {!Object} publicProvider_
 */
function adminClearProviderKey(id) {
  assertOwner();
  const p = getProvider_(id);
  if (!p) throw new Error(`找不到 provider「${id}」。`);
  setProviderKey_(id, '');
  return publicProvider_(p);
}

/**
 * 模型分頁：刪除 provider 與其 key。
 * @param {string} id
 * @return {{deleted: boolean}}
 */
function adminDeleteProvider(id) {
  assertOwner();
  return { deleted: deleteProvider_(id) };
}

/**
 * 模型分頁：測試連線（送一則極短訊息）。
 * @param {string} id
 * @return {!Object} testProvider_ 的結果
 */
function adminTestProvider(id) {
  assertOwner();
  return testProvider_(id);
}

// ---- M1：聊天台 -------------------------------------------------------------------

/**
 * 聊天台：單輪對話（M1 無工具、無 session 持久化）。
 * @param {{providerId: (string|undefined), message: string, system: (string|undefined)}} input
 *   providerId 空字串 / 省略 = 走 main 備援鏈
 * @return {{text: string, provider: string, model: string, usage: Object, ms: number, costEst: number,
 *   stop: string, fallbacks: !Array<!Object>}}
 */
function adminChat(input) {
  assertOwner();
  input = input || {};
  const message = String(input.message || '').trim();
  if (!message) throw new Error('訊息不可為空。');
  const messages = [];
  if (input.system && String(input.system).trim()) messages.push({ role: 'system', content: String(input.system).trim() });
  messages.push({ role: 'user', content: message });
  const r = runChatTurn_({
    providerId: input.providerId || '',
    role: 'main',
    messages,
    sessionId: 'admin-chat',
  });
  // raw 可能很大且含 provider 專屬欄位，不回前端。
  return {
    text: r.text,
    provider: r.provider,
    model: r.model,
    usage: r.usage,
    ms: r.ms,
    costEst: r.costEst,
    stop: r.stop,
    toolCalls: r.toolCalls,
    fallbacks: r.fallbacks || [],
  };
}

/**
 * @param {string} str
 * @return {string}
 */
function escapeHtml_(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
