/**
 * @fileoverview 排程（M4）：Cron tab 的 store、schedule 解析（5 欄 cron 表達式 + 幾個自然語言捷徑）、
 * next_run 計算（純函式）、到期掃描（queueTick 每次先跑）、cronjob_manage 工具的 handler。
 *
 * - schedule 支援 `分 時 日 月 週`（`*`、數字、`,`、`-`、`*\/n`；週 0/7 = 日，也接受 mon..sun）與捷徑
 *   `hourly` / `daily 09:00` / `weekly mon 09:00`（中文：每小時 / 每天 09:00 / 每週一 09:00）。
 * - 日與週都有限制時沿 cron 慣例取「或」。時間一律用 Script 時區（GAS V8 的 Date 本地時間即 appsscript.json 的 timeZone）。
 * - 到期的排程各 enqueue 一個 `cron` job（新 session、mode='autonomous'），然後把 next_run 推到下一次。
 * - cron job 內禁止再建 / 改 / 觸發排程（cronjob_manage 在 autonomous 模式只允許 list），避免遞迴排程。
 * - Script Property CRON_NEXT_RUN 存最早到期時間，讓 queueTick 閒置時不用開 spreadsheet 就知道沒有排程要跑。
 */

/** deliver_to 可選值（telegram 自 M6）。 */
const CRON_DELIVER_TARGETS = Object.freeze(['doc', 'email', 'telegram', 'none']);
/** computeNextRun_ 往後最多找幾天。 */
const CRON_SEARCH_DAYS = 400;
/** computeNextRun_ 迭代安全上限（有跳躍，實際遠小於此）。 */
const CRON_MAX_ITER = 200000;
/** 捷徑沒給時間時的預設。 */
const CRON_DEFAULT_TIME = '09:00';

/** 週名 → 0..6。 */
const CRON_DOW_NAMES = Object.freeze({
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  '日': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '天': 0,
});

/**
 * @typedef {{
 *   id: string, name: string, schedule: string, next_run: ?Date, prompt: string, skills: string, deliver_to: string,
 *   model_pin: string, enabled: boolean, last_run: ?Date, last_status: string, _row: (number|undefined)
 * }} CronRow
 */

// ---- schedule 解析 ---------------------------------------------------------------------------

/**
 * 捷徑 → 5 欄 cron 表達式；已是 5 欄就原樣（去多餘空白）。純函式。
 * @param {string} schedule
 * @return {string} 5 欄表達式
 * @throws {Error} 無法解析
 */
function normalizeSchedule_(schedule) {
  const s = String(schedule || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/：/g, ':');
  if (!s) throw new Error('schedule 不可為空。');
  let m;
  if (/^(hourly|每小時)$/.test(s)) return '0 * * * *';
  if ((m = /^(daily|每天|每日)(?: ?(\d{1,2}):(\d{2}))?$/.exec(s))) {
    const hm = cronTime_(m[2], m[3]);
    return `${hm.minute} ${hm.hour} * * *`;
  }
  if ((m = /^(weekly|每週|每周|每星期) ?(sun|mon|tue|wed|thu|fri|sat|[日一二三四五六天])(?: ?(\d{1,2}):(\d{2}))?$/.exec(s))) {
    const hm = cronTime_(m[3], m[4]);
    return `${hm.minute} ${hm.hour} * * ${CRON_DOW_NAMES[m[2]]}`;
  }
  const fields = s.split(' ');
  if (fields.length !== 5) {
    throw new Error(`schedule「${schedule}」無法解析：請用 5 欄 cron（分 時 日 月 週，例 0 9 * * 1-5）或捷徑 hourly / daily 09:00 / weekly mon 09:00。`);
  }
  parseCronSchedule_(s); // 驗證每欄
  return s;
}

/**
 * @param {string|undefined} hh
 * @param {string|undefined} mm
 * @return {{hour: number, minute: number}}
 */
function cronTime_(hh, mm) {
  if (hh === undefined) { const d = CRON_DEFAULT_TIME.split(':'); hh = d[0]; mm = d[1]; }
  const hour = Number(hh);
  const minute = Number(mm);
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) throw new Error(`時間 ${hh}:${mm} 不合法（00:00–23:59）。`);
  return { hour, minute };
}

