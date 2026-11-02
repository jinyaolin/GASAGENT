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
 * input.isNew=true 表示「新增」：id 已存在就拒絕，避免同一個範本（例如兩個 gemini）互相覆蓋。
 * @param {!Object} input 表單欄位（extra_headers / extra_body 為 JSON 字串）+ 可選 apiKey + 可選 isNew
 * @return {!Object} publicProvider_
 */
function adminSaveProvider(input) {
  assertOwner();
  input = input || {};
  if (input.isNew && getProvider_(String(input.id || '').trim().toLowerCase())) {
    throw new Error(`provider id「${input.id}」已存在。同一協定要加第二組請換一個 id（例如 ${input.id}-2）；要修改既有的請用該列的「編輯」。`);
  }
  const p = saveProvider_(input);
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

// ---- M3：聊天台（session 持久化）------------------------------------------------------

/**
 * 聊天台：一輪含工具呼叫與 session 持久化。sessionId 空 = 沿用最近的 active admin session（閒置過久會自動開新的）。
 * 輸入 `/new` 關閉目前 session 並開新的；`/status` 看目前 session。同步 google.script.run（上限 6 分鐘；迴圈 4.5 分鐘停）。
 * @param {{providerId: (string|undefined), message: string, system: (string|undefined), sessionId: (string|undefined)}} input
 * @return {!Object} runSessionTurn_ 的結果去掉 messages
 */
function adminChat(input) {
  assertOwner();
  input = input || {};
  ensureToolConfigDefaults_(); // 新 toolset 沒有 rbac 列會被一律拒絕；這裡幂等補預設值
  const r = runSessionTurn_({
    message: String(input.message || ''),
    sessionId: String(input.sessionId || ''),
    channel: 'admin',
    providerId: input.providerId || '',
    systemExtra: input.system || '',
    mode: 'interactive',
  });
  return {
    text: r.text,
    steps: (r.steps || []).map((s) => ({
      tool: s.tool, argsPreview: s.argsPreview, resultPreview: s.resultPreview, status: s.status, ok: s.ok, ms: s.ms,
      approvalId: s.approvalId, spillFileId: s.spillFileId,
    })),
    stopped: r.stopped || '',
    stoppedDetail: r.stoppedDetail || '',
    provider: r.provider || '',
    model: r.model || '',
    usage: r.usage,
    costEst: r.costEst || 0,
    ms: r.ms,
    llmCalls: r.llmCalls || 0,
    fallbacks: r.fallbacks || [],
    sessionId: r.sessionId,
    sessionCreated: !!r.sessionCreated,
    sessionReason: r.sessionReason || '',
    turns: r.turns || 0,
    compacted: !!r.compacted,
    curation: r.curation ? describeCuration_(r.curation) : '',
    command: r.command || '',
    skills: r.skills || { loaded: [], missing: [] },
    skillProposal: r.skillProposal ? {
      evaluated: true, proposed: !!r.skillProposal.proposed, approvalId: r.skillProposal.approvalId || '', status: r.skillProposal.status || '',
      text: r.skillProposal.text || '',
      steps: (r.skillProposal.steps || []).map((s) => ({ tool: s.tool, argsPreview: s.argsPreview, resultPreview: s.resultPreview, status: s.status, ok: s.ok, ms: s.ms, approvalId: s.approvalId })),
    } : null,
  };
}

/**
 * 聊天台 / 記憶分頁：最近的 session。
 * @param {number=} limit
 * @return {!Array<!Object>}
 */
function adminListSessions(limit) {
  assertOwner();
  return sheetSessionStore_().listRecent(clampInt_(limit, 20, 1, 200)).map(publicSession_);
}

/**
 * @param {SessionRow} s
 * @return {!Object}
 */
function publicSession_(s) {
  return {
    id: s.id, channel: s.channel, title: s.title, summary: s.summary, status: s.status, turns: s.turns, token_est: s.token_est,
    compact_seq: s.compact_seq, last_curated_turn: s.last_curated_turn, has_embedding: !!s.embedding,
    created: fmtDate_(s.created), last_active: fmtDate_(s.last_active),
  };
}

/**
 * 記憶分頁：某 session 的訊息（活訊息 + 壓縮前的也給，供檢視）。
 * @param {string} sessionId
 * @param {number=} limit 最後幾則，預設 60
 * @return {{session: ?Object, messages: !Array<!Object>}}
 */
function adminGetSessionMessages(sessionId, limit) {
  assertOwner();
  const store = sheetSessionStore_();
  const s = store.get(String(sessionId || ''));
  if (!s) return { session: null, messages: [] };
  const all = store.loadMessages(s.id, 0);
  const n = clampInt_(limit, 60, 1, 500);
  return {
    session: publicSession_(s),
    messages: all.slice(Math.max(0, all.length - n)).map((m) => ({
      seq: m.seq, role: m.role,
      text: m.role === 'tool' ? truncateText_(stringifyContent_(m.content), 600).text
        : (m.tool_calls && m.tool_calls.length ? `[呼叫工具] ${m.tool_calls.map((tc) => tc.function.name).join(', ')}` + (m.content ? '\n' + m.content : '') : truncateText_(stringifyContent_(m.content), 4000).text),
      name: m.name || '',
    })),
  };
}

/**
 * 記憶分頁：關閉 session（跑 curation）。
 * @param {string} sessionId
 * @return {{closed: boolean, curation: string}}
 */
function adminCloseSession(sessionId) {
  assertOwner();
  const store = sheetSessionStore_();
  const s = store.get(String(sessionId || ''));
  if (!s) throw new Error(`找不到 session ${sessionId}`);
  if (s.status !== 'active') return { closed: false, curation: '已經是 ' + s.status };
  const r = closeSession_(s, { store, cfg: getAgentConfig_() });
  return { closed: true, curation: describeCuration_(r.curation) };
}

/**
 * 記憶分頁：對某 session 立刻跑一次 curation（提議進 Approvals，或依設定自動套用）。
 * @param {string} sessionId
 * @return {{curation: string, ops: !Array<!Object>}}
 */
function adminRunCuration(sessionId) {
  assertOwner();
  const store = sheetSessionStore_();
  const s = store.get(String(sessionId || ''));
  if (!s) throw new Error(`找不到 session ${sessionId}`);
  if (!s.turns) throw new Error('這個 session 還沒有任何輪次。');
  const r = curateSession_(s, { store, cfg: getAgentConfig_() });
  return { curation: describeCuration_(r), ops: r.ops };
}

// ---- M3：記憶分頁 -----------------------------------------------------------------------

/**
 * 記憶分頁：兩表全部條目與容量。
 * @return {{memory: !Object, user: !Object}}
 */
function adminGetMemory() {
  assertOwner();
  const store = sheetMemoryStore_();
  const cfg = getAgentConfig_();
  const out = {};
  Object.keys(MEMORY_TARGETS).forEach((target) => {
    const entries = store.list(target).map((e) => ({
      id: e.id, content: e.content, category: e.category, pinned: e.pinned, source_session: e.source_session,
      created: fmtDate_(e.created), updated: fmtDate_(e.updated),
    }));
    out[target] = { label: MEMORY_TARGETS[target].label, hint: MEMORY_TARGETS[target].hint, used: memoryUsedChars_(store.list(target)), limit: memoryLimit_(target, cfg), entries };
  });
  return out;
}

/**
 * 記憶分頁：owner 直接新增 / 編輯 / 刪除條目（不受 agent 的 pinned 限制，但仍受容量上限）。
 * @param {{target: string, action: string, id: (string|undefined), content: (string|undefined), category: (string|undefined), pinned: (boolean|undefined)}} input
 * @return {!Object} adminGetMemory()
 */
function adminSaveMemoryEntry(input) {
  assertOwner();
  input = input || {};
  const store = sheetMemoryStore_();
  const cfg = getAgentConfig_();
  const target = String(input.target || '');
  if (!MEMORY_TARGETS[target]) throw new Error('target 必須是 memory 或 user。');
  const entries = store.list(target);
  const limit = memoryLimit_(target, cfg);
  const content = String(input.content || '').trim().replace(/\s+/g, ' ');
  if (input.action === 'add') {
    if (!content) throw new Error('內容不可為空。');
    if (memoryUsedChars_(entries) + content.length > limit) throw new Error(`超過容量：${memoryUsedChars_(entries)} + ${content.length} > ${limit}`);
    store.add(target, { content, category: String(input.category || '').trim(), pinned: !!input.pinned, source_session: 'owner' });
  } else {
    const e = entries.find((x) => x.id === String(input.id || ''));
    if (!e) throw new Error(`找不到條目 ${input.id}`);
    if (input.action === 'delete') {
      store.remove(target, e);
    } else if (input.action === 'update') {
      if (!content) throw new Error('內容不可為空。');
      if (memoryUsedChars_(entries) - e.content.length + content.length > limit) throw new Error('超過容量。');
      e.content = content;
      e.category = String(input.category === undefined ? e.category : input.category).trim();
      if (input.pinned !== undefined) e.pinned = !!input.pinned;
      store.update(target, e);
    } else {
      throw new Error('action 必須是 add / update / delete。');
    }
  }
  return adminGetMemory();
}

// ---- M3：設定分頁 -----------------------------------------------------------------------

/**
 * 設定分頁：Agent 層設定 + 預設值 + 是否有 fast / embed provider。
 * @return {!Object}
 */
function adminGetAgentSettings() {
  assertOwner();
  ensureToolConfigDefaults_();
  const providers = listProviders_();
  return {
    config: getAgentConfig_(),
    defaults: AGENT_CONFIG_DEFAULTS,
    hasFast: providerChain_('fast', providers).length > 0,
    hasEmbed: providerChain_('embed', providers).length > 0,
  };
}

/**
 * 設定分頁：儲存。
 * @param {!Object} input key 同 AGENT_CONFIG_DEFAULTS
 * @return {!Object} adminGetAgentSettings()
 */
function adminSaveAgentSettings(input) {
  assertOwner();
  saveAgentConfig_(input || {});
  return adminGetAgentSettings();
}

// ---- M2：工具分頁 -----------------------------------------------------------------

/**
 * 工具分頁：registry（每個 toolset 的工具與風險）+ 目前 Config 設定。
 * @return {{toolsets: !Array<!Object>, approval_policy: string, spill_threshold: number, max_tool_steps: number,
 *   web_allowed_domains: string, persona: string, default_persona: string, slides_template_id: string, policies: !Array<string>}}
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
    slides_template_id: config.slidesTemplateId,
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
 * @return {{id: string, state: string, outcome: ?Object, continuation: string}}
 */
function adminDecideApproval(id, approve) {
  assertOwner();
  const r = decideApproval_(String(id || ''), !!approve);
  if (r.outcome) {
    r.outcome = { status: r.outcome.status, ok: r.outcome.ok, ms: r.outcome.ms, content: truncateText_(r.outcome.content, 2000).text };
  }
  return r; // r.continuation = 續跑 job id（M4），沒有為空字串
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

// ---- M4：Queue / 排程 -----------------------------------------------------------------------

/**
 * 聊天台「背景執行」：把一輪排進 Queue（turn job），由每分鐘 trigger 執行；前端用 adminGetJob 輪詢。
 * @param {{providerId: (string|undefined), message: string, system: (string|undefined), sessionId: (string|undefined)}} input
 * @return {!Object} publicJob_
 */
function adminEnqueueChat(input) {
  assertOwner();
  input = input || {};
  const message = String(input.message || '').trim();
  if (!message) throw new Error('訊息不可為空。');
  ensureToolConfigDefaults_();
  const job = enqueue_('turn', {
    message, providerId: input.providerId || '', systemExtra: input.system || '', channel: 'admin', mode: 'interactive',
  }, String(input.sessionId || ''));
  return publicJob_(job);
}

/**
 * 紀錄分頁 / 聊天台輪詢：單一 job。
 * @param {string} id
 * @return {?Object} publicJob_；找不到回 null
 */
function adminGetJob(id) {
  assertOwner();
  const job = sheetQueueStore_().get(String(id || ''));
  return job ? publicJob_(job) : null;
}

/**
 * 紀錄分頁：最近的 job（新的在前）與旗標狀態。
 * @param {number=} limit 預設 30，上限 200
 * @return {{jobs: !Array<!Object>, dirty: boolean, cronNextRun: string, triggerCount: number}}
 */
function adminListQueue(limit) {
  assertOwner();
  const n = clampInt_(limit, 30, 1, 200);
  const jobs = sheetQueueStore_().list();
  return {
    jobs: jobs.slice(Math.max(0, jobs.length - n)).reverse().map(publicJob_),
    dirty: getProp_(PROP.QUEUE_DIRTY) === '1',
    cronNextRun: getProp_(PROP.CRON_NEXT_RUN),
    triggerCount: listQueueTriggers_().length,
  };
}

/**
 * 紀錄分頁：把 failed 的 job 重新排回 queued。
 * @param {string} id
 * @return {!Object} publicJob_
 */
function adminRetryJob(id) {
  assertOwner();
  return publicJob_(retryJob_(String(id || '')));
}

/**
 * 紀錄分頁：立刻跑一次 tick（同步，最多 4.5 分鐘；trigger 同時在跑時會因鎖而略過）。除錯 / 不想等 trigger 時用。
 * @return {!Object} queueTickCore_ 的報告
 */
function adminQueueTick() {
  assertOwner();
  return queueTickCore_({});
}

/**
 * 排程分頁：全部排程 + 可選的 provider + 旗標。
 * @return {{crons: !Array<!Object>, providers: !Array<!Object>, cronNextRun: string, deliverTargets: !Array<string>}}
 */
function adminListCron() {
  assertOwner();
  ensureToolConfigDefaults_();
  const crons = sheetCronStore_().list();
  // 旗標與 tab 對齊（例如直接在 sheet 改過）。
  try { refreshCronNextRunProp_(crons); } catch (err) { /* 忽略 */ }
  return {
    crons: crons.map(publicCron_),
    providers: listProviders_().filter((p) => p.enabled && p.role !== 'embed').map((p) => ({ id: p.id, label: p.label, model: p.model, role: p.role })),
    cronNextRun: getProp_(PROP.CRON_NEXT_RUN),
    deliverTargets: CRON_DELIVER_TARGETS.slice(),
  };
}

/**
 * 排程分頁：新增（無 id）或編輯（有 id）。
 * @param {!Object} input id? / name / schedule / prompt / deliver_to / model_pin / skills / enabled
 * @return {!Object} publicCron_
 */
function adminSaveCron(input) {
  assertOwner();
  input = input || {};
  const deps = { cronStore: sheetCronStore_(), providerIds: listProviders_().map((p) => p.id) };
  const c = input.id ? updateCron_(String(input.id), input, deps) : createCron_(input, deps);
  return publicCron_(c);
}

/**
 * 排程分頁：啟用 / 停用（停用不刪列）。
 * @param {string} id
 * @param {boolean} enabled
 * @return {!Object} publicCron_
 */
function adminSetCronEnabled(id, enabled) {
  assertOwner();
  return publicCron_(updateCron_(String(id || ''), { enabled: !!enabled }, { cronStore: sheetCronStore_() }));
}

/**
 * 排程分頁：立即執行（enqueue 一個 cron job；trigger 一分鐘內會跑）。
 * @param {string} id
 * @return {!Object} publicJob_
 */
function adminRunCronNow(id) {
  assertOwner();
  return publicJob_(runCronNow_(String(id || ''), { cronStore: sheetCronStore_(), queueStore: sheetQueueStore_() }));
}

// ---- M5：技能分頁 -----------------------------------------------------------------------------

/**
 * 技能分頁：索引（略過快取）+ 資料夾資訊。第一次開（資料夾為空）會寫入內建範例技能。
 * @return {{skills: !Array<!Object>, folder: {id: string, name: string, url: string, configured: boolean}, installed: !Array<string>}}
 */
function adminListSkills() {
  assertOwner();
  ensureToolConfigDefaults_();
  const store = driveSkillStore_();
  const installed = installBuiltinSkills_(store);
  const folder = store.folder();
  return {
    skills: getSkillIndex_(store, { force: true }),
    folder: { id: folder.getId(), name: folder.getName(), url: folder.getUrl(), configured: !!getToolConfig_().skillsFolderId },
    installed,
  };
}

/**
 * 技能分頁：單一技能全文（給編輯表單）。
 * @param {string} name
 * @return {{name: string, description: string, triggers: !Array<string>, version: string, enabled: boolean, body: string, text: string, fileId: string, url: string, updated: string}}
 */
function adminGetSkill(name) {
  assertOwner();
  const got = loadSkill_(String(name || ''), driveSkillStore_());
  if (!got) throw new Error(`找不到技能「${name}」。`);
  const s = got.skill;
  return { name: s.name, description: s.description, triggers: s.triggers, version: s.version, enabled: s.enabled, body: s.body, text: got.text, fileId: got.fileId, url: got.url, updated: got.updated };
}

/**
 * 技能分頁：owner 直接新增 / 編輯（不走審批）。表單欄位組成 frontmatter + 正文。
 * @param {{name: string, description: string, triggers: (string|Array<string>|undefined), version: (string|undefined), enabled: (boolean|undefined), body: string, isNew: (boolean|undefined)}} input
 * @return {!Object} adminListSkills()
 */
function adminSaveSkill(input) {
  assertOwner();
  input = input || {};
  const store = driveSkillStore_();
  const name = requireSkillName_(input.name);
  if (input.isNew && store.get(name)) throw new Error(`技能「${name}」已存在；要修改請用該列的「編輯」。`);
  const text = serializeSkillFile_({ name, description: input.description, triggers: input.triggers, version: input.version, enabled: input.enabled !== false, body: input.body });
  parseSkillFile_(text); // 寫入前再驗一次
  store.save(name, text);
  return adminListSkills();
}

/**
 * 技能分頁：啟用 / 停用（改 frontmatter enabled）。
 * @param {string} name
 * @param {boolean} enabled
 * @return {!Object} adminListSkills()
 */
function adminSetSkillEnabled(name, enabled) {
  assertOwner();
  driveSkillStore_().setEnabled(requireSkillName_(name), !!enabled);
  return adminListSkills();
}

/**
 * 技能分頁：重新索引（清 CacheService 快取後重讀 Drive）。
 * @return {!Object} adminListSkills()
 */
function adminReindexSkills() {
  assertOwner();
  invalidateSkillIndex_();
  return adminListSkills();
}

/**
 * 技能分頁：改技能資料夾（Config skills_folder_id；空 = 預設 GAS Agent/skills）。
 * @param {string} folderIdOrUrl
 * @return {!Object} adminListSkills()
 */
function adminSetSkillsFolder(folderIdOrUrl) {
  assertOwner();
  const id = parseDriveId_(folderIdOrUrl);
  if (id) DriveApp.getFolderById(id); // 驗證可開啟
  setConfigValues_({ [TOOL_CONFIG_KEYS.SKILLS_FOLDER_ID]: id });
  skillsFolderCache_ = null;
  invalidateSkillIndex_();
  return adminListSkills();
}

/**
 * @param {string} str
 * @return {string}
 */
function escapeHtml_(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
