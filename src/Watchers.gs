/**
 * @fileoverview 事件觸發（M7-B watchers）：Watchers tab 的 store、四種來源的輪詢比對（gmail / drive / sheets / odoo）、
 * 到期掃描（queueTick 每次先跑）、watch job 的執行、watcher_manage 工具的 handler。
 *
 * 一個 watcher = 來源設定（config JSON）+ 任務指令（prompt）+ 投遞方式。每 every_minutes 檢查一次：
 *   gmail   config {query}                 新的討論串（最後一則晚於 cursor.since、id 不在 seen）
 *   drive   config {folder_id}             資料夾內新增 / 修改的檔案（modifiedDate > cursor.since）
 *   sheets  config {spreadsheet_id, sheet_name?}  工作表新增的列（lastRow > cursor.last_row）
 *   odoo    config {model, domain?, fields?}      白名單 model 裡 id > cursor.last_id 的新記錄
 * 每個事件 enqueue 一個 `watch` job（新 session、channel watch、mode autonomous），事件資料包成資料區塊接在 prompt 後面；
 * 一次檢查最多 WATCH_MAX_EVENTS 個事件，其餘下次再撿。建立 / 啟用時先做一次 baseline，只記 cursor 不觸發，既有資料不會洪水。
 * Script Property WATCH_NEXT_CHECK 存最早的 next_check，queueTick 閒置時不開 spreadsheet。
 * 所有來源可注入（deps.sources），測試不碰 Google / Odoo。
 */

const WATCHER_TYPES = Object.freeze(['gmail', 'drive', 'sheets', 'odoo']);
const WATCH_DEFAULT_EVERY_MINUTES = 5;
const WATCH_MIN_EVERY_MINUTES = 1;
const WATCH_MAX_EVERY_MINUTES = 1440;
/** 一次檢查最多觸發幾個事件。 */
const WATCH_MAX_EVENTS = 5;
/** gmail / drive 的 seen 清單上限。 */
const WATCH_SEEN_MAX = 200;
/** 事件資料區塊字元上限。 */
const WATCH_EVENT_CHARS = 6000;
/** sheets 一次最多帶幾列新資料。 */
const WATCH_SHEETS_MAX_ROWS = 50;

/**
 * @typedef {{
 *   id: string, name: string, type: string, config: !Object, prompt: string, deliver_to: string, model_pin: string, skills: string,
 *   every_minutes: number, enabled: boolean, cursor: !Object, next_check: ?Date, last_check: ?Date, last_fired: ?Date, last_status: string,
 *   _row: (number|undefined)
 * }} WatcherRow
 */

// ---- store ---------------------------------------------------------------------------------------

/** @return {string} */
function newWatcherId_() {
  let rand;
  try { rand = Utilities.getUuid().slice(0, 6); } catch (err) { rand = Math.random().toString(36).slice(2, 8); }
  return 'w_' + Date.now().toString(36) + '_' + rand;
}

/**
 * @param {!Object} r
 * @return {WatcherRow}
 */
function parseWatcherRow_(r) {
  return {
    _row: r._row,
    id: String(r.id || ''),
    name: String(r.name || ''),
    type: String(r.type || '').trim().toLowerCase(),
    config: parseJsonObject_(r.config),
    prompt: String(r.prompt || ''),
    deliver_to: String(r.deliver_to || 'none'),
    model_pin: String(r.model_pin || ''),
    skills: String(r.skills || ''),
    every_minutes: clampInt_(r.every_minutes, WATCH_DEFAULT_EVERY_MINUTES, WATCH_MIN_EVERY_MINUTES, WATCH_MAX_EVERY_MINUTES),
    enabled: toBoolean_(r.enabled),
    cursor: parseJsonObject_(r.cursor),
    next_check: toDateOrNull_(r.next_check),
    last_check: toDateOrNull_(r.last_check),
    last_fired: toDateOrNull_(r.last_fired),
    last_status: String(r.last_status || ''),
  };
}

/**
 * @param {WatcherRow} w
 * @return {!Object}
 */
