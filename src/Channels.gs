/**
 * @fileoverview 通道（M6）共用：Telegram / Email 的 Config 設定、Queue job 結束後依 channel 投遞回覆。
 *
 * 入口一律只做「驗證 → 寫 Queue job → 立刻回覆」，agent 由每分鐘 trigger 的 queueTick 跑；
 * runTurnJob_ 結束後呼叫 deliverTurnToChannel_ 把文字（與待審批的按鈕）送回原通道。
 * 各通道細節在 Channels_Telegram.gs / Channels_Email.gs；設定值在 Config sheet（金鑰在 Script Properties）。
 */

/** 通道設定（Config sheet key）與預設值；ensureToolConfigDefaults_ 一起補。 */
const CHANNEL_CONFIG_DEFAULTS = Object.freeze({
  telegram_enabled: false,
  telegram_allowed_user_ids: '',
  telegram_webhook_url: '',
  telegram_owner_chat_id: '',
  telegram_notify_approvals: true,
  telegram_ack: false,
  telegram_open_groups: '',
  telegram_guest_groups: '',
  telegram_bot_username: '',
  email_enabled: false,
  email_inbox_label: 'agent/inbox',
  email_scan_every_minutes: 5,
});

/**
 * @typedef {{
 *   telegramEnabled: boolean, telegramAllowedUserIds: !Array<string>, telegramWebhookUrl: string, telegramOwnerChatId: string, telegramNotifyApprovals: boolean, telegramAck: boolean, telegramOpenGroups: !Array<string>, telegramGuestGroups: !Array<string>, telegramBotUsername: string,
 *   emailEnabled: boolean, emailInboxLabel: string, emailScanEveryMinutes: number
 * }} ChannelConfig
 */

/**
 * Config map → ChannelConfig。純函式。
 * @param {!Object<string, string>} map
 * @return {ChannelConfig}
 */
function parseChannelConfig_(map) {
  map = map || {};
  const d = CHANNEL_CONFIG_DEFAULTS;
  return {
    telegramEnabled: map.telegram_enabled === undefined ? d.telegram_enabled : toBoolean_(map.telegram_enabled),
    telegramAllowedUserIds: toStringList_(map.telegram_allowed_user_ids).filter((x) => /^\d+$/.test(x)),
    telegramWebhookUrl: String(map.telegram_webhook_url || '').trim(),
    telegramOwnerChatId: String(map.telegram_owner_chat_id || '').trim(),
    telegramNotifyApprovals: map.telegram_notify_approvals === undefined ? d.telegram_notify_approvals : toBoolean_(map.telegram_notify_approvals),
    telegramAck: map.telegram_ack === undefined ? d.telegram_ack : toBoolean_(map.telegram_ack),
    telegramOpenGroups: toStringList_(map.telegram_open_groups).filter((x) => /^-?\d+$/.test(x)),
    telegramGuestGroups: toStringList_(map.telegram_guest_groups).filter((x) => /^-?\d+$/.test(x)),
    telegramBotUsername: String(map.telegram_bot_username || '').trim().replace(/^@/, ''),
    emailEnabled: map.email_enabled === undefined ? d.email_enabled : toBoolean_(map.email_enabled),
    emailInboxLabel: String(map.email_inbox_label || d.email_inbox_label).trim() || d.email_inbox_label,
    emailScanEveryMinutes: clampInt_(map.email_scan_every_minutes, d.email_scan_every_minutes, 1, 1440),
  };
}

/** @return {ChannelConfig} */
function getChannelConfig_() {
  return parseChannelConfig_(getConfigMap_());
}

/**
 * 管理頁「通道」分頁儲存。token / secret 在 Script Properties，其餘進 Config。
 * @param {!Object} input key 同 CHANNEL_CONFIG_DEFAULTS + telegramBotToken（非空才寫）+ regenerateSecret
 * @return {ChannelConfig}
 */
function saveChannelConfig_(input) {
  input = input || {};
  const values = {};
  Object.keys(CHANNEL_CONFIG_DEFAULTS).forEach((k) => {
    if (input[k] === undefined) return;
    const def = CHANNEL_CONFIG_DEFAULTS[k];
    values[k] = typeof def === 'boolean' ? toBoolean_(input[k]) : typeof def === 'number' ? toNumber_(input[k], def) : String(input[k] || '').trim();
  });
  if (values.telegram_allowed_user_ids !== undefined) values.telegram_allowed_user_ids = toStringList_(values.telegram_allowed_user_ids).join(',');
  if (values.telegram_open_groups !== undefined) values.telegram_open_groups = toStringList_(values.telegram_open_groups).join(',');
  if (values.telegram_guest_groups !== undefined) values.telegram_guest_groups = toStringList_(values.telegram_guest_groups).join(',');
  const parsed = parseChannelConfig_(Object.assign({}, getConfigMap_(), values));
  if (values.email_scan_every_minutes !== undefined) values.email_scan_every_minutes = parsed.emailScanEveryMinutes;
  if (parsed.telegramEnabled && !parsed.telegramAllowedUserIds.length) throw new Error('啟用 Telegram 前請先填至少一個允許的 Telegram user id（純數字）。');
  if (Object.keys(values).length) setConfigValues_(values);
  if (typeof input.telegramBotToken === 'string' && input.telegramBotToken.trim()) {
    setTelegramToken_(input.telegramBotToken);
    // 換 token 就重抓 bot username（群組 @mention 判斷用）
    try { setConfigValues_({ telegram_bot_username: String(telegramApi_('getMe', {}).username || '') }); } catch (err) { setConfigValues_({ telegram_bot_username: '' }); }
  }
  if (input.regenerateSecret || !getTelegramSecret_()) setProp_(PROP.TELEGRAM_WEBHOOK_SECRET, newWebhookSecret_());
  // Email：啟用就把下次掃描設成現在，讓 queueTick 立刻接手；停用就清掉旗標（閒置零成本）。
  refreshEmailNextScanProp_(parsed, parsed.emailEnabled ? new Date() : null);
  return parsed;
}

