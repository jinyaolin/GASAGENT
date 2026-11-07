'use strict';
/**
 * @fileoverview GAS Agent 安裝 / 升級授權服務（node:http，零依賴）。掛在 Caddy 的 /agent 底下（handle_path 會剝掉前綴，所以這裡的路由沒有 /agent；
 * 對外連結與 OAuth redirect_uri 一律用 BASE_URL 組）。
 *
 *   GET  /                      首頁
 *   GET  /install/start         → Google 授權（mode install）
 *   GET  /upgrade/start         → Google 授權（mode login，既有 agent 取升級授權）
 *   GET  /oauth/callback        Google 回來：換 token → install：建專案 / 灌 release / 建 A B 部署；兩種 mode 都產生取件碼
 *   POST /pickup {code}         agent 領取 {refresh_token, client_id, client_secret, email, scope}（一次性）
 *   GET  /healthz
 *
 * 環境變數（.env）：BASE_URL、GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、HOST、PORT、DATA_DIR、RELEASE_REPO、RELEASE_REF、PICKUP_TTL_HOURS。
 * 服務不保存使用者資料：refresh token 只在 pickups.json 待領最多 PICKUP_TTL_HOURS，領走即刪。
 */
const http = require('node:http');
const { loadEnvFile, buildConfig } = require('./env');
const google = require('./google');
const release = require('./release');
const pages = require('./pages');
const { PickupStore, StateStore, RateLimit } = require('./pickup');

const PRIVACY_URL = 'https://github.com/jinyaolin/GASAGENT/blob/main/PRIVACY.md';

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('body 太大'), { status: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  res.end(html);
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || '';
}

/**
 * @param {{config: !Object, fetch: (Function|undefined), now: (Function|undefined), log: (Function|undefined)}} opts
 * @return {{server: !http.Server, handle: Function, pickups: !PickupStore, states: !StateStore, config: !Object}}
 */
