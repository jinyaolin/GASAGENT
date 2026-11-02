/**
 * @fileoverview protocol `chatgpt`（M7）：Sign in with ChatGPT（SIWC）開源方案——用 owner 的 ChatGPT Plus / Pro 方案額度打
 * **公開的** Responses API（https://api.openai.com/v1/responses），不是 ChatGPT 的 backend-api。
 * 官方文件：https://developers.openai.com/siwc/token-sharing-open-source
 *
 * 流程：
 *   1. 登入在本機做（OAuth 回呼只能到 127.0.0.1）：`node scripts/siwc-login.js --account <代號>` 動態註冊 client、PKCE、
 *      換 token、驗 ID token，印出一段憑證 JSON。
 *   2. 管理頁「模型」分頁新增 protocol=chatgpt 的 provider，貼上那段 JSON → parseChatGptCredentials_ 驗證後存
 *      Script Property `PROVIDER_OAUTH_<id>`（JSON；官方「自架 VM」一節允許把憑證搬到自己控制的遠端主機並由它 refresh）。
 *   3. 每次呼叫前 chatgptAccessToken_：access token（1 小時）快到期就用 refresh token（30 天滾動）換新，LockService 序列化避免
 *      trigger 與管理頁同時 refresh 把滾動的 refresh token 弄壞；refresh 回終端錯誤（invalid_grant 等）就把憑證標 invalid、
 *      推 Telegram 請 owner 重新登入，不再重試。
 *   4. Responses API 的要求（preview-limitations）：store:false、stream:true、system 走 instructions、不能帶 temperature /
 *      max_output_tokens 等欄位、歷史放 input。GAS UrlFetch 沒有串流，但會等整個 SSE 回完再給我們，所以把 text/event-stream
 *      整段解析，取 response.completed 的 response。
 *
 * 條款（openai.com/policies/sign-in-with-chatgpt-terms）要點與本實作的對應：
 *   - 「請求必須為已驗證的使用者本人」→ 這個 protocol 只服務 principal=owner（runChatTurn_ 會把它從群組成員 / 訪客那一輪的備援鏈剔除）。
 *   - 「不得共享 / 匯集方案額度」→ 每個 Google 帳號（agent）各自登入自己的 ChatGPT 帳號，憑證不互用。
 *   - 「token 持久儲存須在使用者本機 / 自己控制的環境」→ GAS 跑在 owner 自己的 Google 帳號，但 Script Properties 是 Google 代管，
 *     屬灰色地帶；owner 2026-11-03 知情後決定採用。
 * 純函式（build / parse / 判斷 / 套用）與打網路的部分分開，測試注入 fetch / store / lock / now。
 */

