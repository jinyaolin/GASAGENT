#!/usr/bin/env node
/**
 * Google 帳號本機登入：給 GAS Agent 的 protocol=gemini_cli provider 用（Antigravity / Gemini CLI 方案額度打 Code Assist API）。零依賴（node ≥ 18）。
 *
 *   node scripts/gemini-login.js [--account <代號>] [--client antigravity|gemini-cli] [--project <GCP 專案 ID>] [--port <n>]
 *                                [--from-cli] [--print] [--no-setup] [--no-open] [--debug]
 *   --client：預設 antigravity（個人 Google 帳號只有這條能走）；gemini-cli 只剩 Gemini Code Assist Standard / Enterprise 授權能用
 *            （Google 2026-06-18 起不再服務個人帳號）
 *   --project：Standard / Enterprise 方案才需要（個人方案是 Google 代管專案，不用填）
 *   --from-cli：不開瀏覽器，直接沿用本機已登入的憑證：antigravity → ~/.gemini/antigravity-cli/antigravity-oauth-token；
 *               gemini-cli → ~/.gemini/oauth_creds.json
 *   --no-setup：略過 loadCodeAssist / onboardUser / fetchAvailableModels（GAS 端第一次呼叫會自己開通）
 *
 * 做什麼：
 *   1. 開回呼 listener，用系統瀏覽器開 Google 授權頁（授權碼 + PKCE、access_type=offline、prompt=consent 確保拿到 refresh token）。
 *      antigravity 的回呼固定 http://localhost:51121/oauth-callback（它的 client 就是這樣登記的）；gemini-cli 用 127.0.0.1 隨機 port。
 *   2. 用授權碼換 token（Google 安裝型 app 要帶 client_secret），取 userinfo 的 email。
 *   3. 呼叫 Code Assist 的 loadCodeAssist /（必要時）onboardUser 開通，拿到專案 ID 與方案（tier）；antigravity 再問 fetchAvailableModels 印出可用模型。
 *   4. 憑證存 ~/.config/gas-agent/gemini-cli/<代號>.json（0600），並印出一段 JSON：複製貼到管理頁「模型」→ 該 provider 的「Google 帳號憑證」。
 * 之後 GAS 端會自己 refresh（Google 的 refresh token 不會定期到期；撤銷或改密碼才失效，重跑本腳本即可）。
 * 提醒：這兩條 API / OAuth client 都沒公開給第三方用，Google 隨時可能改或擋；只用在你自己控制的 agent，不要把憑證給別人。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HUB_VERSION = '2.24.0';
const HUB_UA = `antigravity/hub/${HUB_VERSION} (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)`;
/** 兩種 client（安裝型 app 的公開 client；與 src/Providers_GeminiCli.gs 的 GEMINI_CLI_CLIENTS 一致）。 */
const CLIENTS = {
  antigravity: {
    id: 'antigravity', label: 'Antigravity',
    clientId: '<antigravity client id removed>.apps.googleusercontent.com', clientSecret: 'GOCSPX-<antigravity client secret removed>',
    scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/cclog', 'https://www.googleapis.com/auth/experimentsandconfigs'],
    endpoint: 'https://daily-cloudcode-pa.googleapis.com',
    redirect: { host: 'localhost', port: 51121, path: '/oauth-callback' },
    loadMetadata: { ideType: 'ANTIGRAVITY' },
    cliTokenFile: path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    userAgent: HUB_UA,
  },
  gemini_cli: {
    id: 'gemini_cli', label: 'Gemini CLI',
    clientId: '<gemini cli client id removed>.apps.googleusercontent.com', clientSecret: 'GOCSPX-<gemini cli client secret removed>',
    scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
    endpoint: 'https://cloudcode-pa.googleapis.com',
    redirect: { host: '127.0.0.1', port: 0, path: '/oauth2callback' },
    loadMetadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
    cliTokenFile: path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
    userAgent: 'google-api-nodejs-client/9.15.1',
  },
};
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const REQUIRED_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const ANTIGRAVITY_FALLBACK_PROJECT = 'rising-fact-p41fc';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : def; };
const flag = (name) => args.indexOf(name) !== -1;
const account = opt('--account', 'default');
const clientKey = String(opt('--client', 'antigravity')).replace(/-/g, '_');
const C = CLIENTS[clientKey];
if (!C) { console.error(`--client 只能是 antigravity 或 gemini-cli（不是「${clientKey}」）。`); process.exit(1); }
const port = Number(opt('--port', String(C.redirect.port)));
const projectHint = opt('--project', process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || '');
const debug = flag('--debug');
if (!/^[a-z0-9][a-z0-9_-]*$/.test(account)) { console.error('--account 只能用小寫字母 / 數字 / - / _'); process.exit(1); }
if (/^\d+$/.test(projectHint)) { console.error(`--project「${projectHint}」是專案編號（數字），要用專案 ID（字串，例如 my-project-123）。`); process.exit(1); }

