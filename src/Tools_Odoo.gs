/**
 * @fileoverview odoo toolset：透過 Odoo JSON-RPC（/jsonrpc，execute_kw）讀寫 ERP 資料。
 *
 * 設定（Config）：odoo_url、odoo_db、odoo_login、odoo_allowed_models（一行一個 model，白名單；空 = 全部拒絕）。
 * 憑證只在 Script Property ODOO_API_KEY（Odoo 14+ 的 API key 或密碼；建議用 API key，可單獨撤銷）。
 * uid 由 authenticate 取得後放 CacheService（6 小時），401 / 失效時重取。
 *
 * 安全邊界：
 * - model 必須在 owner 設的白名單內；odoo_call 不能呼叫 `_` 開頭的私有方法，也不能用它繞過 unlink / write / create。
 * - unlink 是獨立的 D 類工具（RBAC delete 預設關）。
 * - 回傳的欄位值是外部資料（客戶名稱、備註…），executor 會包成資料區塊。
 */

const ODOO_SEARCH_DEFAULT_LIMIT = 20;
const ODOO_SEARCH_MAX_LIMIT = 200;
const ODOO_FIELDS_MAX = 150;
const ODOO_UID_CACHE_SECONDS = 6 * 60 * 60;
/** domain 允許的運算子。 */
const ODOO_DOMAIN_OPERATORS = Object.freeze(['=', '!=', '>', '>=', '<', '<=', '=?', '=like', 'like', 'not like', 'ilike', 'not ilike', '=ilike', 'in', 'not in', 'child_of', 'parent_of', 'any', 'not any']);
/** odoo_call 不可呼叫的方法（各有專用工具或根本不該開）。 */
const ODOO_BLOCKED_METHODS = Object.freeze(['unlink', 'write', 'create', 'search', 'search_read', 'read', 'fields_get', 'sudo', 'with_user', 'with_context', 'with_env', 'env', 'browse', 'exists']);
/** 第一次安裝時的 model 白名單預設值（owner 可在管理頁改）。 */
const ODOO_DEFAULT_MODELS = Object.freeze([
  'res.partner', 'res.users', 'res.company', 'res.currency', 'res.country',
  'sale.order', 'sale.order.line', 'purchase.order', 'purchase.order.line',
  'account.move', 'account.move.line', 'account.payment', 'account.journal', 'account.account', 'account.analytic.account',
  'product.product', 'product.template', 'product.category', 'uom.uom',
  'crm.lead', 'crm.stage', 'crm.team',
  'project.project', 'project.task', 'project.task.type',
  'hr.employee', 'hr.department', 'hr.leave', 'hr.expense',
  'stock.picking', 'stock.move', 'stock.quant', 'stock.warehouse',
  'calendar.event', 'mail.activity', 'ir.attachment', 'ir.model', 'ir.model.fields',
]);

