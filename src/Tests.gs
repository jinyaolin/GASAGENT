/**
 * @fileoverview Smoke tests。可在編輯器直接執行 runSmokeTests()，或從管理頁 Doctor 分頁按鈕執行。
 *
 * 測試只對已安裝的環境做無副作用（或幂等）的操作：不會新建 spreadsheet、不會改 Properties、不打外部網路。
 * M1 的 adapter / 備援鏈測試是純函式 + 注入的 fetch stub。M7 再擴充（RBAC、checkpoint 續跑）。
 */

/**
 * @typedef {{name: string, ok: boolean, error: string, ms: number}} TestResult
 */

/**
 * 跑全部 smoke tests。
 * @return {{ok: boolean, passed: number, failed: number, ms: number, results: !Array<TestResult>}}
 */
function runSmokeTests() {
  const tests = [
    ['schema: 無重複欄位、tab 清單完整', testSchemaDefinition_],
    ['db: ensureDbSchema_ 幂等（第二次不新增任何 tab / 欄位）', testDbSchemaIdempotent_],
    ['db: 每個 tab 表頭與 DB_SCHEMA 完全一致', testDbHeadersMatch_],
    ['owner: assertOwner 拒絕非 owner', testAssertOwnerRejectsStranger_],
    ['owner: assertOwner 接受 owner（大小寫 / 空白不敏感）', testAssertOwnerAcceptsOwner_],
    ['owner: OWNER_EMAIL 未設定時拒絕所有人', testAssertOwnerRejectsWhenUnset_],
    ['owner: 目前使用者通過 assertOwner()', testAssertOwnerCurrentUser_],
    ['queue: queueTick 無 job 時立即 return', testQueueTickNoop_],
    ['admin: doGet?src=telegram 只回一行文字', testDoGetTelegramPlain_],
    ['doctor: runDoctor 全綠（provider 設定項除外）', testDoctorAllGreen_],
    // M1
    ['providers: validateProvider_ 拒絕不合法 id / protocol / role / base_url / JSON', testProviderValidation_],
    ['providers: 備援鏈只含 enabled 同角色並依 priority 排序', testProviderChainOrder_],
    ['adapter openai: 請求（auth header、tools、tool 訊息、extra_body）', testOpenaiBuildRequest_],
    ['adapter openai: 解析 tool_calls 回應與 usage', testOpenaiParseResponse_],
    ['adapter anthropic: system 另置、tool_use / tool_result 區塊、連續 tool 併成一則', testAnthropicBuildRequest_],
    ['adapter anthropic: 解析 content 區塊與 stop_reason', testAnthropicParseResponse_],
    ['adapter gemini: contents / functionDeclarations / functionCall / functionResponse', testGeminiBuildRequest_],
    ['adapter gemini: 解析 functionCall 與 usageMetadata', testGeminiParseResponse_],
    ['providers: 第一個 provider 5xx 時自動換第二個（fetch stub）', testFallbackChain_],
    ['providers: 400 參數錯不 fallback；key 缺失會 fallback', testFallbackStopsOn4xx_],
    ['providers: 成本估算與 Usage 記錄呼叫', testCostEstimate_],
  ];

  const started = Date.now();
  const results = tests.map(([name, fn]) => {
    const t0 = Date.now();
    try {
      fn();
      return { name, ok: true, error: '', ms: Date.now() - t0 };
    } catch (err) {
      return { name, ok: false, error: String(err && err.stack || err), ms: Date.now() - t0 };
    }
  });
  const failed = results.filter((r) => !r.ok).length;
  const summary = { ok: failed === 0, passed: results.length - failed, failed, ms: Date.now() - started, results };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

// ---- 斷言 helpers -----------------------------------------------------------

/**
 * @param {*} cond
 * @param {string} msg
 */
function assert_(cond, msg) {
  if (!cond) throw new Error('斷言失敗：' + msg);
}

/**
 * @param {*} actual
 * @param {*} expected
 * @param {string} msg
 */
function assertEqual_(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`斷言失敗：${msg}\n  期望 ${e}\n  實際 ${a}`);
}

/**
 * @param {function()} fn
 * @param {string} msg
 * @return {Error} 捕到的錯誤
 */
function assertThrows_(fn, msg) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('斷言失敗：應該要 throw — ' + msg);
}

// ---- 測試 -------------------------------------------------------------------

