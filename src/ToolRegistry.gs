/**
 * @fileoverview 工具註冊表：每個工具宣告 {name, toolset, description, parameters, risk, handler}。
 *
 * - name：`<toolset>_<action>`，全專案唯一；registry 載入時檢查無重名與 schema 合法。
 * - risk：'R' 讀 / 'W' 寫 / 'D' 刪 / 'X' 外發（寄信、分享）。RBAC（ToolExecutor.gs）依 risk 對應到
 *   toolset 的 read / write / delete / external 四個開關；X 另受審批策略管。
 * - parameters：JSON Schema（type=object）。ToolExecutor 以它驗參數：required 要齊、未宣告的頂層
 *   參數拒絕、型別粗檢。宣告時請把 additionalProperties 設 false（Gemini adapter 會自動移除）。
 * - handler(args, ctx)：回傳可 JSON 化的結果（字串或 object）。ctx 含 sessionId / mode / config / spill。
 *   handler 直接 throw Error 即為失敗，訊息會回給模型。
 * - 每個 Tools_*.gs 提供一個 `<toolset>Tools_()` 回傳宣告陣列，這裡集中組裝。
 */

/** 風險等級與對應的 RBAC 開關。 */
const RISK_PERMISSION = Object.freeze({ R: 'read', W: 'write', D: 'delete', X: 'external' });

/** 風險等級的中文說明（UI / README 用）。 */
const RISK_LABEL = Object.freeze({ R: '讀', W: '寫', D: '刪', X: '外發' });

/** JSON Schema 型別名稱白名單（型別粗檢只認這些）。 */
const SCHEMA_TYPES = Object.freeze(['string', 'number', 'integer', 'boolean', 'array', 'object']);

/** 工具名規則：小寫字母 / 數字 / 底線，以 toolset 開頭。 */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * @typedef {{
 *   name: string, toolset: string, description: string, parameters: !Object, risk: string,
 *   handler: function(!Object, !Object): *, noSpill: (boolean|undefined),
 *   proposal: (function(!Object, !Object): {reason: string}|undefined)
 * }} ToolDecl
 * proposal（M5）：有此 hook 的工具在未批准時不執行 handler，executor 改呼叫它驗證並取得 reason，寫 Approvals 後回 pending_approval；
 * owner 批准後才以 approved=true 執行 handler（skill_manage 用）。
 */

/**
 * @typedef {{list: !Array<ToolDecl>, byName: !Object<string, ToolDecl>, toolsets: !Array<string>}} ToolRegistry
 */

/** 單次執行內的 registry 快取。 */
let toolRegistryCache_ = null;

/**
 * 組裝全部工具宣告。每個 toolset 的宣告函式在對應的 Tools_*.gs。
 * @return {!Array<ToolDecl>}
 */
function allToolDeclarations_() {
  return [].concat(
    driveTools_(),
    docsTools_(),
    sheetsTools_(),
    slidesTools_(),
    gmailTools_(),
    calendarTools_(),
    webTools_(),
    sessionTools_(),
    memoryTools_(),
    cronTools_(),
    skillsTools_(),
  );
}

/**
 * 建 registry：檢查每個宣告合法、無重名。純函式（傳入宣告陣列），測試可用假宣告。
 * @param {!Array<ToolDecl>} decls
 * @return {ToolRegistry}
 * @throws {Error} 重名或宣告不合法
 */
function buildToolRegistry_(decls) {
  const byName = {};
  const toolsets = [];
  decls.forEach((tool) => {
    validateToolDeclaration_(tool);
    if (byName[tool.name]) throw new Error(`工具重名：${tool.name}（toolset ${byName[tool.name].toolset} 與 ${tool.toolset}）`);
    byName[tool.name] = tool;
    if (toolsets.indexOf(tool.toolset) === -1) toolsets.push(tool.toolset);
  });
  return { list: decls.slice(), byName, toolsets };
}

/**
 * 取得（並快取）全專案 registry。
 * @return {ToolRegistry}
 */
function getToolRegistry_() {
  if (!toolRegistryCache_) toolRegistryCache_ = buildToolRegistry_(allToolDeclarations_());
  return toolRegistryCache_;
}

/**
 * @param {string} name
 * @param {ToolRegistry=} registry
 * @return {?ToolDecl}
 */
function getTool_(name, registry) {
  return (registry || getToolRegistry_()).byName[name] || null;
}

/**
 * @param {ToolRegistry=} registry
 * @return {!Array<string>} toolset 名稱（依宣告順序）
 */
function listToolsets_(registry) {
  return (registry || getToolRegistry_()).toolsets.slice();
}

/**
 * 檢查單一工具宣告：欄位齊全、name 合法且以 toolset 開頭、risk 合法、parameters 是 object schema、
 * required 都在 properties 裡、每個 property 有合法 type、handler 是函式。
 * @param {*} tool
 * @throws {Error}
 */
