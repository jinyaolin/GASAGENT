/**
 * @fileoverview protocol `gemini_cli`（M7）：用 owner 的 **Google 帳號**方案額度打 Google 的 Code Assist API（`/v1internal`），不用 Gemini API key。
 * 兩種 client（憑證的 `client` 欄位決定）：
 *   - `antigravity`（預設）：Antigravity（Google 的 agentic IDE / `agy` CLI）的 OAuth client，打 https://daily-cloudcode-pa.googleapis.com。
 *     個人 Google 帳號（免費 / AI Pro / Ultra）現在只有這條能走；模型含 Gemini 與 Claude（claude-sonnet-4-6 等）。
 *     參考：github.com/NoeFabris/opencode-antigravity-auth（constants / project / request）、github.com/s1eepwalker/antigravity-proxy。
 *   - `gemini_cli`：Gemini CLI 的 OAuth client，打 https://cloudcode-pa.googleapis.com。Google 2026-06-18 起不再服務個人帳號
 *     （「This client is no longer supported for Gemini Code Assist for individuals」），只剩 Gemini Code Assist Standard / Enterprise
 *     授權（公司 GCP 專案）能用。參考：github.com/google-gemini/gemini-cli packages/core/src/code_assist/*.ts。
 *
 * 流程：
 *   1. 登入在本機做（Google OAuth 回呼只能到 loopback）：`node scripts/gemini-login.js --account <代號>`（預設 antigravity；
 *      `--client gemini-cli` 走舊 client）跑授權碼 + PKCE、換 token、取 email，呼叫 loadCodeAssist /（必要時）onboardUser 拿到
 *      Code Assist 專案（個人方案是 Google 代管的專案），印出憑證 JSON。
 *   2. 管理頁「模型」新增 protocol=gemini_cli 的 provider，貼上那段 JSON → parseGeminiCliCredentials_ 驗證後存
 *      Script Property `PROVIDER_OAUTH_<id>`（與 chatgpt 共用同一個鍵名規則）。
 *   3. 每次呼叫前 geminiCliAuth_：access token（1 小時）快到期就用 refresh token 向 https://oauth2.googleapis.com/token 換新
 *      （oauthAccessToken_，與 chatgpt 共用：LockService 序列化、終端錯誤標 invalid 推 Telegram）；憑證裡沒有 project_id 就先
 *      loadCodeAssist →（必要時）onboardUser，把 project_id / tier 寫回憑證。
 *   4. 請求：`POST {endpoint}/v1internal:generateContent`，body `{model, project, request: <標準 Gemini generateContent body>}`
 *      （antigravity 再加 requestType:'agent'、userAgent:'antigravity'、requestId）；回應 `{response: <標準 generateContent 回應>}`
 *      → 直接沿用 geminiBuildRequest_ / geminiParseResponse_。不走串流（GAS 沒有串流）。
 *
 * 已知限制：GAS 的 UrlFetchApp 不能改 User-Agent（固定 Google-Apps-Script），Antigravity 後端用 Hub 的 User-Agent 版本決定
 * 要不要給**最新**模型；舊一點的模型名（gemini-2.5-*、gemini-3-flash、claude-sonnet-4-6）比較穩，測試連線不過就換一個。
 *
 * 條款：這兩條 API 與 OAuth client 都沒公開給第三方程式用，Google 隨時可能改或擋；owner 2026-11-03 知情後決定自用。
 * 所以這個 protocol 只服務 principal=owner，每個 Google 帳號各自登入、憑證不互用。
 * 純函式（parse / build / 判斷）與打網路的部分分開，測試注入 fetch / store / lock / now / sleep。
 */

