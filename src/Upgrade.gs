/**
 * @fileoverview 程式自我升級（Telegram `/upgrade`）與回滾。
 *
 * 流程（都在 owner 的 Apps Script 專案裡自己完成，不需要維護者的 clasp 登入）：
 *   1. `/upgrade`：抓 GitHub repo 的 release.json（版本、code commit、每個 src/ 檔的 sha256、說明），和 APP_VERSION 比對；
 *      順手預檢：Apps Script API 有沒有開、找得到部署 A（只限我）/ B（任何人）、新 manifest 的 OAuth scope 有沒有變。
 *      有新版且沒有阻擋就寫一筆 Approvals（tool = system_upgrade），附批准 / 拒絕按鈕。
 *   2. owner 批准 → decideApproval_ 不走 executeTool_，改 enqueue 一個 type=upgrade 的 job（下一分鐘 queueTick 在 lock 內執行）。
 *   3. runUpgradeJob_：再抓一次 release.json 確認 commit 沒變 → 以 commit 釘住抓全部檔案（raw.githubusercontent）並逐檔驗 sha256
 *      → 語法預檢（new Function）→ scope 沒新增 → 把目前程式備份成 Drive「GAS Agent/upgrades」的 JSON
 *      → Apps Script API：updateContent（manifest MYSELF）→ versions.create → deployments.update A
 *        → updateContent（manifest ANYONE_ANONYMOUS）→ versions.create → deployments.update B → updateContent（MYSELF，HEAD 還原）
 *      → 寫 UPGRADE_LAST / UPGRADE_POST_INSTALL、AuditLog security:upgrade、Telegram 通知。
 *   4. 下一分鐘的 queueTick 已是新程式：看到 UPGRADE_POST_INSTALL 就跑 installAgent()（補 tab / trigger / 預設值）+ Doctor，結果推 Telegram。
 *   5. `/upgrade rollback`：同樣審批 → job 以 Drive 備份的檔案走同一套部署流程還原。
 *
 * 安全：repo / ref 只能在 Script Properties 改（UPGRADE_REPO / UPGRADE_REF，預設 jinyaolin/GASAGENT main），Telegram 不能改；
 * 只有白名單（owner）能 `/upgrade`；審批訊息顯示 commit；檔案 hash 必須和 release.json 一致；新版多要 OAuth scope 時拒絕自動升級
 * （trigger 會因未授權而失敗），要維護者用 deploy.sh 推並在編輯器重新授權。
 *
 * 前置（每個帳號一次）：manifest 要有 script.projects / script.deployments 兩個 scope（已列在 appsscript.json）；
 * 帳號主人到 https://script.google.com/home/usersettings 打開「Google Apps Script API」。Doctor「程式升級」會檢查。
 */

/** Approvals.tool 欄的值（不是真的工具，decideApproval_ 特判）。 */
const UPGRADE_TOOL = 'system_upgrade';
/** Approvals.reason 前綴；enqueueApprovalContinuation_ 看到就不續跑。 */
const UPGRADE_REASON_PREFIX = '程式升級';
/** Queue job type。 */
const UPGRADE_JOB_TYPE = 'upgrade';
/** 預設來源 repo（owner/name）與 ref（分支或 tag）。 */
const UPGRADE_DEFAULT_REPO = 'jinyaolin/GASAGENT';
const UPGRADE_DEFAULT_REF = 'main';
/** repo 根目錄的 release 清單檔。 */
const UPGRADE_RELEASE_FILE = 'release.json';
/** release.json 只接受這個資料夾底下的檔案。 */
const UPGRADE_SRC_PREFIX = 'src/';
/** 副檔名 → Apps Script 檔案型別。 */
const UPGRADE_FILE_TYPES = Object.freeze({ gs: 'SERVER_JS', html: 'HTML', json: 'JSON' });
/** manifest 在 Apps Script 裡的檔名。 */
const UPGRADE_MANIFEST_NAME = 'appsscript';
/** 備份資料夾與保留份數。 */
const UPGRADE_BACKUP_FOLDER_PATH = Object.freeze(['GAS Agent', 'upgrades']);
const UPGRADE_BACKUP_KEEP = 5;
/** Apps Script API。 */
const SCRIPT_API_BASE = 'https://script.googleapis.com/v1';
const SCRIPT_API_ENABLE_URL = 'https://script.google.com/home/usersettings';
/** 兩個部署的 webapp.access。 */
const UPGRADE_ACCESS_ADMIN = 'MYSELF';
const UPGRADE_ACCESS_WEBHOOK = 'ANYONE_ANONYMOUS';

// ---- 來源與 release.json ------------------------------------------------------------------------

/**
 * 升級來源：Script Properties 的 UPGRADE_REPO / UPGRADE_REF，沒設用預設。
 * @param {{getProp: (Function|undefined)}=} deps
 * @return {{repo: string, ref: string}}
 * @throws {Error} repo 格式不對
 */
function upgradeSource_(deps) {
  const get = (deps && deps.getProp) || getProp_;
  const repo = String(get(PROP.UPGRADE_REPO) || UPGRADE_DEFAULT_REPO).trim();
  const ref = String(get(PROP.UPGRADE_REF) || UPGRADE_DEFAULT_REF).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`UPGRADE_REPO「${repo}」格式不對，應為 owner/name。`);
  if (!/^[A-Za-z0-9_.\/-]+$/.test(ref) || ref.indexOf('..') !== -1) throw new Error(`UPGRADE_REF「${ref}」格式不對。`);
  return { repo, ref };
}

/**
 * raw.githubusercontent 的檔案 URL。
 * @param {string} repo
 * @param {string} ref 分支 / tag / commit
 * @param {string} path
 * @return {string}
 */