/** 群聊模式（M6：/group on 的群組裡非 owner 成員觸發的那一輪）附加的 system 指示。 */
const MEMBER_SYSTEM_EXTRA = '本訊息來自 Telegram 群組的成員，不是 owner 本人。你可以用讀取類工具協助回答群組的問題；任何寫入、刪除、寄信、分享類的動作都會先送 owner 審批（這是正常流程，告知對方等 owner 批准即可）。不要主動透露 owner 的私人資料（記憶、私人郵件、行程）；這一輪看不到 owner 的記憶快照。';
/** 訪客模式（M6：/group guest 的群組裡非白名單成員）附加的 system 指示。 */
const GUEST_SYSTEM_EXTRA = '本訊息來自 Telegram 群組的其他成員，不是 owner。你在這個對話裡**沒有任何工具**，也看不到 owner 的記憶、郵件、檔案、行事曆或設定；絕對不要透露或猜測 owner 的任何資料與行程。用一般知識簡短、友善地回答（繁體中文），需要 owner 的資料或決定時請對方直接找 owner。';

/**
 * 訪客用的工具設定：RBAC 全關（模型連工具清單都看不到）。純函式。
 * @param {ToolConfig} toolConfig
 * @return {ToolConfig}
 */
function guestToolConfig_(toolConfig) {
  const rbac = {};
  Object.keys(toolConfig.rbac || {}).forEach((ts) => { rbac[ts] = { read: false, write: false, delete: false, external: false }; });
  return Object.assign({}, toolConfig, { rbac });
}

/**
 * Queue job 結束後依 payload.channel 投遞回覆（admin / cron 不在此處理）。不 throw：失敗回 ok=false 讓呼叫端記下。
 * @param {!Object} payload job payload（channel / telegram_chat_id / external_id）
 * @param {!Object} result summarizeTurnResult_ 的摘要（text / steps / stopped / continued_by / skillProposal）
 * @param {{sendTelegram: (Function|undefined), replyEmail: (Function|undefined), now: (Function|undefined)}=} deps
 * @return {?{channel: string, ok: boolean, summary: string, error: string}} 非通道 job 回 null
 */
function deliverTurnToChannel_(payload, result, deps) {
  deps = deps || {};
  const channel = String(payload.channel || '');
  if (channel !== 'telegram' && channel !== 'email') return null;
  try {
    if (channel === 'telegram') {
      const chatId = String(payload.telegram_chat_id || payload.external_id || '');
      if (!chatId) throw new Error('payload 缺 telegram_chat_id。');
      const r = deliverTurnToTelegram_(chatId, result, Object.assign({}, deps, {
        // 群組：回覆掛在觸發的那則訊息下，大家才知道在回誰
        replyTo: /^(group|supergroup)$/.test(String(payload.telegram_chat_type || '')) ? toNumber_(payload.telegram_message_id, 0) : 0,
      }));
      return { channel, ok: true, summary: `Telegram 已回覆 chat ${chatId}（${r.messages} 則）`, error: '' };
    }
    const threadId = String(payload.email_thread_id || payload.external_id || '');
    if (!threadId) throw new Error('payload 缺 email_thread_id。');
    deliverTurnToEmail_(threadId, result, deps);
    return { channel, ok: true, summary: `Email 已回覆 thread ${threadId}`, error: '' };
  } catch (err) {
    const message = String(err && err.message || err);
    return { channel, ok: false, summary: `通道投遞失敗：${message}`, error: message };
  }
}

/**
 * 回覆文字：agent 的最終文字 + 待審批 / 續跑說明。純函式。
 * @param {!Object} result
 * @param {{approvalHint: string}} opts approvalHint：通道專屬的審批說明（Telegram 有按鈕、Email 指到管理頁）
 * @return {string}
 */
function channelReplyText_(result, opts) {
  const lines = [String(result.text || '（這輪沒有文字結果）').trim()];
  const pending = (result.steps || []).filter((s) => s.status === 'pending_approval');
  if (pending.length) lines.push('', `⏸ 待你審批：${pending.map((s) => s.tool).join(', ')}。${(opts && opts.approvalHint) || ''}${result.approval_notice && result.approval_notice.ok ? '（也已推到 Telegram，可直接按按鈕）' : ''}`.trim());
  if (result.continued_by) lines.push('', '（任務尚未完成，系統已排續跑，稍後會再回覆。）');
  if (result.skillProposal && result.skillProposal.proposed) lines.push('', `💡 agent 提了一個技能提案（${result.skillProposal.approvalId}），到管理頁「紀錄 → 審批」決定。`);
  return lines.join('\n');
}
