/**
 * @fileoverview 清理（保留期限）：Queue 已完成 / 失敗的 job、AuditLog、Usage、已決定的 Approvals、已壓縮進摘要的 Messages，
 * 超過 Config retention_days 的列每天刪一次。目的：這幾張表只進不出，readTable_ 整張讀會隨使用量線性變慢（管理頁與每分鐘 queueTick 都受害）。
 *
 * 安全邊界：
 *   - 只在 queueTickCore_ 的 script lock 裡跑（沒有 job 同時執行）；各 store 的 update 已改成按 id 重新定位，不信任舊列號。
 *   - 不碰 queued / running / needs_input 的 job、被 pending 審批引用的 job（approval 批准後要 enqueue 續跑）、未壓縮的 Messages、Sessions / Memory / Config 等設定表。
 *   - 每個 tab 一次最多刪 HOUSEKEEP_MAX_ROWS_PER_TAB 列、整體看 tick 剩餘預算；沒刪完就 HOUSEKEEP_RETRY_MS 後再來，不讓單次 tick 逼近 6 分鐘。
 *   - 第一次（旗標空）只排下一次時間、不立刻刪：剛部署就大量刪列風險沒必要。
 * 純函式 housekeepPlan_ 決定刪哪些列，測試不碰 Sheet。
 */

/** 多久跑一次。 */
const HOUSEKEEP_EVERY_MS = 24 * 60 * 60 * 1000;
/** 沒刪完時多久後再跑。 */
const HOUSEKEEP_RETRY_MS = 2 * 60 * 1000;
/** 每個 tab 單次最多刪幾列。 */
const HOUSEKEEP_MAX_ROWS_PER_TAB = 500;
/** tick 剩餘預算低於這個就不開始清理。 */
const HOUSEKEEP_MIN_BUDGET_MS = 60000;
/** 清理的 tab 順序（Queue 先：影響每分鐘 tick 最大）。 */
const HOUSEKEEP_TABS = Object.freeze(['Queue', 'AuditLog', 'Usage', 'Approvals', 'Messages']);

/**
 * @param {*} v Date / ISO / 空
 * @return {number} ms；無法解析回 NaN
 */
function housekeepTimeMs_(v) {
  const d = toDateOrNull_(v);
  return d ? d.getTime() : NaN;
}

/**
 * 決定某個 tab 哪些列可刪。純函式。rows 是 readTable_ 的列（含 _row，列序 = sheet 順序 = 時間順序）。
 * @param {string} tab
 * @param {!Array<!Object>} rows
 * @param {{cutoffMs: number, keepJobIds: (Object<string, boolean>|undefined), compactSeq: (Object<string, number>|undefined), maxRows: (number|undefined)}} ctx
 *   keepJobIds：pending 審批引用的 job id；compactSeq：session id → compact_seq（Messages 只刪 seq ≤ compact_seq 的）
 * @return {{rowIndexes: !Array<number>, eligible: number}} rowIndexes 最多 maxRows 筆（最舊優先）；eligible = 全部可刪的數量
 */
function housekeepPlan_(tab, rows, ctx) {
  const cutoff = ctx.cutoffMs;
  const keep = ctx.keepJobIds || {};
  const compact = ctx.compactSeq || {};
  const max = ctx.maxRows || HOUSEKEEP_MAX_ROWS_PER_TAB;
  const older = (v) => { const t = housekeepTimeMs_(v); return isFinite(t) && t < cutoff; };
  const ok = (r) => {
    if (tab === 'Queue') return /^(done|failed)$/.test(String(r.state || '')) && older(r.finished) && !keep[String(r.id || '')];
    if (tab === 'AuditLog' || tab === 'Usage') return older(r.ts);
    if (tab === 'Approvals') return String(r.state || '') !== 'pending' && String(r.state || '') !== '' && older(r.decided_at);
    if (tab === 'Messages') {
      const cs = compact[String(r.session_id || '')];
      return cs !== undefined && toNumber_(r.seq, 0) <= cs && older(r.ts);
    }
    return false;
  };
  const all = (rows || []).filter((r) => r._row >= 2 && ok(r)).map((r) => r._row);
  return { rowIndexes: all.slice(0, max), eligible: all.length };
}

/**
 * 清理一輪：讀 pending 審批與 Sessions 的 compact_seq 當上下文，逐 tab 計畫並刪列。
 * @param {{now: (Function|undefined), retentionDays: number, budgetMs: (number|undefined), tables: (Object|undefined), audit: (Function|undefined)}} deps
 *   tables：{read(tab) → rows, deleteRows(tab, rowIndexes) → n}（預設 readTable_ / deleteTableRows_）
 * @return {{deleted: !Object<string, number>, eligible: !Object<string, number>, complete: boolean, ms: number}}
 */
