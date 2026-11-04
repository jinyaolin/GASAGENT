/**
 * @fileoverview watcher toolset（M7-B）：watcher_manage —— 管理事件觸發（某件事發生就跑任務）。handler 在 Watchers.gs。
 * autonomous 模式只允許 list。群組成員永遠不可用（PRINCIPAL_LOCKED_TOOLSETS）。
 */

/** @return {!Array<ToolDecl>} */
function watcherTools_() {
  return [
    {
      name: 'watcher_manage', toolset: 'watcher', risk: 'W',
      description: '管理事件觸發器（watcher）：系統每 every_minutes 分鐘檢查來源，有新事件就用 prompt 開一個無人模式任務處理（事件資料會附在任務裡），結果依 deliver_to 投遞。type=gmail（config.query：Gmail 搜尋語法，例 "label:發票 has:attachment"）、drive（config.folder_id：資料夾有新 / 改檔）、sheets（config.spreadsheet_id + 可選 sheet_name：工作表新增列）、odoo（config.model + 可選 domain：Odoo 新記錄）。action=list / create（name, type, config, prompt 必填）/ update / delete（停用）/ check_now（立刻檢查一次）。建立時會先記下目前狀態（baseline），只對之後的新事件反應。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'check_now'] },
          id: { type: 'string', description: 'update / delete / check_now 的 watcher id' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['gmail', 'drive', 'sheets', 'odoo'] },
          config: { type: ['string', 'object'], description: '來源設定 object（或其 JSON 字串），欄位依 type：{query} / {folder_id} / {spreadsheet_id, sheet_name} / {model, domain, fields}' },
          prompt: { type: 'string', description: '事件發生時要執行的任務指令（無人模式；事件資料會接在後面，寫清楚要做什麼、產出什麼）' },
          deliver_to: { type: 'string', enum: ['doc', 'email', 'telegram', 'none'], description: '結果投遞，預設 telegram' },
          model_pin: { type: 'string', description: '指定 provider id（空 = main 備援鏈）' },
          skills: { type: 'string', description: '要載入的技能名稱（逗號分隔）' },
          every_minutes: { type: 'integer', description: `檢查間隔（分鐘），預設 ${WATCH_DEFAULT_EVERY_MINUTES}，1–1440` },
          enabled: { type: 'boolean' },
        },
        required: ['action'], additionalProperties: false,
      },
      handler: watcherManage_,
    },
  ];
}
