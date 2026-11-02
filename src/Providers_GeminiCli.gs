/**
 * @fileoverview protocol `gemini_cli`（M7）：用 owner 的 **Google 帳號**（Gemini CLI 的「Login with Google」方案額度）打
 * Gemini CLI 走的 Code Assist API（https://cloudcode-pa.googleapis.com/v1internal），不用 Gemini API key。
 * 參考實作：github.com/google-gemini/gemini-cli packages/core/src/code_assist/{oauth2,server,setup,converter}.ts。
 *
 * 流程：
 *   1. 登入在本機做（Google OAuth 回呼只能到 127.0.0.1）：`node scripts/gemini-login.js --account <代號>` 用 Gemini CLI 的
 *      OAuth client（安裝型 app 的公開 client id / secret，寫死在它的原始碼裡）跑授權碼流程、換 token、取 email，
 *      順便呼叫 loadCodeAssist / onboardUser 拿到這個帳號的 Code Assist 專案（free tier 是 Google 代管的專案），印出憑證 JSON。
 *      已經裝了 Gemini CLI 的人也可 `--from-cli` 直接沿用 ~/.gemini/oauth_creds.json。
 *   2. 管理頁「模型」新增 protocol=gemini_cli 的 provider，貼上那段 JSON → parseGeminiCliCredentials_ 驗證後存
 *      Script Property `PROVIDER_OAUTH_<id>`（與 chatgpt 共用同一個鍵名規則）。
 *   3. 每次呼叫前 geminiCliAuth_：access token（1 小時）快到期就用 refresh token 向 https://oauth2.googleapis.com/token 換新
 *      （oauthAccessToken_，與 chatgpt 共用：LockService 序列化、終端錯誤標 invalid 推 Telegram）；憑證裡沒有 project_id 就先
 *      loadCodeAssist →（必要時）onboardUser + 輪詢 LRO，把 project_id / tier 寫回憑證。
 *   4. 請求：`POST {endpoint}/v1internal:generateContent`，body `{model, project, user_prompt_id, request: <標準 Gemini generateContent body>}`；
 *      回應 `{response: <標準 generateContent 回應>}` → 直接沿用 geminiBuildRequest_ / geminiParseResponse_。不走串流（GAS 沒有串流）。
 *
 * 條款：Gemini Code Assist 的個人方案（免費版）條款允許個人使用；用它的 OAuth client 從別的程式打 API 屬灰色地帶（Google 沒公開
 * 這條 API）。owner 2026-11-03 知情後決定自用；所以這個 protocol 一樣只服務 principal=owner，每個 Google 帳號各自登入、憑證不互用。
 * 純函式（parse / build / 判斷）與打網路的部分分開，測試注入 fetch / store / lock / now / sleep。
 */

