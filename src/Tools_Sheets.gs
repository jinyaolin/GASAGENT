/**
 * @fileoverview sheets toolset：建立 / 讀範圖 / 寫範圍 / 追加列 / 設公式 / 加圖表。用 SpreadsheetApp。
 * range 一律 A1 表示法，可帶工作表名（例 `工作表1!A1:C10`）；省略工作表名時用第一張。
 */

const SHEETS_READ_MAX_ROWS = 500;
const SHEETS_READ_DEFAULT_ROWS = 200;
const SHEETS_FIND_DEFAULT = 50;
const SHEETS_FIND_MAX = 200;
/** 列工作表時表頭最多回幾格。 */
const SHEETS_HEADER_PREVIEW_COLS = 30;
const SHEETS_WRITE_MAX_CELLS = 5000;
const SHEETS_CHART_TYPES = Object.freeze(['line', 'bar', 'column', 'pie', 'scatter', 'area']);

/** @return {!Array<ToolDecl>} */
function sheetsTools_() {
  const ssId = { type: 'string', description: '試算表的 id' };
  const values2d = { type: 'array', description: '二維陣列（列 × 欄），每格為字串或數字', items: { type: 'array', items: { type: ['string', 'number', 'boolean'] } } };
  return [
    {
      name: 'sheets_create', toolset: 'sheets', risk: 'W',
      description: '建立試算表，可設第一張工作表名稱與表頭列，可指定資料夾。回傳 id 與網址。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          sheet_name: { type: 'string', description: '第一張工作表名稱（選填）' },
          header: { type: 'array', items: { type: 'string' }, description: '表頭列（選填）' },
          folder_id: { type: 'string', description: '目標資料夾 id（選填）' },
        },
        required: ['title'], additionalProperties: false,
      },
      handler: sheetsCreate_,
    },
    {
      name: 'sheets_list_sheets', toolset: 'sheets', risk: 'R',
      description: '列出試算表的所有工作表：名稱、有資料的列 / 欄數、是否隱藏、表頭列（第一列前 30 格）。讀資料前先用這個確認工作表名稱。',
      parameters: {
        type: 'object',
        properties: { spreadsheet_id: ssId },
        required: ['spreadsheet_id'], additionalProperties: false,
      },
      handler: sheetsListSheets_,
    },
    {
      name: 'sheets_find', toolset: 'sheets', risk: 'R',
      description: '在試算表裡找含有 query 文字的儲存格（預設全部工作表、不分大小寫、部分比對），回傳每個命中的工作表 / 位置 / 顯示值。適合在大表裡定位某筆資料再用 sheets_read_range 讀該列。',
      parameters: {
        type: 'object',
        properties: {
          spreadsheet_id: ssId,
          query: { type: 'string', description: '要找的文字' },
          sheet_name: { type: 'string', description: '只找這張工作表（選填）' },
          match_case: { type: 'boolean', description: '區分大小寫，預設 false' },
          entire_cell: { type: 'boolean', description: '整格完全相符才算，預設 false' },
          max_results: { type: 'integer', description: `預設 ${SHEETS_FIND_DEFAULT}，上限 ${SHEETS_FIND_MAX}` },
        },
        required: ['spreadsheet_id', 'query'], additionalProperties: false,
      },
      handler: sheetsFind_,
    },
    {
      name: 'sheets_copy_sheet', toolset: 'sheets', risk: 'W',
      description: '把某份試算表的一張工作表整張複製到另一份試算表（保留公式、格式、驗證、合併格；來源只要有檢視權即可，例如別人分享的表）。target_spreadsheet_id 可與來源相同（同檔複製）。注意：公式若引用來源的其他工作表，複製後會變 #REF!。',
      parameters: {
        type: 'object',
        properties: {
          source_spreadsheet_id: { type: 'string', description: '來源試算表 id' },
          sheet_name: { type: 'string', description: '來源工作表名稱' },
          target_spreadsheet_id: { type: 'string', description: '目標試算表 id' },
          new_name: { type: 'string', description: '新工作表名稱（選填，預設同來源；重名自動加序號）' },
        },
        required: ['source_spreadsheet_id', 'sheet_name', 'target_spreadsheet_id'], additionalProperties: false,
      },
      handler: sheetsCopySheet_,
    },
    {
      name: 'sheets_read_range', toolset: 'sheets', risk: 'R',
      description: '讀取某範圍的顯示值（A1 表示法，可含工作表名；省略 range 則讀第一張工作表有資料的範圍）。最多 max_rows 列。',
      parameters: {
        type: 'object',
        properties: {
          spreadsheet_id: ssId,
          range: { type: 'string', description: '例 工作表1!A1:D20；省略 = 第一張工作表的資料範圍' },
          max_rows: { type: 'integer', description: `預設 ${SHEETS_READ_DEFAULT_ROWS}，上限 ${SHEETS_READ_MAX_ROWS}` },
        },
        required: ['spreadsheet_id'], additionalProperties: false,
      },
      handler: sheetsReadRange_,
    },
    {
      name: 'sheets_write_range', toolset: 'sheets', risk: 'W',
      description: '從 range 的左上角開始覆寫 values（二維陣列）。上限 5000 格。',
      parameters: {
        type: 'object',
        properties: { spreadsheet_id: ssId, range: { type: 'string', description: '起始格或範圍，例 工作表1!A2' }, values: values2d },
        required: ['spreadsheet_id', 'range', 'values'], additionalProperties: false,
      },
      handler: sheetsWriteRange_,
    },
    {
      name: 'sheets_append_rows', toolset: 'sheets', risk: 'W',
      description: '在工作表最後一列之後追加多列。上限 5000 格。',
      parameters: {
        type: 'object',
        properties: { spreadsheet_id: ssId, rows: values2d, sheet_name: { type: 'string', description: '省略 = 第一張' } },
        required: ['spreadsheet_id', 'rows'], additionalProperties: false,
      },
      handler: sheetsAppendRows_,
    },
    {
      name: 'sheets_set_formula', toolset: 'sheets', risk: 'W',
      description: '在單一儲存格設公式（以 = 開頭），回傳計算後的顯示值。',
      parameters: {
        type: 'object',
        properties: { spreadsheet_id: ssId, cell: { type: 'string', description: '例 工作表1!E2' }, formula: { type: 'string', description: '例 =SUM(B2:D2)' } },
        required: ['spreadsheet_id', 'cell', 'formula'], additionalProperties: false,
      },
      handler: sheetsSetFormula_,
    },
    {
      name: 'sheets_add_chart', toolset: 'sheets', risk: 'W',
      description: '依資料範圖插入圖表（line / bar / column / pie / scatter / area），放在 anchor_cell（預設資料範圍右側）。',
      parameters: {
        type: 'object',
        properties: {
          spreadsheet_id: ssId,
          data_range: { type: 'string', description: '含表頭的資料範圍，例 工作表1!A1:C13' },
          chart_type: { type: 'string', enum: SHEETS_CHART_TYPES.slice() },
          title: { type: 'string' },
          anchor_cell: { type: 'string', description: '圖表左上角放哪一格（選填）' },
        },
        required: ['spreadsheet_id', 'data_range', 'chart_type'], additionalProperties: false,
      },
      handler: sheetsAddChart_,
    },
  ];
}