/** 公開 Responses API。 */
const CHATGPT_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** OAuth token endpoint（refresh 用）。 */
const CHATGPT_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
/** OIDC 設定（取 revocation_endpoint）。 */
const CHATGPT_OIDC_CONFIG_URL = 'https://auth.openai.com/.well-known/openid-configuration';
/** 找不到 openid-configuration 時的撤銷端點備援。 */
const CHATGPT_REVOKE_URL_FALLBACK = 'https://auth.openai.com/api/accounts/oauth/revoke';
/** OAuth resource 參數（access token 的 aud）。 */
const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
/** 用方案額度打 Responses API 必須有的 scope。 */
const CHATGPT_REQUIRED_SCOPE = 'chatgpt.tokens.use.direct';
/** access token 剩不到這麼久就先 refresh。 */
const CHATGPT_REFRESH_AHEAD_MS = 5 * 60 * 1000;
/** refresh token 壽命（30 天滾動）；Doctor 用來提醒。 */
const CHATGPT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
/** Script Properties 鍵名前綴；完整鍵為 PROVIDER_OAUTH_<id>。 */
const PROVIDER_OAUTH_PREFIX = 'PROVIDER_OAUTH_';
/** refresh 回這些 error code = 憑證不可再用，要重新登入。 */
const CHATGPT_TERMINAL_REFRESH_ERRORS = Object.freeze(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused', 'invalid_client']);
/** 這條路不接受的 Responses 欄位（preview-limitations）；extra_body 帶了也會被拿掉。 */
const CHATGPT_UNSUPPORTED_BODY_FIELDS = Object.freeze(['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id', 'max_tokens']);
/** Responses 層錯誤碼 → 等價 HTTP 狀態（決定要不要 fallback）。 */
const CHATGPT_ERROR_STATUS = Object.freeze({
  subscription_sharing_user_not_eligible: 403, subscription_sharing_usage_limit_exceeded: 429, subscription_sharing_usage_unavailable: 503,
  subscription_sharing_unsupported_capability: 400, subscription_sharing_route_not_supported: 403, subscription_sharing_invalid_user: 401,
  chatpass_v2_scope_not_authorized: 403, chatpass_v2_invalid_authorization_context: 403, subscription_sharing_user_unavailable: 503,
});
/** 給 owner 看的錯誤碼說明。 */
const CHATGPT_ERROR_HINT = Object.freeze({
  subscription_sharing_usage_limit_exceeded: 'ChatGPT 方案額度用完（Plus 是 5 小時滾動上限，且所有 app 共用）：到 https://chatgpt.com/settings/usage 看或等重置。',
  subscription_sharing_user_not_eligible: '這個 ChatGPT 帳號 / workspace 不能把方案額度用在第三方 app。',
  subscription_sharing_unsupported_capability: '請求帶了這條路不支援的欄位 / 工具 / 模型。',
  subscription_sharing_invalid_user: '憑證對應的使用者驗不過，請重新登入。',
});

/**
 * @typedef {{
 *   client_id: string, access_token: string, refresh_token: string, id_token: string, expires_at: number, scopes: !Array<string>,
 *   email: string, subject: string, ext_agent_host_id: string, saved_at: string, refreshed_at: string, invalid: string
 * }} ChatGptCredentials
 * expires_at：access token 到期（毫秒）；invalid：refresh 回終端錯誤的 code（空 = 可用）。
 */

// ---- 憑證儲存 -------------------------------------------------------------------------------

/** @param {string} id @return {string} */
function providerOAuthProp_(id) { return PROVIDER_OAUTH_PREFIX + id; }

/**
 * @param {string} id
 * @return {?ChatGptCredentials}
 */
function getProviderOAuth_(id) {
  const raw = getProp_(providerOAuthProp_(id));
  if (!raw) return null;
  try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : null; } catch (err) { return null; }
}

/**
 * @param {string} id
 * @param {?ChatGptCredentials} creds null = 刪除
 */
function setProviderOAuth_(id, creds) {
  if (!PROVIDER_ID_RE.test(String(id))) throw new Error(`provider id 不合法：${id}`);
  setProp_(providerOAuthProp_(id), creds ? JSON.stringify(creds) : '');
}

/**
 * Script Properties 版的憑證 store（測試注入記憶體版）。
 * @param {string} id
 * @return {{get: function(): ?ChatGptCredentials, set: function(?ChatGptCredentials)}}
 */
function chatgptPropStore_(id) {
  return { get: () => getProviderOAuth_(id), set: (c) => setProviderOAuth_(id, c) };
}

// ---- 純函式：憑證解析 / 判斷 ----------------------------------------------------------------------

/**
 * base64url 解碼成字串（GAS 用 Utilities；本機測試 stub）。
 * @param {string} s
 * @return {string}
 */
function base64UrlDecode_(s) {
  const bytes = Utilities.base64DecodeWebSafe(String(s).replace(/=+$/, ''));
  return Utilities.newBlob(bytes).getDataAsString('UTF-8');
}

/**
 * JWT payload（不驗簽；只拿 exp / email 等資訊）。純函式。
 * @param {*} token
 * @return {?Object}
 */
function decodeJwtPayload_(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try { const o = JSON.parse(base64UrlDecode_(parts[1])); return o && typeof o === 'object' ? o : null; } catch (err) { return null; }
}

/**
 * 把 scripts/siwc-login.js 印出的憑證（JSON 字串或 object）驗證並正規化成 ChatGptCredentials。純函式。
 * 必要：client_id（不能是 dynamic_agent_client）、access_token、refresh_token、scopes 含 chatgpt.tokens.use.direct。
 * expires_at 來源：input.expires_at → saved_at + expires_in → access token 的 exp。
 * @param {*} input
 * @param {number=} now
 * @return {ChatGptCredentials}
 * @throws {Error}
 */