/**
 * 解析一欄：`*`、`n`、`a-b`、`*\/n`、`a-b/n`、逗號組合、週名。純函式。
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @param {string} label 錯誤訊息用
 * @param {Object<string, number>=} names 名稱對照（週）
 * @return {?Object<number, boolean>} null = 任意值
 * @throws {Error}
 */
function parseCronField_(field, min, max, label, names) {
  if (field === '*') return null;
  const out = {};
  const toNum = (tok) => {
    if (names && names[tok] !== undefined) return names[tok];
    if (!/^\d+$/.test(tok)) throw new Error(`${label} 欄「${field}」不合法。`);
    let n = Number(tok);
    if (label === '週' && n === 7) n = 0;
    if (n < min || n > max) throw new Error(`${label} 欄「${field}」超出範圍 ${min}–${max}。`);
    return n;
  };
  field.split(',').forEach((part) => {
    if (!part) throw new Error(`${label} 欄「${field}」不合法。`);
    const stepSplit = part.split('/');
    if (stepSplit.length > 2) throw new Error(`${label} 欄「${field}」不合法。`);
    const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1;
    if (!(step >= 1) || !Number.isInteger(step)) throw new Error(`${label} 欄「${field}」的步進不合法。`);
    let lo;
    let hi;
    const range = stepSplit[0];
    if (range === '*') { lo = min; hi = max; }
    else if (range.indexOf('-') !== -1) {
      const ab = range.split('-');
      if (ab.length !== 2) throw new Error(`${label} 欄「${field}」不合法。`);
      lo = toNum(ab[0]); hi = toNum(ab[1]);
      if (lo > hi) throw new Error(`${label} 欄「${field}」範圍顛倒。`);
    } else {
      lo = toNum(range);
      hi = stepSplit.length === 2 ? max : lo;
    }
    for (let n = lo; n <= hi; n += step) out[n] = true;
  });
  return out;
}

/**
 * schedule → 五個欄位的匹配表。純函式。
 * @param {string} schedule 5 欄表達式或捷徑
 * @return {{expr: string, minute: ?Object, hour: ?Object, dom: ?Object, month: ?Object, dow: ?Object}}
 * @throws {Error}
 */
function parseCronSchedule_(schedule) {
  const s = String(schedule || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const fields = s.split(' ');
  const expr = fields.length === 5 ? s : normalizeSchedule_(s);
  const f = expr.split(' ');
  return {
    expr,
    minute: parseCronField_(f[0], 0, 59, '分'),
    hour: parseCronField_(f[1], 0, 23, '時'),
    dom: parseCronField_(f[2], 1, 31, '日'),
    month: parseCronField_(f[3], 1, 12, '月'),
    dow: parseCronField_(f[4], 0, 7, '週', CRON_DOW_NAMES),
  };
}

/**
 * @param {?Object<number, boolean>} field
 * @param {number} n
 * @return {boolean}
 */
function cronFieldMatches_(field, n) {
  return field === null || !!field[n];
}

/**
 * 從 from 之後（不含 from 所在的那一分鐘）的下一個符合時間。純函式；用本地（Script 時區）時間。
 * 日 / 週都有限制時取「或」（cron 慣例）。
 * @param {string} schedule
 * @param {!Date} from
 * @return {!Date}
 * @throws {Error} 無法解析或 CRON_SEARCH_DAYS 內找不到
 */
function computeNextRun_(schedule, from) {
  const p = parseCronSchedule_(schedule);
  const base = from instanceof Date ? from : new Date(from);
  let t = new Date(base.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = base.getTime() + CRON_SEARCH_DAYS * 86400000;
  for (let i = 0; i < CRON_MAX_ITER; i++) {
    if (t.getTime() > limit) break;
    if (!cronFieldMatches_(p.month, t.getMonth() + 1)) { t = new Date(t.getFullYear(), t.getMonth() + 1, 1, 0, 0, 0, 0); continue; }
    const domOk = cronFieldMatches_(p.dom, t.getDate());
    const dowOk = cronFieldMatches_(p.dow, t.getDay());
    const dayOk = (p.dom !== null && p.dow !== null) ? (domOk || dowOk) : (domOk && dowOk);
    if (!dayOk) { t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 0, 0, 0, 0); continue; }
    if (!cronFieldMatches_(p.hour, t.getHours())) { t = new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours() + 1, 0, 0, 0); continue; }
    if (!cronFieldMatches_(p.minute, t.getMinutes())) { t = new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes() + 1, 0, 0); continue; }
    return t;
  }
  throw new Error(`schedule「${schedule}」在 ${CRON_SEARCH_DAYS} 天內找不到符合的時間。`);
}