function serializeWatcher_(w) {
  return {
    id: w.id, name: w.name, type: w.type, config: JSON.stringify(w.config || {}), prompt: w.prompt, deliver_to: w.deliver_to,
    model_pin: w.model_pin, skills: w.skills, every_minutes: w.every_minutes, enabled: w.enabled ? 'TRUE' : 'FALSE',
    cursor: JSON.stringify(w.cursor || {}), next_check: w.next_check || '', last_check: w.last_check || '', last_fired: w.last_fired || '',
    last_status: truncateText_(w.last_status, 500).text,
  };
}

/**
 * Sheet 版 Watchers store。
 * @return {{list: Function, get: Function, add: Function, update: Function}}
 */
function sheetWatcherStore_() {
  return {
    list: () => readTable_('Watchers').rows.map(parseWatcherRow_).filter((w) => w.id),
    get: (id) => {
      const row = readTable_('Watchers').rows.find((r) => String(r.id) === id);
      return row ? parseWatcherRow_(row) : null;
    },
    add: (w) => { w._row = appendTableRow_('Watchers', serializeWatcher_(w)); return w; },
    update: (w) => {
      let rowIndex = w._row;
      if (!rowIndex) {
        const row = readTable_('Watchers').rows.find((r) => String(r.id) === w.id);
        if (!row) throw new Error(`找不到 watcher ${w.id}`);
        rowIndex = row._row;
        w._row = rowIndex;
      }
      writeTableRow_('Watchers', rowIndex, serializeWatcher_(w));
    },
  };
}

// ---- 驗證 ----------------------------------------------------------------------------------------

/**
 * 依 type 驗證 config。純函式。
 * @param {string} type
 * @param {*} config object 或 JSON 字串
 * @param {{odooModels: (Array<string>|undefined)}=} opts
 * @return {!Object} 正規化後的 config
 * @throws {Error}
 */
function validateWatcherConfig_(type, config, opts) {
  opts = opts || {};
  let c = config;
  if (typeof c === 'string') {
    if (!c.trim()) c = {};
    else if (!isJsonObjectString_(c)) throw new Error('config 必須是 JSON object。');
    else c = JSON.parse(c);
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) c = {};
  const out = {};
  if (type === 'gmail') {
    out.query = String(c.query || '').trim();
    if (!out.query) throw new Error('gmail watcher 需要 config.query（Gmail 搜尋語法，例 label:發票 has:attachment）。');
    if (/\bafter:|\bnewer_than:/i.test(out.query)) throw new Error('config.query 不要帶 after: / newer_than:，系統會自己接時間條件。');
  } else if (type === 'drive') {
    out.folder_id = parseDriveId_(c.folder_id);
    if (!out.folder_id) throw new Error('drive watcher 需要 config.folder_id（資料夾 id 或網址）。');
  } else if (type === 'sheets') {
    out.spreadsheet_id = parseDriveId_(c.spreadsheet_id);
    if (!out.spreadsheet_id) throw new Error('sheets watcher 需要 config.spreadsheet_id。');
    if (c.sheet_name) out.sheet_name = String(c.sheet_name).trim();
  } else if (type === 'odoo') {
    out.model = String(c.model || '').trim().toLowerCase();
    if (!out.model) throw new Error('odoo watcher 需要 config.model（例 sale.order）。');
    if (opts.odooModels && opts.odooModels.indexOf(out.model) === -1) throw new Error(`model「${out.model}」不在 Odoo 白名單內（管理頁「工具」分頁）。`);
    if (c.domain !== undefined && c.domain !== null && c.domain !== '') out.domain = odooValidateDomain_(odooJsonArg_(c.domain, 'config.domain', 'array', true) || []);
    else out.domain = [];
    const fields = toStringList_(c.fields);
    if (fields.length) out.fields = fields;
  } else {
    throw new Error(`type 必須是 ${WATCHER_TYPES.join(' / ')}。`);
  }
  return out;
}

