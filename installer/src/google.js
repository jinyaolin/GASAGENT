'use strict';
/**
 * @fileoverview Google OAuth（授權碼流程）與 Apps Script API 的薄包裝。零依賴，fetch 可注入（測試）。
 * 只要兩個 scope：script.projects（建專案 / 寫程式 / 建版）、script.deployments（建 / 改部署）；userinfo.email 只用來顯示是哪個帳號。
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const SCRIPT_API = 'https://script.googleapis.com/v1';
const USERSETTINGS_URL = 'https://script.google.com/home/usersettings';
const SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
  'https://www.googleapis.com/auth/userinfo.email',
]);

/**
 * 授權網址。純函式。
 * @param {{clientId: string, redirectUri: string, state: string, loginHint: (string|undefined)}} o
 * @return {string}
 */
function authUrl(o) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', o.clientId);
  u.searchParams.set('redirect_uri', o.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', o.state);
  if (o.loginHint) u.searchParams.set('login_hint', o.loginHint);
  return u.toString();
}

async function postForm(url, form, fetchFn) {
  const body = Object.keys(form).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(form[k])).join('&');
  const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  return { status: res.status, json, text };
}

/**
 * 授權碼 → token。
 * @param {{clientId: string, clientSecret: string, redirectUri: string, code: string}} o
 * @param {Function=} fetchFn
 * @return {Promise<{access_token: string, refresh_token: string, expires_in: number, scope: string}>}
 */
async function exchangeCode(o, fetchFn) {
  const r = await postForm(TOKEN_URL, { code: o.code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri, grant_type: 'authorization_code' }, fetchFn || fetch);
  if (r.status !== 200 || !r.json || !r.json.access_token) throw new Error(`Google 換 token 失敗（HTTP ${r.status}）：${r.json && (r.json.error_description || r.json.error) || r.text.slice(0, 200)}`);
  if (!r.json.refresh_token) throw new Error('Google 沒有給 refresh token：請到 https://myaccount.google.com/permissions 移除「GAS Agent」後重新授權。');
  const scopes = String(r.json.scope || '').split(/\s+/);
  const missing = SCOPES.slice(0, 2).filter((s) => scopes.indexOf(s) === -1);
  if (missing.length) throw new Error(`授權時沒有勾選必要權限：${missing.join('、')}。請重新授權並全部允許。`);
  return r.json;
}

/**
 * @param {string} accessToken
 * @param {Function=} fetchFn
 * @return {Promise<{email: string}>}
 */
async function userInfo(accessToken, fetchFn) {
  const res = await (fetchFn || fetch)(USERINFO_URL, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (res.status !== 200) return { email: '' };
  const j = await res.json();
  return { email: String(j.email || '') };
}

/**
 * Apps Script API 錯誤 → 中文。純函式。
 * @param {number} status
 * @param {string} text
 * @return {string}
 */
function apiErrorMessage(status, text) {
  let msg = '';
  try { msg = String(JSON.parse(text).error.message || ''); } catch (err) { msg = String(text || '').slice(0, 300); }
  if (status === 403 && /has not enabled the Apps Script API/i.test(msg)) return `這個 Google 帳號還沒打開 Apps Script API：請到 ${USERSETTINGS_URL} 把「Google Apps Script API」打開，等一分鐘再回來重試。`;
  if (status === 403 && /has not been used in project|is disabled/i.test(msg)) return `安裝服務的 GCP 專案沒開 Apps Script API（服務端設定問題，請通知維護者）：${msg.slice(0, 160)}`;
  if (status === 401) return 'Google 拒絕 token（401），請重新授權。';
  return `Apps Script API 回應 ${status}：${msg || '(無訊息)'}`;
}

/**
 * Apps Script API client。
 * @param {string} accessToken
 * @param {Function=} fetchFn
 */
function scriptApi(accessToken, fetchFn) {
  const f = fetchFn || fetch;
  const call = async (method, path, body) => {
    const init = { method, headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await f(SCRIPT_API + path, init);
    const text = await res.text();
    if (res.status >= 200 && res.status < 300) return text ? JSON.parse(text) : {};
    const err = new Error(apiErrorMessage(res.status, text));
    err.status = res.status;
    throw err;
  };
  return {
    /** @return {Promise<{scriptId: string}>} */
    createProject: (title) => call('POST', '/projects', { title: String(title || 'GAS Agent') }),
    getContent: (scriptId) => call('GET', `/projects/${encodeURIComponent(scriptId)}/content`),
    updateContent: (scriptId, files) => call('PUT', `/projects/${encodeURIComponent(scriptId)}/content`, { files: files.map((x) => ({ name: x.name, type: x.type, source: x.source })) }),
    /** @return {Promise<number>} */
    createVersion: async (scriptId, description) => Number((await call('POST', `/projects/${encodeURIComponent(scriptId)}/versions`, { description: String(description || '').slice(0, 200) })).versionNumber || 0),
    /** @return {Promise<{deploymentId: string}>} */
    createDeployment: (scriptId, versionNumber, description) => call('POST', `/projects/${encodeURIComponent(scriptId)}/deployments`, { versionNumber, manifestFileName: 'appsscript', description: String(description || '').slice(0, 200) }),
    listDeployments: async (scriptId) => {
      const out = [];
      let pageToken = '';
      do {
        const r = await call('GET', `/projects/${encodeURIComponent(scriptId)}/deployments?pageSize=50${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
        (r.deployments || []).forEach((d) => out.push(d));
        pageToken = String(r.nextPageToken || '');
      } while (pageToken && out.length < 500);
      return out;
    },
  };
}

/** @param {string} deploymentId @return {string} Web App 網址 */
function execUrl(deploymentId) { return `https://script.google.com/macros/s/${deploymentId}/exec`; }
/** @param {string} scriptId @return {string} 編輯器網址 */
function editorUrl(scriptId) { return `https://script.google.com/d/${scriptId}/edit`; }

module.exports = { SCOPES, AUTH_URL, TOKEN_URL, USERSETTINGS_URL, authUrl, exchangeCode, userInfo, scriptApi, apiErrorMessage, execUrl, editorUrl };