// ---- Cron store ---------------------------------------------------------------------------------

/** @return {string} */
function newCronId_() {
  let rand;
  try { rand = Utilities.getUuid().slice(0, 6); } catch (err) { rand = Math.random().toString(36).slice(2, 8); }
  return 'cron_' + Date.now().toString(36) + '_' + rand;
}

/**
 * @param {*} v
 * @return {?Date}
 */
function toDateOrNull_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * @param {!Object} r readTable_ 的列
 * @return {CronRow}
 */
function parseCronRow_(r) {
  return {
    _row: r._row,
    id: String(r.id || ''),
    name: String(r.name || ''),
    schedule: String(r.schedule || ''),
    next_run: toDateOrNull_(r.next_run),
    prompt: String(r.prompt || ''),
    skills: String(r.skills || ''),
    deliver_to: String(r.deliver_to || 'none'),
    model_pin: String(r.model_pin || ''),
    enabled: toBoolean_(r.enabled),
    last_run: toDateOrNull_(r.last_run),
    last_status: String(r.last_status || ''),
  };
}

/**
 * @param {CronRow} c
 * @return {!Object}
 */
function serializeCron_(c) {
  return {
    id: c.id, name: c.name, schedule: c.schedule, next_run: c.next_run || '', prompt: c.prompt, skills: c.skills,
    deliver_to: c.deliver_to, model_pin: c.model_pin, enabled: c.enabled ? 'TRUE' : 'FALSE', last_run: c.last_run || '',
    last_status: truncateText_(c.last_status, 500).text,
  };
}

/**
 * Sheet 版 Cron store。
 * @return {{list: Function, get: Function, add: Function, update: Function}}
 */
function sheetCronStore_() {
  return {
    /** @return {!Array<CronRow>} */
    list: () => readTable_('Cron').rows.map(parseCronRow_).filter((c) => c.id),
    /** @param {string} id @return {?CronRow} */
    get: (id) => {
      const row = readTable_('Cron').rows.find((r) => String(r.id) === id);
      return row ? parseCronRow_(row) : null;
    },
    /** @param {CronRow} c @return {CronRow} */
    add: (c) => { c._row = appendTableRow_('Cron', serializeCron_(c)); return c; },
    /** @param {CronRow} c */
    update: (c) => {
      let rowIndex = c._row;
      if (!rowIndex) {
        const row = readTable_('Cron').rows.find((r) => String(r.id) === c.id);
        if (!row) throw new Error(`找不到排程 ${c.id}`);
        rowIndex = row._row;
        c._row = rowIndex;
      }
      writeTableRow_('Cron', rowIndex, serializeCron_(c));
    },
  };
}

/**
 * 驗證並正規化排程輸入（管理頁表單與 cronjob_manage 共用）。純函式。
 * @param {!Object} input name / schedule / prompt / deliver_to / model_pin / skills / enabled
 * @param {CronRow=} existing 編輯時的既有列（省略的欄位沿用）
 * @param {!Array<string>=} providerIds 可用 provider id（model_pin 驗證；省略不驗）
 * @return {CronRow} 不含 _row / id（新建時由呼叫端補）
 * @throws {Error}
 */
function validateCronInput_(input, existing, providerIds) {
  input = input || {};
  const base = existing || { id: '', name: '', schedule: '', next_run: null, prompt: '', skills: '', deliver_to: 'doc', model_pin: '', enabled: true, last_run: null, last_status: '' };
  const pick = (k) => (input[k] === undefined || input[k] === null ? base[k] : input[k]);
  const name = String(pick('name') || '').trim();
  if (!name) throw new Error('name 不可為空。');
  if (name.length > 80) throw new Error('name 請在 80 字以內。');
  const schedule = String(pick('schedule') || '').trim();
  normalizeSchedule_(schedule);
  const prompt = String(pick('prompt') || '').trim();
  if (!prompt) throw new Error('prompt 不可為空。');
  const deliverTo = String(pick('deliver_to') || 'doc').trim().toLowerCase();
  if (CRON_DELIVER_TARGETS.indexOf(deliverTo) === -1) throw new Error(`deliver_to 必須是 ${CRON_DELIVER_TARGETS.join(' / ')}。`);
  const modelPin = String(pick('model_pin') || '').trim();
  if (modelPin && providerIds && providerIds.indexOf(modelPin) === -1) throw new Error(`model_pin「${modelPin}」不是現有的 provider id（${providerIds.join(', ') || '無'}）。`);
  const enabled = input.enabled === undefined || input.enabled === null ? base.enabled : toBoolean_(input.enabled);
  return Object.assign({}, base, { name, schedule, prompt, deliver_to: deliverTo, model_pin: modelPin, skills: String(pick('skills') || '').trim(), enabled });
}

