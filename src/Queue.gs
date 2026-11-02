/**
 * @fileoverview Queue runner（M4）：job 狀態機、LockService 防重入、checkpoint 續跑、cron 到期掃描。
 *
 * installAgent() 裝一支每分鐘的 time-driven trigger 指向 queueTick()。trigger 每日總時間只有 90 分鐘，
 * 所以閒置時必須幾乎零成本地 return：只讀兩個 Script Property（QUEUE_DIRTY = 有 queued job；
 * CRON_NEXT_RUN = 最早到期的排程時間），兩者都沒到就不開 spreadsheet。
 *
 * 每次 tick（整體預算 QUEUE_TICK_BUDGET_MS）：
 *   tryLock → 掃 Cron 到期 → 把卡在 running 超過 10 分鐘的 job 重排 / 判失敗 → 取最舊的 queued job → running →
 *   依 type 執行 → done / needs_approval / failed（attempts ≥ 3 不再重試）→ 更新旗標 → 釋放鎖。
 * 一次 tick 最多跑一個 job。
 *
 * Job type：
 *   turn          聊天台「背景執行」：payload {message, providerId, systemExtra, channel, mode}，session_id 可空（會建新）
 *   continuation  續跑：payload {message, origin: checkpoint|approval, continuations, cron?}，接在同一 session
 *   cron          排程：payload {cron_id, name, prompt, deliver_to, model_pin, skills}；建新 session（channel cron）、mode autonomous、skills 全文注入（M5）、結束後投遞
 *   curation      記憶整理：session_id 指定 session
 * 結果寫在 payload.result（text / steps 摘要 / stopped / sessionId / continued_by / delivery），error 欄放失敗原因。
 *
 * Checkpoint：runTurn_ 到時間預算或步數上限會停（messages 已由 runSessionTurn_ 持久化）；這裡再 enqueue 一個
 * continuation job 帶「請接續完成」提示，上限 QUEUE_CONTINUATION_MAX 次。cron 的投遞只在最終（不再續跑）那次做。
 * 全部依賴（store / lock / now / runSessionTurn / deliver）可注入，測試用記憶體 store。
 */

/** time trigger 指向的函式名；Setup / Doctor 用它找 trigger。 */
const QUEUE_TICK_HANDLER = 'queueTick';

const QUEUE_JOB_TYPES = Object.freeze(['turn', 'cron', 'continuation', 'curation']);
const QUEUE_STATES = Object.freeze(['queued', 'running', 'needs_approval', 'done', 'failed']);
/** 同一 job 最多嘗試幾次（例外才算失敗重試；正常結束不會重跑）。 */
const QUEUE_MAX_ATTEMPTS = 3;
/** 一次 tick 的整體預算（GAS 單次執行 6 分鐘）。 */
const QUEUE_TICK_BUDGET_MS = 270000;
/** 給 job 的最低預算；tick 剩不到這麼多就不接新 job。 */
const QUEUE_MIN_JOB_BUDGET_MS = 60000;
/** running 超過這麼久視為被 GAS 中止（6 分鐘上限 + 緩衝）。 */
const QUEUE_STUCK_RUNNING_MS = 600000;
/** checkpoint 續跑上限。 */
const QUEUE_CONTINUATION_MAX = 3;
/** payload.result.text 上限（整個 payload 要塞進 50,000 字元的 cell）。 */
const QUEUE_RESULT_TEXT_MAX = 6000;
/** 續跑時給模型的 user 訊息。 */
const CONTINUATION_PROMPT = '（系統）上一輪因時間預算或步數上限而中止，任務尚未完成。請接續完成剩下的部分：先看前面已完成的工具步驟與結果，不要重做已完成的工作；完成後照常回覆。';
/** 無人模式（cron）附加的 system 指示。 */
const AUTONOMOUS_SYSTEM_EXTRA = '本輪是排程自動執行，沒有使用者在線：不要提問或等待確認，自行判斷並完成任務；最後輸出可直接交付給 owner 的結果（會被寫成文件或寄給 owner）。無法完成時說明原因與已完成的部分。';

