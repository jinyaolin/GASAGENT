'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../src/server');
const { buildConfig } = require('../src/env');
const release = require('../src/release');

const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

/** 假 Google + 假 GitHub + 假 Apps Script API 的 fetch。 */
function fakeWorld() {
  const files = { 'src/appsscript.json': JSON.stringify({ oauthScopes: ['a'], webapp: { executeAs: 'USER_DEPLOYING', access: 'MYSELF' } }), 'src/Agent.gs': 'function a(){}' };
  const commit = 'b'.repeat(40);
  const rel = { version: '0.9.0', commit, files: {} };
  Object.keys(files).forEach((p) => { rel.files[p] = sha(files[p]); });
  const raw = { [release.rawUrl('r/p', 'main', 'release.json')]: JSON.stringify(rel) };
  Object.keys(files).forEach((p) => { raw[release.rawUrl('r/p', commit, p)] = files[p]; });
  const calls = [];
  let version = 0;
  const api = {
    'POST /projects': () => ({ scriptId: 'SID' }),
    'PUT /projects/SID/content': () => ({}),
    'POST /projects/SID/versions': () => { version += 1; return { versionNumber: version }; },
    'POST /projects/SID/deployments': (body) => ({ deploymentId: 'DEP' + body.versionNumber }),
  };
  const json = (status, obj) => ({ status, text: async () => JSON.stringify(obj), json: async () => obj, arrayBuffer: async () => Buffer.from(JSON.stringify(obj)) });
  const fetchFn = async (url, init) => {
    init = init || {};
    calls.push([init.method || 'GET', url]);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const form = new URLSearchParams(init.body);
      if (form.get('code') === 'good') return json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'https://www.googleapis.com/auth/script.projects https://www.googleapis.com/auth/script.deployments' });
      if (form.get('code') === 'noscope') return json(200, { access_token: 'AT', refresh_token: 'RT', scope: 'openid' });
      return json(400, { error: 'invalid_grant' });
    }
    if (url.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) return json(200, { email: 'me@x.com' });
    if (url in raw) return { status: 200, text: async () => raw[url], arrayBuffer: async () => Buffer.from(raw[url], 'utf8') };
    if (url.startsWith('https://raw.githubusercontent.com/')) return { status: 404, text: async () => '', arrayBuffer: async () => Buffer.alloc(0) };
    if (url.startsWith('https://script.googleapis.com/v1')) {
      const key = `${init.method} ${url.slice('https://script.googleapis.com/v1'.length)}`;
      const h = api[key];
      if (!h) return json(404, { error: { message: 'no ' + key } });
      if (world.apiDisabled) return json(403, { error: { message: 'User has not enabled the Apps Script API. Enable it by visiting https://script.google.com/home/usersettings then retry.' } });
      return json(200, h(init.body ? JSON.parse(init.body) : {}));
    }
    return json(404, {});
  };
  const world = { fetchFn, calls, apiDisabled: false };
  return world;
}

async function startApp(world) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));
  const config = buildConfig({ BASE_URL: 'https://example.test/agent', DATA_DIR: dir, GOOGLE_CLIENT_ID: 'CID', GOOGLE_CLIENT_SECRET: 'CSEC', RELEASE_REPO: 'r/p', PORT: '0' });
  const app = createApp({ config, fetch: world.fetchFn, log: () => {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, close: () => new Promise((r) => app.server.close(r)) };
}

test('首頁、start 轉到 Google、state 驗證', async () => {
  const w = fakeWorld();
  const { app, base, close } = await startApp(w);
  try {
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /GAS Agent 安裝/);
    assert.match(html, /v0\.9\.0/);
    assert.match(html, /https:\/\/example\.test\/agent\/install\/start/);
    const start = await fetch(base + '/install/start', { redirect: 'manual' });
    assert.equal(start.status, 302);
    const loc = new URL(start.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(loc.searchParams.get('client_id'), 'CID');
    assert.equal(loc.searchParams.get('redirect_uri'), 'https://example.test/agent/oauth/callback');
    assert.equal(loc.searchParams.get('access_type'), 'offline');
    assert.equal(loc.searchParams.get('prompt'), 'consent');
    assert.match(loc.searchParams.get('scope'), /script\.projects/);
    const state = loc.searchParams.get('state');
    const bad = await fetch(base + '/oauth/callback?code=good&state=nope');
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /已失效/);
    const denied = await fetch(base + `/oauth/callback?error=access_denied&state=${state}`);
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /取消了授權/);
    assert.equal(app.states.take(state), null, 'state 一次性');
  } finally { await close(); }
});

