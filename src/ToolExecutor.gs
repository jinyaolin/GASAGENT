/**
 * @fileoverview 工具執行：參數驗證 → 主體（principal）開關 → RBAC → 審批策略 → 執行 handler → AuditLog → 輸出溢寫。
 *
 * 設定全部來自 Config sheet（見 TOOL_CONFIG_KEYS）：
 * - `rbac.<toolset>` = JSON {read, write, delete, external}；**沒有這一列的 toolset 一律拒絕**。
 *   installAgent() 會以預設值（read / write 開、delete / external 關）補齊缺的 toolset。
 * - `approval_policy`：X 類工具何時送審批。always 一律送 / autonomous_only 只有無人模式（cron）送 /
 *   never 直接執行。M2 只有互動模式，但判斷完整，M4 的 Queue 把 mode='autonomous' 傳進來即可。
 * - `spill_threshold`：工具結果超過幾個字元就溢寫到 Drive `GAS Agent/spill/`，context 只留前 1000 字 + file id。
 * - `max_tool_steps`：單輪工具步數上限（Agent.gs 用）。
 * - `web_allowed_domains`：web_fetch 的域名白名單（一行一個；空 = 全拒）。
 * - `persona`：system prompt 開頭的人格描述。
 * - `slides_template_id`：slides_create_deck 預設複製的範本簡報（Drive file id 或網址）；空 = Google 預設主題。
 * - `skills_folder_id`（M5）：技能資料夾的 Drive id；空 = 自動建 `GAS Agent/skills`。
 * - `gmail_send_whitelist`（M7）：寄信白名單（一行一個 email 或 `*@domain`）。gmail_send / gmail_forward 的收件人（to / cc / bcc）
 *   **全部**在名單內時，owner 觸發的那次免審批直接寄；任何一個不在、收件人不明（寄草稿 / 回覆討論串）、或由群組成員觸發，仍走審批。
 *   管理頁「工具」分頁與 Telegram `/white list|add|delete <email>` 都能改；異動記 AuditLog `security:whitelist:*`。
 *
 * 全部外部依賴（registry、config、記錄寫入、溢寫儲存）都可由 deps 注入，測試不碰 Drive / Sheet。
 */

/** Config sheet 的 key。 */
const TOOL_CONFIG_KEYS = Object.freeze({
  APPROVAL_POLICY: 'approval_policy',
  SPILL_THRESHOLD: 'spill_threshold',
  MAX_TOOL_STEPS: 'max_tool_steps',
  WEB_ALLOWED_DOMAINS: 'web_allowed_domains',
  PERSONA: 'persona',
  SLIDES_TEMPLATE_ID: 'slides_template_id',
  SKILLS_FOLDER_ID: 'skills_folder_id',
  GMAIL_SEND_WHITELIST: 'gmail_send_whitelist',
});

/** RBAC 設定 key 前綴：rbac.<toolset>。 */
const RBAC_KEY_PREFIX = 'rbac.';

/** 四個 RBAC 開關。 */
const RBAC_PERMISSIONS = Object.freeze(['read', 'write', 'delete', 'external']);

/** 審批策略。 */
const APPROVAL_POLICIES = Object.freeze(['always', 'autonomous_only', 'never']);

/**
 * 主體（principal；M7-A）：RBAC 之外的第二層開關，依「誰觸發這一輪」決定可用的 toolset。
 * - owner：白名單本人（管理頁 / Email / Telegram 私聊 / 群組裡的白名單成員）—— 只看 RBAC 與審批策略。
 * - group_member：Telegram 群聊模式（/group on）裡的非白名單成員 —— 只能用 PRINCIPAL_DEFAULT_TOOLSETS.group_member
 *   （owner 可在管理頁「通道」分頁逐 toolset 放寬，Config telegram_member_toolsets），而且只有 R 類直接跑，
 *   W / D / X 一律送 owner 審批（不看 approval_policy）。PRINCIPAL_LOCKED_TOOLSETS 裡的 toolset 永遠拒絕、不可放寬。
 * - guest：訪客模式（/group guest）—— 沒有任何工具。
 * 不認得的 principal 一律當 guest（fail closed）；未指定（舊呼叫端）當 owner。
 */
const PRINCIPALS = Object.freeze(['owner', 'group_member', 'guest']);
/** 各 principal 預設可用的 toolset（owner 不限）。 */
const PRINCIPAL_DEFAULT_TOOLSETS = Object.freeze({ group_member: Object.freeze(['web', 'skill', 'session']) });
/** 各 principal 永遠拒絕、owner 也無法放寬的 toolset（記憶是 owner 的長期記憶、cronjob 會留下常駐自動化）。 */
const PRINCIPAL_LOCKED_TOOLSETS = Object.freeze({ group_member: Object.freeze(['memory', 'cronjob']) });
/** Workspace 類 toolset（群組放寬這些時 Doctor 會提醒）。 */
const WORKSPACE_TOOLSETS = Object.freeze(['drive', 'docs', 'sheets', 'slides', 'gmail', 'calendar']);

/** 新 toolset 的預設開關。 */
const DEFAULT_TOOLSET_PERMS = Object.freeze({ read: true, write: true, delete: false, external: false });