/**
 * @typedef {{
 *   id: string, type: string, session_id: string, payload: !Object, state: string, attempts: number,
 *   started: ?Date, finished: ?Date, error: string, _row: (number|undefined)
 * }} QueueJob
 */

// ---- store -------------------------------------------------------------------------------------

/** @return {string} */
function newJobId_() {
  let rand;
  try { rand = Utilities.getUuid().slice(0, 6); } catch (err) { rand = Math.random().toString(36).slice(2, 8); }
  return 'job_' + Date.now().toString(36) + '_' + rand;
}

/**
 * @param {!Object} r readTable_ 的列
 * @return {QueueJob}
 */
function parseJobRow_(r) {
  return {
    _row: r._row,
    id: String(r.id || ''),
    type: String(r.type || ''),
    session_id: String(r.session_id || ''),
    payload: parseJsonObject_(r.payload),
    state: String(r.state || ''),
    attempts: toNumber_(r.attempts, 0),
    started: toDateOrNull_(r.started),
    finished: toDateOrNull_(r.finished),
    error: String(r.error || ''),
  };
}

/**
 * @param {QueueJob} j
 * @return {!Object}
 */
function serializeJob_(j) {
  let payload = JSON.stringify(j.payload || {});
  if (payload.length > MESSAGE_CELL_MAX_CHARS) {
    // 太大就丟掉 result 的 steps 再試，最後硬截（會變成壞 JSON，但只影響顯示）。
    const slim = Object.assign({}, j.payload);
    if (slim.result) slim.result = Object.assign({}, slim.result, { steps: [], text: truncateText_(slim.result.text, 2000).text + '…[截斷]' });
    payload = JSON.stringify(slim);
    if (payload.length > MESSAGE_CELL_MAX_CHARS) payload = payload.slice(0, MESSAGE_CELL_MAX_CHARS);
  }
  return {
    id: j.id, type: j.type, session_id: j.session_id || '', payload, state: j.state, attempts: j.attempts,
    started: j.started || '', finished: j.finished || '', error: truncateText_(j.error, 2000).text,
  };
}

/**
 * Sheet 版 Queue store。list() 依列順序（= 入列順序）。
 * @return {{list: Function, get: Function, add: Function, update: Function}}
 */
function sheetQueueStore_() {
  return {
    /** @return {!Array<QueueJob>} */
    list: () => readTable_('Queue').rows.map(parseJobRow_).filter((j) => j.id),
    /** @param {string} id @return {?QueueJob} */
    get: (id) => {
      const row = readTable_('Queue').rows.find((r) => String(r.id) === id);
      return row ? parseJobRow_(row) : null;
    },
    /** @param {QueueJob} j @return {QueueJob} */
    add: (j) => { j._row = appendTableRow_('Queue', serializeJob_(j)); return j; },
    /** @param {QueueJob} j */
    update: (j) => {
      let rowIndex = j._row;
      if (!rowIndex) {
        const row = readTable_('Queue').rows.find((r) => String(r.id) === j.id);
        if (!row) throw new Error(`找不到 job ${j.id}`);
        rowIndex = row._row;
        j._row = rowIndex;
      }
      writeTableRow_('Queue', rowIndex, serializeJob_(j));
    },
  };
}

/**
 * 入列：寫一列 queued 並設 QUEUE_DIRTY。
 * @param {string} type turn / cron / continuation / curation
 * @param {!Object} payload
 * @param {string=} sessionId
 * @param {{store: (Object|undefined)}=} deps
 * @return {QueueJob}
 * @throws {Error} type 不合法
 */
