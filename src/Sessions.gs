/**
 * @fileoverview Session：Sessions / Messages 持久化、CacheService 熱快取、context 壓縮（fast 模型摘要）、/new。
 *
 * 一個 session = 一串輪次。每輪把 user、assistant（含 tool_calls）、tool 訊息以中立格式批次寫進 Messages；
 * Sessions 記 title / summary / compact_seq / turns。載入 context 時只拿 compact_seq 之後的訊息，前面的
 * 已被壓成 summary（放在 system prompt 的「先前對話摘要」區塊）。真相在 Sheet，CacheService 只當熱快取。
 *
 * runSessionTurn_() 是聊天台（M3）與 Queue runner（M4）的共同入口：
 *   載入 / 建立 session → 必要時壓縮 → 記憶快照 + 技能索引（M5；/<skill> 與 cron skills 注入全文）→ runTurn_ → 寫回訊息
 *   → 技能自動提案評估（M5：≥ 5 步且順利結束，同 session 一次）→ 審批通知推 Telegram（M6；非 Telegram 來源）→ curation nudge。
 * 全部依賴（store / chat / now）可注入，測試用記憶體 store。
 */

/** Sheet 單格上限 50,000 字元；存訊息前截到這個長度。 */
const MESSAGE_CELL_MAX_CHARS = 45000;
/** CacheService 單值上限 100 KB；JSON 超過就不快取（下次從 Sheet 讀）。 */
const SESSION_CACHE_MAX_CHARS = 90000;
/** 熱快取存活秒數（上限 6 小時）。 */
const SESSION_CACHE_TTL_SEC = 21600;
/** 壓縮時留給摘要的字數上限。 */
const SUMMARY_MAX_CHARS = 4000;

/** Agent 層設定（Config sheet key）與預設值；ensureToolConfigDefaults_ 一起補。 */
const AGENT_CONFIG_DEFAULTS = Object.freeze({
  memory_max_chars: 2200,
  profile_max_chars: 1375,
  context_max_tokens: 24000,
  keep_recent_turns: 4,
  curation_every_turns: 10,
  curation_auto_apply: false,
  session_idle_hours: 6,
  session_embeddings: false,
  turn_budget_seconds: 270,
});

/**
 * @typedef {{
 *   memoryMaxChars: number, profileMaxChars: number, contextMaxTokens: number, keepRecentTurns: number,
 *   curationEveryTurns: number, curationAutoApply: boolean, sessionIdleHours: number, sessionEmbeddings: boolean,
 *   turnBudgetSeconds: number
 * }} AgentConfig
 */

/**
 * @param {!Object<string, string>} map getConfigMap_()
 * @return {AgentConfig}
 */
function parseAgentConfig_(map) {
  map = map || {};
  const d = AGENT_CONFIG_DEFAULTS;
  return {
    memoryMaxChars: clampInt_(map.memory_max_chars, d.memory_max_chars, 200, 20000),
    profileMaxChars: clampInt_(map.profile_max_chars, d.profile_max_chars, 200, 20000),
    contextMaxTokens: clampInt_(map.context_max_tokens, d.context_max_tokens, 2000, 200000),
    keepRecentTurns: clampInt_(map.keep_recent_turns, d.keep_recent_turns, 1, 50),
    curationEveryTurns: clampInt_(map.curation_every_turns, d.curation_every_turns, 0, 1000),
    curationAutoApply: map.curation_auto_apply === undefined ? d.curation_auto_apply : toBoolean_(map.curation_auto_apply),
    sessionIdleHours: clampInt_(map.session_idle_hours, d.session_idle_hours, 0, 720),
    sessionEmbeddings: map.session_embeddings === undefined ? d.session_embeddings : toBoolean_(map.session_embeddings),
    // 單輪時間預算（秒）。預設 270 = Agent.gs 的 TURN_TIME_BUDGET_MS；驗收 Queue 續跑時可調小。
    turnBudgetSeconds: clampInt_(map.turn_budget_seconds, d.turn_budget_seconds, 20, 300),
  };
}

/** @return {AgentConfig} */
function getAgentConfig_() {
  return parseAgentConfig_(getConfigMap_());
}

// ---- token 估算 -----------------------------------------------------------------------

