#!/usr/bin/env node
/**
 * Gemini CLI（Google 帳號）本機登入：給 GAS Agent 的 protocol=gemini_cli provider 用。零依賴（node ≥ 18）。
 * 照 github.com/google-gemini/gemini-cli packages/core/src/code_assist/{oauth2,setup}.ts 的流程，用它的 OAuth client。
 *
 *   node scripts/gemini-login.js [--account <代號>] [--port <n>] [--project <GCP 專案 ID>] [--from-cli] [--print] [--no-setup] [--no-open] [--debug]
 *   --project：Gemini Code Assist Standard / Enterprise 方案才需要（免費方案是 Google 代管專案，不用填）
 *   --from-cli：不開瀏覽器，直接沿用已登入的 Gemini CLI 憑證 ~/.gemini/oauth_creds.json
 *   --no-setup：略過 loadCodeAssist / onboardUser（GAS 端第一次呼叫會自己做）
 *
 * 做什麼：
 *   1. 在 127.0.0.1:<port>/oauth2callback 開回呼 listener，用系統瀏覽器開 Google 授權頁（scope：cloud-platform、userinfo.email、
 *      userinfo.profile；access_type=offline、prompt=consent 確保拿到 refresh token）。
 *   2. 用授權碼換 token（Google 安裝型 app 要帶 client_secret），取 userinfo 的 email。
 *   3. 呼叫 Code Assist 的 loadCodeAssist /（必要時）onboardUser 開通，拿到這個帳號的專案 ID 與方案（tier）。
 *   4. 憑證存 ~/.config/gas-agent/gemini-cli/<代號>.json（0600），並印出一段 JSON：複製貼到管理頁「模型」→ 該 provider 的「Gemini CLI 憑證」。
 * 之後 GAS 端會自己 refresh（Google 的 refresh token 不會定期到期；撤銷或改密碼才失效，重跑本腳本即可）。
 * 提醒：這是你 Google 帳號的個人方案額度，只用在你自己控制的 agent；不要把憑證給別人或共用。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Gemini CLI 的 OAuth client（安裝型 app，公開在它的原始碼 oauth2.ts）
const CLIENT_ID = '<gemini cli client id removed>.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-<gemini cli client secret removed>';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const SCOPES = ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'];
const REQUIRED_SCOPE = SCOPES[0];
const CODE_ASSIST = 'https://cloudcode-pa.googleapis.com/v1internal';
const METADATA = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
const CALLBACK_PATH = '/oauth2callback';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : def; };
const flag = (name) => args.indexOf(name) !== -1;
const account = opt('--account', 'default');
const port = Number(opt('--port', '0')); // 0 = 系統挑一個空的（Google 的桌面型 client 接受任何 loopback port）
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

/** 印出可貼進管理頁的憑證。 */
function printForPaste(creds) {
  const paste = {
    client_id: creds.client_id, client_secret: creds.client_secret, access_token: creds.access_token, refresh_token: creds.refresh_token, id_token: creds.id_token,
    expires_at: creds.expires_at, scopes: creds.scopes, email: creds.email, subject: creds.subject, project_id: creds.project_id || '', project_hint: creds.project_hint || '', tier: creds.tier || '', saved_at: creds.saved_at,
  };
  console.log('\n==== 把下面整段（含大括號）貼到管理頁「模型」→ 編輯 gemini_cli provider →「Gemini CLI 憑證」====\n');
  console.log(JSON.stringify(paste));
  console.log('\n==== 結束。憑證也存在 ' + credPath + '（0600；--print 可重印）。====');
}