test('install：callback → 建專案 → 頁面有管理頁 / webhook / 取件碼 → pickup 一次性', async () => {
  const w = fakeWorld();
  const { app, base, close } = await startApp(w);
  try {
    const start = await fetch(base + '/install/start', { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cb = await fetch(base + `/oauth/callback?code=good&state=${state}`);
    assert.equal(cb.status, 200);
    const html = await cb.text();
    assert.match(html, /安裝完成/);
    assert.match(html, /me@x\.com/);
    assert.match(html, /https:\/\/script\.google\.com\/macros\/s\/DEP1\/exec/, '管理頁 = 部署 A');
    assert.match(html, /https:\/\/script\.google\.com\/macros\/s\/DEP2\/exec/, 'webhook = 部署 B');
    const m = /\/upgrade code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(html);
    assert.ok(m, '有取件碼');
    const apiCalls = w.calls.filter((c) => c[1].startsWith('https://script.googleapis.com')).map((c) => c[0] + ' ' + c[1].split('/v1')[1]);
    assert.deepEqual(apiCalls, ['POST /projects', 'PUT /projects/SID/content', 'POST /projects/SID/versions', 'POST /projects/SID/deployments', 'PUT /projects/SID/content', 'POST /projects/SID/versions', 'POST /projects/SID/deployments', 'PUT /projects/SID/content']);
    assert.equal(app.pickups.count(), 1);
    const pick = await fetch(base + '/pickup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: m[1].toLowerCase() }) });
    assert.equal(pick.status, 200);
    const bundle = await pick.json();
    assert.deepEqual(bundle, { ok: true, refresh_token: 'RT', client_id: 'CID', client_secret: 'CSEC', email: 'me@x.com', scope: 'https://www.googleapis.com/auth/script.projects https://www.googleapis.com/auth/script.deployments' });
    const again = await fetch(base + '/pickup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: m[1] }) });
    assert.equal(again.status, 404, '領過就沒');
    const h = await (await fetch(base + '/healthz')).json();
    assert.deepEqual(h, { ok: true, pending: 0, configured: true });
  } finally { await close(); }
});

test('login（既有 agent）：只給取件碼、不碰 Apps Script API；缺 scope / 換 token 失敗 / API 未開', async () => {
  const w = fakeWorld();
  const { base, close } = await startApp(w);
  try {
    let start = await fetch(base + '/upgrade/start', { redirect: 'manual' });
    let state = new URL(start.headers.get('location')).searchParams.get('state');
    const cb = await fetch(base + `/oauth/callback?code=good&state=${state}`);
    assert.equal(cb.status, 200);
    const html = await cb.text();
    assert.match(html, /授權完成/);
    assert.match(html, /\/upgrade code [A-Z0-9]{4}-[A-Z0-9]{4}/);
    assert.equal(w.calls.filter((c) => c[1].startsWith('https://script.googleapis.com')).length, 0, 'login 不碰 Apps Script API');

    start = await fetch(base + '/upgrade/start', { redirect: 'manual' });
    state = new URL(start.headers.get('location')).searchParams.get('state');
    const ns = await fetch(base + `/oauth/callback?code=noscope&state=${state}`);
    assert.equal(ns.status, 400);
    assert.match(await ns.text(), /沒有勾選必要權限|refresh token/);

    start = await fetch(base + '/upgrade/start', { redirect: 'manual' });
    state = new URL(start.headers.get('location')).searchParams.get('state');
    const badCode = await fetch(base + `/oauth/callback?code=bad&state=${state}`);
    assert.equal(badCode.status, 400);
    assert.match(await badCode.text(), /換 token 失敗/);

    w.apiDisabled = true;
    start = await fetch(base + '/install/start', { redirect: 'manual' });
    state = new URL(start.headers.get('location')).searchParams.get('state');
    const dis = await fetch(base + `/oauth/callback?code=good&state=${state}`);
    assert.equal(dis.status, 403);
    assert.match(await dis.text(), /usersettings/);
  } finally { await close(); }
});

test('pickup：壞 JSON、404、速率限制', async () => {
  const w = fakeWorld();
  const { base, close } = await startApp(w);
  try {
    assert.equal((await fetch(base + '/pickup', { method: 'POST', body: '{' })).status, 400);
    assert.equal((await fetch(base + '/pickup', { method: 'POST', body: '{"code":"AAAA-BBBB"}' })).status, 404);
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await fetch(base + '/pickup', { method: 'POST', body: '{"code":"AAAA-BBBB"}' })).status;
    assert.equal(last, 429);
    assert.equal((await fetch(base + '/nope')).status, 404);
  } finally { await close(); }
});