/**
 * 粗估 token：CJK 每字約 1 token，其餘每 4 字元 1 token。只用來決定要不要壓縮，不求準。
 * @param {*} text
 * @return {number}
 */
function estimateTokens_(text) {
  const s = text === null || text === undefined ? '' : (typeof text === 'string' ? text : JSON.stringify(text));
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
  }
  return cjk + Math.ceil((s.length - cjk) / 4);
}

/**
 * @param {!Object} m 中立格式訊息
 * @return {number}
 */
function estimateMessageTokens_(m) {
  return estimateTokens_(m.content) + (m.tool_calls ? estimateTokens_(JSON.stringify(m.tool_calls)) : 0) + 4;
}

// ---- 訊息序列化 --------------------------------------------------------------------------

/**
 * 中立訊息 → Messages.content 欄。純文字的 user / assistant 直接存字串；帶 tool_calls 的 assistant 與 tool 訊息存 JSON。
 * @param {!Object} m
 * @return {string}
 */
function serializeMessage_(m) {
  let s;
  if (m.role === 'tool' || (m.role === 'assistant' && m.tool_calls && m.tool_calls.length)) {
    const o = {};
    if (m.content !== undefined) o.content = m.content;
    if (m.tool_calls) o.tool_calls = m.tool_calls;
    if (m.tool_call_id) o.tool_call_id = m.tool_call_id;
    if (m.name) o.name = m.name;
    s = JSON.stringify(o);
  } else {
    s = stringifyContent_(m.content);
  }
  return s.length > MESSAGE_CELL_MAX_CHARS ? s.slice(0, MESSAGE_CELL_MAX_CHARS) + '…[截斷]' : s;
}

/**
 * Messages 列 → 中立訊息。
 * @param {string} role
 * @param {*} content 欄位值
 * @return {!Object}
 */
function deserializeMessage_(role, content) {
  const s = content === null || content === undefined ? '' : String(content);
  if (role === 'tool' || (role === 'assistant' && s.indexOf('{"') === 0)) {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object' && (role === 'tool' || Array.isArray(o.tool_calls))) return Object.assign({ role }, o);
    } catch (err) { /* 當純文字 */ }
  }
  return { role, content: s };
}

// ---- Session store（Sheet + Cache）---------------------------------------------------------

/**
 * @typedef {{
 *   id: string, channel: string, external_id: string, title: string, summary: string, model_override: string,
 *   token_est: number, created: ?Date, last_active: ?Date, status: string, compact_seq: number, turns: number,
 *   last_curated_turn: number, embedding: ?Array<number>, skill_proposed_turn: number, _row: (number|undefined)
 * }} SessionRow
 * skill_proposed_turn（M5）：已在第幾輪請模型評估過技能提案；0 = 還沒。同 session 只評估一次。
 */

/**
 * @param {!Object} r readTable_ 的列
 * @return {SessionRow}
 */
function parseSessionRow_(r) {
  let embedding = null;
  if (r.embedding) { try { embedding = JSON.parse(String(r.embedding)); } catch (err) { embedding = null; } }
  return {
    _row: r._row,
    id: String(r.id || ''),
    channel: String(r.channel || ''),
    external_id: String(r.external_id || ''),
    title: String(r.title || ''),
    summary: String(r.summary || ''),
    model_override: String(r.model_override || ''),
    token_est: toNumber_(r.token_est, 0),
    created: r.created instanceof Date ? r.created : (r.created ? new Date(r.created) : null),
    last_active: r.last_active instanceof Date ? r.last_active : (r.last_active ? new Date(r.last_active) : null),
    status: String(r.status || 'active'),
    compact_seq: toNumber_(r.compact_seq, 0),
    turns: toNumber_(r.turns, 0),
    last_curated_turn: toNumber_(r.last_curated_turn, 0),
    embedding: Array.isArray(embedding) ? embedding : null,
    skill_proposed_turn: toNumber_(r.skill_proposed_turn, 0),
  };
}

/**
 * @param {SessionRow} s
 * @return {!Object} 寫回 sheet 的值
 */
function serializeSession_(s) {
  return {
    id: s.id, channel: s.channel, external_id: s.external_id, title: s.title, summary: s.summary,
    model_override: s.model_override, token_est: s.token_est, created: s.created, last_active: s.last_active,
    status: s.status, compact_seq: s.compact_seq, turns: s.turns, last_curated_turn: s.last_curated_turn,
    embedding: s.embedding ? JSON.stringify(s.embedding) : '',
    skill_proposed_turn: s.skill_proposed_turn || 0,
  };
}