/**
 * 驗證並正規化 watcher 輸入（管理頁表單與 watcher_manage 共用）。純函式。
 * @param {!Object} input
 * @param {WatcherRow=} existing
 * @param {{providerIds: (Array<string>|undefined), odooModels: (Array<string>|undefined)}=} opts
 * @return {WatcherRow} 不含 _row / id / cursor（新建由呼叫端補）
 */
function validateWatcherInput_(input, existing, opts) {
  input = input || {};
  opts = opts || {};
  const base = existing || { id: '', name: '', type: '', config: {}, prompt: '', deliver_to: 'telegram', model_pin: '', skills: '', every_minutes: WATCH_DEFAULT_EVERY_MINUTES, enabled: true, cursor: {}, next_check: null, last_check: null, last_fired: null, last_status: '' };
  const pick = (k) => (input[k] === undefined || input[k] === null ? base[k] : input[k]);
  const name = String(pick('name') || '').trim();
  if (!name) throw new Error('name 不可為空。');
  if (name.length > 80) throw new Error('name 請在 80 字以內。');
  const type = String(pick('type') || '').trim().toLowerCase();
  if (WATCHER_TYPES.indexOf(type) === -1) throw new Error(`type 必須是 ${WATCHER_TYPES.join(' / ')}。`);
  const config = validateWatcherConfig_(type, input.config === undefined ? base.config : input.config, opts);
  const prompt = String(pick('prompt') || '').trim();
  if (!prompt) throw new Error('prompt 不可為空。');
  const deliverTo = String(pick('deliver_to') || 'telegram').trim().toLowerCase();
  if (CRON_DELIVER_TARGETS.indexOf(deliverTo) === -1) throw new Error(`deliver_to 必須是 ${CRON_DELIVER_TARGETS.join(' / ')}。`);
  const modelPin = String(pick('model_pin') || '').trim();
  if (modelPin && opts.providerIds && opts.providerIds.indexOf(modelPin) === -1) throw new Error(`model_pin「${modelPin}」不是現有的 provider id。`);
  const every = clampInt_(pick('every_minutes'), WATCH_DEFAULT_EVERY_MINUTES, WATCH_MIN_EVERY_MINUTES, WATCH_MAX_EVERY_MINUTES);
  const enabled = input.enabled === undefined || input.enabled === null ? base.enabled : toBoolean_(input.enabled);
  return Object.assign({}, base, { name, type, config, prompt, deliver_to: deliverTo, model_pin: modelPin, skills: String(pick('skills') || '').trim(), every_minutes: every, enabled });
}

// ---- 來源（可注入）----------------------------------------------------------------------------------

/**
 * 預設來源：真的打 Gmail / Drive / Sheets / Odoo。每個都回純資料，讓 watcherCheck_ 保持可測。
 * @return {{gmail: Function, drive: Function, sheets: Function, odoo: Function}}
 */
