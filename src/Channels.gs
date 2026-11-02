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
  email_enabled: false,
  email_inbox_label: 'agent/inbox',
  email_scan_every_minutes: 5,
});

/**
 * @typedef {{
 *   telegramEnabled: boolean, telegramAllowedUserIds: !Array<string>, telegramWebhookUrl: string, telegramOwnerChatId: string, telegramNotifyApprovals: boolean, telegramAck: boolean,
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
  const parsed = parseChannelConfig_(Object.assign({}, getConfigMap_(), values));
  if (values.email_scan_every_minutes !== undefined) values.email_scan_every_minutes = parsed.emailScanEveryMinutes;
  if (parsed.telegramEnabled && !parsed.telegramAllowedUserIds.length) throw new Error('啟用 Telegram 前請先填至少一個允許的 Telegram user id（純數字）。');
  if (Object.keys(values).length) setConfigValues_(values);
  if (typeof input.telegramBotToken === 'string' && input.telegramBotToken.trim()) setTelegramToken_(input.telegramBotToken);
  if (input.regenerateSecret || !getTelegramSecret_()) setProp_(PROP.TELEGRAM_WEBHOOK_SECRET, newWebhookSecret_());
  // Email：啟用就把下次掃描設成現在，讓 queueTick 立刻接手；停用就清掉旗標（閒置零成本）。
  refreshEmailNextScanProp_(parsed, parsed.emailEnabled ? new Date() : null);
  return parsed;
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
      const r = deliverTurnToTelegram_(chatId, result, deps);
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
