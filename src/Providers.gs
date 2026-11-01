/**
 * @fileoverview 多 provider：adapter（OpenAI 相容 / Anthropic Messages / Gemini generateContent）、
 * 模型角色與備援鏈、Usage 記錄。
 *
 * 中立格式（neutral）採 OpenAI chat/completions 風格，Agent（M2）與 Messages sheet（M3）都存這個：
 *   messages: [{role: 'system'|'user'|'assistant'|'tool', content: string|null,
 *               tool_calls?: [{id, type: 'function', function: {name, arguments: string(JSON)}}],  // assistant
 *               tool_call_id?: string, name?: string}]                                            // tool
 *   tools:    [{name, description, parameters: JSON Schema}]
 * 每個 adapter 只做兩件純函式：buildRequest(provider, req, apiKey) → {url, headers, body}
 * 與 parseResponse(json) → ChatResult；不打網路，方便測試。網路與備援在 callProvider_ / chatWithChain_。
 *
 * 設定來源是 DB 的 Providers tab；API key 只進 Script Properties `PROVIDER_KEY_<id>`，
 * 絕不寫進 sheet、不回傳前端（只回末 4 碼）。
 */

/** 支援的協定。 */
const PROVIDER_PROTOCOLS = Object.freeze(['openai', 'anthropic', 'gemini']);

/** 模型角色：main 主模型、fast 快模型（摘要 / curation）、embed 嵌入（M3）。 */
const PROVIDER_ROLES = Object.freeze(['main', 'fast', 'embed']);

/** Script Properties 鍵名前綴；完整鍵為 PROVIDER_KEY_<id>。 */
const PROVIDER_KEY_PREFIX = 'PROVIDER_KEY_';

/** provider id 規則：小寫字母 / 數字 / `_` / `-`，最長 32，因為會拼進 Properties 鍵名。 */
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Anthropic Messages API 版本 header。 */
const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic 的 max_tokens 是必填；provider 與請求都沒給時用這個。 */
const DEFAULT_MAX_TOKENS = 1024;

/**
 * @typedef {{
 *   id: string, label: string, protocol: string, base_url: string, model: string, role: string,
 *   priority: number, enabled: boolean, extra_headers: !Object<string, string>, max_tokens: number,
 *   extra_body: !Object, cost_in_per_m: number, cost_out_per_m: number, _row: (number|undefined)
 * }} Provider
 */

/**
 * @typedef {{
 *   messages: !Array<!Object>, tools: (!Array<!Object>|undefined), model: (string|undefined),
 *   maxTokens: (number|undefined), temperature: (number|undefined), sessionId: (string|undefined)
 * }} ChatRequest
 */

/**
 * @typedef {{
 *   text: string, toolCalls: !Array<{id: string, name: string, args: !Object}>,
 *   usage: {prompt: number, completion: number}, stop: string, raw: *
 * }} ChatResult
 * stop：'end' 正常結束、'tool_calls' 要求呼叫工具、'length' 撞到 max_tokens、'other'。
 */

// ---- API key（Script Properties）-------------------------------------------------

/**
 * @param {string} id
 * @return {string} Properties 鍵名
 */
function providerKeyProp_(id) {
  return PROVIDER_KEY_PREFIX + id;
}

/**
 * @param {string} id
 * @return {string} API key；未設定為空字串
 */
function getProviderKey_(id) {
  return getProp_(providerKeyProp_(id));
}

/**
 * 寫入 / 清除 API key。
 * @param {string} id
 * @param {string} key 空字串即刪除
 */
function setProviderKey_(id, key) {
  if (!PROVIDER_ID_RE.test(String(id))) throw new Error(`provider id 不合法：${id}`);
  setProp_(providerKeyProp_(id), String(key || '').trim());
}

/**
 * @param {string} key
 * @return {string} 給 UI 看的提示，只含末 4 碼
 */
function keyHint_(key) {
  return key ? '…' + String(key).slice(-4) : '';
}

// ---- Providers sheet ------------------------------------------------------------

/**
 * 把 sheet 的一列整理成型別正確的 Provider。
 * @param {!Object} row readTable_ 的列
 * @return {Provider}
 */
function parseProviderRow_(row) {
  return {
    _row: row._row,
    id: String(row.id || '').trim(),
    label: String(row.label || '').trim(),
    protocol: String(row.protocol || '').trim().toLowerCase(),
    base_url: String(row.base_url || '').trim(),
    model: String(row.model || '').trim(),
    role: String(row.role || 'main').trim().toLowerCase(),
    priority: toNumber_(row.priority, 100),
    enabled: toBoolean_(row.enabled),
    extra_headers: parseJsonObject_(row.extra_headers),
    max_tokens: toNumber_(row.max_tokens, 0),
    extra_body: parseJsonObject_(row.extra_body),
    cost_in_per_m: toNumber_(row.cost_in_per_m, 0),
    cost_out_per_m: toNumber_(row.cost_out_per_m, 0),
  };
}