function housekeepRun_(deps) {
  const now = deps.now || (() => Date.now());
  const started = now();
  const tables = deps.tables || { read: (tab) => readTable_(tab).rows, deleteRows: (tab, idx) => deleteTableRows_(tab, idx) };
  const cutoffMs = now() - deps.retentionDays * 24 * 60 * 60 * 1000;
  const keepJobIds = {};
  tables.read('Approvals').forEach((r) => { if (String(r.state || '') === 'pending' && r.job_id) keepJobIds[String(r.job_id)] = true; });
  const compactSeq = {};
  tables.read('Sessions').forEach((r) => { if (r.id) compactSeq[String(r.id)] = toNumber_(r.compact_seq, 0); });
  const report = { deleted: {}, eligible: {}, complete: true, ms: 0 };
  for (let i = 0; i < HOUSEKEEP_TABS.length; i++) {
    const tab = HOUSEKEEP_TABS[i];
    if (deps.budgetMs && now() - started > deps.budgetMs) { report.complete = false; break; }
    let rows;
    try { rows = tables.read(tab); } catch (err) { continue; } // 舊安裝沒這個 tab
    const plan = housekeepPlan_(tab, rows, { cutoffMs, keepJobIds, compactSeq });
    report.eligible[tab] = plan.eligible;
    report.deleted[tab] = plan.rowIndexes.length ? tables.deleteRows(tab, plan.rowIndexes) : 0;
    if (plan.eligible > plan.rowIndexes.length) report.complete = false;
  }
  report.ms = now() - started;
  return report;
}

/**
 * queueTick 用：旗標到期才清；旗標空只排下一次（部署後 24 小時才第一次清）。retention_days = 0 關閉。
 * @param {{now: (Function|undefined), cfg: (AgentConfig|undefined), budgetMs: (number|undefined), tables: (Object|undefined), audit: (Function|undefined), force: (boolean|undefined)}} deps
 * @return {?Object} housekeepRun_ 的報告 + nextRun；沒到期回 null
 */
function housekeepIfDue_(deps) {
  deps = deps || {};
  const nowMs = deps.now ? deps.now() : Date.now();
  const next = getProp_(PROP.HOUSEKEEP_NEXT_RUN);
  if (!deps.force) {
    if (!next) { setProp_(PROP.HOUSEKEEP_NEXT_RUN, new Date(nowMs + HOUSEKEEP_EVERY_MS).toISOString()); return null; }
    if (new Date(next).getTime() > nowMs) return null;
  }
  if (deps.budgetMs !== undefined && deps.budgetMs < HOUSEKEEP_MIN_BUDGET_MS) return null; // 這次 tick 沒時間，下次再說
  const cfg = deps.cfg || getAgentConfig_();
  if (!cfg.retentionDays) {
    setProp_(PROP.HOUSEKEEP_NEXT_RUN, new Date(nowMs + HOUSEKEEP_EVERY_MS).toISOString());
    return { skipped: 'disabled', nextRun: getProp_(PROP.HOUSEKEEP_NEXT_RUN) };
  }
  const r = housekeepRun_({ now: deps.now, retentionDays: cfg.retentionDays, budgetMs: deps.budgetMs, tables: deps.tables });
  const nextRun = new Date(nowMs + (r.complete ? HOUSEKEEP_EVERY_MS : HOUSEKEEP_RETRY_MS)).toISOString();
  setProp_(PROP.HOUSEKEEP_NEXT_RUN, nextRun);
  setProp_(PROP.HOUSEKEEP_LAST_RUN, new Date(nowMs).toISOString());
  const total = Object.keys(r.deleted).reduce((a, k) => a + r.deleted[k], 0);
  if (total) {
    const summary = Object.keys(r.deleted).filter((k) => r.deleted[k]).map((k) => `${k} −${r.deleted[k]}`).join('、');
    try {
      (deps.audit || ((e) => appendTableRow_('AuditLog', e)))({
        ts: new Date(nowMs), session_id: '', tool: 'system:housekeeping', args_preview: `保留 ${cfg.retentionDays} 天`,
        result_preview: `${summary}${r.complete ? '' : '（未刪完，2 分鐘後續刪）'}`, ok: true, ms: r.ms, principal: 'owner',
      });
    } catch (err) { /* 忽略 */ }
  }
  return Object.assign(r, { nextRun });
}
