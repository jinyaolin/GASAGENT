/**
 * @fileoverview drive toolset：搜尋 / 列表 / 讀文字 / 建資料夾 / 移動 / 改名 / 匯出 PDF / 分享（X）。
 * 全部用內建 DriveApp（不開 advanced service）；PDF 轉文字走 Drive REST v3 的 OCR 匯入（UrlFetch + OAuth token）。
 */

const DRIVE_MAX_RESULTS = 50;
const DRIVE_DEFAULT_RESULTS = 20;
const DRIVE_READ_MAX_CHARS = 50000;
const DRIVE_READ_DEFAULT_CHARS = 20000;
/** PDF / 圖片 OCR 上限（bytes）；UrlFetch payload 上限 50 MB，保守取 10 MB。 */
const DRIVE_PDF_MAX_BYTES = 10 * 1024 * 1024;

/** @return {!Array<ToolDecl>} */
function driveTools_() {
  const idProp = (what) => ({ type: 'string', description: `${what} 的 Drive id` });
  return [
    {
      name: 'drive_search', toolset: 'drive', risk: 'R',
      description: '用 Drive 搜尋語法找檔案與資料夾。例：title contains \'週報\'、fullText contains \'關鍵字\'、mimeType = \'application/vnd.google-apps.document\'、modifiedDate > \'2026-10-01\'，可用 and 串接。回傳 id / 名稱 / 類型 / 修改時間 / 網址。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Drive 搜尋語法（DriveApp.searchFiles 的 params）' },
          max_results: { type: 'integer', description: `最多幾筆，預設 ${DRIVE_DEFAULT_RESULTS}，上限 ${DRIVE_MAX_RESULTS}` },
        },
        required: ['query'], additionalProperties: false,
      },
      handler: driveSearch_,
    },
    {
      name: 'drive_list', toolset: 'drive', risk: 'R',
      description: '列出某資料夾（省略 folder_id 則為「我的雲端硬碟」根目錄）直屬的子資料夾與檔案。',
      parameters: {
        type: 'object',
        properties: {
          folder_id: idProp('資料夾'),
          max_results: { type: 'integer', description: `最多幾筆，預設 ${DRIVE_DEFAULT_RESULTS}，上限 ${DRIVE_MAX_RESULTS}` },
        },
        additionalProperties: false,
      },
      handler: driveList_,
    },
    {
      name: 'drive_read_text', toolset: 'drive', risk: 'R',
      description: '把檔案內容讀成純文字：Google 文件 / 試算表 / 簡報、純文字 / CSV / JSON / Markdown，以及 PDF 與圖片（PNG / JPG / GIF / BMP / WebP，OCR 成文字，較慢）。超過 max_chars 會截斷。',
      parameters: {
        type: 'object',
        properties: {
          file_id: idProp('檔案'),
          max_chars: { type: 'integer', description: `最多回傳字元數，預設 ${DRIVE_READ_DEFAULT_CHARS}，上限 ${DRIVE_READ_MAX_CHARS}` },
        },
        required: ['file_id'], additionalProperties: false,
      },
      handler: driveReadText_,
    },
    {
      name: 'drive_create_folder', toolset: 'drive', risk: 'W',
      description: '建立資料夾（省略 parent_id 則建在根目錄）。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, parent_id: idProp('上層資料夾') },
        required: ['name'], additionalProperties: false,
      },
      handler: driveCreateFolder_,
    },
    {
      name: 'drive_move', toolset: 'drive', risk: 'W',
      description: '把檔案或資料夾移到另一個資料夾。',
      parameters: {
        type: 'object',
        properties: { file_id: idProp('要移動的檔案或資料夾'), folder_id: idProp('目標資料夾') },
        required: ['file_id', 'folder_id'], additionalProperties: false,
      },
      handler: driveMove_,
    },
    {
      name: 'drive_rename', toolset: 'drive', risk: 'W',
      description: '重新命名檔案或資料夾。',
      parameters: {
        type: 'object',
        properties: { file_id: idProp('檔案或資料夾'), name: { type: 'string', description: '新名稱' } },
        required: ['file_id', 'name'], additionalProperties: false,
      },
      handler: driveRename_,
    },
    {
      name: 'drive_export_pdf', toolset: 'drive', risk: 'W',
      description: '把 Google 文件 / 試算表 / 簡報匯出成 PDF 檔存到 Drive（預設存在原檔同一資料夾）。',
      parameters: {
        type: 'object',
        properties: {
          file_id: idProp('來源檔案'),
          folder_id: idProp('目標資料夾（選填）'),
          name: { type: 'string', description: 'PDF 檔名（選填，預設「原檔名.pdf」）' },
        },
        required: ['file_id'], additionalProperties: false,
      },
      handler: driveExportPdf_,
    },
    {
      name: 'drive_share', toolset: 'drive', risk: 'X',
      description: '把檔案或資料夾分享給某個 email（外發動作，依審批策略可能需 owner 批准）。',
      parameters: {
        type: 'object',
        properties: {
          file_id: idProp('檔案或資料夾'),
          email: { type: 'string', description: '對方 email' },
          role: { type: 'string', enum: ['reader', 'commenter', 'writer'], description: '權限，預設 reader' },
        },
        required: ['file_id', 'email'], additionalProperties: false,
      },
      handler: driveShare_,
    },
  ];
}