function validateToolDeclaration_(tool) {
  if (!tool || typeof tool !== 'object') throw new Error('工具宣告必須是 object');
  const where = `工具「${tool.name || '(無名)'}」`;
  if (!TOOL_NAME_RE.test(String(tool.name || ''))) throw new Error(`${where} name 不合法（小寫字母 / 數字 / 底線）`);
  if (!tool.toolset || !/^[a-z][a-z0-9]*$/.test(tool.toolset)) throw new Error(`${where} toolset 不合法`);
  if (tool.name.indexOf(tool.toolset + '_') !== 0) throw new Error(`${where} name 必須以「${tool.toolset}_」開頭`);
  if (!tool.description || typeof tool.description !== 'string') throw new Error(`${where} 缺 description`);
  if (!RISK_PERMISSION[tool.risk]) throw new Error(`${where} risk 必須是 R / W / D / X`);
  if (typeof tool.handler !== 'function') throw new Error(`${where} handler 必須是函式`);
  if (tool.proposal !== undefined && typeof tool.proposal !== 'function') throw new Error(`${where} proposal 必須是函式`);
  const schema = tool.parameters;
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') throw new Error(`${where} parameters 必須是 type=object 的 JSON Schema`);
  const props = schema.properties || {};
  if (typeof props !== 'object' || Array.isArray(props)) throw new Error(`${where} parameters.properties 必須是 object`);
  Object.keys(props).forEach((key) => {
    const p = props[key];
    if (!p || typeof p !== 'object') throw new Error(`${where} 參數 ${key} 的 schema 必須是 object`);
    const types = [].concat(p.type || []);
    if (!types.length || types.some((t) => SCHEMA_TYPES.indexOf(t) === -1)) throw new Error(`${where} 參數 ${key} 的 type 不合法：${JSON.stringify(p.type)}`);
    if (p.enum && (!Array.isArray(p.enum) || !p.enum.length)) throw new Error(`${where} 參數 ${key} 的 enum 必須是非空陣列`);
  });
  (schema.required || []).forEach((key) => {
    if (!props[key]) throw new Error(`${where} required 的 ${key} 不在 properties 裡`);
  });
}

/**
 * 轉成 M1 adapter 接受的中立工具格式 [{name, description, parameters}]。
 * 傳入 rbac 時只列出目前有權限的工具（模型看不到被關掉的工具就不會白呼叫；ToolExecutor 仍會再查一次）。
 * @param {ToolRegistry=} registry
 * @param {!Object<string, !Object<string, boolean>>=} rbac toolset → {read, write, delete, external}
 * @param {(function(ToolDecl): boolean)=} allow 額外過濾（M7-A：principal 開關），回 false 的不列
 * @return {!Array<{name: string, description: string, parameters: !Object}>}
 */
function listToolsForProvider_(registry, rbac, allow) {
  const reg = registry || getToolRegistry_();
  return reg.list
    .filter((tool) => !rbac || isToolAllowed_(tool, rbac))
    .filter((tool) => !allow || allow(tool))
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

/**
 * @param {ToolDecl} tool
 * @param {!Object<string, !Object<string, boolean>>} rbac
 * @return {boolean}
 */
function isToolAllowed_(tool, rbac) {
  const perms = rbac[tool.toolset];
  return !!(perms && perms[RISK_PERMISSION[tool.risk]]);
}

// ---- 工具 handler 共用 helpers ---------------------------------------------------

/**
 * 整數參數夾在 [min, max]；非數字用 fallback。
 * @param {*} v
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @return {number}
 */
function clampInt_(v, fallback, min, max) {
  const n = Math.floor(toNumber_(v, fallback));
  return Math.max(min, Math.min(max, isFinite(n) ? n : fallback));
}

/**
 * 截長字串。
 * @param {*} text
 * @param {number} max
 * @return {{text: string, truncated: boolean, total: number}}
 */
function truncateText_(text, max) {
  const s = text === null || text === undefined ? '' : String(text);
  if (s.length <= max) return { text: s, truncated: false, total: s.length };
  return { text: s.slice(0, max), truncated: true, total: s.length };
}

/**
 * 給人 / 模型看的時間字串（Script 時區）。測試環境沒有 Utilities 時退回 ISO。
 * @param {*} d
 * @return {string}
 */
function fmtDate_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return d ? String(d) : '';
  try {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX");
  } catch (err) {
    return d.toISOString();
  }
}

/**
 * 解析模型給的日期時間字串；接受 ISO 8601 或 Date 能解析的格式。
 * @param {*} v
 * @param {string} field 參數名（錯誤訊息用）
 * @return {!Date}
 * @throws {Error}
 */
function parseDateArg_(v, field) {
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(d.getTime())) throw new Error(`參數 ${field} 不是合法的日期時間：${v}（請用 ISO 8601，例如 2026-11-03T09:00:00+08:00）`);
  return d;
}

/**
 * 非空字串參數。
 * @param {*} v
 * @param {string} field
 * @return {string}
 * @throws {Error}
 */
function requireString_(v, field) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  if (!s) throw new Error(`參數 ${field} 不可為空。`);
  return s;
}

/**
 * 把字串或字串陣列正規化成字串陣列（去空白、去空項）。
 * @param {*} v
 * @return {!Array<string>}
 */
function toStringList_(v) {
  if (v === null || v === undefined || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[\n,;]+/);
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

/**
 * 從 Drive / Docs / Slides 網址或純 id 取出檔案 id；空值回空字串。
 * @param {*} v
 * @return {string}
 */
function parseDriveId_(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return '';
  const m = /\/d\/([a-zA-Z0-9_-]{10,})/.exec(s) || /[?&]id=([a-zA-Z0-9_-]{10,})/.exec(s);
  return m ? m[1] : s;
}

/**
 * regex 特殊字元跳脫。
 * @param {string} s
 * @return {string}
 */
function escapeRegex_(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