function upgradeRawUrl_(repo, ref, path) {
  return `https://raw.githubusercontent.com/${repo}/${ref}/${String(path).split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * 位元組 → sha256 hex。
 * @param {!Array<number>} bytes
 * @return {string}
 */
function upgradeSha256Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map((b) => ((b & 0xff) < 16 ? '0' : '') + (b & 0xff).toString(16)).join('');
}

/**
 * src/<path> → Apps Script 檔名與型別。純函式。
 * @param {string} path
 * @return {{name: string, type: string}}
 * @throws {Error} 不在 src/、子資料夾、副檔名不支援
 */
function upgradeGasName_(path) {
  const p = String(path || '');
  if (p.indexOf(UPGRADE_SRC_PREFIX) !== 0) throw new Error(`release.json 的檔案「${p}」不在 ${UPGRADE_SRC_PREFIX} 底下。`);
  const rest = p.slice(UPGRADE_SRC_PREFIX.length);
  if (!rest || rest.indexOf('/') !== -1) throw new Error(`release.json 的檔案「${p}」路徑不合法（不支援子資料夾）。`);
  const m = /^(.+)\.([A-Za-z0-9]+)$/.exec(rest);
  const type = m ? UPGRADE_FILE_TYPES[m[2].toLowerCase()] : '';
  if (!type) throw new Error(`release.json 的檔案「${p}」副檔名不支援（只接受 .gs / .html / .json）。`);
  if (type === 'JSON' && m[1] !== UPGRADE_MANIFEST_NAME) throw new Error(`release.json 的檔案「${p}」：JSON 只接受 appsscript.json。`);
  return { name: m[1], type };
}

/**
 * 解析並驗證 release.json。純函式。
 * 格式：{ version, commit (40 hex), date, notes, files: { "src/Agent.gs": "<sha256 hex>", … } }
 * @param {string} text
 * @return {{version: string, commit: string, date: string, notes: string, files: !Object<string, string>, entries: !Array<{path: string, name: string, type: string, sha256: string}>}}
 * @throws {Error}
 */
function upgradeParseRelease_(text) {
  let o;
  try { o = JSON.parse(String(text || '')); } catch (err) { throw new Error('release.json 不是合法 JSON。'); }
  if (!o || typeof o !== 'object') throw new Error('release.json 不是物件。');
  const version = String(o.version || '').trim();
  const commit = String(o.commit || '').trim().toLowerCase();
  if (!version || version.length > 40) throw new Error('release.json 缺 version。');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('release.json 的 commit 必須是 40 碼 sha。');
  const files = o.files && typeof o.files === 'object' && !Array.isArray(o.files) ? o.files : null;
  if (!files || !Object.keys(files).length) throw new Error('release.json 缺 files。');
  const entries = [];
  const seen = {};
  Object.keys(files).sort().forEach((path) => {
    const g = upgradeGasName_(path);
    const sha = String(files[path] || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`release.json 的「${path}」sha256 不合法。`);
    const key = g.name.toLowerCase();
    if (seen[key]) throw new Error(`release.json 有兩個檔案在 Apps Script 會同名：「${seen[key]}」與「${path}」。`);
    seen[key] = path;
    entries.push({ path, name: g.name, type: g.type, sha256: sha });
  });
  if (!entries.some((e) => e.type === 'JSON')) throw new Error('release.json 缺 src/appsscript.json。');
  if (!entries.some((e) => e.type === 'SERVER_JS')) throw new Error('release.json 沒有任何 .gs 檔。');
  return { version, commit, date: String(o.date || ''), notes: String(o.notes || '').slice(0, 2000), files, entries };
}

/**
 * 版本比較（"0.8.0" / "0.7.0-m7a"）：數字段逐段比，再比尾碼字串。純函式。
 * @param {string} a
 * @param {string} b
 * @return {number} a<b → -1；相同 → 0；a>b → 1
 */
function upgradeCompareVersion_(a, b) {
  const sa = String(a || '').trim();
  const sb = String(b || '').trim();
  if (sa === sb) return 0;
  const split = (s) => { const m = /^v?(\d+(?:\.\d+)*)(.*)$/.exec(s); return m ? { nums: m[1].split('.').map(Number), tail: m[2] } : { nums: [], tail: s }; };
  const pa = split(sa);
  const pb = split(sb);
  const n = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < n; i++) {
    const x = pa.nums[i] || 0;
    const y = pb.nums[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.tail === pb.tail) return 0;
  // 有尾碼（pre-release 類）排在沒尾碼前面
  if (!pa.tail) return 1;
  if (!pb.tail) return -1;
  return pa.tail < pb.tail ? -1 : 1;
}

/**
 * 抓 release.json。
 * @param {{repo: string, ref: string}} source
 * @param {{fetch: (Function|undefined)}=} deps fetch(url, params) → HTTPResponse
 * @return {{release: !Object, url: string}}
 * @throws {Error}
 */
function upgradeFetchRelease_(source, deps) {
  const fetch = (deps && deps.fetch) || ((url, params) => UrlFetchApp.fetch(url, params));
  const url = upgradeRawUrl_(source.repo, source.ref, UPGRADE_RELEASE_FILE);
  const res = fetch(url, { muteHttpExceptions: true, followRedirects: true });
  const code = res.getResponseCode();
  if (code === 404) throw new Error(`${source.repo}@${source.ref} 沒有 ${UPGRADE_RELEASE_FILE}（還沒發佈過 release）。`);
  if (code !== 200) throw new Error(`抓 ${UPGRADE_RELEASE_FILE} 失敗：HTTP ${code}。`);
  return { release: upgradeParseRelease_(res.getContentText()), url };
}

/**
 * 以 commit 釘住抓 release 列的全部檔案並逐檔驗 sha256 → Apps Script 檔案陣列。
 * @param {{repo: string}} source
 * @param {!Object} release upgradeParseRelease_ 的結果
 * @param {{fetchAll: (Function|undefined)}=} deps fetchAll(requests) → HTTPResponse[]
 * @return {!Array<{name: string, type: string, source: string}>}
 * @throws {Error} 任一檔抓不到或 hash 不符
 */
function upgradeFetchFiles_(source, release, deps) {
  const fetchAll = (deps && deps.fetchAll) || ((reqs) => UrlFetchApp.fetchAll(reqs));
  const reqs = release.entries.map((e) => ({ url: upgradeRawUrl_(source.repo, release.commit, e.path), muteHttpExceptions: true, followRedirects: true }));
  const files = [];
  const bad = [];
  // 一次最多 20 個併發，避免被 CDN 拒
  for (let i = 0; i < reqs.length; i += 20) {
    const slice = reqs.slice(i, i + 20);
    const responses = fetchAll(slice);
    responses.forEach((res, j) => {
      const e = release.entries[i + j];
      const code = res.getResponseCode();
      if (code !== 200) { bad.push(`${e.path}：HTTP ${code}`); return; }
      const bytes = res.getContent();
      const sha = upgradeSha256Hex_(bytes);
      if (sha !== e.sha256) { bad.push(`${e.path}：sha256 不符（release.json ${e.sha256.slice(0, 12)}…，抓到 ${sha.slice(0, 12)}…）`); return; }
      files.push({ name: e.name, type: e.type, source: res.getContentText() });
    });
  }
  if (bad.length) throw new Error(`檔案驗證失敗（${bad.length}）：\n${bad.slice(0, 8).join('\n')}${bad.length > 8 ? '\n…' : ''}`);
  return files;
}

// ---- 預檢（純函式） --------------------------------------------------------------------------------

/**
 * 從檔案陣列取 manifest 物件。
 * @param {!Array<{name: string, type: string, source: string}>} files
 * @return {!Object}
 * @throws {Error} 缺 manifest 或不是 JSON
 */
function upgradeManifestOf_(files) {
  const f = (files || []).find((x) => x.type === 'JSON' && x.name === UPGRADE_MANIFEST_NAME);
  if (!f) throw new Error('檔案裡沒有 appsscript.json。');
  try { return JSON.parse(f.source); } catch (err) { throw new Error('appsscript.json 不是合法 JSON。'); }
}

/**
 * 回一份新的檔案陣列，manifest 的 webapp.access 改成指定值（其他檔案原樣）。純函式。
 * @param {!Array<{name: string, type: string, source: string}>} files
 * @param {string} access MYSELF / ANYONE_ANONYMOUS
 * @return {!Array<{name: string, type: string, source: string}>}
 */
function upgradeWithManifestAccess_(files, access) {
  return files.map((f) => {
    if (f.type !== 'JSON' || f.name !== UPGRADE_MANIFEST_NAME) return f;
    const m = JSON.parse(f.source);
    m.webapp = Object.assign({ executeAs: 'USER_DEPLOYING' }, m.webapp || {}, { access });
    return { name: f.name, type: f.type, source: JSON.stringify(m, null, 2) };
  });
}

/**
 * 兩份 manifest 的 oauthScopes 差異。純函式。
 * @param {!Object} oldManifest
 * @param {!Object} newManifest
 * @return {{added: !Array<string>, removed: !Array<string>}}
 */
function upgradeScopeDiff_(oldManifest, newManifest) {
  const a = toStringList_((oldManifest || {}).oauthScopes);
  const b = toStringList_((newManifest || {}).oauthScopes);
  return { added: b.filter((s) => a.indexOf(s) === -1), removed: a.filter((s) => b.indexOf(s) === -1) };
}

/**
 * 語法預檢：每個 .gs 丟進 new Function 看能不能解析（不執行）。純函式。
 * @param {!Array<{name: string, type: string, source: string}>} files
 * @return {!Array<string>} 錯誤列表（空 = 通過）
 */
function upgradeSyntaxCheck_(files) {
  const errors = [];
  (files || []).forEach((f) => {
    if (f.type === 'SERVER_JS') {
      try { new Function(f.source); } catch (err) { errors.push(`${f.name}.gs：${err && err.message || err}`); } // eslint-disable-line no-new-func
    } else if (f.type === 'JSON') {
      try { JSON.parse(f.source); } catch (err) { errors.push(`${f.name}.json：${err && err.message || err}`); }
    }
  });
  return errors;
}

/**
 * 從 deployments.list 的結果挑出部署 A（webapp access MYSELF）與 B（ANYONE_ANONYMOUS）；@HEAD（沒有 versionNumber）略過。
 * 純函式。可用 overrides {a, b} 指定部署 id（Script Properties UPGRADE_DEPLOY_A / B）。
 * @param {!Array<!Object>} deployments
 * @param {{a: (string|undefined), b: (string|undefined)}=} overrides
 * @return {{a: {id: string, version: number, access: string}, b: ?{id: string, version: number, access: string}}}
 * @throws {Error} 找不到 A 或有多個候選
 */
function upgradeSelectDeployments_(deployments, overrides) {
  overrides = overrides || {};
  const items = (deployments || []).map((d) => {
    const cfg = d.deploymentConfig || {};
    const ep = (d.entryPoints || []).find((e) => e.entryPointType === 'WEB_APP') || null;
    const access = ep && ep.webApp && ep.webApp.entryPointConfig ? String(ep.webApp.entryPointConfig.access || '') : '';
    return { id: String(d.deploymentId || ''), version: Number(cfg.versionNumber || 0), access, description: String(cfg.description || '') };
  }).filter((d) => d.id && d.version > 0);
  const pick = (want, override, label) => {
    if (override) {
      const hit = items.find((d) => d.id === override);
      if (!hit) throw new Error(`Script Property 指定的${label} ${override} 不在部署清單裡。`);
      return hit;
    }
    const c = items.filter((d) => d.access === want);
    if (c.length > 1) throw new Error(`有 ${c.length} 個 webapp.access=${want} 的部署，分不出${label}；請把要更新的部署 id 寫到 Script Property UPGRADE_DEPLOY_${label === '部署 A' ? 'A' : 'B'}。`);
    return c[0] || null;
  };
  const a = pick(UPGRADE_ACCESS_ADMIN, overrides.a, '部署 A');
  if (!a) throw new Error('找不到部署 A（webapp.access=MYSELF 的版本部署）。');
  const b = pick(UPGRADE_ACCESS_WEBHOOK, overrides.b, '部署 B');
  if (b && b.id === a.id) throw new Error('部署 A 與 B 是同一個部署 id。');
  return { a, b };
}

// ---- Apps Script API --------------------------------------------------------------------------------

/**
 * Apps Script API 包裝。全部方法 throw 友善訊息；API 未啟用會提示去 usersettings 開。
 * @param {{fetch: (Function|undefined), token: (Function|undefined)}=} deps
 * @return {{getContent: Function, updateContent: Function, createVersion: Function, listDeployments: Function, updateDeployment: Function}}
 */
function scriptApi_(deps) {
  deps = deps || {};
  const fetch = deps.fetch || ((url, params) => UrlFetchApp.fetch(url, params));
  const token = deps.token || (() => ScriptApp.getOAuthToken());
  const call = (method, path, body) => {
    const params = { method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token() } };
    if (body !== undefined) { params.contentType = 'application/json'; params.payload = JSON.stringify(body); }
    const res = fetch(SCRIPT_API_BASE + path, params);
    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code >= 200 && code < 300) return text ? JSON.parse(text) : {};
    throw new Error(scriptApiErrorMessage_(code, text));
  };
  return {
    /** @return {{files: !Array<{name: string, type: string, source: string}>}} */
    getContent: (scriptId) => call('get', `/projects/${encodeURIComponent(scriptId)}/content`),
    /** 整組覆寫（沒列的檔會被刪）。 */
    updateContent: (scriptId, files) => call('put', `/projects/${encodeURIComponent(scriptId)}/content`, { files: files.map((f) => ({ name: f.name, type: f.type, source: f.source })) }),
    /** @return {number} versionNumber */
    createVersion: (scriptId, description) => Number(call('post', `/projects/${encodeURIComponent(scriptId)}/versions`, { description: String(description || '').slice(0, 200) }).versionNumber || 0),
    /** @return {!Array<!Object>} */
    listDeployments: (scriptId) => {
      const out = [];
      let pageToken = '';
      do {
        const r = call('get', `/projects/${encodeURIComponent(scriptId)}/deployments?pageSize=50${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
        (r.deployments || []).forEach((d) => out.push(d));
        pageToken = String(r.nextPageToken || '');
      } while (pageToken && out.length < 500);
      return out;
    },
    updateDeployment: (scriptId, deploymentId, versionNumber, description) => call('put', `/projects/${encodeURIComponent(scriptId)}/deployments/${encodeURIComponent(deploymentId)}`,
      { deploymentConfig: { scriptId, versionNumber, manifestFileName: UPGRADE_MANIFEST_NAME, description: String(description || '').slice(0, 200) } }),
  };
}