function defaultWatcherSources_() {
  return {
    /** @param {string} query @param {number} sinceMs @param {number} max @return {!Array<{id, subject, from, date_ms, snippet}>} */
    gmail: (query, sinceMs, max) => {
      const q = `${query} after:${Math.floor(sinceMs / 1000)}`;
      return GmailApp.search(q, 0, max).map((t) => {
        const msgs = t.getMessages();
        const last = msgs[msgs.length - 1];
        return { id: t.getId(), subject: t.getFirstMessageSubject(), from: last ? last.getFrom() : '', date_ms: t.getLastMessageDate().getTime(), snippet: truncateText_(last ? last.getPlainBody() : '', 300).text, messages: msgs.length, has_attachments: msgs.some((m) => m.getAttachments().length > 0) };
      });
    },
    /** @param {string} folderId @param {number} sinceMs @param {number} max @return {!Array<{id, name, mime_type, modified_ms, url}>} */
    drive: (folderId, sinceMs, max) => {
      const iso = new Date(sinceMs).toISOString();
      const it = DriveApp.searchFiles(`'${folderId}' in parents and trashed = false and modifiedDate > '${iso}'`);
      const out = [];
      while (it.hasNext() && out.length < max) {
        const f = it.next();
        out.push({ id: f.getId(), name: f.getName(), mime_type: f.getMimeType(), modified_ms: f.getLastUpdated().getTime(), url: f.getUrl(), size: f.getSize() });
      }
      return out;
    },
    /** @param {string} ssId @param {string} sheetName @param {number} fromRow @param {number} max @return {{last_row: number, header: Array, rows: Array<Array>}} */
    sheets: (ssId, sheetName, fromRow, max) => {
      const ss = SpreadsheetApp.openById(ssId);
      const sheet = resolveSheet_(ss, sheetName);
      const lastRow = sheet.getLastRow();
      const lastCol = Math.max(sheet.getLastColumn(), 1);
      const header = lastRow >= 1 ? sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0] : [];
      let rows = [];
      if (lastRow >= fromRow && fromRow >= 2) rows = sheet.getRange(fromRow, 1, Math.min(lastRow - fromRow + 1, max), lastCol).getDisplayValues();
      return { last_row: lastRow, header, rows, sheet: sheet.getName(), url: ss.getUrl() };
    },
    /** @param {string} model @param {!Array} domain @param {!Array<string>} fields @param {number} max @return {!Array<!Object>} */
    odoo: (model, domain, fields, max) => {
      const kwargs = { limit: max, order: 'id asc' };
      if (fields && fields.length) kwargs.fields = fields;
      return (odooExecute_(getToolConfig_(), model, 'search_read', [domain], kwargs) || []).map(odooNormalizeRecord_);
    },
    /** @param {string} model @param {!Array} domain @return {number} 目前最大 id */
    odooMaxId: (model, domain) => {
      const rows = odooExecute_(getToolConfig_(), model, 'search_read', [domain], { fields: ['id'], limit: 1, order: 'id desc' }) || [];
      return rows.length ? toNumber_(rows[0].id, 0) : 0;
    },
  };
}

// ---- 檢查（純邏輯 + 注入來源）--------------------------------------------------------------------------

/**
 * 檢查一個 watcher：回新事件與新 cursor。baseline=true 只建立 cursor、不回事件。
 * @param {WatcherRow} w
 * @param {{sources: Object, now: (Function|undefined), baseline: (boolean|undefined)}} deps
 * @return {{events: !Array<{key: string, title: string, data: !Object}>, cursor: !Object, scanned: number}}
 */