const DEFAULT_APPROVAL_POLICY = 'always';
const DEFAULT_SPILL_THRESHOLD = 8000;
const DEFAULT_MAX_TOOL_STEPS = 25;
/** 溢寫後留在 context 的預覽字數。 */
const SPILL_PREVIEW_CHARS = 1000;
/** AuditLog 的 args / result 預覽字數。 */
const AUDIT_PREVIEW_CHARS = 500;
/** Drive 溢寫資料夾（根目錄下）。 */
const SPILL_FOLDER_PATH = Object.freeze(['GAS Agent', 'spill']);

/**
 * @typedef {{
 *   rbac: !Object<string, {read: boolean, write: boolean, delete: boolean, external: boolean}>,
 *   approvalPolicy: string, spillThreshold: number, maxToolSteps: number,
 *   webAllowedDomains: !Array<string>, persona: string, slidesTemplateId: string, skillsFolderId: string,
 *   gmailSendWhitelist: !Array<string>
 * }} ToolConfig
 */

/**
 * @typedef {{
 *   name: string, status: ('ok'|'error'|'denied'|'invalid'|'pending_approval'), ok: boolean,
 *   content: string, result: *, ms: number, approvalId: string, spill: ?{fileId: string, total: number}, error: string
 * }} ToolOutcome
 * content 是回給模型的字串（已截長 / 溢寫）；result 是 handler 原始回傳（只有 ok 時有）。
 */

// ---- 設定 -------------------------------------------------------------------------

/**
 * 把 Config map 解析成型別正確的 ToolConfig。純函式。
 * @param {!Object<string, string>} map getConfigMap_() 的結果
 * @return {ToolConfig}
 */
function parseToolConfig_(map) {
  map = map || {};
  const rbac = {};
  Object.keys(map).forEach((key) => {
    if (key.indexOf(RBAC_KEY_PREFIX) !== 0) return;
    const toolset = key.slice(RBAC_KEY_PREFIX.length).trim();
    if (!toolset) return;
    const raw = parseJsonObject_(map[key]);
    const perms = {};
    RBAC_PERMISSIONS.forEach((p) => { perms[p] = toBoolean_(raw[p]); });
    rbac[toolset] = perms;
  });
  const policy = String(map[TOOL_CONFIG_KEYS.APPROVAL_POLICY] || '').trim().toLowerCase();
  return {
    rbac,
    approvalPolicy: APPROVAL_POLICIES.indexOf(policy) === -1 ? DEFAULT_APPROVAL_POLICY : policy,
    spillThreshold: clampInt_(map[TOOL_CONFIG_KEYS.SPILL_THRESHOLD], DEFAULT_SPILL_THRESHOLD, 1500, 200000),
    maxToolSteps: clampInt_(map[TOOL_CONFIG_KEYS.MAX_TOOL_STEPS], DEFAULT_MAX_TOOL_STEPS, 1, 200),
    webAllowedDomains: parseAllowedDomains_(map[TOOL_CONFIG_KEYS.WEB_ALLOWED_DOMAINS]),
    persona: String(map[TOOL_CONFIG_KEYS.PERSONA] || '').trim(),
    slidesTemplateId: String(map[TOOL_CONFIG_KEYS.SLIDES_TEMPLATE_ID] || '').trim(),
    skillsFolderId: String(map[TOOL_CONFIG_KEYS.SKILLS_FOLDER_ID] || '').trim(),
    gmailSendWhitelist: parseEmailWhitelist_(map[TOOL_CONFIG_KEYS.GMAIL_SEND_WHITELIST]),
  };
}

// ---- 寄信白名單（M7）---------------------------------------------------------------

/** email 格式（寬鬆）。 */
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;

/**
 * 白名單文字 → 正規化陣列：小寫、去重、丟掉不合法；`@domain.com` / `*@domain.com` 都存成 `*@domain.com`（整個網域）。純函式。
 * @param {*} text 換行 / 逗號 / 分號 / 空白分隔，或陣列
 * @return {!Array<string>}
 */
function parseEmailWhitelist_(text) {
  const out = [];
  const list = Array.isArray(text) ? text : String(text === null || text === undefined ? '' : text).split(/[\s,;]+/);
  list.forEach((raw) => {
    let s = String(raw || '').trim().toLowerCase().replace(/^<|>$/g, '');
    if (!s) return;
    if (/^@[^@\s]+\.[^@\s]+$/.test(s)) s = '*' + s;
    if (!(EMAIL_RE.test(s) || /^\*@[^@\s*]+\.[^@\s*]+$/.test(s))) return;
    if (out.indexOf(s) === -1) out.push(s);
  });
  return out;
}

/**
 * 從收件人字串（「名字 <a@b.c>, d@e.f」）抽出 email（小寫、去重）。純函式。
 * @param {*} text 字串或字串陣列
 * @return {!Array<string>}
 */
function extractEmails_(text) {
  const s = (Array.isArray(text) ? text : [text]).map((x) => (x === null || x === undefined ? '' : String(x))).join(',');
  const out = [];
  (s.match(/[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+/g) || []).forEach((e) => { const l = e.toLowerCase(); if (out.indexOf(l) === -1) out.push(l); });
  return out;
}

/**
 * 單一 email 是否在白名單（精確或 `*@domain`）。純函式。
 * @param {string} email
 * @param {!Array<string>} whitelist parseEmailWhitelist_ 的結果
 * @return {boolean}
 */
function isEmailWhitelisted_(email, whitelist) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !whitelist || !whitelist.length) return false;
  const domain = e.slice(e.lastIndexOf('@'));
  return whitelist.some((w) => w === e || (w.indexOf('*@') === 0 && w.slice(1) === domain));
}

