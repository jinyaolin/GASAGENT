/**
 * @fileoverview 長期記憶：Memory / UserProfile 兩表的字元上限、快照注入、memory_manage 與 session_search 工具、curation。
 *
 * 沿 hermes 的設計：記憶工具只有 add / replace / remove，**沒有 read**——每輪開始時把兩表快照放進 system prompt，
 * 模型自然看得到；容量滿了回錯誤逼它先整併。一列一條目（content / category / pinned）；pinned 的條目 agent 不能改或刪，
 * 只有 owner 在管理頁能動。curation：每 K 輪或 /new 時，用 fast 模型從對話提議記憶更新；預設寫進 Approvals 由 owner 批准，
 * Config `curation_auto_apply` 開了才直接套用。
 */

/** 兩個目標表。 */
const MEMORY_TARGETS = Object.freeze({
  user: { tab: 'UserProfile', cfgKey: 'profileMaxChars', label: '關於使用者（UserProfile）', hint: '身分、偏好、溝通風格、慣用工具' },
  memory: { tab: 'Memory', cfgKey: 'memoryMaxChars', label: '長期記憶（Memory）', hint: '專案脈絡、決定、工作方式、重要事實' },
});

/** 單條目上限，避免一條就吃光容量。 */
const MEMORY_ENTRY_MAX_CHARS = 500;
/** session_search 回傳上限。 */
const SESSION_SEARCH_MAX = 10;
/** curation 一次最多提議幾筆。 */
const CURATION_MAX_OPS = 12;

/**
 * memory toolset 只有 memory_manage；session_search 依命名歸在 session toolset（宣告在 Tools_Session.gs，handler 在本檔）。
 * @return {!Array<ToolDecl>}
 */
function memoryTools_() {
  return [
    {
      name: 'memory_manage', toolset: 'memory', risk: 'W',
      description: '維護長期記憶。target=memory（專案脈絡、決定、工作方式）或 user（關於使用者的偏好與事實）。action=add 新增一條；replace 以 old_content 找到既有條目（需唯一命中）換成 content；remove 刪除。沒有讀取動作：目前內容已在 system prompt 的快照裡。容量不足時會回錯，請先合併或刪舊條目。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['memory', 'user'] },
          action: { type: 'string', enum: ['add', 'replace', 'remove'] },
          content: { type: 'string', description: 'add / replace 的新內容（一句話到三句話，≤ 500 字）' },
          old_content: { type: 'string', description: 'replace / remove 要比對的既有條目片段（唯一命中即可）' },
          category: { type: 'string', description: '分類（選填），例：preference / project / tool / fact' },
        },
        required: ['target', 'action'], additionalProperties: false,
      },
      handler: memoryManage_,
    },
  ];
}

// ---- store -----------------------------------------------------------------------------------

/**
 * @typedef {{id: string, content: string, category: string, created: ?Date, updated: ?Date, source_session: string, pinned: boolean, _row: (number|undefined)}} MemoryEntry
 */

/** @return {string} */
function newMemoryId_() {
  let rand;
  try { rand = Utilities.getUuid().slice(0, 6); } catch (err) { rand = Math.random().toString(36).slice(2, 8); }
  return 'm_' + Date.now().toString(36) + '_' + rand;
}

/**
 * @param {!Object} r
 * @return {MemoryEntry}
 */
function parseMemoryRow_(r) {
  return {
    _row: r._row,
    id: String(r.id || ''),
    content: String(r.content || ''),
    category: String(r.category || ''),
    created: r.created instanceof Date ? r.created : null,
    updated: r.updated instanceof Date ? r.updated : null,
    source_session: String(r.source_session || ''),
    pinned: toBoolean_(r.pinned),
  };
}

/**
 * @param {MemoryEntry} e
 * @return {!Object}
 */
function serializeMemory_(e) {
  return { id: e.id, content: e.content, category: e.category, created: e.created, updated: e.updated, source_session: e.source_session, pinned: e.pinned ? 'TRUE' : 'FALSE' };
}

/**
 * Sheet 版記憶 store。target 是 'memory' | 'user'。
 * @return {{list: Function, add: Function, update: Function, remove: Function}}
 */