function watcherCheck_(w, deps) {
  deps = deps || {};
  const sources = deps.sources || defaultWatcherSources_();
  const nowMs = deps.now ? deps.now() : Date.now();
  const cursor = Object.assign({}, w.cursor || {});
  const events = [];
  const c = w.config || {};

  if (w.type === 'gmail' || w.type === 'drive') {
    const since = toNumber_(cursor.since_ms, 0);
    if (deps.baseline || !since) return { events: [], cursor: { since_ms: nowMs, seen: [] }, scanned: 0 };
    const seen = Array.isArray(cursor.seen) ? cursor.seen.map(String) : [];
    const items = w.type === 'gmail' ? sources.gmail(c.query, since, WATCH_MAX_EVENTS * 4) : sources.drive(c.folder_id, since, WATCH_MAX_EVENTS * 4);
    const tsOf = (it) => toNumber_(w.type === 'gmail' ? it.date_ms : it.modified_ms, 0);
    const fresh = items.filter((it) => tsOf(it) > since && seen.indexOf(String(it.id)) === -1).sort((a, b) => tsOf(a) - tsOf(b));
    const take = fresh.slice(0, WATCH_MAX_EVENTS);
    let maxTs = since;
    take.forEach((it) => {
      maxTs = Math.max(maxTs, tsOf(it));
      events.push({
        key: String(it.id),
        title: w.type === 'gmail' ? `新郵件：${it.subject || '（無主旨）'}` : `新檔案：${it.name}`,
        data: Object.assign({ source: w.type }, it, { time: fmtDate_(new Date(tsOf(it))) }),
      });
    });
    // since 只推到「這次處理到」的最晚時間，沒撿完的下次還會出現；seen 擋掉同一時間點的重複。
    const newSeen = seen.concat(take.map((it) => String(it.id))).slice(-WATCH_SEEN_MAX);
    return { events, cursor: { since_ms: take.length ? maxTs : since, seen: newSeen }, scanned: items.length };
  }

  if (w.type === 'sheets') {
    const lastRow = toNumber_(cursor.last_row, 0);
    const snap = sources.sheets(c.spreadsheet_id, c.sheet_name || '', deps.baseline || !lastRow ? Number.MAX_SAFE_INTEGER : lastRow + 1, WATCH_SHEETS_MAX_ROWS);
    if (deps.baseline || !lastRow) return { events: [], cursor: { last_row: Math.max(snap.last_row, 1) }, scanned: 0 };
    if (snap.last_row <= lastRow || !snap.rows.length) return { events: [], cursor: { last_row: Math.max(lastRow, snap.last_row <= lastRow ? snap.last_row : lastRow) }, scanned: 0 };
    const rows = snap.rows.map((vals, i) => { const o = { _row: lastRow + 1 + i }; snap.header.forEach((h, ci) => { o[h || `col${ci + 1}`] = vals[ci]; }); return o; });
    const endRow = lastRow + rows.length;
    events.push({
      key: `rows_${lastRow + 1}_${endRow}`,
      title: `工作表「${snap.sheet}」新增 ${rows.length} 列（第 ${lastRow + 1}–${endRow} 列）`,
      data: { source: 'sheets', spreadsheet_id: c.spreadsheet_id, sheet: snap.sheet, url: snap.url, first_row: lastRow + 1, last_row: endRow, header: snap.header, rows },
    });
    return { events, cursor: { last_row: endRow }, scanned: rows.length };
  }

  if (w.type === 'odoo') {
    const lastId = toNumber_(cursor.last_id, 0);
    const domain = Array.isArray(c.domain) ? c.domain : [];
    if (deps.baseline || !cursor.last_id && cursor.last_id !== 0) {
      return { events: [], cursor: { last_id: sources.odooMaxId(c.model, domain) }, scanned: 0 };
    }
    const fields = (c.fields && c.fields.length) ? c.fields : ['display_name', 'create_date', 'write_date'];
    const records = sources.odoo(c.model, domain.concat([['id', '>', lastId]]), fields, WATCH_MAX_EVENTS);
    let maxId = lastId;
    records.forEach((r) => {
      maxId = Math.max(maxId, toNumber_(r.id, 0));
      events.push({ key: `${c.model}#${r.id}`, title: `Odoo ${c.model} 新記錄：${r.display_name || r.name || r.id}`, data: Object.assign({ source: 'odoo', model: c.model }, r) });
    });
    return { events, cursor: { last_id: maxId }, scanned: records.length };
  }
  throw new Error(`不支援的 watcher type：${w.type}`);
}

/**
 * 事件 → watch job 的 payload（runWatchJob_ 用）。純函式。
 * @param {WatcherRow} w
 * @param {{key: string, title: string, data: !Object}} ev
 * @return {!Object}
 */
function watchJobPayload_(w, ev) {
  return { watcher_id: w.id, name: w.name, type: w.type, prompt: w.prompt, deliver_to: w.deliver_to, model_pin: w.model_pin, skills: w.skills, event: { key: ev.key, title: ev.title, data: ev.data } };
}

/**
 * 給模型的 user 訊息：prompt + 事件資料區塊（與工具結果同一種 untrusted 標記）。純函式。
 * @param {!Object} p watch job payload
 * @return {string}
 */
function watchEventMessage_(p) {
  const ev = p.event || {};
  const json = truncateText_(JSON.stringify(ev.data || {}, null, 1), WATCH_EVENT_CHARS).text;
  return `${p.prompt}\n\n觸發事件：${ev.title || ''}\n<<tool_result name=watcher_event status=ok untrusted>>\n${defangDataBlockMarkers_(json)}\n<<end>>`;
}

// ---- 到期掃描 ------------------------------------------------------------------------------------------

/**
 * 最早的 next_check → Script Property WATCH_NEXT_CHECK（沒有啟用的就清掉）。
 * @param {!Array<WatcherRow>} watchers
 * @return {string} ISO 或空字串
 */