/** Google OAuth token / 撤銷端點。 */
const GEMINI_CLI_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GEMINI_CLI_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GEMINI_CLI_API_VERSION = 'v1internal';
/** 打 Code Assist 必須有的 scope。 */
const GEMINI_CLI_REQUIRED_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** refresh 回這些 error = 要重新登入。 */
const GEMINI_CLI_TERMINAL_REFRESH_ERRORS = Object.freeze(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_rapt']);
/** onboardUser 的輪詢：每 5 秒、最多 8 次（GAS 單次執行上限 6 分鐘，留餘裕）。 */
const GEMINI_CLI_LRO_POLL_MS = 5000;
const GEMINI_CLI_LRO_MAX_POLLS = 8;
/** tier id。 */
const GEMINI_CLI_TIER_FREE = 'free-tier';
const GEMINI_CLI_TIER_LEGACY = 'legacy-tier';
/** Antigravity Hub 的版本 / User-Agent（後端用它決定模型清單；GAS 設不了 User-Agent，但 onboardUser 的 metadata 會帶版本）。 */
const ANTIGRAVITY_HUB_VERSION = '2.24.0';
const ANTIGRAVITY_USER_AGENT = `antigravity/hub/${ANTIGRAVITY_HUB_VERSION} (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)`;
/** Antigravity 沒回專案時（公司 / Workspace 帳號）社群實作用的固定專案。 */
const ANTIGRAVITY_FALLBACK_PROJECT = 'rising-fact-p41fc';

/**
 * 兩種 client 的差異處。OAuth client id / secret **不放在原始碼**（repo 公開；GitHub push protection 也會擋）：
 * 由 scripts/gemini-login.js 從本機 ~/.config/gas-agent/oauth-clients.json 讀，寫進貼到管理頁的憑證 JSON（client_id / client_secret），
 * GAS 端只用憑證裡的值；憑證缺這兩欄會在解析時報錯要求重新登入。
 * knownModels：Code Assist 的 fetchAvailableModels 只有 antigravity 有；拿不到時用這份靜態名單（社群 2026 年中實測過的）。
 * @type {!Object<string, {id: string, label: string, endpoint: string, scopes: !Array<string>, loadMetadata: !Object, knownModels: !Array<{slug: string, display_name: string}>}>}
 */
const GEMINI_CLI_CLIENTS = Object.freeze({
  antigravity: Object.freeze({
    id: 'antigravity', label: 'Antigravity',
    endpoint: 'https://daily-cloudcode-pa.googleapis.com',
    scopes: Object.freeze(['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/cclog', 'https://www.googleapis.com/auth/experimentsandconfigs']),
    loadMetadata: Object.freeze({ ideType: 'ANTIGRAVITY' }),
    knownModels: Object.freeze([
      { slug: 'gemini-3-flash', display_name: 'Gemini 3 Flash' },
      { slug: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro' },
      { slug: 'gemini-2.5-flash', display_name: 'Gemini 2.5 Flash' },
      { slug: 'gemini-3.5-flash-low', display_name: 'Gemini 3.5 Flash（low）' },
      { slug: 'gemini-3.1-pro-low', display_name: 'Gemini 3.1 Pro（low）' },
      { slug: 'gemini-3.8-flash-tiered', display_name: 'Gemini 3.8 Flash（tiered；需新版 User-Agent，GAS 可能不給）' },
      { slug: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
      { slug: 'claude-opus-4-6-thinking', display_name: 'Claude Opus 4.6 Thinking' },
      { slug: 'gpt-oss-120b-medium', display_name: 'GPT-OSS 120B（medium）' },
    ]),
  }),
  gemini_cli: Object.freeze({
    id: 'gemini_cli', label: 'Gemini CLI',
    endpoint: 'https://cloudcode-pa.googleapis.com',
    scopes: Object.freeze(['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile']),
    loadMetadata: Object.freeze({ ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }),
    knownModels: Object.freeze([
      { slug: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro（CLI 預設）' },
      { slug: 'gemini-2.5-flash', display_name: 'Gemini 2.5 Flash' },
      { slug: 'gemini-2.5-flash-lite', display_name: 'Gemini 2.5 Flash Lite' },
      { slug: 'gemini-3-pro-preview', display_name: 'Gemini 3 Pro Preview' },
      { slug: 'gemini-3-flash-preview', display_name: 'Gemini 3 Flash Preview' },
      { slug: 'gemini-3.1-pro-preview', display_name: 'Gemini 3.1 Pro Preview' },
    ]),
  }),
});
/** 預設 client（個人帳號只有這條能走）。 */
const GEMINI_CLI_DEFAULT_CLIENT = 'antigravity';
/** 相容舊程式 / 文件的別名。 */
const GEMINI_CLI_ENDPOINT = GEMINI_CLI_CLIENTS.gemini_cli.endpoint;
const ANTIGRAVITY_ENDPOINT = GEMINI_CLI_CLIENTS.antigravity.endpoint;

/**
 * @typedef {{
 *   client: string, client_id: string, client_secret: string, access_token: string, refresh_token: string, id_token: string, expires_at: number, scopes: !Array<string>,
 *   email: string, subject: string, project_id: string, project_hint: string, tier: string, saved_at: string, refreshed_at: string, invalid: string
 * }} GeminiCliCredentials
 * client：antigravity / gemini_cli；project_id：Code Assist 的 cloudaicompanionProject（登入腳本已解析，或第一次呼叫時由
 * loadCodeAssist / onboardUser 取得並寫回）；project_hint：使用者指定的 GCP 專案（Standard / Enterprise 方案才需要；gemini-login.js --project）。
 */

// ---- 純函式：憑證解析 ------------------------------------------------------------------------------

/**
 * @param {string} client
 * @return {!Object} GEMINI_CLI_CLIENTS 的一項
 * @throws {Error} 不認識的 client
 */
function geminiCliClient_(client) {
  const c = GEMINI_CLI_CLIENTS[client || GEMINI_CLI_DEFAULT_CLIENT];
  if (!c) throw new Error(`憑證的 client「${client}」不認識（只有 ${Object.keys(GEMINI_CLI_CLIENTS).join(' / ')}）。`);
  return c;
}

/**
 * 從憑證判斷 client：明寫的 client 欄位 → 有 expiry_date（google-auth-library 格式 = Gemini CLI 的 ~/.gemini/oauth_creds.json）→ 預設 antigravity。純函式。
 * @param {!Object} o
 * @return {string}
 */
function geminiCliDetectClient_(o) {
  const explicit = String(o.client || '').trim().replace(/-/g, '_');
  if (explicit) return explicit;
  return o.expiry_date !== undefined && !o.client_id ? 'gemini_cli' : GEMINI_CLI_DEFAULT_CLIENT;
}

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
    if (!s) throw new Error('請貼上 scripts/gemini-login.js 印出的憑證 JSON。');
    try { o = JSON.parse(s); } catch (err) { throw new Error('憑證不是合法 JSON：請整段複製 scripts/gemini-login.js 的輸出。'); }
  }
  if (!o || typeof o !== 'object') throw new Error('憑證必須是 JSON object。');
  const str = (k) => (o[k] === null || o[k] === undefined ? '' : String(o[k]).trim());
  if (!str('access_token')) throw new Error('憑證缺 access_token。');
  if (!str('refresh_token')) throw new Error('憑證缺 refresh_token（登入時要 access_type=offline 且同意畫面要重新授權一次；重跑 gemini-login.js）。');
  const client = geminiCliDetectClient_(o);
  const spec = geminiCliClient_(client);
  let scopes = Array.isArray(o.scopes) ? o.scopes.map(String) : String(str('scope')).split(/\s+/).filter(Boolean);
  scopes = scopes.map((x) => x.trim()).filter((x, i, a) => x && a.indexOf(x) === i);
  if (scopes.length && scopes.indexOf(GEMINI_CLI_REQUIRED_SCOPE) === -1) throw new Error(`憑證沒有 ${GEMINI_CLI_REQUIRED_SCOPE} scope：這不是 Antigravity / Gemini CLI 的登入憑證。`);
  let expiresAt = toNumber_(o.expires_at, 0) || toNumber_(o.expiry_date, 0);
  if (!expiresAt && o.expires_in && o.saved_at) {
    const saved = new Date(String(o.saved_at)).getTime();
    if (isFinite(saved)) expiresAt = saved + toNumber_(o.expires_in, 0) * 1000;
  }
  if (!expiresAt) expiresAt = now; // 不知道就當已過期，第一次呼叫會先 refresh
  const idPayload = decodeJwtPayload_(o.id_token) || {};
  const projectId = str('project_id') || str('cloudaicompanionProject');
  if (/^\d+$/.test(projectId)) throw new Error(`project_id「${projectId}」是專案編號（數字），要用專案 ID（字串，例如 my-project-123）。`);
  if (!str('client_id') || !str('client_secret')) {
    throw new Error('憑證沒有 client_id / client_secret（OAuth client 不放在程式裡）：請在本機重新執行 node scripts/gemini-login.js --account <代號>（它會從 ~/.config/gas-agent/oauth-clients.json 讀 client 並寫進憑證），再把印出的 JSON 貼回來。');
  }
  return {
    client,
    client_id: str('client_id'),
    client_secret: str('client_secret'),
    access_token: str('access_token'),
    refresh_token: str('refresh_token'),
    id_token: str('id_token'),
    expires_at: Math.floor(expiresAt),
    scopes: scopes.length ? scopes : spec.scopes.slice(),
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
  if (!creds.client_id || !creds.client_secret) throw new Error('憑證沒有 client_id / client_secret，無法 refresh；請重新執行 scripts/gemini-login.js 並貼新憑證。');
  const form = ['grant_type=refresh_token', 'client_id=' + encodeURIComponent(creds.client_id), 'client_secret=' + encodeURIComponent(creds.client_secret), 'refresh_token=' + encodeURIComponent(creds.refresh_token)];
  return { url: GEMINI_CLI_TOKEN_URL, payload: form.join('&'), headers: { Accept: 'application/json' } };
}

/** @type {OAuthSpec} */
const GEMINI_CLI_OAUTH_SPEC = Object.freeze({ name: 'Google 帳號（Antigravity / Gemini CLI）', login: 'scripts/gemini-login.js', refreshRequest: geminiCliRefreshRequest_, terminalErrors: GEMINI_CLI_TERMINAL_REFRESH_ERRORS });

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
 * @return {?Object} chatgptCredentialSummary_ 的欄位 + client / projectId / tier；scopesOk 改看 cloud-platform；Google refresh token 不會 30 天到期，refreshExpiresAt 留空
 */
function geminiCliCredentialSummary_(creds, now) {
  const s = chatgptCredentialSummary_(creds, now);
  if (!s) return null;
  s.scopesOk = (creds.scopes || []).indexOf(GEMINI_CLI_REQUIRED_SCOPE) !== -1;
  s.refreshExpiresAt = '';
  s.client = creds.client || GEMINI_CLI_DEFAULT_CLIENT;
  s.projectId = creds.project_id || '';
  s.tier = creds.tier || '';
  return s;
}

// ---- Code Assist：loadCodeAssist / onboardUser --------------------------------------------------------

/**
 * 這個 provider + 憑證要打的 endpoint：base_url 若留在任一已知預設（或空）就依 client 決定，否則尊重使用者填的。
 * @param {Provider} provider
 * @param {?Object=} creds
 * @return {string} 不含結尾斜線
 */
function geminiCliEndpoint_(provider, creds) {
  const base = String(provider.base_url || '').replace(/\/+$/, '');
  const known = Object.keys(GEMINI_CLI_CLIENTS).map((k) => GEMINI_CLI_CLIENTS[k].endpoint);
  if (!base || known.indexOf(base) !== -1) return geminiCliClient_(creds && creds.client).endpoint;
  return base;
}

/**
 * @param {string} endpoint
 * @param {string} method loadCodeAssist / onboardUser / generateContent…
 * @return {string}
 */
function geminiCliMethodUrl_(endpoint, method) {
  return `${endpoint}/${GEMINI_CLI_API_VERSION}:${method}`;
}

/**
 * 打 Code Assist 的一個 method（POST JSON）或取 LRO（GET）。非 2xx throw providerError_。
 * @param {Provider} provider
 * @param {string} token
 * @param {string} url 完整網址
 * @param {?Object} body null = GET
 * @param {Function=} fetchFn
 * @return {!Object}
 */
function geminiCliRpc_(provider, token, url, body, fetchFn) {
  fetchFn = fetchFn || defaultProviderFetch_;
  const options = { method: body ? 'post' : 'get', headers: { Authorization: 'Bearer ' + token, 'User-Agent': ANTIGRAVITY_USER_AGENT }, muteHttpExceptions: true };
  if (body) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
  const what = url.replace(/^https?:\/\/[^/]+\//, '');
  let res;
  try { res = fetchFn(url, options); } catch (err) { throw providerError_(provider, 0, `Code Assist ${what} fetch 失敗：${err && err.message || err}`); }
  const code = res.getResponseCode();
  const text = res.getContentText();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  if (code < 200 || code >= 300) throw providerError_(provider, code, `Code Assist ${what}：${extractApiError_(json, text)}`);
  return json || {};
}

/**
 * loadCodeAssist 回應裡的專案（字串或 {id}）。純函式。
 * @param {*} v
 * @return {string}
 */
function geminiCliProjectField_(v) {
  if (!v) return '';
  return String(typeof v === 'object' ? (v.id || '') : v).trim();
}

/**
 * loadCodeAssist 回應 → 已就緒的 {project, tier}，或 null（還沒 onboard）。純函式。
 * gemini_cli（照 setup.ts）：currentTier 存在 = 已 onboard，專案用 cloudaicompanionProject（沒有就用 projectHint，再沒有就依 ineligibleTiers 報錯）。
 * antigravity（照 opencode-antigravity-auth）：有 cloudaicompanionProject 就直接用；沒有就去 onboard（不看 currentTier）。
 * @param {!Object} loadRes
 * @param {string} projectHint 憑證裡使用者指定的 project_id（可空）
 * @param {string=} client
 * @return {?{project: string, tier: string}}
 * @throws {Error} 已 onboard 但沒有專案可用
 */
function geminiCliProjectFromLoad_(loadRes, projectHint, client) {
  loadRes = loadRes || {};
  const project = geminiCliProjectField_(loadRes.cloudaicompanionProject);
  const tier = String((loadRes.paidTier && loadRes.paidTier.id) || (loadRes.currentTier && loadRes.currentTier.id) || '');
  if ((client || GEMINI_CLI_DEFAULT_CLIENT) === 'antigravity') {
    return project ? { project, tier } : null;
  }
  if (!loadRes.currentTier) return null;
  const chosen = project || String(projectHint || '');
  if (!chosen) throw new Error(geminiCliIneligibleMessage_(loadRes));
  return { project: chosen, tier: tier || 'standard-tier' };
}

/**
 * onboardUser 的 body。純函式。
 * gemini_cli：{tierId, cloudaicompanionProject?, metadata{ideType…, duetProject?}}；free-tier 不能帶專案（會 Precondition Failed）。
 * antigravity：{tier_id, metadata{ide_type:'ANTIGRAVITY', ide_version, ide_name}}（snake_case）；預設 tier 取 allowedTiers 的 isDefault → 第一個 → currentTier → free-tier。
 * @param {!Object} loadRes
 * @param {string} projectHint
 * @param {string=} client
 * @return {{tierId: string, body: !Object}}
 */
function geminiCliOnboardRequest_(loadRes, projectHint, client) {
  loadRes = loadRes || {};
  const tiers = loadRes.allowedTiers || [];
  const def = tiers.find((t) => t && t.isDefault);
  if ((client || GEMINI_CLI_DEFAULT_CLIENT) === 'antigravity') {
    const tierId = String((def && def.id) || (tiers[0] && tiers[0].id) || (loadRes.currentTier && loadRes.currentTier.id) || GEMINI_CLI_TIER_FREE);
    return { tierId, body: { tier_id: tierId, metadata: { ide_type: 'ANTIGRAVITY', ide_version: ANTIGRAVITY_HUB_VERSION, ide_name: 'antigravity' } } };
  }
  const tierId = String((def && def.id) || GEMINI_CLI_TIER_LEGACY);
  const metadata = Object.assign({}, GEMINI_CLI_CLIENTS.gemini_cli.loadMetadata);
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
    return '這個 Google 帳號不能用這條方案：' + tiers.map((t) => `${t.tierName || t.tierId || '?'}：${t.reasonMessage || t.reasonCode || ''}${t.validationUrl ? '（請先到 ' + t.validationUrl + ' 完成驗證）' : ''}`).join('；');
  }
  return '這個 Google 帳號需要指定 Google Cloud 專案（Gemini Code Assist Standard / Enterprise）：重跑 scripts/gemini-login.js --project <專案 ID> 再貼憑證。';
}

/**
 * 確保憑證裡有 Code Assist 專案：loadCodeAssist →（必要時）onboardUser + 輪詢，寫回 store。
 * gemini_cli 的 LRO 用 GET operations/<name> 輪詢；antigravity 照社群實作重送 onboardUser 直到 done，沒拿到專案就用 ANTIGRAVITY_FALLBACK_PROJECT。
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
  const client = creds.client || GEMINI_CLI_DEFAULT_CLIENT;
  const spec = geminiCliClient_(client);
  const endpoint = geminiCliEndpoint_(provider, creds);
  const hint = String(creds.project_hint || '');
  const sleep = deps.sleep || ((ms) => Utilities.sleep(ms));
  const loadBody = { metadata: Object.assign({}, spec.loadMetadata) };
  if (client === 'gemini_cli' && hint) { loadBody.cloudaicompanionProject = hint; loadBody.metadata.duetProject = hint; }
  const loadRes = geminiCliRpc_(provider, token, geminiCliMethodUrl_(endpoint, 'loadCodeAssist'), loadBody, deps.fetch);
  let ready;
  try { ready = geminiCliProjectFromLoad_(loadRes, hint, client); } catch (err) { throw providerError_(provider, 403, err.message); }
  if (!ready) {
    const onboard = geminiCliOnboardRequest_(loadRes, hint, client);
    let lro = geminiCliRpc_(provider, token, geminiCliMethodUrl_(endpoint, 'onboardUser'), onboard.body, deps.fetch);
    let polls = 0;
    while (!lro.done && polls < GEMINI_CLI_LRO_MAX_POLLS && (client === 'antigravity' || lro.name)) {
      sleep(GEMINI_CLI_LRO_POLL_MS);
      lro = client === 'antigravity'
        ? geminiCliRpc_(provider, token, geminiCliMethodUrl_(endpoint, 'onboardUser'), onboard.body, deps.fetch)
        : geminiCliRpc_(provider, token, `${endpoint}/${GEMINI_CLI_API_VERSION}/${lro.name}`, null, deps.fetch);
      polls++;
    }
    let project = lro.done ? geminiCliProjectField_(lro.response && lro.response.cloudaicompanionProject) : '';
    if (!project && client === 'antigravity') project = hint || ANTIGRAVITY_FALLBACK_PROJECT;
    if (!lro.done && !project) throw providerError_(provider, 503, 'Code Assist 開通（onboardUser）還在進行中，請稍後再試一次。');
    if (!project) project = hint;
    if (!project) throw providerError_(provider, 403, geminiCliIneligibleMessage_(loadRes));
    ready = { project, tier: onboard.tierId };
  }
  store.set(Object.assign({}, store.get() || creds, { project_id: ready.project, tier: ready.tier }));
  return ready;
}

/**
 * 這次呼叫要用的 {token, project, client, endpoint}：token 會自動 refresh；project 沒有就先開通。
 * @param {Provider} provider
 * @param {{fetch: (Function|undefined), store: (Object|undefined), lock: (Object|undefined), now: (Function|undefined), sleep: (Function|undefined)}=} deps
 * @return {{token: string, project: string, client: string, endpoint: string}}
 */
function geminiCliAuth_(provider, deps) {
  deps = deps || {};
  const token = geminiCliAccessToken_(provider, deps);
  const store = deps.store || chatgptPropStore_(provider.id);
  const creds = store.get() || {};
  const project = creds.project_id || geminiCliSetup_(provider, token, { fetch: deps.fetch, store, sleep: deps.sleep }).project;
  return { token, project, client: creds.client || GEMINI_CLI_DEFAULT_CLIENT, endpoint: geminiCliEndpoint_(provider, creds) };
}

// ---- Adapter：Code Assist generateContent（包一層標準 Gemini body）-------------------------------------------

/**
 * @param {Provider} provider
 * @param {ChatRequest} req
 * @param {{token: string, project: string, client: (string|undefined), endpoint: (string|undefined)}|string} auth geminiCliAuth_ 的結果（測試可直接給 token 字串：project 空、client 預設）
 * @return {{url: string, headers: !Object, body: !Object}}
 */
function geminiCliBuildRequest_(provider, req, auth) {
  const a = typeof auth === 'string' ? { token: auth } : (auth || {});
  const token = String(a.token || '');
  const project = String(a.project || '');
  const client = a.client || GEMINI_CLI_DEFAULT_CLIENT;
  const endpoint = a.endpoint || geminiCliEndpoint_(provider, { client });
  // 內層就是標準 generateContent body（contents / systemInstruction / tools / generationConfig；extra_body 也套在內層）
  const inner = geminiBuildRequest_(Object.assign({}, provider, { base_url: 'https://generativelanguage.googleapis.com' }), req, '');
  const model = req.model || provider.model;
  const body = { model, project, request: inner.body };
  if (req.sessionId) body.request.sessionId = String(req.sessionId);
  if (client === 'antigravity') {
    body.requestType = 'agent';
    body.userAgent = 'antigravity';
    body.requestId = 'agent-' + geminiCliPromptId_(req);
  } else {
    body.user_prompt_id = geminiCliPromptId_(req);
  }
  return {
    url: geminiCliMethodUrl_(endpoint, 'generateContent'),
    headers: Object.assign({ Authorization: 'Bearer ' + token, 'User-Agent': ANTIGRAVITY_USER_AGENT }, provider.extra_headers),
    body,
  };
}

/**
 * 這輪的識別字串（Code Assist 的 user_prompt_id / requestId）。
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
 * fetchAvailableModels 回應（antigravity：`{models: {<name>: {displayName, disabled, quotaInfo{remainingFraction, resetTime}}}}`）→ [{slug, display_name}]，
 * 停用的剔除、剩餘額度附在名稱上。純函式。
 * @param {?Object} json
 * @return {!Array<{slug: string, display_name: string}>}
 */
function geminiCliParseModels_(json) {
  const models = json && json.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return [];
  return Object.keys(models).filter((k) => models[k] && !models[k].disabled).map((k) => {
    const m = models[k];
    const q = m.quotaInfo && typeof m.quotaInfo.remainingFraction === 'number' ? `，額度剩 ${Math.round(m.quotaInfo.remainingFraction * 100)}%` : '';
    return { slug: k, display_name: `${m.displayName || k}${q}` };
  });
}

/**
 * 「可用模型」：antigravity 問 fetchAvailableModels（要 token + project；失敗就退回靜態名單）；gemini_cli 沒有這支 API，回靜態名單。
 * @param {Provider} provider
 * @param {{fetch: (Function|undefined), auth: (Object|undefined), store: (Object|undefined)}=} deps auth 可注入 {token, project, client, endpoint}
 * @return {!Array<{slug: string, display_name: string}>}
 */
function geminiCliListModels_(provider, deps) {
  deps = deps || {};
  const store = deps.store || chatgptPropStore_(provider.id);
  const creds = store.get();
  const client = (deps.auth && deps.auth.client) || (creds && creds.client) || GEMINI_CLI_DEFAULT_CLIENT;
  const known = geminiCliClient_(client).knownModels.map((m) => Object.assign({}, m));
  if (client !== 'antigravity' || !creds) return known;
  try {
    const auth = deps.auth || geminiCliAuth_(provider, { fetch: deps.fetch, store });
    const json = geminiCliRpc_(provider, auth.token, geminiCliMethodUrl_(auth.endpoint || geminiCliEndpoint_(provider, creds), 'fetchAvailableModels'), { project: auth.project }, deps.fetch);
    const live = geminiCliParseModels_(json);
    return live.length ? live : known;
  } catch (err) {
    return known;
  }
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
  return p.protocol === 'gemini_cli' ? geminiCliListModels_(p) : chatgptListModels_(p);
}

/**
 * 依協定的本機登入腳本名（訊息用）。
 * @param {string} protocol
 * @return {string}
 */
function oauthLoginScript_(protocol) {
  return protocol === 'gemini_cli' ? GEMINI_CLI_OAUTH_SPEC.login : CHATGPT_OAUTH_SPEC.login;
}