function sheetMemoryStore_() {
  const tab = (target) => {
    const t = MEMORY_TARGETS[target];
    if (!t) throw new Error(`target 必須是 memory 或 user，實際 ${target}`);
    return t.tab;
  };
  return {
    list: (target) => readTable_(tab(target)).rows.map(parseMemoryRow_).filter((e) => e.id && e.content),
    add: (target, entry) => {
      const now = new Date();
      const e = Object.assign({ id: newMemoryId_(), category: '', created: now, updated: now, source_session: '', pinned: false }, entry);
      e._row = appendTableRow_(tab(target), serializeMemory_(e));
      return e;
    },
    update: (target, entry) => {
      entry.updated = new Date();
      writeTableRow_(tab(target), entry._row, serializeMemory_(entry));
      return entry;
    },
    remove: (target, entry) => { deleteTableRow_(tab(target), entry._row); },
  };
}

/**
 * @param {!Array<MemoryEntry>} entries
 * @return {number} 內容總字元數
 */
function memoryUsedChars_(entries) {
  return entries.reduce((acc, e) => acc + e.content.length, 0);
}

/**
 * @param {string} target
 * @param {AgentConfig} cfg
 * @return {number}
 */
function memoryLimit_(target, cfg) {
  return cfg[MEMORY_TARGETS[target].cfgKey];
}

/**
 * 兩表快照 → system prompt 區塊。純函式（store 可注入）。
 * @param {{list: Function}} store
 * @param {AgentConfig} cfg
 * @return {string}
 */
function buildMemorySnapshot_(store, cfg) {
  const parts = ['## 長期記憶快照（每輪開始時凍結；要更動請用 memory_manage）'];
  Object.keys(MEMORY_TARGETS).forEach((target) => {
    const t = MEMORY_TARGETS[target];
    const entries = store.list(target);
    const used = memoryUsedChars_(entries);
    parts.push(`### ${t.label} — ${used} / ${memoryLimit_(target, cfg)} 字元`);
    if (!entries.length) parts.push('（尚無條目）');
    entries.forEach((e) => parts.push(`- ${e.category ? `[${e.category}] ` : ''}${e.content}${e.pinned ? '（owner 鎖定）' : ''}`));
  });
  return parts.join('\n');
}

/**
 * 以 old_content 找唯一條目：先全等，再子字串。
 * @param {!Array<MemoryEntry>} entries
 * @param {string} needle
 * @return {MemoryEntry}
 * @throws {Error} 0 或多筆命中
 */
function findMemoryEntry_(entries, needle) {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').replace(/[…\.。、，,;；:：!！?？\-—–\s]+$/, '').trim();
  const n = norm(needle);
  if (!n) throw new Error('replace / remove 需要 old_content。');
  const exact = entries.filter((e) => e.content === n || norm(e.content) === n);
  if (exact.length === 1) return exact[0];
  let partial = entries.filter((e) => e.content.indexOf(n) !== -1 || norm(e.content).indexOf(n) !== -1);
  if (partial.length === 1) return partial[0];
  if (!partial.length && n.length >= 12) {
    // 模型常把條目改寫或只記得開頭：用前 12 字當前綴找唯一命中
    const head = n.slice(0, 12);
    partial = entries.filter((e) => norm(e.content).indexOf(head) === 0);
    if (partial.length === 1) return partial[0];
  }
  if (!partial.length) {
    const current = entries.slice(0, 20).map((e) => `- ${truncateText_(e.content, 80).text}`).join('\n');
    throw new Error(`找不到含「${truncateText_(n, 60).text}」的條目。快照是本輪開始時的狀態，若你這輪已改過它請用下面目前的內容比對：\n${current || '（目前沒有條目）'}`);
  }
  throw new Error(`「${truncateText_(n, 60).text}」命中 ${partial.length} 條，請給更長的片段以唯一識別。`);
}

/**
 * memory_manage handler。純邏輯，store / cfg 由 ctx 注入（預設 Sheet）。
 * @param {!Object} args
 * @param {!Object} ctx
 * @return {!Object}
 */