function parseChatGptCredentials_(input, now) {
  now = now || Date.now();
  let o = input;
  if (typeof o === 'string') {
    const s = o.trim();
    if (!s) throw new Error('請貼上 scripts/siwc-login.js 印出的憑證 JSON。');
    try { o = JSON.parse(s); } catch (err) { throw new Error('憑證不是合法 JSON：請整段複製 scripts/siwc-login.js 的輸出。'); }
  }
  if (!o || typeof o !== 'object') throw new Error('憑證必須是 JSON object。');
  const str = (k) => (o[k] === null || o[k] === undefined ? '' : String(o[k]).trim());
  const clientId = str('client_id');
  if (!clientId) throw new Error('憑證缺 client_id。');
  if (clientId === 'dynamic_agent_client') throw new Error('client_id 是 dynamic_agent_client：登入沒完成動態註冊，請重跑 scripts/siwc-login.js。');
  if (!str('access_token')) throw new Error('憑證缺 access_token。');
  if (!str('refresh_token')) throw new Error('憑證缺 refresh_token（登入時要有 offline_access scope）。');
  let scopes = Array.isArray(o.scopes) ? o.scopes.map(String) : toStringList_(str('scope')).join(' ').split(/\s+/).filter(Boolean);
  scopes = scopes.map((x) => String(x).trim()).filter((x, i, a) => x && a.indexOf(x) === i);
  if (scopes.indexOf(CHATGPT_REQUIRED_SCOPE) === -1) throw new Error(`憑證沒有 ${CHATGPT_REQUIRED_SCOPE} scope：登入時使用者沒有同意「使用 ChatGPT 方案」，請重跑登入並在同意畫面勾選。`);
  const payload = decodeJwtPayload_(o.access_token) || {};
  let expiresAt = toNumber_(o.expires_at, 0);
  if (!expiresAt && o.expires_in && o.saved_at) {
    const saved = new Date(String(o.saved_at)).getTime();
    if (isFinite(saved)) expiresAt = saved + toNumber_(o.expires_in, 0) * 1000;
  }
  if (!expiresAt && payload.exp) expiresAt = toNumber_(payload.exp, 0) * 1000;
  if (!expiresAt) expiresAt = now; // 不知道就當已過期，第一次呼叫會先 refresh
  const idPayload = decodeJwtPayload_(o.id_token) || {};
  return {
    client_id: clientId,
    access_token: str('access_token'),
    refresh_token: str('refresh_token'),
    id_token: str('id_token'),
    expires_at: Math.floor(expiresAt),
    scopes,
    email: str('email') || String(idPayload.email || '').trim(),
    subject: str('subject') || String(idPayload.sub || payload.sub || '').trim(),
    ext_agent_host_id: str('ext_agent_host_id'),
    saved_at: str('saved_at') || new Date(now).toISOString(),
    refreshed_at: str('refreshed_at'),
    invalid: '',
  };
}

/**
 * access token 是否該先 refresh。純函式。
 * @param {ChatGptCredentials} creds
 * @param {number} now
 * @return {boolean}
 */
function chatgptNeedsRefresh_(creds, now) {
  return !creds.expires_at || creds.expires_at - now < CHATGPT_REFRESH_AHEAD_MS;
}

/**
 * refresh 請求（form-encoded；依官方文件省略 scope 以保留原授權）。純函式。
 * @param {ChatGptCredentials} creds
 * @return {{url: string, payload: string, headers: !Object}}
 */
function chatgptRefreshRequest_(creds) {
  const form = ['grant_type=refresh_token', 'client_id=' + encodeURIComponent(creds.client_id), 'refresh_token=' + encodeURIComponent(creds.refresh_token), 'resource=' + encodeURIComponent(CHATGPT_RESOURCE)];
  return { url: CHATGPT_TOKEN_URL, payload: form.join('&'), headers: { Accept: 'application/json' } };
}

/**
 * 把 token endpoint 的回應套進憑證（access / 滾動 refresh / id_token / 到期）。純函式，回新物件。
 * @param {ChatGptCredentials} creds
 * @param {!Object} json
 * @param {number} now
 * @return {ChatGptCredentials}
 * @throws {Error} 回應缺 access_token
 */
