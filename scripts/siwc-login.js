#!/usr/bin/env node
/**
 * Sign in with ChatGPT（SIWC）本機登入：給 GAS Agent 的 protocol=chatgpt provider 用。零依賴（node ≥ 18）。
 * 官方流程：https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 *
 *   node scripts/siwc-login.js [--account <代號>] [--name "GAS Agent"] [--port 1455] [--print] [--reset] [--no-open] [--debug]
 *   --reset：忘掉已核發的 client_id（核發的 client 綁定第一次註冊時選的 ChatGPT 帳號 + 工作區；換帳號 / 工作區登入會被
 *           3p_login_workspace_scope_denied 擋，要重設後重新註冊，且之後每次都選同一個帳號與工作區）
 *
 * 做什麼：
 *   1. 為這個帳號（= 一個 GAS Agent 安裝）產生並保存一個穩定的 ext_agent_host_id（urn:uuid:…）。
 *   2. 在 127.0.0.1:<port>/auth/callback 開一個回呼 listener，用系統瀏覽器開 OpenAI 授權頁：
 *      第一次用 client_id=dynamic_agent_client + agent_name_hint 動態註冊；之後用已核發的 client_id 重新授權。
 *      scope：openid profile email offline_access resource.invoke chatgpt.tokens.use.direct；resource=https://api.openai.com/v1；PKCE S256。
 *   3. 用授權碼換 token，驗 ID token（JWKS 簽章、iss / aud / nonce / exp），確認拿到 chatgpt.tokens.use.direct。
 *   4. 憑證存 ~/.config/gas-agent/siwc/<代號>.json（0600），並印出一段 JSON：複製貼到管理頁「模型」→ 該 provider 的「ChatGPT 憑證」。
 * 之後 GAS 端會自己 refresh；refresh token 30 天沒成功續期就失效，重跑本腳本即可（會沿用 client_id 與 host id）。
 * 條款提醒：只能用在你自己的 ChatGPT 方案與你自己控制的 agent；不要把憑證給別人或共用。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const REQUIRED_SCOPE = 'chatgpt.tokens.use.direct';
const CALLBACK_PATH = '/auth/callback';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : def; };
const flag = (name) => args.indexOf(name) !== -1;
const account = opt('--account', 'default');
const agentName = opt('--name', 'GAS Agent');
const port = Number(opt('--port', '1455'));
if (!/^[a-z0-9][a-z0-9_-]*$/.test(account)) { console.error('--account 只能用小寫字母 / 數字 / - / _'); process.exit(1); }

const dir = path.join(os.homedir(), '.config', 'gas-agent', 'siwc');
const credPath = path.join(dir, `${account}.json`);
const hostPath = path.join(dir, `${account}.host`);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (err) { return null; } };
const writePrivate = (p, text) => { fs.writeFileSync(p + '.tmp', text, { mode: 0o600 }); fs.renameSync(p + '.tmp', p); fs.chmodSync(p, 0o600); };

/** 印出可貼進管理頁的憑證（去掉本機才需要的欄位）。 */
function printForPaste(creds) {
  const paste = {
    client_id: creds.client_id, access_token: creds.access_token, refresh_token: creds.refresh_token, id_token: creds.id_token,
    expires_at: creds.expires_at, scopes: creds.scopes, email: creds.email, subject: creds.subject, ext_agent_host_id: creds.ext_agent_host_id, saved_at: creds.saved_at,
  };
  console.log('\n==== 把下面整段（含大括號）貼到管理頁「模型」→ 編輯 chatgpt provider →「ChatGPT 憑證」====\n');
  console.log(JSON.stringify(paste));
  console.log('\n==== 結束。憑證也存在 ' + credPath + '（0600）；貼完可以留著以便下次重新授權。====');
}

if (flag('--reset')) {
  // 忘掉已核發的 client_id（換 ChatGPT 帳號 / 工作區時用；host id 保留）
  try { fs.unlinkSync(credPath); console.log('已刪除 ' + credPath + '，下次執行會重新動態註冊。'); } catch (err) { console.log('沒有已存的憑證，不用重設。'); }
  process.exit(0);
}

if (flag('--print')) {
  const saved = readJson(credPath);
  if (!saved) { console.error('沒有已存的憑證：' + credPath); process.exit(1); }
  printForPaste(saved);
  process.exit(0);
}

