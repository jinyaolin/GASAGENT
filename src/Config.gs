/**
 * @fileoverview Script Properties 封裝與 owner 驗證。
 *
 * 設計原則（見 vault 規格「安全模型」）：
 * - 金鑰、owner email、DB id 這類身分/連線資訊只放 Script Properties。
 * - 其他可調設定走 DB spreadsheet 的 Config tab（M1 以後）。
 * - 以 `_` 結尾的函式是私有 helper，google.script.run 無法從前端呼叫。
 */

/** 應用版本，顯示於管理頁與 Doctor。 */
const APP_VERSION = '0.8.1';

/** Script Properties 鍵名。 */
const PROP = Object.freeze({
  /** 安裝者 email；所有後端入口都比對它。 */
  OWNER_EMAIL: 'OWNER_EMAIL',
  /** 私有 DB spreadsheet 的 id。 */
  DB_SPREADSHEET_ID: 'DB_SPREADSHEET_ID',
  /**
   * 由 enqueue（M4）設為 '1'。queueTick 先看這個旗標，沒設就不開 DB 直接 return，
   * 讓每分鐘 trigger 在閒置時幾乎不耗 trigger 配額。
   */
  QUEUE_DIRTY: 'QUEUE_DIRTY',
  /** web_search 的搜尋 API key（Brave / Google Programmable Search）；引擎與 cx 在 Config。 */
  WEB_SEARCH_KEY: 'WEB_SEARCH_KEY',
  /** Odoo 的 API key（或密碼）；URL / db / 登入帳號 / model 白名單在 Config。 */
  ODOO_API_KEY: 'ODOO_API_KEY',
  /**
   * 最早到期的排程時間（ISO）。Cron 有異動時由 refreshCronNextRunProp_ 更新；queueTick 閒置時連同 QUEUE_DIRTY
   * 一起看，兩者都沒到就不開 spreadsheet。
   */
  CRON_NEXT_RUN: 'CRON_NEXT_RUN',
  /** M6：Telegram bot token（只在 Script Properties，管理頁只顯示末 4 碼）。 */
  TELEGRAM_BOT_TOKEN: 'TELEGRAM_BOT_TOKEN',
  /** M6：webhook URL 的 query secret（32 字元），doPost 比對 e.parameter.key。 */
  TELEGRAM_WEBHOOK_SECRET: 'TELEGRAM_WEBHOOK_SECRET',
  /** M6：Email 指令信下次掃描時間（ISO）；空 = 停用。queueTick 閒置時連同另兩個旗標一起看。 */
  EMAIL_NEXT_SCAN: 'EMAIL_NEXT_SCAN',
  /** M7-B：最早到期的 watcher 檢查時間（ISO），上限 now + WATCH_IDLE_RESCAN_MINUTES；永遠有值（直接改表也會被撿到）。 */
  WATCH_NEXT_CHECK: 'WATCH_NEXT_CHECK',
  /** M7-B：上次真的開 Watchers tab 掃描的時間（ISO）；Doctor / /status 用來判斷監看有沒有在跑。 */
  WATCH_LAST_SCAN: 'WATCH_LAST_SCAN',
  /** 清理（保留期限）：下次 / 上次跑的時間（ISO）。空 = 還沒排過（第一次 tick 會排 24 小時後）。 */
  HOUSEKEEP_NEXT_RUN: 'HOUSEKEEP_NEXT_RUN',
  HOUSEKEEP_LAST_RUN: 'HOUSEKEEP_LAST_RUN',
  /** 委託寄件者（Telegram /owner）：JSON {email: passkey}。只在 Script Properties，管理頁與 Telegram 只列 email。 */
  EMAIL_DELEGATE_KEYS: 'EMAIL_DELEGATE_KEYS',
  /** 程式升級（Upgrade.gs）：來源 repo（owner/name）與 ref；沒設用 jinyaolin/GASAGENT main。只能在這裡改，Telegram 不能改。 */
  UPGRADE_REPO: 'UPGRADE_REPO',
  UPGRADE_REF: 'UPGRADE_REF',
  /** 認不出部署 A / B 時手動指定部署 id（通常不用）。 */
  UPGRADE_DEPLOY_A: 'UPGRADE_DEPLOY_A',
  UPGRADE_DEPLOY_B: 'UPGRADE_DEPLOY_B',
  /** 上次升級 / 回滾（JSON）、可回滾的備份（JSON {fileId, name, version, at}）、升級後第一次 tick 要跑 post-install 的旗標（JSON）。 */
  UPGRADE_LAST: 'UPGRADE_LAST',
  UPGRADE_BACKUP: 'UPGRADE_BACKUP',
  UPGRADE_POST_INSTALL: 'UPGRADE_POST_INSTALL',
  /** 各 provider 的 API key 以 `PROVIDER_KEY_<id>` 存放（見 Providers.gs），不在此列舉。 */
});

