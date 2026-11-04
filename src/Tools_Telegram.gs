/**
 * @fileoverview telegram toolset：telegram_send_file —— 把 Drive 檔案（PDF / 簡報 / 圖片…）直接傳進 Telegram 對話。
 *
 * 目標 chat 不由模型指定：任務來自 Telegram 就送回同一個 chat，否則送 owner 的 Telegram（Config telegram_owner_chat_id）。
 * 這樣模型拿不到任意 chat_id 當外洩管道；群組成員（principal group_member）預設看不到這個 toolset。
 */

/** @return {!Array<ToolDecl>} */
function telegramTools_() {
  return [
    {
      name: 'telegram_send_file', toolset: 'telegram', risk: 'W',
      description: '把 Drive 檔案直接傳進 Telegram 對話（Google 文件 / 試算表 / 簡報會轉成 PDF；其他檔原樣；上限 50 MB）。任務來自 Telegram 就送回同一個對話，否則送 owner 的 Telegram。做好報告 / 簡報要給 owner 看時用這個，比只給連結方便。',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'Drive 檔案 id 或網址' },
          caption: { type: 'string', description: '附在檔案下方的說明（≤ 1024 字，選填）' },
          as_photo: { type: 'boolean', description: '圖片以照片形式傳（會被 Telegram 壓縮；預設 false 以檔案傳）' },
        },
        required: ['file_id'], additionalProperties: false,
      },
      handler: telegramSendFile_,
    },
  ];
}

/**
 * 決定要送到哪個 chat：session 是 telegram 通道 → 該 chat（去掉 :guest 後綴）；否則 owner chat。
 * @param {?Object} session
 * @param {{telegramEnabled: boolean, telegramOwnerChatId: string, telegramAllowedUserIds: !Array<string>}} ccfg
 * @return {{chatId: string, target: string}}
 * @throws {Error} 找不到 chat
 */
function telegramTargetChat_(session, ccfg) {
  if (!ccfg || !ccfg.telegramEnabled) throw new Error('Telegram 通道未啟用（管理頁「通道」分頁）。');
  if (session && session.channel === 'telegram' && session.external_id) {
    return { chatId: String(session.external_id).replace(/:guest$/, ''), target: 'session_chat' };
  }
  const owner = String(ccfg.telegramOwnerChatId || ccfg.telegramAllowedUserIds[0] || '');
  if (!owner) throw new Error('沒有 owner 的 Telegram chat id：先在 Telegram 對 bot 說一句話，或在「通道」分頁填白名單 user id。');
  return { chatId: owner, target: 'owner_chat' };
}

function telegramSendFile_(args, ctx) {
  ctx = ctx || {};
  const ccfg = ctx.channelCfg || getChannelConfig_();
  let session = null;
  if (ctx.sessionId) {
    try { session = (ctx.sessionStore || sheetSessionStore_()).get(ctx.sessionId); } catch (err) { session = null; }
  }
  const target = telegramTargetChat_(session, ccfg);
  const r = (ctx.sendDocument || telegramSendDocument_)(target.chatId, requireString_(args.file_id, 'file_id'), { caption: args.caption ? String(args.caption) : '', asPhoto: !!args.as_photo });
  return { sent: true, target: target.target, chat_id: target.chatId, method: r.method, file_name: r.file_name, bytes: r.bytes };
}