/** Code Assist：POST method 或 GET 完整網址。 */
async function codeAssist(token, methodOrUrl, body) {
  const url = /^https?:\/\//.test(methodOrUrl) ? methodOrUrl : `${CODE_ASSIST}:${methodOrUrl}`;
  const res = await fetch(url, { method: body ? 'POST' : 'GET', headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  if (debug) console.log(`[debug] ${methodOrUrl} → HTTP ${res.status} ${text.slice(0, 500)}`);
  if (!res.ok) throw new Error(`Code Assist ${methodOrUrl} HTTP ${res.status}：${(json && json.error && json.error.message) || text.slice(0, 300)}`);
  return json || {};
}

/**
 * loadCodeAssist →（必要時）onboardUser + 輪詢，回 {project, tier}。照 setup.ts。
 * @throws {Error} 不合格 / 要指定專案
 */
async function setupCodeAssist(token) {
  const loadBody = { metadata: Object.assign({}, METADATA) };
  if (projectHint) { loadBody.cloudaicompanionProject = projectHint; loadBody.metadata.duetProject = projectHint; }
  const load = await codeAssist(token, 'loadCodeAssist', loadBody);
  const ineligible = () => {
    const tiers = load.ineligibleTiers || [];
    if (tiers.length) return '這個 Google 帳號不能用 Gemini CLI 的免費方案：' + tiers.map((t) => `${t.tierName || t.tierId || '?'}：${t.reasonMessage || t.reasonCode || ''}${t.validationUrl ? '（請先到 ' + t.validationUrl + ' 完成驗證）' : ''}`).join('；');
    return '這個帳號需要指定 Google Cloud 專案（Gemini Code Assist Standard / Enterprise）：加 --project <專案 ID> 重跑。';
  };
  if (load.currentTier) {
    const tier = (load.paidTier && load.paidTier.id) || load.currentTier.id || 'standard-tier';
    const project = load.cloudaicompanionProject || projectHint;
    if (!project) throw new Error(ineligible());
    return { project, tier, onboarded: false };
  }
  const def = (load.allowedTiers || []).find((t) => t.isDefault);
  const tierId = (def && def.id) || 'legacy-tier';
  const body = { tierId, metadata: Object.assign({}, METADATA) };
  if (tierId !== 'free-tier' && projectHint) { body.cloudaicompanionProject = projectHint; body.metadata.duetProject = projectHint; }
  console.log(`帳號尚未開通 Code Assist，以 ${tierId} 開通中…`);
  let lro = await codeAssist(token, 'onboardUser', body);
  for (let i = 0; !lro.done && lro.name && i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    lro = await codeAssist(token, `${CODE_ASSIST}/${lro.name}`, null);
  }
  if (!lro.done) throw new Error('開通（onboardUser）超過 60 秒還沒完成，稍後重跑即可（或貼憑證讓 GAS 端再試）。');
  const project = (lro.response && lro.response.cloudaicompanionProject && lro.response.cloudaicompanionProject.id) || projectHint;
  if (!project) throw new Error(ineligible());
  return { project, tier: tierId, onboarded: true };
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
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, access_token: token.access_token, refresh_token: token.refresh_token, id_token: token.id_token || '',
    expires_at: extra.expires_at || (now + (Number(token.expires_in) || 3600) * 1000), scopes: scopes.length ? scopes : SCOPES,
    email: email || idc.email || '', subject: subject || idc.sub || '', project_id: '', project_hint: projectHint, tier: '', saved_at: new Date(now).toISOString(), account,
  };
  if (!flag('--no-setup')) {
    try {
      const s = await setupCodeAssist(creds.access_token);
      creds.project_id = s.project; creds.tier = s.tier;
      console.log(`Code Assist：${s.onboarded ? '已開通' : '已就緒'}，方案 ${s.tier}，專案 ${s.project}`);
    } catch (err) {
      console.error(`⚠️ Code Assist 開通沒成功：${err.message}\n   憑證仍會印出；GAS 端第一次呼叫會再試一次。`);
    }
  }
  writePrivate(credPath, JSON.stringify(creds, null, 2) + '\n');
  console.log(`\n✅ 登入完成：${creds.email || creds.subject || '(未知帳號)'}`);
  printForPaste(creds);
}

if (flag('--print')) {
  const saved = readJson(credPath);
  if (!saved) { console.error('沒有已存的憑證：' + credPath); process.exit(1); }
  printForPaste(saved);
  process.exit(0);
}

if (flag('--from-cli')) {
  // 沿用 Gemini CLI 自己的憑證（google-auth-library Credentials：access_token / refresh_token / scope / id_token / expiry_date）
  const cliPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
  const cli = readJson(cliPath);
  if (!cli || !cli.refresh_token) { console.error(`找不到可用的 Gemini CLI 憑證（${cliPath}）：先跑一次 gemini 並選 Login with Google，或不加 --from-cli 直接登入。`); process.exit(1); }
  (async () => {
    // access token 可能已過期：先 refresh 一次，順便驗證 refresh token 還活著
    const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: cli.refresh_token });
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    const token = await res.json();
    if (!res.ok || !token.access_token) throw new Error(`Gemini CLI 的 refresh token 換不到新 token（HTTP ${res.status}：${token.error || ''} ${token.error_description || ''}），請改用一般登入。`);
    token.refresh_token = cli.refresh_token;
    token.id_token = token.id_token || cli.id_token || '';
    token.scope = token.scope || cli.scope || '';
    await finish(token, { email: decodeJwt(token.id_token).email || '' });
    process.exit(0);
  })().catch((err) => { console.error('\n✗ ' + (err && err.message || err)); process.exit(1); });
} else {
  // 一般登入：loopback 回呼 + 授權碼
  const state = b64url(crypto.randomBytes(24));
  let redirectUri = '';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, redirectUri);
    const reply = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">${html}</body>`); };
    if (url.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end('not found'); return; }
    try {
      if (url.searchParams.get('state') !== state) throw new Error('state 不符（舊分頁或別的登入嘗試），請用終端機印的網址重開。');
      const error = url.searchParams.get('error');
      if (error) throw new Error(`授權被拒：${error}${url.searchParams.get('error_description') ? ' — ' + url.searchParams.get('error_description') : ''}`);
      const code = url.searchParams.get('code');
      if (!code) throw new Error('回呼沒有 code。');
      const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, redirect_uri: redirectUri });
      const tokenRes = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString() });
      const tokenText = await tokenRes.text();
      let token;
      try { token = JSON.parse(tokenText); } catch (err) { throw new Error(`token 回應不是 JSON（HTTP ${tokenRes.status}）：${tokenText.slice(0, 300)}`); }
      if (!tokenRes.ok || !token.access_token) throw new Error(`換 token 失敗（HTTP ${tokenRes.status}：${token.error || ''}${token.error_description ? ' — ' + token.error_description : ''}${debug ? '\n' + tokenText.slice(0, 1000) : ''}）`);
      if (!token.refresh_token) throw new Error('token 回應沒有 refresh_token：到 https://myaccount.google.com/permissions 移除「Gemini CLI」（或 Gemini Code Assist）的存取權後重跑，同意畫面會重新授權。');
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
  server.listen(port, '127.0.0.1', () => {
    redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
    const params = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state });
    const authUrl = `${AUTHORIZE_URL}?${params.toString()}`;
    console.log(`帳號 ${account}；憑證檔 ${credPath}${projectHint ? '；GCP 專案 ' + projectHint : ''}`);
    console.log('等待瀏覽器完成 Google 登入與同意（請選要用來跑 agent 的 Google 帳號，全部允許）…');
    console.log('若瀏覽器沒自動開啟，手動開這個網址：\n' + authUrl + '\n');
    if (!flag('--no-open')) {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const a = process.platform === 'win32' ? ['/c', 'start', '', authUrl] : [authUrl];
      execFile(cmd, a, () => {});
    }
  });
  server.on('error', (err) => { console.error(`回呼 listener 開不起來（127.0.0.1:${port || '隨機'}）：${err.message}。換 --port 再試。`); process.exit(1); });
}
