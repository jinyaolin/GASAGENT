/**
 * @fileoverview docs toolset：建立 / 讀取 / 追加 / 取代文字 / 插表格 / 大綱。用 DocumentApp。
 *
 * content 參數接受「輕量 markdown」：`# ` `## ` `### ` 標題、`- ` / `* ` 項目、`1. ` 編號、空行分段，其餘為段落。
 * 解析在 parseLiteMarkdown_()（純函式，可測），套用在 appendLiteMarkdown_()。
 */

const DOCS_READ_MAX_CHARS = 50000;
const DOCS_READ_DEFAULT_CHARS = 20000;
const DOCS_TABLE_MAX_CELLS = 400;

/** @return {!Array<ToolDecl>} */
function docsTools_() {
  const docId = { type: 'string', description: 'Google 文件的 id' };
  const content = { type: 'string', description: '內容。支援輕量 markdown：# / ## / ### 標題、- 項目、1. 編號、空行分段' };
  return [
    {
      name: 'docs_create', toolset: 'docs', risk: 'W',
      description: '建立 Google 文件，可同時寫入內容（輕量 markdown），可指定資料夾。回傳 id 與網址。',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, content, folder_id: { type: 'string', description: '目標資料夾 id（選填）' } },
        required: ['title'], additionalProperties: false,
      },
      handler: docsCreate_,
    },
    {
      name: 'docs_read', toolset: 'docs', risk: 'R',
      description: '讀取 Google 文件的純文字內容（超過 max_chars 截斷）。',
      parameters: {
        type: 'object',
        properties: { doc_id: docId, max_chars: { type: 'integer', description: `預設 ${DOCS_READ_DEFAULT_CHARS}，上限 ${DOCS_READ_MAX_CHARS}` } },
        required: ['doc_id'], additionalProperties: false,
      },
      handler: docsRead_,
    },
    {
      name: 'docs_append', toolset: 'docs', risk: 'W',
      description: '在文件末端追加內容（輕量 markdown）。',
      parameters: { type: 'object', properties: { doc_id: docId, content }, required: ['doc_id', 'content'], additionalProperties: false },
      handler: docsAppend_,
    },
    {
      name: 'docs_replace_text', toolset: 'docs', risk: 'W',
      description: '把文件中所有符合 find 的文字換成 replace_with（預設逐字比對；use_regex=true 時 find 視為正規表示式）。回傳取代次數。',
      parameters: {
        type: 'object',
        properties: {
          doc_id: docId,
          find: { type: 'string' },
          replace_with: { type: 'string' },
          use_regex: { type: 'boolean', description: '預設 false' },
        },
        required: ['doc_id', 'find', 'replace_with'], additionalProperties: false,
      },
      handler: docsReplaceText_,
    },
    {
      name: 'docs_insert_table', toolset: 'docs', risk: 'W',
      description: '在文件末端插入表格；rows 是二維字串陣列，第一列為表頭（粗體）。上限 400 格。',
      parameters: {
        type: 'object',
        properties: {
          doc_id: docId,
          rows: { type: 'array', description: '二維陣列，例如 [["欄1","欄2"],["a","b"]]', items: { type: 'array', items: { type: 'string' } } },
          caption: { type: 'string', description: '表格前的說明段落（選填）' },
        },
        required: ['doc_id', 'rows'], additionalProperties: false,
      },
      handler: docsInsertTable_,
    },
    {
      name: 'docs_outline', toolset: 'docs', risk: 'R',
      description: '列出文件的標題大綱（層級與文字），適合先看結構再決定要讀哪段。',
      parameters: { type: 'object', properties: { doc_id: docId }, required: ['doc_id'], additionalProperties: false },
      handler: docsOutline_,
    },
  ];
}

// ---- 輕量 markdown --------------------------------------------------------------------

/**
 * @typedef {{kind: ('heading'|'bullet'|'number'|'paragraph'), level: number, text: string}} LiteBlock
 */

/**
 * 解析輕量 markdown 成區塊。純函式。
 * @param {string} content
 * @return {!Array<LiteBlock>}
 */