// ---- helpers ------------------------------------------------------------------------

/**
 * @param {GoogleAppsScript.Drive.File} file
 * @return {!Object}
 */
function driveFileInfo_(file) {
  return {
    id: file.getId(),
    name: file.getName(),
    mime_type: file.getMimeType(),
    modified: fmtDate_(file.getLastUpdated()),
    size: file.getSize(),
    url: file.getUrl(),
  };
}

/**
 * @param {GoogleAppsScript.Drive.Folder} folder
 * @return {!Object}
 */
function driveFolderInfo_(folder) {
  return {
    id: folder.getId(),
    name: folder.getName(),
    mime_type: 'application/vnd.google-apps.folder',
    modified: fmtDate_(folder.getLastUpdated()),
    url: folder.getUrl(),
  };
}

/**
 * id 可能是檔案或資料夾；先當檔案，不行再當資料夾。
 * @param {string} id
 * @return {{kind: string, item: (GoogleAppsScript.Drive.File|GoogleAppsScript.Drive.Folder)}}
 */
function driveGetItem_(id) {
  id = requireString_(id, 'file_id');
  try {
    const folder = DriveApp.getFolderById(id);
    // getFolderById 對檔案 id 會丟錯；走到這裡表示真的是資料夾。
    return { kind: 'folder', item: folder };
  } catch (err) {
    return { kind: 'file', item: DriveApp.getFileById(id) };
  }
}

/**
 * @param {GoogleAppsScript.Drive.FileIterator|GoogleAppsScript.Drive.FolderIterator} it
 * @param {number} max
 * @param {function(*): !Object} mapFn
 * @param {!Array<!Object>} out
 */
function driveCollect_(it, max, mapFn, out) {
  while (out.length < max && it.hasNext()) out.push(mapFn(it.next()));
}

function driveSearch_(args) {
  const query = requireString_(args.query, 'query');
  const max = clampInt_(args.max_results, DRIVE_DEFAULT_RESULTS, 1, DRIVE_MAX_RESULTS);
  const items = [];
  try {
    driveCollect_(DriveApp.searchFiles(query), max, driveFileInfo_, items);
    if (items.length < max) driveCollect_(DriveApp.searchFolders(query), max, driveFolderInfo_, items);
  } catch (err) {
    throw new Error(`Drive 搜尋失敗（請檢查搜尋語法，例如 title contains 'x'）：${err && err.message || err}`);
  }
  return { query, count: items.length, truncated: items.length >= max, items };
}

function driveList_(args) {
  const folder = args.folder_id ? DriveApp.getFolderById(String(args.folder_id)) : DriveApp.getRootFolder();
  const max = clampInt_(args.max_results, DRIVE_DEFAULT_RESULTS, 1, DRIVE_MAX_RESULTS);
  const items = [];
  driveCollect_(folder.getFolders(), max, driveFolderInfo_, items);
  if (items.length < max) driveCollect_(folder.getFiles(), max, driveFileInfo_, items);
  return { folder: driveFolderInfo_(folder), count: items.length, truncated: items.length >= max, items };
}

function driveReadText_(args) {
  const id = requireString_(args.file_id, 'file_id');
  const max = clampInt_(args.max_chars, DRIVE_READ_DEFAULT_CHARS, 200, DRIVE_READ_MAX_CHARS);
  const file = DriveApp.getFileById(id);
  const mime = file.getMimeType();
  let text;
  if (mime === MimeType.GOOGLE_DOCS) {
    text = DocumentApp.openById(id).getBody().getText();
  } else if (mime === MimeType.GOOGLE_SHEETS) {
    text = sheetsToText_(SpreadsheetApp.openById(id), max);
  } else if (mime === MimeType.GOOGLE_SLIDES) {
    text = slidesToText_(SlidesApp.openById(id)).map((s) => `--- 第 ${s.index} 頁 ---\n${s.texts.join('\n')}`).join('\n');
  } else if (mime === MimeType.PDF) {
    text = pdfToText_(file);
  } else if (/^image\/(png|jpe?g|gif|bmp|webp)$/i.test(mime)) {
    text = ocrToText_(file, mime);
  } else if (/^text\/|json|xml|csv|markdown|javascript/i.test(mime)) {
    text = file.getBlob().getDataAsString('UTF-8');
  } else {
    throw new Error(`不支援把 ${mime} 轉成文字（${file.getName()}）。`);
  }
  const t = truncateText_(text, max);
  return { id, name: file.getName(), mime_type: mime, chars: t.total, truncated: t.truncated, text: t.text };
}