/** @return {!Array<ToolDecl>} */
function odooTools_() {
  const model = { type: 'string', description: 'Odoo model 名稱，例 res.partner / sale.order / account.move（須在 owner 的白名單內，見 odoo_models）' };
  const ids = { type: 'array', items: { type: 'integer' }, description: '記錄 id 陣列' };
  const fields = { type: 'array', items: { type: 'string' }, description: '要回的欄位名；省略 = 常用欄位（id / name / display_name 等）；不確定欄位名先用 odoo_fields 查' };
  // 自由結構的參數宣告成 string | object / array：三家 adapter 都吃得下（Gemini 會取 string），handler 收到字串就 JSON.parse。
  const values = { type: ['string', 'object'], description: '欄位 → 值的 object（或其 JSON 字串）。many2one 給 id（整數）；one2many / many2many 給 [[6, 0, [ids]]] 或 [[4, id]] 這類 Odoo 指令；日期用 YYYY-MM-DD、時間用 YYYY-MM-DD HH:MM:SS（UTC）' };
  return [
    {
      name: 'odoo_models', toolset: 'odoo', risk: 'R',
      description: '列出 agent 可操作的 Odoo model（owner 白名單）與各 model 的顯示名稱、目前連線的使用者與公司。開始任何 Odoo 任務前先呼叫。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: odooModels_,
    },
    {
      name: 'odoo_fields', toolset: 'odoo', risk: 'R',
      description: '查某個 model 的欄位：名稱 / 標籤 / 型別 / 是否必填 / 關聯 model / selection 選項。可用 search 過濾名稱或標籤（例 "partner"）。要建立或搜尋前先查這個。',
      parameters: {
        type: 'object',
        properties: {
          model,
          search: { type: 'string', description: '只回名稱或標籤含此文字的欄位（選填，不分大小寫）' },
          required_only: { type: 'boolean', description: '只回必填欄位（選填）' },
        },
        required: ['model'], additionalProperties: false,
      },
      handler: odooFields_,
    },
    {
      name: 'odoo_search_read', toolset: 'odoo', risk: 'R',
      description: '搜尋並讀取記錄。domain 是 Odoo 條件陣列，例 [["customer_rank", ">", 0], ["name", "ilike", "王"]]（預設 AND；可用 "|" / "&" / "!" 前置）。回傳記錄陣列，many2one 欄位為 {id, name}。',
      parameters: {
        type: 'object',
        properties: {
          model,
          domain: { type: ['string', 'array'], description: 'Odoo domain 陣列（或其 JSON 字串）；省略或 [] = 全部' },
          fields,
          limit: { type: 'integer', description: `預設 ${ODOO_SEARCH_DEFAULT_LIMIT}，上限 ${ODOO_SEARCH_MAX_LIMIT}` },
          offset: { type: 'integer', description: '跳過前幾筆（分頁用）' },
          order: { type: 'string', description: '排序，例 "date_order desc, id"' },
          count_only: { type: 'boolean', description: 'true = 只回符合筆數，不回記錄' },
        },
        required: ['model'], additionalProperties: false,
      },
      handler: odooSearchRead_,
    },
    {
      name: 'odoo_read', toolset: 'odoo', risk: 'R',
      description: '依 id 讀取記錄（已知 id 時比 search_read 直接）。',
      parameters: {
        type: 'object',
        properties: { model, ids, fields },
        required: ['model', 'ids'], additionalProperties: false,
      },
      handler: odooRead_,
    },
    {
      name: 'odoo_create', toolset: 'odoo', risk: 'W',
      description: '建立一筆記錄，回傳新 id 與 display_name。建立前先用 odoo_fields 確認必填欄位；關聯欄位要先查到對方 id。',
      parameters: {
        type: 'object',
        properties: { model, values },
        required: ['model', 'values'], additionalProperties: false,
      },
      handler: odooCreate_,
    },
    {
      name: 'odoo_write', toolset: 'odoo', risk: 'W',
      description: '更新一或多筆記錄的欄位。',
      parameters: {
        type: 'object',
        properties: { model, ids, values },
        required: ['model', 'ids', 'values'], additionalProperties: false,
      },
      handler: odooWrite_,
    },
    {
      name: 'odoo_call', toolset: 'odoo', risk: 'W',
      description: '在記錄上呼叫 Odoo 的業務方法（工作流按鈕），例 sale.order 的 action_confirm、account.move 的 action_post、purchase.order 的 button_confirm、crm.lead 的 action_set_won。不可呼叫 _ 開頭的私有方法或 unlink / write / create。',
      parameters: {
        type: 'object',
        properties: {
          model,
          method: { type: 'string', description: '方法名' },
          ids,
          args: { type: ['string', 'array'], description: '位置參數陣列（或其 JSON 字串；選填，接在 ids 之後）' },
          kwargs: { type: ['string', 'object'], description: '關鍵字參數 object（或其 JSON 字串；選填）' },
        },
        required: ['model', 'method', 'ids'], additionalProperties: false,
      },
      handler: odooCall_,
    },
    {
      name: 'odoo_unlink', toolset: 'odoo', risk: 'D',
      description: '刪除記錄（刪除動作：owner 需開啟 odoo 的 delete 權限）。Odoo 多數單據不允許刪已確認的，請改用 odoo_call 取消（action_cancel）。',
      parameters: {
        type: 'object',
        properties: { model, ids },
        required: ['model', 'ids'], additionalProperties: false,
      },
      handler: odooUnlink_,
    },
  ];
}