/**
 * 驗證並正規化前端 / 使用者輸入的 provider。純函式，不碰 sheet。
 * @param {!Object} input
 * @return {Provider}
 * @throws {Error} 欄位不合法
 */
function validateProvider_(input) {
  const p = parseProviderRow_(Object.assign({}, input, {
    extra_headers: input.extra_headers === undefined ? '' : input.extra_headers,
    extra_body: input.extra_body === undefined ? '' : input.extra_body,
  }));
  delete p._row;
  if (!PROVIDER_ID_RE.test(p.id)) throw new Error('id 只能用小寫字母、數字、_ 與 -，最長 32 字元。');
  if (PROVIDER_PROTOCOLS.indexOf(p.protocol) === -1) throw new Error(`protocol 必須是 ${PROVIDER_PROTOCOLS.join(' / ')}。`);
  if (PROVIDER_ROLES.indexOf(p.role) === -1) throw new Error(`role 必須是 ${PROVIDER_ROLES.join(' / ')}。`);
  if (!/^https:\/\/[^\s/]+/.test(p.base_url)) throw new Error('base_url 必須是 https:// 開頭的網址。');
  if (!p.model) throw new Error('model 不可為空。');
  if (!p.label) p.label = p.id;
  if (!isFinite(p.priority)) throw new Error('priority 必須是數字。');
  if (p.max_tokens < 0 || p.cost_in_per_m < 0 || p.cost_out_per_m < 0) throw new Error('max_tokens / 成本不可為負數。');
  // extra_headers / extra_body 若是字串但不是合法 JSON object，parseJsonObject_ 會回 {}；這裡要明確報錯。
  ['extra_headers', 'extra_body'].forEach((field) => {
    const raw = input[field];
    if (typeof raw === 'string' && raw.trim() && !isJsonObjectString_(raw)) {
      throw new Error(`${field} 必須是 JSON object（例如 {"X-Title": "GAS Agent"}）。`);
    }
  });
  return p;
}

/**
 * 讀全部 provider（含停用的）。
 * @return {!Array<Provider>}
 */
function listProviders_() {
  return readTable_('Providers').rows.map(parseProviderRow_).filter((p) => p.id);
}

/**
 * @param {string} id
 * @return {?Provider}
 */
function getProvider_(id) {
  return listProviders_().find((p) => p.id === id) || null;
}

/**
 * 新增或更新（以 id 為鍵）。
 * @param {!Object} input
 * @return {Provider}
 */
function saveProvider_(input) {
  const p = validateProvider_(input);
  const existing = getProvider_(p.id);
  const values = serializeProvider_(p);
  if (existing) {
    writeTableRow_('Providers', existing._row, values);
    p._row = existing._row;
  } else {
    p._row = appendTableRow_('Providers', values);
  }
  return p;
}

/**
 * 刪除 provider 與其 API key。
 * @param {string} id
 * @return {boolean} 是否真的刪了一列
 */
function deleteProvider_(id) {
  const existing = getProvider_(id);
  setProviderKey_(id, '');
  if (!existing) return false;
  deleteTableRow_('Providers', existing._row);
  return true;
}

/**
 * @param {Provider} p
 * @return {!Object} 寫回 sheet 用的值（JSON 欄位序列化、空值留白）
 */
function serializeProvider_(p) {
  return {
    id: p.id,
    label: p.label,
    protocol: p.protocol,
    base_url: p.base_url,
    model: p.model,
    role: p.role,
    priority: p.priority,
    enabled: p.enabled ? 'TRUE' : 'FALSE',
    extra_headers: Object.keys(p.extra_headers).length ? JSON.stringify(p.extra_headers) : '',
    max_tokens: p.max_tokens || '',
    extra_body: Object.keys(p.extra_body).length ? JSON.stringify(p.extra_body) : '',
    cost_in_per_m: p.cost_in_per_m || '',
    cost_out_per_m: p.cost_out_per_m || '',
  };
}

/**
 * 某角色的備援鏈：enabled 且 role 相符，依 priority 由小到大（同值依 id）。純函式。
 * @param {string} role
 * @param {!Array<Provider>} providers
 * @return {!Array<Provider>}
 */
