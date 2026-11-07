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
  /** M7-A：群聊模式成員（principal group_member）可用的 toolset；只有 R 類直接跑。memory / cronjob 永遠不可放寬。 */
  telegram_member_toolsets: 'web,skill,session',
  email_enabled: false,
  email_inbox_label: 'agent/inbox',
  email_scan_every_minutes: 5,
  /** Email 回覆 / 投遞的寄件者顯示名稱（寄件地址仍是 owner 本人）；掃描時也用它認出 agent 自己的回覆。 */
  email_sender_name: 'GAS Agent',
});

/**
 * @typedef {{
 *   telegramEnabled: boolean, telegramAllowedUserIds: !Array<string>, telegramWebhookUrl: string, telegramOwnerChatId: string, telegramNotifyApprovals: boolean, telegramAck: boolean, telegramOpenGroups: !Array<string>, telegramGuestGroups: !Array<string>, telegramBotUsername: string,
 *   telegramMemberToolsets: !Array<string>, emailEnabled: boolean, emailInboxLabel: string, emailScanEveryMinutes: number, emailSenderName: string
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
    telegramMemberToolsets: principalToolsets_('group_member', map.telegram_member_toolsets === undefined ? d.telegram_member_toolsets : map.telegram_member_toolsets),
    emailEnabled: map.email_enabled === undefined ? d.email_enabled : toBoolean_(map.email_enabled),
    emailInboxLabel: String(map.email_inbox_label || d.email_inbox_label).trim() || d.email_inbox_label,
    emailScanEveryMinutes: clampInt_(map.email_scan_every_minutes, d.email_scan_every_minutes, 1, 1440),
    emailSenderName: String(map.email_sender_name === undefined ? d.email_sender_name : map.email_sender_name).trim().slice(0, 80) || d.email_sender_name,
  };
}

/** @return {ChannelConfig} */
function getChannelConfig_() {
  return parseChannelConfig_(getConfigMap_());
}

/**
 * 管理頁「通道」分頁儲存。token / secret 在 Script Properties，其餘進 Config。
 * token（M7-A）：先用新 token 打 getMe 驗證，成功才寫入並重登 webhook（telegramReplaceToken_）；失敗 throw、舊 token 不動。
 * secret：沒有就產生一個；輪替請用 telegramRotateSecret_（會自動重登 webhook）。
 * @param {!Object} input key 同 CHANNEL_CONFIG_DEFAULTS + telegramBotToken（非空才寫）
 * @param {{api: (Function|undefined)}=} deps 測試注入（api(method, payload)）
 * @return {ChannelConfig}
 */
function saveChannelConfig_(input, deps) {
  input = input || {};
  deps = deps || {};
  const values = {};
  Object.keys(CHANNEL_CONFIG_DEFAULTS).forEach((k) => {
    if (input[k] === undefined) return;
    const def = CHANNEL_CONFIG_DEFAULTS[k];
    values[k] = typeof def === 'boolean' ? toBoolean_(input[k]) : typeof def === 'number' ? toNumber_(input[k], def) : String(input[k] || '').trim();
  });
  if (values.telegram_allowed_user_ids !== undefined) values.telegram_allowed_user_ids = toStringList_(values.telegram_allowed_user_ids).join(',');
  if (values.telegram_open_groups !== undefined) values.telegram_open_groups = toStringList_(values.telegram_open_groups).join(',');
  if (values.telegram_guest_groups !== undefined) values.telegram_guest_groups = toStringList_(values.telegram_guest_groups).join(',');
  if (values.telegram_member_toolsets !== undefined) values.telegram_member_toolsets = principalToolsets_('group_member', values.telegram_member_toolsets).join(',');
  const parsed = parseChannelConfig_(Object.assign({}, getConfigMap_(), values));
  if (values.email_scan_every_minutes !== undefined) values.email_scan_every_minutes = parsed.emailScanEveryMinutes;
  if (values.email_sender_name !== undefined) values.email_sender_name = parsed.emailSenderName;
  if (parsed.telegramEnabled && !parsed.telegramAllowedUserIds.length) throw new Error('啟用 Telegram 前請先填至少一個允許的 Telegram user id（純數字）。');
  if (Object.keys(values).length) setConfigValues_(values);
  if (!getTelegramSecret_()) setProp_(PROP.TELEGRAM_WEBHOOK_SECRET, newWebhookSecret_());
  if (typeof input.telegramBotToken === 'string' && input.telegramBotToken.trim()) {
    telegramReplaceToken_(input.telegramBotToken, { cfg: parsed, api: deps.api });
  }
  // Email：啟用就把下次掃描設成現在，讓 queueTick 立刻接手；停用就清掉旗標（閒置零成本）。
  refreshEmailNextScanProp_(parsed, parsed.emailEnabled ? new Date() : null);
  return parsed;
}