/** @return {string} 新 session id */
function newSessionId_() {
  let rand;
  try { rand = Utilities.getUuid().slice(0, 6); } catch (err) { rand = Math.random().toString(36).slice(2, 8); }
  return 's_' + Date.now().toString(36) + '_' + rand;
}

/**
 * Sheet 版 session store。
 * @return {{get: Function, create: Function, update: Function, listRecent: Function, appendMessages: Function,
 *   loadMessages: Function, scanMessages: Function}}
 */
function sheetSessionStore_() {
  const cacheKey = (id) => 'sess:' + id;
  const cache = () => { try { return CacheService.getScriptCache(); } catch (err) { return null; } };
  return {
    /** @param {string} id @return {?SessionRow} */
    get: (id) => {
      const row = readTable_('Sessions').rows.find((r) => String(r.id) === id);
      return row ? parseSessionRow_(row) : null;
    },
    /** @param {!Object} fields @return {SessionRow} */
    create: (fields) => {
      const now = new Date();
      const s = Object.assign({
        id: newSessionId_(), channel: 'admin', external_id: '', title: '', summary: '', model_override: '', token_est: 0,
        created: now, last_active: now, status: 'active', compact_seq: 0, turns: 0, last_curated_turn: 0, embedding: null, skill_proposed_turn: 0,
      }, fields || {});
      s._row = appendTableRow_('Sessions', serializeSession_(s));
      return s;
    },
    /** @param {SessionRow} s 整列覆寫（需有 _row；沒有就查） */
    update: (s) => {
      let rowIndex = s._row;
      if (!rowIndex) {
        const row = readTable_('Sessions').rows.find((r) => String(r.id) === s.id);
        if (!row) throw new Error(`找不到 session ${s.id}`);
        rowIndex = row._row;
        s._row = rowIndex;
      }
      writeTableRow_('Sessions', rowIndex, serializeSession_(s));
    },
    /** @param {number} n @param {string=} channel @return {!Array<SessionRow>} last_active 新的在前 */
    listRecent: (n, channel) => readTable_('Sessions').rows.map(parseSessionRow_)
      .filter((s) => s.id && (!channel || s.channel === channel))
      .sort((a, b) => (b.last_active ? b.last_active.getTime() : 0) - (a.last_active ? a.last_active.getTime() : 0))
      .slice(0, n),
    /**
     * 批次追加訊息並更新快取。
     * @param {string} sessionId
     * @param {number} fromSeq 第一則的 seq
     * @param {!Array<!Object>} messages 中立格式
     */
    appendMessages: (sessionId, fromSeq, messages) => {
      if (!messages.length) return;
      const sheet = getDbSheet_('Messages');
      const headers = readHeaders_(sheet);
      const now = new Date();
      const rows = messages.map((m, i) => rowValues_(headers, {
        session_id: sessionId, seq: fromSeq + i, role: m.role, content: serializeMessage_(m), tokens: estimateMessageTokens_(m), ts: now,
      }));
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
      const c = cache();
      if (!c) return;
      try {
        const cached = c.get(cacheKey(sessionId));
        const all = (cached ? JSON.parse(cached) : []).concat(messages.map((m, i) => Object.assign({ seq: fromSeq + i }, m)));
        const json = JSON.stringify(all);
        if (json.length <= SESSION_CACHE_MAX_CHARS) c.put(cacheKey(sessionId), json, SESSION_CACHE_TTL_SEC);
        else c.remove(cacheKey(sessionId));
      } catch (err) {
        console.warn('session 快取更新失敗：' + (err && err.message || err));
      }
    },
    /**
     * 載入 seq > fromSeq 的訊息（依 seq 排序）。先看快取，沒有就掃 Messages 的 session_id 欄只讀命中的列。
     * @param {string} sessionId
     * @param {number} fromSeq
     * @return {!Array<!Object>} 每則帶 seq
     */
    loadMessages: (sessionId, fromSeq) => {
      const c = cache();
      if (c) {
        try {
          const cached = c.get(cacheKey(sessionId));
          if (cached) return JSON.parse(cached).filter((m) => m.seq > fromSeq);
        } catch (err) { /* 掉回 Sheet */ }
      }
      const sheet = getDbSheet_('Messages');
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return [];
      const headers = readHeaders_(sheet);
      const col = {};
      headers.forEach((h, i) => { col[h] = i; });
      const ids = sheet.getRange(2, col.session_id + 1, lastRow - 1, 1).getValues();
      const hits = [];
      ids.forEach((v, i) => { if (String(v[0]) === sessionId) hits.push(i + 2); });
      if (!hits.length) return [];
      // 連續列合併成區塊讀，減少 getRange 次數。
      const out = [];
      let start = hits[0];
      let prev = hits[0];
      const flush = (a, b) => {
        sheet.getRange(a, 1, b - a + 1, headers.length).getValues().forEach((vals) => {
          const seq = toNumber_(vals[col.seq], 0);
          if (seq > fromSeq) out.push(Object.assign({ seq }, deserializeMessage_(String(vals[col.role]), vals[col.content])));
        });
      };
      for (let i = 1; i < hits.length; i++) {
        if (hits[i] === prev + 1) { prev = hits[i]; continue; }
        flush(start, prev);
        start = hits[i];
        prev = hits[i];
      }
      flush(start, prev);
      out.sort((a, b) => a.seq - b.seq);
      if (c) {
        try {
          const json = JSON.stringify(out);
          if (fromSeq === 0 && json.length <= SESSION_CACHE_MAX_CHARS) c.put(cacheKey(sessionId), json, SESSION_CACHE_TTL_SEC);
        } catch (err) { /* 忽略 */ }
      }
      return out;
    },
    /**
     * 全文掃描（session_search 用）：回所有 user / assistant 純文字訊息的 {session_id, seq, role, text, ts}。
     * @return {!Array<!Object>}
     */
    scanMessages: () => readTable_('Messages').rows
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({
        session_id: String(r.session_id), seq: toNumber_(r.seq, 0), role: String(r.role),
        text: stringifyContent_(deserializeMessage_(String(r.role), r.content).content), ts: r.ts instanceof Date ? r.ts : null,
      })),
  };
}