function chatgptApplyTokenResponse_(creds, json, now) {
  if (!json || !json.access_token) throw new Error('token 回應缺 access_token。');
  const payload = decodeJwtPayload_(json.access_token) || {};
  const expiresIn = toNumber_(json.expires_in, 0);
  const expiresAt = expiresIn ? now + expiresIn * 1000 : (payload.exp ? toNumber_(payload.exp, 0) * 1000 : now + 3600000);
  const scopes = json.scope ? String(json.scope).split(/\s+/).filter(Boolean) : creds.scopes;
  return Object.assign({}, creds, {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : creds.refresh_token,
    id_token: json.id_token ? String(json.id_token) : creds.id_token,
    expires_at: Math.floor(expiresAt),
    scopes,
    refreshed_at: new Date(now).toISOString(),
    invalid: '',
  });
}

/**
 * refresh 失敗的 error code（OAuth 的 error 欄或 Responses 風格 error.code）。純函式。
 * @param {?Object} json
 * @return {string}
 */
function chatgptErrorCode_(json) {
  if (!json) return '';
  if (typeof json.error === 'string') return json.error;
  if (json.error && json.error.code) return String(json.error.code);
  return '';
}

/**
 * 給 UI / Doctor 的憑證摘要（不含 token）。純函式。
 * @param {?ChatGptCredentials} creds
 * @param {number=} now
 * @return {?{email: string, subject: string, expiresAt: string, expiresInMin: number, refreshAgeDays: number, refreshExpiresAt: string, invalid: string, scopesOk: boolean, hostId: string}}
 */
function chatgptCredentialSummary_(creds, now) {
  if (!creds) return null;
  now = now || Date.now();
  const refreshBase = new Date(creds.refreshed_at || creds.saved_at || 0).getTime() || 0;
  return {
    email: creds.email || '', subject: creds.subject || '',
    expiresAt: creds.expires_at ? new Date(creds.expires_at).toISOString() : '', expiresInMin: creds.expires_at ? Math.round((creds.expires_at - now) / 60000) : 0,
    refreshAgeDays: refreshBase ? Math.round(((now - refreshBase) / 86400000) * 10) / 10 : 0,
    refreshExpiresAt: refreshBase ? new Date(refreshBase + CHATGPT_REFRESH_TOKEN_TTL_MS).toISOString() : '',
    invalid: creds.invalid || '', scopesOk: (creds.scopes || []).indexOf(CHATGPT_REQUIRED_SCOPE) !== -1, hostId: creds.ext_agent_host_id || '',
  };
}

// ---- 取 access token（含 refresh）--------------------------------------------------------------

/**
 * @typedef {{name: string, login: string, refreshRequest: function(Object): {url: string, payload: string, headers: !Object}, terminalErrors: !Array<string>}} OAuthSpec
 * 一種 OAuth 方案 provider 的差異處：name 給訊息用、login 是本機登入腳本、refreshRequest 組 refresh 請求、terminalErrors 是「要重新登入」的錯誤碼。
 */

/** @type {OAuthSpec} */
const CHATGPT_OAUTH_SPEC = Object.freeze({ name: 'ChatGPT', login: 'scripts/siwc-login.js', refreshRequest: chatgptRefreshRequest_, terminalErrors: CHATGPT_TERMINAL_REFRESH_ERRORS });

/**
 * 回可用的 access token；快到期就 refresh（LockService 序列化）。refresh 終端錯誤 → 標 invalid、通知 owner、throw（401，不 fallback 重試同一個）。
 * chatgpt 與 gemini_cli 共用（spec 決定 token endpoint 與錯誤碼；token 回應格式都是標準 OAuth）。
 * @param {Provider} provider
 * @param {{fetch: (Function|undefined), now: (Function|undefined), store: (Object|undefined), lock: (Object|undefined), notify: (Function|undefined)}=} deps
 *   store {get, set}；lock {waitLock(ms), releaseLock()}；notify(text) 通知 owner
 * @param {OAuthSpec=} spec 預設 chatgpt
 * @return {string}
 * @throws {Error} providerError_
 */