// ---- 純函式 ------------------------------------------------------------------------------

/**
 * 白名單文字 → model 名稱陣列（小寫、去重、只留 a.b 形式）。
 * @param {*} text 換行 / 逗號 / 空白分隔，或陣列
 * @return {!Array<string>}
 */
function parseOdooModels_(text) {
  const list = Array.isArray(text) ? text : String(text === null || text === undefined ? '' : text).split(/[\s,;]+/);
  const out = [];
  list.forEach((raw) => {
    const m = String(raw || '').trim().toLowerCase();
    if (!m || !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(m)) return;
    if (out.indexOf(m) === -1) out.push(m);
  });
  return out;
}

/**
 * @param {*} model
 * @param {!Array<string>} allowed
 * @return {string} 正規化後的 model 名
 * @throws {Error} 不在白名單
 */
function odooAssertModel_(model, allowed) {
  const m = requireString_(model, 'model').toLowerCase();
  if (!allowed || !allowed.length) throw new Error('Odoo model 白名單是空的，一律拒絕。owner 可在管理頁「工具」分頁的 Odoo 區塊設定。');
  if (allowed.indexOf(m) === -1) throw new Error(`model「${m}」不在白名單內（目前允許：${allowed.join(', ')}）。owner 可在管理頁「工具」分頁加入。`);
  return m;
}

/**
 * @param {*} method
 * @return {string}
 * @throws {Error} 私有方法或被封鎖的方法
 */
function odooAssertMethod_(method) {
  const m = requireString_(method, 'method');
  if (!/^[a-z][a-z0-9_]*$/i.test(m)) throw new Error(`method 名稱不合法：${m}`);
  if (m[0] === '_') throw new Error(`不可呼叫私有方法 ${m}。`);
  if (ODOO_BLOCKED_METHODS.indexOf(m) !== -1) throw new Error(`${m} 不能透過 odoo_call 呼叫，請用對應的 odoo_* 工具。`);
  return m;
}

/**
 * 驗證 Odoo domain：陣列，元素是 '&' / '|' / '!' 或 [field, operator, value]。
 * @param {*} domain
 * @return {!Array} 原 domain（已驗證）
 * @throws {Error}
 */
function odooValidateDomain_(domain) {
  if (domain === undefined || domain === null) return [];
  if (!Array.isArray(domain)) throw new Error('domain 必須是陣列，例 [["name", "ilike", "王"]]。');
  domain.forEach((term, i) => {
    if (term === '&' || term === '|' || term === '!') return;
    if (!Array.isArray(term) || term.length !== 3) throw new Error(`domain[${i}] 必須是 [欄位, 運算子, 值] 三元組或 "&" / "|" / "!"。`);
    if (typeof term[0] !== 'string' || !/^[a-z][a-z0-9_.]*$/i.test(term[0])) throw new Error(`domain[${i}] 欄位名不合法：${JSON.stringify(term[0])}`);
    if (ODOO_DOMAIN_OPERATORS.indexOf(String(term[1])) === -1) throw new Error(`domain[${i}] 運算子「${term[1]}」不支援（可用：${ODOO_DOMAIN_OPERATORS.join(' ')}）。`);
  });
  return domain;
}

/**
 * 自由結構參數：接受 object / array 本身或 JSON 字串。
 * @param {*} v
 * @param {string} field
 * @param {string} expect 'array' | 'object'
 * @param {boolean=} optional 省略時回 null
 * @return {?(Array|Object)}
 * @throws {Error}
 */