function providerChain_(role, providers) {
  return providers
    .filter((p) => p.enabled && p.role === role)
    .sort((a, b) => (a.priority - b.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 去掉不該回前端的欄位。
 * @param {Provider} p
 * @return {!Object}
 */
function publicProvider_(p) {
  const key = getProviderKey_(p.id);
  const out = Object.assign({}, p, { hasKey: !!key, keyHint: keyHint_(key) });
  delete out._row;
  return out;
}

// ---- 共用 helpers -------------------------------------------------------------

/**
 * @param {*} v
 * @param {number} fallback
 * @return {number}
 */
function toNumber_(v, fallback) {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

/**
 * @param {*} v sheet 的布林 / 'TRUE' / 'yes' / 1 等
 * @return {boolean}
 */
function toBoolean_(v) {
  if (typeof v === 'boolean') return v;
  return ['true', 'yes', 'y', '1', 'on'].indexOf(String(v).trim().toLowerCase()) !== -1;
}

/**
 * @param {*} v JSON 字串或 object
 * @return {!Object} 解析失敗或不是 object 時回 {}
 */
function parseJsonObject_(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

/**
 * @param {string} s
 * @return {boolean} 是否為合法 JSON object 字串
 */
function isJsonObjectString_(s) {
  try {
    const parsed = JSON.parse(s);
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch (err) {
    return false;
  }
}

/**
 * 工具參數：中立格式存 JSON 字串（OpenAI 風格），但也接受 object。
 * @param {*} v
 * @return {!Object} 解析失敗時回 {_raw: 原字串}
 */
function parseJsonArgs_(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string' || !v.trim()) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? parsed : { _raw: v };
  } catch (err) {
    return { _raw: v };
  }
}

/**
 * @param {*} content 字串、null、或 OpenAI 風格的 parts 陣列
 * @return {string}
 */
function stringifyContent_(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  }
  return JSON.stringify(content);
}

/**
 * @param {string} base
 * @param {string} path 以 / 開頭
 * @return {string}
 */
function joinUrl_(base, path) {
  return String(base).replace(/\/+$/, '') + path;
}

/**
 * 先取請求的 maxTokens，再取 provider 設定；都沒有回 0（表示不帶）。
 * @param {Provider} provider
 * @param {ChatRequest} req
 * @return {number}
 */
function pickMaxTokens_(provider, req) {
  if (req.maxTokens && req.maxTokens > 0) return Math.floor(req.maxTokens);
  if (provider.max_tokens && provider.max_tokens > 0) return Math.floor(provider.max_tokens);
  return 0;
}

/**
 * 把 provider.extra_body 蓋到 body 上；值為 null 的 key 代表「移除」（例如拿掉 max_tokens）。
 * @param {!Object} body
 * @param {!Object} extra
 * @return {!Object} body 本身
 */
function applyExtraBody_(body, extra) {
  Object.keys(extra || {}).forEach((k) => {
    if (extra[k] === null) delete body[k];
    else body[k] = extra[k];
  });
  return body;
}

/**
 * 三種協定的結束原因對齊成 'end' | 'tool_calls' | 'length' | 'other'。
 * @param {*} reason
 * @param {number} toolCallCount
 * @return {string}
 */
function normalizeStop_(reason, toolCallCount) {
  const r = String(reason || '').toLowerCase();
  if (r === 'tool_calls' || r === 'tool_use' || r === 'function_call') return 'tool_calls';
  if (r === 'length' || r === 'max_tokens') return 'length';
  if (r === 'stop' || r === 'end_turn' || r === 'stop_sequence' || r === '') return toolCallCount ? 'tool_calls' : 'end';
  return 'other';
}

/**
 * 從 tool 訊息往前找對應 assistant tool_call 的函式名（Gemini functionResponse 需要 name）。
 * @param {!Array<!Object>} messages
 * @param {number} index tool 訊息在 messages 的位置
 * @param {string} toolCallId
 * @return {string} 找不到回空字串
 */
function findToolCallName_(messages, index, toolCallId) {
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    const hit = m.tool_calls.find((tc) => tc.id === toolCallId);
    if (hit) return (hit.function && hit.function.name) || hit.name || '';
  }
  return '';
}

/**
 * 工具定義若缺 parameters，給一個空 object schema。
 * @param {!Object} tool
 * @return {!Object}
 */
function toolParameters_(tool) {
  return tool.parameters || { type: 'object', properties: {} };
}

// ---- Adapter：OpenAI 相容（OpenAI / OpenRouter / Z.ai GLM / DeepSeek …）-----------------

/**
 * @param {Provider} provider
 * @param {ChatRequest} req
 * @param {string} apiKey
 * @return {{url: string, headers: !Object, body: !Object}}
 */
function openaiBuildRequest_(provider, req, apiKey) {
  const body = {
    model: req.model || provider.model,
    messages: req.messages.map(openaiMessage_),
  };
  const maxTokens = pickMaxTokens_(provider, req);
  if (maxTokens) body.max_tokens = maxTokens;
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (req.tools && req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: toolParameters_(t) },
    }));
    body.tool_choice = 'auto';
  }
  applyExtraBody_(body, provider.extra_body);
  return {
    url: joinUrl_(provider.base_url, '/chat/completions'),
    headers: Object.assign({ Authorization: 'Bearer ' + apiKey }, provider.extra_headers),
    body,
  };
}

/**
 * 中立格式本來就是 OpenAI 風格，這裡只做正規化（arguments 轉字串、tool 訊息欄位）。
 * @param {!Object} m
 * @return {!Object}
 */
