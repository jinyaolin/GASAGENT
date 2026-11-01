/**
 * @fileoverview Script Properties 封裝與 owner 驗證。
 *
 * 設計原則（見 vault 規格「安全模型」）：
 * - 金鑰、owner email、DB id 這類身分/連線資訊只放 Script Properties。
 * - 其他可調設定走 DB spreadsheet 的 Config tab（M1 以後）。
 * - 以 `_` 結尾的函式是私有 helper，google.script.run 無法從前端呼叫。
 */

/** 應用版本，顯示於管理頁與 Doctor。 */
const APP_VERSION = '0.1.0-m1';

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
]);

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