function odooJsonArg_(v, field, expect, optional) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw new Error(`${field} 不可為空。`);
  }
  let parsed = v;
  if (typeof v === 'string') {
    try { parsed = JSON.parse(v); } catch (err) { throw new Error(`${field} 不是合法 JSON：${v.slice(0, 100)}`); }
  }
  if (expect === 'array' && !Array.isArray(parsed)) throw new Error(`${field} 必須是陣列。`);
  if (expect === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error(`${field} 必須是 object。`);
  return parsed;
}

/**
 * @param {*} ids
 * @return {!Array<number>}
 * @throws {Error}
 */
function odooNormalizeIds_(ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('ids 必須是非空的整數陣列。');
  return ids.map((v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`id 不合法：${JSON.stringify(v)}`);
    return n;
  });
}

/**
 * JSON-RPC 請求 body。
 * @param {string} service 'common' | 'object'
 * @param {string} method
 * @param {!Array} args
 * @return {!Object}
 */
function odooRpcPayload_(service, method, args) {
  return { jsonrpc: '2.0', method: 'call', id: Date.now() % 1000000, params: { service, method, args } };
}

/**
 * execute_kw 的 payload。
 * @param {{db: string}} cfg
 * @param {number} uid
 * @param {string} key
 * @param {string} model
 * @param {string} method
 * @param {!Array} args
 * @param {!Object=} kwargs
 * @return {!Object}
 */
function odooExecutePayload_(cfg, uid, key, model, method, args, kwargs) {
  return odooRpcPayload_('object', 'execute_kw', [cfg.db, uid, key, model, method, args || [], kwargs || {}]);
}

/**
 * 解析 JSON-RPC 回應：有 error 就丟可讀錯誤（AccessError / ValidationError 的 message）。
 * @param {*} json
 * @return {*} result
 * @throws {Error}
 */
function odooParseResponse_(json) {
  if (!json || typeof json !== 'object') throw new Error('Odoo 回應不是 JSON-RPC 物件。');
  if (json.error) {
    const e = json.error;
    const data = e.data || {};
    const name = String(data.name || '').replace(/^odoo\.exceptions\./, '').replace(/^odoo\./, '');
    const msg = String(data.message || e.message || '未知錯誤').trim();
    const err = new Error(`Odoo ${name || 'error'}：${msg}`);
    err.odooName = name;
    err.odooCode = e.code;
    throw err;
  }
  return json.result;
}

/**
 * 記錄正規化：many2one 的 [id, name] → {id, name}；false → null。
 * @param {!Object} rec
 * @return {!Object}
 */
function odooNormalizeRecord_(rec) {
  const out = {};
  Object.keys(rec || {}).forEach((k) => {
    const v = rec[k];
    if (v === false) out[k] = null;
    else if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'string') out[k] = { id: v[0], name: v[1] };
    else out[k] = v;
  });
  return out;
}

/**
 * fields_get 的結果 → 精簡清單。
 * @param {!Object} fieldsGet
 * @param {{search: string, requiredOnly: boolean}} opts
 * @return {{count: number, truncated: boolean, fields: !Array<!Object>}}
 */