/** Gemini CLI 的 OAuth client（安裝型 app，公開在原始碼 oauth2.ts）。 */
const GEMINI_CLI_CLIENT_ID = '<gemini cli client id removed>.apps.googleusercontent.com';
const GEMINI_CLI_CLIENT_SECRET = 'GOCSPX-<gemini cli client secret removed>';
/** Google OAuth token / 撤銷端點。 */
const GEMINI_CLI_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GEMINI_CLI_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** Code Assist API。 */
const GEMINI_CLI_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const GEMINI_CLI_API_VERSION = 'v1internal';
/** 打 Code Assist 必須有的 scope。 */
const GEMINI_CLI_REQUIRED_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** refresh 回這些 error = 要重新登入。 */
const GEMINI_CLI_TERMINAL_REFRESH_ERRORS = Object.freeze(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_rapt']);
/** onboardUser 的 LRO 輪詢：每 5 秒、最多 8 次（GAS 單次執行上限 6 分鐘，留餘裕）。 */
const GEMINI_CLI_LRO_POLL_MS = 5000;
const GEMINI_CLI_LRO_MAX_POLLS = 8;
/** 送給 Code Assist 的 client metadata（照 Gemini CLI）。 */
const GEMINI_CLI_METADATA = Object.freeze({ ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' });
/** tier id。 */
const GEMINI_CLI_TIER_FREE = 'free-tier';
const GEMINI_CLI_TIER_LEGACY = 'legacy-tier';
/**
 * Code Assist 沒有「列模型」API；這是 Gemini CLI 原始碼（config/models.ts）列的模型名，給管理頁「可用模型」一鍵設定用。
 * 哪些真的能用取決於帳號的 tier；測試連線不過就換一個。
 */
const GEMINI_CLI_KNOWN_MODELS = Object.freeze([
  { slug: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro（CLI 預設）' },
  { slug: 'gemini-2.5-flash', display_name: 'Gemini 2.5 Flash' },
  { slug: 'gemini-2.5-flash-lite', display_name: 'Gemini 2.5 Flash Lite' },
  { slug: 'gemini-3-pro-preview', display_name: 'Gemini 3 Pro Preview' },
  { slug: 'gemini-3-flash-preview', display_name: 'Gemini 3 Flash Preview' },
  { slug: 'gemini-3.1-pro-preview', display_name: 'Gemini 3.1 Pro Preview' },
  { slug: 'gemini-3.1-flash-lite', display_name: 'Gemini 3.1 Flash Lite' },
]);

/**
 * @typedef {{
 *   client_id: string, client_secret: string, access_token: string, refresh_token: string, id_token: string, expires_at: number, scopes: !Array<string>,
 *   email: string, subject: string, project_id: string, project_hint: string, tier: string, saved_at: string, refreshed_at: string, invalid: string
 * }} GeminiCliCredentials
 * project_id：Code Assist 的 cloudaicompanionProject（登入腳本已解析，或第一次呼叫時由 loadCodeAssist / onboardUser 取得並寫回）；
 * project_hint：使用者指定的 GCP 專案（Standard / Enterprise 方案才需要；gemini-login.js --project）。
 */

// ---- 純函式：憑證解析 ------------------------------------------------------------------------------

/**
 * 把 scripts/gemini-login.js 印出的憑證、或 Gemini CLI 的 ~/.gemini/oauth_creds.json（google-auth-library Credentials：
 * access_token / refresh_token / scope / id_token / expiry_date）驗證並正規化成 GeminiCliCredentials。純函式。
 * @param {*} input JSON 字串或 object
 * @param {number=} now
 * @return {GeminiCliCredentials}
 * @throws {Error}
 */
function parseGeminiCliCredentials_(input, now) {
  now = now || Date.now();
  let o = input;
  if (typeof o === 'string') {
    const s = o.trim();
    if (!s) throw new Error('請貼上 scripts/gemini-login.js 印出的憑證 JSON（或 ~/.gemini/oauth_creds.json 的內容）。');
    try { o = JSON.parse(s); } catch (err) { throw new Error('憑證不是合法 JSON：請整段複製 scripts/gemini-login.js 的輸出。'); }
  }
  if (!o || typeof o !== 'object') throw new Error('憑證必須是 JSON object。');
  const str = (k) => (o[k] === null || o[k] === undefined ? '' : String(o[k]).trim());
  if (!str('access_token')) throw new Error('憑證缺 access_token。');
  if (!str('refresh_token')) throw new Error('憑證缺 refresh_token（登入時要 access_type=offline 且同意畫面要重新授權一次；重跑 gemini-login.js）。');
  let scopes = Array.isArray(o.scopes) ? o.scopes.map(String) : String(str('scope')).split(/\s+/).filter(Boolean);
  scopes = scopes.map((x) => x.trim()).filter((x, i, a) => x && a.indexOf(x) === i);
  if (scopes.length && scopes.indexOf(GEMINI_CLI_REQUIRED_SCOPE) === -1) throw new Error(`憑證沒有 ${GEMINI_CLI_REQUIRED_SCOPE} scope：這不是 Gemini CLI 的登入憑證。`);
  let expiresAt = toNumber_(o.expires_at, 0) || toNumber_(o.expiry_date, 0);
  if (!expiresAt && o.expires_in && o.saved_at) {
    const saved = new Date(String(o.saved_at)).getTime();
    if (isFinite(saved)) expiresAt = saved + toNumber_(o.expires_in, 0) * 1000;
  }
  if (!expiresAt) expiresAt = now; // 不知道就當已過期，第一次呼叫會先 refresh
  const idPayload = decodeJwtPayload_(o.id_token) || {};
  const projectId = str('project_id') || str('cloudaicompanionProject');
  if (/^\d+$/.test(projectId)) throw new Error(`project_id「${projectId}」是專案編號（數字），要用專案 ID（字串，例如 my-project-123）。`);
  return {
    client_id: str('client_id') || GEMINI_CLI_CLIENT_ID,
    client_secret: str('client_secret') || GEMINI_CLI_CLIENT_SECRET,
    access_token: str('access_token'),
    refresh_token: str('refresh_token'),
    id_token: str('id_token'),
    expires_at: Math.floor(expiresAt),
    scopes: scopes.length ? scopes : [GEMINI_CLI_REQUIRED_SCOPE],
    email: str('email') || String(idPayload.email || '').trim(),
    subject: str('subject') || String(idPayload.sub || '').trim(),
    project_id: projectId,
    project_hint: str('project_hint'),
    tier: str('tier'),
    saved_at: str('saved_at') || new Date(now).toISOString(),
    refreshed_at: str('refreshed_at'),
    invalid: '',
  };
}

/**
 * Google token endpoint 的 refresh 請求（安裝型 app 要帶 client_secret）。純函式。
 * @param {GeminiCliCredentials} creds
 * @return {{url: string, payload: string, headers: !Object}}
 */
function geminiCliRefreshRequest_(creds) {
  const form = ['grant_type=refresh_token', 'client_id=' + encodeURIComponent(creds.client_id || GEMINI_CLI_CLIENT_ID), 'client_secret=' + encodeURIComponent(creds.client_secret || GEMINI_CLI_CLIENT_SECRET), 'refresh_token=' + encodeURIComponent(creds.refresh_token)];
  return { url: GEMINI_CLI_TOKEN_URL, payload: form.join('&'), headers: { Accept: 'application/json' } };
}

/** @type {OAuthSpec} */
const GEMINI_CLI_OAUTH_SPEC = Object.freeze({ name: 'Gemini CLI（Google 帳號）', login: 'scripts/gemini-login.js', refreshRequest: geminiCliRefreshRequest_, terminalErrors: GEMINI_CLI_TERMINAL_REFRESH_ERRORS });

/**
 * gemini_cli 的 access token（會自動 refresh）。
 * @param {Provider} provider
 * @param {Object=} deps 同 oauthAccessToken_
 * @return {string}
 */
function geminiCliAccessToken_(provider, deps) { return oauthAccessToken_(provider, deps, GEMINI_CLI_OAUTH_SPEC); }

/**
 * 給 UI / Doctor 的憑證摘要（不含 token）。純函式。
 * @param {?GeminiCliCredentials} creds
 * @param {number=} now
 * @return {?Object} chatgptCredentialSummary_ 的欄位 + projectId / tier；scopesOk 改看 cloud-platform；Google refresh token 不會 30 天到期，refreshExpiresAt 留空
 */
function geminiCliCredentialSummary_(creds, now) {
  const s = chatgptCredentialSummary_(creds, now);
  if (!s) return null;
  s.scopesOk = (creds.scopes || []).indexOf(GEMINI_CLI_REQUIRED_SCOPE) !== -1;
  s.refreshExpiresAt = '';
  s.projectId = creds.project_id || '';
  s.tier = creds.tier || '';
  return s;
}

// ---- Code Assist：loadCodeAssist / onboardUser --------------------------------------------------------

/**
 * @param {Provider} provider
 * @return {string} 不含結尾斜線的 endpoint
 */
function geminiCliEndpoint_(provider) {
  return String(provider.base_url || GEMINI_CLI_ENDPOINT).replace(/\/+$/, '');
}

/**
 * @param {Provider} provider
 * @param {string} method loadCodeAssist / onboardUser / generateContent…
 * @return {string}
 */
function geminiCliMethodUrl_(provider, method) {
  return `${geminiCliEndpoint_(provider)}/${GEMINI_CLI_API_VERSION}:${method}`;
}

/**
 * 打 Code Assist 的一個 method（POST JSON）或取 LRO（GET）。非 2xx throw providerError_。
 * @param {Provider} provider
 * @param {string} token
 * @param {string} urlOrMethod method 名（POST）或完整網址（GET，body 為 null）
 * @param {?Object} body
 * @param {Function=} fetchFn
 * @return {!Object}
 */
function geminiCliRpc_(provider, token, urlOrMethod, body, fetchFn) {
  fetchFn = fetchFn || defaultProviderFetch_;
  const url = /^https?:\/\//.test(urlOrMethod) ? urlOrMethod : geminiCliMethodUrl_(provider, urlOrMethod);
  const options = { method: body ? 'post' : 'get', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
  if (body) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
  let res;
  try { res = fetchFn(url, options); } catch (err) { throw providerError_(provider, 0, `Code Assist ${urlOrMethod} fetch 失敗：${err && err.message || err}`); }
  const code = res.getResponseCode();
  const text = res.getContentText();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  if (code < 200 || code >= 300) throw providerError_(provider, code, `Code Assist ${urlOrMethod.replace(/^https?:\/\/[^/]+\//, '')}：${extractApiError_(json, text)}`);
  return json || {};
}

/**
 * loadCodeAssist 回應 → 已就緒的 {project, tier}，或 null（還沒 onboard）。純函式。
 * 照 setup.ts：currentTier 存在 = 已 onboard，專案用 cloudaicompanionProject（沒有就用使用者給的 projectHint，再沒有就依 ineligibleTiers 報錯）。
 * @param {!Object} loadRes
 * @param {string} projectHint 憑證裡使用者指定的 project_id（可空）
 * @return {?{project: string, tier: string}}
 * @throws {Error} 已 onboard 但沒有專案可用
 */
function geminiCliProjectFromLoad_(loadRes, projectHint) {
  if (!loadRes || !loadRes.currentTier) return null;
  const tier = String((loadRes.paidTier && loadRes.paidTier.id) || loadRes.currentTier.id || 'standard-tier');
  const project = String(loadRes.cloudaicompanionProject || projectHint || '');
  if (!project) throw new Error(geminiCliIneligibleMessage_(loadRes));
  return { project, tier };
}

/**
 * onboardUser 的 body。純函式。free-tier 不能帶專案（會 Precondition Failed）；其他 tier 帶使用者指定的專案。
 * @param {!Object} loadRes
 * @param {string} projectHint
 * @return {{tierId: string, body: !Object}}
 */
function geminiCliOnboardRequest_(loadRes, projectHint) {
  const def = ((loadRes && loadRes.allowedTiers) || []).find((t) => t && t.isDefault);
  const tierId = String((def && def.id) || GEMINI_CLI_TIER_LEGACY);
  const metadata = Object.assign({}, GEMINI_CLI_METADATA);
  const body = { tierId, metadata };
  if (tierId !== GEMINI_CLI_TIER_FREE && projectHint) { body.cloudaicompanionProject = projectHint; metadata.duetProject = projectHint; }
  return { tierId, body };
}

/**
 * 沒有專案可用時的說明（ineligibleTiers 的理由；沒有就是要自己設 GCP 專案）。純函式。
 * @param {!Object} loadRes
 * @return {string}
 */
function geminiCliIneligibleMessage_(loadRes) {
  const tiers = (loadRes && loadRes.ineligibleTiers) || [];
  if (tiers.length) {
    return '這個 Google 帳號不能用 Gemini CLI 的免費方案：' + tiers.map((t) => `${t.tierName || t.tierId || '?'}：${t.reasonMessage || t.reasonCode || ''}${t.validationUrl ? '（請先到 ' + t.validationUrl + ' 完成驗證）' : ''}`).join('；');
  }
  return '這個 Google 帳號需要指定 Google Cloud 專案（Gemini Code Assist Standard / Enterprise）：重跑 scripts/gemini-login.js --project <專案 ID> 再貼憑證。';
}

/**
 * 確保憑證裡有 Code Assist 專案：loadCodeAssist →（必要時）onboardUser + 輪詢 LRO，寫回 store。
 * @param {Provider} provider
 * @param {string} token
 * @param {{fetch: (Function|undefined), store: (Object|undefined), sleep: (Function|undefined)}=} deps
 * @return {{project: string, tier: string}}
 * @throws {Error} providerError_
 */
function geminiCliSetup_(provider, token, deps) {
  deps = deps || {};
  const store = deps.store || chatgptPropStore_(provider.id);
  const creds = store.get() || {};
  if (creds.project_id) return { project: creds.project_id, tier: creds.tier || '' };
  const hint = String(creds.project_hint || '');
  const sleep = deps.sleep || ((ms) => Utilities.sleep(ms));
  const loadBody = { metadata: Object.assign({}, GEMINI_CLI_METADATA) };
  if (hint) { loadBody.cloudaicompanionProject = hint; loadBody.metadata.duetProject = hint; }
  const loadRes = geminiCliRpc_(provider, token, 'loadCodeAssist', loadBody, deps.fetch);
  let ready;
  try { ready = geminiCliProjectFromLoad_(loadRes, hint); } catch (err) { throw providerError_(provider, 403, err.message); }
  if (!ready) {
    const onboard = geminiCliOnboardRequest_(loadRes, hint);
    let lro = geminiCliRpc_(provider, token, 'onboardUser', onboard.body, deps.fetch);
    let polls = 0;
    while (!lro.done && lro.name && polls < GEMINI_CLI_LRO_MAX_POLLS) {
      sleep(GEMINI_CLI_LRO_POLL_MS);
      lro = geminiCliRpc_(provider, token, `${geminiCliEndpoint_(provider)}/${GEMINI_CLI_API_VERSION}/${lro.name}`, null, deps.fetch);
      polls++;
    }
    if (!lro.done) throw providerError_(provider, 503, 'Code Assist 開通（onboardUser）還在進行中，請稍後再試一次。');
    const project = String((lro.response && lro.response.cloudaicompanionProject && lro.response.cloudaicompanionProject.id) || hint || '');
    if (!project) throw providerError_(provider, 403, geminiCliIneligibleMessage_(loadRes));
    ready = { project, tier: onboard.tierId };
  }
  store.set(Object.assign({}, store.get() || creds, { project_id: ready.project, tier: ready.tier }));
  return ready;
}

/**
 * 這次呼叫要用的 {token, project}：token 會自動 refresh；project 沒有就先開通。
 * @param {Provider} provider
 * @param {{fetch: (Function|undefined), store: (Object|undefined), lock: (Object|undefined), now: (Function|undefined), sleep: (Function|undefined)}=} deps
 * @return {{token: string, project: string}}
 */
function geminiCliAuth_(provider, deps) {
  deps = deps || {};
  const token = geminiCliAccessToken_(provider, deps);
  const store = deps.store || chatgptPropStore_(provider.id);
  const creds = store.get() || {};
  const project = creds.project_id || geminiCliSetup_(provider, token, { fetch: deps.fetch, store, sleep: deps.sleep }).project;
  return { token, project };
}

// ---- Adapter：Code Assist generateContent（包一層標準 Gemini body）-------------------------------------------

/**
 * @param {Provider} provider
 * @param {ChatRequest} req
 * @param {{token: string, project: string}|string} auth geminiCliAuth_ 的結果（測試可直接給 token 字串，project 為空）
 * @return {{url: string, headers: !Object, body: !Object}}
 */
function geminiCliBuildRequest_(provider, req, auth) {
  const token = typeof auth === 'string' ? auth : String(auth && auth.token || '');
  const project = typeof auth === 'string' ? '' : String(auth && auth.project || '');
  // 內層就是標準 generateContent body（contents / systemInstruction / tools / generationConfig；extra_body 也套在內層）
  const inner = geminiBuildRequest_(Object.assign({}, provider, { base_url: 'https://generativelanguage.googleapis.com' }), req, '');
  const model = req.model || provider.model;
  const body = { model, project, user_prompt_id: geminiCliPromptId_(req), request: inner.body };
  if (req.sessionId) body.request.session_id = String(req.sessionId);
  return {
    url: geminiCliMethodUrl_(provider, 'generateContent'),
    headers: Object.assign({ Authorization: 'Bearer ' + token }, provider.extra_headers),
    body,
  };
}

/**
 * user_prompt_id（Code Assist 要一個識別這輪的字串）。
 * @param {ChatRequest} req
 * @return {string}
 */
function geminiCliPromptId_(req) {
  let rand;
  try { rand = Utilities.getUuid(); } catch (err) { rand = Math.random().toString(36).slice(2) + Date.now().toString(36); }
  return (req && req.sessionId ? String(req.sessionId) + '-' : '') + rand;
}

/**
 * Code Assist 回應 `{response: <generateContent 回應>, traceId}` → ChatResult。純函式。
 * @param {!Object} json
 * @return {ChatResult}
 */
function geminiCliParseResponse_(json) {
  const inner = json && json.response && typeof json.response === 'object' ? json.response : json;
  const result = geminiParseResponse_(inner || {});
  result.raw = json;
  return result;
}

// ---- 模型清單 / 登出 ---------------------------------------------------------------------------------------

/**
 * 「可用模型」：Code Assist 沒有列模型 API，回 Gemini CLI 原始碼列的模型名。
 * @return {!Array<{slug: string, display_name: string}>}
 */
function geminiCliListModels_() {
  return GEMINI_CLI_KNOWN_MODELS.map((m) => Object.assign({}, m));
}

/**
 * 登出：向 Google 撤銷 refresh token，然後清掉憑證。撤銷失敗仍清憑證並回 revoked=false。
 * @param {Provider} provider
 * @param {{fetch: (Function|undefined), store: (Object|undefined)}=} deps
 * @return {{revoked: boolean, cleared: boolean, error: string}}
 */
function geminiCliRevoke_(provider, deps) {
  deps = deps || {};
  const store = deps.store || chatgptPropStore_(provider.id);
  const creds = store.get();
  const out = { revoked: false, cleared: false, error: '' };
  if (creds && creds.refresh_token) {
    const fetchFn = deps.fetch || defaultProviderFetch_;
    try {
      const res = fetchFn(GEMINI_CLI_REVOKE_URL, { method: 'post', contentType: 'application/x-www-form-urlencoded', payload: `token=${encodeURIComponent(creds.refresh_token)}`, muteHttpExceptions: true });
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

// ---- 兩種 OAuth 協定的分派（Admin / Doctor / publicProvider_ 用）------------------------------------------------

/**
 * @param {string} protocol
 * @return {boolean} 這個協定用 OAuth 憑證（PROVIDER_OAUTH_<id>）而不是 API key
 */
function isOAuthProtocol_(protocol) { return OAUTH_PROTOCOLS.indexOf(protocol) !== -1; }

/**
 * 依協定解析貼上的憑證。
 * @param {string} protocol
 * @param {*} input
 * @return {!Object}
 */
function parseOAuthCredentials_(protocol, input) {
  if (protocol === 'gemini_cli') return parseGeminiCliCredentials_(input);
  return parseChatGptCredentials_(input);
}

/**
 * 依協定做憑證摘要（不含 token）。
 * @param {Provider} p
 * @param {?Object} creds
 * @return {?Object}
 */
function oauthCredentialSummary_(p, creds) {
  return p.protocol === 'gemini_cli' ? geminiCliCredentialSummary_(creds) : chatgptCredentialSummary_(creds);
}

/**
 * 依協定登出（撤銷 + 清憑證）。
 * @param {Provider} p
 * @return {{revoked: boolean, cleared: boolean, error: string}}
 */
function oauthRevoke_(p) {
  return p.protocol === 'gemini_cli' ? geminiCliRevoke_(p) : chatgptRevoke_(p);
}

/**
 * 依協定列可用模型。
 * @param {Provider} p
 * @return {!Array<{slug: string, display_name: string}>}
 */
function oauthListModels_(p) {
  return p.protocol === 'gemini_cli' ? geminiCliListModels_() : chatgptListModels_(p);
}

/**
 * 依協定的本機登入腳本名（訊息用）。
 * @param {string} protocol
 * @return {string}
 */
function oauthLoginScript_(protocol) {
  return protocol === 'gemini_cli' ? GEMINI_CLI_OAUTH_SPEC.login : CHATGPT_OAUTH_SPEC.login;
}