/** 群聊模式（M6：/group on 的群組裡非 owner 成員觸發的那一輪）附加的 system 指示。 */
const MEMBER_SYSTEM_EXTRA = '本訊息來自 Telegram 群組的成員，不是 owner 本人。你只有下面列出的少數公開工具（讀取類直接用；任何寫入、刪除、寄信、分享類的動作都會先送 owner 審批，告知對方等 owner 批准即可）。owner 的 Gmail、Drive、文件、行事曆、記憶等 Workspace 資料在群組對話裡**一律不可讀取也不可透露**；若對方要求這類事情，簡短回「這個功能只有 owner 本人能用」即可，不要重試、不要說明 owner 的設定。這一輪看不到 owner 的記憶快照。';
/** 群聊模式下某個工具被 principal 開關擋下時，附在回覆末尾給群組看的中性說明。 */
const MEMBER_DENIED_NOTE = '（群組對話只能用公開工具；owner 的 Gmail / Drive / 行事曆等資料不會在群組中讀取。）';

/**
 * 群聊成員的 system 指示：固定文字 + 這個群組目前可用的 toolset。純函式。
 * @param {(!Array<string>|undefined)=} toolsets
 * @return {string}
 */
function memberSystemExtra_(toolsets) {
  const list = principalToolsets_('group_member', toolsets);
  return MEMBER_SYSTEM_EXTRA + `\n群組目前可用的 toolset：${list.length ? list.join(', ') : '（無；只能用一般知識回答）'}。`;
}
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
    const r = deliverTurnToEmail_(threadId, result, deps);
    return { channel, ok: true, summary: r.skipped ? `Email 未回覆 thread ${threadId}（這輪沒有文字結果也沒有待審批 / 續跑）` : `Email 已回覆 thread ${threadId}`, error: '' };
  } catch (err) {
    const message = String(err && err.message || err);
    return { channel, ok: false, summary: `通道投遞失敗：${message}`, error: message };
  }
}

/**
 * 回覆文字：agent 的最終文字 + 待審批 / 續跑說明。純函式。
 * @param {!Object} result
 * @param {{approvalHint: string, skipEmpty: (boolean|undefined)}} opts approvalHint：通道專屬的審批說明（Telegram 有按鈕、Email 指到管理頁）；
 *   skipEmpty：沒有文字、也沒有待審批 / 續跑 / 技能提案要講時回空字串（Email 用：不寄「（這輪沒有文字結果）」）
 * @return {string}
 */
function channelReplyText_(result, opts) {
  const text = String(result.text || '').trim();
  const pendingCount = (result.steps || []).filter((s) => s.status === 'pending_approval').length;
  const hasExtra = pendingCount > 0 || !!result.continued_by || !!(result.skillProposal && result.skillProposal.proposed);
  if (!text && !hasExtra && opts && opts.skipEmpty) return '';
  const lines = [text || '（這輪沒有文字結果）'];
  const pending = (result.steps || []).filter((s) => s.status === 'pending_approval');
  if (pending.length) lines.push('', `⏸ 待你審批：${pending.map((s) => s.tool).join(', ')}。${(opts && opts.approvalHint) || ''}${result.approval_notice && result.approval_notice.ok ? '（也已推到 Telegram，可直接按按鈕）' : ''}`.trim());
  if (result.continued_by) lines.push('', '（任務尚未完成，系統已排續跑，稍後會再回覆。）');
  if (result.skillProposal && result.skillProposal.proposed) lines.push('', `💡 agent 提了一個技能提案（${result.skillProposal.approvalId}）${result.skillProposal.notified ? '，內容與批准 / 拒絕按鈕已另送到你的 Telegram。' : '，用 /approve 或管理頁「紀錄 → 審批」決定。'}`);
  return lines.join('\n');
}
