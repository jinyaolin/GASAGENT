'use strict';
/**
 * @fileoverview 安裝服務的頁面（繁中、單檔 HTML、無框架）。全部純函式回字串；所有外部值都經 esc()。
 * 視覺沿用 zaistudio.tw 的「暗夜書房」：暖墨黑底、燭光金（唯一 accent）、宋體標題、黑體內文。
 * 流程：首頁（/）→ 安裝前準備（/install）→ Google 授權 → 建置 → 完成頁的上手清單。
 */
const { USERSETTINGS_URL } = require('./google');

const SITE_URL = 'https://zaistudio.tw';
const CONTACT_EMAIL = 'jinyao.lin@gmail.com';
let defaultBase = '';
/** 頁面裡的站內連結都以 BASE_URL 開頭（服務掛在 /agent 底下）；createApp 啟動時設定。 */
function setBaseUrl(u) { defaultBase = String(u || '').replace(/\/+$/, ''); }

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CSS = `
:root{color-scheme:dark;
  --bg:#16110C;--surface:#1E1710;--paper:#241C13;--ink:#ECE3D2;--muted:#93826A;--faint:#6B5D4A;
  --lamp:#E0A94E;--lamp-ink:#1C1206;--lamp-soft:rgba(224,169,78,.10);--lamp-line:rgba(224,169,78,.28);
  --line:rgba(236,227,210,.10);--ok:#8FA46A;--err:#CB6048;--ember:#C76A44;
  --glow:radial-gradient(60% 50% at 50% 0%,rgba(224,169,78,.16),transparent 70%);
  --serif:"Noto Serif TC","Songti TC","Source Han Serif TC","Source Han Serif","PMingLiU",serif;
  --sans:"Noto Sans TC","PingFang TC","Microsoft JhengHei","Heiti TC",system-ui,-apple-system,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:light){:root{color-scheme:light;
  --bg:#F4EDDF;--surface:#FBF6EC;--paper:#FFFDF8;--ink:#241E14;--muted:#7A6A52;--faint:#A8977C;
  --lamp:#9C6B18;--lamp-ink:#FFFDF8;--lamp-soft:rgba(156,107,24,.08);--lamp-line:rgba(156,107,24,.30);
  --line:rgba(36,30,20,.12);--ok:#5E7340;--err:#A8432F;--ember:#A8532F;
  --glow:radial-gradient(60% 50% at 50% 0%,rgba(224,169,78,.22),transparent 70%)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;font:16px/1.75 var(--sans);color:var(--ink);background:var(--bg);background-image:var(--glow);background-repeat:no-repeat;min-height:100vh;line-break:strict}
a{color:var(--lamp);text-underline-offset:3px}
h1,h2,h3{font-family:var(--serif);font-weight:600;line-height:1.3;text-wrap:balance;margin:0}
p{margin:.5em 0}
code{font-family:var(--mono);font-size:.9em;background:var(--lamp-soft);border:1px solid var(--line);border-radius:6px;padding:.1em .4em}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
.narrow{max-width:680px}

/* 頁首 / 頁尾 */
.top{position:sticky;top:0;z-index:10;backdrop-filter:saturate(1.2) blur(10px);-webkit-backdrop-filter:saturate(1.2) blur(10px);background:color-mix(in srgb,var(--bg) 78%,transparent);border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;gap:20px;height:60px}
.brand{display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;white-space:nowrap}
.brand .seal{font-family:var(--serif);font-size:24px;color:var(--lamp);line-height:1}
.brand .word{font-family:var(--serif);font-size:16px;letter-spacing:.02em}
.brand .tag{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.nav{display:flex;gap:18px;margin-left:auto;font-size:14px}
.nav a{color:var(--muted);text-decoration:none}.nav a:hover{color:var(--ink)}
.top .btn{margin-left:auto}.nav+.btn{margin-left:8px}
@media (max-width:760px){.nav{display:none}}
.foot{border-top:1px solid var(--line);margin-top:96px;padding:32px 0 48px;color:var(--muted);font-size:13px}
.foot .wrap{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center}
.foot a{color:var(--muted)}.foot .sp{flex:1}

/* 按鈕 */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 22px;border-radius:999px;font:600 15px/1 var(--sans);text-decoration:none;border:1px solid transparent;cursor:pointer;transition:transform .12s,box-shadow .2s,background .2s,opacity .2s;white-space:nowrap}
.btn:active{transform:scale(.97)}
.btn.primary{background:var(--lamp);color:var(--lamp-ink);box-shadow:0 0 0 0 rgba(224,169,78,0)}
.btn.primary:hover{box-shadow:0 6px 28px -6px rgba(224,169,78,.55)}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--lamp-line)}
.btn.ghost:hover{background:var(--lamp-soft)}
.btn.sm{padding:8px 14px;font-size:13px}
.btn[aria-disabled=true]{opacity:.4;pointer-events:none}
.btn.lg{padding:15px 28px;font-size:16px}

/* 區塊 */
section{padding:72px 0 0}
.eyebrow{font-size:12px;letter-spacing:.32em;color:var(--lamp);text-transform:uppercase;margin-bottom:14px}
.sec-h{font-size:clamp(24px,3.4vw,32px);margin-bottom:10px}
.sec-sub{color:var(--muted);max-width:40em;margin-bottom:28px}
.rule{height:1px;width:56px;background:var(--lamp);opacity:.6;margin:18px 0}
.muted{color:var(--muted)}.small{font-size:13px}
.card{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:22px 24px}
.grid{display:grid;gap:16px}
.g3{grid-template-columns:repeat(3,1fr)}.g2{grid-template-columns:repeat(2,1fr)}
@media (max-width:860px){.g3{grid-template-columns:1fr 1fr}}
@media (max-width:600px){.g3,.g2{grid-template-columns:1fr}.card{padding:18px}.task{grid-template-columns:30px minmax(0,1fr);gap:12px}.task .k{width:30px;height:30px}.stepper li{font-size:12px}}

/* Hero */
.hero{padding:72px 0 24px;display:grid;grid-template-columns:1.1fr .9fr;gap:48px;align-items:center}
@media (max-width:860px){.hero{grid-template-columns:1fr;gap:36px;padding-top:48px}}
.hero h1{font-size:clamp(32px,5.2vw,52px);letter-spacing:.01em}
.hero h1 em{font-style:normal;color:var(--lamp)}
.hero .lede{font-size:17px;color:var(--muted);max-width:30em;margin:18px 0 28px}
.hero .ctas{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.hero .assure{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:22px;font-size:13px;color:var(--muted)}
.hero .assure span::before{content:"✓";color:var(--lamp);margin-right:6px}

/* 對話示意 */
.chat{background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:18px;box-shadow:0 30px 80px -40px rgba(0,0,0,.7),0 0 0 1px var(--lamp-soft) inset}
.chat .bar{display:flex;align-items:center;gap:10px;padding:0 4px 14px;border-bottom:1px solid var(--line);margin-bottom:14px;font-size:13px;color:var(--muted)}
.chat .av{width:28px;height:28px;border-radius:50%;background:var(--lamp);color:var(--lamp-ink);display:grid;place-items:center;font:600 14px var(--serif)}
.chat .bar b{color:var(--ink);font-weight:600}
.msg{max-width:86%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.6;margin:8px 0}
.msg.me{margin-left:auto;background:var(--lamp-soft);border:1px solid var(--lamp-line);border-bottom-right-radius:4px}
.msg.ai{background:var(--surface);border:1px solid var(--line);border-bottom-left-radius:4px}
.msg .ap{display:flex;gap:8px;margin-top:10px}
.msg .ap span{font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--lamp-line);color:var(--lamp)}
.msg .ap span.y{background:var(--lamp);color:var(--lamp-ink);border-color:transparent}
.chat .cap{font-size:11px;color:var(--faint);text-align:center;margin-top:10px}

/* 功能 / 信任 */
.feat .ic{font:600 20px/1 var(--serif);color:var(--lamp);width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:var(--lamp-soft);border:1px solid var(--lamp-line);margin-bottom:14px}
.feat h3{font-size:18px;margin-bottom:6px}
.feat p{color:var(--muted);font-size:14px;margin:0}

/* 三步驟 */
.steps3{counter-reset:s}
.steps3 .card{position:relative;padding-top:26px}
.steps3 .n{font:600 13px var(--mono);color:var(--lamp);letter-spacing:.1em}
.steps3 h3{font-size:19px;margin:8px 0 6px}
.steps3 .t{position:absolute;top:22px;right:22px;font-size:12px;color:var(--muted)}

/* 方案 */
.plan{display:flex;flex-direction:column}
.plan.hot{border-color:var(--lamp-line);box-shadow:0 0 0 1px var(--lamp-line) inset,0 20px 60px -30px rgba(224,169,78,.35)}
.plan .badge{align-self:flex-start;font-size:12px;padding:3px 10px;border-radius:999px;background:var(--lamp);color:var(--lamp-ink);font-weight:600;margin-bottom:12px}
.plan .badge.o{background:transparent;color:var(--muted);border:1px solid var(--line)}
.plan h3{font-size:20px}
.plan .price{font:600 40px/1.1 var(--serif);margin:14px 0 2px}
.plan .price small{font:400 14px var(--sans);color:var(--muted);margin-left:6px}
.plan ul{list-style:none;padding:0;margin:18px 0 24px;flex:1}
.plan li{padding:7px 0 7px 26px;position:relative;font-size:14px;border-top:1px dashed var(--line)}
.plan li::before{content:"✓";position:absolute;left:4px;color:var(--lamp)}

/* FAQ */
.faq details{border-top:1px solid var(--line);padding:4px 0}
.faq details:last-child{border-bottom:1px solid var(--line)}
.faq summary{cursor:pointer;list-style:none;padding:16px 32px 16px 0;font-family:var(--serif);font-size:17px;position:relative}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";position:absolute;right:4px;top:12px;font:300 24px var(--sans);color:var(--lamp);transition:transform .2s}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq details p{color:var(--muted);margin:0 0 18px;font-size:15px}

/* CTA band */
.band{margin-top:72px;text-align:center;padding:56px 24px;border-radius:24px;background:var(--paper);border:1px solid var(--lamp-line);background-image:radial-gradient(50% 80% at 50% 0%,rgba(224,169,78,.14),transparent 70%)}
.band h2{font-size:clamp(24px,3.4vw,34px);margin-bottom:10px}
.band p{color:var(--muted);margin-bottom:24px}

/* 流程進度條 */
.stepper{display:flex;gap:0;list-style:none;padding:0;margin:40px 0 36px;counter-reset:st}
.stepper li{flex:1;position:relative;text-align:center;font-size:13px;color:var(--faint);counter-increment:st}
.stepper li::before{content:counter(st);display:grid;place-items:center;width:30px;height:30px;margin:0 auto 8px;border-radius:50%;border:1px solid var(--line);background:var(--surface);font:600 13px var(--mono);position:relative;z-index:1}
.stepper li::after{content:"";position:absolute;top:15px;left:calc(50% + 15px);right:calc(-50% + 15px);height:1px;background:var(--line)}
.stepper li:last-child::after{display:none}
.stepper li.done{color:var(--muted)}.stepper li.done::before{content:"✓";background:var(--lamp-soft);border-color:var(--lamp-line);color:var(--lamp)}
.stepper li.done::after{background:var(--lamp-line)}
.stepper li.now{color:var(--ink);font-weight:600}.stepper li.now::before{background:var(--lamp);color:var(--lamp-ink);border-color:var(--lamp);box-shadow:0 0 0 6px var(--lamp-soft)}

/* 流程頁 */
.page-h{font-size:clamp(26px,4vw,36px);margin-bottom:8px}
.task>div{min-width:0}.task{display:grid;grid-template-columns:36px minmax(0,1fr);gap:16px;align-items:start;margin:14px 0}
.task .k{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--lamp-soft);border:1px solid var(--lamp-line);color:var(--lamp);font:600 14px var(--mono)}
.task h3{font-size:18px;margin:4px 0 6px}
.task p{color:var(--muted);font-size:14px}
.task .act{margin-top:12px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.check{display:flex;gap:10px;align-items:flex-start;cursor:pointer;font-size:14px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--surface);margin-top:12px}
.check input{accent-color:var(--lamp);width:18px;height:18px;margin:2px 0 0;flex:none}
.shot{border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:var(--surface);font-size:13px;margin-top:12px}
.shot .w{color:var(--ember);font-weight:600}
.shot ol{margin:8px 0 0;padding-left:20px;color:var(--muted)}
.perm{list-style:none;padding:0;margin:10px 0 0}
.perm li{font-size:14px;padding:6px 0 6px 26px;position:relative}
.perm li::before{content:"";position:absolute;left:4px;top:13px;width:8px;height:8px;border-radius:50%;background:var(--lamp)}
.perm li.no::before{background:transparent;border:1px solid var(--faint)}
.perm li.no{color:var(--muted)}
.go{margin-top:28px;display:flex;flex-wrap:wrap;gap:14px;align-items:center}
.go .note{font-size:13px;color:var(--muted)}

/* 完成頁 */
.done-h{text-align:center;padding:8px 0 12px}
.done-h .mark{width:64px;height:64px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;background:var(--lamp);color:var(--lamp-ink);font-size:30px;box-shadow:0 0 0 10px var(--lamp-soft),0 0 60px rgba(224,169,78,.45)}
.done-h .mark.err{background:var(--err);color:#fff;box-shadow:0 0 0 10px rgba(203,96,72,.12)}
.done-h p{color:var(--muted)}
.field{margin:14px 0}
.field label{display:block;font-size:12px;letter-spacing:.08em;color:var(--muted);margin-bottom:6px}
.field .row{display:flex;gap:8px;align-items:stretch;min-width:0}.field .row .btn{flex:none}
.field .val{flex:1;min-width:0;font:13px/1.5 var(--mono);padding:10px 12px;border-radius:10px;background:var(--surface);border:1px solid var(--line);overflow-x:auto;white-space:nowrap;user-select:all}
.code{font:600 clamp(28px,6vw,38px)/1 var(--mono);letter-spacing:.18em;color:var(--lamp);text-align:center;padding:22px 12px;border:1px dashed var(--lamp-line);border-radius:14px;background:var(--lamp-soft);user-select:all}
.alert{border-left:3px solid var(--lamp);background:var(--lamp-soft);padding:12px 16px;border-radius:0 12px 12px 0;font-size:14px;margin:20px 0}
.alert.err{border-color:var(--err);background:rgba(203,96,72,.08)}
.legal h2{font-size:22px;margin:36px 0 10px}.legal li{margin:6px 0;color:var(--muted)}.legal li b{color:var(--ink)}
`;