// ---- helpers ------------------------------------------------------------------------

/**
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {*} name 省略為第一張
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function resolveSheet_(ss, name) {
  if (!name) return ss.getSheets()[0];
  const sheet = ss.getSheetByName(String(name));
  if (!sheet) throw new Error(`找不到工作表「${name}」。現有：${ss.getSheets().map((s) => s.getName()).join(', ')}`);
  return sheet;
}

/**
 * A1（可含工作表名）→ Range。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} a1
 * @return {GoogleAppsScript.Spreadsheet.Range}
 */
function resolveRange_(ss, a1) {
  a1 = requireString_(a1, 'range');
  try {
    return a1.indexOf('!') !== -1 ? ss.getRange(a1) : ss.getSheets()[0].getRange(a1);
  } catch (err) {
    throw new Error(`range「${a1}」無法解析：${err && err.message || err}`);
  }
}

/**
 * @param {*} values
 * @param {string} field
 * @return {!Array<!Array<*>>} 補齊成矩形
 */
function normalize2d_(values, field) {
  if (!Array.isArray(values) || !values.length || !values.every(Array.isArray)) throw new Error(`${field} 必須是非空的二維陣列。`);
  const cols = Math.max(...values.map((r) => r.length));
  if (!cols) throw new Error(`${field} 每列至少要有一格。`);
  if (values.length * cols > SHEETS_WRITE_MAX_CELLS) throw new Error(`一次最多寫 ${SHEETS_WRITE_MAX_CELLS} 格（目前 ${values.length}×${cols}）。`);
  return values.map((r) => { const row = r.map((c) => (c === null || c === undefined ? '' : c)); while (row.length < cols) row.push(''); return row; });
}