/**
 * 全部收件人都在白名單才算（空清單 = 不算）。純函式。
 * @param {?Array<string>} recipients null = 收件人不明
 * @param {!Array<string>} whitelist
 * @return {boolean}
 */
function recipientsWhitelisted_(recipients, whitelist) {
  if (!Array.isArray(recipients) || !recipients.length) return false;
  return recipients.every((r) => isEmailWhitelisted_(r, whitelist));
}

/** @return {ToolConfig} 目前 Config sheet 的工具設定 */
function getToolConfig_() {
  return parseToolConfig_(getConfigMap_());
}

/**
 * 以預設值補齊缺少的工具設定（每個 registry toolset 的 rbac 列、審批策略、門檻）。幂等；不覆寫既有值。
 * @return {!Array<string>} 這次新寫入的 key
 */
function ensureToolConfigDefaults_() {
  const map = getConfigMap_();
  const missing = {};
  listToolsets_().forEach((toolset) => {
    if (!(RBAC_KEY_PREFIX + toolset in map)) missing[RBAC_KEY_PREFIX + toolset] = DEFAULT_TOOLSET_PERMS;
  });
  if (!(TOOL_CONFIG_KEYS.APPROVAL_POLICY in map)) missing[TOOL_CONFIG_KEYS.APPROVAL_POLICY] = DEFAULT_APPROVAL_POLICY;
  if (!(TOOL_CONFIG_KEYS.SPILL_THRESHOLD in map)) missing[TOOL_CONFIG_KEYS.SPILL_THRESHOLD] = DEFAULT_SPILL_THRESHOLD;
  if (!(TOOL_CONFIG_KEYS.MAX_TOOL_STEPS in map)) missing[TOOL_CONFIG_KEYS.MAX_TOOL_STEPS] = DEFAULT_MAX_TOOL_STEPS;
  if (!(TOOL_CONFIG_KEYS.WEB_ALLOWED_DOMAINS in map)) missing[TOOL_CONFIG_KEYS.WEB_ALLOWED_DOMAINS] = '';
  if (!(TOOL_CONFIG_KEYS.PERSONA in map)) missing[TOOL_CONFIG_KEYS.PERSONA] = '';
  if (!(TOOL_CONFIG_KEYS.SLIDES_TEMPLATE_ID in map)) missing[TOOL_CONFIG_KEYS.SLIDES_TEMPLATE_ID] = '';
  if (!(TOOL_CONFIG_KEYS.SKILLS_FOLDER_ID in map)) missing[TOOL_CONFIG_KEYS.SKILLS_FOLDER_ID] = '';
  if (!(TOOL_CONFIG_KEYS.GMAIL_SEND_WHITELIST in map)) missing[TOOL_CONFIG_KEYS.GMAIL_SEND_WHITELIST] = '';
  Object.keys(AGENT_CONFIG_DEFAULTS).forEach((k) => { if (!(k in map)) missing[k] = AGENT_CONFIG_DEFAULTS[k]; });
  Object.keys(CHANNEL_CONFIG_DEFAULTS).forEach((k) => { if (!(k in map)) missing[k] = CHANNEL_CONFIG_DEFAULTS[k]; });
  const keys = Object.keys(missing);
  if (keys.length) setConfigValues_(missing);
  return keys;
}

/**
 * 管理頁「工具」分頁儲存：驗證後寫回 Config。
 * @param {{rbac: !Object<string, !Object>, approval_policy: string, spill_threshold: *, max_tool_steps: *,
 *   web_allowed_domains: string, persona: string}} input
 * @return {ToolConfig}
 * @throws {Error} 不合法
 */
function saveToolConfig_(input) {
  input = input || {};
  const values = {};
  const toolsets = listToolsets_();
  const rbac = input.rbac || {};
  Object.keys(rbac).forEach((toolset) => {
    if (toolsets.indexOf(toolset) === -1) throw new Error(`未知的 toolset：${toolset}`);
    const perms = {};
    RBAC_PERMISSIONS.forEach((p) => { perms[p] = toBoolean_(rbac[toolset][p]); });
    values[RBAC_KEY_PREFIX + toolset] = perms;
  });
  const policy = String(input.approval_policy || DEFAULT_APPROVAL_POLICY).trim().toLowerCase();
  if (APPROVAL_POLICIES.indexOf(policy) === -1) throw new Error(`approval_policy 必須是 ${APPROVAL_POLICIES.join(' / ')}`);
  values[TOOL_CONFIG_KEYS.APPROVAL_POLICY] = policy;
  const spill = toNumber_(input.spill_threshold, DEFAULT_SPILL_THRESHOLD);
  if (spill < 1500 || spill > 200000) throw new Error('spill_threshold 必須在 1500 到 200000 之間。');
  values[TOOL_CONFIG_KEYS.SPILL_THRESHOLD] = Math.floor(spill);
  const steps = toNumber_(input.max_tool_steps, DEFAULT_MAX_TOOL_STEPS);
  if (steps < 1 || steps > 200) throw new Error('max_tool_steps 必須在 1 到 200 之間。');
  values[TOOL_CONFIG_KEYS.MAX_TOOL_STEPS] = Math.floor(steps);
  values[TOOL_CONFIG_KEYS.WEB_ALLOWED_DOMAINS] = parseAllowedDomains_(input.web_allowed_domains).join('\n');
  values[TOOL_CONFIG_KEYS.PERSONA] = String(input.persona || '').trim();
  values[TOOL_CONFIG_KEYS.SLIDES_TEMPLATE_ID] = parseDriveId_(input.slides_template_id);
  // skills_folder_id 由「技能」分頁管理；工具分頁沒送就不動。
  if (input.skills_folder_id !== undefined) values[TOOL_CONFIG_KEYS.SKILLS_FOLDER_ID] = parseDriveId_(input.skills_folder_id);
  // 寄信白名單：沒送就不動（Telegram /white 也會改它）；有變動記 AuditLog（記 email，不是秘密）。
  if (input.gmail_send_whitelist !== undefined) {
    const next = parseEmailWhitelist_(input.gmail_send_whitelist);
    const prev = getToolConfig_().gmailSendWhitelist;
    values[TOOL_CONFIG_KEYS.GMAIL_SEND_WHITELIST] = next.join('\n');
    if (next.join(',') !== prev.join(',')) securityAudit_('whitelist:set', `寄信白名單由管理頁改為 ${next.length} 筆：${next.join(', ') || '（空）'}`);
  }
  setConfigValues_(values);
  return getToolConfig_();
}