function parseLiteMarkdown_(content) {
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'paragraph', level: 0, text: para.join(' ') });
    para = [];
  };
  String(content || '').replace(/\r\n?/g, '\n').split('\n').forEach((line) => {
    const trimmed = line.trim();
    let m;
    if (!trimmed) { flush(); return; }
    if ((m = /^(#{1,3})\s+(.+)$/.exec(trimmed))) { flush(); blocks.push({ kind: 'heading', level: m[1].length, text: m[2].trim() }); return; }
    if ((m = /^[-*•]\s+(.+)$/.exec(trimmed))) { flush(); blocks.push({ kind: 'bullet', level: 0, text: m[1].trim() }); return; }
    if ((m = /^\d+[.)]\s+(.+)$/.exec(trimmed))) { flush(); blocks.push({ kind: 'number', level: 0, text: m[1].trim() }); return; }
    para.push(trimmed);
  });
  flush();
  return blocks;
}

/**
 * 把區塊套到文件 body 末端。
 * @param {GoogleAppsScript.Document.Body} body
 * @param {string} content
 * @return {number} 加了幾個元素
 */
function appendLiteMarkdown_(body, content) {
  const headings = { 1: DocumentApp.ParagraphHeading.HEADING1, 2: DocumentApp.ParagraphHeading.HEADING2, 3: DocumentApp.ParagraphHeading.HEADING3 };
  const blocks = parseLiteMarkdown_(content);
  blocks.forEach((b) => {
    if (b.kind === 'heading') body.appendParagraph(b.text).setHeading(headings[b.level]);
    else if (b.kind === 'bullet') body.appendListItem(b.text).setGlyphType(DocumentApp.GlyphType.BULLET);
    else if (b.kind === 'number') body.appendListItem(b.text).setGlyphType(DocumentApp.GlyphType.NUMBER);
    else body.appendParagraph(b.text).setHeading(DocumentApp.ParagraphHeading.NORMAL);
  });
  return blocks.length;
}

/**
 * @param {GoogleAppsScript.Document.Document} doc
 * @return {!Object}
 */
function docInfo_(doc) {
  return { id: doc.getId(), title: doc.getName(), url: doc.getUrl() };
}

// ---- handlers ------------------------------------------------------------------------

function docsCreate_(args) {
  const title = requireString_(args.title, 'title');
  const doc = DocumentApp.create(title);
  let blocks = 0;
  if (args.content) {
    const body = doc.getBody();
    // 新文件有一個空段落，先把它拿掉再追加，免得開頭多一行。
    blocks = appendLiteMarkdown_(body, args.content);
    if (blocks && body.getNumChildren() > 1) {
      const first = body.getChild(0);
      if (first.getType() === DocumentApp.ElementType.PARAGRAPH && !first.asParagraph().getText()) body.removeChild(first);
    }
  }
  doc.saveAndClose();
  if (args.folder_id) DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(String(args.folder_id)));
  return Object.assign(docInfo_(doc), { blocks });
}

function docsRead_(args) {
  const doc = DocumentApp.openById(requireString_(args.doc_id, 'doc_id'));
  const max = clampInt_(args.max_chars, DOCS_READ_DEFAULT_CHARS, 200, DOCS_READ_MAX_CHARS);
  const t = truncateText_(doc.getBody().getText(), max);
  return Object.assign(docInfo_(doc), { chars: t.total, truncated: t.truncated, text: t.text });
}

function docsAppend_(args) {
  const doc = DocumentApp.openById(requireString_(args.doc_id, 'doc_id'));
  const blocks = appendLiteMarkdown_(doc.getBody(), requireString_(args.content, 'content'));
  doc.saveAndClose();
  return Object.assign(docInfo_(doc), { appended_blocks: blocks });
}

function docsReplaceText_(args) {
  const doc = DocumentApp.openById(requireString_(args.doc_id, 'doc_id'));
  const find = requireString_(args.find, 'find');
  const pattern = args.use_regex ? find : escapeRegex_(find);
  const body = doc.getBody();
  let count = 0;
  let hit = body.findText(pattern);
  while (hit && count < 10000) { count++; hit = body.findText(pattern, hit); }
  if (count) body.replaceText(pattern, String(args.replace_with));
  doc.saveAndClose();
  return Object.assign(docInfo_(doc), { replaced: count });
}

function docsInsertTable_(args) {
  const doc = DocumentApp.openById(requireString_(args.doc_id, 'doc_id'));
  const rows = args.rows;
  if (!Array.isArray(rows) || !rows.length || !rows.every(Array.isArray)) throw new Error('rows 必須是非空的二維陣列。');
  const cols = Math.max(...rows.map((r) => r.length));
  if (rows.length * cols > DOCS_TABLE_MAX_CELLS) throw new Error(`表格太大（${rows.length}×${cols}），上限 ${DOCS_TABLE_MAX_CELLS} 格。`);
  const cells = rows.map((r) => { const row = r.map((c) => (c === null || c === undefined ? '' : String(c))); while (row.length < cols) row.push(''); return row; });
  const body = doc.getBody();
  if (args.caption) body.appendParagraph(String(args.caption));
  const table = body.appendTable(cells);
  for (let c = 0; c < cols; c++) table.getRow(0).getCell(c).editAsText().setBold(true);
  doc.saveAndClose();
  return Object.assign(docInfo_(doc), { rows: rows.length, cols });
}

function docsOutline_(args) {
  const doc = DocumentApp.openById(requireString_(args.doc_id, 'doc_id'));
  const H = DocumentApp.ParagraphHeading;
  const levels = {};
  [[H.TITLE, 0], [H.SUBTITLE, 0], [H.HEADING1, 1], [H.HEADING2, 2], [H.HEADING3, 3], [H.HEADING4, 4], [H.HEADING5, 5], [H.HEADING6, 6]]
    .forEach(([h, lv]) => { levels[h] = lv; });
  const outline = [];
  doc.getBody().getParagraphs().forEach((p) => {
    const h = p.getHeading();
    if (h === H.NORMAL) return;
    const text = p.getText().trim();
    if (text) outline.push({ level: levels[h] === undefined ? 1 : levels[h], text });
  });
  return Object.assign(docInfo_(doc), { count: outline.length, outline: outline.slice(0, 200) });
}