/**
 * appsscript.json 宣告的 OAuth scopes。Doctor 拿實際授權的 token 來比對。
 * 改 appsscript.json 時這裡要一起改。
 */
const REQUIRED_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/script.external_request',
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/userinfo.email',
  // Upgrade.gs：Apps Script API 改寫自己（updateContent / versions）與切換部署
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
]);

/**
 * 母 scope → 它涵蓋的子 scope 前綴。Apps Script 自動推斷（manifest 沒列 scopes 時）給 GmailApp 的是完整的
 * https://mail.google.com/，tokeninfo 不會另外列出 gmail.modify，但權限其實足夠；Doctor 比對時要認得。
 */
const SCOPE_SUPERSETS = Object.freeze({
  'https://mail.google.com/': ['https://www.googleapis.com/auth/gmail.'],
  'https://www.googleapis.com/auth/drive': ['https://www.googleapis.com/auth/drive.'],
  'https://www.googleapis.com/auth/calendar': ['https://www.googleapis.com/auth/calendar.'],
  'https://www.googleapis.com/auth/spreadsheets': ['https://www.googleapis.com/auth/spreadsheets.'],
  'https://www.googleapis.com/auth/documents': ['https://www.googleapis.com/auth/documents.'],
  'https://www.googleapis.com/auth/presentations': ['https://www.googleapis.com/auth/presentations.'],
});

/**
 * 某個需要的 scope 是否已被授權（本身在清單裡，或被母 scope 涵蓋）。純函式。
 * @param {string} required
 * @param {!Array<string>} granted
 * @return {boolean}
 */
function scopeGranted_(required, granted) {
  if (granted.indexOf(required) !== -1) return true;
  return Object.keys(SCOPE_SUPERSETS).some((sup) => granted.indexOf(sup) !== -1 && SCOPE_SUPERSETS[sup].some((prefix) => required.indexOf(prefix) === 0));
}

/**
 * @param {!Array<string>} granted
 * @return {!Array<string>} REQUIRED_SCOPES 裡尚未授權的
 */
function missingScopes_(granted) {
  return REQUIRED_SCOPES.filter((s) => !scopeGranted_(s, granted || []));
}

/** appsscript.json 設定的時區；Doctor 會比對。 */
const EXPECTED_TIME_ZONE = 'Asia/Taipei';

/** @return {GoogleAppsScript.Properties.Properties} */
function getProps_() {
  return PropertiesService.getScriptProperties();
}

/**
 * 讀 Script Property；不存在回空字串。
 * @param {string} key
 * @return {string}
 */
function getProp_(key) {
  const value = getProps_().getProperty(key);
  return value === null ? '' : value;
}

/**
 * 寫 Script Property；傳空值等同刪除。
 * @param {string} key
 * @param {?string|number|boolean} value
 */
function setProp_(key, value) {
  if (value === null || value === undefined || value === '') {
    getProps_().deleteProperty(key);
  } else {
    getProps_().setProperty(key, String(value));
  }
}

/** @return {string} OWNER_EMAIL，未安裝時為空字串。 */
function getOwnerEmail_() {
  return getProp_(PROP.OWNER_EMAIL);
}

/** @return {string} DB spreadsheet id，未安裝時為空字串。 */
function getDbSpreadsheetId_() {
  return getProp_(PROP.DB_SPREADSHEET_ID);
}

/**
 * @param {?string} email
 * @return {string} 去空白、轉小寫
 */