// ---- Context 壓縮 ------------------------------------------------------------------------

/**
 * 把活訊息切成「要壓縮的舊訊息」與「保留的最近 N 輪」。一輪從 user 訊息開始。純函式。
 * @param {!Array<!Object>} messages 依 seq 排序
 * @param {number} keepTurns
 * @return {{old: !Array<!Object>, recent: !Array<!Object>}}
 */
function splitForCompaction_(messages, keepTurns) {
  const userIdx = [];
  messages.forEach((m, i) => { if (m.role === 'user') userIdx.push(i); });
  if (userIdx.length <= keepTurns) return { old: [], recent: messages.slice() };
  const cut = userIdx[userIdx.length - keepTurns];
  return { old: messages.slice(0, cut), recent: messages.slice(cut) };
}

/**
 * 是否需要壓縮：summary + 活訊息的估算 token 超過上限，且有超過 keepTurns 輪可壓。純函式。
 * @param {string} summary
 * @param {!Array<!Object>} messages
 * @param {AgentConfig} cfg
 * @return {boolean}
 */
function needsCompaction_(summary, messages, cfg) {
  const total = estimateTokens_(summary) + messages.reduce((acc, m) => acc + estimateMessageTokens_(m), 0);
  if (total <= cfg.contextMaxTokens) return false;
  return splitForCompaction_(messages, cfg.keepRecentTurns).old.length > 0;
}

/**
 * 把訊息攤成給摘要模型看的文字（工具結果只留前 400 字）。
 * @param {!Array<!Object>} messages
 * @return {string}
 */
function transcriptForSummary_(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return `[工具 ${m.name || ''} 結果] ${truncateText_(stringifyContent_(m.content), 400).text}`;
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      const calls = m.tool_calls.map((tc) => `${tc.function.name}(${truncateText_(tc.function.arguments || '', 200).text})`).join('; ');
      return `[assistant 呼叫工具] ${calls}${m.content ? '\n' + stringifyContent_(m.content) : ''}`;
    }
    return `[${m.role}] ${stringifyContent_(m.content)}`;
  }).join('\n');
}