/**
 * 管理頁「設定」分頁儲存 Agent 層設定（記憶上限、context 壓縮、curation、session 閒置）。
 * @param {!Object} input key 同 AGENT_CONFIG_DEFAULTS
 * @return {AgentConfig}
 */
function saveAgentConfig_(input) {
  input = input || {};
  const values = {};
  Object.keys(AGENT_CONFIG_DEFAULTS).forEach((k) => {
    if (input[k] === undefined) return;
    values[k] = typeof AGENT_CONFIG_DEFAULTS[k] === 'boolean' ? toBoolean_(input[k]) : toNumber_(input[k], AGENT_CONFIG_DEFAULTS[k]);
  });
  const parsed = parseAgentConfig_(Object.assign({}, getConfigMap_(), values));
  // 用 parse 後（已夾限）的值寫回，避免 sheet 裡留下超出範圖的數字。
  const normalized = {
    memory_max_chars: parsed.memoryMaxChars, profile_max_chars: parsed.profileMaxChars, context_max_tokens: parsed.contextMaxTokens,
    keep_recent_turns: parsed.keepRecentTurns, curation_every_turns: parsed.curationEveryTurns, curation_auto_apply: parsed.curationAutoApply,
    session_idle_hours: parsed.sessionIdleHours, session_embeddings: parsed.sessionEmbeddings,
    turn_budget_seconds: parsed.turnBudgetSeconds,
  };
  const out = {};
  Object.keys(values).forEach((k) => { out[k] = normalized[k]; });
  if (Object.keys(out).length) setConfigValues_(out);
  return getAgentConfig_();
}

// ---- 驗證 -------------------------------------------------------------------------

/**
 * 依工具的 JSON Schema 驗參數：required 齊全、未宣告的頂層參數拒絕、型別粗檢（數字 / 布林字串會順手轉型）。
 * 純函式；會回傳正規化後的 args（可能是新 object）。
 * @param {ToolDecl} tool
 * @param {*} args
 * @return {!Object}
 * @throws {Error} 說明哪個參數有問題
 */
function validateToolArgs_(tool, args) {
  if (args === null || args === undefined || args === '') args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('參數必須是 JSON object。');
  if ('_raw' in args && Object.keys(args).length === 1) throw new Error(`參數不是合法 JSON：${String(args._raw).slice(0, 120)}`);
  const schema = tool.parameters || { type: 'object', properties: {} };
  const props = schema.properties || {};
  const out = {};

  const unknown = Object.keys(args).filter((k) => !props[k]);
  if (unknown.length) {
    throw new Error(`未宣告的參數：${unknown.join(', ')}。此工具可用參數：${Object.keys(props).join(', ') || '（無）'}。`);
  }
  (schema.required || []).forEach((k) => {
    const v = args[k];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) throw new Error(`缺少必要參數：${k}。`);
  });
  Object.keys(args).forEach((k) => {
    let v = args[k];
    if (v === undefined || v === null) return;
    const p = props[k];
    const types = [].concat(p.type || []);
    v = coerceArg_(v, types);
    if (!types.some((t) => matchesType_(v, t))) {
      throw new Error(`參數 ${k} 型別錯誤：應為 ${types.join(' | ')}，實際為 ${Array.isArray(v) ? 'array' : typeof v}。`);
    }
    if (p.enum && p.enum.indexOf(v) === -1) throw new Error(`參數 ${k} 必須是 ${p.enum.join(' / ')} 之一。`);
    out[k] = v;
  });
  return out;
}

/**
 * 模型常把數字 / 布林送成字串；在宣告型別允許時轉回來。
 * @param {*} v
 * @param {!Array<string>} types
 * @return {*}
 */
