/**
 * @fileoverview 私有 DB spreadsheet：開/建、tab schema、幂等補齊。
 *
 * 資料真相在 Sheet（規格「儲存」段）。CacheService 之後只當熱快取。
 * 本檔做 schema 與以表頭為鍵的通用列讀寫（readTable_ / appendTableRow_ / writeTableRow_）；
 * 各 tab 的業務邏輯在對應檔案（Providers.gs 等）。
 */

/** DB spreadsheet 檔名。 */
const DB_NAME = 'GAS Agent DB';

/**
 * 每個 tab 的表頭（第一列）。順序即欄位順序；既有 tab 缺欄會往右補，不重排。
 * 與 vault 規格「資料模型」表一致。
 * @type {!Object<string, !Array<string>>}
 */
const DB_SCHEMA = Object.freeze({
  Config: ['key', 'value', 'updated'],
  Providers: ['id', 'label', 'protocol', 'base_url', 'model', 'role', 'priority', 'enabled', 'extra_headers', 'max_tokens',
    'extra_body', 'cost_in_per_m', 'cost_out_per_m'],
  Sessions: ['id', 'channel', 'external_id', 'title', 'summary', 'model_override', 'token_est', 'created', 'last_active', 'status',
    'compact_seq', 'turns', 'last_curated_turn', 'embedding', 'skill_proposed_turn'],
  Messages: ['session_id', 'seq', 'role', 'content', 'tokens', 'ts'],
  Memory: ['id', 'content', 'category', 'created', 'updated', 'source_session', 'pinned'],
  UserProfile: ['id', 'content', 'category', 'created', 'updated', 'source_session', 'pinned'],
  Cron: ['id', 'name', 'schedule', 'next_run', 'prompt', 'skills', 'deliver_to', 'model_pin', 'enabled', 'last_run', 'last_status'],
  Watchers: ['id', 'name', 'type', 'config', 'prompt', 'deliver_to', 'model_pin', 'skills', 'every_minutes', 'enabled', 'cursor', 'next_check', 'last_check', 'last_fired', 'last_status'],
  Queue: ['id', 'type', 'session_id', 'payload', 'state', 'attempts', 'started', 'finished', 'error'],
  Approvals: ['id', 'job_id', 'tool', 'args', 'reason', 'state', 'decided_at', 'result'],
  AuditLog: ['ts', 'session_id', 'tool', 'args_preview', 'result_preview', 'ok', 'ms', 'principal'],
  Usage: ['ts', 'provider', 'model', 'prompt_tokens', 'completion_tokens', 'cost_est', 'session_id', 'ms', 'ok'],
});

/** tab 名稱清單（依 schema 順序）。 */
const DB_TABS = Object.freeze(Object.keys(DB_SCHEMA));

/** 單次執行內的 spreadsheet 快取。 */
let dbSpreadsheetCache_ = null;

/**
 * 取得已安裝的 DB spreadsheet。
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 * @throws {Error} 未安裝或無法開啟
 */
function getDb_() {
  if (dbSpreadsheetCache_) return dbSpreadsheetCache_;
  const id = getDbSpreadsheetId_();
  if (!id) throw new Error('尚未安裝：DB_SPREADSHEET_ID 未設定，請先執行 installAgent()。');
  dbSpreadsheetCache_ = SpreadsheetApp.openById(id);
  return dbSpreadsheetCache_;
}

/**
 * 取得某個 tab。
 * @param {string} tab
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 * @throws {Error} tab 不存在
 */
function getDbSheet_(tab) {
  const sheet = getDb_().getSheetByName(tab);
  if (!sheet) throw new Error(`DB 缺少 tab「${tab}」，請執行 installAgent() 補齊。`);
  return sheet;
}

/** @return {string} DB spreadsheet 的網址；未安裝為空字串。 */
function getDbUrl_() {
  const id = getDbSpreadsheetId_();
  return id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : '';
}

/**
 * 開既有 DB；若 Properties 沒有 id、檔案打不開或已在垃圾桶，就建一個新的並寫回 Properties。
 * @return {{spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet, created: boolean}}
 */
function openOrCreateDb_() {
  const id = getDbSpreadsheetId_();
  if (id) {
    try {
      const existing = SpreadsheetApp.openById(id);
      if (!DriveApp.getFileById(id).isTrashed()) {
        dbSpreadsheetCache_ = existing;
        return { spreadsheet: existing, created: false };
      }
    } catch (err) {
      // 打不開就往下建新的；舊 id 會被覆寫。
      console.warn(`既有 DB (${id}) 無法開啟，將重建：${err && err.message}`);
    }
  }
  const created = SpreadsheetApp.create(DB_NAME);
  setProp_(PROP.DB_SPREADSHEET_ID, created.getId());
  dbSpreadsheetCache_ = created;
  return { spreadsheet: created, created: true };
}

/**
 * 幂等建立 schema：缺的 tab 補上、既有 tab 缺的欄位往右補、既有資料不動。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {boolean=} dropBlankDefaultSheet 剛建好的 spreadsheet 會帶一張預設空白工作表，
 *   傳 true 才刪它；對既有 spreadsheet 一律不刪任何非 schema 的 tab。
 * @return {{createdTabs: !Array<string>, existingTabs: !Array<string>, addedColumns: !Object<string, !Array<string>>}}
 */