/**
 * 到期的排程：enabled、有 next_run 且 next_run <= now。純函式。
 * @param {!Array<CronRow>} crons
 * @param {!Date} now
 * @return {!Array<CronRow>}
 */
function dueCrons_(crons, now) {
  return crons.filter((c) => c.enabled && c.next_run && c.next_run.getTime() <= now.getTime());
}

/**
 * 最早到期的 enabled 排程時間。純函式。
 * @param {!Array<CronRow>} crons
 * @return {?Date}
 */
function earliestCronNextRun_(crons) {
  let best = null;
  crons.forEach((c) => {
    if (!c.enabled || !c.next_run) return;
    if (!best || c.next_run.getTime() < best.getTime()) best = c.next_run;
  });
  return best;
}

/**
 * 把最早到期時間寫進 Script Property CRON_NEXT_RUN（沒有就清掉）。queueTick 閒置時只看它。
 * @param {!Array<CronRow>} crons
 * @return {string} 寫入的 ISO 字串（空 = 清掉）
 */
function refreshCronNextRunProp_(crons) {
  const next = earliestCronNextRun_(crons);
  const iso = next ? next.toISOString() : '';
  setProp_(PROP.CRON_NEXT_RUN, iso);
  return iso;
}

/**
 * cron job 的 payload。
 * @param {CronRow} c
 * @return {!Object}
 */
function cronJobPayload_(c) {
  return { cron_id: c.id, name: c.name, prompt: c.prompt, deliver_to: c.deliver_to, model_pin: c.model_pin, skills: c.skills };
}

/**
 * queueTick 每次先跑：到期的排程各 enqueue 一個 cron job、next_run 往後推；enabled 但沒有 next_run 的補算。
 * @param {{cronStore: Object, queueStore: Object, now: (Function|undefined)}} deps
 * @return {!Array<!Object>} 這次 enqueue 的 job
 */
function scanCronDue_(deps) {
  const now = new Date(deps.now ? deps.now() : Date.now());
  const crons = deps.cronStore.list();
  const jobs = [];
  crons.forEach((c) => {
    if (!c.enabled) return;
    if (!c.next_run) {
      try {
        c.next_run = computeNextRun_(c.schedule, now);
      } catch (err) {
        c.last_status = `schedule 無法解析：${err && err.message || err}`;
      }
      deps.cronStore.update(c);
      return;
    }
    if (c.next_run.getTime() > now.getTime()) return;
    let job;
    try {
      job = enqueue_('cron', cronJobPayload_(c), '', { store: deps.queueStore });
      c.last_run = now;
      c.last_status = `queued（job ${job.id}）`;
      jobs.push(job);
    } catch (err) {
      c.last_status = `enqueue 失敗：${err && err.message || err}`;
    }
    try {
      c.next_run = computeNextRun_(c.schedule, now);
    } catch (err) {
      c.next_run = null;
      c.enabled = false;
      c.last_status = `schedule 無法解析，已停用：${err && err.message || err}`;
    }
    deps.cronStore.update(c);
  });
  return jobs;
}

/**
 * 給 UI / 工具看的排程。
 * @param {CronRow} c
 * @return {!Object}
 */
function publicCron_(c) {
  let expr = '';
  let scheduleError = '';
  try { expr = normalizeSchedule_(c.schedule); } catch (err) { scheduleError = String(err && err.message || err); }
  return {
    id: c.id, name: c.name, schedule: c.schedule, cron_expr: expr, schedule_error: scheduleError,
    next_run: fmtDate_(c.next_run), prompt: c.prompt, skills: c.skills, deliver_to: c.deliver_to, model_pin: c.model_pin,
    enabled: c.enabled, last_run: fmtDate_(c.last_run), last_status: c.last_status,
  };
}

// ---- 管理頁 / 工具共用的操作 ---------------------------------------------------------------------