function enqueue_(type, payload, sessionId, deps) {
  if (QUEUE_JOB_TYPES.indexOf(type) === -1) throw new Error(`未知的 job type：${type}`);
  const store = (deps && deps.store) || sheetQueueStore_();
  const job = { id: newJobId_(), type, session_id: String(sessionId || ''), payload: payload || {}, state: 'queued', attempts: 0, started: null, finished: null, error: '' };
  store.add(job);
  setProp_(PROP.QUEUE_DIRTY, '1');
  return job;
}

/**
 * 把失敗的 job 重新排回 queued（管理頁「重試」）。
 * @param {string} id
 * @param {{store: (Object|undefined)}=} deps
 * @return {QueueJob}
 * @throws {Error} 找不到或不是 failed
 */
function retryJob_(id, deps) {
  const store = (deps && deps.store) || sheetQueueStore_();
  const job = store.get(String(id || ''));
  if (!job) throw new Error(`找不到 job ${id}。`);
  if (job.state !== 'failed') throw new Error(`job ${id} 目前是 ${job.state}，只有 failed 可以重試。`);
  job.state = 'queued';
  job.attempts = 0;
  job.error = '';
  job.started = null;
  job.finished = null;
  store.update(job);
  setProp_(PROP.QUEUE_DIRTY, '1');
  return job;
}

/**
 * 給 UI 看的 job。
 * @param {QueueJob} j
 * @return {!Object}
 */
function publicJob_(j) {
  const p = j.payload || {};
  return {
    id: j.id, type: j.type, state: j.state, session_id: j.session_id, attempts: j.attempts,
    started: fmtDate_(j.started), finished: fmtDate_(j.finished), error: j.error,
    created_at: jobCreatedAt_(j.id),
    summary: jobSummary_(j),
    payload: {
      message: p.message ? truncateText_(String(p.message), 300).text : '',
      origin: p.origin || '', continuations: toNumber_(p.continuations, 0), cron: p.cron || (p.cron_id ? { cron_id: p.cron_id, name: p.name, deliver_to: p.deliver_to } : null),
      mode: p.mode || '', providerId: p.providerId || '', approval_id: p.approval_id || '',
      result: p.result || null,
    },
  };
}

/**
 * 從 id 的 base36 時戳還原建立時間。
 * @param {string} id
 * @return {string}
 */
function jobCreatedAt_(id) {
  const m = /^job_([0-9a-z]+)_/.exec(id);
  if (!m) return '';
  const ms = parseInt(m[1], 36);
  return isFinite(ms) ? fmtDate_(new Date(ms)) : '';
}

/**
 * 一行描述 job 內容。
 * @param {QueueJob} j
 * @return {string}
 */
function jobSummary_(j) {
  const p = j.payload || {};
  if (j.type === 'cron') return `排程「${p.name || p.cron_id || ''}」`;
  if (j.type === 'continuation') return `${p.origin === 'approval' ? '審批後續跑' : '續跑'}${p.continuations ? `（第 ${p.continuations} 次）` : ''}${p.cron ? `：排程「${p.cron.name}」` : ''}`;
  if (j.type === 'curation') return '記憶整理';
  return truncateText_(String(p.message || '').replace(/\s+/g, ' '), 80).text;
}

// ---- tick ----------------------------------------------------------------------------------------

/** @return {{tryLock: function(number): boolean, releaseLock: function()}} */
function scriptLock_() {
  const lock = LockService.getScriptLock();
  return { tryLock: (ms) => lock.tryLock(ms), releaseLock: () => { try { lock.releaseLock(); } catch (err) { /* 忽略 */ } } };
}

/**
 * 每分鐘 trigger 入口。閒置時只讀兩個 Property 就 return。
 * @return {void}
 */
function queueTick() {
  const dirty = getProp_(PROP.QUEUE_DIRTY) === '1';
  const nextCron = getProp_(PROP.CRON_NEXT_RUN);
  const cronDue = !!nextCron && new Date(nextCron).getTime() <= Date.now();
  if (!dirty && !cronDue) return;
  queueTickCore_({});
}