const dir = path.join(os.homedir(), '.config', 'gas-agent', 'gemini-cli');
const credPath = path.join(dir, `${account}.json`);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (err) { return null; } };
const writePrivate = (p, text) => { fs.writeFileSync(p + '.tmp', text, { mode: 0o600 }); fs.renameSync(p + '.tmp', p); fs.chmodSync(p, 0o600); };
const decodeJwt = (t) => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch (err) { return {}; } };
const projectField = (v) => (v ? String(typeof v === 'object' ? (v.id || '') : v).trim() : '');

/** 印出可貼進管理頁的憑證。 */
function printForPaste(creds) {
  const paste = {
    client: creds.client, client_id: creds.client_id, client_secret: creds.client_secret, access_token: creds.access_token, refresh_token: creds.refresh_token, id_token: creds.id_token,
    expires_at: creds.expires_at, scopes: creds.scopes, email: creds.email, subject: creds.subject, project_id: creds.project_id || '', project_hint: creds.project_hint || '', tier: creds.tier || '', saved_at: creds.saved_at,
  };
  console.log('\n==== 把下面整段（含大括號）貼到管理頁「模型」→ 編輯 gemini_cli provider →「Google 帳號憑證」====\n');
  console.log(JSON.stringify(paste));
  console.log('\n==== 結束。憑證也存在 ' + credPath + '（0600；--print 可重印）。====');
}

/** Code Assist：POST method（或 GET 完整網址，body=null）。 */
async function codeAssist(token, methodOrUrl, body, extraHeaders) {
  const url = /^https?:\/\//.test(methodOrUrl) ? methodOrUrl : `${C.endpoint}/v1internal:${methodOrUrl}`;
  const headers = Object.assign({ Authorization: 'Bearer ' + token, 'User-Agent': C.userAgent }, body ? { 'Content-Type': 'application/json' } : {}, extraHeaders || {});
  const res = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  if (debug) console.log(`[debug] ${methodOrUrl} → HTTP ${res.status} ${text.slice(0, 600)}`);
  if (!res.ok) throw new Error(`Code Assist ${methodOrUrl} HTTP ${res.status}：${(json && json.error && json.error.message) || text.slice(0, 300)}`);
  return json || {};
}

function ineligibleMessage(load) {
  const tiers = load.ineligibleTiers || [];
  if (tiers.length) return '這個 Google 帳號不能用這條方案：' + tiers.map((t) => `${t.tierName || t.tierId || '?'}：${t.reasonMessage || t.reasonCode || ''}${t.validationUrl ? '（請先到 ' + t.validationUrl + ' 完成驗證）' : ''}`).join('；');
  return '這個帳號需要指定 Google Cloud 專案（Gemini Code Assist Standard / Enterprise）：加 --project <專案 ID> 重跑。';
}