function ensureDbSchema_(ss, dropBlankDefaultSheet) {
  const report = { createdTabs: [], existingTabs: [], addedColumns: {} };
  DB_TABS.forEach((tab) => {
    let sheet = ss.getSheetByName(tab);
    if (!sheet) {
      sheet = ss.insertSheet(tab, ss.getSheets().length);
      report.createdTabs.push(tab);
    } else {
      report.existingTabs.push(tab);
    }
    const result = ensureHeaders_(sheet, DB_SCHEMA[tab]);
    if (!result.written && result.added.length) report.addedColumns[tab] = result.added;
  });

  if (dropBlankDefaultSheet) {
    ss.getSheets()
      .filter((s) => DB_TABS.indexOf(s.getName()) === -1 && isSheetBlank_(s))
      .forEach((s) => ss.deleteSheet(s));
  }
  return report;
}

/**
 * 確保第一列有指定表頭。空白工作表直接寫整列；已有表頭則只把缺的欄位接在最右邊。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {!Array<string>} headers
 * @return {{written: boolean, added: !Array<string>}} written=true 表示整列是這次新寫的
 */
function ensureHeaders_(sheet, headers) {
  const existing = readHeaders_(sheet);
  if (existing.length === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return { written: true, added: headers.slice() };
  }
  const missing = headers.filter((h) => existing.indexOf(h) === -1);
  if (missing.length) {
    const startCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, startCol, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  if (sheet.getFrozenRows() < 1) sheet.setFrozenRows(1);
  return { written: false, added: missing };
}

/**
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {!Array<string>} 第一列非空白的表頭
 */
function readHeaders_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map((v) => String(v).trim())
    .filter((v) => v !== '');
}

/**
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {boolean}
 */
function isSheetBlank_(sheet) {
  return sheet.getLastRow() === 0 && sheet.getLastColumn() === 0;
}

/**
 * 比對目前 DB 與 DB_SCHEMA，供 Doctor 與測試使用；不修改任何東西。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {!Array<{tab: string, exists: boolean, missingColumns: !Array<string>, extraColumns: !Array<string>}>}
 */
function inspectDbSchema_(ss) {
  return DB_TABS.map((tab) => {
    const sheet = ss.getSheetByName(tab);
    if (!sheet) return { tab, exists: false, missingColumns: DB_SCHEMA[tab].slice(), extraColumns: [] };
    const have = readHeaders_(sheet);
    const want = DB_SCHEMA[tab];
    return {
      tab,
      exists: true,
      missingColumns: want.filter((h) => have.indexOf(h) === -1),
      extraColumns: have.filter((h) => want.indexOf(h) === -1),
    };
  });
}

// ---- 以表頭為鍵的通用列讀寫 ------------------------------------------------------
//
// 每列對應一個 object，key 是第一列表頭；多出的欄位忽略、缺的欄位寫空字串。
// 回傳的列帶 `_row`（1-based 列號）供 writeTableRow_ / deleteTableRow_ 使用。

/**
 * 讀整張 tab（不含表頭）。全空白的列會被略過。
 * @param {string} tab
 * @return {{headers: !Array<string>, rows: !Array<!Object>}}
 */
function readTable_(tab) {
  const sheet = getDbSheet_(tab);
  const headers = readHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (!headers.length || lastRow < 2) return { headers, rows: [] };
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const rows = [];
  values.forEach((vals, i) => {
    if (!vals.some((v) => v !== '' && v !== null)) return;
    const row = { _row: i + 2 };
    headers.forEach((h, c) => { row[h] = vals[c]; });
    rows.push(row);
  });
  return { headers, rows };
}

/**
 * 在 tab 末端追加一列。
 * @param {string} tab
 * @param {!Object} obj 以表頭為 key
 * @return {number} 新列的列號
 */
function appendTableRow_(tab, obj) {
  const sheet = getDbSheet_(tab);
  const headers = readHeaders_(sheet);
  sheet.appendRow(rowValues_(headers, obj));
  return sheet.getLastRow();
}

/**
 * 覆寫指定列（整列依表頭重寫）。
 * @param {string} tab
 * @param {number} rowIndex 1-based 列號（≥ 2）
 * @param {!Object} obj
 */
function writeTableRow_(tab, rowIndex, obj) {
  if (rowIndex < 2) throw new Error('writeTableRow_ 不可覆寫表頭列');
  const sheet = getDbSheet_(tab);
  const headers = readHeaders_(sheet);
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([rowValues_(headers, obj)]);
}

/**
 * 刪除指定列。
 * @param {string} tab
 * @param {number} rowIndex 1-based 列號（≥ 2）
 */
function deleteTableRow_(tab, rowIndex) {
  if (rowIndex < 2) throw new Error('deleteTableRow_ 不可刪表頭列');
  getDbSheet_(tab).deleteRow(rowIndex);
}

/**
 * @param {!Array<string>} headers
 * @param {!Object} obj
 * @return {!Array<*>} 依表頭順序的值；object / array 會 JSON 化，null/undefined 為空字串
 */
function rowValues_(headers, obj) {
  return headers.map((h) => {
    const v = obj[h];
    if (v === null || v === undefined) return '';
    if (typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
    return v;
  });
}