/**
 * 用 fast 模型（沒有就 main）把舊訊息併進既有摘要。
 * @param {string} previousSummary
 * @param {!Array<!Object>} oldMessages
 * @param {{chat: (Function|undefined), sessionId: (string|undefined)}=} deps chat 預設 runChatTurn_（role fast → main）
 * @return {string} 新摘要
 */
function summarizeMessages_(previousSummary, oldMessages, deps) {
  deps = deps || {};
  const chat = deps.chat || chatFastOrMain_;
  const prompt = [
    '你是對話壓縮器。把「既有摘要」與「新增對話」合併成一份精簡的繁體中文摘要，供 agent 之後繼續對話時參考。',
    '必須保留：使用者的目標與偏好、已做的決定、產出的檔案名稱 / id / 連結、尚未完成或待確認的事、重要數字與日期。',
    '省略：寒暄、重複、工具的原始輸出細節。用條列，總長不超過 ' + SUMMARY_MAX_CHARS + ' 字元。只輸出摘要本身。',
    '',
    '## 既有摘要',
    previousSummary || '（無）',
    '',
    '## 新增對話',
    transcriptForSummary_(oldMessages),
  ].join('\n');
  const r = chat({ role: 'fast', messages: [{ role: 'user', content: prompt }], maxTokens: 2048, sessionId: deps.sessionId || '' });
  const text = String(r.text || '').trim();
  return truncateText_(text || previousSummary, SUMMARY_MAX_CHARS).text;
}

/**
 * 先走 fast 備援鏈，沒有 fast provider 就走 main。
 * @param {!Object} input runChatTurn_ 的 input
 * @return {!Object}
 */
function chatFastOrMain_(input) {
  const providers = listProviders_();
  const role = providerChain_('fast', providers).length ? 'fast' : 'main';
  return runChatTurn_(Object.assign({}, input, { role, providerId: '' }));
}

// ---- 輪次入口 -----------------------------------------------------------------------------

/**
 * 解析聊天輸入的斜線指令：/new、/status，或 M5 的 /<skill-name>（其餘開頭為 / 的字串當一般訊息）。純函式。
 * @param {string} text
 * @return {{command: string, rest: string, skill: string}} command 為 '' 表示一般訊息；'skill' 時 skill 為技能名
 */
function parseSlashCommand_(text) {
  const m = /^\/(new|status)\b\s*([\s\S]*)$/i.exec(String(text || '').trim());
  if (m) return { command: m[1].toLowerCase(), rest: m[2].trim(), skill: '' };
  const sk = parseSkillSlash_(text);
  if (sk) return { command: 'skill', rest: sk.rest, skill: sk.name };
  return { command: '', rest: String(text || '').trim(), skill: '' };
}

/**
 * 取得要用的 session：指定 id 且仍 active 且未閒置過久就沿用；否則建新的。
 * @param {string} sessionId 可空
 * @param {string} channel
 * @param {AgentConfig} cfg
 * @param {!Object} store
 * @param {function(): number} now
 * @param {string=} externalId M6：通道識別（Telegram chat id / Gmail thread id），新建 session 時帶上
 * @return {{session: SessionRow, created: boolean, reason: string}}
 */
function resolveSession_(sessionId, channel, cfg, store, now, externalId) {
  const fields = { channel, external_id: externalId || '' };
  if (sessionId) {
    const s = store.get(sessionId);
    if (s && s.status === 'active') {
      const idleMs = s.last_active ? now() - s.last_active.getTime() : 0;
      if (!cfg.sessionIdleHours || idleMs < cfg.sessionIdleHours * 3600000) return { session: s, created: false, reason: '' };
      s.status = 'closed';
      store.update(s);
      return { session: store.create(fields), created: true, reason: `前一個 session 閒置超過 ${cfg.sessionIdleHours} 小時，已自動開新 session` };
    }
  }
  return { session: store.create(fields), created: true, reason: sessionId ? '指定的 session 不存在或已關閉，已開新 session' : '' };
}

/**
 * 關閉 session（/new）：標 closed，若有未 curation 的輪次就跑一次 curation。
 * @param {SessionRow} s
 * @param {{store: Object, cfg: AgentConfig, curate: (Function|undefined)}} deps
 * @return {{closed: boolean, curation: ?Object}}
 */