/**
 * Apps Script API 錯誤 → 中文訊息。純函式。
 * @param {number} code
 * @param {string} text
 * @return {string}
 */
function scriptApiErrorMessage_(code, text) {
  let msg = '';
  try { const o = JSON.parse(text); msg = String(o.error && o.error.message || ''); } catch (err) { msg = String(text || '').slice(0, 300); }
  if (code === 403 && /Apps Script API has not been used|has not enabled the Apps Script API|not enabled|PERMISSION_DENIED/i.test(msg + text)) {
    return `Apps Script API 尚未啟用或沒權限：請帳號主人到 ${SCRIPT_API_ENABLE_URL} 打開「Google Apps Script API」（Workspace 帳號可能要管理員允許），然後重新授權一次（編輯器執行 installAgent()）。原始訊息：${msg.slice(0, 200)}`;
  }
  if (code === 401) return `Apps Script API 拒絕 token（401）：manifest 可能還沒有 script.projects / script.deployments scope，請在編輯器執行 installAgent() 重新授權。${msg.slice(0, 200)}`;
  return `Apps Script API 回應 ${code}：${msg || '(無訊息)'}`;
}

// ---- 檢查與提案 --------------------------------------------------------------------------------------

/**
 * 升級目前狀態（/upgrade status、Doctor）。
 * @param {{getProp: (Function|undefined)}=} deps
 * @return {{version: string, source: {repo: string, ref: string}, sourceError: string, last: ?Object, backup: ?Object}}
 */