/**
 * tick 的本體。所有依賴可注入。
 * @param {{store: (Object|undefined), cronStore: (Object|undefined), lock: (Object|undefined), now: (Function|undefined),
 *   budgetMs: (number|undefined), runJob: (Function|undefined), sessionDeps: (Object|undefined), deliverDeps: (Object|undefined)}} deps
 * @return {{skipped: string, cronEnqueued: !Array<string>, recovered: !Array<string>, ran: ?Object, remaining: number, cronError: string}}
 */
function queueTickCore_(deps) {
  deps = deps || {};
  const now = deps.now || (() => Date.now());
  const started = now();
  const lock = deps.lock || scriptLock_();
  const report = { skipped: '', cronEnqueued: [], recovered: [], ran: null, remaining: 0, cronError: '' };
  if (!lock.tryLock(5000)) { report.skipped = 'locked'; return report; }
  try {
    const store = deps.store || sheetQueueStore_();
    const cronStore = deps.cronStore || sheetCronStore_();

    // 1. 到期的排程入列
    try {
      report.cronEnqueued = scanCronDue_({ cronStore, queueStore: store, now }).map((j) => j.id);
    } catch (err) {
      report.cronError = String(err && err.message || err);
      console.warn('掃排程失敗：' + report.cronError);
    }

    // 2. 卡住的 running：超過 10 分鐘視為被 GAS 中止
    let jobs = store.list();
    jobs.forEach((j) => {
      if (j.state !== 'running' || !j.started || now() - j.started.getTime() <= QUEUE_STUCK_RUNNING_MS) return;
      if (j.attempts >= QUEUE_MAX_ATTEMPTS) {
        j.state = 'failed';
        j.error = `running 超過 ${QUEUE_STUCK_RUNNING_MS / 60000} 分鐘未完成（執行可能被 GAS 中止），已達嘗試上限。`;
      } else {
        j.state = 'queued';
        j.error = `running 超過 ${QUEUE_STUCK_RUNNING_MS / 60000} 分鐘未完成，重新排入（第 ${j.attempts} 次嘗試）。`;
      }
      j.finished = new Date(now());
      store.update(j);
      report.recovered.push(j.id);
    });

    // 3. 取最舊的 queued job 執行
    const budgetTotal = deps.budgetMs || QUEUE_TICK_BUDGET_MS;
    const job = jobs.find((j) => j.state === 'queued');
    if (job && budgetTotal - (now() - started) >= QUEUE_MIN_JOB_BUDGET_MS) {
      job.state = 'running';
      job.attempts += 1;
      job.started = new Date(now());
      job.finished = null;
      job.error = '';
      store.update(job);
      try {
        const r = (deps.runJob || runQueueJob_)(job, Object.assign({}, deps, { store, cronStore, now, budgetMs: budgetTotal - (now() - started) }));
        job.payload = Object.assign({}, job.payload, { result: r.result });
        job.state = r.state || 'done';
        job.error = r.error || '';
      } catch (err) {
        job.error = String(err && err.stack || err && err.message || err);
        job.state = job.attempts >= QUEUE_MAX_ATTEMPTS ? 'failed' : 'queued';
      }
      job.finished = new Date(now());
      store.update(job);
      report.ran = { id: job.id, type: job.type, state: job.state, error: job.error, attempts: job.attempts };
    }

    // 4. 旗標
    report.remaining = store.list().filter((j) => j.state === 'queued').length;
    setProp_(PROP.QUEUE_DIRTY, report.remaining ? '1' : '');
    try { refreshCronNextRunProp_(cronStore.list()); } catch (err) { /* 忽略 */ }
    return report;
  } finally {
    lock.releaseLock();
  }
}

// ---- job runners ------------------------------------------------------------------------------

