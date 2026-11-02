/**
 * @fileoverview skill toolset（M5）：skill_load（R）載技能全文、skill_manage（W）以「提案」新建 / 修補技能。
 * handler 在 Skills.gs。toolset 取名 skill（不是 skills）是因為 registry 規則要求工具名以「<toolset>_」開頭，
 * 而工具名沿 hermes 叫 skill_load / skill_manage；RBAC key 因此是 rbac.skill。
 *
 * skill_manage 宣告 proposal hook：executor 在未批准時不執行 handler，而是驗證後寫一列 Approvals（reason 以「技能提案」開頭）
 * 回 pending_approval；owner 在管理頁批准後 decideApproval_ 以 approved=true 重跑才真的寫 Drive。
 */

/** @return {!Array<ToolDecl>} */
function skillsTools_() {
  return [
    {
      name: 'skill_load', toolset: 'skill', risk: 'R', noSpill: true,
      description: '載入一個技能的全文（步驟、格式、注意事項）。system prompt 的「可用技能」只列名稱與描述；任務符合某個技能的描述或觸發詞時先呼叫這個再照技能指示做。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名稱（小寫連字號，例 weekly-report）' } },
        required: ['name'], additionalProperties: false,
      },
      handler: skillLoad_,
    },
    {
      name: 'skill_manage', toolset: 'skill', risk: 'W',
      description: '提案新建或修補技能（不會立刻生效：會寫成一筆審批，owner 批准後才寫入 Drive）。action=create 需要 name / description / content（正文 markdown：步驟、工具與參數要點、輸出格式、注意事項，不放這次任務的具體資料）；action=patch 需要 name，並給 patch_find + patch_replace（原文片段需唯一命中）或整份 content，也可只改 description / triggers。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'patch'] },
          name: { type: 'string', description: '技能名稱：小寫字母 / 數字 / 連字號，例 weekly-report' },
          description: { type: 'string', description: '一行說明何時用這個技能（≤ 300 字）' },
          content: { type: 'string', description: 'create 的正文；patch 時給整份新正文（與 patch_find 二選一）' },
          patch_find: { type: 'string', description: 'patch：要取代的原文片段（需唯一命中）' },
          patch_replace: { type: 'string', description: 'patch：取代成的文字（空字串 = 刪除該片段）' },
          triggers: { type: 'array', items: { type: 'string' }, description: '觸發詞（選填）' },
          version: { type: 'string', description: '版本（選填，例 1.1）' },
        },
        required: ['action', 'name'], additionalProperties: false,
      },
      proposal: skillManageProposal_,
      handler: skillManage_,
    },
  ];
}