function refreshWatchNextCheckProp_(watchers) {
  let min = null;
  (watchers || []).forEach((w) => {
    if (!w.enabled) return;
    const t = w.next_check ? w.next_check.getTime() : 0; // 沒有 next_check 的視為立刻
    if (min === null || t < min) min = t;
  });
  const iso = min === null ? '' : new Date(min).toISOString();
  setProp_(PROP.WATCH_NEXT_CHECK, iso);
  return iso;
}

/**
 * queueTick 每次先跑：旗標到期才開 sheet；到期的 watcher 各檢查一次、事件入列、推進 next_check。
 * @param {{watcherStore: (Object|undefined), queueStore: (Object|undefined), now: (Function|undefined), sources: (Object|undefined), force: (boolean|undefined), enqueue: (Function|undefined)}} deps
 * @return {?{checked: number, fired: !Array<string>, errors: !Array<string>}} 旗標沒到回 null
 */
function watcherScanIfDue_(deps) {
  deps = deps || {};
  const nowMs = deps.now ? deps.now() : Date.now();
  if (!deps.force) {
    const next = getProp_(PROP.WATCH_NEXT_CHECK);
    if (!next || new Date(next).getTime() > nowMs) return null;
  }
  const store = deps.watcherStore || sheetWatcherStore_();
  const report = { checked: 0, fired: [], errors: [] };
  const watchers = store.list();
  watchers.forEach((w) => {
    if (!w.enabled) return;
    if (!deps.force && w.next_check && w.next_check.getTime() > nowMs) return;
    report.checked++;
    try {
      const r = runWatcherCheck_(w, { store, queueStore: deps.queueStore, now: () => nowMs, sources: deps.sources, enqueue: deps.enqueue });
      report.fired.push(...r.jobs.map((j) => j.id));
    } catch (err) {
      report.errors.push(`${w.id}: ${err && err.message || err}`);
    }
  });
  try { refreshWatchNextCheckProp_(store.list()); } catch (err) { /* 忽略 */ }
  return report;
}

/**
 * 檢查一個 watcher 並處理結果：事件 enqueue、cursor / next_check / last_* 寫回。
 * @param {WatcherRow} w
 * @param {{store: Object, queueStore: (Object|undefined), now: (Function|undefined), sources: (Object|undefined), baseline: (boolean|undefined), enqueue: (Function|undefined)}} deps
 * @return {{events: number, jobs: !Array<!Object>, cursor: !Object}}
 */
function runWatcherCheck_(w, deps) {
  const nowMs = deps.now ? deps.now() : Date.now();
  const nowDate = new Date(nowMs);
  const jobs = [];
  let result;
  try {
    result = watcherCheck_(w, { sources: deps.sources, now: () => nowMs, baseline: !!deps.baseline });
    w.cursor = result.cursor;
    result.events.forEach((ev) => {
      try {
        jobs.push((deps.enqueue || ((type, payload, sid) => enqueue_(type, payload, sid, { store: deps.queueStore })))('watch', watchJobPayload_(w, ev), ''));
      } catch (err) {
        throw new Error(`enqueue 失敗：${err && err.message || err}`);
      }
    });
    if (jobs.length) w.last_fired = nowDate;
    w.last_status = deps.baseline ? `baseline（cursor ${JSON.stringify(summarizeCursor_(w.cursor))}）`
      : jobs.length ? `觸發 ${jobs.length} 件（job ${jobs.map((j) => j.id).join(', ')}）` : `無新事件（掃到 ${result.scanned} 筆）`;
  } catch (err) {
    w.last_status = `檢查失敗：${err && err.message || err}`;
    result = { events: [], cursor: w.cursor, scanned: 0 };
  }
  w.last_check = nowDate;
  w.next_check = new Date(nowMs + w.every_minutes * 60000);
  deps.store.update(w);
  return { events: result.events.length, jobs, cursor: w.cursor };
}

/**
 * @param {!Object} cursor
 * @return {!Object} 給 UI 看的 cursor（seen 只留數量）
 */