function oauthAccessToken_(provider, deps, spec) {
  deps = deps || {};
  spec = spec || CHATGPT_OAUTH_SPEC;
  const now = deps.now || (() => Date.now());
  const store = deps.store || chatgptPropStore_(provider.id);
  let creds = store.get();
  if (!creds) throw providerError_(provider, 0, `尚未登入 ${spec.name}：在本機執行 node ${spec.login}，把印出的憑證貼到管理頁「模型」→ 編輯 ${provider.id}。`);
  if (creds.invalid) throw providerError_(provider, 401, `${spec.name} 憑證已失效（${creds.invalid}）：請重新執行 ${spec.login} 並貼上新憑證。`);
  if (!chatgptNeedsRefresh_(creds, now())) return creds.access_token;

  const lock = deps.lock || (() => { try { return LockService.getScriptLock(); } catch (err) { return null; } })();
  let locked = false;
  if (lock) { try { lock.waitLock(20000); locked = true; } catch (err) { locked = false; } }
  try {
    if (locked) {
      // 等鎖期間可能已被別的執行 refresh 過
      creds = store.get() || creds;
      if (creds.invalid) throw providerError_(provider, 401, `${spec.name} 憑證已失效（${creds.invalid}）：請重新登入。`);
      if (!chatgptNeedsRefresh_(creds, now())) return creds.access_token;
    }
    const req = spec.refreshRequest(creds);
    const fetchFn = deps.fetch || defaultProviderFetch_;
    let res;
    try {
      res = fetchFn(req.url, { method: 'post', contentType: 'application/x-www-form-urlencoded', headers: req.headers, payload: req.payload, muteHttpExceptions: true });
    } catch (err) {
      throw providerError_(provider, 0, `refresh token 失敗（fetch）：${err && err.message || err}`);
    }
    const code = res.getResponseCode();
    const text = res.getContentText();
    let json = null;
    try { json = JSON.parse(text); } catch (err) { json = null; }
    if (code >= 200 && code < 300 && json && json.access_token) {
      const next = chatgptApplyTokenResponse_(creds, json, now());
      store.set(next);
      return next.access_token;
    }
    const errCode = chatgptErrorCode_(json);
    if (spec.terminalErrors.indexOf(errCode) !== -1 || code === 400 || code === 401) {
      store.set(Object.assign({}, creds, { invalid: errCode || ('http_' + code) }));
      const msg = `${spec.name} 憑證失效（${errCode || 'HTTP ' + code}），provider ${provider.id} 已停用，請重新執行 ${spec.login} 並到管理頁貼上新憑證。`;
      try { (deps.notify || telegramNotifyOwner_)(`⚠️ ${msg}`); } catch (err) { /* 忽略 */ }
      securityAudit_('provider:oauth_invalid', `${provider.id}：${errCode || 'HTTP ' + code}`);
      throw providerError_(provider, 401, msg);
    }
    throw providerError_(provider, code, `refresh token 失敗：${extractApiError_(json, text)}`);
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (err) { /* 忽略 */ } }
  }
}

/**
 * chatgpt 的 access token（oauthAccessToken_ 的 chatgpt 殼）。
 * @param {Provider} provider
 * @param {Object=} deps 同 oauthAccessToken_
 * @return {string}
 */
function chatgptAccessToken_(provider, deps) { return oauthAccessToken_(provider, deps, CHATGPT_OAUTH_SPEC); }

// ---- Adapter：Responses API ------------------------------------------------------------------

/**
 * 中立訊息 → Responses `input` 項目 + `instructions`。純函式。
 * system → instructions；user → message；assistant 文字 → output_text message；assistant tool_calls → function_call；tool → function_call_output。
 * @param {!Array<!Object>} messages
 * @return {{instructions: string, input: !Array<!Object>}}
 */
function chatgptInputItems_(messages) {
  const systems = [];
  const input = [];
  (messages || []).forEach((m) => {
    if (m.role === 'system') { const t = stringifyContent_(m.content); if (t) systems.push(t); return; }
    if (m.role === 'user') { input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: stringifyContent_(m.content) }] }); return; }
    if (m.role === 'assistant') {
      const text = stringifyContent_(m.content);
      if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      (m.tool_calls || []).forEach((tc) => {
        input.push({ type: 'function_call', call_id: String(tc.id || ''), name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments || {}) });
      });
      return;
    }
    if (m.role === 'tool') input.push({ type: 'function_call_output', call_id: String(m.tool_call_id || ''), output: stringifyContent_(m.content) });
  });
  return { instructions: systems.join('\n\n'), input };
}