/**
 * loadCodeAssist →（必要時）onboardUser，回 {project, tier}。
 * antigravity：有 cloudaicompanionProject 就用；沒有就 onboardUser（snake_case metadata）重送直到 done，還是沒有就用社群實作的 fallback 專案。
 * gemini-cli：照 gemini-cli setup.ts（currentTier → cloudaicompanionProject；否則 onboardUser + GET operations/<name>）。
 */
async function setupCodeAssist(token) {
  const loadBody = { metadata: Object.assign({}, C.loadMetadata) };
  if (C.id === 'gemini_cli' && projectHint) { loadBody.cloudaicompanionProject = projectHint; loadBody.metadata.duetProject = projectHint; }
  const load = await codeAssist(token, 'loadCodeAssist', loadBody);
  const tiers = load.allowedTiers || [];
  const def = tiers.find((t) => t && t.isDefault);
  const direct = projectField(load.cloudaicompanionProject);
  const curTier = String((load.paidTier && load.paidTier.id) || (load.currentTier && load.currentTier.id) || '');
  if (C.id === 'antigravity') {
    if (direct) return { project: direct, tier: curTier, onboarded: false };
    const tierId = String((def && def.id) || (tiers[0] && tiers[0].id) || curTier || 'free-tier');
    console.log(`帳號尚未開通 Code Assist，以 ${tierId} 開通中…`);
    const body = { tier_id: tierId, metadata: { ide_type: 'ANTIGRAVITY', ide_version: HUB_VERSION, ide_name: 'antigravity' } };
    const hdr = { 'User-Agent': `${HUB_UA} google-api-nodejs-client/10.3.0`, 'X-Goog-Api-Client': 'gl-node/22.21.1', Accept: '*/*' };
    let lro = await codeAssist(token, 'onboardUser', body, hdr);
    for (let i = 0; !lro.done && i < 10; i++) { await new Promise((r) => setTimeout(r, 5000)); lro = await codeAssist(token, 'onboardUser', body, hdr); }
    const project = (lro.done && projectField(lro.response && lro.response.cloudaicompanionProject)) || projectHint || ANTIGRAVITY_FALLBACK_PROJECT;
    if (!lro.done) console.log(`⚠️ onboardUser 沒回 done，先用 ${project}（社群實作的 fallback 專案）。`);
    return { project, tier: tierId, onboarded: true };
  }
  if (load.currentTier) {
    const project = direct || projectHint;
    if (!project) throw new Error(ineligibleMessage(load));
    return { project, tier: curTier || 'standard-tier', onboarded: false };
  }
  const tierId = (def && def.id) || 'legacy-tier';
  const body = { tierId, metadata: Object.assign({}, C.loadMetadata) };
  if (tierId !== 'free-tier' && projectHint) { body.cloudaicompanionProject = projectHint; body.metadata.duetProject = projectHint; }
  console.log(`帳號尚未開通 Code Assist，以 ${tierId} 開通中…`);
  let lro = await codeAssist(token, 'onboardUser', body);
  for (let i = 0; !lro.done && lro.name && i < 12; i++) { await new Promise((r) => setTimeout(r, 5000)); lro = await codeAssist(token, `${C.endpoint}/v1internal/${lro.name}`, null); }
  if (!lro.done) throw new Error('開通（onboardUser）超過 60 秒還沒完成，稍後重跑即可（或貼憑證讓 GAS 端再試）。');
  const project = projectField(lro.response && lro.response.cloudaicompanionProject) || projectHint;
  if (!project) throw new Error(ineligibleMessage(load));
  return { project, tier: tierId, onboarded: true };
}

/** antigravity：這個帳號現在能用的模型（含剩餘額度）。 */
async function listModels(token, project) {
  const json = await codeAssist(token, 'fetchAvailableModels', { project });
  const models = json.models && typeof json.models === 'object' ? json.models : {};
  return Object.keys(models).filter((k) => models[k] && !models[k].disabled).map((k) => {
    const m = models[k];
    const q = m.quotaInfo && typeof m.quotaInfo.remainingFraction === 'number' ? `，額度剩 ${Math.round(m.quotaInfo.remainingFraction * 100)}%` : '';
    return `${k}（${m.displayName || k}${q}）`;
  });
}