function upgradeStatus_(deps) {
  const get = (deps && deps.getProp) || getProp_;
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (err) { return null; } };
  let source = { repo: UPGRADE_DEFAULT_REPO, ref: UPGRADE_DEFAULT_REF };
  let sourceError = '';
  try { source = upgradeSource_(deps); } catch (err) { sourceError = String(err && err.message || err); }
  return { version: APP_VERSION, source, sourceError, last: parse(get(PROP.UPGRADE_LAST)), backup: parse(get(PROP.UPGRADE_BACKUP)) };
}

/**
 * 狀態文字。純函式。
 * @param {{version: string, source: Object, sourceError: string, last: ?Object, backup: ?Object}} st
 * @return {string}
 */
function upgradeStatusText_(st) {
  const lines = [`📦 目前版本 v${st.version}；來源 ${st.source.repo}@${st.source.ref}${st.sourceError ? '（設定有誤：' + st.sourceError + '）' : ''}`];
  if (st.last) lines.push(`上次${st.last.action === 'rollback' ? '回滾' : '升級'}：${st.last.at || '?'} v${st.last.from || '?'} → v${st.last.version || '?'}${st.last.commit ? '（' + String(st.last.commit).slice(0, 7) + '）' : ''}${st.last.versionA ? `，部署 A @${st.last.versionA}${st.last.versionB ? ' / B @' + st.last.versionB : ''}` : ''}`);
  else lines.push('尚未透過 /upgrade 升級過。');
  lines.push(st.backup ? `可回滾到：v${st.backup.version || '?'}（備份於 ${st.backup.at || '?'}，/upgrade rollback）` : '沒有可回滾的備份。');
  return lines.join('\n');
}