function odooSummarizeFields_(fieldsGet, opts) {
  const q = String((opts && opts.search) || '').toLowerCase();
  const names = Object.keys(fieldsGet || {}).filter((name) => {
    const f = fieldsGet[name];
    if (opts && opts.requiredOnly && !f.required) return false;
    if (q && name.toLowerCase().indexOf(q) === -1 && String(f.string || '').toLowerCase().indexOf(q) === -1) return false;
    return true;
  }).sort((a, b) => {
    const fa = fieldsGet[a]; const fb = fieldsGet[b];
    if (!!fa.required !== !!fb.required) return fa.required ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const fields = names.slice(0, ODOO_FIELDS_MAX).map((name) => {
    const f = fieldsGet[name];
    const o = { name, label: f.string || '', type: f.type || '' };
    if (f.required) o.required = true;
    if (f.readonly) o.readonly = true;
    if (f.relation) o.relation = f.relation;
    if (Array.isArray(f.selection) && f.selection.length) o.selection = f.selection.map((s) => s[0]);
    if (f.help) o.help = truncateText_(String(f.help), 120).text;
    return o;
  });
  return { count: names.length, truncated: names.length > ODOO_FIELDS_MAX, fields };
}

// ---- 連線 ---------------------------------------------------------------------------------

/**
 * @param {!Object} config ToolConfig
 * @return {{url: string, db: string, login: string}}
 * @throws {Error} 未設定
 */
function odooConfig_(config) {
  const url = String((config && config.odooUrl) || '').replace(/\/+$/, '');
  const db = String((config && config.odooDb) || '').trim();
  const login = String((config && config.odooLogin) || '').trim();
  if (!url || !db || !login) throw new Error('Odoo 尚未設定：owner 請到管理頁「工具」分頁的 Odoo 區塊填 URL / 資料庫 / 登入帳號並貼 API key。');
  if (!/^https:\/\//.test(url)) throw new Error('odoo_url 必須是 https:// 開頭。');
  return { url, db, login };
}

/**
 * 送 JSON-RPC。
 * @param {string} url Odoo 根網址
 * @param {!Object} payload
 * @param {Function=} fetchFn 測試注入
 * @return {*} result
 */
function odooRpc_(url, payload, fetchFn) {
  const res = (fetchFn || ((u, o) => UrlFetchApp.fetch(u, o)))(url + '/jsonrpc', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  if (!json) throw new Error(`Odoo 回應不是 JSON（HTTP ${code}）：${String(text).slice(0, 200)}`);
  return odooParseResponse_(json);
}

/**
 * 取 uid（CacheService 快取）。
 * @param {{url: string, db: string, login: string}} cfg
 * @param {string} key
 * @param {{fetch: Function, cache: Object}=} deps
 * @return {number}
 */
function odooUid_(cfg, key, deps) {
  deps = deps || {};
  const cache = deps.cache || CacheService.getScriptCache();
  const cacheKey = 'odoo_uid:' + cfg.db + ':' + cfg.login;
  const cached = cache.get(cacheKey);
  if (cached && Number(cached) > 0) return Number(cached);
  const uid = odooRpc_(cfg.url, odooRpcPayload_('common', 'authenticate', [cfg.db, cfg.login, key, {}]), deps.fetch);
  if (!uid || typeof uid !== 'number') throw new Error(`Odoo 登入失敗：帳號 ${cfg.login} 或 API key 不正確（資料庫 ${cfg.db}）。`);
  cache.put(cacheKey, String(uid), ODOO_UID_CACHE_SECONDS);
  return uid;
}

/**
 * execute_kw；遇 session / access 失效時清 uid 快取重試一次。
 * @param {!Object} config ToolConfig
 * @param {string} model
 * @param {string} method
 * @param {!Array} args
 * @param {!Object=} kwargs
 * @param {{fetch: Function, cache: Object, key: string}=} deps
 * @return {*}
 */
function odooExecute_(config, model, method, args, kwargs, deps) {
  deps = deps || {};
  const cfg = odooConfig_(config);
  const key = deps.key !== undefined ? deps.key : getProp_(PROP.ODOO_API_KEY);
  if (!key) throw new Error('Odoo API key 尚未設定（Script Property ODOO_API_KEY）：owner 請到管理頁「工具」分頁貼入。');
  const uid = odooUid_(cfg, key, deps);
  return odooRpc_(cfg.url, odooExecutePayload_(cfg, uid, key, model, method, args, kwargs), deps.fetch);
}

/**
 * 測試連線：authenticate + 讀自己的名字 / 公司 + 數 res.partner。
 * @param {!Object} config
 * @return {{ok: boolean, uid: number, user: string, company: string, version: string, partners: number, ms: number, error: string}}
 */
function odooTestConnection_(config) {
  const t0 = Date.now();
  try {
    const cfg = odooConfig_(config);
    const cache = CacheService.getScriptCache();
    cache.remove('odoo_uid:' + cfg.db + ':' + cfg.login);
    const version = odooRpc_(cfg.url, odooRpcPayload_('common', 'version', []));
    const me = odooExecute_(config, 'res.users', 'search_read', [[['id', '=', odooUid_(cfg, getProp_(PROP.ODOO_API_KEY))]]], { fields: ['name', 'login', 'company_id'], limit: 1 });
    const user = me && me[0] ? odooNormalizeRecord_(me[0]) : {};
    let partners = -1;
    try { partners = odooExecute_(config, 'res.partner', 'search_count', [[]]); } catch (err) { partners = -1; }
    return { ok: true, uid: user.id || 0, user: user.name || user.login || '', company: user.company_id ? user.company_id.name : '', version: String(version && version.server_version || ''), partners, ms: Date.now() - t0, error: '' };
  } catch (err) {
    return { ok: false, uid: 0, user: '', company: '', version: '', partners: -1, ms: Date.now() - t0, error: String(err && err.message || err) };
  }
}

// ---- handlers ---------------------------------------------------------------------------

/** @return {!Array<string>} */
function odooAllowed_(ctx) {
  return (ctx && ctx.config && ctx.config.odooAllowedModels) || [];
}

function odooModels_(args, ctx) {
  const allowed = odooAllowed_(ctx);
  if (!allowed.length) throw new Error('Odoo model 白名單是空的。owner 可在管理頁「工具」分頁的 Odoo 區塊設定。');
  const cfg = odooConfig_(ctx.config);
  let names = {};
  try {
    const rows = odooExecute_(ctx.config, 'ir.model', 'search_read', [[['model', 'in', allowed]]], { fields: ['model', 'name', 'transient'], limit: allowed.length + 5 });
    rows.forEach((r) => { names[r.model] = r.name; });
  } catch (err) { names = {}; }
  let me = {};
  try {
    const rows = odooExecute_(ctx.config, 'res.users', 'read', [[odooUid_(cfg, getProp_(PROP.ODOO_API_KEY))]], { fields: ['name', 'login', 'company_id', 'tz', 'lang'] });
    me = rows && rows[0] ? odooNormalizeRecord_(rows[0]) : {};
  } catch (err) { me = {}; }
  return {
    url: cfg.url, db: cfg.db,
    user: me.name || cfg.login, company: me.company_id ? me.company_id.name : '', tz: me.tz || '', lang: me.lang || '',
    models: allowed.map((m) => ({ model: m, name: names[m] || '', installed: m in names })),
  };
}

function odooFields_(args, ctx) {
  const model = odooAssertModel_(args.model, odooAllowed_(ctx));
  const fieldsGet = odooExecute_(ctx.config, model, 'fields_get', [], { attributes: ['string', 'type', 'required', 'readonly', 'relation', 'selection', 'help'] });
  return Object.assign({ model }, odooSummarizeFields_(fieldsGet, { search: args.search, requiredOnly: !!args.required_only }));
}

function odooSearchRead_(args, ctx) {
  const model = odooAssertModel_(args.model, odooAllowed_(ctx));
  const domain = odooValidateDomain_(odooJsonArg_(args.domain, 'domain', 'array', true));
  if (args.count_only) {
    return { model, domain, count: odooExecute_(ctx.config, model, 'search_count', [domain]) };
  }
  const limit = clampInt_(args.limit, ODOO_SEARCH_DEFAULT_LIMIT, 1, ODOO_SEARCH_MAX_LIMIT);
  const kwargs = { limit, offset: clampInt_(args.offset, 0, 0, 1000000) };
  const fields = toStringList_(args.fields);
  if (fields.length) kwargs.fields = fields;
  if (args.order) kwargs.order = String(args.order);
  const rows = odooExecute_(ctx.config, model, 'search_read', [domain], kwargs);
  const records = (rows || []).map(odooNormalizeRecord_);
  let total = records.length;
  if (records.length >= limit || kwargs.offset) {
    try { total = odooExecute_(ctx.config, model, 'search_count', [domain]); } catch (err) { total = -1; }
  }
  return { model, domain, count: records.length, total, offset: kwargs.offset, limit, truncated: total > kwargs.offset + records.length, records };
}

function odooRead_(args, ctx) {
  const model = odooAssertModel_(args.model, odooAllowed_(ctx));
  const ids = odooNormalizeIds_(args.ids);
  if (ids.length > ODOO_SEARCH_MAX_LIMIT) throw new Error(`一次最多讀 ${ODOO_SEARCH_MAX_LIMIT} 筆。`);
  const kwargs = {};
  const fields = toStringList_(args.fields);
  if (fields.length) kwargs.fields = fields;
  const rows = odooExecute_(ctx.config, model, 'read', [ids], kwargs);
  return { model, count: (rows || []).length, records: (rows || []).map(odooNormalizeRecord_) };
}

function odooCreate_(args, ctx) {
  const model = odooAssertModel_(args.model, odooAllowed_(ctx));
  const values = odooJsonArg_(args.values, 'values', 'object');
  if (!Object.keys(values).length) throw new Error('values 必須是非空 object。');
  const id = odooExecute_(ctx.config, model, 'create', [values]);
  const newId = Array.isArray(id) ? id[0] : id;
  let display = '';
  try {
    const rows = odooExecute_(ctx.config, model, 'read', [[newId]], { fields: ['display_name'] });
    display = rows && rows[0] ? rows[0].display_name : '';
  } catch (err) { display = ''; }
  return { model, created: true, id: newId, display_name: display, url: odooRecordUrl_(ctx.config, model, newId) };
}

function odooWrite_(args, ctx) {
  const model = odooAssertModel_(args.model, odooAllowed_(ctx));
  const ids = odooNormalizeIds_(args.ids);
  const values = odooJsonArg_(args.values, 'values', 'object');
  if (!Object.keys(values).length) throw new Error('values 必須是非空 object。');
  odooExecute_(ctx.config, model, 'write', [ids, values]);
  return { model, updated: ids.length, ids, fields: Object.keys(values) };
}

function odooCall_(args, ctx) {
  const model = odooAssertModel_(args.model, odooAllowed_(ctx));
  const method = odooAssertMethod_(args.method);
  const ids = odooNormalizeIds_(args.ids);
  const extra = odooJsonArg_(args.args, 'args', 'array', true) || [];
  const kwargs = odooJsonArg_(args.kwargs, 'kwargs', 'object', true) || {};
  const result = odooExecute_(ctx.config, model, method, [ids].concat(extra), kwargs);
  // 按鈕類方法常回 True 或一個 action dict；action 只留 type / name 避免塞爆
  let summary = result;
  if (result && typeof result === 'object' && !Array.isArray(result) && result.type) summary = { type: result.type, name: result.name || '', res_model: result.res_model || '', res_id: result.res_id || null };
  let states = [];
  try {
    const rows = odooExecute_(ctx.config, model, 'read', [ids], { fields: ['display_name', 'state'] });
    states = (rows || []).map(odooNormalizeRecord_);
  } catch (err) { states = []; }
  return { model, method, ids, result: summary, records: states };
}

function odooUnlink_(args, ctx) {
  const model = odooAssertModel_(args.model, odooAllowed_(ctx));
  const ids = odooNormalizeIds_(args.ids);
  odooExecute_(ctx.config, model, 'unlink', [ids]);
  return { model, deleted: ids.length, ids };
}

/**
 * @param {!Object} config
 * @param {string} model
 * @param {number} id
 * @return {string} Odoo 18 的記錄網址
 */
function odooRecordUrl_(config, model, id) {
  const url = String((config && config.odooUrl) || '').replace(/\/+$/, '');
  return url ? `${url}/odoo/${model}/${id}` : '';
}