// 1. host id（一個 GAS Agent 安裝 = 一個 host）
let hostId = '';
try { hostId = fs.readFileSync(hostPath, 'utf8').trim(); } catch (err) { hostId = ''; }
if (!/^urn:uuid:[0-9a-f-]{36}$/.test(hostId)) { hostId = 'urn:uuid:' + crypto.randomUUID(); writePrivate(hostPath, hostId + '\n'); }

// 2. 授權。每次嘗試（attempt）有自己的 state / nonce / PKCE；官方文件：第一次動態註冊後若換 token 回 invalid_grant，
//    要丟掉該 code、用剛核發的 client_id 重新授權一次 —— 這裡自動做（最多 3 次），不用使用者重跑。
const saved = readJson(credPath);
let issuedClientId = saved && saved.client_id && saved.client_id !== 'dynamic_agent_client' ? saved.client_id : '';
const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
const debug = flag('--debug');
let attempt = null;
let attempts = 0;

function startAttempt(reason) {
  attempts++;
  attempt = { state: b64url(crypto.randomBytes(24)), nonce: b64url(crypto.randomBytes(24)), verifier: b64url(crypto.randomBytes(48)), clientId: issuedClientId };
  const params = new URLSearchParams({
    client_id: issuedClientId || 'dynamic_agent_client',
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state: attempt.state, nonce: attempt.nonce,
    code_challenge_method: 'S256',
    code_challenge: b64url(crypto.createHash('sha256').update(attempt.verifier).digest()),
  });
  if (!issuedClientId) params.set('agent_name_hint', agentName);
  else {
    if (saved && saved.client_id === issuedClientId && saved.id_token) params.set('id_token_hint', saved.id_token);
    if (saved && saved.client_id === issuedClientId && saved.email) params.set('login_hint', saved.email);
  }
  const authUrl = `${AUTHORIZE_URL}?${params.toString()}`;
  console.log(`\n[第 ${attempts} 次授權] ${reason}`);
  console.log(issuedClientId ? `用已核發的 client ${issuedClientId} 重新授權` : `第一次登入：動態註冊「${agentName}」`);
  console.log('等待瀏覽器完成 OpenAI 登入與同意（請勾選「使用 ChatGPT 方案」）…');
  console.log('若瀏覽器沒自動開啟，手動開這個網址：\n' + authUrl + '\n');
  if (!flag('--no-open')) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const a = process.platform === 'win32' ? ['/c', 'start', '', authUrl] : [authUrl];
    execFile(cmd, a, () => {});
  }
}