function openaiMessage_(m) {
  const hasToolCalls = m.role === 'assistant' && m.tool_calls && m.tool_calls.length;
  const out = { role: m.role, content: hasToolCalls && (m.content === null || m.content === undefined) ? null : stringifyContent_(m.content) };
  if (hasToolCalls) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments || {}),
      },
    }));
  }
  if (m.role === 'tool') {
    out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
  }
  return out;
}

/**
 * @param {!Object} json chat/completions 回應
 * @return {ChatResult}
 */
function openaiParseResponse_(json) {
  const choice = (json.choices || [])[0] || {};
  const msg = choice.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc, i) => ({
    id: tc.id || ('call_' + (i + 1)),
    name: (tc.function && tc.function.name) || '',
    args: parseJsonArgs_(tc.function && tc.function.arguments),
  }));
  const usage = json.usage || {};
  return {
    text: stringifyContent_(msg.content),
    toolCalls,
    usage: { prompt: toNumber_(usage.prompt_tokens, 0), completion: toNumber_(usage.completion_tokens, 0) },
    stop: normalizeStop_(choice.finish_reason, toolCalls.length),
    raw: json,
  };
}

// ---- Adapter：Anthropic Messages -----------------------------------------------------

/**
 * @param {Provider} provider
 * @param {ChatRequest} req
 * @param {string} apiKey
 * @return {{url: string, headers: !Object, body: !Object}}
 */
function anthropicBuildRequest_(provider, req, apiKey) {
  const systemParts = [];
  const messages = [];
  req.messages.forEach((m) => {
    if (m.role === 'system') {
      systemParts.push(stringifyContent_(m.content));
    } else if (m.role === 'tool') {
      pushBlocks_(messages, 'user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: stringifyContent_(m.content) }]);
    } else if (m.role === 'assistant') {
      const blocks = [];
      const text = stringifyContent_(m.content);
      if (text) blocks.push({ type: 'text', text });
      (m.tool_calls || []).forEach((tc) => blocks.push({
        type: 'tool_use', id: tc.id, name: tc.function.name, input: parseJsonArgs_(tc.function.arguments),
      }));
      if (blocks.length) pushBlocks_(messages, 'assistant', blocks);
    } else {
      pushBlocks_(messages, 'user', [{ type: 'text', text: stringifyContent_(m.content) || ' ' }]);
    }
  });

  const body = {
    model: req.model || provider.model,
    max_tokens: pickMaxTokens_(provider, req) || DEFAULT_MAX_TOKENS,
    messages,
  };
  if (systemParts.length) body.system = systemParts.join('\n\n');
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (req.tools && req.tools.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: toolParameters_(t) }));
  }
  applyExtraBody_(body, provider.extra_body);
  return {
    url: joinUrl_(provider.base_url.replace(/\/v1\/?$/, ''), '/v1/messages'),
    headers: Object.assign({ 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }, provider.extra_headers),
    body,
  };
}

/**
 * Anthropic / Gemini 都要求 user / assistant(model) 交替，連續同角色的區塊併成一則。
 * @param {!Array<!Object>} messages
 * @param {string} role
 * @param {!Array<!Object>} blocks
 */
function pushBlocks_(messages, role, blocks) {
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    last.content.push(...blocks);
  } else {
    messages.push({ role, content: blocks.slice() });
  }
}

/**
 * @param {!Object} json Messages API 回應
 * @return {ChatResult}
 */
function anthropicParseResponse_(json) {
  const blocks = json.content || [];
  const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
  const usage = json.usage || {};
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join(''),
    toolCalls,
    usage: { prompt: toNumber_(usage.input_tokens, 0), completion: toNumber_(usage.output_tokens, 0) },
    stop: normalizeStop_(json.stop_reason, toolCalls.length),
    raw: json,
  };
}

// ---- Adapter：Gemini generateContent ---------------------------------------------------

/**
 * @param {Provider} provider
 * @param {ChatRequest} req
 * @param {string} apiKey
 * @return {{url: string, headers: !Object, body: !Object}}
 */
