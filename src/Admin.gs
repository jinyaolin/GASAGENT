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

// ---- M2：聊天台（接工具迴圈）------------------------------------------------------

/**
 * 聊天台：一輪含工具呼叫的對話。M2 仍是同步 google.script.run（上限 6 分鐘；迴圈自己在 4.5 分鐘停）。
 * history 由前端保存（只含 user / assistant 文字），M3 才做 server 端 session。
 * @param {{providerId: (string|undefined), message: string, system: (string|undefined),
 *   history: (!Array<{role: string, content: string}>|undefined)}} input
 * @return {!Object} runTurn_ 的結果去掉 messages（可能很大）
 */
function adminChat(input) {
  assertOwner();
  input = input || {};
  ensureToolConfigDefaults_(); // 新 toolset 沒有 rbac 列會被一律拒絕；這裡幂等補預設值
  const r = runTurn_({
    message: String(input.message || ''),
    history: Array.isArray(input.history) ? input.history.slice(-20) : [],
    providerId: input.providerId || '',
    systemExtra: input.system || '',
    sessionId: 'admin-chat',
    mode: 'interactive',
  });
  return {
    text: r.text,
    steps: r.steps.map((s) => ({
      tool: s.tool, argsPreview: s.argsPreview, resultPreview: s.resultPreview, status: s.status, ok: s.ok, ms: s.ms,
      approvalId: s.approvalId, spillFileId: s.spillFileId,
    })),
    stopped: r.stopped,
    stoppedDetail: r.stoppedDetail,
    provider: r.provider,
    model: r.model,
    usage: r.usage,
    costEst: r.costEst,
    ms: r.ms,
    llmCalls: r.llmCalls,
    fallbacks: r.fallbacks || [],
  };
}

// ---- M2：工具分頁 -----------------------------------------------------------------

/**
 * 工具分頁：registry（每個 toolset 的工具與風險）+ 目前 Config 設定。
 * @return {{toolsets: !Array<!Object>, approval_policy: string, spill_threshold: number, max_tool_steps: number,
 *   web_allowed_domains: string, persona: string, default_persona: string, policies: !Array<string>}}
 */
function adminGetToolSettings() {
  assertOwner();
  ensureToolConfigDefaults_();
  const registry = getToolRegistry_();
  const config = getToolConfig_();
  return {
    toolsets: registry.toolsets.map((name) => ({
      name,
      perms: config.rbac[name] || null,
      tools: registry.list.filter((t) => t.toolset === name).map((t) => ({ name: t.name, risk: t.risk, description: t.description })),
    })),
    approval_policy: config.approvalPolicy,
    spill_threshold: config.spillThreshold,
    max_tool_steps: config.maxToolSteps,
    web_allowed_domains: config.webAllowedDomains.join('\n'),
    persona: config.persona,
    default_persona: DEFAULT_PERSONA,
    default_perms: DEFAULT_TOOLSET_PERMS,
    policies: APPROVAL_POLICIES.slice(),
  };
}

/**
 * 工具分頁：儲存設定到 Config sheet。
 * @param {!Object} input 見 saveToolConfig_
 * @return {!Object} adminGetToolSettings()
 */
function adminSaveToolSettings(input) {
  assertOwner();
  saveToolConfig_(input || {});
  return adminGetToolSettings();
}

// ---- M2：紀錄 / 審批 -----------------------------------------------------------------

/**
 * 紀錄分頁：待審批 + 最近已處理的審批。
 * @return {{pending: !Array<!Object>, decided: !Array<!Object>}}
 */
function adminListApprovals() {
  assertOwner();
  const all = listApprovals_().map((r) => { const o = Object.assign({}, r); delete o._row; return o; });
  return {
    pending: all.filter((r) => r.state === 'pending'),
    decided: all.filter((r) => r.state !== 'pending').slice(0, 30),
  };
}

/**
 * 紀錄分頁：批准（立即執行一次）或拒絕。
 * @param {string} id
 * @param {boolean} approve
 * @return {{id: string, state: string, outcome: ?Object}}
 */
function adminDecideApproval(id, approve) {
  assertOwner();
  const r = decideApproval_(String(id || ''), !!approve);
  if (r.outcome) {
    r.outcome = { status: r.outcome.status, ok: r.outcome.ok, ms: r.outcome.ms, content: truncateText_(r.outcome.content, 2000).text };
  }
  return r;
}

/**
 * 紀錄分頁：最近的 AuditLog（新的在前）。
 * @param {number=} limit 預設 50，上限 200
 * @return {!Array<!Object>}
 */
function adminListAuditLog(limit) {
  assertOwner();
  const n = clampInt_(limit, 50, 1, 200);
  const rows = readTable_('AuditLog').rows;
  return rows.slice(Math.max(0, rows.length - n)).reverse().map((r) => ({
    ts: r.ts instanceof Date ? fmtDate_(r.ts) : String(r.ts || ''),
    session_id: String(r.session_id || ''),
    tool: String(r.tool || ''),
    args_preview: String(r.args_preview || ''),
    result_preview: String(r.result_preview || ''),
    ok: toBoolean_(r.ok),
    ms: toNumber_(r.ms, 0),
  }));
}

/**
 * @param {string} str
 * @return {string}
 */
function escapeHtml_(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