function testSchemaDefinition_() {
  const expectedTabs = ['Config', 'Providers', 'Sessions', 'Messages', 'Memory', 'UserProfile',
    'Cron', 'Queue', 'Approvals', 'AuditLog', 'Usage'];
  assertEqual_(DB_TABS.slice(), expectedTabs, 'DB_TABS 應與規格資料模型一致');
  DB_TABS.forEach((tab) => {
    const headers = DB_SCHEMA[tab];
    assert_(headers.length > 0, `${tab} 不可沒有欄位`);
    assertEqual_(new Set(headers).size, headers.length, `${tab} 欄位名不可重複`);
  });
}

function testDbSchemaIdempotent_() {
  const ss = getDb_();
  const first = ensureDbSchema_(ss, false);
  const second = ensureDbSchema_(ss, false);
  assertEqual_(first.createdTabs, [], '已安裝環境第一次呼叫不應新建 tab');
  assertEqual_(second.createdTabs, [], '第二次呼叫不應新建 tab');
  assertEqual_(second.addedColumns, {}, '第二次呼叫不應補任何欄位');
  assertEqual_(second.existingTabs.length, DB_TABS.length, '所有 tab 都應已存在');
}

function testDbHeadersMatch_() {
  const problems = inspectDbSchema_(getDb_())
    .filter((t) => !t.exists || t.missingColumns.length)
    .map((t) => `${t.tab}: ${t.exists ? '缺 ' + t.missingColumns.join(',') : '不存在'}`);
  assertEqual_(problems, [], '表頭應完整');
}

function testAssertOwnerRejectsStranger_() {
  const err = assertThrows_(() => assertOwnerEmail_('stranger@example.com', 'owner@example.com'), '非 owner');
  assert_(/拒絕存取/.test(err.message), '錯誤訊息應為拒絕存取，實際：' + err.message);
  // 也要用真實 OWNER_EMAIL 驗一次
  assertThrows_(() => assertOwnerEmail_('stranger@example.com'), '非 owner（真實 OWNER_EMAIL）');
}

function testAssertOwnerAcceptsOwner_() {
  assertOwnerEmail_('Owner@Example.com ', 'owner@example.com');
  assertOwnerEmail_(getOwnerEmail_());
}

function testAssertOwnerRejectsWhenUnset_() {
  const err = assertThrows_(() => assertOwnerEmail_('anyone@example.com', ''), 'OWNER_EMAIL 為空');
  assert_(/尚未安裝/.test(err.message), '錯誤訊息應提示尚未安裝，實際：' + err.message);
}

function testAssertOwnerCurrentUser_() {
  assertOwner();
}

function testQueueTickNoop_() {
  assertEqual_(getProp_(PROP.QUEUE_DIRTY), '', 'M0 不應有 QUEUE_DIRTY 旗標');
  const t0 = Date.now();
  queueTick();
  assert_(Date.now() - t0 < 2000, 'queueTick 無 job 時應在 2 秒內返回');
}

function testDoGetTelegramPlain_() {
  const out = doGet({ parameter: { src: 'telegram' } });
  const content = out.getContent();
  assert_(content.length < 200 && content.indexOf('<script') === -1 && content.indexOf('sidebar') === -1,
    'telegram 路由不可回管理頁 HTML，實際：' + content.slice(0, 80));
}

function testDoctorAllGreen_() {
  const r = runDoctor();
  // provider_* 取決於使用者是否已設定 provider，不算程式問題。
  const fails = r.checks.filter((c) => c.status === 'fail' && c.id.indexOf('provider_') !== 0).map((c) => `${c.label}：${c.detail}`);
  assertEqual_(fails, [], 'Doctor 不應有紅燈');
}

// ---- M1：providers / adapters ------------------------------------------------------

/** @return {!Object} 合法的 provider 輸入（表單形式） */
function fakeProviderInput_(overrides) {
  return Object.assign({
    id: 'test-openai', label: 'Test', protocol: 'openai', base_url: 'https://example.com/v1', model: 'test-model',
    role: 'main', priority: 10, enabled: true, extra_headers: '', max_tokens: 256, extra_body: '',
    cost_in_per_m: 1, cost_out_per_m: 2,
  }, overrides || {});
}