/**
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {!Object}
 */
function ssInfo_(ss) {
  return { id: ss.getId(), title: ss.getName(), url: ss.getUrl() };
}

/**
 * 在試算表裡找一個沒被用掉的工作表名：name、name (2)、name (3)…。純函式（傳入既有名稱清單）。
 * @param {string} name
 * @param {!Array<string>} existing
 * @return {string}
 */
function uniqueSheetName_(name, existing) {
  const base = String(name || '').trim() || '工作表';
  const taken = (existing || []).map((n) => String(n).toLowerCase());
  if (taken.indexOf(base.toLowerCase()) === -1) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})`;
    if (taken.indexOf(candidate.toLowerCase()) === -1) return candidate;
  }
  throw new Error(`找不到可用的工作表名稱（${base}）。`);
}

// ---- handlers ------------------------------------------------------------------------

function sheetsListSheets_(args) {
  const ss = SpreadsheetApp.openById(requireString_(args.spreadsheet_id, 'spreadsheet_id'));
  const sheets = ss.getSheets().map((sheet, i) => {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const header = lastRow >= 1 && lastCol >= 1
      ? sheet.getRange(1, 1, 1, Math.min(lastCol, SHEETS_HEADER_PREVIEW_COLS)).getDisplayValues()[0]
      : [];
    return {
      index: i + 1, name: sheet.getName(), sheet_id: sheet.getSheetId(), hidden: sheet.isSheetHidden(),
      rows: lastRow, cols: lastCol, frozen_rows: sheet.getFrozenRows(), header,
    };
  });
  return Object.assign(ssInfo_(ss), { count: sheets.length, sheets });
}

function sheetsFind_(args) {
  const ss = SpreadsheetApp.openById(requireString_(args.spreadsheet_id, 'spreadsheet_id'));
  const query = requireString_(args.query, 'query');
  const max = clampInt_(args.max_results, SHEETS_FIND_DEFAULT, 1, SHEETS_FIND_MAX);
  const scope = args.sheet_name ? resolveSheet_(ss, args.sheet_name) : ss;
  const finder = scope.createTextFinder(query).matchCase(!!args.match_case).matchEntireCell(!!args.entire_cell);
  const all = finder.findAll();
  const matches = all.slice(0, max).map((r) => ({
    sheet: r.getSheet().getName(), cell: r.getA1Notation(), row: r.getRow(), col: r.getColumn(), value: r.getDisplayValue(),
  }));
  return Object.assign(ssInfo_(ss), { query, scope: args.sheet_name || '(全部工作表)', count: all.length, truncated: all.length > max, matches });
}

function sheetsCopySheet_(args) {
  const srcId = requireString_(args.source_spreadsheet_id, 'source_spreadsheet_id');
  const dstId = requireString_(args.target_spreadsheet_id, 'target_spreadsheet_id');
  const src = SpreadsheetApp.openById(srcId);
  const sheet = resolveSheet_(src, requireString_(args.sheet_name, 'sheet_name'));
  const dst = srcId === dstId ? src : SpreadsheetApp.openById(dstId);
  let copy;
  try {
    copy = sheet.copyTo(dst);
  } catch (err) {
    throw new Error(`複製工作表失敗（來源若設「禁止下載 / 列印 / 複製」會被擋）：${err && err.message || err}`);
  }
  const wanted = args.new_name ? String(args.new_name).trim() : sheet.getName();
  const others = dst.getSheets().filter((s) => s.getSheetId() !== copy.getSheetId()).map((s) => s.getName());
  const finalName = uniqueSheetName_(wanted, others);
  copy.setName(finalName);
  // 公式若引用來源其他工作表會變 #REF!，掃一下提醒模型
  let refErrors = 0;
  try {
    const range = copy.getDataRange();
    if (range.getNumRows() && range.getNumColumns()) {
      range.getDisplayValues().forEach((row) => row.forEach((v) => { if (v === '#REF!') refErrors++; }));
    }
  } catch (err) { refErrors = -1; }
  return {
    source: Object.assign(ssInfo_(src), { sheet: sheet.getName() }),
    target: Object.assign(ssInfo_(dst), { sheet: finalName, renamed_from_default: finalName !== wanted ? wanted : '' }),
    rows: copy.getLastRow(), cols: copy.getLastColumn(),
    ref_errors: refErrors,
    note: refErrors > 0 ? `有 ${refErrors} 格 #REF!：公式引用了來源試算表的其他工作表，請改用值或一併複製被引用的工作表。` : '',
  };
}