function coerceArg_(v, types) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if ((types.indexOf('number') !== -1 || types.indexOf('integer') !== -1) && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (types.indexOf('boolean') !== -1 && /^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if ((types.indexOf('array') !== -1 || types.indexOf('object') !== -1) && /^[\[{]/.test(s)) {
    try { return JSON.parse(s); } catch (err) { return v; }
  }
  return v;
}

/**
 * @param {*} v
 * @param {string} type JSON Schema 型別
 * @return {boolean}
 */
function matchesType_(v, type) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return !!v && typeof v === 'object' && !Array.isArray(v);
    default: return false;
  }
}

/**
 * RBAC：toolset 必須在 Config 宣告，且 risk 對應的開關為 true。純函式。
 * @param {ToolDecl} tool
 * @param {!Object<string, !Object<string, boolean>>} rbac
 * @return {string} 空字串 = 允許；否則為拒絕原因
 */
function checkToolAccess_(tool, rbac) {
  const perms = (rbac || {})[tool.toolset];
  if (!perms) {
    return `toolset「${tool.toolset}」尚未在 Config 宣告 RBAC 開關（${RBAC_KEY_PREFIX}${tool.toolset}），一律拒絕。owner 可在管理頁「工具」分頁儲存設定或按 Doctor「重新安裝」補預設值。`;
  }
  const perm = RISK_PERMISSION[tool.risk];
  if (!perms[perm]) {
    return `toolset「${tool.toolset}」的 ${perm} 權限未開啟（工具 ${tool.name} 風險等級 ${tool.risk}）。owner 可在管理頁「工具」分頁開啟。`;
  }
  return '';
}

/**
 * @param {*} principal
 * @return {string} 合法的 principal：空 / undefined → owner；不認得 → guest
 */
function normalizePrincipal_(principal) {
  if (principal === undefined || principal === null || principal === '') return 'owner';
  return PRINCIPALS.indexOf(String(principal)) === -1 ? 'guest' : String(principal);
}

/**
 * 某 principal 實際可用的 toolset 清單：省略 toolsets 用預設；一律去掉鎖定的、小寫、去重。純函式。
 * @param {string} principal
 * @param {(!Array<string>|string|undefined)=} toolsets
 * @return {!Array<string>}
 */
function principalToolsets_(principal, toolsets) {
  const p = normalizePrincipal_(principal);
  const locked = PRINCIPAL_LOCKED_TOOLSETS[p] || [];
  const base = toolsets === undefined || toolsets === null ? (PRINCIPAL_DEFAULT_TOOLSETS[p] || []) : toolsets;
  return toStringList_(base).map((t) => t.toLowerCase()).filter((t, i, arr) => locked.indexOf(t) === -1 && arr.indexOf(t) === i);
}

/**
 * 主體開關：owner 不限；guest 全拒；group_member 只能用允許清單內（且不在鎖定清單）的 toolset。純函式。
 * 拒絕理由是給模型看的，要求它對群組回一句中性說明、不要重試、不要透露 owner 設定。
 * @param {ToolDecl} tool
 * @param {string} principal
 * @param {(!Array<string>|undefined)=} toolsets group_member 可用的 toolset（省略用預設）
 * @return {string} 空字串 = 允許；否則為拒絕原因
 */
function checkPrincipalAccess_(tool, principal, toolsets) {
  const p = normalizePrincipal_(principal);
  if (p === 'owner') return '';
  if (p === 'guest') return '訪客對話沒有任何工具。請用一般知識回答，需要 owner 的資料請對方直接找 owner。';
  const allowed = principalToolsets_(p, toolsets);
  if (allowed.indexOf(tool.toolset) === -1) {
    return `toolset「${tool.toolset}」在群組對話中不開放（群組成員目前可用：${allowed.join(', ') || '（無）'}）。` +
      '請簡短告知對方「這個功能只有 owner 本人能用」即可，不要重試、不要說明 owner 的設定。';
  }
  return '';
}

/**
 * X 類工具是否要送審批。純函式。
 * @param {ToolDecl} tool
 * @param {string} policy always / autonomous_only / never
 * @param {string} mode 'interactive' | 'autonomous'
 * @return {boolean}
 */
function needsApproval_(tool, policy, mode) {
  if (tool.risk !== 'X') return false;
  if (policy === 'never') return false;
  if (policy === 'autonomous_only') return mode === 'autonomous';
  return true;
}

// ---- 執行 -------------------------------------------------------------------------

/**
 * 給模型看的錯誤 JSON。
 * @param {string} code
 * @param {string} message
 * @return {string}
 */
function toolErrorText_(code, message) {
  return JSON.stringify({ error: code, message: String(message || '') });
}

/**
 * handler 回傳值轉成字串：字串原樣、其他 JSON 化（Date → ISO）。
 * @param {*} result
 * @return {string}
 */
function stringifyToolResult_(result) {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  return JSON.stringify(result, (k, v) => (v instanceof Date ? fmtDate_(v) : v));
}

/**
 * @return {string} 審批 id
 */
function newApprovalId_() {
  let rand;
  try { rand = Utilities.getUuid().slice(0, 8); } catch (err) { rand = Math.random().toString(36).slice(2, 10); }
  return 'apr_' + Date.now().toString(36) + '_' + rand;
}

/**
 * 預設的記錄寫入：AuditLog / Approvals 都進 DB sheet。測試可注入記憶體版本。
 * @return {{audit: function(!Object), approval: function(!Object)}}
 */
function defaultToolSink_() {
  return {
    audit: (entry) => appendTableRow_('AuditLog', entry),
    approval: (row) => appendTableRow_('Approvals', row),
  };
}

/**
 * 安全事件寫 AuditLog（M7-A：secret / token / key 輪替、紅隊）。只記動作與結果，**絕不記值**。不 throw。
 * @param {string} action 例 telegram:rotate_secret → tool 欄為 security:<action>
 * @param {string} detail 說明（會截長）
 * @param {Function=} audit 注入的寫入函式（測試用）；省略寫 DB
 */
function securityAudit_(action, detail, audit) {
  try {
    (audit || ((entry) => appendTableRow_('AuditLog', entry)))({
      ts: new Date(), session_id: '', tool: 'security:' + action, args_preview: truncateText_(detail || '', AUDIT_PREVIEW_CHARS).text,
      result_preview: '', ok: true, ms: 0, principal: 'owner',
    });
  } catch (err) {
    console.warn('寫安全事件失敗：' + (err && err.message || err));
  }
}

/**
 * 溢寫檔的 Drive 儲存：`GAS Agent/spill/<name>`。
 * @return {{write: function(string, string): string, read: function(string): string}}
 */
function driveSpillStore_() {
  return {
    write: (name, text) => spillFolder_().createFile(name, text, MimeType.PLAIN_TEXT).getId(),
    read: (fileId) => DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8'),
  };
}

/** 單次執行內的溢寫資料夾快取。 */
let spillFolderCache_ = null;

/**
 * @return {GoogleAppsScript.Drive.Folder} 溢寫資料夾（不存在就建）
 */
function spillFolder_() {
  if (spillFolderCache_) return spillFolderCache_;
  let folder = DriveApp.getRootFolder();
  SPILL_FOLDER_PATH.forEach((name) => {
    const it = folder.getFoldersByName(name);
    folder = it.hasNext() ? it.next() : folder.createFolder(name);
  });
  spillFolderCache_ = folder;
  return folder;
}

/**
 * 分頁讀溢寫檔。session_spill_read 工具與測試共用。
 * @param {{read: function(string): string}} store
 * @param {string} fileId
 * @param {*} offset
 * @param {*} limit
 * @return {{file_id: string, offset: number, limit: number, total: number, has_more: boolean, next_offset: ?number, text: string}}
 */
function spillRead_(store, fileId, offset, limit) {
  const text = store.read(requireString_(fileId, 'file_id'));
  const total = text.length;
  const off = clampInt_(offset, 0, 0, Math.max(0, total));
  const lim = clampInt_(limit, 6000, 1, 20000);
  const slice = text.slice(off, off + lim);
  const hasMore = off + slice.length < total;
  return { file_id: fileId, offset: off, limit: lim, total, has_more: hasMore, next_offset: hasMore ? off + slice.length : null, text: slice };
}

/**
 * 執行一個工具呼叫，依序：存在 → 參數 → RBAC → 審批策略 → handler → AuditLog → 溢寫。
 * 絕不 throw（除了 sink 本身壞掉只 console.warn）；所有失敗都變成給模型看的 content。
 *
 * @param {string} name 工具名
 * @param {*} args 模型給的參數
 * @param {{sessionId: (string|undefined), mode: (string|undefined), jobId: (string|undefined),
 *   approved: (boolean|undefined), approveWrites: (boolean|undefined), principal: (string|undefined),
 *   principalToolsets: (!Array<string>|undefined)}=} ctx approved=true 表示 owner 已批准（略過審批判斷；RBAC / principal 仍檢）；
 *   approveWrites=true 表示 R 以外的工具一律送審批；principal（M7-A）owner / group_member / guest，group_member 等同 approveWrites
 *   且只能用 principalToolsets（省略用 PRINCIPAL_DEFAULT_TOOLSETS）內的 toolset
 * @param {{registry: (ToolRegistry|undefined), config: (ToolConfig|undefined),
 *   sink: ({audit: Function, approval: Function}|undefined), spill: ({write: Function, read: Function}|undefined)}=} deps
 * @return {ToolOutcome}
 */
function executeTool_(name, args, ctx, deps) {
  ctx = ctx || {};
  deps = deps || {};
  const registry = deps.registry || getToolRegistry_();
  const config = deps.config || getToolConfig_();
  const sink = deps.sink || defaultToolSink_();
  const mode = ctx.mode || 'interactive';
  const principal = normalizePrincipal_(ctx.principal);
  const approveWrites = !!ctx.approveWrites || principal === 'group_member';
  const t0 = Date.now();
  let normalizedArgs = args;

  /**
   * @param {string} status
   * @param {string} content
   * @param {Object=} extra
   * @return {ToolOutcome}
   */
  const finish = (status, content, extra) => {
    const outcome = Object.assign({
      name, status, ok: status === 'ok', content, result: null, ms: Date.now() - t0, approvalId: '', spill: null, error: '', whitelisted: false,
    }, extra || {});
    try {
      sink.audit({
        ts: new Date(),
        session_id: ctx.sessionId || '',
        tool: name,
        args_preview: truncateText_(stringifyToolResult_(normalizedArgs), AUDIT_PREVIEW_CHARS).text,
        result_preview: truncateText_((status === 'ok' ? (outcome.whitelisted ? '[白名單免審] ' : '') : `[${status}] `) + content, AUDIT_PREVIEW_CHARS).text,
        ok: status === 'ok',
        ms: outcome.ms,
        principal,
      });
    } catch (err) {
      console.warn('寫 AuditLog 失敗：' + (err && err.message || err));
    }
    return outcome;
  };

  const tool = registry.byName[name];
  if (!tool) return finish('invalid', toolErrorText_('unknown_tool', `沒有名為「${name}」的工具。`));

  try {
    normalizedArgs = validateToolArgs_(tool, args);
  } catch (err) {
    return finish('invalid', toolErrorText_('invalid_args', err.message));
  }

  // 主體開關先於 RBAC：群組成員被擋時只看到中性訊息，不會看到 owner 的 RBAC 設定說明。
  const principalDenied = checkPrincipalAccess_(tool, principal, ctx.principalToolsets);
  if (principalDenied) return finish('denied', toolErrorText_('principal_denied', principalDenied), { error: 'principal_denied' });

  const denied = checkToolAccess_(tool, config.rbac);
  if (denied) return finish('denied', toolErrorText_('rbac_denied', denied), { error: 'rbac_denied' });

  // deps 裡除了 executor 自己用的四個，其餘（memoryStore / sessionStore / agentConfig / skillStore / embed…）都透給 handler，測試可注入假 store。
  const extras = {};
  Object.keys(deps).forEach((k) => { if (['registry', 'config', 'sink', 'spill'].indexOf(k) === -1) extras[k] = deps[k]; });
  const handlerCtx = Object.assign({}, ctx, extras, { mode, config, spill: deps.spill || null, registry });

  // M7 寄信白名單：owner 觸發、工具有 recipients hook、收件人全在名單內 → X 類免審批（群組成員 / 收件人不明不適用）。
  let whitelisted = false;
  if (!ctx.approved && principal === 'owner' && tool.risk === 'X' && typeof tool.recipients === 'function') {
    let rcpts = null;
    try { rcpts = tool.recipients(normalizedArgs); } catch (err) { rcpts = null; }
    whitelisted = recipientsWhitelisted_(rcpts, config.gmailSendWhitelist || []);
  }

  // 提案型工具（M5 skill_manage）：未批准時不執行，先讓工具自己驗證並給 reason，再走與 X 類相同的審批路徑。
  let reason = '';
  if (!ctx.approved && typeof tool.proposal === 'function') {
    try {
      reason = String(tool.proposal(normalizedArgs, handlerCtx).reason || `提案：${name}`);
    } catch (err) {
      return finish('invalid', toolErrorText_('invalid_proposal', String(err && err.message || err)));
    }
  } else if (!ctx.approved && !whitelisted && needsApproval_(tool, config.approvalPolicy, mode)) {
    reason = `風險 ${tool.risk}（${RISK_LABEL[tool.risk]}）；審批策略 ${config.approvalPolicy}；模式 ${mode}`;
  } else if (!ctx.approved && approveWrites && tool.risk !== 'R') {
    reason = `風險 ${tool.risk}（${RISK_LABEL[tool.risk]}）；由群組成員（非 owner）觸發，寫入類動作一律送審`;
  }
  if (reason) {
    const approvalId = newApprovalId_();
    const isProposal = typeof tool.proposal === 'function';
    try {
      sink.approval({
        id: approvalId,
        job_id: ctx.jobId || ctx.sessionId || '',
        tool: name,
        args: JSON.stringify(normalizedArgs),
        reason,
        state: 'pending',
        decided_at: '',
        result: '',
      });
    } catch (err) {
      return finish('error', toolErrorText_('approval_write_failed', `無法寫入 Approvals：${err && err.message || err}`), { error: String(err && err.message || err) });
    }
    return finish('pending_approval', JSON.stringify({
      status: 'pending_approval',
      approval_id: approvalId,
      message: isProposal
        ? `提案已送出（${tool.name}），owner 會在管理頁「紀錄 → 審批」決定，批准後才會寫入。請不要重送同一提案，向使用者說明「已提出提案待審批」並結束即可。`
        : `此動作待批准（${tool.name}）。owner 會在管理頁「紀錄 → 審批」決定；批准後系統會直接執行一次。請不要重試同一動作，向使用者說明「已送出審批」並結束即可。`,
    }), { approvalId });
  }

  let result;
  try {
    result = tool.handler(normalizedArgs, handlerCtx);
  } catch (err) {
    const message = String(err && err.message || err);
    return finish('error', toolErrorText_('tool_error', message), { error: message });
  }

  let content = stringifyToolResult_(result);
  let spillInfo = null;
  if (!tool.noSpill && content.length > config.spillThreshold) {
    try {
      const store = deps.spill || driveSpillStore_();
      const fileName = `${name}_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      const fileId = store.write(fileName, content);
      spillInfo = { fileId, total: content.length };
      content = content.slice(0, SPILL_PREVIEW_CHARS) +
        `\n\n[結果共 ${spillInfo.total} 字元，以上只是前 ${SPILL_PREVIEW_CHARS} 字。完整內容已存成檔案 file_id=${fileId}，` +
        `需要時用 session_spill_read(file_id, offset, limit) 分頁讀取。]`;
    } catch (err) {
      // 溢寫失敗就硬截，至少不要撐爆 context。
      content = content.slice(0, config.spillThreshold) + `\n\n[結果過長已截斷；溢寫到 Drive 失敗：${err && err.message || err}]`;
    }
  }
  return finish('ok', content, { result, spill: spillInfo, whitelisted });
}

// ---- 審批 -------------------------------------------------------------------------

/**
 * 讀 Approvals。
 * @param {string=} state 篩 state；省略為全部
 * @return {!Array<!Object>} 新的在前
 */
function listApprovals_(state) {
  return readTable_('Approvals').rows
    .filter((r) => r.id && (!state || String(r.state) === state))
    .map((r) => ({
      _row: r._row,
      id: String(r.id),
      job_id: String(r.job_id || ''),
      tool: String(r.tool || ''),
      args: String(r.args || ''),
      reason: String(r.reason || ''),
      state: String(r.state || ''),
      decided_at: r.decided_at instanceof Date ? fmtDate_(r.decided_at) : String(r.decided_at || ''),
      result: String(r.result || ''),
      created_at: approvalCreatedAt_(String(r.id)),
    }))
    .reverse();
}

/**
 * 從 id 的 base36 時戳還原建立時間。
 * @param {string} id
 * @return {string}
 */
function approvalCreatedAt_(id) {
  const m = /^apr_([0-9a-z]+)_/.exec(id);
  if (!m) return '';
  const ms = parseInt(m[1], 36);
  return isFinite(ms) ? fmtDate_(new Date(ms)) : '';
}

/**
 * Sheet 版 Approvals store（decideApproval_ 用；測試可注入記憶體版）。
 * @return {{list: function(): !Array<!Object>, update: function(!Object, !Object)}}
 */
function sheetApprovalStore_() {
  return {
    list: () => listApprovals_(),
    update: (row, fields) => {
      writeTableRow_('Approvals', row._row, Object.assign({ id: row.id, job_id: row.job_id, tool: row.tool, args: row.args, reason: row.reason }, fields));
    },
  };
}

/**
 * owner 決定一筆審批。批准 = 立刻以 approved=true 執行該工具一次（RBAC 仍檢）並把結果寫回；拒絕 = 標記 denied。
 * M4：若 Approvals.job_id 對應一個仍 active 的 session（M2 起 job_id 存 sessionId），再 enqueue 一個 continuation job，
 * 以 user 訊息「（系統）先前待審批的 X 已由 owner 批准並執行，結果：…」（拒絕也通知）接回該 session 續跑。
 * curation 提議（reason 以 curation 開頭）與技能提案（M5，reason 以「技能提案」開頭）不是對話中的動作，不續跑。
 * @param {string} id
 * @param {boolean} approve
 * @param {{approvalStore: (Object|undefined), sessionStore: (Object|undefined), queueStore: (Object|undefined),
 *   enqueue: (Function|undefined)}=} deps 其餘欄位（registry / config / sink / spill…）透給 executeTool_
 * @return {{id: string, state: string, outcome: ?ToolOutcome, continuation: string}} continuation = 續跑 job id（沒有為空）
 * @throws {Error} 找不到或已處理
 */
function decideApproval_(id, approve, deps) {
  deps = deps || {};
  const approvalStore = deps.approvalStore || sheetApprovalStore_();
  const row = approvalStore.list().find((r) => r.id === id);
  if (!row) throw new Error(`找不到審批「${id}」。`);
  if (row.state !== 'pending') throw new Error(`審批「${id}」已處理（${row.state}）。`);
  const now = new Date();
  const execDeps = {};
  Object.keys(deps).forEach((k) => { if (['approvalStore', 'sessionStore', 'queueStore', 'enqueue'].indexOf(k) === -1) execDeps[k] = deps[k]; });
  if (!approve) {
    approvalStore.update(row, { state: 'denied', decided_at: now, result: '' });
    const c = enqueueApprovalContinuation_(row, false, null, deps);
    return { id, state: 'denied', outcome: null, continuation: c ? c.id : '' };
  }
  const outcome = executeTool_(row.tool, parseJsonArgs_(row.args), { sessionId: row.job_id, mode: 'interactive', approved: true }, execDeps);
  const resultText = truncateText_((outcome.ok ? 'OK: ' : `[${outcome.status}] `) + outcome.content, 2000).text;
  approvalStore.update(row, { state: 'approved', decided_at: now, result: resultText });
  const c = enqueueApprovalContinuation_(row, true, outcome, deps);
  return { id, state: 'approved', outcome: Object.assign({}, outcome, { result: null }), continuation: c ? c.id : '' };
}

/**
 * 審批決定後把結果接回原 session：enqueue 一個 continuation job。沒有可續跑的 session 時回 null。
 * @param {!Object} row Approvals 列
 * @param {boolean} approved
 * @param {?ToolOutcome} outcome
 * @param {{sessionStore: (Object|undefined), queueStore: (Object|undefined), enqueue: (Function|undefined)}} deps
 * @return {?Object} job
 */
function enqueueApprovalContinuation_(row, approved, outcome, deps) {
  if (/^curation/i.test(String(row.reason || '')) || String(row.reason || '').indexOf(SKILL_PROPOSAL_REASON_PREFIX) === 0) return null;
  const sessionId = String(row.job_id || '');
  if (!sessionId) return null;
  let session = null;
  try {
    session = (deps.sessionStore || sheetSessionStore_()).get(sessionId);
  } catch (err) {
    return null;
  }
  if (!session || session.status !== 'active') return null;
  const argsPreview = truncateText_(String(row.args || ''), 300).text;
  const text = approved
    ? `（系統）先前待審批的 ${row.tool} 已由 owner 批准並執行，結果：${truncateText_(outcome ? outcome.content : '', 1500).text}`
    : `（系統）先前待審批的 ${row.tool}（參數 ${argsPreview}）已由 owner 拒絕，未執行。`;
  const payload = {
    message: text + '\n請據此接續完成原本的任務並回覆（不要再重送同一個動作）。',
    origin: 'approval', approval_id: row.id, continuations: 0,
    channel: session.channel || 'admin', mode: session.channel === 'cron' ? 'autonomous' : 'interactive',
    // M6：通道 session 的續跑結果要送回原通道
    external_id: session.external_id || '',
    telegram_chat_id: session.channel === 'telegram' ? session.external_id : '',
    email_thread_id: session.channel === 'email' ? session.external_id : '',
  };
  try {
    return (deps.enqueue || enqueue_)('continuation', payload, sessionId, { store: deps.queueStore });
  } catch (err) {
    console.warn('審批後續跑 enqueue 失敗：' + (err && err.message || err));
    return null;
  }
}