function geminiBuildRequest_(provider, req, apiKey) {
  const systemParts = [];
  const contents = [];
  req.messages.forEach((m, index) => {
    if (m.role === 'system') {
      systemParts.push(stringifyContent_(m.content));
    } else if (m.role === 'tool') {
      const name = m.name || findToolCallName_(req.messages, index, m.tool_call_id) || 'unknown';
      const text = stringifyContent_(m.content);
      let response;
      try {
        const parsed = JSON.parse(text);
        response = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { result: parsed };
      } catch (err) {
        response = { result: text };
      }
      pushParts_(contents, 'user', [{ functionResponse: { name, response } }]);
    } else if (m.role === 'assistant') {
      const parts = [];
      const text = stringifyContent_(m.content);
      if (text) parts.push({ text });
      (m.tool_calls || []).forEach((tc) => parts.push({ functionCall: { name: tc.function.name, args: parseJsonArgs_(tc.function.arguments) } }));
      if (parts.length) pushParts_(contents, 'model', parts);
    } else {
      pushParts_(contents, 'user', [{ text: stringifyContent_(m.content) || ' ' }]);
    }
  });

  const body = { contents };
  if (systemParts.length) body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  const generationConfig = {};
  const maxTokens = pickMaxTokens_(provider, req);
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
  if (typeof req.temperature === 'number') generationConfig.temperature = req.temperature;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (req.tools && req.tools.length) {
    body.tools = [{
      functionDeclarations: req.tools.map((t) => {
        const decl = { name: t.name, description: t.description || '' };
        const params = geminiCleanSchema_(toolParameters_(t));
        if (params.properties && Object.keys(params.properties).length) decl.parameters = params;
        return decl;
      }),
    }];
  }
  applyExtraBody_(body, provider.extra_body);
  const model = req.model || provider.model;
  return {
    url: joinUrl_(provider.base_url.replace(/\/v1(beta)?\/?$/, ''), `/v1beta/models/${encodeURIComponent(model)}:generateContent`),
    headers: Object.assign({ 'x-goog-api-key': apiKey }, provider.extra_headers),
    body,
  };
}

/**
 * @param {!Array<!Object>} contents
 * @param {string} role 'user' | 'model'
 * @param {!Array<!Object>} parts
 */
function pushParts_(contents, role, parts) {
  const last = contents[contents.length - 1];
  if (last && last.role === role) {
    last.parts.push(...parts);
  } else {
    contents.push({ role, parts: parts.slice() });
  }
}

/**
 * Gemini 的 schema 是 OpenAPI 子集，比 JSON Schema 嚴：
 * - 不認 additionalProperties / $schema / default / title 等關鍵字（只在 schema 層級移除；`properties` 底下的 key 是參數名，不能動）
 * - `type` 必須是單一字串：["string","array"] 這種聯集收斂成一個（有 string 取 string）
 * - type 不是 array 就不能有 items；不是 object 就不能有 properties / required
 * - required 只能列 properties 裡有的
 * @param {*} schema
 * @return {*}
 */
function geminiCleanSchema_(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const drop = ['additionalProperties', '$schema', '$id', 'examples', 'default', 'title', 'format'];
  const out = {};
  Object.keys(schema).forEach((k) => {
    if (drop.indexOf(k) !== -1) return;
    const v = schema[k];
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      Object.keys(v).forEach((name) => { out.properties[name] = geminiCleanSchema_(v[name]); });
    } else if (k === 'items') {
      out.items = geminiCleanSchema_(v);
    } else if (k === 'type' && Array.isArray(v)) {
      const types = v.filter((t) => t !== 'null');
      out.type = types.indexOf('string') !== -1 ? 'string' : (types[0] || 'string');
    } else {
      out[k] = v;
    }
  });
  if (out.type && out.type !== 'array') delete out.items;
  if (out.type && out.type !== 'object') { delete out.properties; delete out.required; }
  if (out.required && out.properties) out.required = out.required.filter((name) => out.properties[name]);
  if (out.required && !out.required.length) delete out.required;
  return out;
}

/**
 * @param {!Object} json generateContent 回應
 * @return {ChatResult}
 */
function geminiParseResponse_(json) {
  const candidate = (json.candidates || [])[0] || {};
  const parts = (candidate.content && candidate.content.parts) || [];
  const toolCalls = parts.filter((p) => p.functionCall).map((p, i) => ({
    id: p.functionCall.id || ('fc_' + (i + 1)),
    name: p.functionCall.name || '',
    args: p.functionCall.args || {},
  }));
  const usage = json.usageMetadata || {};
  const blocked = !json.candidates && json.promptFeedback && json.promptFeedback.blockReason;
  return {
    text: parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join(''),
    toolCalls,
    usage: {
      prompt: toNumber_(usage.promptTokenCount, 0),
      completion: toNumber_(usage.candidatesTokenCount, 0) + toNumber_(usage.thoughtsTokenCount, 0),
    },
    stop: blocked ? 'other' : normalizeStop_(candidate.finishReason, toolCalls.length),
    raw: json,
  };
}

/** @type {!Object<string, {buildRequest: Function, parseResponse: Function}>} */
const PROVIDER_ADAPTERS_ = Object.freeze({
  openai: { buildRequest: openaiBuildRequest_, parseResponse: openaiParseResponse_ },
  anthropic: { buildRequest: anthropicBuildRequest_, parseResponse: anthropicParseResponse_ },
  gemini: { buildRequest: geminiBuildRequest_, parseResponse: geminiParseResponse_ },
});

/**
 * @param {string} protocol
 * @return {{buildRequest: Function, parseResponse: Function}}
 */
function getAdapter_(protocol) {
  const adapter = PROVIDER_ADAPTERS_[protocol];
  if (!adapter) throw new Error(`不支援的 protocol：${protocol}`);
  return adapter;
}