/** token 回應 + email → 憑證物件；跑 setup；存檔；印出。 */
async function finish(token, extra) {
  const now = Date.now();
  const scopes = String(token.scope || '').split(/\s+/).filter(Boolean);
  if (scopes.length && scopes.indexOf(REQUIRED_SCOPE) === -1) throw new Error(`沒有拿到 ${REQUIRED_SCOPE} scope，請重跑並在同意畫面全部允許。`);
  let email = extra.email || '';
  let subject = extra.subject || '';
  if (!email) {
    try {
      const u = await (await fetch(USERINFO_URL, { headers: { Authorization: 'Bearer ' + token.access_token } })).json();
      email = u.email || ''; subject = subject || u.id || '';
    } catch (err) { /* 沒 email 也能用 */ }
  }
  const idc = decodeJwt(token.id_token);
  const creds = {
    client: C.id, client_id: C.clientId, client_secret: C.clientSecret, access_token: token.access_token, refresh_token: token.refresh_token, id_token: token.id_token || '',
    expires_at: extra.expires_at || (now + (Number(token.expires_in) || 3600) * 1000), scopes: scopes.length ? scopes : C.scopes.slice(),
    email: email || idc.email || '', subject: subject || idc.sub || '', project_id: '', project_hint: projectHint, tier: '', saved_at: new Date(now).toISOString(), account,
  };
  if (!flag('--no-setup')) {
    try {
      const s = await setupCodeAssist(creds.access_token);
      creds.project_id = s.project; creds.tier = s.tier;
      console.log(`Code Assist（${C.label}）：${s.onboarded ? '已開通' : '已就緒'}${s.tier ? '，方案 ' + s.tier : ''}，專案 ${s.project}`);
      if (C.id === 'antigravity') {
        try {
          const models = await listModels(creds.access_token, s.project);
          if (models.length) console.log('這個帳號可用的模型（填到 provider 的 model；GAS 設不了 User-Agent，最新的模型可能不給，不行就換一個）：\n  ' + models.join('\n  '));
        } catch (err) { console.log(`（列模型失敗：${err.message}；管理頁「可用模型」會再試）`); }
      }
    } catch (err) {
      console.error(`⚠️ Code Assist 開通沒成功：${err.message}\n   憑證仍會印出；GAS 端第一次呼叫會再試一次。`);
    }
  }
  writePrivate(credPath, JSON.stringify(creds, null, 2) + '\n');
  console.log(`\n✅ 登入完成（${C.label}）：${creds.email || creds.subject || '(未知帳號)'}`);
  printForPaste(creds);
}

/** 用 refresh token 換一次新 token（--from-cli 時驗證並取得 access token）。 */
async function refreshWith(refreshToken) {
  const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: C.clientId, client_secret: C.clientSecret, refresh_token: refreshToken });
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const token = await res.json();
  if (!res.ok || !token.access_token) throw new Error(`refresh token 換不到新 token（HTTP ${res.status}：${token.error || ''} ${token.error_description || ''}），請改用一般登入。`);
  token.refresh_token = refreshToken;
  return token;
}

if (flag('--print')) {
  const saved = readJson(credPath);
  if (!saved) { console.error('沒有已存的憑證：' + credPath); process.exit(1); }
  printForPaste(saved);
  process.exit(0);
}

