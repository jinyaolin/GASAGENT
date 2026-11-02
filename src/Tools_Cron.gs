/**
 * @fileoverview cronjob toolset（M4）：cronjob_manage，沿 hermes 的單一 action 式工具管理排程。
 * handler 在 Cron.gs（cronjobManage_）。toolset 取名 cronjob 是因為 registry 規則要求工具名以「<toolset>_」開頭。
 * autonomous 模式（排程任務內）只允許 list，其餘動作回錯以免遞迴排程。
 */

/** @return {!Array<ToolDecl>} */
function cronTools_() {
  return [
    {
      name: 'cronjob_manage', toolset: 'cronjob', risk: 'W',
      description: '管理排程任務（無人時由系統每分鐘 trigger 執行）。action=list 列出全部；create 需要 name / schedule / prompt，可選 deliver_to（doc 建 Google 文件 / email 寄給 owner / telegram 送 owner 的 Telegram / none）、model_pin、skills；update 以 id 改欄位；delete 停用（不刪除）；run_now 立刻排入執行。schedule 用 5 欄 cron（分 時 日 月 週，例 "0 9 * * 1-5"）或捷徑 "hourly" / "daily 09:00" / "weekly mon 09:00"。排程任務執行中不可再建排程。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'run_now'] },
          id: { type: 'string', description: 'update / delete / run_now 的排程 id' },
          name: { type: 'string', description: '排程名稱（也是投遞文件標題的前綴）' },
          schedule: { type: 'string', description: '5 欄 cron 或捷徑 hourly / daily HH:MM / weekly <mon..sun> HH:MM' },
          prompt: { type: 'string', description: '到時要執行的任務指令（會在全新 session、無人模式下執行）' },
          deliver_to: { type: 'string', enum: ['doc', 'email', 'telegram', 'none'], description: '結果投遞方式，預設 doc；telegram 送到 owner 的 Telegram' },
          model_pin: { type: 'string', description: '指定 provider id（空 = main 備援鏈）' },
          skills: { type: 'string', description: '要載入的技能名稱（M5 才生效，逗號分隔）' },
          enabled: { type: 'boolean', description: 'update 時可直接啟停' },
        },
        required: ['action'], additionalProperties: false,
      },
      handler: cronjobManage_,
    },
  ];
}
