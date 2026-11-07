'use strict';
/**
 * @fileoverview GitHub release（repo 根目錄 release.json，由 scripts/release.sh 產生）→ Apps Script 檔案；與 src/Upgrade.gs 同一套規則：
 * 以 release.json 的 commit 釘住抓 raw 檔、逐檔驗 sha256、只收 src/ 底下的 .gs / .html / appsscript.json。
 * 部署順序也同 deploy.sh：manifest MYSELF → 版本 → 部署 A（管理頁）；manifest ANYONE_ANONYMOUS → 版本 → 部署 B（webhook）；manifest 還原 MYSELF。
 */
const crypto = require('node:crypto');

const FILE_TYPES = { gs: 'SERVER_JS', html: 'HTML', json: 'JSON' };
const SRC_PREFIX = 'src/';
const MANIFEST = 'appsscript';
const ACCESS_ADMIN = 'MYSELF';
const ACCESS_WEBHOOK = 'ANYONE_ANONYMOUS';

function rawUrl(repo, ref, path) {
  return `https://raw.githubusercontent.com/${repo}/${ref}/${String(path).split('/').map(encodeURIComponent).join('/')}`;
}

/** src/<path> → {name, type}。 */
function gasName(path) {
  const p = String(path || '');
  if (!p.startsWith(SRC_PREFIX)) throw new Error(`release.json 的「${p}」不在 src/ 底下`);
  const rest = p.slice(SRC_PREFIX.length);
  if (!rest || rest.includes('/')) throw new Error(`release.json 的「${p}」路徑不合法`);
  const m = /^(.+)\.([A-Za-z0-9]+)$/.exec(rest);
  const type = m ? FILE_TYPES[m[2].toLowerCase()] : '';
  if (!type) throw new Error(`release.json 的「${p}」副檔名不支援`);
  if (type === 'JSON' && m[1] !== MANIFEST) throw new Error(`release.json 的「${p}」：JSON 只接受 appsscript.json`);
  return { name: m[1], type };
}

/**
 * 解析並驗證 release.json。純函式。
 * @param {string} text
 * @return {{version: string, commit: string, date: string, notes: string, entries: !Array<{path: string, name: string, type: string, sha256: string}>}}
 */
function parseRelease(text) {
  let o;
  try { o = JSON.parse(String(text || '')); } catch (err) { throw new Error('release.json 不是合法 JSON'); }
  const version = String(o && o.version || '').trim();
  const commit = String(o && o.commit || '').trim().toLowerCase();
  if (!version) throw new Error('release.json 缺 version');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('release.json 的 commit 必須是 40 碼 sha');
  const files = o.files && typeof o.files === 'object' && !Array.isArray(o.files) ? o.files : null;
  if (!files || !Object.keys(files).length) throw new Error('release.json 缺 files');
  const seen = new Map();
  const entries = Object.keys(files).sort().map((path) => {
    const g = gasName(path);
    const sha256 = String(files[path] || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`release.json 的「${path}」sha256 不合法`);
    const key = g.name.toLowerCase();
    if (seen.has(key)) throw new Error(`release.json 有兩個檔案在 Apps Script 會同名：${seen.get(key)} 與 ${path}`);
    seen.set(key, path);
    return { path, name: g.name, type: g.type, sha256 };
  });
  if (!entries.some((e) => e.type === 'JSON')) throw new Error('release.json 缺 src/appsscript.json');
  return { version, commit, date: String(o.date || ''), notes: String(o.notes || '').slice(0, 2000), entries };
}

/**
 * @param {string} repo
 * @param {string} ref
 * @param {Function=} fetchFn
 * @return {Promise<!Object>} parseRelease 的結果
 */
async function fetchRelease(repo, ref, fetchFn) {
  const res = await (fetchFn || fetch)(rawUrl(repo, ref, 'release.json'), { headers: { 'Cache-Control': 'no-cache' } });
  if (res.status === 404) throw new Error(`${repo}@${ref} 沒有 release.json（還沒發佈過 release）`);
  if (res.status !== 200) throw new Error(`抓 release.json 失敗：HTTP ${res.status}`);
  return parseRelease(await res.text());
}

/**
 * 以 commit 釘住抓全部檔案並驗 sha256。
 * @param {string} repo
 * @param {!Object} release
 * @param {Function=} fetchFn
 * @return {Promise<!Array<{name: string, type: string, source: string}>>}
 */
async function fetchFiles(repo, release, fetchFn) {
  const f = fetchFn || fetch;
  const bad = [];
  const files = [];
  for (let i = 0; i < release.entries.length; i += 10) {
    const slice = release.entries.slice(i, i + 10);
    const results = await Promise.all(slice.map(async (e) => {
      const res = await f(rawUrl(repo, release.commit, e.path));
      if (res.status !== 200) return { e, error: `HTTP ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (sha !== e.sha256) return { e, error: `sha256 不符（${sha.slice(0, 12)}…）` };
      return { e, source: buf.toString('utf8') };
    }));
    results.forEach((r) => { if (r.error) bad.push(`${r.e.path}：${r.error}`); else files.push({ name: r.e.name, type: r.e.type, source: r.source }); });
  }
  if (bad.length) throw new Error(`檔案驗證失敗（${bad.length}）：${bad.slice(0, 5).join('；')}`);
  return files;
}

/** 回新的檔案陣列，manifest 的 webapp.access 改成指定值。純函式。 */
function withManifestAccess(files, access) {
  return files.map((x) => {
    if (x.type !== 'JSON' || x.name !== MANIFEST) return x;
    const m = JSON.parse(x.source);
    m.webapp = Object.assign({ executeAs: 'USER_DEPLOYING' }, m.webapp || {}, { access });
    return { name: x.name, type: x.type, source: JSON.stringify(m, null, 2) };
  });
}

/**
 * 全新安裝：建專案 → 灌檔 → 建版 → 建部署 A（MYSELF）→ 翻 manifest → 建版 → 建部署 B（ANYONE）→ manifest 還原。
 * @param {!Object} api google.scriptApi
 * @param {!Array<{name: string, type: string, source: string}>} files
 * @param {{title: string, description: string}} o
 * @return {Promise<{scriptId: string, versionA: number, deployA: string, versionB: number, deployB: string}>}
 */
async function installFresh(api, files, o) {
  const adminFiles = withManifestAccess(files, ACCESS_ADMIN);
  const { scriptId } = await api.createProject(o.title);
  await api.updateContent(scriptId, adminFiles);
  const versionA = await api.createVersion(scriptId, o.description);
  const a = await api.createDeployment(scriptId, versionA, `${o.description} — A 管理頁（只限我）`);
  await api.updateContent(scriptId, withManifestAccess(files, ACCESS_WEBHOOK));
  const versionB = await api.createVersion(scriptId, `${o.description}（webhook）`);
  const b = await api.createDeployment(scriptId, versionB, `${o.description} — B Telegram webhook（任何人）`);
  await api.updateContent(scriptId, adminFiles);
  return { scriptId, versionA, deployA: a.deploymentId, versionB, deployB: b.deploymentId };
}

module.exports = { rawUrl, gasName, parseRelease, fetchRelease, fetchFiles, withManifestAccess, installFresh, ACCESS_ADMIN, ACCESS_WEBHOOK };
