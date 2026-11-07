'use strict';
/**
 * @fileoverview 安裝服務的頁面（繁中、單檔 HTML、無框架）。全部純函式回字串；所有外部值都經 esc()。
 */
const { USERSETTINGS_URL } = require('./google');

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CSS = `
:root{color-scheme:light dark;--fg:#1f2328;--bg:#fff;--muted:#656d76;--line:#d0d7de;--accent:#1f6feb;--ok:#1a7f37;--warn:#9a6700;--err:#cf222e;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#8b949e;--line:#30363d;--accent:#58a6ff;--ok:#3fb950;--warn:#d29922;--err:#f85149;--card:#161b22}}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC","PingFang TC",sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:720px;margin:0 auto;padding:40px 20px 80px}h1{font-size:28px;margin:0 0 8px}h2{font-size:20px;margin:32px 0 8px}p{margin:8px 0}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 20px;margin:16px 0}
.btn{display:inline-block;padding:12px 20px;border-radius:8px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;margin:8px 8px 8px 0}
.btn.secondary{background:transparent;color:var(--accent);border:1px solid var(--accent)}
code,.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.code{font-size:32px;letter-spacing:4px;padding:12px 16px;border:2px dashed var(--line);border-radius:10px;display:inline-block;user-select:all}
ol li{margin:6px 0}.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}a{color:var(--accent)}.small{font-size:14px}
`;

function layout(title, body) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} — GAS Agent</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

/**
 * 首頁。
 * @param {{baseUrl: string, repo: string, version: string, privacyUrl: string}} o
 */
function landing(o) {
  return layout('GAS Agent 安裝', `
<h1>GAS Agent 安裝</h1>
<p class="muted">把 GAS Agent 裝進<strong>你自己的 Google 帳號</strong>：這個頁面會替你建立一個 Apps Script 專案、灌入 <a href="https://github.com/${esc(o.repo)}" rel="noopener">公開的程式碼</a>（目前 v${esc(o.version)}）、建好管理頁與 Telegram webhook 兩個部署。程式、資料、金鑰都只在你的帳號裡；本服務不保存你的任何資料，授權 token 只保留到你取件為止（最多 24 小時）。<a href="${esc(o.privacyUrl)}" rel="noopener">隱私權政策</a></p>

<h2>第一次安裝</h2>
<div class="card">
<ol>
<li>先到 <a href="${esc(USERSETTINGS_URL)}" target="_blank" rel="noopener">Apps Script 使用者設定</a> 把「Google Apps Script API」打開（Google 只讓本人開）。</li>
<li>按下面的按鈕，用要安裝的 Google 帳號登入並允許「存取你的 Apps Script 專案」。會看到「Google 尚未驗證這個應用程式」，按「進階 → 前往 GAS Agent」繼續。</li>
<li>安裝完成會給你管理頁網址與一組取件碼，照頁面上的步驟完成授權與設定。</li>
</ol>
<a class="btn" href="${esc(o.baseUrl)}/install/start">用 Google 登入並安裝</a>
</div>

<h2>已經有 GAS Agent，要讓它能自己升級</h2>
<div class="card">
<p>在 Telegram 對你的 bot 輸入 <code>/upgrade login</code> 會拿到同一個連結；或直接按下面的按鈕，用 agent 所在的 Google 帳號授權，拿到取件碼後回 Telegram 輸入 <code>/upgrade code 取件碼</code>。</p>
<a class="btn secondary" href="${esc(o.baseUrl)}/upgrade/start">取得升級授權</a>
</div>
<p class="small muted">只要求兩個權限：建立 / 修改你的 Apps Script 專案、更新它的部署。不碰 Gmail、Drive、日曆。</p>`);
}

/**
 * 安裝完成。
 * @param {{email: string, scriptId: string, editorUrl: string, adminUrl: string, webhookUrl: string, code: string, version: string, ttlHours: number}} o
 */
function installed(o) {
  return layout('安裝完成', `
<h1 class="ok">✅ 安裝完成</h1>
<p>已在 <strong>${esc(o.email || '你的帳號')}</strong> 建立 GAS Agent v${esc(o.version)}（專案 <code>${esc(o.scriptId)}</code>，<a href="${esc(o.editorUrl)}" target="_blank" rel="noopener">在編輯器打開</a>）。</p>
<div class="card">
<p><strong>管理頁（只限你本人）</strong><br><a href="${esc(o.adminUrl)}" target="_blank" rel="noopener">${esc(o.adminUrl)}</a></p>
<p><strong>Telegram webhook 網址（部署 B，設定通道時要填）</strong><br><code>${esc(o.webhookUrl)}</code></p>
<p><strong>升級取件碼</strong>（${esc(o.ttlHours)} 小時內有效，只能用一次）<br><span class="code">${esc(o.code)}</span></p>
</div>
<h2>接下來</h2>
<ol>
<li>打開上面的管理頁。第一次 Google 會要你授權 agent 本身的 Gmail / Drive / 日曆等權限（這一步一定要本人按，無法代做；一樣會有「尚未驗證」警告）。授權後頁面會顯示「GAS Agent 尚未安裝」，按「安裝」就會建好資料庫試算表與每分鐘的 trigger。</li>
<li>到「模型」分頁填你的 AI 模型 API key。</li>
<li>到「通道」分頁貼 Telegram bot token、把上面的 webhook 網址填進去並按「設定 webhook」，把你自己的 Telegram user id 加進白名單。</li>
<li>在 Telegram 對 bot 輸入 <code>/upgrade code ${esc(o.code)}</code>，agent 之後就能用 <code>/upgrade</code> 自己更新。</li>
</ol>
<p class="small muted">這組取件碼領走之後本服務就不再保有任何你的資料。</p>`);
}

/**
 * 升級授權完成（既有 agent）。
 * @param {{email: string, code: string, ttlHours: number}} o
 */
function loginDone(o) {
  return layout('升級授權', `
<h1 class="ok">✅ 授權完成</h1>
<p>帳號 <strong>${esc(o.email || '')}</strong>。回到 Telegram 對你的 bot 輸入：</p>
<div class="card"><p><code>/upgrade code ${esc(o.code)}</code></p><p><span class="code">${esc(o.code)}</span></p></div>
<p class="small muted">取件碼 ${esc(o.ttlHours)} 小時內有效、只能用一次；agent 領走後本服務就不再保有任何你的資料。之後輸入 <code>/upgrade</code> 就能檢查並升級。</p>`);
}

/**
 * 錯誤頁。
 * @param {{message: string, retryUrl: string, hint: (string|undefined)}} o
 */
function error(o) {
  return layout('失敗', `
<h1 class="err">❌ 失敗</h1>
<div class="card"><p>${esc(o.message)}</p>${o.hint ? `<p class="muted">${esc(o.hint)}</p>` : ''}</div>
<a class="btn" href="${esc(o.retryUrl)}">再試一次</a>`);
}

module.exports = { landing, installed, loginDone, error, esc };