function memoryManage_(args, ctx) {
  const store = (ctx && ctx.memoryStore) || sheetMemoryStore_();
  const cfg = (ctx && ctx.agentConfig) || getAgentConfig_();
  const target = args.target;
  if (!MEMORY_TARGETS[target]) throw new Error('target 必須是 memory 或 user。');
  const limit = memoryLimit_(target, cfg);
  const entries = store.list(target);
  const used = memoryUsedChars_(entries);
  const content = String(args.content || '').trim().replace(/\s+/g, ' ');
  const usage = (after) => ({ used: after, limit, free: limit - after });

  if (args.action === 'add') {
    if (!content) throw new Error('add 需要 content。');
    if (content.length > MEMORY_ENTRY_MAX_CHARS) throw new Error(`單條目上限 ${MEMORY_ENTRY_MAX_CHARS} 字元（目前 ${content.length}），請精簡。`);
    if (entries.some((e) => e.content === content)) return { ok: true, action: 'add', target, skipped: 'duplicate', usage: usage(used) };
    if (used + content.length > limit) {
      throw new Error(`${MEMORY_TARGETS[target].label}容量不足：目前 ${used} / ${limit}，新增 ${content.length} 字會超過。請先用 replace 合併相近條目或 remove 過時條目。`);
    }
    const e = store.add(target, { content, category: String(args.category || '').trim(), source_session: (ctx && ctx.sessionId) || '' });
    return { ok: true, action: 'add', target, id: e.id, usage: usage(used + content.length) };
  }
  if (args.action === 'replace') {
    if (!content) throw new Error('replace 需要 content。');
    if (content.length > MEMORY_ENTRY_MAX_CHARS) throw new Error(`單條目上限 ${MEMORY_ENTRY_MAX_CHARS} 字元（目前 ${content.length}），請精簡。`);
    const e = findMemoryEntry_(entries, args.old_content);
    if (e.pinned) throw new Error('該條目由 owner 鎖定（pinned），agent 不能修改。');
    const after = used - e.content.length + content.length;
    if (after > limit) throw new Error(`替換後會超過容量（${after} / ${limit}），請縮短或先刪其他條目。`);
    e.content = content;
    if (args.category) e.category = String(args.category).trim();
    store.update(target, e);
    return { ok: true, action: 'replace', target, id: e.id, content, note: '之後要再改這條請用新內容比對（system prompt 的快照不會更新）。', usage: usage(after) };
  }
  if (args.action === 'remove') {
    const e = findMemoryEntry_(entries, args.old_content);
    if (e.pinned) throw new Error('該條目由 owner 鎖定（pinned），agent 不能刪除。');
    store.remove(target, e);
    return { ok: true, action: 'remove', target, id: e.id, usage: usage(used - e.content.length) };
  }
  throw new Error('action 必須是 add / replace / remove。');
}

// ---- session_search ---------------------------------------------------------------------------

/**
 * 關鍵字 AND 比對（不分大小寫）。純函式。
 * @param {string} text
 * @param {!Array<string>} terms 已小寫
 * @return {boolean}
 */
function matchesAllTerms_(text, terms) {
  const t = String(text || '').toLowerCase();
  return terms.every((k) => t.indexOf(k) !== -1);
}

/**
 * 取第一個關鍵字附近的片段。
 * @param {string} text
 * @param {string} term 小寫
 * @param {number} radius
 * @return {string}
 */
function snippetAround_(text, term, radius) {
  const s = String(text || '');
  const i = s.toLowerCase().indexOf(term);
  if (i === -1) return truncateText_(s, radius * 2).text;
  const start = Math.max(0, i - radius);
  const end = Math.min(s.length, i + term.length + radius);
  return (start > 0 ? '…' : '') + s.slice(start, end).replace(/\s+/g, ' ') + (end < s.length ? '…' : '');
}

/**
 * 搜尋核心。純函式：sessions / messages / 可選的向量比對都由參數給。
 * @param {string} query
 * @param {!Array<SessionRow>} sessions
 * @param {!Array<{session_id: string, seq: number, role: string, text: string, ts: ?Date}>} messages
 * @param {{limit: number, excludeSessionId: string, queryVector: ?Array<number>}} opts
 * @return {!Array<!Object>}
 */
function searchSessions_(query, sessions, messages, opts) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new Error('query 不可為空。');
  const byId = {};
  sessions.forEach((s) => { byId[s.id] = { session: s, score: 0, snippets: [] }; });
  sessions.forEach((s) => {
    if (s.id === opts.excludeSessionId) return;
    if (matchesAllTerms_(s.title + '\n' + s.summary, terms)) {
      byId[s.id].score += 3;
      byId[s.id].snippets.push(snippetAround_(s.title + ' — ' + s.summary, terms[0], 80));
    }
    if (opts.queryVector && s.embedding) {
      const cos = cosine_(opts.queryVector, s.embedding);
      if (cos > 0.5) byId[s.id].score += cos * 5;
    }
  });
  messages.forEach((m) => {
    const hit = byId[m.session_id];
    if (!hit || m.session_id === opts.excludeSessionId) return;
    if (!matchesAllTerms_(m.text, terms)) return;
    hit.score += 1;
    if (hit.snippets.length < 3) hit.snippets.push(`[${m.role}] ` + snippetAround_(m.text, terms[0], 80));
  });
  return Object.keys(byId).map((id) => byId[id]).filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || (b.session.last_active ? b.session.last_active.getTime() : 0) - (a.session.last_active ? a.session.last_active.getTime() : 0))
    .slice(0, opts.limit)
    .map((h) => ({
      session_id: h.session.id, title: h.session.title, status: h.session.status, turns: h.session.turns,
      created: fmtDate_(h.session.created), last_active: fmtDate_(h.session.last_active),
      score: Math.round(h.score * 10) / 10, snippets: h.snippets,
    }));
}