if (flag('--from-cli')) {
  // 沿用本機 CLI 的憑證：antigravity-oauth-token {access_token, refresh_token, expiry(RFC3339), token_type}；oauth_creds.json {access_token, refresh_token, scope, id_token, expiry_date}
  const cli = readJson(C.cliTokenFile);
  if (!cli || !cli.refresh_token) { console.error(`找不到可用的 ${C.label} 憑證（${C.cliTokenFile}）：先用 ${C.id === 'antigravity' ? 'agy' : 'gemini'} 登入一次，或不加 --from-cli 直接登入。`); process.exit(1); }
  (async () => {
    const token = await refreshWith(cli.refresh_token);
    token.id_token = token.id_token || cli.id_token || '';
    token.scope = token.scope || cli.scope || '';
    await finish(token, { email: decodeJwt(token.id_token).email || '' });
    process.exit(0);
  })().catch((err) => { console.error('\n✗ ' + (err && err.message || err)); process.exit(1); });
} else {
  // 一般登入：loopback 回呼 + 授權碼 + PKCE
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  let redirectUri = '';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, redirectUri);
    const reply = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">${html}</body>`); };
    if (url.pathname !== C.redirect.path) { res.writeHead(404); res.end('not found'); return; }
    try {
      if (url.searchParams.get('state') !== state) throw new Error('state 不符（舊分頁或別的登入嘗試），請用終端機印的網址重開。');
      const error = url.searchParams.get('error');
      if (error) throw new Error(`授權被拒：${error}${url.searchParams.get('error_description') ? ' — ' + url.searchParams.get('error_description') : ''}`);
      const code = url.searchParams.get('code');
      if (!code) throw new Error('回呼沒有 code。');
      const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: C.clientId, client_secret: C.clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier });
      const tokenRes = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString() });
      const tokenText = await tokenRes.text();
      let token;
      try { token = JSON.parse(tokenText); } catch (err) { throw new Error(`token 回應不是 JSON（HTTP ${tokenRes.status}）：${tokenText.slice(0, 300)}`); }
      if (!tokenRes.ok || !token.access_token) throw new Error(`換 token 失敗（HTTP ${tokenRes.status}：${token.error || ''}${token.error_description ? ' — ' + token.error_description : ''}${debug ? '\n' + tokenText.slice(0, 1000) : ''}）`);
      if (!token.refresh_token) throw new Error(`token 回應沒有 refresh_token：到 https://myaccount.google.com/permissions 移除「${C.label}」的存取權後重跑，同意畫面會重新授權。`);
      reply(200, '<h2>登入完成</h2><p>回到終端機複製憑證。可以關閉此分頁。</p>');
      server.close();
      await finish(token, {});
      process.exit(0);
    } catch (err) {
      reply(400, `<h2>登入失敗</h2><pre>${String(err && err.message || err).replace(/</g, '&lt;')}</pre>`);
      console.error('\n✗ ' + (err && err.message || err));
      setTimeout(() => process.exit(1), 200);
    }
  });
  server.listen(port, C.redirect.host === 'localhost' ? '127.0.0.1' : C.redirect.host, () => {
    redirectUri = `http://${C.redirect.host}:${server.address().port}${C.redirect.path}`;
    const params = new URLSearchParams({ client_id: C.clientId, redirect_uri: redirectUri, response_type: 'code', scope: C.scopes.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' });
    const authUrl = `${AUTHORIZE_URL}?${params.toString()}`;
    console.log(`帳號 ${account}；client ${C.label}；憑證檔 ${credPath}${projectHint ? '；GCP 專案 ' + projectHint : ''}`);
    console.log('等待瀏覽器完成 Google 登入與同意（請選要用來跑 agent 的 Google 帳號，全部允許）…');
    console.log('若瀏覽器沒自動開啟，手動開這個網址：\n' + authUrl + '\n');
    if (!flag('--no-open')) {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const a = process.platform === 'win32' ? ['/c', 'start', '', authUrl] : [authUrl];
      execFile(cmd, a, () => {});
    }
  });
  server.on('error', (err) => { console.error(`回呼 listener 開不起來（${C.redirect.host}:${port || '隨機'}）：${err.message}。${C.id === 'antigravity' ? 'Antigravity 的回呼 port 固定 51121，請先關掉占用它的程式（例如 agy）再試。' : '換 --port 再試。'}`); process.exit(1); });
}