function createApp(opts) {
  const config = opts.config;
  const fetchFn = opts.fetch || fetch;
  const now = opts.now || (() => Date.now());
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), ...a));
  const pickups = new PickupStore(config.dataDir, { now, ttlMs: config.pickupTtlHours * 3600 * 1000 });
  const states = new StateStore({ now });
  const pickupLimit = new RateLimit(20, 60 * 1000, now);
  const startLimit = new RateLimit(30, 60 * 1000, now);
  const redirectUri = config.baseUrl + '/oauth/callback';

  const startAuth = (res, mode, req) => {
    if (!startLimit.hit(clientIp(req))) return sendHtml(res, 429, pages.error({ message: '請求太頻繁，請一分鐘後再試。', retryUrl: config.baseUrl + '/' }));
    const state = states.create({ mode });
    res.writeHead(302, { Location: google.authUrl({ clientId: config.googleClientId, redirectUri, state }), 'Cache-Control': 'no-store' });
    return res.end();
  };

  async function callback(url, res) {
    const retryUrl = config.baseUrl + '/';
    const err = url.searchParams.get('error');
    const st = states.take(url.searchParams.get('state'));
    if (!st) return sendHtml(res, 400, pages.error({ message: '這個授權連結已失效或不是由本頁面發出的（10 分鐘內有效）。', retryUrl }));
    if (err) return sendHtml(res, 400, pages.error({ message: `Google 回報：${err}`, hint: err === 'access_denied' ? '你取消了授權；要安裝 / 升級必須允許存取 Apps Script 專案。' : '', retryUrl }));
    const code = url.searchParams.get('code');
    if (!code) return sendHtml(res, 400, pages.error({ message: 'Google 沒有回傳授權碼。', retryUrl }));
    let token;
    try {
      token = await google.exchangeCode({ clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri, code }, fetchFn);
    } catch (e) {
      return sendHtml(res, 400, pages.error({ message: e.message, retryUrl }));
    }
    const { email } = await google.userInfo(token.access_token, fetchFn);
    const bundle = { refresh_token: token.refresh_token, client_id: config.googleClientId, client_secret: config.googleClientSecret, email, scope: token.scope || '' };
    if (st.mode === 'login') {
      const pcode = pickups.create(bundle);
      log('login ok', email || '(no email)');
      return sendHtml(res, 200, pages.loginDone({ email, code: pcode, ttlHours: config.pickupTtlHours }));
    }
    // install
    const api = google.scriptApi(token.access_token, fetchFn);
    let rel;
    let files;
    try {
      rel = await release.fetchRelease(config.releaseRepo, config.releaseRef, fetchFn);
      files = await release.fetchFiles(config.releaseRepo, rel, fetchFn);
    } catch (e) {
      return sendHtml(res, 502, pages.error({ message: `抓不到程式碼：${e.message}`, retryUrl: config.baseUrl + '/install/start' }));
    }
    let out;
    try {
      out = await release.installFresh(api, files, { title: 'GAS Agent', description: `v${rel.version} (${rel.commit.slice(0, 7)}) 由安裝頁建立` });
    } catch (e) {
      log('install failed', email, e.message);
      const hint = /usersettings/.test(e.message) ? '' : '若已經建了一半，可到 https://script.google.com/home 刪掉剛建的「GAS Agent」專案再重試。';
      return sendHtml(res, e.status === 403 ? 403 : 502, pages.error({ message: e.message, hint, retryUrl: config.baseUrl + '/install/start' }));
    }
    const pcode = pickups.create(bundle);
    log('install ok', email || '(no email)', out.scriptId, `A @${out.versionA} B @${out.versionB}`);
    return sendHtml(res, 200, pages.installed({
      email, scriptId: out.scriptId, editorUrl: google.editorUrl(out.scriptId), adminUrl: google.execUrl(out.deployA), webhookUrl: google.execUrl(out.deployB),
      code: pcode, version: rel.version, ttlHours: config.pickupTtlHours,
    }));
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && p === '/') {
        let version = '?';
        try { version = (await release.fetchRelease(config.releaseRepo, config.releaseRef, fetchFn)).version; } catch (e) { version = '?'; }
        return sendHtml(res, 200, pages.landing({ baseUrl: config.baseUrl, repo: config.releaseRepo, version, privacyUrl: PRIVACY_URL }));
      }
      if (req.method === 'GET' && p === '/install/start') return startAuth(res, 'install', req);
      if (req.method === 'GET' && p === '/upgrade/start') return startAuth(res, 'login', req);
      if (req.method === 'GET' && p === '/oauth/callback') return await callback(url, res);
      if (req.method === 'POST' && p === '/pickup') {
        if (!pickupLimit.hit(clientIp(req))) return sendJson(res, 429, { error: 'too many requests' });
        let body = {};
        try { body = JSON.parse(await readBody(req, 4096) || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad json' }); }
        const bundle = pickups.redeem(body.code);
        if (!bundle) return sendJson(res, 404, { error: '取件碼不存在、已用過或已過期' });
        log('pickup', bundle.email || '(no email)');
        return sendJson(res, 200, Object.assign({ ok: true }, bundle));
      }
      if (req.method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true, pending: pickups.count(), configured: !!(config.googleClientId && config.googleClientSecret) });
      return sendHtml(res, 404, pages.error({ message: `沒有 ${req.method} ${p}。`, retryUrl: config.baseUrl + '/' }));
    } catch (e) {
      log('unhandled', req.method, p, e && e.stack || e);
      if (!res.headersSent) sendHtml(res, e.status || 500, pages.error({ message: e.message || 'internal error', retryUrl: config.baseUrl + '/' }));
      else res.end();
    }
    return undefined;
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.headersTimeout = 60000;
  return { server, handle, pickups, states, config };
}

if (require.main === module) {
  loadEnvFile();
  const config = buildConfig();
  if (!config.googleClientId || !config.googleClientSecret) console.warn('⚠️ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 未設定：授權會失敗。');
  const app = createApp({ config });
  app.server.listen(config.port, config.host, () => {
    console.log(`gas-agent-installer 聽 http://${config.host}:${config.port}（對外 ${config.baseUrl}，資料 ${config.dataDir}）`);
  });
  const shutdown = () => { app.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