function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Owner 驗證。每個 google.script.run 後端入口與 doGet 的第一行都要呼叫。
 *
 * 在「以我執行」的部署下，Session.getEffectiveUser() 永遠是部署者本人，所以不能拿它當門禁。
 * 真正能分辨「是不是 owner 本人在看」的是 Session.getActiveUser()：
 *   - owner 自己開頁面：回 owner 的 email（自己永遠看得到自己）。
 *   - 其他人或匿名訪客（部署若被誤設成「任何人」）：消費者帳號下回空字串。
 * 因此這裡要求 active user **必須存在且等於 owner**，空字串一律拒絕。
 * 部署的存取等級「只限我」仍是第一道門，這裡是第二道，兩道都要過。
 *
 * @throws {Error} 未安裝或不是 owner
 */
function assertOwner() {
  const active = Session.getActiveUser().getEmail();
  if (!active) {
    throw new Error('拒絕存取：無法識別目前使用者（匿名或非 owner）。請確認 Web App 部署為「以我執行 / 只限我」並以 owner 帳號登入。');
  }
  assertOwnerEmail_(active);
}

/**
 * assertOwner 的核心比對，參數可注入供測試。
 * @param {string} email 要驗證的 email
 * @param {string=} expectedOwner 省略時讀 OWNER_EMAIL
 * @throws {Error}
 */
function assertOwnerEmail_(email, expectedOwner) {
  const owner = normalizeEmail_(expectedOwner === undefined ? getOwnerEmail_() : expectedOwner);
  if (!owner) {
    throw new Error('尚未安裝：OWNER_EMAIL 未設定，請先在 Apps Script 編輯器執行 installAgent()。');
  }
  if (normalizeEmail_(email) !== owner) {
    throw new Error('拒絕存取：目前使用者不是這個 agent 的 owner。');
  }
}

// ---- Config sheet（可調設定；M2 起使用）------------------------------------------
//
// 一列一個 key：value 一律存字串（object 自動 JSON 化），updated 記最後修改時間。
// 金鑰與身分資訊仍在 Script Properties，這裡只放「可調」設定：RBAC 開關、審批策略、人格、門檻值等。

/**
 * 讀整張 Config 成 {key: value}；value 一律轉成字串，空值為 ''。
 * @return {!Object<string, string>}
 */
function getConfigMap_() {
  const map = {};
  readTable_('Config').rows.forEach((r) => {
    const key = String(r.key || '').trim();
    if (!key) return;
    map[key] = r.value === null || r.value === undefined ? '' : String(r.value);
  });
  return map;
}

/**
 * 寫入多個設定值（以 key upsert）。object / array 會 JSON 化；null / undefined 寫成空字串（保留列）。
 * @param {!Object<string, *>} values
 * @return {!Array<string>} 寫入的 key
 */
function setConfigValues_(values) {
  const sheet = getDbSheet_('Config');
  const headers = readHeaders_(sheet);
  const col = {};
  headers.forEach((h, i) => { col[h] = i + 1; });
  if (!col.key || !col.value) throw new Error('Config tab 缺 key / value 欄，請執行 installAgent()。');
  const rows = readTable_('Config').rows;
  const now = new Date();
  Object.keys(values).forEach((key) => {
    let v = values[key];
    if (v === null || v === undefined) v = '';
    else if (typeof v === 'object') v = JSON.stringify(v);
    else v = String(v);
    const existing = rows.find((r) => String(r.key || '').trim() === key);
    const rowIndex = existing ? existing._row : sheet.getLastRow() + 1;
    // value 欄先設成純文字格式再寫：否則 Sheets 會把 "111,222" 當千分位數字、"TRUE" 當布林、"09:00" 當時間，
    // 讀回來就變形（Telegram 白名單兩個 id 以上就是這樣消失的）。
    const valueCell = sheet.getRange(rowIndex, col.value);
    valueCell.setNumberFormat('@');
    sheet.getRange(rowIndex, col.key).setValue(key);
    valueCell.setValue(v);
    if (col.updated) sheet.getRange(rowIndex, col.updated).setValue(now);
    if (existing) existing.value = v;
    else rows.push({ _row: rowIndex, key, value: v, updated: now });
  });
  return Object.keys(values);
}
