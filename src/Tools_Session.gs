/**
 * @fileoverview session toolset：session_spill_read（分頁讀 ToolExecutor 溢寫到 Drive 的工具結果）、session_search（M3，搜過去的對話；handler 在 Memory.gs）。
 * 標 noSpill，讀出的內容不會再被溢寫（否則永遠讀不到）；limit 上限 20000 字。
 */

/** @return {!Array<ToolDecl>} */
function sessionTools_() {
  return [
    {
      name: 'session_spill_read', toolset: 'session', risk: 'R', noSpill: true,
      description: '分頁讀取先前工具結果溢寫成的檔案（工具結果裡會給 file_id）。用 offset / limit 逐段讀，回傳 has_more 與 next_offset。',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string' },
          offset: { type: 'integer', description: '從第幾個字元開始，預設 0' },
          limit: { type: 'integer', description: '讀幾個字元，預設 6000，上限 20000' },
        },
        required: ['file_id'], additionalProperties: false,
      },
      handler: (args, ctx) => spillRead_((ctx && ctx.spill) || driveSpillStore_(), args.file_id, args.offset, args.limit),
    },
    {
      name: 'session_search', toolset: 'session', risk: 'R',
      description: '搜尋過去的對話 session（標題、摘要、訊息），用來回答「我們之前聊過…」。多個關鍵字以空白分隔需全部命中；回傳符合的 session 與片段。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '關鍵字（空白分隔，AND）' },
          limit: { type: 'integer', description: `最多幾個 session，預設 5，上限 ${SESSION_SEARCH_MAX}` },
        },
        required: ['query'], additionalProperties: false,
      },
      handler: sessionSearch_,
    },
  ];
}