// ---- 呼叫、錯誤、備援鏈 -------------------------------------------------------------

/**
 * 建一個帶 provider / HTTP 狀態的錯誤。status 0 表示沒打到網路（key 缺失、建請求失敗、fetch 例外）。
 * @param {Provider} provider
 * @param {number} status
 * @param {string} message
 * @param {number=} ms
 * @return {!Error}
 */
function providerError_(provider, status, message, ms) {
  const err = new Error(`[${provider.id}${status ? ' HTTP ' + status : ''}] ${message}`);
  err.providerId = provider.id;
  err.status = status;
  err.ms = ms || 0;
  return err;
}

/**
 * 從錯誤回應裡撈可讀訊息（三家都用 error.message）。
 * @param {?Object} json
 * @param {string} text
 * @return {string}
 */
function extractApiError_(json, text) {
  if (json && json.error) {
    if (typeof json.error === 'string') return json.error;
    if (json.error.message) return String(json.error.message);
  }
  return String(text || '').slice(0, 300) || '（空回應）';
}

/**
 * 是否該換下一個 provider。4xx 的「請求本身有問題」（400 / 404 / 413 / 422 等）換誰都一樣，直接丟出；
 * 沒打到網路（key 未設定、fetch 例外）、401 / 403（key 失效）、408 / 429（忙）、5xx 才 fallback。
 * @param {!Error} err
 * @return {boolean}
 */
function isFallbackableError_(err) {
  const s = Number(err.status || 0);
  if (!s) return true;
  if (s >= 500) return true;
  return [401, 403, 408, 429].indexOf(s) !== -1;
}

/**
 * 預設的 fetch：UrlFetchApp（無法設 timeout；單次執行上限 6 分鐘）。
 * @param {string} url
 * @param {!Object} options
 * @return {GoogleAppsScript.URL_Fetch.HTTPResponse}
 */
function defaultProviderFetch_(url, options) {
  return UrlFetchApp.fetch(url, options);
}

/**
 * 呼叫單一 provider 一次（不做備援、不寫記錄）。
 * @param {Provider} provider
 * @param {ChatRequest} req
 * @param {{fetch: (Function|undefined), keyFor: (Function|undefined)}=} deps 測試可注入 fetch stub 與 key 來源
 * @return {ChatResult & {provider: string, model: string, ms: number, costEst: number}}
 * @throws {Error} providerError_
 */
function callProvider_(provider, req, deps) {
  deps = deps || {};
  const fetchFn = deps.fetch || defaultProviderFetch_;
  const apiKey = deps.keyFor ? deps.keyFor(provider.id) : getProviderKey_(provider.id);
  if (!apiKey) throw providerError_(provider, 0, `API key 未設定（Script Property ${providerKeyProp_(provider.id)}），請到管理頁「模型」填入。`);

  const adapter = getAdapter_(provider.protocol);
  const prepared = adapter.buildRequest(provider, req, apiKey);
  const t0 = Date.now();
  let res;
  try {
    res = fetchFn(prepared.url, {
      method: 'post',
      contentType: 'application/json',
      headers: prepared.headers,
      payload: JSON.stringify(prepared.body),
      muteHttpExceptions: true,
    });
  } catch (err) {
    throw providerError_(provider, 0, `fetch 失敗：${err && err.message || err}`, Date.now() - t0);
  }
  const ms = Date.now() - t0;
  const code = res.getResponseCode();
  const text = res.getContentText();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  if (code < 200 || code >= 300) throw providerError_(provider, code, extractApiError_(json, text), ms);
  if (!json) throw providerError_(provider, code, `回應不是 JSON：${String(text).slice(0, 200)}`, ms);

  const result = adapter.parseResponse(json);
  result.provider = provider.id;
  result.model = prepared.body.model || provider.model;
  result.ms = ms;
  result.costEst = estimateCost_(provider, result.usage);
  return result;
}

/**
 * 以 Providers 的選填單價（USD / 百萬 tokens）粗估成本；沒填就 0。
 * @param {Provider} provider
 * @param {{prompt: number, completion: number}} usage
 * @return {number}
 */
function estimateCost_(provider, usage) {
  const cost = (usage.prompt / 1e6) * (provider.cost_in_per_m || 0) + (usage.completion / 1e6) * (provider.cost_out_per_m || 0);
  return Math.round(cost * 1e6) / 1e6;
}

/**
 * 寫 Usage（每次呼叫一列，失敗也記、ok=false）；失敗另記一筆 AuditLog 方便查備援原因。
 * 記錄本身出錯只 console.warn，不影響回覆。
 * @param {{provider: Provider, ok: boolean, result: (Object|undefined), error: (Error|undefined), ms: number, sessionId: string}} entry
 */
