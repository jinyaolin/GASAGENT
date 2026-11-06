/**
 * @fileoverview drive toolset：搜尋 / 列表 / 讀文字 / 建資料夾 / 移動 / 改名 / 複製 / 匯出 PDF / 分享（X）/ 列權限 / 取消分享。
 * 全部用內建 DriveApp（不開 advanced service）；PDF 轉文字走 Drive REST v3 的 OCR 匯入（UrlFetch + OAuth token）。
 */

const DRIVE_MAX_RESULTS = 50;
const DRIVE_DEFAULT_RESULTS = 20;
const DRIVE_READ_MAX_CHARS = 50000;
const DRIVE_READ_DEFAULT_CHARS = 20000;
/** Google 格式匯出成 Office / CSV 的對應（Drive REST v3 export；DriveApp.getAs 只會 PDF）。 */
const DRIVE_OFFICE_EXPORT = Object.freeze({
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx', label: 'xlsx' },
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx', label: 'docx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx', label: 'pptx' },
});
/** drive_export 可選格式。 */
const DRIVE_EXPORT_FORMATS = Object.freeze(['pdf', 'xlsx', 'docx', 'pptx', 'csv']);
/** Drive REST export 單檔上限 10 MB。 */
const DRIVE_EXPORT_MAX_BYTES = 10 * 1024 * 1024;
/** PDF / 圖片 OCR 上限（bytes）；UrlFetch payload 上限 50 MB，保守取 10 MB。 */
const DRIVE_PDF_MAX_BYTES = 10 * 1024 * 1024;
/**
 * OCR 語言提示。Drive REST v3 的 ocrLanguage 只收 ISO 639-1 **兩碼**（zh / en / ja…），給 zh-TW 會回
 * HTTP 400「Invalid Value, location: ocrLanguage」（2026-11-02 Telegram 傳 PDF 踩到）。繁簡由 Drive 自己判，不能指定。
 */