/**
 * 依 type 分派。回 {state, result, error?}；throw 視為失敗（會重試到 QUEUE_MAX_ATTEMPTS）。
 * @param {QueueJob} job
 * @param {!Object} deps queueTickCore_ 傳下來（store / cronStore / now / budgetMs / sessionDeps / deliverDeps）
 * @return {{state: string, result: !Object}}
 */
function runQueueJob_(job, deps) {
  switch (job.type) {
    case 'turn':
    case 'continuation':
      return runTurnJob_(job, deps);
    case 'cron':
      return runCronJob_(job, deps);
    case 'curation':
      return runCurationJob_(job, deps);
    default:
      throw new Error(`未知的 job type：${job.type}`);
  }
}

/**
 * runSessionTurn_ 結果 → 存進 payload.result 的摘要。
 * @param {!Object} r
 * @return {!Object}
 */
function summarizeTurnResult_(r) {
  return {
    text: truncateText_(r.text || '', QUEUE_RESULT_TEXT_MAX).text,
    steps: (r.steps || []).slice(0, 60).map((s) => ({
      tool: s.tool, status: s.status, ok: s.ok, ms: s.ms, approvalId: s.approvalId || '',
      argsPreview: truncateText_(s.argsPreview, 160).text, resultPreview: truncateText_(s.resultPreview, 200).text,
    })),
    stopped: r.stopped || '',
    stoppedDetail: r.stoppedDetail || '',
    sessionId: r.sessionId || '',
    sessionCreated: !!r.sessionCreated,
    turns: r.turns || 0,
    provider: r.provider || '',
    model: r.model || '',
    usage: r.usage || { prompt: 0, completion: 0 },
    llmCalls: r.llmCalls || 0,
    ms: r.ms || 0,
    compacted: !!r.compacted,
    skills: r.skills || null,
    skillProposal: r.skillProposal ? { proposed: !!r.skillProposal.proposed, approvalId: r.skillProposal.approvalId || '', text: truncateText_(r.skillProposal.text, 300).text } : null,
  };
}

/**
 * turn / continuation：跑一輪，必要時 enqueue 續跑；cron 類最終才投遞。
 * @param {QueueJob} job
 * @param {!Object} deps
 * @return {{state: string, result: !Object}}
 */
function runTurnJob_(job, deps) {
  const p = job.payload || {};
  if (!p.message) throw new Error('payload.message 不可為空。');
  const runSessionTurn = deps.runSessionTurn || runSessionTurn_;
  const sessionDeps = Object.assign({}, deps.sessionDeps || {});
  sessionDeps.turnDeps = Object.assign({}, sessionDeps.turnDeps || {}, { budgetMs: Math.min(deps.budgetMs || TURN_TIME_BUDGET_MS, TURN_TIME_BUDGET_MS) });
  if (deps.now) sessionDeps.now = deps.now;

  const r = runSessionTurn({
    message: String(p.message),
    sessionId: job.session_id || '',
    channel: p.channel || 'admin',
    providerId: p.providerId || '',
    systemExtra: p.systemExtra || '',
    mode: p.mode || 'interactive',
    skills: p.skills || (p.cron && p.cron.skills) || '',
  }, sessionDeps);
  if (r.sessionId) job.session_id = r.sessionId;

  const result = summarizeTurnResult_(r);
  let state = result.steps.some((s) => s.status === 'pending_approval') ? 'needs_approval' : 'done';
  const continuations = toNumber_(p.continuations, 0);
  if (r.stopped === 'time_budget' || r.stopped === 'max_steps') {
    if (continuations < QUEUE_CONTINUATION_MAX) {
      const next = enqueue_('continuation', {
        message: CONTINUATION_PROMPT, origin: 'checkpoint', continuations: continuations + 1,
        channel: p.channel || 'admin', providerId: p.providerId || '', systemExtra: p.systemExtra || '', mode: p.mode || 'interactive',
        skills: p.skills || (p.cron && p.cron.skills) || '', cron: p.cron || null, root_job_id: p.root_job_id || job.id,
      }, r.sessionId, { store: deps.store });
      result.continued_by = next.id;
    } else {
      result.continuation_exhausted = true;
    }
  }

  // cron：最終才投遞並更新 last_status
  if (p.cron) {
    if (result.continued_by) {
      recordCronStatus_(p.cron, `running（續跑 job ${result.continued_by}）`, deps);
    } else {
      const cronRow = deps.cronStore ? deps.cronStore.get(p.cron.cron_id) : null;
      const cronInfo = Object.assign({ id: p.cron.cron_id, name: p.cron.name, deliver_to: p.cron.deliver_to }, cronRow ? { schedule: cronRow.schedule } : {});
      result.delivery = deliverResult_(cronInfo, result, Object.assign({ now: deps.now }, deps.deliverDeps || {}));
      if (!result.delivery.ok) state = 'failed';
      recordCronStatus_(p.cron, `${state}${result.stopped ? `（${result.stopped}）` : ''}；${result.delivery.summary}`, deps);
    }
  }
  // 投遞失敗：state=failed 並把原因放 error 欄，但結果保留；不自動重試（重跑會再花一次模型費用）。
  return { state, result, error: state === 'failed' && result.delivery ? result.delivery.error : '' };
}

