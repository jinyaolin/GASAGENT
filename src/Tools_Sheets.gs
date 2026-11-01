/**
 * @fileoverview sheets toolset：建立 / 讀範圖 / 寫範圍 / 追加列 / 設公式 / 加圖表。用 SpreadsheetApp。
 * range 一律 A1 表示法，可帶工作表名（例 `工作表1!A1:C10`）；省略工作表名時用第一張。
 */

const SHEETS_READ_MAX_ROWS = 500;
const SHEETS_READ_DEFAULT_ROWS = 200;
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

// ---- handlers ------------------------------------------------------------------------

function sheetsCreate_(args) {
  const ss = SpreadsheetApp.create(requireString_(args.title, 'title'));
  const sheet = ss.getSheets()[0];
  if (args.sheet_name) sheet.setName(String(args.sheet_name));
  if (Array.isArray(args.header) && args.header.length) {
    sheet.getRange(1, 1, 1, args.header.length).setValues([args.header.map(String)]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  if (args.folder_id) DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(String(args.folder_id)));
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