function closeSession_(s, deps) {
  s.status = 'closed';
  s.last_active = new Date();
  deps.store.update(s);
  let curation = null;
  if (deps.cfg.curationEveryTurns > 0 && s.turns > s.last_curated_turn) {
    try {
      curation = (deps.curate || curateSession_)(s, deps);
    } catch (err) {
      curation = { error: String(err && err.message || err) };
    }
  }
  return { closed: true, curation };
}

/**
 * 聊天台 / Queue 共同入口：一輪含持久化。
 * @param {{message: string, sessionId: (string|undefined), channel: (string|undefined), providerId: (string|undefined),
 *   systemExtra: (string|undefined), mode: (string|undefined), skills: (string|undefined), externalId: (string|undefined)}} input
 *   skills（M5）：cron 的 `skills` 欄（逗號分隔技能名），全文注入 system prompt；externalId（M6）：通道識別，新建 session 時寫入 external_id
 * @param {{store: (Object|undefined), cfg: (AgentConfig|undefined), toolConfig: (ToolConfig|undefined),
 *   registry: (ToolRegistry|undefined), memoryStore: (Object|undefined), skillStore: (Object|undefined), chat: (Function|undefined),
 *   summarize: (Function|undefined), curate: (Function|undefined), now: (Function|undefined), turnDeps: (Object|undefined)}=} deps
 * @return {!Object} runTurn_ 結果 + {sessionId, sessionCreated, sessionReason, turns, compacted, curation, command,
 *   skills: {loaded, missing}, skillProposal: ?{evaluated, proposed, approvalId, text}, approvalNotice: ?{ok, chatId, skipped, error}}
 */