/**
 * /upgrade 的檢查 + 預檢：抓 release.json、比版本、看 Apps Script API / 部署 / scope。不寫任何東西。
 * @param {{fetch: (Function|undefined), fetchAll: (Function|undefined), api: (Object|undefined), scriptId: (string|undefined),
 *   getProp: (Function|undefined), currentVersion: (string|undefined)}=} deps
 * @return {{ok: boolean, upToDate: boolean, current: string, source: Object, latest: ?Object, blockers: !Array<string>,
 *   warnings: !Array<string>, deployments: ?Object, scopes: ?{added: !Array<string>, removed: !Array<string>}, text: string}}
 */
function upgradePlan_(deps) {
  deps = deps || {};
  const current = deps.currentVersion || APP_VERSION;
  const plan = { ok: false, upToDate: false, current, source: null, latest: null, blockers: [], warnings: [], deployments: null, scopes: null, text: '' };
  try {
    plan.source = upgradeSource_(deps);
  } catch (err) {
    plan.blockers.push(String(err && err.message || err));
    plan.text = upgradePlanText_(plan);
    return plan;
  }
  let release;
  try {
    release = upgradeFetchRelease_(plan.source, deps).release;
    plan.latest = { version: release.version, commit: release.commit, date: release.date, notes: release.notes, fileCount: release.entries.length };
  } catch (err) {
    plan.blockers.push(String(err && err.message || err));
    plan.text = upgradePlanText_(plan);
    return plan;
  }
  const cmp = upgradeCompareVersion_(release.version, current);
  if (cmp === 0) { plan.upToDate = true; plan.ok = true; plan.text = upgradePlanText_(plan); return plan; }
  if (cmp < 0) plan.warnings.push(`release 的 v${release.version} 比目前的 v${current} 舊（降版）。`);
  // Apps Script API：部署清單 + 目前 manifest
  const api = deps.api || scriptApi_(deps);
  const scriptId = deps.scriptId || ScriptApp.getScriptId();
  try {
    plan.deployments = upgradeSelectDeployments_(api.listDeployments(scriptId), { a: (deps.getProp || getProp_)(PROP.UPGRADE_DEPLOY_A), b: (deps.getProp || getProp_)(PROP.UPGRADE_DEPLOY_B) });
    if (!plan.deployments.b) plan.warnings.push('沒有部署 B（Telegram webhook），只會更新部署 A。');
  } catch (err) {
    plan.blockers.push(String(err && err.message || err));
  }
  if (!plan.blockers.length) {
    try {
      const currentManifest = upgradeManifestOf_(api.getContent(scriptId).files || []);
      const entry = release.entries.find((e) => e.type === 'JSON');
      const only = Object.assign({}, release, { entries: [entry] });
      const newManifest = upgradeManifestOf_(upgradeFetchFiles_(plan.source, only, deps));
      plan.scopes = upgradeScopeDiff_(currentManifest, newManifest);
      if (plan.scopes.added.length) plan.blockers.push(`新版需要新的 OAuth scope（${plan.scopes.added.join('、')}），自動升級後 trigger 會因未授權而失敗；這版請由維護者用 deploy.sh 推送，並在編輯器執行 installAgent() 重新授權。`);
      if (plan.scopes.removed.length) plan.warnings.push(`新版不再需要 scope：${plan.scopes.removed.join('、')}。`);
    } catch (err) {
      plan.blockers.push(String(err && err.message || err));
    }
  }
  plan.ok = !plan.blockers.length;
  plan.text = upgradePlanText_(plan);
  return plan;
}

/**
 * 計畫 → Telegram 文字。純函式。
 * @param {!Object} plan
 * @return {string}
 */
function upgradePlanText_(plan) {
  const lines = [];
  if (plan.upToDate) {
    lines.push(`✅ 已是最新版 v${plan.current}（${plan.source.repo}@${plan.source.ref}）。`);
    return lines.join('\n');
  }
  if (plan.latest) {
    lines.push(`${plan.ok ? '🆕' : '⛔'} v${plan.current} → v${plan.latest.version}（commit ${plan.latest.commit.slice(0, 7)}${plan.latest.date ? '，' + String(plan.latest.date).slice(0, 10) : ''}；${plan.source.repo}@${plan.source.ref}）`);
    if (plan.latest.notes) lines.push(`變更：${plan.latest.notes}`);
    lines.push(`檔案 ${plan.latest.fileCount} 個${plan.deployments ? `；部署 A @${plan.deployments.a.version}${plan.deployments.b ? ' / B @' + plan.deployments.b.version : ''} 會切到新版` : ''}${plan.scopes ? `；OAuth scope ${plan.scopes.added.length || plan.scopes.removed.length ? '有變' : '不變'}` : ''}`);
  } else if (plan.source) {
    lines.push(`⛔ 無法檢查 ${plan.source.repo}@${plan.source.ref}`);
  } else {
    lines.push('⛔ 無法檢查升級');
  }
  plan.blockers.forEach((b) => lines.push(`❌ ${b}`));
  plan.warnings.forEach((w) => lines.push(`⚠ ${w}`));
  if (plan.ok && plan.latest) lines.push('', '批准後排進 Queue，下一分鐘執行：先把目前版本備份到 Drive「GAS Agent/upgrades」，再更新程式與部署；完成會通知，之後可 /upgrade rollback 還原。');
  return lines.join('\n');
}

/**
 * 升級 / 回滾的 Approvals 列。純函式。
 * @param {{action: string, version: string, commit: (string|undefined), from: string, repo: (string|undefined), ref: (string|undefined), backup_file_id: (string|undefined)}} args
 * @param {string} by 誰提的（寫進 reason）
 * @param {string=} id 測試可指定
 * @return {!Object}
 */
