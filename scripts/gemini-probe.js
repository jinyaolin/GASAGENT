#!/usr/bin/env node
/**
 * 診斷用：拿 ~/.config/gas-agent/gemini-cli/<代號>.json 的憑證，用不同 User-Agent 打一次 Code Assist generateContent，
 * 看是哪個條件被擋（GAS 的 UrlFetchApp 不能改 User-Agent，所以用這支在本機比對）。只印狀態碼與錯誤訊息，不印 token。
 *
 *   node scripts/gemini-probe.js [--account default] [--model gemini-3-flash]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : d; };
const account = opt('--account', 'default');
const model = opt('--model', 'gemini-3-flash');
const creds = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'gas-agent', 'gemini-cli', `${account}.json`), 'utf8'));
const endpoint = creds.client === 'gemini_cli' ? 'https://cloudcode-pa.googleapis.com' : 'https://daily-cloudcode-pa.googleapis.com';

async function token() {
  if (creds.expires_at && creds.expires_at - Date.now() > 60000) return creds.access_token;
  const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: creds.client_id, client_secret: creds.client_secret, refresh_token: creds.refresh_token });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const j = await res.json();
  if (!j.access_token) throw new Error('refresh 失敗：' + JSON.stringify(j));
  creds.access_token = j.access_token; creds.expires_at = Date.now() + (j.expires_in || 3600) * 1000;
  fs.writeFileSync(path.join(os.homedir(), '.config', 'gas-agent', 'gemini-cli', `${account}.json`), JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  return j.access_token;
}

function envelope(variant) {
  const body = { model, project: creds.project_id, request: { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }], generationConfig: { maxOutputTokens: 32 } } };
  if (variant.agentFields) { body.requestType = 'agent'; body.userAgent = 'antigravity'; body.requestId = 'agent-' + Math.random().toString(36).slice(2); }
  return body;
}

const VARIANTS = [
  { name: 'A. Hub UA + agent 欄位（社群實作）', ua: 'antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)', agentFields: true },
  { name: 'B. GAS 的 UA + agent 欄位（= GAS 現況）', ua: 'Mozilla/5.0 (compatible; Google-Apps-Script; beanserver; +https://script.google.com; id: TEST)', agentFields: true },
  { name: 'C. GAS 的 UA、不帶 agent 欄位', ua: 'Mozilla/5.0 (compatible; Google-Apps-Script; beanserver; +https://script.google.com; id: TEST)', agentFields: false },
  { name: 'D. Electron 風 UA（antigravity-proxy 用的）+ agent 欄位', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.0.14 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36', agentFields: true },
  { name: 'E. 沒有 User-Agent + agent 欄位', ua: '', agentFields: true },
];

(async () => {
  const t = await token();
  console.log(`client ${creds.client}；專案 ${creds.project_id}；tier ${creds.tier}；model ${model}；endpoint ${endpoint}\n`);
  for (const v of VARIANTS) {
    const headers = { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
    if (v.ua) headers['User-Agent'] = v.ua;
    const res = await fetch(`${endpoint}/v1internal:generateContent`, { method: 'POST', headers, body: JSON.stringify(envelope(v)) });
    const text = await res.text();
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); msg = j.error ? `${j.error.status || ''} ${j.error.message}` : (j.response && j.response.candidates ? '回覆：' + JSON.stringify(j.response.candidates[0].content.parts.map((p) => p.text).join('')) : text.slice(0, 200)); } catch (err) { /* 原文 */ }
    console.log(`${v.name}\n   HTTP ${res.status} ${msg}\n`);
  }
})().catch((err) => { console.error('✗ ' + (err && err.message || err)); process.exit(1); });