/**
 * @param {Provider} provider
 * @param {ChatRequest} req
 * @param {string} accessToken
 * @return {{url: string, headers: !Object, body: !Object}}
 */
function chatgptBuildRequest_(provider, req, accessToken) {
  const items = chatgptInputItems_(req.messages);
  const body = { model: req.model || provider.model, input: items.input, store: false, stream: true };
  if (items.instructions) body.instructions = items.instructions;
  if (req.tools && req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description || '', parameters: toolParameters_(t), strict: false }));
    body.tool_choice = 'auto';
  }
  applyExtraBody_(body, provider.extra_body);
  CHATGPT_UNSUPPORTED_BODY_FIELDS.forEach((k) => { delete body[k]; });
  body.store = false;
  body.stream = true;
  return {
    url: joinUrl_(provider.base_url || CHATGPT_DEFAULT_BASE_URL, '/responses'),
    headers: Object.assign({ Authorization: 'Bearer ' + accessToken, Accept: 'text/event-stream' }, provider.extra_headers),
    body,
  };
}

/**
 * 解析 SSE 文字成事件陣列。純函式。
 * @param {string} text
 * @return {!Array<{event: string, data: *}>} data 能 JSON 就解析，否則原字串
 */
function parseSse_(text) {
  const out = [];
  String(text || '').split(/\r?\n\r?\n/).forEach((chunk) => {
    let event = '';
    const dataLines = [];
    chunk.split(/\r?\n/).forEach((line) => {
      if (line.indexOf('event:') === 0) event = line.slice(6).trim();
      else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^ /, ''));
    });
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    if (raw.trim() === '[DONE]') return;
    let data = raw;
    try { data = JSON.parse(raw); } catch (err) { data = raw; }
    out.push({ event, data });
  });
  return out;
}

/**
 * 從整段 SSE 取最終的 response 物件：response.completed / response.incomplete 的 response；response.failed 或純 JSON 錯誤就 throw（帶 status / code）。純函式。
 * @param {string} text
 * @return {!Object} response
 * @throws {Error} err.status / err.code
 */
function chatgptFinalFromSse_(text) {
  const events = parseSse_(text);
  let final = null;
  let failed = null;
  events.forEach((e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    const type = d.type || e.event;
    if (type === 'response.completed' || type === 'response.incomplete') final = d.response || final;
    else if (type === 'response.failed') failed = d.response || d;
    else if (type === 'error') failed = { error: d.error || d };
  });
  if (failed) {
    const errObj = (failed.error) || {};
    const code = String(errObj.code || errObj.type || 'response_failed');
    const err = new Error(`${errObj.message || code}${CHATGPT_ERROR_HINT[code] ? '；' + CHATGPT_ERROR_HINT[code] : ''}`);
    err.code = code;
    err.status = CHATGPT_ERROR_STATUS[code] || 500;
    throw err;
  }
  if (final) return final;
  // 不是 SSE：可能是純 JSON（錯誤或非串流回應）
  let json = null;
  try { json = JSON.parse(String(text || '')); } catch (err) { json = null; }
  if (json && json.object === 'response' && Array.isArray(json.output)) return json;
  if (json) {
    const code = chatgptErrorCode_(json);
    const err = new Error(extractApiError_(json, text) + (CHATGPT_ERROR_HINT[code] ? '；' + CHATGPT_ERROR_HINT[code] : ''));
    err.code = code;
    err.status = CHATGPT_ERROR_STATUS[code] || 500;
    throw err;
  }
  const err = new Error('串流沒有 response.completed：' + String(text || '').slice(0, 200));
  err.status = 502;
  throw err;
}

/**
 * Responses 最終物件 → ChatResult。純函式。
 * @param {!Object} response
 * @return {ChatResult}
 */