function upgradeApprovalRow_(args, by, id) {
  const label = args.action === 'rollback' ? `回滾到 v${args.version}` : `升級 v${args.from} → v${args.version}（${String(args.commit || '').slice(0, 7)}）`;
  return {
    id: id || newApprovalId_(),
    job_id: '',
    tool: UPGRADE_TOOL,
    args: JSON.stringify(args),
    reason: `${UPGRADE_REASON_PREFIX}：${label}；由 ${by} 透過 /upgrade 提出`,
    state: 'pending',
    decided_at: '',
    result: '',
  };
}

/**
 * decideApproval_ 的特判：批准升級 / 回滾 → enqueue 一個 upgrade job（不在 webhook 執行內做，交給 queueTick 的 lock）。
 * @param {!Object} row Approvals 列
 * @param {{enqueue: (Function|undefined), queueStore: (Object|undefined)}} deps
 * @return {ToolOutcome}
 */
function upgradeOnApproved_(row, deps) {
  const args = parseJsonArgs_(row.args);
  if (['upgrade', 'rollback'].indexOf(String(args.action || '')) === -1) return { ok: false, status: 'invalid', content: `升級審批的 action「${args.action}」不認得。`, ms: 0 };
  const payload = Object.assign({}, args, { approval_id: row.id });
  const job = (deps.enqueue || enqueue_)(UPGRADE_JOB_TYPE, payload, '', { store: deps.queueStore });
  const what = args.action === 'rollback' ? `回滾到 v${args.version}` : `升級到 v${args.version}`;
  return { ok: true, status: 'ok', content: `${what} 已排進 Queue（job ${job.id}），下一分鐘開始執行；完成或失敗都會通知。`, ms: 0 };
}

// ---- 備份 --------------------------------------------------------------------------------------------

/**
 * 把目前程式備份成 Drive JSON（GAS Agent/upgrades/backup-v<版本>-<時間>.json），並只留最近 UPGRADE_BACKUP_KEEP 份。
 * @param {!Array<{name: string, type: string, source: string}>} files
 * @param {{version: string, scriptId: string, at: string}} meta
 * @return {{fileId: string, name: string, version: string, at: string}}
 */
function upgradeBackupWrite_(files, meta) {
  const folder = folderByPath_(UPGRADE_BACKUP_FOLDER_PATH.slice());
  const name = `backup-v${meta.version}-${meta.at.replace(/[:]/g, '').slice(0, 15)}.json`;
  const body = JSON.stringify({ version: meta.version, scriptId: meta.scriptId, at: meta.at, files });
  const file = folder.createFile(name, body, MimeType.PLAIN_TEXT);
  try { upgradeBackupPrune_(folder, UPGRADE_BACKUP_KEEP); } catch (err) { console.warn('清舊備份失敗：' + (err && err.message || err)); }
  return { fileId: file.getId(), name, version: meta.version, at: meta.at };
}

/**
 * 備份資料夾只留最新 keep 份（照檔名排序；檔名含時間）。
 * @param {GoogleAppsScript.Drive.Folder} folder
 * @param {number} keep
 * @return {number} 刪了幾個
 */
function upgradeBackupPrune_(folder, keep) {
  const names = [];
  const it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); if (/^backup-v.*\.json$/.test(f.getName())) names.push(f); }
  names.sort((x, y) => (x.getName() < y.getName() ? 1 : x.getName() > y.getName() ? -1 : 0));
  let removed = 0;
  names.slice(keep).forEach((f) => { f.setTrashed(true); removed++; });
  return removed;
}

/**
 * 讀回備份。
 * @param {string} fileId
 * @return {{version: string, scriptId: string, at: string, files: !Array<{name: string, type: string, source: string}>}}
 * @throws {Error}
 */