function sheetsCreate_(args) {
  const ss = SpreadsheetApp.create(requireString_(args.title, 'title'));
  const sheet = ss.getSheets()[0];
  if (args.sheet_name) sheet.setName(String(args.sheet_name));
  if (Array.isArray(args.header) && args.header.length) {
    sheet.getRange(1, 1, 1, args.header.length).setValues([args.header.map(String)]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  if (args.folder_id) DriveApp.getFileById(ss.getId()).moveTo(requireFolder_(args.folder_id));
  return Object.assign(ssInfo_(ss), { sheet: sheet.getName() });
}

function sheetsReadRange_(args) {
  const ss = SpreadsheetApp.openById(requireString_(args.spreadsheet_id, 'spreadsheet_id'));
  const range = args.range ? resolveRange_(ss, args.range) : ss.getSheets()[0].getDataRange();
  const max = clampInt_(args.max_rows, SHEETS_READ_DEFAULT_ROWS, 1, SHEETS_READ_MAX_ROWS);
  const all = range.getDisplayValues();
  const values = all.slice(0, max);
  return Object.assign(ssInfo_(ss), {
    sheet: range.getSheet().getName(), range: range.getA1Notation(), rows: all.length, cols: range.getNumColumns(),
    truncated: all.length > max, values,
  });
}

function sheetsWriteRange_(args) {
  const ss = SpreadsheetApp.openById(requireString_(args.spreadsheet_id, 'spreadsheet_id'));
  const values = normalize2d_(args.values, 'values');
  const target = resolveRange_(ss, args.range).offset(0, 0, values.length, values[0].length);
  target.setValues(values);
  return Object.assign(ssInfo_(ss), { sheet: target.getSheet().getName(), range: target.getA1Notation(), rows: values.length, cols: values[0].length });
}

function sheetsAppendRows_(args) {
  const ss = SpreadsheetApp.openById(requireString_(args.spreadsheet_id, 'spreadsheet_id'));
  const sheet = resolveSheet_(ss, args.sheet_name);
  const rows = normalize2d_(args.rows, 'rows');
  const first = sheet.getLastRow() + 1;
  sheet.getRange(first, 1, rows.length, rows[0].length).setValues(rows);
  return Object.assign(ssInfo_(ss), { sheet: sheet.getName(), appended: rows.length, first_row: first, last_row: first + rows.length - 1 });
}

function sheetsSetFormula_(args) {
  const ss = SpreadsheetApp.openById(requireString_(args.spreadsheet_id, 'spreadsheet_id'));
  const formula = requireString_(args.formula, 'formula');
  if (formula[0] !== '=') throw new Error('formula 必須以 = 開頭。');
  const cell = resolveRange_(ss, args.cell);
  if (cell.getNumRows() !== 1 || cell.getNumColumns() !== 1) throw new Error('cell 必須是單一儲存格。');
  cell.setFormula(formula);
  SpreadsheetApp.flush();
  return Object.assign(ssInfo_(ss), { sheet: cell.getSheet().getName(), cell: cell.getA1Notation(), formula, value: cell.getDisplayValue() });
}

function sheetsAddChart_(args) {
  const ss = SpreadsheetApp.openById(requireString_(args.spreadsheet_id, 'spreadsheet_id'));
  const range = resolveRange_(ss, args.data_range);
  const sheet = range.getSheet();
  const typeMap = { line: Charts.ChartType.LINE, bar: Charts.ChartType.BAR, column: Charts.ChartType.COLUMN, pie: Charts.ChartType.PIE, scatter: Charts.ChartType.SCATTER, area: Charts.ChartType.AREA };
  const type = typeMap[String(args.chart_type)];
  if (!type) throw new Error(`chart_type 必須是 ${SHEETS_CHART_TYPES.join(' / ')}。`);
  let row = range.getRow();
  let col = range.getLastColumn() + 2;
  if (args.anchor_cell) {
    const anchor = resolveRange_(ss, args.anchor_cell);
    row = anchor.getRow();
    col = anchor.getColumn();
  }
  const builder = sheet.newChart().setChartType(type).addRange(range).setPosition(row, col, 0, 0)
    .setOption('useFirstRowAsHeaders', true);
  if (args.title) builder.setOption('title', String(args.title));
  sheet.insertChart(builder.build());
  return Object.assign(ssInfo_(ss), { sheet: sheet.getName(), chart_type: args.chart_type, data_range: range.getA1Notation(), charts_on_sheet: sheet.getCharts().length });
}
