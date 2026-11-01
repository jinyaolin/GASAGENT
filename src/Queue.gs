/**
 * @fileoverview Queue runner 空殼。M4 才放 job 狀態機、LockService、checkpoint/續跑。
 *
 * installAgent() 會裝一支每分鐘的 time-driven trigger 指向 queueTick()。
 * trigger 每日總時間只有 90 分鐘，所以閒置時必須幾乎零成本地 return：
 * 先看 Script Property QUEUE_DIRTY（讀 Properties 只要幾毫秒），
 * 沒有旗標就不開 spreadsheet。enqueue（M4）負責把旗標設為 '1'。
 */

/** time trigger 指向的函式名；Setup / Doctor 用它找 trigger。 */
const QUEUE_TICK_HANDLER = 'queueTick';

/**
 * 每分鐘 trigger 入口。M0 僅為空殼：無待辦 job 立刻 return。
 * @return {void}
 */
function queueTick() {
  if (getProp_(PROP.QUEUE_DIRTY) !== '1') return;

  // M4：LockService.tryLock → 取 queued job → runTurn → checkpoint → 續排 / 完成。
  // M0 還沒有任何會寫 Queue 的入口，若旗標被誤設就清掉，避免每分鐘白跑。
  const queueSheet = getDb_().getSheetByName('Queue');
  if (!queueSheet || queueSheet.getLastRow() <= 1) {
    setProp_(PROP.QUEUE_DIRTY, '');
  }
}