const DRIVE_OCR_LANGUAGE = 'zh';

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
      name: 'drive_copy', toolset: 'drive', risk: 'W',
      description: '複製一份檔案（Google 文件 / 試算表 / 簡報或一般檔案都可，含格式與內容；資料夾不支援）。預設放在原檔同一資料夾、檔名「原檔名 的副本」。回傳新檔 id 與網址。',
      parameters: {
        type: 'object',
        properties: {
          file_id: idProp('來源檔案'),
          name: { type: 'string', description: '新檔名（選填）' },
          folder_id: idProp('目標資料夾（選填）'),
        },
        required: ['file_id'], additionalProperties: false,
      },
      handler: driveCopy_,
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
      name: 'drive_export', toolset: 'drive', risk: 'W',
      description: '把 Google 試算表 / 文件 / 簡報匯出成指定格式存到 Drive：xlsx（試算表）、docx（文件）、pptx（簡報）、csv（試算表第一張工作表）或 pdf。要給別人可編輯的檔案時用 xlsx / docx / pptx，不要給 PDF。預設存在原檔同一資料夾，回傳新檔 id 與網址（可接著用 attachment_file_ids 寄出或 telegram_send_file 傳送）。',
      parameters: {
        type: 'object',
        properties: {
          file_id: idProp('來源檔案'),
          format: { type: 'string', enum: DRIVE_EXPORT_FORMATS.slice(), description: 'xlsx / docx / pptx / csv / pdf；格式要跟來源類型相符' },
          folder_id: idProp('目標資料夾（選填）'),
          name: { type: 'string', description: '檔名（選填，預設「原檔名.副檔名」）' },
        },
        required: ['file_id', 'format'], additionalProperties: false,
      },
      handler: driveExport_,
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
    {
      name: 'drive_list_permissions', toolset: 'drive', risk: 'R',
      description: '列出檔案或資料夾目前分享給誰（擁有者、編輯者、檢視者 / 評論者）與連結分享狀態。',
      parameters: {
        type: 'object',
        properties: { file_id: idProp('檔案或資料夾') },
        required: ['file_id'], additionalProperties: false,
      },
      handler: driveListPermissions_,
    },
    {
      name: 'drive_unshare', toolset: 'drive', risk: 'W',
      description: '收回分享：移除某個 email 的存取權（email），或把「知道連結的任何人」改回私人（revoke_link=true）；兩者可同時給。不會影響擁有者。',
      parameters: {
        type: 'object',
        properties: {
          file_id: idProp('檔案或資料夾'),
          email: { type: 'string', description: '要移除存取權的 email（選填）' },
          revoke_link: { type: 'boolean', description: 'true = 關閉連結分享，改為只有被明確加入的人能開（選填）' },
        },
        required: ['file_id'], additionalProperties: false,
      },
      handler: driveUnshare_,
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
 * 嚴格取資料夾：id（或網址）必須真的是資料夾，否則報清楚的錯。各工具的 folder_id / parent_id 都走這裡。
 * @param {*} id
 * @param {string=} field 錯誤訊息用的參數名
 * @return {GoogleAppsScript.Drive.Folder}
 * @throws {Error} 不是資料夾
 */
function requireFolder_(id, field) {
  const got = driveGetItem_(id);
  if (got.kind !== 'folder') throw new Error(`${field || 'folder_id'}「${got.item.getName()}」是檔案（${got.item.getMimeType()}），不是資料夾。`);
  return got.item;
}

/**
 * id 可能是檔案或資料夾，用 mimeType 判斷。
 * 注意：DriveApp.getFolderById 拿到「檔案」的 id **不會丟錯**，會回一個空的假資料夾（2026-11-04 agent 把別人分享的簡報
 * 當成空資料夾就是這樣來的），所以不能用「先當資料夾試」的寫法；getFileById 對資料夾 id 則正常回 File，mimeType 是 folder。
 * @param {string} id
 * @return {{kind: string, item: (GoogleAppsScript.Drive.File|GoogleAppsScript.Drive.Folder)}}
 */
function driveGetItem_(id) {
  id = parseDriveId_(requireString_(id, 'file_id')) || requireString_(id, 'file_id');
  const file = DriveApp.getFileById(id);
  if (file.getMimeType() === MimeType.FOLDER) return { kind: 'folder', item: DriveApp.getFolderById(id) };
  return { kind: 'file', item: file };
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
  let folder;
  if (args.folder_id) {
    const got = driveGetItem_(args.folder_id);
    if (got.kind !== 'folder') throw new Error(`「${got.item.getName()}」是檔案（${got.item.getMimeType()}），不是資料夾；要讀內容請用 drive_read_text，要複製請用 drive_copy。`);
    folder = got.item;
  } else {
    folder = DriveApp.getRootFolder();
  }
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
 * Drive REST v3 multipart 上傳 + 轉 Google 文件（觸發 OCR）的網址。純函式，測試鎖住 ocrLanguage 必須是兩碼。
 * @param {string=} lang 省略用 DRIVE_OCR_LANGUAGE
 * @return {string}
 * @throws {Error} lang 不是 ISO 639-1 兩碼
 */
function driveOcrUploadUrl_(lang) {
  const l = String(lang === undefined ? DRIVE_OCR_LANGUAGE : lang).trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(l)) throw new Error(`ocrLanguage 必須是 ISO 639-1 兩碼（如 zh / en），不是「${lang}」。`);
  return `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ocrLanguage=${l}&fields=id`;
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
  const res = UrlFetchApp.fetch(driveOcrUploadUrl_(), {
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
  const parent = args.parent_id ? requireFolder_(args.parent_id, 'parent_id') : DriveApp.getRootFolder();
  return driveFolderInfo_(parent.createFolder(name));
}

function driveMove_(args) {
  const target = requireFolder_(requireString_(args.folder_id, 'folder_id'));
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
    folder = requireFolder_(args.folder_id);
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

function driveCopy_(args) {
  const got = driveGetItem_(args.file_id);
  if (got.kind === 'folder') throw new Error('資料夾不支援複製，請建新資料夾後逐檔複製。');
  const file = got.item;
  const name = args.name ? String(args.name).trim() : `${file.getName()} 的副本`;
  let folder = null;
  if (args.folder_id) {
    folder = requireFolder_(args.folder_id);
  } else {
    const parents = file.getParents();
    if (parents.hasNext()) folder = parents.next();
  }
  const copy = folder ? file.makeCopy(name, folder) : file.makeCopy(name);
  return { copied_from: { id: file.getId(), name: file.getName() }, copy: driveFileInfo_(copy), folder: folder ? driveFolderInfo_(folder) : null };
}

/**
 * @param {!Array<GoogleAppsScript.Base.User>} users
 * @return {!Array<string>}
 */
function userEmails_(users) {
  return (users || []).map((u) => u.getEmail()).filter(Boolean);
}

function driveListPermissions_(args) {
  const got = driveGetItem_(args.file_id);
  const item = got.item;
  const owner = item.getOwner();
  let access = '';
  let permission = '';
  try { access = String(item.getSharingAccess()); permission = String(item.getSharingPermission()); } catch (err) { access = '(無法讀取)'; }
  const editors = userEmails_(item.getEditors());
  const viewers = userEmails_(item.getViewers());
  return {
    item: got.kind === 'folder' ? driveFolderInfo_(item) : driveFileInfo_(item),
    owner: owner ? owner.getEmail() : '',
    editors,
    viewers_and_commenters: viewers,
    link_sharing: { access, permission, is_private: access === 'PRIVATE' },
    shared_with_count: editors.length + viewers.length,
  };
}

function driveUnshare_(args) {
  const got = driveGetItem_(args.file_id);
  const item = got.item;
  const email = args.email ? String(args.email).trim() : '';
  const revokeLink = !!args.revoke_link;
  if (!email && !revokeLink) throw new Error('請給 email 或 revoke_link=true 至少一個。');
  const removed = [];
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`email 格式不正確：${email}`);
    const owner = item.getOwner();
    if (owner && owner.getEmail().toLowerCase() === email.toLowerCase()) throw new Error('不能移除擁有者的存取權。');
    const before = userEmails_(item.getEditors()).concat(userEmails_(item.getViewers())).map((e) => e.toLowerCase());
    if (before.indexOf(email.toLowerCase()) === -1) throw new Error(`${email} 目前沒有這個項目的存取權。`);
    try { item.removeEditor(email); } catch (err) { /* 不是編輯者 */ }
    try { item.removeViewer(email); } catch (err) { /* 不是檢視者 */ }
    if (got.kind === 'file') { try { item.removeCommenter(email); } catch (err) { /* 不是評論者 */ } }
    removed.push(email);
  }
  let linkChanged = false;
  if (revokeLink) {
    const access = String(item.getSharingAccess());
    if (access !== 'PRIVATE') { item.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); linkChanged = true; }
  }
  return Object.assign({ removed, link_sharing_revoked: linkChanged }, driveListPermissions_({ file_id: item.getId() }));
}

/**
 * 決定一個 Drive 檔案要怎麼匯出。純函式。
 * @param {string} mimeType 來源 mimeType
 * @param {string} name 來源檔名
 * @param {string} format 'auto' | 'pdf' | 'office' | 'xlsx' | 'docx' | 'pptx' | 'csv'
 *   auto：試算表 → xlsx，文件 / 簡報 → pdf，非 Google 格式原檔；office：Google 格式一律對應的 Office 格式
 * @return {{kind: ('raw'|'getAs'|'export'), mime: string, fileName: string, label: string}}
 * @throws {Error} 格式與來源不符
 */
function driveExportPlan_(mimeType, name, format) {
  const f = String(format || 'auto').toLowerCase();
  const isGoogle = String(mimeType || '').indexOf('application/vnd.google-apps.') === 0;
  const base = String(name || 'file').replace(/\.(pdf|xlsx|docx|pptx|csv)$/i, '');
  const office = DRIVE_OFFICE_EXPORT[mimeType];
  if (!isGoogle) {
    if (f === 'auto' || f === 'office' || f === 'raw') return { kind: 'raw', mime: String(mimeType || ''), fileName: String(name || 'file'), label: 'raw' };
    throw new Error(`${name} 不是 Google 文件 / 試算表 / 簡報（${mimeType}），不能轉成 ${f}；直接用原檔即可。`);
  }
  const pdf = () => ({ kind: 'getAs', mime: 'application/pdf', fileName: base + '.pdf', label: 'pdf' });
  if (f === 'pdf') return pdf();
  if (f === 'auto') return mimeType === 'application/vnd.google-apps.spreadsheet' && office ? { kind: 'export', mime: office.mime, fileName: base + office.ext, label: office.label } : pdf();
  if (f === 'office') {
    if (!office) throw new Error(`${name}（${mimeType}）沒有對應的 Office 格式，請用 pdf。`);
    return { kind: 'export', mime: office.mime, fileName: base + office.ext, label: office.label };
  }
  if (f === 'csv') {
    if (mimeType !== 'application/vnd.google-apps.spreadsheet') throw new Error('csv 只能從試算表匯出。');
    return { kind: 'export', mime: 'text/csv', fileName: base + '.csv', label: 'csv' };
  }
  if (f === 'xlsx' || f === 'docx' || f === 'pptx') {
    if (!office || office.label !== f) throw new Error(`${name} 是 ${isGoogle ? mimeType.replace('application/vnd.google-apps.', 'Google ') : mimeType}，不能匯出成 ${f}（試算表 → xlsx、文件 → docx、簡報 → pptx）。`);
    return { kind: 'export', mime: office.mime, fileName: base + office.ext, label: f };
  }
  throw new Error(`不支援的格式：${format}（可用 ${DRIVE_EXPORT_FORMATS.join(' / ')}）。`);
}

/**
 * 依 plan 取得 Blob：raw 原檔、getAs（PDF）、export（Drive REST v3 匯出 Office / CSV，走 OAuth token）。
 * @param {GoogleAppsScript.Drive.File} file
 * @param {{kind: string, mime: string, fileName: string}} plan
 * @param {{fetch: (Function|undefined), token: (string|undefined)}=} deps 測試注入
 * @return {GoogleAppsScript.Base.Blob}
 */
function driveExportBlob_(file, plan, deps) {
  deps = deps || {};
  if (plan.kind === 'raw') return file.getBlob();
  if (plan.kind === 'getAs') return file.getAs(plan.mime).setName(plan.fileName);
  const fetch = deps.fetch || ((u, o) => UrlFetchApp.fetch(u, o));
  const token = deps.token !== undefined ? deps.token : ScriptApp.getOAuthToken();
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.getId())}/export?mimeType=${encodeURIComponent(plan.mime)}`;
  const res = fetch(url, { method: 'get', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code >= 300) {
    let msg = '';
    try { msg = JSON.parse(res.getContentText()).error.message; } catch (err) { msg = String(res.getContentText()).slice(0, 200); }
    throw new Error(`匯出 ${plan.fileName} 失敗（HTTP ${code}）：${msg}${code === 403 && /too large/i.test(msg) ? '；Drive 匯出單檔上限 10 MB，請拆小或改 PDF' : ''}`);
  }
  return res.getBlob().setName(plan.fileName);
}

function driveExport_(args, ctx) {
  const file = DriveApp.getFileById(parseDriveId_(requireString_(args.file_id, 'file_id')));
  const plan = driveExportPlan_(file.getMimeType(), file.getName(), requireString_(args.format, 'format'));
  if (plan.kind === 'raw') throw new Error(`${file.getName()} 不是 Google 格式，不需要匯出。`);
  let folder;
  if (args.folder_id) {
    folder = requireFolder_(args.folder_id);
  } else {
    const parents = file.getParents();
    folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  }
  const blob = driveExportBlob_(file, plan, (ctx && ctx.exportDeps) || undefined);
  if (args.name) blob.setName(String(args.name));
  const out = folder.createFile(blob);
  return Object.assign({ source: { id: file.getId(), name: file.getName() }, format: plan.label }, driveFileInfo_(out));
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