function recordProviderCall_(entry) {
  try {
    const ts = new Date();
    const usage = (entry.result && entry.result.usage) || { prompt: 0, completion: 0 };
    appendTableRow_('Usage', {
      ts,
      provider: entry.provider.id,
      model: (entry.result && entry.result.model) || entry.provider.model,
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      cost_est: entry.result ? entry.result.costEst : 0,
      session_id: entry.sessionId || '',
      ms: entry.ms,
      ok: entry.ok,
    });
    if (!entry.ok) {
      appendTableRow_('AuditLog', {
        ts,
        session_id: entry.sessionId || '',
        tool: 'llm:' + entry.provider.id,
        args_preview: entry.provider.model,
        result_preview: String(entry.error && entry.error.message || entry.error).slice(0, 500),
        ok: false,
        ms: entry.ms,
      });
    }
  } catch (err) {
    console.warn('記錄 Usage 失敗：' + (err && err.message || err));
  }
}

/**
 * 依序嘗試備援鏈：成功即回，失敗且可 fallback 就換下一個；每次嘗試都記錄。
 * @param {!Array<Provider>} chain
 * @param {ChatRequest} req
 * @param {{fetch: (Function|undefined), keyFor: (Function|undefined), record: (Function|undefined)}=} deps
 * @return {ChatResult & {provider: string, model: string, ms: number, costEst: number, fallbacks: !Array<{provider: string, status: number, error: string}>}}
 * @throws {Error} 全部失敗或遇到不可 fallback 的錯
 */
function chatWithChain_(chain, req, deps) {
  deps = deps || {};
  const record = deps.record || recordProviderCall_;
  if (!chain.length) throw new Error('沒有可用的 provider：請到管理頁「模型」新增並啟用至少一個。');
  const fallbacks = [];
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    try {
      const result = callProvider_(provider, req, deps);
      record({ provider, ok: true, result, ms: result.ms, sessionId: req.sessionId || '' });
      result.fallbacks = fallbacks;
      return result;
    } catch (err) {
      record({ provider, ok: false, error: err, ms: err.ms || 0, sessionId: req.sessionId || '' });
      fallbacks.push({ provider: provider.id, status: err.status || 0, error: err.message });
      const last = i === chain.length - 1;
      if (!isFallbackableError_(err)) {
        err.fallbacks = fallbacks;
        throw err;
      }
      if (last) {
        const summary = new Error(`備援鏈全部失敗（${chain.length} 個）：\n` + fallbacks.map((f) => `- ${f.error}`).join('\n'));
        summary.fallbacks = fallbacks;
        throw summary;
      }
    }
  }
  throw new Error('unreachable');
}

// ---- Embedding（M3；embed 角色）---------------------------------------------------------

/**
 * @param {Provider} provider
 * @param {!Array<string>} texts
 * @param {string} apiKey
 * @return {{url: string, headers: !Object, body: !Object}}
 */
function openaiEmbedRequest_(provider, texts, apiKey) {
  const body = applyExtraBody_({ model: provider.model, input: texts }, provider.extra_body);
  return { url: joinUrl_(provider.base_url, '/embeddings'), headers: Object.assign({ Authorization: 'Bearer ' + apiKey }, provider.extra_headers), body };
}

/**
 * @param {!Object} json
 * @return {!Array<!Array<number>>} 依 index 排序的向量
 */
function openaiEmbedParse_(json) {
  return (json.data || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0)).map((d) => d.embedding || []);
}

/**
 * @param {Provider} provider
 * @param {!Array<string>} texts
 * @param {string} apiKey
 * @return {{url: string, headers: !Object, body: !Object}}
 */
function geminiEmbedRequest_(provider, texts, apiKey) {
  const model = provider.model.indexOf('models/') === 0 ? provider.model : 'models/' + provider.model;
  const body = { requests: texts.map((t) => ({ model, content: { parts: [{ text: t }] } })) };
  return {
    url: joinUrl_(provider.base_url.replace(/\/v1(beta)?\/?$/, ''), `/v1beta/${model}:batchEmbedContents`),
    headers: Object.assign({ 'x-goog-api-key': apiKey }, provider.extra_headers),
    body,
  };
}

/**
 * @param {!Object} json
 * @return {!Array<!Array<number>>}
 */
function geminiEmbedParse_(json) {
  return (json.embeddings || []).map((e) => e.values || []);
}

/** @type {!Object<string, {buildRequest: Function, parseResponse: Function}>} */
const EMBED_ADAPTERS_ = Object.freeze({
  openai: { buildRequest: openaiEmbedRequest_, parseResponse: openaiEmbedParse_ },
  gemini: { buildRequest: geminiEmbedRequest_, parseResponse: geminiEmbedParse_ },
});

/**
 * 嵌入一批文字（單一 provider、不備援）。
 * @param {Provider} provider
 * @param {!Array<string>} texts
 * @param {{fetch: (Function|undefined), keyFor: (Function|undefined)}=} deps
 * @return {!Array<!Array<number>>}
 * @throws {Error}
 */