function summarizeCursor_(cursor) {
  const c = Object.assign({}, cursor || {});
  if (Array.isArray(c.seen)) c.seen = c.seen.length;
  if (c.since_ms) c.since = fmtDate_(new Date(c.since_ms));
  delete c.since_ms;
  return c;
}

/**
 * 給 UI / 工具看的 watcher。
 * @param {WatcherRow} w
 * @return {!Object}
 */
function publicWatcher_(w) {
  return {
    id: w.id, name: w.name, type: w.type, config: w.config, prompt: w.prompt, deliver_to: w.deliver_to, model_pin: w.model_pin, skills: w.skills,
    every_minutes: w.every_minutes, enabled: w.enabled, cursor: summarizeCursor_(w.cursor),
    next_check: fmtDate_(w.next_check), last_check: fmtDate_(w.last_check), last_fired: fmtDate_(w.last_fired), last_status: w.last_status,
  };
}

// ---- 管理頁 / 工具共用 ------------------------------------------------------------------------------------

/**
 * 新建 watcher：驗證、寫列、立刻 baseline（只記 cursor 不觸發）。
 * @param {!Object} input
 * @param {{store: Object, providerIds: (Array<string>|undefined), odooModels: (Array<string>|undefined), sources: (Object|undefined), now: (Function|undefined)}} deps
 * @return {WatcherRow}
 */
function createWatcher_(input, deps) {
  const w = validateWatcherInput_(input, null, { providerIds: deps.providerIds, odooModels: deps.odooModels });
  w.id = newWatcherId_();
  w.cursor = {};
  deps.store.add(w);
  runWatcherCheck_(w, { store: deps.store, now: deps.now, sources: deps.sources, baseline: true });
  try { refreshWatchNextCheckProp_(deps.store.list()); } catch (err) { /* 忽略 */ }
  return w;
}

/**
 * 更新 watcher；type / config 變了就重做 baseline。
 * @param {string} id
 * @param {!Object} input
 * @param {!Object} deps 同 createWatcher_
 * @return {WatcherRow}
 */
function updateWatcher_(id, input, deps) {
  const existing = deps.store.get(String(id || ''));
  if (!existing) throw new Error(`找不到 watcher ${id}。`);
  const next = validateWatcherInput_(input, existing, { providerIds: deps.providerIds, odooModels: deps.odooModels });
  next.id = existing.id;
  next._row = existing._row;
  const sourceChanged = next.type !== existing.type || JSON.stringify(next.config) !== JSON.stringify(existing.config);
  const reEnabled = next.enabled && !existing.enabled;
  if (sourceChanged || reEnabled) {
    next.cursor = {};
    deps.store.update(next);
    runWatcherCheck_(next, { store: deps.store, now: deps.now, sources: deps.sources, baseline: true });
  } else {
    deps.store.update(next);
  }
  try { refreshWatchNextCheckProp_(deps.store.list()); } catch (err) { /* 忽略 */ }
  return next;
}

/**
 * 立刻檢查一次（不等 next_check）。
 * @param {string} id
 * @param {{store: Object, queueStore: (Object|undefined), sources: (Object|undefined), now: (Function|undefined)}} deps
 * @return {{watcher: !Object, events: number, jobs: !Array<string>}}
 */
function checkWatcherNow_(id, deps) {
  const w = deps.store.get(String(id || ''));
  if (!w) throw new Error(`找不到 watcher ${id}。`);
  const r = runWatcherCheck_(w, { store: deps.store, queueStore: deps.queueStore, now: deps.now, sources: deps.sources });
  try { refreshWatchNextCheckProp_(deps.store.list()); } catch (err) { /* 忽略 */ }
  return { watcher: publicWatcher_(w), events: r.events, jobs: r.jobs.map((j) => j.id) };
}

/**
 * watcher_manage handler（宣告在 Tools_Watcher.gs）。autonomous 模式只允許 list（避免事件任務再建 watcher 形成迴圈）。
 * @param {!Object} args
 * @param {!Object} ctx
 * @return {!Object}
 */