/**
 * session_search handler。
 * @param {!Object} args
 * @param {!Object} ctx
 * @return {!Object}
 */
function sessionSearch_(args, ctx) {
  const store = (ctx && ctx.sessionStore) || sheetSessionStore_();
  const cfg = (ctx && ctx.agentConfig) || getAgentConfig_();
  const limit = clampInt_(args.limit, 5, 1, SESSION_SEARCH_MAX);
  const sessions = store.listRecent(1000);
  let queryVector = null;
  if (cfg.sessionEmbeddings && sessions.some((s) => s.embedding)) {
    try {
      const embed = (ctx && ctx.embed) || ((texts) => embedWithChain_(texts).vectors);
      queryVector = embed([String(args.query)])[0] || null;
    } catch (err) {
      queryVector = null; // 沒有 embed provider 就只用關鍵字
    }
  }
  const results = searchSessions_(String(args.query), sessions, store.scanMessages(), { limit, excludeSessionId: (ctx && ctx.sessionId) || '', queryVector });
  return { query: args.query, count: results.length, used_embeddings: !!queryVector, sessions: results };
}

// ---- curation ---------------------------------------------------------------------------------

/**
 * 從模型回覆抓 JSON（容忍 ```json 圍欄與前後廢話）。純函式。
 * @param {string} text
 * @return {?Object}
 */
function extractJson_(text) {
  const s = String(text || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const candidates = [fenced ? fenced[1] : null, s, s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)].filter(Boolean);
  for (let i = 0; i < candidates.length; i++) {
    try {
      const o = JSON.parse(candidates[i].trim());
      if (o && typeof o === 'object') return o;
    } catch (err) { /* 試下一個 */ }
  }
  return null;
}

/**
 * 模型的 curation JSON → memory_manage 參數列。純函式。
 * 格式：{memory: {add: [{content, category}|string], replace: [{old, new, category}], remove: [string]}, user: {...}}
 * @param {?Object} proposal
 * @return {!Array<!Object>}
 */
function curationOps_(proposal) {
  const ops = [];
  if (!proposal) return ops;
  Object.keys(MEMORY_TARGETS).forEach((target) => {
    const p = proposal[target];
    if (!p || typeof p !== 'object') return;
    [].concat(p.add || []).forEach((a) => {
      const content = typeof a === 'string' ? a : (a && a.content);
      if (content && String(content).trim()) ops.push({ target, action: 'add', content: String(content).trim(), category: (a && a.category) ? String(a.category) : '' });
    });
    [].concat(p.replace || []).forEach((r) => {
      if (r && r.old && r.new) ops.push({ target, action: 'replace', old_content: String(r.old), content: String(r.new), category: r.category ? String(r.category) : '' });
    });
    [].concat(p.remove || []).forEach((r) => {
      const old = typeof r === 'string' ? r : (r && (r.old || r.content));
      if (old) ops.push({ target, action: 'remove', old_content: String(old) });
    });
  });
  return ops.slice(0, CURATION_MAX_OPS);
}

/**
 * 給 curation 模型的 prompt。純函式。
 * @param {string} snapshot buildMemorySnapshot_
 * @param {string} transcript
 * @param {AgentConfig} cfg
 * @return {string}
 */