function embedTexts_(provider, texts, deps) {
  deps = deps || {};
  const adapter = EMBED_ADAPTERS_[provider.protocol];
  if (!adapter) throw providerError_(provider, 0, `protocol ${provider.protocol} 不支援嵌入（只有 openai / gemini）。`);
  const apiKey = deps.keyFor ? deps.keyFor(provider.id) : getProviderKey_(provider.id);
  if (!apiKey) throw providerError_(provider, 0, `API key 未設定（Script Property ${providerKeyProp_(provider.id)}）。`);
  const prepared = adapter.buildRequest(provider, texts, apiKey);
  const t0 = Date.now();
  let res;
  try {
    res = (deps.fetch || defaultProviderFetch_)(prepared.url, { method: 'post', contentType: 'application/json', headers: prepared.headers, payload: JSON.stringify(prepared.body), muteHttpExceptions: true });
  } catch (err) {
    throw providerError_(provider, 0, `fetch 失敗：${err && err.message || err}`, Date.now() - t0);
  }
  const code = res.getResponseCode();
  const text = res.getContentText();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  if (code < 200 || code >= 300) throw providerError_(provider, code, extractApiError_(json, text), Date.now() - t0);
  const vectors = adapter.parseResponse(json || {});
  if (vectors.length !== texts.length) throw providerError_(provider, code, `嵌入數量不符：要 ${texts.length} 回 ${vectors.length}`, Date.now() - t0);
  return vectors;
}

/**
 * 走 embed 角色的備援鏈。
 * @param {!Array<string>} texts
 * @param {{fetch: (Function|undefined), keyFor: (Function|undefined), providers: (Array|undefined)}=} deps
 * @return {{vectors: !Array<!Array<number>>, provider: string}}
 * @throws {Error} 沒有 embed provider 或全部失敗
 */
function embedWithChain_(texts, deps) {
  deps = deps || {};
  const chain = providerChain_('embed', deps.providers || listProviders_());
  if (!chain.length) throw new Error('沒有啟用的 embed provider（role=embed）。');
  const errors = [];
  for (let i = 0; i < chain.length; i++) {
    try {
      return { vectors: embedTexts_(chain[i], texts, deps), provider: chain[i].id };
    } catch (err) {
      errors.push(err.message);
      if (!isFallbackableError_(err)) throw err;
    }
  }
  throw new Error('embed 備援鏈全部失敗：\n' + errors.map((e) => '- ' + e).join('\n'));
}

/**
 * @param {!Array<number>} a
 * @param {!Array<number>} b
 * @return {number} cosine 相似度；長度不符或零向量回 0
 */
function cosine_(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * 單輪對話入口。M1 由管理頁聊天台以 google.script.run 同步呼叫；M4 改走 Queue 時 UI 不用改，
 * 只要 job runner 呼叫同一個函式。
 * @param {{providerId: (string|undefined), role: (string|undefined), messages: !Array<!Object>,
 *   tools: (!Array<!Object>|undefined), maxTokens: (number|undefined), temperature: (number|undefined),
 *   sessionId: (string|undefined)}} input providerId 指定就只打它（不 fallback）；否則走 role（預設 main）的備援鏈
 * @return {!Object} chatWithChain_ 的結果
 */
function runChatTurn_(input) {
  const providers = listProviders_();
  let chain;
  if (input.providerId) {
    const p = providers.find((x) => x.id === input.providerId);
    if (!p) throw new Error(`找不到 provider「${input.providerId}」。`);
    if (p.role === 'embed') throw new Error('embed 角色的 provider 不能聊天（M3 才接嵌入 API）。');
    chain = [p];
  } else {
    chain = providerChain_(input.role || 'main', providers);
  }
  return chatWithChain_(chain, {
    messages: input.messages,
    tools: input.tools || [],
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    sessionId: input.sessionId || '',
  });
}

/**
 * 「測試連線」：送一則極短訊息，回延遲與回覆。
 * @param {string} id
 * @return {{ok: boolean, ms: number, text: string, model: string, usage: Object, error: string}}
 */
function testProvider_(id) {
  const provider = getProvider_(id);
  if (!provider) throw new Error(`找不到 provider「${id}」。`);
  if (provider.role === 'embed') throw new Error('embed 角色的 provider 不能用聊天測試（M3 才接嵌入 API）。');
  const t0 = Date.now();
  try {
    const result = callProvider_(provider, {
      messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
      maxTokens: 32,
      sessionId: 'admin-test',
    });
    recordProviderCall_({ provider, ok: true, result, ms: result.ms, sessionId: 'admin-test' });
    return { ok: true, ms: result.ms, text: result.text, model: result.model, usage: result.usage, stop: result.stop, error: '' };
  } catch (err) {
    recordProviderCall_({ provider, ok: false, error: err, ms: err.ms || (Date.now() - t0), sessionId: 'admin-test' });
    return { ok: false, ms: err.ms || (Date.now() - t0), text: '', model: provider.model, usage: null, stop: '', error: String(err.message || err) };
  }
}
