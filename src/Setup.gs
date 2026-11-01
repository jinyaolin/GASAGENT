/**
 * @fileoverview 安裝：寫 OWNER_EMAIL、建 DB 與 tabs、裝 master trigger。可重複執行。
 *
 * 第一次要在 Apps Script 編輯器手動執行 installAgent()，Google 會跳出授權畫面；
 * 之後管理頁的「重新安裝」按鈕（adminReinstall）也走同一條路。
 */

/**
 * 安裝或修復 agent。幂等：重跑不會重建 DB、不會重複裝 trigger。
 * @return {{owner: string, db: {id: string, url: string, created: boolean}, schema: Object, trigger: Object, toolConfig: Object, version: string}}
 * @throws {Error} 目前帳號與既有 OWNER_EMAIL 不符
 */
function installAgent() {
  const me = Session.getEffectiveUser().getEmail();
  if (!me) throw new Error('無法取得目前使用者的 email，請在 Apps Script 編輯器以本人帳號執行。');

  const existingOwner = getOwnerEmail_();
  if (existingOwner && normalizeEmail_(existingOwner) !== normalizeEmail_(me)) {
    throw new Error(
      `此 agent 已安裝給 ${existingOwner}，目前帳號 ${me} 不符。` +
      '要更換 owner 請先到「專案設定 → 指令碼屬性」手動刪除 OWNER_EMAIL。'
    );
  }
  setProp_(PROP.OWNER_EMAIL, me);

  const db = openOrCreateDb_();
  const schema = ensureDbSchema_(db.spreadsheet, db.created);
  const trigger = ensureQueueTrigger_();
  // M2：每個 toolset 的 RBAC 開關、審批策略等預設值（只補缺的，不覆寫）。
  const toolConfig = { addedKeys: ensureToolConfigDefaults_() };
  // M4：CRON_NEXT_RUN 旗標與 Cron tab 對齊（queueTick 閒置時靠它判斷有沒有排程要跑）。
  let cronNextRun = '';
  try { cronNextRun = refreshCronNextRunProp_(sheetCronStore_().list()); } catch (err) { cronNextRun = `failed: ${err && err.message || err}`; }

  const summary = {
    version: APP_VERSION,
    owner: me,
    db: { id: db.spreadsheet.getId(), url: db.spreadsheet.getUrl(), created: db.created },
    schema,
    trigger,
    toolConfig,
    cronNextRun,
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

/**
 * 確保恰好一支每分鐘 trigger 指向 queueTick；多的刪掉。
 * @return {{created: boolean, removedDuplicates: number, total: number}}
 */
function ensureQueueTrigger_() {
  const existing = listQueueTriggers_();
  if (existing.length === 0) {
    ScriptApp.newTrigger(QUEUE_TICK_HANDLER).timeBased().everyMinutes(1).create();
    return { created: true, removedDuplicates: 0, total: 1 };
  }
  existing.slice(1).forEach((t) => ScriptApp.deleteTrigger(t));
  return { created: false, removedDuplicates: existing.length - 1, total: 1 };
}

/**
 * @return {!Array<GoogleAppsScript.Script.Trigger>} 本專案中指向 queueTick 的 trigger
 */
function listQueueTriggers_() {
  return ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === QUEUE_TICK_HANDLER);
}

/**
 * 移除本 agent 裝的所有 trigger（除錯 / 解除安裝用）。不碰 Properties 與 DB。
 * @return {{removed: number}}
 */
function removeAgentTriggers() {
  const triggers = listQueueTriggers_();
  triggers.forEach((t) => ScriptApp.deleteTrigger(t));
  console.log(`已移除 ${triggers.length} 支 trigger`);
  return { removed: triggers.length };
}