/** @return {!Array<!Object>} 中立格式的一段含工具呼叫的對話 */
function fakeConversation_() {
  return [
    { role: 'system', content: '你是測試助理。' },
    { role: 'user', content: '台北天氣？' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Taipei"}' } },
      { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"temp":25}' },
    { role: 'tool', tool_call_id: 'call_2', content: 'noon' },
    { role: 'assistant', content: '25 度，中午。' },
    { role: 'user', content: '謝謝' },
  ];
}

/** @return {!Array<!Object>} 工具定義 */
function fakeTools_() {
  return [{
    name: 'get_weather', description: 'Get weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
  }];
}

/**
 * @param {number} code
 * @param {*} body
 * @return {{getResponseCode: function(): number, getContentText: function(): string}}
 */
function fakeResponse_(code, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { getResponseCode: () => code, getContentText: () => text };
}

function testProviderValidation_() {
  const ok = validateProvider_(fakeProviderInput_());
  assertEqual_(ok.enabled, true, 'enabled 解析');
  assertEqual_(ok.priority, 10, 'priority 解析');
  assertEqual_(validateProvider_(fakeProviderInput_({ enabled: 'TRUE', priority: '5' })).priority, 5, '字串數字可解析');
  assertThrows_(() => validateProvider_(fakeProviderInput_({ id: 'Bad Id' })), 'id 含空白與大寫');
  assertThrows_(() => validateProvider_(fakeProviderInput_({ protocol: 'cohere' })), '未知 protocol');
  assertThrows_(() => validateProvider_(fakeProviderInput_({ role: 'boss' })), '未知 role');
  assertThrows_(() => validateProvider_(fakeProviderInput_({ base_url: 'http://insecure' })), 'http 不允許');
  assertThrows_(() => validateProvider_(fakeProviderInput_({ model: '' })), 'model 空');
  assertThrows_(() => validateProvider_(fakeProviderInput_({ extra_headers: '{bad json' })), 'extra_headers 非 JSON');
  assertThrows_(() => validateProvider_(fakeProviderInput_({ extra_body: '[1,2]' })), 'extra_body 非 object');
  const parsed = validateProvider_(fakeProviderInput_({ extra_body: '{"thinking":{"type":"disabled"}}' }));
  assertEqual_(parsed.extra_body, { thinking: { type: 'disabled' } }, 'extra_body 解析成 object');
  const row = serializeProvider_(parsed);
  assertEqual_(row.enabled, 'TRUE', 'enabled 序列化');
  assertEqual_(row.extra_body, '{"thinking":{"type":"disabled"}}', 'extra_body 序列化');
  assert_(!('apiKey' in row) && !('key' in row), '序列化不可含 key');
}

function testProviderChainOrder_() {
  const providers = [
    validateProvider_(fakeProviderInput_({ id: 'b', priority: 20 })),
    validateProvider_(fakeProviderInput_({ id: 'a', priority: 10 })),
    validateProvider_(fakeProviderInput_({ id: 'off', priority: 1, enabled: false })),
    validateProvider_(fakeProviderInput_({ id: 'fast1', priority: 1, role: 'fast' })),
    validateProvider_(fakeProviderInput_({ id: 'c', priority: 10 })),
  ];
  assertEqual_(providerChain_('main', providers).map((p) => p.id), ['a', 'c', 'b'], 'main 鏈排序');
  assertEqual_(providerChain_('fast', providers).map((p) => p.id), ['fast1'], 'fast 鏈');
  assertEqual_(providerChain_('embed', providers).map((p) => p.id), [], 'embed 鏈為空');
}

function testOpenaiBuildRequest_() {
  const provider = validateProvider_(fakeProviderInput_({
    base_url: 'https://api.z.ai/api/coding/paas/v4/', extra_headers: '{"X-Title":"GAS Agent"}',
    extra_body: '{"thinking":{"type":"disabled"},"max_tokens":null}',
  }));
  const r = openaiBuildRequest_(provider, { messages: fakeConversation_(), tools: fakeTools_(), temperature: 0.2 }, 'sk-test');
  assertEqual_(r.url, 'https://api.z.ai/api/coding/paas/v4/chat/completions', 'URL 去掉尾斜線後接 /chat/completions');
  assertEqual_(r.headers.Authorization, 'Bearer sk-test', 'Bearer header');
  assertEqual_(r.headers['X-Title'], 'GAS Agent', 'extra_headers 併入');
  assertEqual_(r.body.model, 'test-model', 'model');
  assertEqual_(r.body.temperature, 0.2, 'temperature');
  assert_(!('max_tokens' in r.body), 'extra_body 的 null 應移除 max_tokens');
  assertEqual_(r.body.thinking, { type: 'disabled' }, 'extra_body 併入');
  assertEqual_(r.body.tools, [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: fakeTools_()[0].parameters } }], 'tools 包成 function');
  assertEqual_(r.body.tool_choice, 'auto', 'tool_choice');
  assertEqual_(r.body.messages.length, 7, '訊息數不變');
  assertEqual_(r.body.messages[2], { role: 'assistant', content: null, tool_calls: [
    { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Taipei"}' } },
    { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{}' } },
  ] }, 'assistant tool_calls 原樣');
  assertEqual_(r.body.messages[3], { role: 'tool', content: '{"temp":25}', tool_call_id: 'call_1' }, 'tool 訊息');
  // 沒有 tools 時不可帶 tools / tool_choice（部分相容端點會拒絕空陣列）
  const plain = openaiBuildRequest_(provider, { messages: [{ role: 'user', content: 'hi' }] }, 'k');
  assert_(!('tools' in plain.body) && !('tool_choice' in plain.body), '無工具時不帶 tools');
}

function testOpenaiParseResponse_() {
  const r = openaiParseResponse_({
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Taipei"}' } },
      { id: 'call_y', type: 'function', function: { name: 'broken', arguments: '{not json' } },
    ] } }],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  });
  assertEqual_(r.text, '', '無文字');
  assertEqual_(r.toolCalls, [
    { id: 'call_x', name: 'get_weather', args: { city: 'Taipei' } },
    { id: 'call_y', name: 'broken', args: { _raw: '{not json' } },
  ], 'toolCalls 解析（壞 JSON 保留 _raw）');
  assertEqual_(r.usage, { prompt: 12, completion: 7 }, 'usage');
  assertEqual_(r.stop, 'tool_calls', 'stop');
  const plain = openaiParseResponse_({ choices: [{ finish_reason: 'length', message: { content: 'hello' } }] });
  assertEqual_([plain.text, plain.stop, plain.usage], ['hello', 'length', { prompt: 0, completion: 0 }], '純文字 + 無 usage');
}