function curationPrompt_(snapshot, transcript, cfg) {
  return [
    '你是記憶整理員。閱讀「目前記憶快照」與「最近對話」，提議對長期記憶的更新。只輸出一個 JSON object，格式：',
    '{"memory": {"add": [{"content": "...", "category": "..."}], "replace": [{"old": "既有條目片段", "new": "..."}], "remove": ["既有條目片段"]},',
    ' "user": {"add": [...], "replace": [...], "remove": [...]}}',
    '規則：',
    `- memory 放專案脈絡、決定、工作方式、重要事實（上限 ${cfg.memoryMaxChars} 字元）；user 放使用者的身分、偏好、溝通風格（上限 ${cfg.profileMaxChars} 字元）。`,
    '- 只記長期有用、之後對話會再用到的事；不記一次性任務細節、不記工具輸出、不記已在快照裡的內容。',
    '- 每條一到兩句、繁體中文、具體。相近條目用 replace 合併；過時的用 remove。沒有值得更新的就回 {"memory":{},"user":{}}。',
    `- 最多 ${CURATION_MAX_OPS} 筆操作。`,
    '',
    snapshot,
    '',
    '## 最近對話',
    transcript,
  ].join('\n');
}

/**
 * 跑一次 curation：fast 模型提議 → 寫 Approvals（或自動套用）→ 更新 session 的 last_curated_turn（與可選的 embedding）。
 * @param {SessionRow} session
 * @param {{store: Object, cfg: AgentConfig, memoryStore: (Object|undefined), chat: (Function|undefined),
 *   toolConfig: (ToolConfig|undefined), registry: (ToolRegistry|undefined), sink: (Object|undefined), embed: (Function|undefined)}} deps
 * @return {{proposed: number, applied: number, failed: number, auto: boolean, ops: !Array<!Object>, error: string}}
 */
function curateSession_(session, deps) {
  const store = deps.store;
  const cfg = deps.cfg;
  const memoryStore = deps.memoryStore || sheetMemoryStore_();
  const chat = deps.chat || chatFastOrMain_;
  const all = store.loadMessages(session.id, 0);
  const since = Math.max(1, session.turns - session.last_curated_turn);
  const recent = splitForCompaction_(all, since).recent;
  const transcript = (session.summary && since >= session.turns ? '[較早摘要] ' + session.summary + '\n' : '') + transcriptForSummary_(recent);
  const snapshot = buildMemorySnapshot_(memoryStore, cfg);
  const r = chat({ role: 'fast', messages: [{ role: 'user', content: curationPrompt_(snapshot, truncateText_(transcript, 30000).text, cfg) }], maxTokens: 1500, sessionId: session.id });
  const ops = curationOps_(extractJson_(r.text));

  const result = { proposed: ops.length, applied: 0, failed: 0, auto: !!cfg.curationAutoApply, ops: [], error: '' };
  const registry = deps.registry || getToolRegistry_();
  const toolConfig = deps.toolConfig || getToolConfig_();
  const sink = deps.sink || defaultToolSink_();
  ops.forEach((op) => {
    const args = {};
    Object.keys(op).forEach((k) => { if (op[k]) args[k] = op[k]; });
    if (cfg.curationAutoApply) {
      const outcome = executeTool_('memory_manage', args, { sessionId: session.id, approved: true }, { registry, config: toolConfig, sink, memoryStore, agentConfig: cfg });
      if (outcome.ok) result.applied++; else result.failed++;
      result.ops.push({ args, status: outcome.status, content: truncateText_(outcome.content, 200).text });
    } else {
      sink.approval({
        id: newApprovalId_(), job_id: session.id, tool: 'memory_manage', args: JSON.stringify(args),
        reason: `curation 提議（session ${session.id} 第 ${session.turns} 輪）`, state: 'pending', decided_at: '', result: '',
      });
      result.ops.push({ args, status: 'pending_approval' });
    }
  });

  session.last_curated_turn = session.turns;
  if (cfg.sessionEmbeddings) {
    try {
      const embed = deps.embed || ((texts) => embedWithChain_(texts).vectors);
      session.embedding = embed([truncateText_((session.title + '\n' + (session.summary || transcriptForSummary_(recent))), 6000).text])[0] || null;
    } catch (err) {
      console.warn('session embedding 失敗：' + (err && err.message || err));
    }
  }
  store.update(session);
  return result;
}

/**
 * @param {!Object} c curateSession_ 的結果
 * @return {string}
 */
function describeCuration_(c) {
  if (!c) return '';
  if (c.error) return `失敗：${c.error}`;
  if (!c.proposed) return '沒有需要更新的記憶';
  return c.auto ? `自動套用 ${c.applied} 筆${c.failed ? `，${c.failed} 筆失敗` : ''}` : `提議 ${c.proposed} 筆，待你在「紀錄 → 審批」批准`;
}