/**
 * 更新 Cron 的 last_status（找不到該排程就略過）。
 * @param {{cron_id: string}} cronRef
 * @param {string} status
 * @param {!Object} deps
 */
function recordCronStatus_(cronRef, status, deps) {
  if (!deps.cronStore || !cronRef || !cronRef.cron_id) return;
  try {
    const c = deps.cronStore.get(cronRef.cron_id);
    if (!c) return;
    c.last_status = `${fmtDate_(new Date(deps.now ? deps.now() : Date.now()))} ${status}`;
    deps.cronStore.update(c);
  } catch (err) {
    console.warn('更新 Cron last_status 失敗：' + (err && err.message || err));
  }
}

/**
 * cron：建新 session（channel cron、external_id = cron id、model_override = model_pin），轉成 autonomous 的 turn job。
 * @param {QueueJob} job
 * @param {!Object} deps
 * @return {{state: string, result: !Object}}
 */
function runCronJob_(job, deps) {
  const p = job.payload || {};
  if (!p.prompt) throw new Error('cron payload 缺 prompt。');
  const sessionStore = (deps.sessionDeps && deps.sessionDeps.store) || sheetSessionStore_();
  const nowDate = new Date(deps.now ? deps.now() : Date.now());
  const session = sessionStore.create({ channel: 'cron', external_id: p.cron_id || '', title: p.name || '排程', model_override: p.model_pin || '', created: nowDate, last_active: nowDate });
  job.session_id = session.id;
  job.payload = Object.assign({}, p, {
    message: p.prompt, channel: 'cron', providerId: p.model_pin || '', mode: 'autonomous', systemExtra: AUTONOMOUS_SYSTEM_EXTRA,
    cron: { cron_id: p.cron_id || '', name: p.name || '', deliver_to: p.deliver_to || 'none', skills: p.skills || '' },
  });
  return runTurnJob_(job, deps);
}

/**
 * curation：對 session 跑一次 curateSession_。
 * @param {QueueJob} job
 * @param {!Object} deps
 * @return {{state: string, result: !Object}}
 */
function runCurationJob_(job, deps) {
  const sessionStore = (deps.sessionDeps && deps.sessionDeps.store) || sheetSessionStore_();
  const s = sessionStore.get(job.session_id);
  if (!s) throw new Error(`找不到 session ${job.session_id}。`);
  const cfg = (deps.sessionDeps && deps.sessionDeps.cfg) || getAgentConfig_();
  const curate = deps.curate || curateSession_;
  const r = curate(s, Object.assign({ store: sessionStore, cfg }, deps.sessionDeps || {}));
  return { state: 'done', result: { text: describeCuration_(r), curation: r, sessionId: s.id, steps: [], stopped: '' } };
}