function testAnthropicBuildRequest_() {
  const provider = validateProvider_(fakeProviderInput_({ protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1', max_tokens: '' }));
  const r = anthropicBuildRequest_(provider, { messages: fakeConversation_(), tools: fakeTools_() }, 'sk-ant');
  assertEqual_(r.url, 'https://api.anthropic.com/v1/messages', 'base_url 帶 /v1 也不重複');
  assertEqual_(r.headers['x-api-key'], 'sk-ant', 'x-api-key');
  assertEqual_(r.headers['anthropic-version'], ANTHROPIC_VERSION, 'anthropic-version');
  assert_(!r.headers.Authorization, '不可帶 Authorization');
  assertEqual_(r.body.system, '你是測試助理。', 'system 另置');
  assertEqual_(r.body.max_tokens, DEFAULT_MAX_TOKENS, 'max_tokens 必填，用預設');
  assertEqual_(r.body.tools, [{ name: 'get_weather', description: 'Get weather', input_schema: fakeTools_()[0].parameters }], 'tools → input_schema');
  assertEqual_(r.body.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user'], 'user/assistant 交替');
  assertEqual_(r.body.messages[1].content, [
    { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Taipei' } },
    { type: 'tool_use', id: 'call_2', name: 'get_time', input: {} },
  ], 'tool_calls → tool_use 區塊（content 為 null 時無 text 區塊）');
  assertEqual_(r.body.messages[2].content, [
    { type: 'tool_result', tool_use_id: 'call_1', content: '{"temp":25}' },
    { type: 'tool_result', tool_use_id: 'call_2', content: 'noon' },
  ], '兩則 tool 訊息併成一則 user，各自 tool_result');
  assertEqual_(r.body.messages[4].content, [{ type: 'text', text: '謝謝' }], 'user 文字區塊');
}

function testAnthropicParseResponse_() {
  const r = anthropicParseResponse_({
    content: [
      { type: 'text', text: '我查一下。' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Taipei' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 30, output_tokens: 11 },
  });
  assertEqual_(r.text, '我查一下。', 'text 區塊');
  assertEqual_(r.toolCalls, [{ id: 'toolu_1', name: 'get_weather', args: { city: 'Taipei' } }], 'tool_use → toolCalls');
  assertEqual_(r.usage, { prompt: 30, completion: 11 }, 'usage');
  assertEqual_(r.stop, 'tool_calls', 'stop_reason=tool_use');
  assertEqual_(anthropicParseResponse_({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }).stop, 'end', 'end_turn → end');
  assertEqual_(anthropicParseResponse_({ content: [], stop_reason: 'max_tokens' }).stop, 'length', 'max_tokens → length');
}

function testGeminiBuildRequest_() {
  const provider = validateProvider_(fakeProviderInput_({ protocol: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' }));
  const r = geminiBuildRequest_(provider, { messages: fakeConversation_(), tools: fakeTools_(), temperature: 0 }, 'AIza-test');
  assertEqual_(r.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', 'URL');
  assertEqual_(r.headers['x-goog-api-key'], 'AIza-test', 'key 走 header，不進 URL');
  assert_(r.url.indexOf('AIza') === -1, 'URL 不可含 key');
  assertEqual_(r.body.systemInstruction, { parts: [{ text: '你是測試助理。' }] }, 'systemInstruction');
  assertEqual_(r.body.generationConfig, { maxOutputTokens: 256, temperature: 0 }, 'generationConfig（temperature 0 也要帶）');
  assertEqual_(r.body.tools, [{ functionDeclarations: [{
    name: 'get_weather', description: 'Get weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }] }], 'functionDeclarations 並移除 additionalProperties');
  assertEqual_(r.body.contents.map((c) => c.role), ['user', 'model', 'user', 'model', 'user'], 'user/model 交替');
  assertEqual_(r.body.contents[1].parts, [
    { functionCall: { name: 'get_weather', args: { city: 'Taipei' } } },
    { functionCall: { name: 'get_time', args: {} } },
  ], 'tool_calls → functionCall');
  assertEqual_(r.body.contents[2].parts, [
    { functionResponse: { name: 'get_weather', response: { temp: 25 } } },
    { functionResponse: { name: 'get_time', response: { result: 'noon' } } },
  ], 'tool 訊息 → functionResponse，name 由前一則 assistant 的 tool_call_id 反查，非 object 內容包成 {result}');
  assertEqual_(r.body.contents[4].parts, [{ text: '謝謝' }], 'user 文字 part');
}

function testGeminiParseResponse_() {
  const r = geminiParseResponse_({
    candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [
      { text: '查詢中' },
      { functionCall: { name: 'get_weather', args: { city: 'Taipei' } } },
    ] } }],
    usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 9, thoughtsTokenCount: 5 },
  });
  assertEqual_(r.text, '查詢中', 'text');
  assertEqual_(r.toolCalls, [{ id: 'fc_1', name: 'get_weather', args: { city: 'Taipei' } }], 'functionCall → toolCalls（補 id）');
  assertEqual_(r.usage, { prompt: 40, completion: 14 }, 'usage 含 thoughts');
  assertEqual_(r.stop, 'tool_calls', 'STOP 但有 functionCall → tool_calls');
  const plain = geminiParseResponse_({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'a' }, { text: 'b' }] } }] });
  assertEqual_([plain.text, plain.stop], ['ab', 'length'], '多個 text part 串接、MAX_TOKENS → length');
  const blocked = geminiParseResponse_({ promptFeedback: { blockReason: 'SAFETY' } });
  assertEqual_([blocked.text, blocked.stop], ['', 'other'], '被擋時 stop=other');
}

/**
 * 建一個可記錄呼叫的 fetch stub：依序回傳 responses（函式則呼叫、Error 則 throw）。
 * @param {!Array<*>} responses
 * @return {{fetch: Function, calls: !Array<{url: string, options: Object}>}}
 */
function fetchStub_(responses) {
  const calls = [];
  return {
    calls,
    fetch: (url, options) => {
      calls.push({ url, options });
      const next = responses[calls.length - 1];
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(url, options) : next;
    },
  };
}

function testFallbackChain_() {
  const chain = [
    validateProvider_(fakeProviderInput_({ id: 'primary', protocol: 'openai', priority: 1 })),
    validateProvider_(fakeProviderInput_({ id: 'backup', protocol: 'anthropic', base_url: 'https://api.anthropic.com', priority: 2 })),
  ];
  const stub = fetchStub_([
    fakeResponse_(503, { error: { message: 'overloaded' } }),
    fakeResponse_(200, { content: [{ type: 'text', text: 'from backup' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }),
  ]);
  const records = [];
  const r = chatWithChain_(chain, { messages: [{ role: 'user', content: 'hi' }], sessionId: 's1' },
    { fetch: stub.fetch, keyFor: () => 'k', record: (e) => records.push(e) });
  assertEqual_(r.provider, 'backup', '應由第二個 provider 回答');
  assertEqual_(r.text, 'from backup', '回覆文字');
  assertEqual_(r.fallbacks.length, 1, '記錄一次 fallback');
  assertEqual_(r.fallbacks[0].provider, 'primary', 'fallback 來源');
  assertEqual_(r.fallbacks[0].status, 503, 'fallback 狀態碼');
  assert_(/overloaded/.test(r.fallbacks[0].error), 'fallback 錯誤訊息含 API 回的 message');
  assertEqual_(stub.calls.length, 2, '共打兩次');
  assert_(stub.calls[1].url.indexOf('anthropic.com/v1/messages') !== -1, '第二次打 Anthropic');
  assertEqual_(records.map((e) => [e.provider.id, e.ok]), [['primary', false], ['backup', true]], '兩次嘗試都記錄');
  assertEqual_(records[1].sessionId, 's1', 'sessionId 帶進記錄');
}

function testFallbackStopsOn4xx_() {
  const chain = [
    validateProvider_(fakeProviderInput_({ id: 'p1', priority: 1 })),
    validateProvider_(fakeProviderInput_({ id: 'p2', priority: 2 })),
  ];
  // 400：請求本身有問題，不換下一個
  const stub400 = fetchStub_([fakeResponse_(400, { error: { message: 'bad param' } })]);
  const err = assertThrows_(() => chatWithChain_(chain, { messages: [] }, { fetch: stub400.fetch, keyFor: () => 'k', record: () => {} }), '400 應直接丟出');
  assertEqual_(err.status, 400, '保留狀態碼');
  assertEqual_(stub400.calls.length, 1, '400 後不應再打第二個');
  // key 缺失（status 0）：不打網路，直接換下一個
  const stubKey = fetchStub_([fakeResponse_(200, { choices: [{ finish_reason: 'stop', message: { content: 'p2 ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })]);
  const r = chatWithChain_(chain, { messages: [{ role: 'user', content: 'hi' }] },
    { fetch: stubKey.fetch, keyFor: (id) => (id === 'p2' ? 'k2' : ''), record: () => {} });
  assertEqual_(r.provider, 'p2', 'p1 無 key 應換 p2');
  assertEqual_(stubKey.calls.length, 1, 'p1 無 key 不打網路');
  assert_(/API key 未設定/.test(r.fallbacks[0].error), 'fallback 原因為 key 未設定');
  // 全部失敗：錯誤訊息列出每個 provider
  const stubAll = fetchStub_([fakeResponse_(500, 'boom'), new Error('network down')]);
  const errAll = assertThrows_(() => chatWithChain_(chain, { messages: [] }, { fetch: stubAll.fetch, keyFor: () => 'k', record: () => {} }), '全部失敗');
  assert_(/備援鏈全部失敗/.test(errAll.message) && /p1/.test(errAll.message) && /p2/.test(errAll.message) && /network down/.test(errAll.message), '摘要含兩個 provider 與原因，實際：' + errAll.message);
  assertEqual_(errAll.fallbacks.length, 2, '兩次失敗都在 fallbacks');
  // 空鏈
  assertThrows_(() => chatWithChain_([], { messages: [] }, { record: () => {} }), '空鏈應報錯');
}

function testCostEstimate_() {
  const p = validateProvider_(fakeProviderInput_({ cost_in_per_m: 2, cost_out_per_m: 10 }));
  assertEqual_(estimateCost_(p, { prompt: 1000000, completion: 100000 }), 3, '2 + 1 美元');
  assertEqual_(estimateCost_(validateProvider_(fakeProviderInput_({ cost_in_per_m: '', cost_out_per_m: '' })), { prompt: 5000, completion: 5000 }), 0, '沒填單價為 0');
  const stub = fetchStub_([fakeResponse_(200, { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 500000, completion_tokens: 100000 } })]);
  const r = callProvider_(p, { messages: [{ role: 'user', content: 'hi' }] }, { fetch: stub.fetch, keyFor: () => 'k' });
  assertEqual_(r.costEst, 2, 'callProvider_ 帶 costEst（0.5M×2 + 0.1M×10）');
  assertEqual_(r.model, 'test-model', 'callProvider_ 帶 model');
  assert_(typeof r.ms === 'number', 'callProvider_ 帶 ms');
  const payload = JSON.parse(stub.calls[0].options.payload);
  assertEqual_(payload.max_tokens, 256, 'provider 的 max_tokens 帶進請求');
  assertEqual_(stub.calls[0].options.muteHttpExceptions, true, 'muteHttpExceptions 以便讀錯誤 body');
}
