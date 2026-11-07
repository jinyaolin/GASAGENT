'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const release = require('../src/release');

const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const manifest = (access) => JSON.stringify({ timeZone: 'Asia/Taipei', oauthScopes: ['a'], webapp: { executeAs: 'USER_DEPLOYING', access: access || 'MYSELF' } }, null, 2);

function fixture() {
  const files = { 'src/appsscript.json': manifest(), 'src/Agent.gs': 'function a() { return 1; }', 'src/admin_js.html': '<b>x</b>' };
  const commit = 'a'.repeat(40);
  const rel = { version: '0.9.0', commit, date: '2026-11-08', notes: 'n', files: {} };
  Object.keys(files).forEach((p) => { rel.files[p] = sha(files[p]); });
  const urls = { [release.rawUrl('r/p', 'main', 'release.json')]: JSON.stringify(rel) };
  Object.keys(files).forEach((p) => { urls[release.rawUrl('r/p', commit, p)] = files[p]; });
  const fetchFn = async (url) => {
    const body = urls[url];
    return { status: body === undefined ? 404 : 200, text: async () => body || '', arrayBuffer: async () => Buffer.from(body || '', 'utf8') };
  };
  return { files, rel, commit, fetchFn, urls };
}

test('parseRelease 驗證', () => {
  const f = fixture();
  const r = release.parseRelease(JSON.stringify(f.rel));
  assert.equal(r.entries.length, 3);
  assert.deepEqual(r.entries.map((e) => e.name + ':' + e.type).sort(), ['Agent:SERVER_JS', 'admin_js:HTML', 'appsscript:JSON']);
  const bad = (mut) => { const x = JSON.parse(JSON.stringify(f.rel)); mut(x); assert.throws(() => release.parseRelease(JSON.stringify(x))); };
  bad((x) => { x.commit = 'abc'; });
  bad((x) => { x.files['README.md'] = sha('x'); });
  bad((x) => { x.files['src/a/b.gs'] = sha('x'); });
  bad((x) => { x.files['src/x.txt'] = sha('x'); });
  bad((x) => { x.files['src/Agent.html'] = sha('x'); });
  bad((x) => { delete x.files['src/appsscript.json']; });
  assert.throws(() => release.parseRelease('{'));
});

test('fetchRelease / fetchFiles 驗 sha256', async () => {
  const f = fixture();
  const r = await release.fetchRelease('r/p', 'main', f.fetchFn);
  assert.equal(r.version, '0.9.0');
  const files = await release.fetchFiles('r/p', r, f.fetchFn);
  assert.deepEqual(files.map((x) => x.name).sort(), ['Agent', 'admin_js', 'appsscript']);
  const tampered = JSON.parse(JSON.stringify(r));
  tampered.entries[1].sha256 = sha('evil');
  await assert.rejects(() => release.fetchFiles('r/p', tampered, f.fetchFn), /sha256 不符/);
  await assert.rejects(() => release.fetchRelease('r/other', 'main', f.fetchFn), /沒有 release.json/);
});

test('withManifestAccess 只改 manifest', () => {
  const f = fixture();
  const files = [{ name: 'appsscript', type: 'JSON', source: manifest() }, { name: 'Agent', type: 'SERVER_JS', source: 'x' }];
  const out = release.withManifestAccess(files, 'ANYONE_ANONYMOUS');
  assert.equal(JSON.parse(out[0].source).webapp.access, 'ANYONE_ANONYMOUS');
  assert.equal(JSON.parse(files[0].source).webapp.access, 'MYSELF');
  assert.equal(out[1], files[1]);
  void f;
});

test('installFresh 順序：建專案 → 灌 MYSELF → 版 → 部署 A → 灌 ANYONE → 版 → 部署 B → 還原', async () => {
  const calls = [];
  let v = 0;
  const api = {
    createProject: async (title) => { calls.push(['createProject', title]); return { scriptId: 'SID' }; },
    updateContent: async (id, files) => { calls.push(['updateContent', JSON.parse(files.find((x) => x.name === 'appsscript').source).webapp.access]); },
    createVersion: async (id, d) => { v += 1; calls.push(['createVersion', v]); return v; },
    createDeployment: async (id, vn, d) => { calls.push(['createDeployment', vn]); return { deploymentId: 'D' + vn }; },
  };
  const files = [{ name: 'appsscript', type: 'JSON', source: manifest() }, { name: 'Agent', type: 'SERVER_JS', source: 'x' }];
  const out = await release.installFresh(api, files, { title: 'GAS Agent', description: 'v1' });
  assert.deepEqual(out, { scriptId: 'SID', versionA: 1, deployA: 'D1', versionB: 2, deployB: 'D2' });
  assert.deepEqual(calls.map((c) => c.join(':')), ['createProject:GAS Agent', 'updateContent:MYSELF', 'createVersion:1', 'createDeployment:1', 'updateContent:ANYONE_ANONYMOUS', 'createVersion:2', 'createDeployment:2', 'updateContent:MYSELF']);
});