function upgradeBackupRead_(fileId) {
  let text;
  try { text = DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8'); } catch (err) { throw new Error(`讀不到備份檔 ${fileId}：${err && err.message || err}`); }
  const o = JSON.parse(text);
  if (!o || !Array.isArray(o.files) || !o.files.length) throw new Error('備份檔內容不完整。');
  return o;
}

// ---- 執行（Queue job） ---------------------------------------------------------------------------------

/**
 * 把一組檔案部署成 A / B 兩個版本（同 deploy.sh 的順序）：
 * updateContent(MYSELF) → version → update A → [updateContent(ANYONE) → version → update B → updateContent(MYSELF)]。
 * @param {!Object} api scriptApi_
 * @param {string} scriptId
 * @param {!Array<{name: string, type: string, source: string}>} files 新版（manifest 的 access 會被覆寫）
 * @param {{a: {id: string}, b: ?{id: string}}} deployments
 * @param {string} description 版本說明
 * @return {{versionA: number, versionB: number}}
 */
function upgradeDeploy_(api, scriptId, files, deployments, description) {
  const adminFiles = upgradeWithManifestAccess_(files, UPGRADE_ACCESS_ADMIN);
  api.updateContent(scriptId, adminFiles);
  const versionA = api.createVersion(scriptId, description);
  api.updateDeployment(scriptId, deployments.a.id, versionA, description);
  let versionB = 0;
  if (deployments.b) {
    api.updateContent(scriptId, upgradeWithManifestAccess_(files, UPGRADE_ACCESS_WEBHOOK));
    versionB = api.createVersion(scriptId, `${description}（webhook）`);
    api.updateDeployment(scriptId, deployments.b.id, versionB, `${description}（webhook）`);
    api.updateContent(scriptId, adminFiles); // HEAD 的 manifest 回到 MYSELF
  }
  return { versionA, versionB };
}

/**
 * upgrade job：payload = {action: 'upgrade'|'rollback', version, commit, repo, ref, from, backup_file_id, approval_id}。
 * 失敗不重試（回 state failed），並通知 owner。
 * @param {QueueJob} job
 * @param {{api: (Object|undefined), scriptId: (string|undefined), fetch: (Function|undefined), fetchAll: (Function|undefined),
 *   backupWrite: (Function|undefined), backupRead: (Function|undefined), getProp: (Function|undefined), setProp: (Function|undefined),
 *   notify: (Function|undefined), audit: (Function|undefined), now: (Function|undefined), currentVersion: (string|undefined)}} deps
 * @return {{state: string, result: !Object, error: (string|undefined)}}
 */
function runUpgradeJob_(job, deps) {
  deps = deps || {};
  const p = job.payload || {};
  const action = String(p.action || 'upgrade');
  const nowMs = deps.now ? deps.now() : Date.now();
  const at = fmtDate_(new Date(nowMs));
  const getProp = deps.getProp || getProp_;
  const setProp = deps.setProp || setProp_;
  const notify = deps.notify || ((text) => telegramNotifyOwner_(text));
  const currentVersion = deps.currentVersion || APP_VERSION;
  const log = [];
  try {
    const api = deps.api || scriptApi_(deps);
    const scriptId = deps.scriptId || ScriptApp.getScriptId();
    // 1. 新檔案
    let files;
    let target = { version: String(p.version || ''), commit: String(p.commit || ''), description: '' };
    if (action === 'rollback') {
      if (!p.backup_file_id) throw new Error('rollback 缺 backup_file_id。');
      const backup = (deps.backupRead || upgradeBackupRead_)(String(p.backup_file_id));
      files = backup.files;
      target = { version: String(backup.version || p.version || '?'), commit: '', description: `rollback to v${backup.version || '?'} via /upgrade` };
      log.push(`讀備份 ${p.backup_file_id}（v${target.version}，${backup.files.length} 檔）`);
    } else {
      const source = { repo: String(p.repo || ''), ref: String(p.ref || '') };
      if (!source.repo) Object.assign(source, upgradeSource_(deps));
      const release = upgradeFetchRelease_(source, deps).release;
      if (release.commit !== String(p.commit || '')) throw new Error(`release 已經變了：審批時是 v${p.version}（${String(p.commit || '').slice(0, 7)}），現在是 v${release.version}（${release.commit.slice(0, 7)}）。請重新 /upgrade。`);
      files = upgradeFetchFiles_(source, release, deps);
      target = { version: release.version, commit: release.commit, description: `v${release.version} (${release.commit.slice(0, 7)}) via /upgrade` };
      log.push(`抓 ${files.length} 檔（${source.repo}@${release.commit.slice(0, 7)}）hash 全對`);
    }
    // 2. 預檢
    const syntax = upgradeSyntaxCheck_(files);
    if (syntax.length) throw new Error(`語法預檢失敗：\n${syntax.slice(0, 5).join('\n')}`);
    const current = api.getContent(scriptId).files || [];
    const scopes = upgradeScopeDiff_(upgradeManifestOf_(current), upgradeManifestOf_(files));
    if (scopes.added.length) throw new Error(`新版需要新的 OAuth scope（${scopes.added.join('、')}），拒絕自動${action === 'rollback' ? '回滾' : '升級'}；請用 deploy.sh 並在編輯器重新授權。`);
    const deployments = upgradeSelectDeployments_(api.listDeployments(scriptId), { a: getProp(PROP.UPGRADE_DEPLOY_A), b: getProp(PROP.UPGRADE_DEPLOY_B) });
    log.push(`預檢通過：語法 OK、scope 不變、部署 A ${deployments.a.id.slice(0, 8)}…${deployments.b ? ' / B ' + deployments.b.id.slice(0, 8) + '…' : ''}`);
    // 3. 備份目前版本
    const backup = (deps.backupWrite || upgradeBackupWrite_)(current, { version: currentVersion, scriptId, at });
    setProp(PROP.UPGRADE_BACKUP, JSON.stringify(backup));
    log.push(`備份目前 v${currentVersion} → ${backup.name}`);
    // 4. 部署
    const v = upgradeDeploy_(api, scriptId, files, deployments, target.description);
    log.push(`部署 A @${v.versionA}${v.versionB ? '、B @' + v.versionB : ''}`);
    // 5. 記錄與通知；新程式下一分鐘跑 post-install
    const last = { action, version: target.version, commit: target.commit, from: currentVersion, at, versionA: v.versionA, versionB: v.versionB, backup: backup.fileId, approval_id: p.approval_id || '' };
    setProp(PROP.UPGRADE_LAST, JSON.stringify(last));
    setProp(PROP.UPGRADE_POST_INSTALL, JSON.stringify({ action, version: target.version, from: currentVersion, at }));
    securityAudit_('upgrade', `${action} v${currentVersion} → v${target.version}${target.commit ? ' (' + target.commit.slice(0, 7) + ')' : ''}；部署 A @${v.versionA}${v.versionB ? ' / B @' + v.versionB : ''}；備份 ${backup.name}`, deps.audit);
    const text = `✅ ${action === 'rollback' ? '已回滾' : '已升級'}：v${currentVersion} → v${target.version}${target.commit ? '（' + target.commit.slice(0, 7) + '）' : ''}\n${log.join('\n')}\n下一分鐘新程式會自動補 tab / trigger / 預設值並健檢，結果另行通知。${action === 'rollback' ? '' : '\n有問題可 /upgrade rollback 還原到 v' + currentVersion + '。'}`;
    try { notify(text); } catch (err) { /* 忽略 */ }
    return { state: 'done', result: { text, action, from: currentVersion, version: target.version, commit: target.commit, versionA: v.versionA, versionB: v.versionB, backup: backup.fileId, steps: [], stopped: '' } };
  } catch (err) {
    const msg = String(err && err.message || err);
    const text = `❌ ${action === 'rollback' ? '回滾' : '升級'}失敗（v${currentVersion} 不變）：${msg}${log.length ? '\n已完成：' + log.join('；') : ''}`;
    try { notify(text); } catch (e2) { /* 忽略 */ }
    securityAudit_('upgrade_failed', `${action}：${msg}`, deps.audit);
    return { state: 'failed', error: msg, result: { text, action, from: currentVersion, steps: [], stopped: 'error' } };
  }
}

/**
 * 升級 / 回滾後第一次 tick（已是新程式）：跑 installAgent()（補 tab / trigger / 預設值，幂等）與 Doctor，結果推 Telegram。
 * 旗標先清再跑，失敗也不會每分鐘重跑。
 * @param {{getProp: (Function|undefined), setProp: (Function|undefined), install: (Function|undefined), doctor: (Function|undefined),
 *   notify: (Function|undefined), currentVersion: (string|undefined)}=} deps
 * @return {?{version: string, install: ?Object, doctor: ?Object, error: string}}
 */
function upgradePostInstallIfDue_(deps) {
  deps = deps || {};
  const getProp = deps.getProp || getProp_;
  const setProp = deps.setProp || setProp_;
  const raw = getProp(PROP.UPGRADE_POST_INSTALL);
  if (!raw) return null;
  setProp(PROP.UPGRADE_POST_INSTALL, '');
  let info = {};
  try { info = JSON.parse(raw) || {}; } catch (err) { info = {}; }
  const out = { version: deps.currentVersion || APP_VERSION, install: null, doctor: null, error: '' };
  const lines = [`🔄 ${info.action === 'rollback' ? '回滾' : '升級'}後檢查：現在跑的是 v${out.version}${info.version && info.version !== out.version ? `（預期 v${info.version}，不一致！）` : ''}`];
  try {
    const r = (deps.install || installAgent)();
    out.install = { createdTabs: (r.schema && r.schema.createdTabs) || [], trigger: r.trigger || null, addedKeys: (r.toolConfig && r.toolConfig.addedKeys) || [] };
    lines.push(`installAgent：tab ${out.install.createdTabs.length ? '新增 ' + out.install.createdTabs.join(', ') : '齊全'}；trigger ${r.trigger && r.trigger.created ? '已補' : '正常'}；Config 補 ${out.install.addedKeys.length} 個預設值`);
  } catch (err) {
    out.error = String(err && err.message || err);
    lines.push(`installAgent 失敗：${out.error}`);
  }
  try {
    const d = (deps.doctor || runDoctor)();
    out.doctor = { ok: d.ok, fails: d.checks.filter((c) => c.status === 'fail').length, warns: d.checks.filter((c) => c.status === 'warn').length };
    lines.push(doctorSummaryText_(d, { showOk: false }));
  } catch (err) {
    lines.push(`Doctor 失敗：${err && err.message || err}`);
  }
  try { (deps.notify || ((t) => telegramNotifyOwner_(t)))(lines.join('\n')); } catch (err) { /* 忽略 */ }
  return out;
}

// ---- Doctor -------------------------------------------------------------------------------------------

/**
 * Doctor 用：Apps Script API 能不能用、部署 A / B 認得出來、目前版本與備份。
 * @param {{api: (Object|undefined), scriptId: (string|undefined), getProp: (Function|undefined)}=} deps
 * @return {{status: string, detail: string}}
 */
function upgradeDoctorCheck_(deps) {
  deps = deps || {};
  const st = upgradeStatus_(deps);
  const base = `v${st.version}；來源 ${st.source.repo}@${st.source.ref}${st.last ? `；上次 ${st.last.action === 'rollback' ? '回滾' : '升級'} ${st.last.at}` : ''}${st.backup ? `；可回滾到 v${st.backup.version}` : ''}`;
  if (st.sourceError) return { status: 'warn', detail: `${base}。${st.sourceError}` };
  try {
    const api = deps.api || scriptApi_(deps);
    const scriptId = deps.scriptId || ScriptApp.getScriptId();
    const d = upgradeSelectDeployments_(api.listDeployments(scriptId), { a: (deps.getProp || getProp_)(PROP.UPGRADE_DEPLOY_A), b: (deps.getProp || getProp_)(PROP.UPGRADE_DEPLOY_B) });
    return { status: 'ok', detail: `${base}；Telegram /upgrade 可更新部署 A @${d.a.version}${d.b ? ' / B @' + d.b.version : '（沒有部署 B）'}` };
  } catch (err) {
    return { status: 'warn', detail: `${base}。/upgrade 目前不能用：${err && err.message || err}` };
  }
}

// ---- 編輯器手動入口（Telegram / 管理頁都壞掉時的救命繩；不經審批） -----------------------------------------

/**
 * 在 Apps Script 編輯器直接升級到 release 最新版（沒有 Telegram 的帳號、或想略過審批時用）。會印出計畫與結果。
 * @return {!Object}
 */
function upgradeNow() {
  const plan = upgradePlan_();
  console.log(plan.text);
  if (!plan.ok || plan.upToDate) return plan;
  const r = runUpgradeJob_({ id: 'manual', type: UPGRADE_JOB_TYPE, payload: { action: 'upgrade', version: plan.latest.version, commit: plan.latest.commit, repo: plan.source.repo, ref: plan.source.ref, from: plan.current } }, {});
  console.log(r.result.text);
  return r;
}

/**
 * 在 Apps Script 編輯器直接回滾到 UPGRADE_BACKUP 記的備份（升級後 webhook / 管理頁壞掉、收不到 /upgrade rollback 時用）。
 * @return {!Object}
 */
function upgradeRollbackNow() {
  const st = upgradeStatus_();
  if (!st.backup || !st.backup.fileId) throw new Error('沒有可回滾的備份（UPGRADE_BACKUP 空）。');
  const r = runUpgradeJob_({ id: 'manual', type: UPGRADE_JOB_TYPE, payload: { action: 'rollback', version: st.backup.version, backup_file_id: st.backup.fileId } }, {});
  console.log(r.result.text);
  return r;
}