/**
 * 新建排程。
 * @param {!Object} input
 * @param {{cronStore: Object, providerIds: (Array<string>|undefined), now: (Function|undefined)}} deps
 * @return {CronRow}
 */
function createCron_(input, deps) {
  const now = new Date(deps.now ? deps.now() : Date.now());
  const c = validateCronInput_(input, undefined, deps.providerIds);
  c.id = newCronId_();
  c.next_run = c.enabled ? computeNextRun_(c.schedule, now) : null;
  c.last_status = '';
  deps.cronStore.add(c);
  refreshCronNextRunProp_(deps.cronStore.list());
  return c;
}

/**
 * 更新排程（schedule 變了或重新啟用就重算 next_run）。
 * @param {string} id
 * @param {!Object} input
 * @param {{cronStore: Object, providerIds: (Array<string>|undefined), now: (Function|undefined)}} deps
 * @return {CronRow}
 * @throws {Error} 找不到
 */
function updateCron_(id, input, deps) {
  const now = new Date(deps.now ? deps.now() : Date.now());
  const existing = deps.cronStore.get(String(id || ''));
  if (!existing) throw new Error(`找不到排程 ${id}。`);
  const c = validateCronInput_(input, existing, deps.providerIds);
  const scheduleChanged = normalizeSchedule_(c.schedule) !== normalizeSchedule_(existing.schedule);
  if (!c.enabled) c.next_run = existing.next_run;
  else if (scheduleChanged || !existing.enabled || !existing.next_run) c.next_run = computeNextRun_(c.schedule, now);
  deps.cronStore.update(c);
  refreshCronNextRunProp_(deps.cronStore.list());
  return c;
}

/**
 * 立即執行：直接 enqueue 一個 cron job（不動 next_run）。
 * @param {string} id
 * @param {{cronStore: Object, queueStore: Object, now: (Function|undefined)}} deps
 * @return {!Object} job
 * @throws {Error} 找不到
 */
function runCronNow_(id, deps) {
  const c = deps.cronStore.get(String(id || ''));
  if (!c) throw new Error(`找不到排程 ${id}。`);
  const job = enqueue_('cron', cronJobPayload_(c), '', { store: deps.queueStore });
  c.last_run = new Date(deps.now ? deps.now() : Date.now());
  c.last_status = `queued（手動，job ${job.id}）`;
  deps.cronStore.update(c);
  return job;
}

/**
 * cronjob_manage handler（宣告在 Tools_Cron.gs）。autonomous 模式只允許 list。
 * @param {!Object} args
 * @param {!Object} ctx
 * @return {!Object}
 */
function cronjobManage_(args, ctx) {
  ctx = ctx || {};
  const action = String(args.action || '');
  if (action !== 'list' && ctx.mode === 'autonomous') {
    throw new Error('排程任務（autonomous 模式）執行中不可建立 / 修改 / 觸發排程，以免遞迴排程。請把建議寫在回覆裡由 owner 決定。');
  }
  const cronStore = ctx.cronStore || sheetCronStore_();
  const queueStore = ctx.queueStore || sheetQueueStore_();
  const providerIds = ctx.providerIds || listProviders_().map((p) => p.id);
  const deps = { cronStore, queueStore, providerIds, now: ctx.now };
  const fields = {};
  ['name', 'schedule', 'prompt', 'deliver_to', 'model_pin', 'skills', 'enabled'].forEach((k) => { if (args[k] !== undefined) fields[k] = args[k]; });

  if (action === 'list') {
    const crons = cronStore.list().map(publicCron_);
    return { count: crons.length, crons };
  }
  if (action === 'create') {
    const c = createCron_(fields, deps);
    return { ok: true, action, cron: publicCron_(c) };
  }
  const id = requireString_(args.id, 'id');
  if (action === 'update') {
    return { ok: true, action, cron: publicCron_(updateCron_(id, fields, deps)) };
  }
  if (action === 'delete') {
    // 不刪列：停用即可，保留歷史。
    return { ok: true, action: 'delete', note: '已停用（不刪除列）', cron: publicCron_(updateCron_(id, { enabled: false }, deps)) };
  }
  if (action === 'run_now') {
    const job = runCronNow_(id, deps);
    return { ok: true, action, job_id: job.id, note: '已排入 Queue，每分鐘 trigger 會執行；結果依 deliver_to 投遞。' };
  }
  throw new Error('action 必須是 list / create / update / delete / run_now。');
}