/** 記住已核發的 client_id（即使 token 還沒拿到），下次 / 下一輪就用它重新授權。 */
function rememberClient(clientId) {
  issuedClientId = clientId;
  const partial = Object.assign({}, saved || {}, { client_id: clientId, ext_agent_host_id: hostId, account, agent_name: agentName });
  if (!partial.access_token) { delete partial.access_token; delete partial.refresh_token; }
  writePrivate(credPath, JSON.stringify(partial, null, 2) + '\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end('not found'); return; }
  const reply = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">${html}</body>`); };
  const cur = attempt;
  try {
    if (!cur || url.searchParams.get('state') !== cur.state) throw new Error('state 不符（舊分頁或別的登入嘗試），請關掉該分頁；若還在等，用終端機印的網址重開。');
    const error = url.searchParams.get('error');
    if (error) throw new Error(`授權被拒：${error}${url.searchParams.get('error_description') ? ' — ' + url.searchParams.get('error_description') : ''}`);
    const code = url.searchParams.get('code');
    if (!code) throw new Error('回呼沒有 code。');
    let clientId = cur.clientId;
    const cbClient = url.searchParams.get('client_id');
    if (!clientId) {
      if (!cbClient) throw new Error('動態註冊沒有回 client_id，註冊未完成，請重跑。');
      clientId = cbClient;
      rememberClient(clientId);
      console.log(`已核發 client_id：${clientId}`);
    } else if (cbClient && cbClient !== clientId) {
      throw new Error(`回呼的 client_id（${cbClient}）與已存的（${clientId}）不同，拒絕覆蓋；如要換帳號請先刪除 ${credPath}。`);
    }
    if (debug) console.log('callback 參數：' + JSON.stringify(Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'code'))));
    // 3. 換 token
    const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: cur.verifier, redirect_uri: redirectUri, resource: RESOURCE });
    const tokenRes = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString() });
    const tokenText = await tokenRes.text();
    let token;
    try { token = JSON.parse(tokenText); } catch (err) { throw new Error(`token 回應不是 JSON（HTTP ${tokenRes.status}）：${tokenText.slice(0, 300)}`); }
    if (!tokenRes.ok || !token.access_token) {
      const detail = `HTTP ${tokenRes.status}：${token.error || ''}${token.error_description ? ' — ' + token.error_description : ''}${debug ? '\n' + tokenText.slice(0, 1000) : ''}`;
      if (token.error === 'invalid_grant' && attempts < 3) {
        reply(200, `<h2>再授權一次</h2><p>OpenAI 要求用剛核發的 client 重新授權（${detail}）。終端機已重新開啟授權頁，請在新分頁完成；此分頁可關閉。</p>`);
        console.log(`換 token 回 ${detail}；依官方文件改用核發的 client_id 重新授權…`);
        startAttempt('invalid_grant 後重新授權');
        return;
      }
      throw new Error(`換 token 失敗（${detail}）`);
    }
    if (!token.refresh_token) throw new Error('token 回應沒有 refresh_token（offline_access 沒被授與）。');
    const scopes = String(token.scope || '').split(/\s+/).filter(Boolean);
    if (scopes.indexOf(REQUIRED_SCOPE) === -1) throw new Error(`沒有拿到 ${REQUIRED_SCOPE}：同意畫面裡「使用 ChatGPT 方案」沒有勾。請重跑並勾選（或到 ChatGPT 設定 → Apps 允許這個 app 使用方案）。`);
    // 驗 ID token
    const idClaims = await verifyIdToken(token.id_token, clientId, cur.nonce);
    const now = Date.now();
    const creds = {
      email: idClaims.email || '', issuer: ISSUER, subject: idClaims.sub, client_id: clientId, ext_agent_host_id: hostId,
      id_token: token.id_token, access_token: token.access_token, refresh_token: token.refresh_token, token_type: token.token_type || 'Bearer',
      expires_in: token.expires_in || 3600, expires_at: now + (Number(token.expires_in) || 3600) * 1000, scopes, saved_at: new Date(now).toISOString(),
      agent_name: agentName, account,
    };
    writePrivate(credPath, JSON.stringify(creds, null, 2) + '\n');
    reply(200, `<h2>登入完成</h2><p>${creds.email || creds.subject}（client ${clientId}）。回到終端機複製憑證。可以關閉此分頁。</p>`);
    console.log(`\n✅ 登入完成：${creds.email || creds.subject}；client_id ${clientId}；host ${hostId}`);
    printForPaste(creds);
    setTimeout(() => process.exit(0), 200);
  } catch (err) {
    reply(400, `<h2>登入失敗</h2><pre>${String(err && err.message || err).replace(/</g, '&lt;')}</pre>`);
    console.error('\n✗ ' + (err && err.message || err));
    setTimeout(() => process.exit(1), 200);
  }
});

/** 驗 ID token：JWKS 簽章、iss、aud、nonce、exp。 */
async function verifyIdToken(idToken, clientId, expectedNonce) {
  if (!idToken) throw new Error('token 回應沒有 id_token。');
  const [h, p, s] = idToken.split('.');
  if (!h || !p || !s) throw new Error('id_token 格式不對。');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const jwks = await (await fetch(JWKS_URL)).json();
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || (jwks.keys || [])[0];
  if (!jwk) throw new Error('JWKS 裡找不到簽章金鑰。');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const algo = header.alg === 'ES256' ? 'sha256' : 'RSA-SHA256';
  const ok = header.alg === 'ES256'
    ? crypto.verify(algo, Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))
    : crypto.verify(algo, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('id_token 簽章驗證失敗。');
  if (claims.iss !== ISSUER) throw new Error(`id_token iss 不對：${claims.iss}`);
  const aud = [].concat(claims.aud || []);
  if (aud.indexOf(clientId) === -1) throw new Error(`id_token aud 不含 client_id：${aud.join(',')}`);
  if (claims.nonce !== expectedNonce) throw new Error('id_token nonce 不符。');
  if (claims.exp && claims.exp * 1000 < Date.now()) throw new Error('id_token 已過期。');
  return claims;
}

server.listen(port, '127.0.0.1', () => {
  console.log(`帳號 ${account}；host ${hostId}；憑證檔 ${credPath}`);
  startAttempt(issuedClientId ? '沿用已核發的 client' : '第一次登入');
});
server.on('error', (err) => { console.error(`回呼 listener 開不起來（127.0.0.1:${port}）：${err.message}。換 --port 再試。`); process.exit(1); });