function chatgptParseResponse_(response) {
  const texts = [];
  const toolCalls = [];
  (response.output || []).forEach((item, i) => {
    if (item.type === 'message') {
      (item.content || []).forEach((c) => { if (c.type === 'output_text' && c.text) texts.push(c.text); });
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: String(item.call_id || item.id || ('call_' + (i + 1))), name: String(item.name || ''), args: parseJsonArgs_(item.arguments) });
    }
  });
  const usage = response.usage || {};
  const stop = toolCalls.length ? 'tool_calls' : response.status === 'incomplete' ? 'length' : response.status === 'completed' ? 'end' : 'other';
  return { text: texts.join(''), toolCalls, usage: { prompt: toNumber_(usage.input_tokens, 0), completion: toNumber_(usage.output_tokens, 0) }, stop, raw: response };
}

// ---- 模型清單 / 登出 -------------------------------------------------------------------------------

/**
 * 這個 ChatGPT 帳號可用的模型（GET /models，取 visibility=list）。
 * @param {Provider} provider
 * @param {{fetch: (Function|undefined), token: (string|undefined)}=} deps
 * @return {!Array<{slug: string, display_name: string}>}
 */
function chatgptListModels_(provider, deps) {
  deps = deps || {};
  const token = deps.token !== undefined ? deps.token : chatgptAccessToken_(provider, deps);
  const fetchFn = deps.fetch || defaultProviderFetch_;
  const res = fetchFn(joinUrl_(provider.base_url || CHATGPT_DEFAULT_BASE_URL, '/models'), { method: 'get', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  const code = res.getResponseCode();
  const text = res.getContentText();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  if (code < 200 || code >= 300) throw providerError_(provider, code, extractApiError_(json, text));
  return chatgptParseModels_(json);
}

/**
 * 模型清單回應 → [{slug, display_name}]（SIWC 的 models[]，或標準 data[]）。純函式。
 * @param {?Object} json
 * @return {!Array<{slug: string, display_name: string}>}
 */
function chatgptParseModels_(json) {
  if (!json) return [];
  if (Array.isArray(json.models)) {
    return json.models.filter((m) => !m.visibility || m.visibility === 'list').map((m) => ({ slug: String(m.slug || m.id || ''), display_name: String(m.display_name || m.slug || m.id || '') })).filter((m) => m.slug);
  }
  if (Array.isArray(json.data)) return json.data.map((m) => ({ slug: String(m.id || ''), display_name: String(m.id || '') })).filter((m) => m.slug);
  return [];
}

/**
 * 登出：撤銷 refresh token（revocation_endpoint；拿不到就用備援網址），然後清掉憑證。撤銷失敗仍清憑證並回 revoked=false。
 * @param {Provider} provider
 * @param {{fetch: (Function|undefined), store: (Object|undefined)}=} deps
 * @return {{revoked: boolean, cleared: boolean, error: string}}
 */
function chatgptRevoke_(provider, deps) {
  deps = deps || {};
  const store = deps.store || chatgptPropStore_(provider.id);
  const creds = store.get();
  const out = { revoked: false, cleared: false, error: '' };
  if (creds && creds.refresh_token) {
    const fetchFn = deps.fetch || defaultProviderFetch_;
    let endpoint = CHATGPT_REVOKE_URL_FALLBACK;
    try {
      const cfg = JSON.parse(fetchFn(CHATGPT_OIDC_CONFIG_URL, { method: 'get', muteHttpExceptions: true }).getContentText());
      if (cfg && cfg.revocation_endpoint) endpoint = String(cfg.revocation_endpoint);
    } catch (err) { /* 用備援 */ }
    try {
      const res = fetchFn(endpoint, { method: 'post', contentType: 'application/x-www-form-urlencoded', payload: `token=${encodeURIComponent(creds.refresh_token)}&token_type_hint=refresh_token&client_id=${encodeURIComponent(creds.client_id)}`, muteHttpExceptions: true });
      out.revoked = res.getResponseCode() >= 200 && res.getResponseCode() < 300;
      if (!out.revoked) out.error = `撤銷回 HTTP ${res.getResponseCode()}`;
    } catch (err) {
      out.error = String(err && err.message || err);
    }
  }
  store.set(null);
  out.cleared = true;
  return out;
}

/**
 * provider 的憑證是否存在且可用（Doctor / 管理頁 / 備援鏈用）。
 * @param {Provider} p
 * @return {boolean}
 */
function providerHasCredential_(p) {
  if (isOAuthProtocol_(p.protocol)) { const c = getProviderOAuth_(p.id); return !!(c && !c.invalid); }
  return !!getProviderKey_(p.id);
}