function watcherManage_(args, ctx) {
  ctx = ctx || {};
  const action = String(args.action || '');
  if (action !== 'list' && ctx.mode === 'autonomous') {
    throw new Error('排程 / 事件任務（autonomous 模式）執行中不可建立、修改或觸發 watcher，以免形成迴圈。請把建議寫在回覆裡由 owner 決定。');
  }
  const store = ctx.watcherStore || sheetWatcherStore_();
  const queueStore = ctx.queueStore || sheetQueueStore_();
  const providerIds = ctx.providerIds || listProviders_().map((p) => p.id);
  const odooModels = ctx.odooModels || ((ctx.config && ctx.config.odooAllowedModels) || []);
  const deps = { store, queueStore, providerIds, odooModels, sources: ctx.watcherSources, now: ctx.now };
  const fields = {};
  ['name', 'type', 'config', 'prompt', 'deliver_to', 'model_pin', 'skills', 'every_minutes', 'enabled'].forEach((k) => { if (args[k] !== undefined) fields[k] = args[k]; });
  if (action === 'list') {
    const watchers = store.list().map(publicWatcher_);
    return { count: watchers.length, watchers };
  }
  if (action === 'create') return { ok: true, action, watcher: publicWatcher_(createWatcher_(fields, deps)) };
  const id = requireString_(args.id, 'id');
  if (action === 'update') return { ok: true, action, watcher: publicWatcher_(updateWatcher_(id, fields, deps)) };
  if (action === 'delete') return { ok: true, action: 'delete', note: '已停用（不刪除列）', watcher: publicWatcher_(updateWatcher_(id, { enabled: false }, deps)) };
  if (action === 'check_now') {
    const r = checkWatcherNow_(id, deps);
    return { ok: true, action, events: r.events, job_ids: r.jobs, note: r.jobs.length ? '事件已排入 Queue，每分鐘 trigger 會執行。' : '沒有新事件。', watcher: r.watcher };
  }
  throw new Error('action 必須是 list / create / update / delete / check_now。');
}

// ---- job ----------------------------------------------------------------------------------------------

/**
 * watch job：建新 session（channel watch、external_id = watcher id），事件資料區塊接在 prompt 後，以 autonomous 跑；
 * 結束後依 deliver_to 投遞（借 cron 的投遞路徑），並更新 watcher 的 last_status。
 * @param {QueueJob} job
 * @param {!Object} deps queueTickCore_ 傳下來
 * @return {{state: string, result: !Object}}
 */
function runWatchJob_(job, deps) {
  const p = job.payload || {};
  if (!p.prompt) throw new Error('watch payload 缺 prompt。');
  const sessionStore = (deps.sessionDeps && deps.sessionDeps.store) || sheetSessionStore_();
  const nowDate = new Date(deps.now ? deps.now() : Date.now());
  const session = sessionStore.create({ channel: 'watch', external_id: p.watcher_id || '', title: `${p.name || 'watcher'}：${(p.event && p.event.title) || ''}`.slice(0, 120), model_override: p.model_pin || '', created: nowDate, last_active: nowDate });
  job.session_id = session.id;
  job.payload = Object.assign({}, p, {
    message: watchEventMessage_(p), channel: 'watch', providerId: p.model_pin || '', mode: 'autonomous', systemExtra: AUTONOMOUS_SYSTEM_EXTRA,
    skills: p.skills || '',
    cron: { cron_id: '', name: p.name || '', deliver_to: p.deliver_to || 'none', skills: p.skills || '', watcher_id: p.watcher_id || '' },
  });
  const r = runTurnJob_(job, deps);
  try {
    const store = deps.watcherStore || sheetWatcherStore_();
    const w = store.get(p.watcher_id);
    if (w) {
      w.last_status = `${fmtDate_(nowDate)} job ${job.id} ${r.state}${r.result && r.result.delivery ? '；' + r.result.delivery.summary : ''}`;
      store.update(w);
    }
  } catch (err) { console.warn('更新 watcher last_status 失敗：' + (err && err.message || err)); }
  return r;
}