/**
 * 試算表 → 每個工作表的 TSV，夠 max 字就停。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {number} max
 * @return {string}
 */
function sheetsToText_(ss, max) {
  const parts = [];
  let total = 0;
  ss.getSheets().some((sheet) => {
    const range = sheet.getDataRange();
    const rows = range.getNumRows() ? range.getDisplayValues() : [];
    const tsv = rows.map((r) => r.join('\t')).join('\n');
    parts.push(`=== ${sheet.getName()}（${rows.length} 列）===\n${tsv}`);
    total += tsv.length;
    return total > max;
  });
  return parts.join('\n\n');
}

/**
 * PDF → 文字（OCR）。
 * @param {GoogleAppsScript.Drive.File} file
 * @return {string}
 */
function pdfToText_(file) {
  return ocrToText_(file, 'application/pdf');
}

/**
 * PDF / 圖片 → 文字：以 Drive REST v3 multipart 上傳並轉成 Google 文件（觸發 OCR），讀完後把暫存文件丟進垃圾桶。
 * @param {GoogleAppsScript.Drive.File} file
 * @param {string} contentType application/pdf 或 image/*
 * @return {string}
 */
function ocrToText_(file, contentType) {
  if (file.getSize() > DRIVE_PDF_MAX_BYTES) throw new Error(`檔案太大（${file.getSize()} bytes），OCR 上限 ${DRIVE_PDF_MAX_BYTES} bytes。`);
  const boundary = 'gasagent' + Date.now();
  const meta = JSON.stringify({ name: `[OCR 暫存] ${file.getName()}`, mimeType: MimeType.GOOGLE_DOCS });
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const payload = Utilities.newBlob(head).getBytes().concat(file.getBlob().getBytes(), Utilities.newBlob(tail).getBytes());
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ocrLanguage=zh-TW&fields=id', {
    method: 'post',
    contentType: `multipart/related; boundary=${boundary}`,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload,
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error(`OCR 失敗（HTTP ${res.getResponseCode()}）：${res.getContentText().slice(0, 300)}`);
  const tempId = JSON.parse(res.getContentText()).id;
  try {
    return DocumentApp.openById(tempId).getBody().getText();
  } finally {
    try { DriveApp.getFileById(tempId).setTrashed(true); } catch (err) { console.warn('清除 OCR 暫存文件失敗：' + err); }
  }
}

function driveCreateFolder_(args) {
  const name = requireString_(args.name, 'name');
  const parent = args.parent_id ? DriveApp.getFolderById(String(args.parent_id)) : DriveApp.getRootFolder();
  return driveFolderInfo_(parent.createFolder(name));
}

function driveMove_(args) {
  const target = DriveApp.getFolderById(requireString_(args.folder_id, 'folder_id'));
  const got = driveGetItem_(args.file_id);
  got.item.moveTo(target);
  return { moved: got.kind === 'folder' ? driveFolderInfo_(got.item) : driveFileInfo_(got.item), to: driveFolderInfo_(target) };
}

function driveRename_(args) {
  const name = requireString_(args.name, 'name');
  const got = driveGetItem_(args.file_id);
  got.item.setName(name);
  return got.kind === 'folder' ? driveFolderInfo_(got.item) : driveFileInfo_(got.item);
}

function driveExportPdf_(args) {
  const file = DriveApp.getFileById(requireString_(args.file_id, 'file_id'));
  let folder;
  if (args.folder_id) {
    folder = DriveApp.getFolderById(String(args.folder_id));
  } else {
    const parents = file.getParents();
    folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  }
  const name = args.name ? String(args.name) : file.getName().replace(/\.pdf$/i, '') + '.pdf';
  let blob;
  try {
    blob = file.getAs(MimeType.PDF).setName(name);
  } catch (err) {
    throw new Error(`無法把 ${file.getMimeType()} 轉成 PDF：${err && err.message || err}`);
  }
  return driveFileInfo_(folder.createFile(blob));
}

function driveShare_(args) {
  const email = requireString_(args.email, 'email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`email 格式不正確：${email}`);
  const role = args.role || 'reader';
  const got = driveGetItem_(args.file_id);
  if (role === 'writer') got.item.addEditor(email);
  else if (role === 'commenter') {
    if (got.kind === 'folder') throw new Error('資料夾不支援 commenter，請用 reader 或 writer。');
    got.item.addCommenter(email);
  } else got.item.addViewer(email);
  return { shared: true, role, email, item: got.kind === 'folder' ? driveFolderInfo_(got.item) : driveFileInfo_(got.item) };
}