const JS = `
document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var t=b.getAttribute('data-copy');var done=function(){var o=b.textContent;b.textContent='已複製';setTimeout(function(){b.textContent=o},1400)};if(navigator.clipboard){navigator.clipboard.writeText(t).then(done,function(){})}else{var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy');done()}catch(e){}a.remove()}})});
var gate=document.querySelector('[data-gate]');if(gate){var boxes=document.querySelectorAll('[data-req]');var sync=function(){var ok=Array.prototype.every.call(boxes,function(x){return x.checked});gate.setAttribute('aria-disabled',ok?'false':'true')};boxes.forEach(function(x){x.addEventListener('change',sync)});sync();gate.addEventListener('click',function(){if(gate.getAttribute('aria-disabled')==='true')return;gate.textContent='正在前往 Google…';gate.setAttribute('aria-disabled','true')})}
`;

/**
 * @param {string} title
 * @param {string} body
 * @param {{baseUrl: (string|undefined), nav: (boolean|undefined), cta: (boolean|undefined), wide: (boolean|undefined)}=} opts
 */
function layout(title, body, opts) {
  const o = opts || {};
  const base = o.baseUrl || defaultBase;
  const nav = o.nav ? `<nav class="nav"><a href="#features">功能</a><a href="#how">運作方式</a><a href="#trust">安全</a><a href="#pricing">方案</a><a href="#faq">常見問題</a></nav>` : '';
  const cta = o.cta ? `<a class="btn primary sm" href="${esc(base)}/install">開始安裝</a>` : '';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="${o.index ? 'index,follow' : 'noindex'}"><meta name="theme-color" content="#16110C">
<title>${esc(title)}</title>
<meta name="description" content="GAS Agent：住在你自己 Google 帳號裡的私人 AI 助理。在 Telegram 交辦，替你處理 Gmail、Drive、文件、日曆與排程。">
<meta property="og:title" content="${esc(title)}"><meta property="og:site_name" content="Zai Studio"><meta property="og:type" content="website">
<link rel="icon" href="${SITE_URL}/icon.svg"><style>${CSS}</style></head><body>
<header class="top"><div class="wrap"><a class="brand" href="${esc(base)}/"><span class="seal">齋</span><span class="word">Zai Studio</span><span class="tag">Agent</span></a>${nav}${cta}</div></header>
<main class="wrap${o.wide ? '' : ' narrow'}">${body}</main>
<footer class="foot"><div class="wrap"><span>© ${new Date().getFullYear()} Zai Studio</span><a href="${SITE_URL}">zaistudio.tw</a><a href="${esc(base)}/privacy">隱私權與服務條款</a><a href="https://github.com/jinyaolin/GASAGENT" rel="noopener">開源程式碼</a><span class="sp"></span><a href="mailto:${CONTACT_EMAIL}">聯絡我們</a></div></footer>
<script>${JS}</script></body></html>`;
}

/** 流程進度條：1 準備、2 Google 授權、3 建置、4 開始使用。 */
function stepper(now) {
  const labels = ['準備', 'Google 授權', '自動建置', '開始使用'];
  return `<ol class="stepper" aria-label="安裝進度">${labels.map((l, i) => `<li class="${i + 1 < now ? 'done' : i + 1 === now ? 'now' : ''}">${l}</li>`).join('')}</ol>`;
}

function copyField(label, value, link) {
  return `<div class="field"><label>${esc(label)}</label><div class="row"><div class="val">${link ? `<a href="${esc(value)}" target="_blank" rel="noopener">${esc(value)}</a>` : esc(value)}</div><button class="btn ghost sm" type="button" data-copy="${esc(value)}">複製</button></div></div>`;
}

/**
 * 首頁（產品頁）。
 * @param {{baseUrl: string, repo: string, version: string, privacyUrl: string}} o
 */
function landing(o) {
  const b = esc(o.baseUrl || defaultBase);
  const features = [
    ['訊', '在 Telegram 交辦', '像傳訊息給助理一樣，用一句話交代事情；也可以寄信給它。'],
    ['信', '幫你處理 Gmail', '整理未讀、摘要重點、草擬回覆；要寄出前一定先問你。'],
    ['檔', 'Drive 與文件', '找檔案、讀文件、更新試算表、產生簡報，都在你自己的雲端硬碟。'],
    ['曆', '管理行程', '查空檔、建活動、提醒你明天要準備什麼。'],
    ['時', '定時自動做', '每天早上的信件簡報、每週的報表整理，設定一次就固定執行。'],
    ['憶', '記得你的習慣', '長期記憶與可擴充的技能，越用越懂你的工作方式。'],
  ];
  const trust = [
    ['守', '資料只在你的帳號', '程式、對話、記憶、金鑰都存在你自己的 Google 帳號，我們看不到，也不保存。'],
    ['准', '要往外送，先問你', '寄信、分享檔案這類動作會先送到 Telegram 等你按「批准」。'],
    ['驗', '開源、可驗證', '程式碼公開在 GitHub，安裝時逐檔核對 sha256 指紋，裝進去的就是公開的那份。'],
    ['刪', '授權用完即刪', '安裝服務只為你暫存一組升級授權，最多 24 小時，agent 領走就立刻刪除。'],
  ];
  const faqs = [
    ['要付費嗎？', '公測期間安裝與升級完全免費。AI 模型的用量由你自己的模型帳號（OpenAI、Anthropic、Google Gemini 等）計費；也可以用 ChatGPT 或 Google 帳號登入既有方案。Google Apps Script 本身免費。'],
    ['為什麼 Google 會說「尚未驗證這個應用程式」？', 'GAS Agent 是個人開源專案，還沒送 Google 的商業驗證。授權畫面點「進階」→「前往 GAS Agent」即可繼續。安裝服務只要求兩個權限：建立你的 Apps Script 專案、更新它的部署，不碰 Gmail、Drive、日曆。'],
    ['我的資料存在哪裡？', '全部在你自己的 Google 帳號：對話與記憶在 Drive 裡的試算表，金鑰在 Apps Script 專案的屬性中。Zai Studio 沒有任何資料庫存放你的內容。'],
    ['支援哪些 AI 模型？', 'OpenAI 相容服務（含 Z.ai 等）、Anthropic Claude、Google Gemini，也支援用 ChatGPT 或 Google 帳號登入。可以設定多組備援，一個掛掉自動換下一個。'],
    ['之後怎麼升級？', '在 Telegram 對 bot 輸入 /upgrade，agent 會抓最新版、核對指紋、先備份再更新；有問題可以一鍵回滾。'],
    ['不想用了怎麼移除？', '到 script.google.com 刪掉「GAS Agent」專案，再刪除 Drive 裡的「GAS Agent」資料夾與試算表，就完全清除了。'],
  ];
  return layout('GAS Agent 安裝｜你的私人 AI 助理 — Zai Studio', `
<div class="hero">
  <div>
    <div class="eyebrow">Zai Studio · GAS Agent v${esc(o.version)}</div>
    <h1>一位住在你<br><em>Google 帳號</em>裡的<br>私人 AI 助理</h1>
    <p class="lede">在 Telegram 交代一句話，它就替你處理 Gmail、整理 Drive、排行程、定時寫報告。不用架伺服器、不用寫程式，三分鐘裝好。</p>
    <div class="ctas"><a class="btn primary lg" href="${b}/install">免費開始安裝</a><a class="btn ghost lg" href="#how">看看怎麼運作</a></div>
    <div class="assure"><span>公測免費</span><span>資料不離開你的帳號</span><span>開源可驗證</span></div>
  </div>
  <div class="chat" aria-hidden="true">
    <div class="bar"><span class="av">G</span><b>GAS Agent</b><span>· Telegram</span></div>
    <div class="msg me">幫我看一下今天的未讀信，重要的整理成重點，客戶那封幫我草擬回覆。</div>
    <div class="msg ai">今天有 18 封未讀，3 封需要你處理：<br>① 王經理問報價單的交期<br>② 會計提醒月底對帳<br>③ 下週二會議改時間<br>給王經理的回覆草稿已準備好，要寄出嗎？<div class="ap"><span class="y">批准寄出</span><span>先不要</span></div></div>
    <div class="msg me">寄出。另外每天早上八點都幫我做一次。</div>
    <div class="msg ai">已寄出 ✓ 每天 08:00 的信件簡報也排好了。</div>
    <div class="cap">示意畫面</div>
  </div>
</div>

<section id="features">
  <div class="eyebrow">能幫你做什麼</div>
  <h2 class="sec-h">交辦日常瑣事，留時間給重要的事</h2>
  <p class="sec-sub">它直接使用你 Google 帳號裡的工具，所以看得到你的信、你的檔案、你的行程——也只看得到你的。</p>
  <div class="grid g3">${features.map((f) => `<div class="card feat"><div class="ic">${f[0]}</div><h3>${f[1]}</h3><p>${f[2]}</p></div>`).join('')}</div>
</section>

<section id="how">
  <div class="eyebrow">運作方式</div>
  <h2 class="sec-h">三個步驟，裝進你自己的帳號</h2>
  <p class="sec-sub">安裝服務替你在 Google Apps Script 建好專案、灌入程式、開好管理頁與 Telegram 入口。整個過程你都看得到、按得到。</p>
  <div class="grid g3 steps3">
    <div class="card"><span class="n">STEP 01</span><span class="t">約 1 分鐘</span><h3>開啟 Apps Script API</h3><p class="muted">Google 規定這個開關只能由本人打開，我們會帶你到正確的頁面。</p></div>
    <div class="card"><span class="n">STEP 02</span><span class="t">約 1 分鐘</span><h3>用 Google 登入，自動建置</h3><p class="muted">授權後，安裝服務自動建立專案、核對程式指紋、建好兩個部署。</p></div>
    <div class="card"><span class="n">STEP 03</span><span class="t">約 5 分鐘</span><h3>接上模型與 Telegram</h3><p class="muted">在只限你本人開啟的管理頁填入 AI 金鑰與 bot，就能開始交辦。</p></div>
  </div>
</section>

<section id="trust">
  <div class="eyebrow">安全與隱私</div>
  <h2 class="sec-h">它替你工作，但不替我們收集</h2>
  <p class="sec-sub">GAS Agent 的設計原則是「你的帳號、你的資料、你說了算」。</p>
  <div class="grid g2">${trust.map((f) => `<div class="card feat"><div class="ic">${f[0]}</div><h3>${f[1]}</h3><p>${f[2]}</p></div>`).join('')}</div>
</section>

<section id="pricing">
  <div class="eyebrow">方案</div>
  <h2 class="sec-h">公測期間，個人使用免費</h2>
  <p class="sec-sub">你只需要一個 Google 帳號，和一組自己的 AI 模型金鑰（或 ChatGPT / Google 帳號登入）。</p>
  <div class="grid g2">
    <div class="card plan hot"><span class="badge">公測中</span><h3>個人版</h3><div class="price">NT$0<small>/ 公測期間</small></div><p class="muted small">AI 用量依你自己的模型帳號計費</p>
      <ul><li>一鍵安裝到你的 Google 帳號</li><li>Gmail、Drive、文件、試算表、簡報、日曆工具</li><li>Telegram 與 Email 交辦、排程任務</li><li>長期記憶與技能</li><li>/upgrade 自動升級、可回滾</li></ul>
      <a class="btn primary" href="${b}/install">免費開始安裝</a></div>
    <div class="card plan"><span class="badge o">洽詢</span><h3>團隊導入</h3><div class="price" style="font-size:28px">依需求報價</div><p class="muted small">幫公司或團隊的多個帳號導入</p>
      <ul><li>協助多帳號安裝與設定</li><li>依團隊流程客製技能與排程</li><li>權限與審批規則規劃</li><li>導入教學</li></ul>
      <a class="btn ghost" href="mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('GAS Agent 團隊導入洽詢')}">聯絡我們</a></div>
  </div>
</section>

<section id="faq">
  <div class="eyebrow">常見問題</div>
  <h2 class="sec-h">安裝前你可能想知道</h2>
  <div class="faq">${faqs.map((f) => `<details><summary>${esc(f[0])}</summary><p>${esc(f[1])}</p></details>`).join('')}</div>
</section>

<section id="upgrade">
  <div class="card" style="display:flex;flex-wrap:wrap;gap:16px 24px;align-items:center">
    <div style="flex:1;min-width:260px"><h3 style="font-size:19px;margin-bottom:4px">已經裝好了？讓它能自己升級</h3><p class="muted small" style="margin:0">在 Telegram 對 bot 輸入 <code>/upgrade login</code> 會拿到同一個連結；授權後回 Telegram 輸入 <code>/upgrade code 取件碼</code>。</p></div>
    <a class="btn ghost" href="${b}/upgrade/start">取得升級授權</a>
  </div>
</section>

<div class="band">
  <h2>今天就把瑣事交出去</h2>
  <p>三分鐘裝好，公測期間免費。</p>
  <a class="btn primary lg" href="${b}/install">免費開始安裝</a>
  <p class="small" style="margin-top:16px">也可以 <a href="${b}/install/start">直接用 Google 登入並安裝</a>（已經開啟 Apps Script API 的人）</p>
</div>`, { baseUrl: o.baseUrl, nav: true, cta: true, wide: true, index: true });
}

/**
 * 安裝前準備（流程第 1 步）。
 * @param {{baseUrl: string, version: string, privacyUrl: string}} o
 */
function prep(o) {
  const b = esc(o.baseUrl || defaultBase);
  return layout('安裝前準備 — GAS Agent', `
${stepper(1)}
<div class="eyebrow">安裝前準備</div>
<h1 class="page-h">兩件事確認好，就能開始</h1>
<p class="muted">接下來會用你的 Google 帳號建立 GAS Agent v${esc(o.version)}。請用<strong>要讓 agent 住進去的那個帳號</strong>操作。</p>

<div class="card" style="margin-top:28px">
  <div class="task"><span class="k">1</span><div>
    <h3>開啟 Google Apps Script API</h3>
    <p>Google 規定這個開關只能由帳號本人打開。打開設定頁後，把「Google Apps Script API」切到<strong>開啟</strong>，再回到這裡。</p>
    <div class="act"><a class="btn ghost sm" href="${esc(USERSETTINGS_URL)}" target="_blank" rel="noopener">打開 Apps Script 設定 ↗</a></div>
    <label class="check"><input type="checkbox" data-req> <span>我已經把 Google Apps Script API 打開了</span></label>
  </div></div>
</div>

<div class="card" style="margin-top:16px">
  <div class="task"><span class="k">2</span><div>
    <h3>先看一下會出現的授權畫面</h3>
    <p>GAS Agent 是個人開源專案，還沒送 Google 商業驗證，所以會看到一個警告畫面，這是正常的。</p>
    <div class="shot"><span class="w">⚠ Google 尚未驗證這個應用程式</span><ol><li>點左下角「進階」</li><li>點「前往 GAS Agent（不安全）」</li><li>勾選權限後按「繼續」</li></ol></div>
    <p style="margin-top:14px">安裝服務只要求這些權限：</p>
    <ul class="perm"><li>建立與修改你的 Apps Script 專案</li><li>更新這個專案的部署</li><li>知道你的 Email（顯示在完成頁）</li><li class="no">不會讀取 Gmail、Drive、日曆</li></ul>
    <label class="check"><input type="checkbox" data-req> <span>我了解，並同意 <a href="${b}/privacy" target="_blank">隱私權政策與服務條款</a></span></label>
  </div></div>
</div>

<div class="go">
  <a class="btn primary lg" href="${b}/install/start" data-gate>用 Google 登入並安裝</a>
  <span class="note">授權後約需 20–40 秒自動建置，請不要關閉視窗。</span>
</div>`, { baseUrl: o.baseUrl });
}

/**
 * 安裝完成（流程第 4 步：上手清單）。
 * @param {{email: string, scriptId: string, editorUrl: string, adminUrl: string, webhookUrl: string, code: string, version: string, ttlHours: number}} o
 */
function installed(o) {
  const cmd = `/upgrade code ${o.code}`;
  return layout('安裝完成 — GAS Agent', `
${stepper(4)}
<div class="done-h">
  <div class="mark">✓</div>
  <div class="eyebrow">安裝完成</div>
  <h1 class="page-h">你的 GAS Agent 已經就位</h1>
  <p>已在 <strong style="color:var(--ink)">${esc(o.email || '你的帳號')}</strong> 建立 v${esc(o.version)}。再完成下面四步，就能開始交辦。</p>
</div>

<div class="alert">這個頁面只會出現一次。請先把下面的網址和取件碼存好（取件碼 ${esc(o.ttlHours)} 小時內有效、只能用一次）。</div>

<div class="card">
  <div class="task"><span class="k">1</span><div>
    <h3>打開管理頁，完成授權與安裝</h3>
    <p>第一次打開時 Google 會請你授權 agent 使用 Gmail、Drive、日曆等（一樣會看到「尚未驗證」，點「進階」繼續）。授權後按頁面上的「安裝」，就會建好資料庫試算表與排程。</p>
    <div class="act"><a class="btn primary sm" href="${esc(o.adminUrl)}" target="_blank" rel="noopener">打開管理頁 ↗</a><span class="small muted">只有你本人能打開</span></div>
  </div></div>
  <div class="task"><span class="k">2</span><div>
    <h3>接上 AI 模型</h3>
    <p>在管理頁的「模型」分頁填入你的 API 金鑰，或用 ChatGPT / Google 帳號登入。可以設多組備援。</p>
  </div></div>
  <div class="task"><span class="k">3</span><div>
    <h3>接上 Telegram</h3>
    <p>在「通道」分頁貼上 Telegram bot token，填入下面的 webhook 網址並按「設定 webhook」，再把你自己的 Telegram user id 加進白名單。</p>
  </div></div>
  <div class="task"><span class="k">4</span><div>
    <h3>開啟自動升級</h3>
    <p>在 Telegram 對你的 bot 傳這行指令，之後輸入 <code>/upgrade</code> 就能自己更新到新版。</p>
    ${copyField('Telegram 指令', cmd)}
  </div></div>
</div>

<h2 style="font-size:20px;margin:40px 0 4px">你的安裝資訊</h2>
<p class="muted small">請存下來，之後設定或排除問題時會用到。</p>
<div class="card" style="margin-top:12px">
  ${copyField('管理頁（只限你本人）', o.adminUrl, true)}
  ${copyField('Telegram webhook 網址（設定通道時要填）', o.webhookUrl)}
  <div class="field"><label>升級取件碼</label><div class="code">${esc(o.code)}</div></div>
  <p class="small muted" style="margin-top:14px">Apps Script 專案 <code>${esc(o.scriptId)}</code> · <a href="${esc(o.editorUrl)}" target="_blank" rel="noopener">在編輯器打開</a></p>
</div>
<p class="small muted" style="text-align:center;margin-top:24px">取件碼被領走後，Zai Studio 就不再保有任何你的資料。遇到問題？<a href="mailto:${CONTACT_EMAIL}">聯絡我們</a></p>`, { baseUrl: o.baseUrl });
}

/**
 * 升級授權完成（既有 agent）。
 * @param {{email: string, code: string, ttlHours: number, baseUrl: (string|undefined)}} o
 */
function loginDone(o) {
  const cmd = `/upgrade code ${o.code}`;
  return layout('升級授權完成 — GAS Agent', `
<div class="done-h" style="margin-top:56px">
  <div class="mark">✓</div>
  <div class="eyebrow">授權完成</div>
  <h1 class="page-h">最後一步：回到 Telegram</h1>
  <p>帳號 <strong style="color:var(--ink)">${esc(o.email || '')}</strong>。對你的 bot 傳下面這行指令，agent 就能自己升級。</p>
</div>
<div class="card" style="margin-top:20px">
  ${copyField('Telegram 指令', cmd)}
  <div class="field"><label>取件碼</label><div class="code">${esc(o.code)}</div></div>
</div>
<p class="small muted" style="text-align:center;margin-top:20px">取件碼 ${esc(o.ttlHours)} 小時內有效、只能用一次；agent 領走後 Zai Studio 就不再保有任何你的資料。之後輸入 <code>/upgrade</code> 就能檢查並升級。</p>`, { baseUrl: o.baseUrl });
}

/**
 * 錯誤頁。
 * @param {{message: string, retryUrl: string, hint: (string|undefined), baseUrl: (string|undefined)}} o
 */
function error(o) {
  return layout('出了點問題 — GAS Agent', `
<div class="done-h" style="margin-top:56px">
  <div class="mark err">!</div>
  <div class="eyebrow" style="color:var(--err)">失敗</div>
  <h1 class="page-h">這一步沒有完成</h1>
</div>
<div class="alert err"><p style="margin:0">${esc(o.message)}</p>${o.hint ? `<p class="muted" style="margin:8px 0 0">${esc(o.hint)}</p>` : ''}</div>
<div class="go" style="justify-content:center"><a class="btn primary" href="${esc(o.retryUrl)}">再試一次</a><a class="btn ghost" href="mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('GAS Agent 安裝問題')}">聯絡我們</a></div>`, { baseUrl: o.baseUrl });
}

/**
 * 隱私權政策與服務條款（與 repo 的 PRIVACY.md 同步）。
 * @param {{baseUrl: string}} o
 */
function privacy(o) {
  return layout('隱私權政策與服務條款 — GAS Agent', `
<div class="legal" style="margin-top:48px">
<div class="eyebrow">法律資訊</div>
<h1 class="page-h">隱私權政策與服務條款</h1>
<p class="muted">GAS Agent 是開源的個人 agent，程式碼在 <a href="https://github.com/jinyaolin/GASAGENT" rel="noopener">github.com/jinyaolin/GASAGENT</a>。它以 Google Apps Script 的形式安裝在<strong>使用者自己的 Google 帳號</strong>裡，由使用者本人部署、本人授權、本人使用。</p>
<h2>隱私權政策</h2>
<ul>
<li><b>資料存放</b>：對話、記憶、設定、紀錄全部存在使用者自己 Google Drive 裡的試算表與資料夾；API 金鑰與 token 只存在該 Apps Script 專案的 Script Properties。開發者無法存取任何使用者的資料。</li>
<li><b>安裝服務</b>：zaistudio.tw/agent 只在使用者授權後，暫存一組 Apps Script 專案的授權（最多 ${esc(o.ttlHours || 24)} 小時），供使用者自己的 agent 領取，領取後立即刪除；不保存其他任何資料。</li>
<li><b>資料用途</b>：Gmail、Drive、文件、試算表、簡報、日曆等權限只用於執行使用者本人（或其授權的通道，例如本人的 Telegram）下達的任務。</li>
<li><b>第三方</b>：使用者自行設定的 AI 模型供應商（例如 OpenAI 相容服務、Anthropic、Google Gemini、Z.ai）會收到使用者交付任務時提供的內容；除此之外不會把資料傳給任何第三方，也沒有任何分析或追蹤。</li>
<li><b>程式更新</b>：<code>/upgrade</code> 只會從上述 GitHub repo 讀取公開的程式碼，不會上傳任何資料。</li>
<li><b>刪除</b>：使用者可隨時刪除 Apps Script 專案、Drive 裡的「GAS Agent」資料夾與試算表，即完全移除所有資料。</li>
</ul>
<h2>服務條款</h2>
<ul>
<li>本軟體依 repo 內授權條款以「現狀」提供，不附任何明示或默示的保證。</li>
<li>使用者須自行負責其 Google 帳號、AI 供應商帳號與 Telegram bot 的安全與費用。</li>
<li>使用者對 agent 代為執行的動作（寄信、建立或修改檔案等）負完全責任；本軟體預設把高風險動作送審批，但最終決定權與責任在使用者。</li>
<li>本服務目前為公測，不提供服務水準承諾，內容與方案可能變更。</li>
</ul>
<p class="muted" style="margin-top:28px">聯絡：<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
</div>`, { baseUrl: o.baseUrl, index: true });
}

module.exports = { landing, prep, installed, loginDone, error, privacy, esc, setBaseUrl };