function runSessionTurn_(input, deps) {
  deps = deps || {};
  const now = deps.now || (() => Date.now());
  const started = now();
  const store = deps.store || sheetSessionStore_();
  const cfg = deps.cfg || getAgentConfig_();
  const channel = input.channel || 'admin';
  const parsed = parseSlashCommand_(input.message);

  if (parsed.command === 'new') {
    let closed = null;
    if (input.sessionId) {
      const prev = store.get(input.sessionId);
      if (prev && prev.status === 'active') closed = closeSession_(prev, { store, cfg, curate: deps.curate, memoryStore: deps.memoryStore, chat: deps.chat, toolConfig: deps.toolConfig, registry: deps.registry });
    }
    const fresh = store.create({ channel, external_id: input.externalId || '' });
    const lines = [`已開新 session（${fresh.id}）。`];
    if (closed && closed.curation) {
      lines.push(closed.curation.error ? `前一個 session 的記憶整理失敗：${closed.curation.error}`
        : `前一個 session 的記憶整理：${describeCuration_(closed.curation)}`);
    }
    if (!parsed.rest) {
      return { text: lines.join('\n'), steps: [], stopped: '', usage: { prompt: 0, completion: 0 }, costEst: 0, ms: now() - started, llmCalls: 0, fallbacks: [],
        sessionId: fresh.id, sessionCreated: true, sessionReason: '', turns: 0, compacted: false, curation: closed ? closed.curation : null, command: 'new', skills: { loaded: [], missing: [] }, skillProposal: null };
    }
    // /new 後面帶訊息：在新 session 繼續跑。
    input = Object.assign({}, input, { message: parsed.rest, sessionId: fresh.id });
  } else if (parsed.command === 'status') {
    const s = input.sessionId ? store.get(input.sessionId) : null;
    const text = s ? `session ${s.id}：${s.turns} 輪，約 ${s.token_est} tokens，${s.summary ? '有' : '無'}摘要，上次活動 ${fmtDate_(s.last_active)}。` : '目前沒有 session，送出第一則訊息就會建立。';
    return { text, steps: [], stopped: '', usage: { prompt: 0, completion: 0 }, costEst: 0, ms: now() - started, llmCalls: 0, fallbacks: [],
      sessionId: s ? s.id : '', sessionCreated: false, sessionReason: '', turns: s ? s.turns : 0, compacted: false, curation: null, command: 'status', skills: { loaded: [], missing: [] }, skillProposal: null };
  }

  const toolConfig = deps.toolConfig || getToolConfig_();
  const registry = deps.registry || getToolRegistry_();
  const memoryStore = deps.memoryStore || sheetMemoryStore_();
  const skillStore = deps.skillStore || (registry.byName.skill_load ? driveSkillStore_() : null);

  // M5：/<skill-name> → 技能全文注入；找不到就直接回錯誤文字（不打模型、不建 session）。
  const skillBlocks = [];
  const skillsReport = { loaded: [], missing: [] };
  const wantSkills = [];
  if (parsed.command === 'skill') wantSkills.push(parsed.skill);
  String(input.skills || '').split(/[\s,;，、]+/).forEach((n) => { if (n) wantSkills.push(n); });
  if (wantSkills.length) {
    const got = skillStore ? skillBlocksFor_(wantSkills, skillStore) : { blocks: [], loaded: [], missing: wantSkills.slice() };
    skillBlocks.push(...got.blocks);
    skillsReport.loaded = got.loaded;
    skillsReport.missing = got.missing;
    if (parsed.command === 'skill' && got.loaded.indexOf(parsed.skill) === -1) {
      let names = [];
      try { names = skillStore ? enabledSkills_(getSkillIndex_(skillStore)).map((x) => x.name) : []; } catch (err) { names = []; }
      const text = `找不到技能「${parsed.skill}」${got.missing.length && /（/.test(got.missing[0]) ? '：' + got.missing[0] : ''}。` +
        `可用技能：${names.length ? names.map((x) => '/' + x).join('、') : '（無；到管理頁「技能」分頁新增）'}。`;
      return { text, steps: [], stopped: '', usage: { prompt: 0, completion: 0 }, costEst: 0, ms: now() - started, llmCalls: 0, fallbacks: [],
        sessionId: input.sessionId || '', sessionCreated: false, sessionReason: '', turns: 0, compacted: false, curation: null, command: 'skill',
        skills: skillsReport, skillProposal: null };
    }
    if (parsed.command === 'skill' && !parsed.rest) parsed.rest = SKILL_DEFAULT_MESSAGE;
  }

  const resolved = resolveSession_(input.sessionId || '', channel, cfg, store, now, input.externalId || '');
  const session = resolved.session;

  // 1. 載入活訊息，必要時壓縮
  let live = store.loadMessages(session.id, session.compact_seq);
  let compacted = false;
  if (needsCompaction_(session.summary, live, cfg)) {
    const split = splitForCompaction_(live, cfg.keepRecentTurns);
    const summarize = deps.summarize || summarizeMessages_;
    session.summary = summarize(session.summary, split.old, { chat: deps.chat, sessionId: session.id });
    session.compact_seq = split.old[split.old.length - 1].seq;
    live = split.recent;
    compacted = true;
  }

  // 2. 記憶快照 + 先前摘要 → system prompt 附加區塊
  const snapshot = buildMemorySnapshot_(memoryStore, cfg);
  const contextBlocks = [];
  if (snapshot) contextBlocks.push(snapshot);
  if (session.summary) contextBlocks.push('## 先前對話摘要（本 session 較早的部分已壓縮）\n' + session.summary);
  // M5：啟用技能的索引（名稱 + 描述）；全文注入的技能接在後面
  if (skillStore) {
    try {
      const indexBlock = buildSkillsIndexBlock_(getSkillIndex_(skillStore));
      if (indexBlock) contextBlocks.push(indexBlock);
    } catch (err) {
      contextBlocks.push(`## 可用技能\n（技能索引讀取失敗：${err && err.message || err}）`);
    }
  }
  skillBlocks.forEach((b) => contextBlocks.push(b));
  contextBlocks.push(`## 本 session\nid=${session.id}，這是第 ${session.turns + 1} 輪。使用者可用 /new 開新 session，/<技能名> 直接套用技能。`);

  // 3. 跑一輪
  const history = live.map((m) => { const o = Object.assign({}, m); delete o.seq; return o; });
  const turnDeps = Object.assign({ registry, config: toolConfig, chat: deps.chat, now: deps.now }, deps.turnDeps || {}, {
    // 時間預算：Config turn_budget_seconds 與呼叫端（Queue 剩餘預算）取小。
    budgetMs: Math.min(cfg.turnBudgetSeconds * 1000, (deps.turnDeps && deps.turnDeps.budgetMs) || Infinity),
    executeDeps: Object.assign({ registry, config: toolConfig, memoryStore, sessionStore: store, agentConfig: cfg, skillStore }, (deps.turnDeps && deps.turnDeps.executeDeps) || {}),
  });
  const r = runTurn_({
    message: parsed.rest,
    history,
    providerId: input.providerId || session.model_override || '',
    sessionId: session.id,
    mode: input.mode || 'interactive',
    systemExtra: input.systemExtra || '',
    contextBlocks,
  }, turnDeps);

  // 4. 寫回這輪新增的訊息（system 與 history 之外的）
  const newMessages = r.messages.slice(1 + history.length);
  const lastSeq = live.length ? live[live.length - 1].seq : session.compact_seq;
  store.appendMessages(session.id, lastSeq + 1, newMessages);
  session.turns += 1;
  session.last_active = new Date();
  if (!session.title) session.title = truncateText_(parsed.rest.replace(/\s+/g, ' '), 60).text;
  session.token_est = estimateTokens_(session.summary) + live.concat(newMessages).reduce((acc, m) => acc + estimateMessageTokens_(m), 0);
  store.update(session);

  // 4b. M5：複雜任務（≥ SKILL_PROPOSE_MIN_STEPS 步、順利結束）後請模型評估一次是否值得存成技能；同 session 只問一次。
  //     這次評估的訊息不寫進 Messages（避免污染對話），結果放 skillProposal 給 UI 顯示；提案本身在 Approvals。
  let skillProposal = null;
  if (shouldNudgeSkillProposal_(r, session, { hasSkillManage: !!(registry.byName.skill_manage && isToolAllowed_(registry.byName.skill_manage, toolConfig.rbac)), elapsedMs: now() - started })) {
    session.skill_proposed_turn = session.turns;
    store.update(session);
    try {
      const nudge = runTurn_({
        message: skillProposalNudgeMessage_(r.steps.length),
        history: r.messages.slice(1),
        providerId: input.providerId || session.model_override || '',
        sessionId: session.id,
        mode: input.mode || 'interactive',
        systemExtra: input.systemExtra || '',
        contextBlocks,
      }, Object.assign({}, turnDeps, { budgetMs: Math.min(SKILL_PROPOSE_BUDGET_MS, turnDeps.budgetMs || SKILL_PROPOSE_BUDGET_MS), maxSteps: 2 }));
      const proposalStep = nudge.steps.find((s) => s.tool === 'skill_manage');
      skillProposal = {
        evaluated: true,
        proposed: !!(proposalStep && proposalStep.status === 'pending_approval'),
        approvalId: proposalStep ? proposalStep.approvalId || '' : '',
        status: proposalStep ? proposalStep.status : '',
        text: truncateText_(nudge.text, 500).text,
        steps: nudge.steps,
      };
      r.usage.prompt += nudge.usage.prompt;
      r.usage.completion += nudge.usage.completion;
      r.costEst = Math.round((r.costEst + nudge.costEst) * 1e6) / 1e6;
      r.llmCalls += nudge.llmCalls;
    } catch (err) {
      skillProposal = { evaluated: true, proposed: false, approvalId: '', status: 'error', text: String(err && err.message || err), steps: [] };
    }
  }

  // 4c. M6：停在審批的動作推一則帶按鈕的 Telegram 通知（Telegram 來源的任務回覆本身就有按鈕，不重複）
  let approvalNotice = null;
  const pendingSteps = r.steps.filter((s) => s.status === 'pending_approval' && s.approvalId);
  if (pendingSteps.length && channel !== 'telegram') {
    approvalNotice = (deps.notifyApprovals || notifyApprovalsTelegram_)({ channel, sessionId: session.id, steps: pendingSteps, message: parsed.rest });
  }

  // 5. Curation nudge：每 K 輪一次，且本輪沒花太久才做（避免撞 6 分鐘）
  let curation = null;
  if (cfg.curationEveryTurns > 0 && session.turns - session.last_curated_turn >= cfg.curationEveryTurns && (now() - started) < 180000) {
    try {
      curation = (deps.curate || curateSession_)(session, { store, cfg, memoryStore, chat: deps.chat, toolConfig, registry });
    } catch (err) {
      curation = { error: String(err && err.message || err) };
    }
  }

  return Object.assign(r, {
    sessionId: session.id, sessionCreated: resolved.created, sessionReason: resolved.reason, turns: session.turns,
    compacted, curation, command: parsed.command, skills: skillsReport, skillProposal, approvalNotice,
  });
}
