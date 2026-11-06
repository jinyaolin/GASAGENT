/**
 * @fileoverview 使用分析報告：從 Queue（每輪結果）、Usage（每次模型呼叫）、AuditLog（每次工具執行）、Sessions 統計
 * 近 N 天的表現，判斷 max_tool_steps / 時間預算夠不夠、模型是否常失敗或打轉、哪些工具常出錯，並給出調整建議。
 * 純函式 usageReport_(input) 可注入資料測試；adminUsageReport / Telegram /stats 用 collectUsageReport_ 讀真表。
 */

/** 預設統計天數。 */
const REPORT_DEFAULT_DAYS = 7;
/** 建議門檻：步數 / 時間用到預算的多少算「接近上限」。 */
const REPORT_NEAR_LIMIT_RATIO = 0.8;
/** 慢工具門檻（ms）。 */
const REPORT_SLOW_TOOL_MS = 20000;
/** 單次模型呼叫平均 prompt tokens 超過此值視為 context 偏大。 */
const REPORT_HEAVY_PROMPT_TOKENS = 50000;

/**
 * 百分位（最近鄰）。
 * @param {!Array<number>} nums
 * @param {number} p 0–100
 * @return {number}
 */
function percentile_(nums, p) {
  if (!nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

/** @param {!Array<number>} nums @return {number} */
function average_(nums) {
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
}

/**
 * 表格 cell 的時間 → ms；吃 Date / ISO 字串 / 空。
 * @param {*} v
 * @return {number} NaN = 沒有
 */
function cellTimeMs_(v) {
  if (v instanceof Date) return v.getTime();
  if (!v) return NaN;
  const t = new Date(String(v)).getTime();
  return isNaN(t) ? NaN : t;
}

/**
 * 工具失敗訊息分類：模型端（參數不對 / 找錯 id）或執行端（API / 權限 / 配額）。純函式。
 * @param {string} preview result_preview
 * @return {string} 'params' | 'not_found' | 'permission' | 'quota' | 'other'
 */
function classifyToolFailure_(preview) {
  const p = String(preview || '');
  if (/缺少|必須|不是合法|不合法|請給|invalid|required|parameter|參數|格式/i.test(p)) return 'params';
  if (/找不到|not found|不存在|404/i.test(p)) return 'not_found';
  if (/權限|permission|forbidden|403|未開放|拒絕/i.test(p)) return 'permission';
  if (/quota|配額|429|too many|rate/i.test(p)) return 'quota';
  return 'other';
}

/**
 * 產生報告。純函式。
 * @param {{
 *   days: (number|undefined), now: (number|undefined),
 *   queueRows: !Array<!Object>, usageRows: !Array<!Object>, auditRows: !Array<!Object>, sessionRows: !Array<!Object>,
 *   maxSteps: (number|undefined), budgetMs: (number|undefined)}} input
 * @return {!Object} 結構化報告（含 suggestions 與 text）
 */
function usageReport_(input) {
  const days = Math.max(1, Math.min(90, Number(input.days) || REPORT_DEFAULT_DAYS));
  const nowMs = input.now || Date.now();
  const since = nowMs - days * 86400000;
  const maxSteps = Number(input.maxSteps) || DEFAULT_MAX_TOOL_STEPS;
  const budgetMs = Number(input.budgetMs) || TURN_TIME_BUDGET_MS;
  const inWindow = (t) => !isNaN(t) && t >= since && t <= nowMs + 60000;

  // ---- Queue：每輪結果 -----------------------------------------------------------
  const jobs = (input.queueRows || []).map((r) => {
    let payload = r.payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (err) { payload = {}; } }
    return { id: String(r.id || ''), type: String(r.type || ''), state: String(r.state || ''), attempts: Number(r.attempts) || 0, started: cellTimeMs_(r.started), finished: cellTimeMs_(r.finished), error: String(r.error || ''), payload: payload || {} };
  }).filter((j) => inWindow(j.finished) || inWindow(j.started));
  const byType = {};
  const byState = {};
  jobs.forEach((j) => { byType[j.type] = (byType[j.type] || 0) + 1; byState[j.state] = (byState[j.state] || 0) + 1; });
  const turns = jobs.filter((j) => j.payload.result && typeof j.payload.result === 'object').map((j) => Object.assign({ jobType: j.type, jobId: j.id, channel: String(j.payload.channel || j.payload.deliver_to || '') }, j.payload.result));
  const stops = { max_steps: 0, time_budget: 0, circuit_breaker: 0, needs_input: 0 };
  turns.forEach((t) => { if (t.stopped && stops[t.stopped] !== undefined) stops[t.stopped]++; });
  const stepCounts = turns.map((t) => (t.steps || []).length);
  const turnMs = turns.map((t) => Number(t.ms) || 0).filter((x) => x > 0);
  const llmCalls = turns.map((t) => Number(t.llmCalls) || 0);
  const nearSteps = stepCounts.filter((n) => n >= maxSteps * REPORT_NEAR_LIMIT_RATIO).length;
  const nearBudget = turnMs.filter((ms) => ms >= budgetMs * REPORT_NEAR_LIMIT_RATIO).length;
  const promptPerCall = [];
  turns.forEach((t) => { const calls = Number(t.llmCalls) || 0; const p = t.usage && Number(t.usage.prompt) || 0; if (calls > 0 && p > 0) promptPerCall.push(Math.round(p / calls)); });
  const failedErrors = {};
  jobs.filter((j) => j.state === 'failed' && j.error).forEach((j) => { const k = j.error.slice(0, 90); failedErrors[k] = (failedErrors[k] || 0) + 1; });
  const circuitTools = {};
  turns.filter((t) => t.stopped === 'circuit_breaker').forEach((t) => { const last = (t.steps || []).slice(-1)[0]; if (last) circuitTools[last.tool] = (circuitTools[last.tool] || 0) + 1; });

  // ---- Usage：每次模型呼叫 -------------------------------------------------------
  const models = {};
  (input.usageRows || []).forEach((r) => {
    if (!inWindow(cellTimeMs_(r.ts))) return;
    const key = `${r.provider || '?'} / ${r.model || '?'}`;
    const m = models[key] || (models[key] = { provider: String(r.provider || ''), model: String(r.model || ''), calls: 0, fails: 0, prompt: [], completion: [], ms: [], cost: 0 });
    m.calls++;
    const ok = r.ok === undefined || r.ok === '' ? true : toBoolean_(r.ok);
    if (!ok) m.fails++;
    m.prompt.push(Number(r.prompt_tokens) || 0); m.completion.push(Number(r.completion_tokens) || 0);
    if (Number(r.ms) > 0) m.ms.push(Number(r.ms));
    m.cost += Number(r.cost_est) || 0;
  });
  const modelStats = Object.keys(models).map((k) => { const m = models[k]; return { key: k, provider: m.provider, model: m.model, calls: m.calls, fails: m.fails, failRate: m.calls ? m.fails / m.calls : 0, avgPrompt: average_(m.prompt), avgCompletion: average_(m.completion), avgMs: average_(m.ms), p90Ms: percentile_(m.ms, 90), cost: Math.round(m.cost * 10000) / 10000 }; }).sort((a, b) => b.calls - a.calls);

  // ---- AuditLog：每次工具執行 ----------------------------------------------------
  const tools = {};
  const repeats = {};
  (input.auditRows || []).forEach((r) => {
    if (!inWindow(cellTimeMs_(r.ts))) return;
    const name = String(r.tool || '');
    if (!name || /^(security|telegram):/.test(name)) return;
    const t = tools[name] || (tools[name] = { tool: name, calls: 0, fails: 0, pending: 0, ms: [], failKinds: {}, samples: [] });
    t.calls++;
    const preview = String(r.result_preview || '');
    if (Number(r.ms) > 0) t.ms.push(Number(r.ms));
    if (/pending_approval|待審批/.test(preview)) t.pending++;
    else if (!toBoolean_(r.ok)) {
      t.fails++;
      const kind = classifyToolFailure_(preview);
      t.failKinds[kind] = (t.failKinds[kind] || 0) + 1;
      if (t.samples.length < 2) t.samples.push(preview.replace(/\s+/g, ' ').slice(0, 120));
    }
    const rk = `${r.session_id || ''}|${name}|${String(r.args_preview || '').slice(0, 200)}`;
    repeats[rk] = (repeats[rk] || 0) + 1;
  });
  const toolStats = Object.keys(tools).map((k) => { const t = tools[k]; return { tool: t.tool, calls: t.calls, fails: t.fails, pending: t.pending, failRate: t.calls ? t.fails / t.calls : 0, avgMs: average_(t.ms), maxMs: t.ms.length ? Math.max.apply(null, t.ms) : 0, failKinds: t.failKinds, samples: t.samples }; }).sort((a, b) => b.calls - a.calls);
  const repeatedCalls = Object.keys(repeats).filter((k) => repeats[k] >= 3).map((k) => ({ tool: k.split('|')[1], times: repeats[k] })).sort((a, b) => b.times - a.times).slice(0, 5);
  const slowTools = toolStats.filter((t) => t.avgMs >= REPORT_SLOW_TOOL_MS).map((t) => `${t.tool}（平均 ${Math.round(t.avgMs / 1000)}s）`);
  const paramErrorTools = toolStats.filter((t) => t.calls >= 3 && (t.failKinds.params || 0) / t.calls >= 0.15).map((t) => `${t.tool}（${t.failKinds.params}/${t.calls}）`);

  // ---- Sessions -----------------------------------------------------------------
  const sessions = (input.sessionRows || []).filter((s) => inWindow(cellTimeMs_(s.last_active)) || inWindow(cellTimeMs_(s.created)));
  const sessionsByChannel = {};
  sessions.forEach((s) => { const c = String(s.channel || '?'); sessionsByChannel[c] = (sessionsByChannel[c] || 0) + 1; });
  const sessionTurns = sessions.map((s) => Number(s.turns) || 0);
  const bigSessions = sessions.filter((s) => (Number(s.token_est) || 0) >= 80000).length;

  // ---- 建議 ---------------------------------------------------------------------
  const suggestions = [];
  const totalTurns = turns.length;
  const pct = (n) => totalTurns ? Math.round((n / totalTurns) * 100) : 0;
  if (stops.max_steps) {
    const p90 = percentile_(stepCounts, 90);
    const hasRepeats = repeatedCalls.length > 0;
    suggestions.push(`有 ${stops.max_steps} 輪（${pct(stops.max_steps)}%）撞到步數上限 ${maxSteps}（系統會自動續跑最多 3 次，但每次續跑都要重讀 context）。` +
      (hasRepeats ? `同時看到同一工具同參數重複呼叫 ≥ 3 次（${repeatedCalls.map((r) => r.tool + '×' + r.times).join('、')}），比較像模型打轉而不是上限太低：換更強的 main 模型、或讓那些工具的錯誤訊息更明確，比調高 max_tool_steps 有效。`
        : `步數 p90 = ${p90}；若多為正常的長任務，建議 max_tool_steps 調到 ${Math.min(200, Math.max(maxSteps + 5, Math.ceil(p90 * 1.5)))}，或在指令裡把大任務拆成幾則訊息。`));
  } else if (nearSteps) {
    suggestions.push(`${nearSteps} 輪步數達上限的 80% 以上（上限 ${maxSteps}）但沒撞到；暫不需調整，長任務變多時再看。`);
  }
  if (stops.time_budget || nearBudget) {
    const slowModels = modelStats.filter((m) => m.avgMs >= 30000).map((m) => `${m.model}（平均 ${Math.round(m.avgMs / 1000)}s / 次）`);
    suggestions.push(`有 ${stops.time_budget} 輪撞到時間預算 ${Math.round(budgetMs / 1000)} 秒、${nearBudget} 輪用掉 80% 以上。GAS 單次執行上限 6 分鐘，預算不能再往上調，只能縮短每步：` +
      (slowTools.length ? `慢工具 ${slowTools.join('、')} —— 調低 max_chars / max_results 或改讀原始試算表而非 OCR；` : '') +
      (slowModels.length ? `模型本身慢 ${slowModels.join('、')} —— main 換較快的模型（或 reasoning_effort 調低）；` : '') +
      '也可以把任務拆成幾則訊息。');
  }
  if (stops.circuit_breaker) {
    suggestions.push(`有 ${stops.circuit_breaker} 輪熔斷（同一工具同參數連錯 3 次）：${Object.keys(circuitTools).map((t) => t + '×' + circuitTools[t]).join('、') || '—'}。通常是工具回的錯誤訊息沒讓模型知道該怎麼改；看下方該工具的失敗樣本，若是程式問題請修工具，若是模型一直給錯參數就換更強的模型。`);
  }
  modelStats.filter((m) => m.calls >= 5 && m.failRate >= 0.05).forEach((m) => {
    suggestions.push(`${m.key} 失敗率 ${Math.round(m.failRate * 100)}%（${m.fails}/${m.calls}）：provider 不穩或額度 / 速率限制；確認備援鏈有第二個 main，或換 provider。`);
  });
  if (promptPerCall.length && average_(promptPerCall) >= REPORT_HEAVY_PROMPT_TOKENS) {
    suggestions.push(`每次模型呼叫平均 ${average_(promptPerCall)} prompt tokens，context 偏大（慢、貴、容易忘）：調低 spill_threshold 讓工具結果早點溢寫、常用 /new 開新 session、或調低讀取類工具的 max_chars。`);
  }
  if (paramErrorTools.length) {
    suggestions.push(`工具參數錯誤比例高：${paramErrorTools.join('、')}。這是「模型不夠聰明 / 沒看懂工具說明」的訊號：main 換更強的模型，或把這些工具的 description 寫得更白（必填欄位、id 從哪來）。`);
  }
  if (!stops.max_steps && repeatedCalls.length) {
    suggestions.push(`同一工具同參數重複呼叫 ≥ 3 次：${repeatedCalls.map((r) => r.tool + '×' + r.times).join('、')}，模型在打轉；通常是工具回錯但訊息不明確，或模型太弱。`);
  }
  if (bigSessions) suggestions.push(`${bigSessions} 個 session 累積 ≥ 80k tokens；長對話建議 /new 重開，壓縮摘要仍會保留重點。`);
  if (!suggestions.length) suggestions.push(totalTurns ? `近 ${days} 天沒有撞到步數 / 時間上限、模型與工具失敗率都在正常範圍，目前參數夠用。` : `近 ${days} 天沒有完成的輪次紀錄，無法判斷；請在有使用紀錄後再看。`);

  const report = {
    days, since: new Date(since).toISOString(), maxSteps, budgetMs,
    jobs: { total: jobs.length, byType, byState, failedErrors: Object.keys(failedErrors).map((k) => ({ error: k, count: failedErrors[k] })).sort((a, b) => b.count - a.count).slice(0, 5) },
    turns: { total: totalTurns, stops, steps: { avg: average_(stepCounts), p90: percentile_(stepCounts, 90), max: stepCounts.length ? Math.max.apply(null, stepCounts) : 0, nearLimit: nearSteps }, ms: { avg: average_(turnMs), p90: percentile_(turnMs, 90), max: turnMs.length ? Math.max.apply(null, turnMs) : 0, nearLimit: nearBudget }, llmCalls: { avg: average_(llmCalls), max: llmCalls.length ? Math.max.apply(null, llmCalls) : 0 }, avgPromptPerCall: average_(promptPerCall), continuations: byType.continuation || 0 },
    models: modelStats, tools: toolStats, repeatedCalls, slowTools, paramErrorTools,
    sessions: { total: sessions.length, byChannel: sessionsByChannel, avgTurns: average_(sessionTurns), maxTurns: sessionTurns.length ? Math.max.apply(null, sessionTurns) : 0, bigSessions },
    suggestions,
  };
  report.text = usageReportText_(report);
  return report;
}

/**
 * 報告 → 純文字（Telegram / 管理頁共用）。
 * @param {!Object} r usageReport_ 結果
 * @return {string}
 */
function usageReportText_(r) {
  const sec = (ms) => `${Math.round(ms / 1000)}s`;
  const lines = [`📊 使用分析（近 ${r.days} 天）`, ''];
  const t = r.turns;
  lines.push(`輪次 ${t.total}（job ${r.jobs.total}：${Object.keys(r.jobs.byType).map((k) => k + ' ' + r.jobs.byType[k]).join('、') || '—'}；狀態 ${Object.keys(r.jobs.byState).map((k) => k + ' ' + r.jobs.byState[k]).join('、') || '—'}）`);
  lines.push(`步數：平均 ${t.steps.avg}、p90 ${t.steps.p90}、最多 ${t.steps.max}（上限 ${r.maxSteps}；撞到 ${t.stops.max_steps} 輪、≥80% ${t.steps.nearLimit} 輪；自動續跑 ${t.continuations} 次）`);
  lines.push(`時間：平均 ${sec(t.ms.avg)}、p90 ${sec(t.ms.p90)}、最長 ${sec(t.ms.max)}（預算 ${sec(r.budgetMs)}；撞到 ${t.stops.time_budget} 輪、≥80% ${t.ms.nearLimit} 輪）`);
  lines.push(`熔斷 ${t.stops.circuit_breaker} 輪、提問等待 ${t.stops.needs_input} 輪；每輪模型呼叫平均 ${t.llmCalls.avg} 次（最多 ${t.llmCalls.max}），每次平均 ${t.avgPromptPerCall} prompt tokens`);
  if (r.jobs.failedErrors.length) lines.push(`失敗 job：${r.jobs.failedErrors.map((e) => `${e.error}（${e.count}）`).join('；')}`);
  lines.push('', '模型：');
  if (!r.models.length) lines.push('（無呼叫紀錄）');
  r.models.forEach((m) => lines.push(`• ${m.key}：${m.calls} 次，失敗 ${m.fails}（${Math.round(m.failRate * 100)}%），平均 ${m.avgPrompt}→${m.avgCompletion} tokens，${sec(m.avgMs)}/次（p90 ${sec(m.p90Ms)}）${m.cost ? '，約 $' + m.cost : ''}`));
  lines.push('', '工具（依呼叫次數）：');
  if (!r.tools.length) lines.push('（無工具紀錄）');
  r.tools.slice(0, 15).forEach((x) => {
    const kinds = Object.keys(x.failKinds).map((k) => ({ params: '參數', not_found: '找不到', permission: '權限', quota: '配額', other: '其他' })[k] + ' ' + x.failKinds[k]).join('、');
    lines.push(`• ${x.tool}：${x.calls} 次，失敗 ${x.fails}${kinds ? '（' + kinds + '）' : ''}${x.pending ? '，待審 ' + x.pending : ''}，平均 ${sec(x.avgMs)}${x.maxMs >= REPORT_SLOW_TOOL_MS ? '，最慢 ' + sec(x.maxMs) : ''}`);
    x.samples.forEach((s) => lines.push(`    ↳ ${s}`));
  });
  if (r.repeatedCalls.length) lines.push('', `重複呼叫（同 session 同工具同參數 ≥ 3 次）：${r.repeatedCalls.map((x) => x.tool + '×' + x.times).join('、')}`);
  lines.push('', `Session ${r.sessions.total} 個（${Object.keys(r.sessions.byChannel).map((k) => k + ' ' + r.sessions.byChannel[k]).join('、') || '—'}），平均 ${r.sessions.avgTurns} 輪、最多 ${r.sessions.maxTurns} 輪，≥80k tokens ${r.sessions.bigSessions} 個`);
  lines.push('', '建議：');
  r.suggestions.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  return lines.join('\n');
}

/**
 * 讀真表產生報告。
 * @param {number=} days
 * @return {!Object}
 */
function collectUsageReport_(days) {
  return usageReport_({
    days: days || REPORT_DEFAULT_DAYS,
    queueRows: readTable_('Queue').rows,
    usageRows: readTable_('Usage').rows,
    auditRows: readTable_('AuditLog').rows,
    sessionRows: readTable_('Sessions').rows,
    maxSteps: getToolConfig_().maxToolSteps,
    budgetMs: TURN_TIME_BUDGET_MS,
  });
}
