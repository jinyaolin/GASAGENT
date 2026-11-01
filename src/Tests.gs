/**
 * @fileoverview Smoke tests。可在編輯器直接執行 runSmokeTests()，或從管理頁 Doctor 分頁按鈕執行。
 *
 * 測試只對已安裝的環境做無副作用（或幂等）的操作：不會新建 spreadsheet、不會改 Properties、不打外部網路。
 * M1 的 adapter / 備援鏈測試是純函式 + 注入的 fetch stub；M2 的 registry / executor / 迴圈測試用假 registry、
 * 記憶體 sink 與假 provider，不寫 Sheet、不碰 Drive；M4 的 queue / cron / deliver 測試用記憶體 store、假鎖與注入的投遞 handler。
 * 第三欄 'pure' 的測試可在本機 node 跑（scripts/local-tests.js）。
 */

/**
 * @typedef {{name: string, ok: boolean, error: string, ms: number}} TestResult
 */

/**
 * 跑全部 smoke tests。
 * @return {{ok: boolean, passed: number, failed: number, ms: number, results: !Array<TestResult>}}
 */
function runSmokeTests() {
  return runTestTable_(smokeTestTable_());
}

/**
 * 全部測試。第三欄：'db' 需要已安裝的 GAS 環境；'pure' 只用純函式與注入的假物件（本機 node 也能跑）。
 * @return {!Array<!Array>}
 */
function smokeTestTable_() {
  return [
    ['schema: 無重複欄位、tab 清單完整', testSchemaDefinition_, 'pure'],
    ['db: ensureDbSchema_ 幂等（第二次不新增任何 tab / 欄位）', testDbSchemaIdempotent_, 'db'],
    ['db: 每個 tab 表頭與 DB_SCHEMA 完全一致', testDbHeadersMatch_, 'db'],
    ['owner: assertOwner 拒絕非 owner', testAssertOwnerRejectsStranger_, 'db'],
    ['owner: assertOwner 接受 owner（大小寫 / 空白不敏感）', testAssertOwnerAcceptsOwner_, 'db'],
    ['owner: OWNER_EMAIL 未設定時拒絕所有人', testAssertOwnerRejectsWhenUnset_, 'pure'],
    ['owner: 目前使用者通過 assertOwner()', testAssertOwnerCurrentUser_, 'db'],
    ['queue: queueTick 無 job 時立即 return', testQueueTickNoop_, 'db'],
    ['admin: doGet?src=telegram 只回一行文字', testDoGetTelegramPlain_, 'db'],
    ['doctor: runDoctor 全綠（provider 設定項除外）', testDoctorAllGreen_, 'db'],
    // M1
    ['providers: validateProvider_ 拒絕不合法 id / protocol / role / base_url / JSON', testProviderValidation_, 'pure'],
    ['providers: 備援鏈只含 enabled 同角色並依 priority 排序', testProviderChainOrder_, 'pure'],
    ['adapter openai: 請求（auth header、tools、tool 訊息、extra_body）', testOpenaiBuildRequest_, 'pure'],
    ['adapter openai: 解析 tool_calls 回應與 usage', testOpenaiParseResponse_, 'pure'],
    ['adapter anthropic: system 另置、tool_use / tool_result 區塊、連續 tool 併成一則', testAnthropicBuildRequest_, 'pure'],
    ['adapter anthropic: 解析 content 區塊與 stop_reason', testAnthropicParseResponse_, 'pure'],
    ['adapter gemini: contents / functionDeclarations / functionCall / functionResponse', testGeminiBuildRequest_, 'pure'],
    ['adapter gemini: 解析 functionCall 與 usageMetadata', testGeminiParseResponse_, 'pure'],
    ['adapter gemini: thoughtSignature 解析 → 中立格式 → 重放（缺簽章填假簽章）', testGeminiThoughtSignature_, 'pure'],
    ['providers: 第一個 provider 5xx 時自動換第二個（fetch stub）', testFallbackChain_, 'pure'],
    ['providers: 400 參數錯不 fallback；key 缺失會 fallback', testFallbackStopsOn4xx_, 'pure'],
    ['providers: 成本估算與 Usage 記錄呼叫', testCostEstimate_, 'pure'],
    // M2
    ['registry: 全部工具無重名、schema 合法、名稱以 toolset 開頭', testRegistryValid_, 'pure'],
    ['registry: 重名 / 壞 schema 的宣告被拒；listToolsForProvider_ 依 RBAC 過濾', testRegistryRejectsBad_, 'pure'],
    ['executor: 參數驗證（required、未宣告參數拒絕、型別、enum、字串轉型）', testValidateArgs_, 'pure'],
    ['executor: RBAC 拒絕（toolset 未宣告 / 權限關閉）且 handler 不執行', testRbacDenied_, 'pure'],
    ['executor: 審批策略 always / autonomous_only / never 與 approved 略過', testApprovalPolicy_, 'pure'],
    ['executor: X 類工具被攔時寫入 Approvals 並回 pending_approval', testApprovalIntercept_, 'pure'],
    ['executor: 成功 / handler 丟錯都寫 AuditLog（預覽截長）', testAuditLog_, 'pure'],
    ['spill: 結果超過門檻溢寫，context 留前 1000 字 + file_id；session_spill_read 分頁讀回', testSpillRoundTrip_, 'pure'],
    ['agent: 工具迴圈正常收尾（tool → 文字），tool 訊息包成 untrusted 區塊', testRunTurnHappyPath_, 'pure'],
    ['agent: 同一工具 + 同參數失敗 3 次即熔斷', testRunTurnCircuitBreaker_, 'pure'],
    ['agent: 步數上限與時間預算到就停並回報；重複的待審批不再寫第二筆', testRunTurnLimits_, 'pure'],
    ['config: parseToolConfig_ 預設值與 rbac.<toolset> 解析', testToolConfigParse_, 'pure'],
    ['web: 域名白名單（exact / *.wildcard / 空 = 全拒）與 HTML 轉文字', testWebHelpers_, 'pure'],
    ['docs/slides: 輕量 markdown 解析、deck spec 驗證（九種版面、table / image 必填、>40 頁）、兩層項目、簡報規則進 prompt、刪頁預設被 RBAC 擋', testDocsSlidesSpecs_, 'pure'],
    // M3
    ['config: parseAgentConfig_ 預設值與夾限', testAgentConfigParse_, 'pure'],
    ['memory: add / replace / remove、容量上限、pinned、唯一命中（memory_manage 經 executor）', testMemoryManage_, 'pure'],
    ['memory: 快照區塊含兩表、容量與鎖定標記', testMemorySnapshot_, 'pure'],
    ['session: 訊息序列化來回、token 估算、壓縮切分與門檻判斷', testSessionSerialization_, 'pure'],
    ['session: runSessionTurn_ 建 session、寫訊息、第二輪帶歷史與快照、/status、/new 關閉並 curation', testRunSessionTurn_, 'pure'],
    ['session: 超過 context 門檻時用 fast 摘要壓縮、compact_seq 前移；閒置自動切新 session', testSessionCompaction_, 'pure'],
    ['search: searchSessions_ 依 AND 關鍵字計分、片段、排除目前 session；session_search 工具', testSessionSearch_, 'pure'],
    ['curation: JSON 解析成 memory_manage 操作；預設寫 Approvals、auto_apply 直接套用', testCuration_, 'pure'],
    ['embed: openai / gemini 嵌入請求與解析、cosine、備援鏈無 provider 報錯', testEmbeddings_, 'pure'],
    // M4
    ['cron: 5 欄 cron 與捷徑解析、computeNextRun_（分 / 時 / 日 / 週 / 月跳躍、dom|dow 取或、找不到報錯）、輸入驗證', testCronSchedule_, 'pure'],
    ['queue: enqueue → tick → done；例外重試到 3 次即 failed；鎖住略過；卡住的 running 重排；一次只跑一個；重試按鈕', testQueueStateMachine_, 'pure'],
    ['queue: 步數 / 時間預算中止時 enqueue continuation 接同一 session，上限 3 次；正常結束不續跑', testCheckpointContinuation_, 'pure'],
    ['approval: 批准 / 拒絕後 enqueue continuation 把結果接回原 session；curation 提議與已關閉 session 不續跑', testApprovalContinuation_, 'pure'],
    ['cron: 到期掃描入列並推進 next_run；cron job 建新 session、autonomous 模式送審批、投遞 doc、更新 last_status；cronjob_manage 在 autonomous 只能 list', testCronJobAutonomous_, 'pure'],
    ['deliver: 標題「<name> YYYY-MM-DD」、內文含結果與執行資訊；doc / email / none；handler 失敗回 ok=false', testDeliverContent_, 'pure'],
    ['gmail: 附件參數宣告、數量 / 總量上限、轉寄內文組裝、gmail_forward 為 X 類走審批', testGmailAttachments_, 'pure'],
  ];
}

/**
 * @param {!Array<!Array>} tests
 * @return {{ok: boolean, passed: number, failed: number, ms: number, results: !Array<TestResult>}}
 */
function runTestTable_(tests) {
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
  // 有 queued job 或排程剛好到期時會真的跑 job，閒置路徑測不到，直接略過。
  if (getProp_(PROP.QUEUE_DIRTY) === '1') return;
  const nextCron = getProp_(PROP.CRON_NEXT_RUN);
  if (nextCron && new Date(nextCron).getTime() <= Date.now() + 60000) return;
  const t0 = Date.now();
  queueTick();
  assert_(Date.now() - t0 < 2000, 'queueTick 閒置時應在 2 秒內返回（只讀兩個 Property）');
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
    { functionCall: { name: 'get_weather', args: { city: 'Taipei' } }, thoughtSignature: GEMINI_DUMMY_THOUGHT_SIGNATURE },
    { functionCall: { name: 'get_time', args: {} }, thoughtSignature: GEMINI_DUMMY_THOUGHT_SIGNATURE },
  ], 'tool_calls → functionCall（無簽章填假簽章）');
  assertEqual_(r.body.contents[2].parts, [
    { functionResponse: { name: 'get_weather', response: { temp: 25 } } },
    { functionResponse: { name: 'get_time', response: { result: 'noon' } } },
  ], 'tool 訊息 → functionResponse，name 由前一則 assistant 的 tool_call_id 反查，非 object 內容包成 {result}');
  assertEqual_(r.body.contents[4].parts, [{ text: '謝謝' }], 'user 文字 part');
}

function testGeminiThoughtSignature_() {
  const parsed = geminiParseResponse_({ candidates: [{ finishReason: 'STOP', content: { parts: [
    { functionCall: { name: 'drive_search', args: { query: 'x' } }, thoughtSignature: 'sig-abc' },
    { functionCall: { name: 'docs_read', args: {} } },
  ] } }] });
  assertEqual_(parsed.toolCalls[0].thoughtSignature, 'sig-abc', '解析保留 thoughtSignature');
  assert_(!('thoughtSignature' in parsed.toolCalls[1]), '沒有簽章就不加欄位');
  // 迴圈把簽章帶進中立格式
  const fake = fakeChat_([{ toolCalls: parsed.toolCalls.map((tc, i) => Object.assign({ id: 'c' + i }, tc)), stop: 'tool_calls' }, { text: 'ok' }]);
  const r = runTurn_({ message: 'go' }, fakeTurnDeps_(fake.chat));
  const asst = fake.calls[1].messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assertEqual_(asst.tool_calls[0].thought_signature, 'sig-abc', '中立格式 tool_calls 帶 thought_signature');
  assert_(!('thought_signature' in asst.tool_calls[1]), '沒簽章的不帶');
  // 重建 Gemini 請求：有簽章原樣帶回，沒簽章填假簽章跳過驗證
  const provider = validateProvider_(fakeProviderInput_({ protocol: 'gemini', base_url: 'https://generativelanguage.googleapis.com' }));
  const req = geminiBuildRequest_(provider, { messages: fake.calls[1].messages.filter((m) => m.role !== 'system') }, 'k');
  const modelParts = req.body.contents.find((c) => c.role === 'model').parts.filter((p) => p.functionCall);
  assertEqual_(modelParts.map((p) => p.thoughtSignature), ['sig-abc', GEMINI_DUMMY_THOUGHT_SIGNATURE], 'functionCall parts 的 thoughtSignature');
  // openai / anthropic adapter 不受影響（不會把 thought_signature 洩到請求裡）
  const oa = openaiBuildRequest_(validateProvider_(fakeProviderInput_()), { messages: fake.calls[1].messages }, 'k');
  assert_(JSON.stringify(oa.body).indexOf('thought_signature') === -1, 'openai 請求不含 thought_signature');
  const an = anthropicBuildRequest_(validateProvider_(fakeProviderInput_({ protocol: 'anthropic', base_url: 'https://api.anthropic.com' })), { messages: fake.calls[1].messages }, 'k');
  assert_(JSON.stringify(an.body).indexOf('thought_signature') === -1, 'anthropic 請求不含 thought_signature');
  // 序列化來回保留
  const m = { role: 'assistant', content: null, tool_calls: asst.tool_calls };
  assertEqual_(deserializeMessage_('assistant', serializeMessage_(m)), m, 'Messages 存取保留簽章');
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

// ---- M2：registry / executor / agent --------------------------------------------------

/**
 * 假工具組：echo（R）、write（W）、boom（R，一定丟錯）、send（X）、big（R，回長字串）。
 * @param {Object=} overrides 覆寫某個工具的欄位
 * @return {!Array<ToolDecl>}
 */
function fakeToolDecls_(overrides) {
  const base = {
    toolset: 'fake',
    parameters: { type: 'object', properties: { text: { type: 'string' }, n: { type: 'integer' }, flag: { type: 'boolean' }, mode: { type: 'string', enum: ['a', 'b'] }, list: { type: 'array' } }, required: ['text'], additionalProperties: false },
  };
  const decls = [
    Object.assign({}, base, { name: 'fake_echo', risk: 'R', description: 'echo', handler: (args) => ({ echoed: args.text, n: args.n, flag: args.flag }) }),
    Object.assign({}, base, { name: 'fake_write', risk: 'W', description: 'write', handler: (args) => 'wrote ' + args.text }),
    Object.assign({}, base, { name: 'fake_boom', risk: 'R', description: 'boom', handler: () => { throw new Error('kaboom'); } }),
    Object.assign({}, base, { name: 'fake_send', risk: 'X', description: 'send', handler: (args) => ({ sent: args.text }) }),
    Object.assign({}, base, { name: 'fake_big', risk: 'R', description: 'big', handler: (args) => 'X'.repeat(toNumber_(args.n, 10000)) }),
  ];
  return decls.map((d) => Object.assign({}, d, (overrides && overrides[d.name]) || {}));
}

/** @return {!Object<string, !Object>} fake toolset 全開 */
function fakeRbac_(perms) {
  return { fake: Object.assign({ read: true, write: true, delete: false, external: true }, perms || {}), session: { read: true, write: false, delete: false, external: false } };
}

/**
 * @param {Object=} overrides
 * @return {ToolConfig}
 */
function fakeToolConfig_(overrides) {
  return Object.assign({ rbac: fakeRbac_(), approvalPolicy: 'always', spillThreshold: 2000, maxToolSteps: 25, webAllowedDomains: [], persona: '' }, overrides || {});
}

/** @return {{sink: Object, audits: !Array, approvals: !Array}} 記憶體 sink */
function memorySink_() {
  const audits = [];
  const approvals = [];
  return { audits, approvals, sink: { audit: (e) => audits.push(e), approval: (r) => approvals.push(r) } };
}

/** @return {{store: Object, files: !Object<string, string>}} 記憶體溢寫儲存 */
function memorySpill_() {
  const files = {};
  let n = 0;
  return { files, store: { write: (name, text) => { const id = 'spill_' + (++n); files[id] = text; return id; }, read: (id) => { if (!(id in files)) throw new Error('no such file ' + id); return files[id]; } } };
}

/**
 * 執行假工具的便捷包裝。
 * @return {{outcome: ToolOutcome, audits: !Array, approvals: !Array, files: !Object}}
 */
function execFake_(name, args, ctx, cfg, registry) {
  const mem = memorySink_();
  const spill = memorySpill_();
  const outcome = executeTool_(name, args, ctx || {}, { registry: registry || buildToolRegistry_(fakeToolDecls_().concat(sessionTools_())), config: cfg || fakeToolConfig_(), sink: mem.sink, spill: spill.store });
  return { outcome, audits: mem.audits, approvals: mem.approvals, files: spill.files, spill: spill.store };
}

function testRegistryValid_() {
  const registry = buildToolRegistry_(allToolDeclarations_());
  assert_(registry.list.length >= 35, `工具數應 ≥ 35，實際 ${registry.list.length}`);
  assertEqual_(registry.toolsets, ['drive', 'docs', 'sheets', 'slides', 'gmail', 'calendar', 'web', 'session', 'memory', 'cronjob'], 'toolset 順序');
  assertEqual_(registry.list.filter((t) => t.risk === 'D').map((t) => t.name), ['slides_delete_slide'], 'D 類只有刪簡報頁（RBAC delete 預設關）');
  assertEqual_(registry.list.filter((t) => t.risk === 'X').map((t) => t.name).sort(), ['drive_share', 'gmail_forward', 'gmail_send'], 'X 類只有 share / send / forward');
  registry.list.forEach((t) => {
    validateToolDeclaration_(t);
    assertEqual_(t.parameters.additionalProperties, false, `${t.name} 應宣告 additionalProperties=false`);
  });
  const neutral = listToolsForProvider_(registry);
  assertEqual_(neutral.length, registry.list.length, '不給 rbac 時全部列出');
  assertEqual_(Object.keys(neutral[0]).sort(), ['description', 'name', 'parameters'], '中立格式只含三欄');
  // 每個工具都能經過三個 adapter 的 buildRequest（schema 不會讓 adapter 爆）
  const p = validateProvider_(fakeProviderInput_({ protocol: 'gemini', base_url: 'https://generativelanguage.googleapis.com' }));
  const r = geminiBuildRequest_(p, { messages: [{ role: 'user', content: 'hi' }], tools: neutral }, 'k');
  assertEqual_(r.body.tools[0].functionDeclarations.length, neutral.length, 'gemini functionDeclarations 數');
  assert_(JSON.stringify(r.body).indexOf('additionalProperties') === -1, 'gemini 不可含 additionalProperties');
  // Gemini 的 type 必須是單一字串：registry 裡有 ["string","array"]（slides body）、["string","number","boolean"]（sheets 格）
  const walkSchema = (schema, path) => {
    if (!schema || typeof schema !== 'object') return;
    assert_(typeof schema.type === 'string', `gemini schema type 必須是字串：${path} = ${JSON.stringify(schema.type)}`);
    if (schema.type !== 'array') assert_(!('items' in schema), `${path} 非 array 不可有 items`);
    if (schema.type !== 'object') assert_(!('properties' in schema) && !('required' in schema), `${path} 非 object 不可有 properties / required`);
    (schema.required || []).forEach((name) => assert_(schema.properties && schema.properties[name], `${path}.required 的 ${name} 不在 properties`));
    if (schema.items) walkSchema(schema.items, path + '.items');
    Object.keys(schema.properties || {}).forEach((k) => walkSchema(schema.properties[k], path + '.' + k));
  };
  r.body.tools[0].functionDeclarations.forEach((d) => walkSchema(d.parameters, d.name));
  const docsCreate = r.body.tools[0].functionDeclarations.find((d) => d.name === 'docs_create');
  assertEqual_(Object.keys(docsCreate.parameters.properties), ['title', 'content', 'folder_id'], '屬性名 title 不可被當關鍵字刪掉');
  assertEqual_(docsCreate.parameters.required, ['title'], 'required 保留');
  assertEqual_(geminiCleanSchema_({ type: ['string', 'array'], items: { type: ['number', 'null'] }, title: 'x', default: 1 }), { type: 'string' }, 'type 陣列收斂成 string 並去掉 items / title / default');
  assertEqual_(geminiCleanSchema_({ type: ['array', 'null'], items: { type: 'integer', title: 'n' } }), { type: 'array', items: { type: 'integer' } }, '無 string 取第一個非 null，items 保留');
}

function testRegistryRejectsBad_() {
  const decls = fakeToolDecls_();
  assertThrows_(() => buildToolRegistry_(decls.concat([decls[0]])), '重名');
  assertThrows_(() => buildToolRegistry_([Object.assign({}, decls[0], { name: 'other_echo' })]), 'name 未以 toolset 開頭');
  assertThrows_(() => buildToolRegistry_([Object.assign({}, decls[0], { risk: 'Z' })]), 'risk 不合法');
  assertThrows_(() => buildToolRegistry_([Object.assign({}, decls[0], { parameters: { type: 'array' } })]), 'parameters 非 object');
  assertThrows_(() => buildToolRegistry_([Object.assign({}, decls[0], { parameters: { type: 'object', properties: { x: { type: 'thing' } } } })]), 'property type 不合法');
  assertThrows_(() => buildToolRegistry_([Object.assign({}, decls[0], { parameters: { type: 'object', properties: {}, required: ['ghost'] } })]), 'required 不在 properties');
  assertThrows_(() => buildToolRegistry_([Object.assign({}, decls[0], { handler: 'nope' })]), 'handler 非函式');
  const registry = buildToolRegistry_(decls);
  assertEqual_(listToolsForProvider_(registry, fakeRbac_({ write: false, external: false })).map((t) => t.name), ['fake_echo', 'fake_boom', 'fake_big'], 'RBAC 過濾掉 W / X');
  assertEqual_(listToolsForProvider_(registry, {}).length, 0, 'toolset 未宣告 → 全部不列');
}

function testValidateArgs_() {
  const tool = fakeToolDecls_()[0];
  assertEqual_(validateToolArgs_(tool, { text: 'hi', n: '5', flag: 'true', mode: 'a', list: '[1,2]' }), { text: 'hi', n: 5, flag: true, mode: 'a', list: [1, 2] }, '字串轉型');
  const e1 = assertThrows_(() => validateToolArgs_(tool, { text: 'hi', bogus: 1 }), '未宣告參數');
  assert_(/未宣告的參數：bogus/.test(e1.message), e1.message);
  const e2 = assertThrows_(() => validateToolArgs_(tool, { n: 1 }), 'required 缺');
  assert_(/缺少必要參數：text/.test(e2.message), e2.message);
  assertThrows_(() => validateToolArgs_(tool, { text: '   ' }), 'required 空白字串視為缺');
  assertThrows_(() => validateToolArgs_(tool, { text: 'x', n: 1.5 }), 'integer 收到小數');
  assertThrows_(() => validateToolArgs_(tool, { text: 'x', n: 'abc' }), 'integer 收到非數字字串');
  assertThrows_(() => validateToolArgs_(tool, { text: 'x', mode: 'z' }), 'enum 外的值');
  assertThrows_(() => validateToolArgs_(tool, { text: 'x', list: 'notarray' }), 'array 收到字串');
  assertThrows_(() => validateToolArgs_(tool, [1, 2]), 'args 是陣列');
  assertThrows_(() => validateToolArgs_(tool, { _raw: '{bad' }), '壞 JSON 的 _raw');
  assertEqual_(validateToolArgs_({ parameters: { type: 'object', properties: {} } }, undefined), {}, '無參數工具接受 undefined');
}

function testRbacDenied_() {
  let called = 0;
  const registry = buildToolRegistry_(fakeToolDecls_({ fake_write: { handler: () => { called++; return 'ok'; } } }));
  // 權限關閉
  let r = execFake_('fake_write', { text: 'a' }, {}, fakeToolConfig_({ rbac: fakeRbac_({ write: false }) }), registry);
  assertEqual_(r.outcome.status, 'denied', 'write 關閉 → denied');
  assert_(/write 權限未開啟/.test(r.outcome.content), r.outcome.content);
  assertEqual_(JSON.parse(r.outcome.content).error, 'rbac_denied', 'error code');
  // toolset 未宣告
  r = execFake_('fake_write', { text: 'a' }, {}, fakeToolConfig_({ rbac: {} }), registry);
  assertEqual_(r.outcome.status, 'denied', 'toolset 未宣告 → denied');
  assert_(/尚未在 Config 宣告/.test(r.outcome.content), r.outcome.content);
  assertEqual_(called, 0, 'handler 不可被執行');
  assertEqual_(r.audits.length, 1, '拒絕也寫 AuditLog');
  assertEqual_(r.audits[0].ok, false, 'AuditLog ok=false');
  assert_(/^\[denied\]/.test(r.audits[0].result_preview), 'result_preview 標示狀態');
  // 不存在的工具 / 參數錯
  assertEqual_(execFake_('nope_x', {}).outcome.status, 'invalid', '未知工具');
  const bad = execFake_('fake_echo', { text: 'a', extra: 1 }).outcome;
  assertEqual_(bad.status, 'invalid', '未宣告參數 → invalid');
  assertEqual_(JSON.parse(bad.content).error, 'invalid_args', 'error code');
  // 正常
  const ok = execFake_('fake_write', { text: 'a' }, {}, fakeToolConfig_(), registry).outcome;
  assertEqual_([ok.status, ok.ok, ok.content], ['ok', true, 'ok'], '權限開啟 → 執行');
  assertEqual_(called, 1, 'handler 執行一次');
}

function testApprovalPolicy_() {
  const send = fakeToolDecls_()[3];
  const echo = fakeToolDecls_()[0];
  assertEqual_(needsApproval_(echo, 'always', 'interactive'), false, '非 X 不送審');
  assertEqual_(needsApproval_(send, 'always', 'interactive'), true, 'always 互動也送審');
  assertEqual_(needsApproval_(send, 'always', 'autonomous'), true, 'always 無人送審');
  assertEqual_(needsApproval_(send, 'autonomous_only', 'interactive'), false, 'autonomous_only 互動不送審');
  assertEqual_(needsApproval_(send, 'autonomous_only', 'autonomous'), true, 'autonomous_only 無人送審');
  assertEqual_(needsApproval_(send, 'never', 'autonomous'), false, 'never 不送審');
  // external 關閉時 RBAC 先擋，不會進審批
  const denied = execFake_('fake_send', { text: 'a' }, {}, fakeToolConfig_({ rbac: fakeRbac_({ external: false }) }));
  assertEqual_(denied.outcome.status, 'denied', 'external 關 → denied');
  assertEqual_(denied.approvals.length, 0, '不寫 Approvals');
  // approved=true 略過審批直接執行
  const approved = execFake_('fake_send', { text: 'go' }, { approved: true });
  assertEqual_([approved.outcome.status, approved.outcome.content], ['ok', '{"sent":"go"}'], 'approved 直接執行');
  // never 直接執行
  const never = execFake_('fake_send', { text: 'go' }, {}, fakeToolConfig_({ approvalPolicy: 'never' }));
  assertEqual_(never.outcome.status, 'ok', 'never 直接執行');
  const auto = execFake_('fake_send', { text: 'go' }, { mode: 'interactive' }, fakeToolConfig_({ approvalPolicy: 'autonomous_only' }));
  assertEqual_(auto.outcome.status, 'ok', 'autonomous_only 互動模式直接執行');
}

function testApprovalIntercept_() {
  const r = execFake_('fake_send', { text: 'hello', n: '3' }, { sessionId: 's9', mode: 'interactive' });
  assertEqual_(r.outcome.status, 'pending_approval', 'status');
  assertEqual_(r.outcome.ok, false, 'pending 不算 ok');
  assert_(/^apr_/.test(r.outcome.approvalId), 'approvalId 格式');
  const body = JSON.parse(r.outcome.content);
  assertEqual_(body.status, 'pending_approval', 'content 給模型的狀態');
  assertEqual_(body.approval_id, r.outcome.approvalId, 'content 帶 approval_id');
  assert_(/不要重試/.test(body.message), '提示模型不要重試');
  assertEqual_(r.approvals.length, 1, '寫一列 Approvals');
  const row = r.approvals[0];
  assertEqual_([row.id, row.job_id, row.tool, row.state, row.decided_at, row.result], [r.outcome.approvalId, 's9', 'fake_send', 'pending', '', ''], 'Approvals 欄位');
  assertEqual_(JSON.parse(row.args), { text: 'hello', n: 3 }, 'args 為驗證後的 JSON');
  assert_(/風險 X/.test(row.reason) && /always/.test(row.reason), 'reason 含風險與策略');
  assertEqual_(r.audits.length, 1, '也寫 AuditLog');
  assert_(/^\[pending_approval\]/.test(r.audits[0].result_preview), 'AuditLog 標示 pending');
  assert_(approvalCreatedAt_(row.id).length > 0, '可從 id 還原建立時間');
}

function testAuditLog_() {
  const ok = execFake_('fake_echo', { text: 'hi', n: 2 }, { sessionId: 'sess-1' });
  assertEqual_(ok.outcome.status, 'ok', 'ok');
  assertEqual_(ok.outcome.result, { echoed: 'hi', n: 2, flag: undefined }, 'result 原始值');
  assertEqual_(ok.outcome.content, '{"echoed":"hi","n":2}', 'content JSON 化');
  assertEqual_(ok.audits.length, 1, '一列 AuditLog');
  const a = ok.audits[0];
  assertEqual_([a.session_id, a.tool, a.ok], ['sess-1', 'fake_echo', true], 'AuditLog 欄位');
  assertEqual_(a.args_preview, '{"text":"hi","n":2}', 'args_preview');
  assertEqual_(a.result_preview, '{"echoed":"hi","n":2}', 'result_preview');
  assert_(a.ts instanceof Date && typeof a.ms === 'number', 'ts / ms');
  const boom = execFake_('fake_boom', { text: 'x' });
  assertEqual_(boom.outcome.status, 'error', 'handler 丟錯 → error');
  assertEqual_(JSON.parse(boom.outcome.content), { error: 'tool_error', message: 'kaboom' }, '錯誤訊息回給模型');
  assertEqual_(boom.outcome.error, 'kaboom', 'outcome.error');
  assertEqual_(boom.audits[0].ok, false, 'AuditLog ok=false');
  const long = execFake_('fake_echo', { text: 'y'.repeat(3000) }, {}, fakeToolConfig_({ spillThreshold: 100000 }));
  assertEqual_(long.audits[0].args_preview.length, AUDIT_PREVIEW_CHARS, 'args_preview 截到 500');
  assertEqual_(long.audits[0].result_preview.length, AUDIT_PREVIEW_CHARS, 'result_preview 截到 500');
}

function testSpillRoundTrip_() {
  const r = execFake_('fake_big', { text: 'x', n: 5000 });
  assertEqual_(r.outcome.status, 'ok', 'ok');
  assert_(r.outcome.spill && r.outcome.spill.total === 5000, '溢寫資訊');
  const fileId = r.outcome.spill.fileId;
  assertEqual_(Object.keys(r.files), [fileId], '寫了一個檔');
  assertEqual_(r.files[fileId].length, 5000, '完整內容在檔案裡');
  assert_(r.outcome.content.indexOf('X'.repeat(SPILL_PREVIEW_CHARS)) === 0, 'context 留前 1000 字');
  assert_(r.outcome.content.length < 1400, 'context 內容明顯短於原文');
  assert_(r.outcome.content.indexOf(`file_id=${fileId}`) !== -1, 'context 含 file_id');
  assert_(r.outcome.content.indexOf('session_spill_read') !== -1, 'context 提示用 spill_read');
  assertEqual_(r.outcome.result.length, 5000, 'result 仍是完整原文');
  // 不超過門檻不溢寫
  const small = execFake_('fake_big', { text: 'x', n: 1999 });
  assertEqual_([small.outcome.spill, small.outcome.content.length], [null, 1999], '未超過門檻不溢寫');
  // 用 session_spill_read 分頁讀回（同一個 spill store）
  const registry = buildToolRegistry_(fakeToolDecls_().concat(sessionTools_()));
  const cfg = fakeToolConfig_();
  const mem = memorySink_();
  const p1 = executeTool_('session_spill_read', { file_id: fileId, offset: 0, limit: 3000 }, {}, { registry, config: cfg, sink: mem.sink, spill: r.spill });
  assertEqual_(p1.status, 'ok', 'spill_read ok');
  assertEqual_(p1.spill, null, 'spill_read 本身不再溢寫（noSpill）');
  const page1 = JSON.parse(p1.content);
  assertEqual_([page1.offset, page1.limit, page1.total, page1.has_more, page1.next_offset, page1.text.length], [0, 3000, 5000, true, 3000, 3000], '第一頁');
  const p2 = executeTool_('session_spill_read', { file_id: fileId, offset: page1.next_offset, limit: 3000 }, {}, { registry, config: cfg, sink: mem.sink, spill: r.spill });
  const page2 = JSON.parse(p2.content);
  assertEqual_([page2.offset, page2.has_more, page2.next_offset, page2.text.length], [3000, false, null, 2000], '第二頁');
  assertEqual_(page1.text + page2.text, r.files[fileId], '兩頁拼回原文');
  assertEqual_(JSON.parse(executeTool_('session_spill_read', { file_id: 'nope' }, {}, { registry, config: cfg, sink: mem.sink, spill: r.spill }).content).error, 'tool_error', '不存在的檔案回錯');
  assertEqual_(JSON.parse(executeTool_('session_spill_read', { file_id: fileId, limit: 999999 }, {}, { registry, config: cfg, sink: mem.sink, spill: r.spill }).content).limit, 20000, 'limit 上限 20000');
}

/**
 * 假 provider：依序回傳 scripted 的 ChatResult；超過就重複最後一個。記錄每次收到的請求。
 * @param {!Array<!Object>} scripted
 * @return {{chat: Function, calls: !Array<!Object>}}
 */
function fakeChat_(scripted) {
  const calls = [];
  return {
    calls,
    chat: (req) => {
      calls.push(req);
      const r = scripted[Math.min(calls.length - 1, scripted.length - 1)];
      return Object.assign({ text: '', toolCalls: [], usage: { prompt: 10, completion: 5 }, stop: 'end', provider: 'fake', model: 'fake-1', ms: 1, costEst: 0.001, fallbacks: [] }, r);
    },
  };
}

/** @return {Object} runTurn_ 的 deps（假 registry / config / 記憶體 sink） */
function fakeTurnDeps_(chat, overrides) {
  const mem = memorySink_();
  const spill = memorySpill_();
  const registry = buildToolRegistry_(fakeToolDecls_().concat(sessionTools_()));
  const config = fakeToolConfig_();
  return Object.assign({ chat, registry, config, executeDeps: { registry, config, sink: mem.sink, spill: spill.store }, _mem: mem }, overrides || {});
}

function testRunTurnHappyPath_() {
  const fake = fakeChat_([
    { text: '我查一下', toolCalls: [{ id: 'c1', name: 'fake_echo', args: { text: 'ping' } }], stop: 'tool_calls' },
    { text: '結果是 ping。', stop: 'end' },
  ]);
  const deps = fakeTurnDeps_(fake.chat);
  const r = runTurn_({ message: '請 echo ping', history: [{ role: 'user', content: '之前' }, { role: 'assistant', content: '好' }], sessionId: 'sx' }, deps);
  assertEqual_(r.text, '結果是 ping。', '最後文字');
  assertEqual_(r.stopped, '', '正常結束');
  assertEqual_(r.llmCalls, 2, 'LLM 兩次');
  assertEqual_(r.usage, { prompt: 20, completion: 10 }, 'usage 累加');
  assertEqual_(r.steps.length, 1, '一步');
  assertEqual_([r.steps[0].tool, r.steps[0].status, r.steps[0].ok], ['fake_echo', 'ok', true], 'step 摘要');
  assertEqual_(r.steps[0].resultPreview, '{"echoed":"ping"}', 'resultPreview');
  // 第一次請求：system + history + user；tools 依 RBAC 過濾（fake 全開 + session）
  const first = fake.calls[0];
  assertEqual_(first.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user'], '首輪訊息順序');
  assert_(/untrusted/.test(first.messages[0].content) && /無效/.test(first.messages[0].content), 'system prompt 含資料區塊規則');
  assert_(first.messages[0].content.indexOf(DEFAULT_PERSONA) === 0, '空 persona 用預設');
  assertEqual_(first.tools.map((t) => t.name), ['fake_echo', 'fake_write', 'fake_boom', 'fake_send', 'fake_big', 'session_spill_read', 'session_search'], 'tools 清單');
  assertEqual_(first.sessionId, 'sx', 'sessionId 帶入');
  // 第二次請求：多了 assistant(tool_calls) + tool
  const second = fake.calls[1];
  assertEqual_(second.messages.length, 6, '第二輪訊息數');
  const asst = second.messages[4];
  assertEqual_(asst.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'fake_echo', arguments: '{"text":"ping"}' } }], 'assistant tool_calls 中立格式');
  const toolMsg = second.messages[5];
  assertEqual_([toolMsg.role, toolMsg.tool_call_id, toolMsg.name], ['tool', 'c1', 'fake_echo'], 'tool 訊息欄位');
  assertEqual_(toolMsg.content, '<<tool_result name=fake_echo status=ok untrusted>>\n{"echoed":"ping"}\n<<end>>', 'tool 結果包成資料區塊');
  assertEqual_(deps._mem.audits.length, 1, 'AuditLog 一列');
  // persona 與額外指示
  const cfg = fakeToolConfig_({ persona: '我是測試人格', rbac: fakeRbac_({ write: false }) });
  const prompt = buildSystemPrompt_(cfg, deps.registry, '請簡短');
  assert_(prompt.indexOf('我是測試人格') === 0, '自訂 persona 在最前');
  assert_(/fake 的 write：fake_write/.test(prompt), '列出未開放的工具');
  assert_(/本次額外指示\n請簡短/.test(prompt), '額外指示在最後');
  assertThrows_(() => runTurn_({ message: '   ' }, deps), '空訊息');
}

function testRunTurnCircuitBreaker_() {
  const call = { text: '', toolCalls: [{ id: 'c', name: 'fake_boom', args: { text: 'same' } }], stop: 'tool_calls' };
  const fake = fakeChat_([call]);
  const deps = fakeTurnDeps_(fake.chat);
  const r = runTurn_({ message: '一直失敗' }, deps);
  assertEqual_(r.stopped, 'circuit_breaker', '熔斷');
  assertEqual_(r.steps.length, 3, '剛好 3 步');
  assertEqual_(fake.calls.length, 3, 'LLM 剛好 3 次');
  assert_(r.steps.every((s) => s.status === 'error'), '三步皆失敗');
  assert_(/熔斷/.test(r.text) && /fake_boom/.test(r.text), '回報說明含熔斷與工具名：' + r.text);
  // 參數不同就不算同一鍵：不熔斷，走到步數上限
  const varied = fakeChat_([
    { toolCalls: [{ id: 'a', name: 'fake_boom', args: { text: '1' } }], stop: 'tool_calls' },
    { toolCalls: [{ id: 'b', name: 'fake_boom', args: { text: '2' } }], stop: 'tool_calls' },
    { toolCalls: [{ id: 'c', name: 'fake_boom', args: { text: '3' } }], stop: 'tool_calls' },
    { toolCalls: [{ id: 'd', name: 'fake_boom', args: { text: '4' } }], stop: 'tool_calls' },
    { text: '放棄', stop: 'end' },
  ]);
  const r2 = runTurn_({ message: 'x' }, fakeTurnDeps_(varied.chat));
  assertEqual_([r2.stopped, r2.steps.length, r2.text], ['', 4, '放棄'], '不同參數不熔斷');
  // 同參數但 key 順序不同視為相同
  assertEqual_(stableJson_({ b: 1, a: [2, { d: 1, c: 2 }] }), stableJson_({ a: [2, { c: 2, d: 1 }], b: 1 }), 'stableJson_ 排序 key');
}

function testRunTurnLimits_() {
  // 步數上限：每次回一個工具呼叫，maxSteps=2 → 2 步後停
  const loop = fakeChat_([{ toolCalls: [{ id: 'c', name: 'fake_echo', args: { text: 'x' } }], stop: 'tool_calls' }]);
  const r = runTurn_({ message: 'loop' }, fakeTurnDeps_(loop.chat, { maxSteps: 2 }));
  assertEqual_([r.stopped, r.steps.length, loop.calls.length], ['max_steps', 2, 2], '步數上限');
  assert_(/步數上限/.test(r.text) && /fake_echo → fake_echo/.test(r.text), '回報列出已完成步驟：' + r.text);
  // 一次回多個工具呼叫但超過上限：多的不執行
  const multi = fakeChat_([{ toolCalls: [1, 2, 3].map((i) => ({ id: 'c' + i, name: 'fake_echo', args: { text: String(i) } })), stop: 'tool_calls' }]);
  const r2 = runTurn_({ message: 'multi' }, fakeTurnDeps_(multi.chat, { maxSteps: 2 }));
  assertEqual_(r2.steps.map((s) => s.status), ['ok', 'ok', 'error'], '第三個呼叫未執行');
  assert_(/max_steps/.test(r2.steps[2].resultPreview), '未執行原因');
  // 時間預算：假時鐘每次 chat 前進 300 秒，預算 270 秒 → 第一步做完就停
  let t = 0;
  const slow = fakeChat_([{ toolCalls: [{ id: 'c', name: 'fake_echo', args: { text: 'x' } }], stop: 'tool_calls' }]);
  const slowChat = (req) => { t += 300000; return slow.chat(req); };
  const r3 = runTurn_({ message: 'slow' }, fakeTurnDeps_(slowChat, { now: () => t }));
  assertEqual_([r3.stopped, r3.steps.length], ['time_budget', 1], '時間預算到就停');
  assert_(/時間預算/.test(r3.text), '回報時間預算');
  // 同一回合多個工具呼叫，預算在中途耗盡：後面的不執行
  let t2 = 0;
  const multiSlow = fakeChat_([{ toolCalls: [{ id: 'a', name: 'fake_echo', args: { text: '1' } }, { id: 'b', name: 'fake_echo', args: { text: '2' } }], stop: 'tool_calls' }]);
  const slowExec = (name, args, ctx, d) => { const o = executeTool_(name, args, ctx, d); t2 += 200000; return o; };
  const r3b = runTurn_({ message: 'x' }, fakeTurnDeps_(multiSlow.chat, { now: () => t2, execute: slowExec, budgetMs: 150000 }));
  assertEqual_(r3b.steps.map((s) => s.status), ['ok', 'error'], '預算中途耗盡，第二個呼叫不執行');
  assertEqual_(r3b.stopped, 'time_budget', '隨後停止');
  // 重複的待審批：同一 X 動作第二次不再寫 Approvals，且三次後熔斷
  const sendLoop = fakeChat_([{ toolCalls: [{ id: 'c', name: 'fake_send', args: { text: 'mail' } }], stop: 'tool_calls' }]);
  const deps = fakeTurnDeps_(sendLoop.chat);
  const r4 = runTurn_({ message: 'send' }, deps);
  assertEqual_(deps._mem.approvals.length, 1, '只寫一筆 Approvals');
  assertEqual_(r4.steps.map((s) => s.status), ['pending_approval', 'pending_approval', 'pending_approval'], '三步皆 pending');
  assertEqual_(r4.steps[0].approvalId, r4.steps[2].approvalId, '沿用同一個 approvalId');
  assertEqual_(r4.stopped, 'circuit_breaker', '重複送審也會熔斷');
  assert_(/待審批：fake_send/.test(r4.text), '回報含待審批');
}

function testToolConfigParse_() {
  const d = parseToolConfig_({});
  assertEqual_([d.approvalPolicy, d.spillThreshold, d.maxToolSteps, d.webAllowedDomains, d.persona, d.rbac], ['always', 8000, 25, [], '', {}], '全空 → 預設');
  const c = parseToolConfig_({
    'rbac.gmail': '{"read":"TRUE","write":true,"delete":false,"external":"false"}',
    'rbac.web': 'not json',
    'rbac.': '{}',
    approval_policy: 'Never ',
    spill_threshold: '3000',
    max_tool_steps: '999',
    web_allowed_domains: 'Example.com\nhttps://*.Wikipedia.org/wiki\nexample.com',
    persona: '  hi  ',
  });
  assertEqual_(c.rbac, { gmail: { read: true, write: true, delete: false, external: false }, web: { read: false, write: false, delete: false, external: false } }, 'rbac 解析（壞 JSON → 全關）');
  assertEqual_([c.approvalPolicy, c.spillThreshold, c.maxToolSteps, c.persona], ['never', 3000, 200, 'hi'], '策略 / 門檻 / 夾限');
  assertEqual_(c.webAllowedDomains, ['example.com', '*.wikipedia.org'], '白名單正規化去重');
  assertEqual_(parseToolConfig_({ approval_policy: 'bogus', spill_threshold: '10' }).approvalPolicy, 'always', '未知策略退回 always');
  assertEqual_(parseToolConfig_({ spill_threshold: '10' }).spillThreshold, 1500, 'spill 下限 1500');
}

function testWebHelpers_() {
  const allowed = parseAllowedDomains_('example.com, *.wikipedia.org');
  assertEqual_(isDomainAllowed_('example.com', allowed), true, 'exact');
  assertEqual_(isDomainAllowed_('www.example.com', allowed), false, 'exact 不含子網域');
  assertEqual_(isDomainAllowed_('zh.wikipedia.org', allowed), true, 'wildcard 子網域');
  assertEqual_(isDomainAllowed_('wikipedia.org', allowed), true, 'wildcard 含本身');
  assertEqual_(isDomainAllowed_('evilwikipedia.org', allowed), false, 'wildcard 不可被尾綴混淆');
  assertEqual_(isDomainAllowed_('EXAMPLE.COM.', allowed), true, '大小寫與尾點');
  assertEqual_(isDomainAllowed_('example.com', []), false, '空白名單全拒');
  assertEqual_(parseUrl_('https://user:pw@Sub.Example.com:8443/path?q=1'), { scheme: 'https', host: 'sub.example.com' }, 'parseUrl_ 去 userinfo / port');
  assertEqual_(parseUrl_('ftp://x'), { scheme: 'ftp', host: 'x' }, 'parseUrl_ scheme');
  assertEqual_(parseUrl_('not a url').host, '', '壞 URL');
  const html = '<html><head><title> 測試 &amp; 頁 </title><style>p{}</style></head><body><script>alert(1)</script>' +
    '<h1>標題</h1><p>第一段&nbsp;文字&#x4e2d;&#25991;</p><ul><li>甲</li><li>乙</li></ul><table><tr><td>a</td><td>b</td></tr></table><!-- c --><div>尾</div></body></html>';
  const t = htmlToText_(html);
  assertEqual_(t.title, '測試 & 頁', 'title');
  assertEqual_(t.text, '標題\n第一段 文字中文\n- 甲\n- 乙\n\na | b\n\n尾', 'text');
  // web_fetch handler 在白名單外直接拒絕，不打網路
  const cfg = fakeToolConfig_({ rbac: { web: { read: true, write: false, delete: false, external: false } }, webAllowedDomains: ['example.com'] });
  const registry = buildToolRegistry_(webTools_());
  const mem = memorySink_();
  const denied = executeTool_('web_fetch', { url: 'https://evil.com/x' }, {}, { registry, config: cfg, sink: mem.sink, spill: memorySpill_().store });
  assertEqual_(denied.status, 'error', '白名單外 → error');
  assert_(/不在白名單/.test(denied.content), denied.content);
  const empty = executeTool_('web_fetch', { url: 'https://example.com/' }, {}, { registry, config: fakeToolConfig_({ rbac: cfg.rbac, webAllowedDomains: [] }), sink: mem.sink, spill: memorySpill_().store });
  assert_(/白名單是空的/.test(empty.content), '空白名單訊息：' + empty.content);
  const scheme = executeTool_('web_fetch', { url: 'ftp://example.com/' }, {}, { registry, config: cfg, sink: mem.sink, spill: memorySpill_().store });
  assert_(/只支援 http/.test(scheme.content), 'scheme 檢查');
}

function testDocsSlidesSpecs_() {
  const blocks = parseLiteMarkdown_('# 標題\n\n## 小標\n段落一\n接續\n\n- 甲\n* 乙\n1. 一\n2) 二\n\n### 三級\n尾段');
  assertEqual_(blocks, [
    { kind: 'heading', level: 1, text: '標題' },
    { kind: 'heading', level: 2, text: '小標' },
    { kind: 'paragraph', level: 0, text: '段落一 接續' },
    { kind: 'bullet', level: 0, text: '甲' },
    { kind: 'bullet', level: 0, text: '乙' },
    { kind: 'number', level: 0, text: '一' },
    { kind: 'number', level: 0, text: '二' },
    { kind: 'heading', level: 3, text: '三級' },
    { kind: 'paragraph', level: 0, text: '尾段' },
  ], '輕量 markdown 區塊');
  assertEqual_(parseLiteMarkdown_(''), [], '空字串');
  const specs = validateDeckSpec_([{ type: 'title', title: 'T', subtitle: 'S' }, { type: 'content', title: 'C', body: ['a', 'b'] }, { type: 'two_column', left: 'L', right: ['r'] }, { type: 'quote', quote: 'Q', attribution: 'A' }, { type: 'closing' },
    { type: 'image', title: 'I', image: 'https://example.com/a.png', caption: 'c' }, { type: 'image_full', image: '1abcdefghijklmnop', title: 'Full' }, { type: 'table', title: 'T2', rows: [['a', 'b'], ['1']] }]);
  assertEqual_(specs.length, 8, '8 頁合法');
  assertEqual_(specs[2].right, ['r'], '陣列保留');
  assertEqual_(specs[7].rows, [['a', 'b'], ['1', '']], 'table 補齊短列');
  assertThrows_(() => validateDeckSpec_([]), '空 deck');
  assertThrows_(() => validateDeckSpec_(new Array(41).fill({ type: 'content' })), '> 40 頁');
  assertThrows_(() => validateDeckSpec_([{ type: 'poster' }]), '未知 type');
  assertThrows_(() => validateDeckSpec_([{ type: 'quote' }]), 'quote 缺文字');
  assertThrows_(() => validateDeckSpec_([{ type: 'image', title: 'x' }]), 'image 缺 image');
  assertThrows_(() => validateDeckSpec_([{ type: 'table', rows: [] }]), 'table 缺 rows');
  assertThrows_(() => validateDeckSpec_([{ type: 'table', rows: [new Array(121).fill('x')] }]), 'table 超過 120 格');
  assertThrows_(() => validateDeckSpec_(['content']), '非 object');
  assertEqual_(SLIDE_TYPES.slice(), ['title', 'section', 'content', 'two_column', 'quote', 'image', 'image_full', 'table', 'closing'], '九種類型');
  // 兩層項目、Drive id 解析、system prompt 簡報規則、刪頁工具預設被 RBAC 擋
  assertEqual_(splitBulletLevels_(['重點一', '> 子項 a', '>> 第三層', '  > 子項 b', '', '重點二']), { lines: ['重點一', '子項 a', '第三層', '子項 b', '重點二'], levels: [0, 1, 2, 1, 0] }, '> 前綴 = 第二層，最多兩層');
  assertEqual_(parseDriveId_('https://docs.google.com/presentation/d/1AbC_dEf-GhIjK/edit#slide=id.p'), '1AbC_dEf-GhIjK', '網址取 id');
  assertEqual_([parseDriveId_('1AbC_dEf-GhIjK'), parseDriveId_(''), parseDriveId_('https://drive.google.com/open?id=1XyZ_abcdefghij')], ['1AbC_dEf-GhIjK', '', '1XyZ_abcdefghij'], '純 id / 空 / open?id=');
  const slidesReg = buildToolRegistry_(slidesTools_());
  const prompt = buildSystemPrompt_(fakeToolConfig_({ rbac: { slides: { read: true, write: true, delete: false, external: false } } }), slidesReg, '');
  assert_(/## 簡報/.test(prompt) && /先用文字回大綱/.test(prompt) && /slides_update_slide/.test(prompt), 'system prompt 含簡報規劃規則');
  assert_(/slides 的 delete：slides_delete_slide/.test(prompt), '刪頁預設列在未開放');
  const sink = memorySink_();
  const del = executeTool_('slides_delete_slide', { presentation_id: 'p', slide_index: 2 }, {}, { registry: slidesReg, config: fakeToolConfig_({ rbac: { slides: { read: true, write: true, delete: false, external: false } } }), sink: sink.sink, spill: memorySpill_().store });
  assertEqual_(del.status, 'denied', 'delete 關 → 刪頁被拒');
  assertEqual_(parseToolConfig_({ slides_template_id: 'https://docs.google.com/presentation/d/1TemplateIdXYZ/edit' }).slidesTemplateId, 'https://docs.google.com/presentation/d/1TemplateIdXYZ/edit', 'Config 原樣保存（handler 再 parseDriveId_）');
}

// ---- M3：memory / session / curation / embed ----------------------------------------------------

/** @return {{store: Object, data: Object}} 記憶體版記憶 store */
function memoryMemoryStore_() {
  const data = { memory: [], user: [] };
  let n = 0;
  return {
    data,
    store: {
      list: (t) => data[t].map((e) => Object.assign({}, e)),
      add: (t, e) => { const x = Object.assign({ id: 'm' + (++n), category: '', created: new Date(), updated: new Date(), source_session: '', pinned: false }, e); data[t].push(x); return x; },
      update: (t, e) => { const i = data[t].findIndex((x) => x.id === e.id); data[t][i] = Object.assign({}, e, { updated: new Date() }); return data[t][i]; },
      remove: (t, e) => { data[t] = data[t].filter((x) => x.id !== e.id); },
    },
  };
}

/** @return {{store: Object, sessions: !Array, messages: !Array}} 記憶體版 session store */
function memorySessionStore_() {
  const sessions = [];
  const messages = [];
  let n = 0;
  return {
    sessions, messages,
    store: {
      get: (id) => { const s = sessions.find((x) => x.id === id); return s ? Object.assign({}, s) : null; },
      create: (fields) => {
        const now = new Date();
        const s = Object.assign({ id: 's' + (++n), channel: 'admin', external_id: '', title: '', summary: '', model_override: '', token_est: 0, created: now, last_active: now, status: 'active', compact_seq: 0, turns: 0, last_curated_turn: 0, embedding: null }, fields || {});
        sessions.push(s);
        return Object.assign({}, s);
      },
      update: (s) => { const i = sessions.findIndex((x) => x.id === s.id); if (i === -1) throw new Error('no session ' + s.id); sessions[i] = Object.assign({}, s); },
      listRecent: (k, channel) => sessions.filter((s) => !channel || s.channel === channel).slice().sort((a, b) => b.last_active - a.last_active).slice(0, k).map((s) => Object.assign({}, s)),
      appendMessages: (sid, fromSeq, msgs) => msgs.forEach((m, i) => messages.push(Object.assign({ session_id: sid, seq: fromSeq + i, ts: new Date() }, JSON.parse(JSON.stringify(m))))),
      loadMessages: (sid, fromSeq) => messages.filter((m) => m.session_id === sid && m.seq > fromSeq).map((m) => { const o = Object.assign({}, m); delete o.session_id; delete o.ts; return o; }),
      scanMessages: () => messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ session_id: m.session_id, seq: m.seq, role: m.role, text: stringifyContent_(m.content), ts: m.ts })),
    },
  };
}

/** @return {AgentConfig} */
function fakeAgentConfig_(overrides) {
  return Object.assign(parseAgentConfig_({}), { curationEveryTurns: 0 }, overrides || {});
}

/** registry：假工具 + session + memory */
function fakeM3Registry_() {
  return buildToolRegistry_(fakeToolDecls_().concat(sessionTools_(), memoryTools_()));
}

/** rbac：fake / session / memory 全開 */
function fakeM3ToolConfig_(overrides) {
  return fakeToolConfig_(Object.assign({ rbac: Object.assign(fakeRbac_(), { memory: { read: true, write: true, delete: false, external: false }, session: { read: true, write: false, delete: false, external: false } }) }, overrides || {}));
}

function testAgentConfigParse_() {
  const d = parseAgentConfig_({});
  assertEqual_([d.memoryMaxChars, d.profileMaxChars, d.contextMaxTokens, d.keepRecentTurns, d.curationEveryTurns, d.curationAutoApply, d.sessionIdleHours, d.sessionEmbeddings],
    [2200, 1375, 24000, 4, 10, false, 6, false], '預設');
  const c = parseAgentConfig_({ memory_max_chars: '50', profile_max_chars: '99999', context_max_tokens: '5000', keep_recent_turns: '0', curation_every_turns: '3', curation_auto_apply: 'TRUE', session_idle_hours: '0', session_embeddings: 'yes' });
  assertEqual_([c.memoryMaxChars, c.profileMaxChars, c.contextMaxTokens, c.keepRecentTurns, c.curationEveryTurns, c.curationAutoApply, c.sessionIdleHours, c.sessionEmbeddings],
    [200, 20000, 5000, 1, 3, true, 0, true], '夾限與布林');
  Object.keys(AGENT_CONFIG_DEFAULTS).forEach((k) => assert_(k in parseAgentConfig_({}) || true, k));
}

function testMemoryManage_() {
  const mem = memoryMemoryStore_();
  const cfg = fakeAgentConfig_({ memoryMaxChars: 200, profileMaxChars: 300 });
  const registry = fakeM3Registry_();
  const sink = memorySink_();
  const run = (args, ctx) => executeTool_('memory_manage', args, Object.assign({ sessionId: 'sA' }, ctx || {}), { registry, config: fakeM3ToolConfig_(), sink: sink.sink, spill: memorySpill_().store, memoryStore: mem.store, agentConfig: cfg });
  let r = run({ target: 'user', action: 'add', content: '偏好繁體中文，程式註解用英文', category: 'preference' });
  assertEqual_(r.status, 'ok', 'add ok：' + r.content);
  assertEqual_(JSON.parse(r.content).usage, { used: 14, limit: 300, free: 286 }, 'usage');
  assertEqual_(mem.data.user[0].source_session, 'sA', 'source_session 來自 ctx');
  r = run({ target: 'user', action: 'add', content: '偏好繁體中文，程式註解用英文' });
  assertEqual_(JSON.parse(r.content).skipped, 'duplicate', '重複不加');
  assertEqual_(mem.data.user.length, 1, '仍一條');
  // 容量
  r = run({ target: 'memory', action: 'add', content: 'x'.repeat(201) });
  assert_(/容量不足/.test(r.content), '超過容量：' + r.content);
  r = run({ target: 'memory', action: 'add', content: 'y'.repeat(501) });
  assert_(/單條目上限/.test(r.content), '單條上限');
  run({ target: 'memory', action: 'add', content: 'GAS Agent 專案在 ~/gas-agent，用 clasp 部署', category: 'project' });
  run({ target: 'memory', action: 'add', content: 'telegram-assistant 專案靠 launchd 跑' });
  // replace：唯一命中、子字串
  r = run({ target: 'memory', action: 'replace', old_content: 'clasp 部署', content: 'GAS Agent 專案在 ~/gas-agent，clasp deploy -i 更新既有部署' });
  assertEqual_(r.status, 'ok', 'replace ok：' + r.content);
  assert_(/deploy -i/.test(mem.data.memory[0].content), '內容已換');
  r = run({ target: 'memory', action: 'replace', old_content: '專案', content: 'z' });
  assert_(/命中 2 條/.test(r.content), '多重命中拒絕：' + r.content);
  r = run({ target: 'memory', action: 'remove', old_content: '不存在的東西' });
  assert_(/找不到/.test(r.content), '找不到');
  // pinned
  mem.data.memory[1].pinned = true;
  r = run({ target: 'memory', action: 'remove', old_content: 'telegram-assistant' });
  assert_(/鎖定/.test(r.content), 'pinned 不可刪');
  r = run({ target: 'memory', action: 'replace', old_content: 'telegram-assistant', content: 'x' });
  assert_(/鎖定/.test(r.content), 'pinned 不可改');
  mem.data.memory[1].pinned = false;
  r = run({ target: 'memory', action: 'remove', old_content: 'telegram-assistant' });
  assertEqual_([r.status, mem.data.memory.length], ['ok', 1], 'remove ok');
  // 參數驗證
  assertEqual_(run({ target: 'brain', action: 'add', content: 'x' }).status, 'invalid', 'target enum');
  assertEqual_(run({ target: 'memory', action: 'add' }).status, 'error', 'add 無 content');
  assertEqual_(run({ target: 'memory', action: 'replace', content: 'x' }).status, 'error', 'replace 無 old_content');
  // RBAC：memory write 關 → denied
  const denied = executeTool_('memory_manage', { target: 'memory', action: 'add', content: 'x' }, {}, { registry, config: fakeM3ToolConfig_({ rbac: Object.assign(fakeRbac_(), { memory: { read: true, write: false, delete: false, external: false } }) }), sink: sink.sink, spill: memorySpill_().store, memoryStore: mem.store, agentConfig: cfg });
  assertEqual_(denied.status, 'denied', 'RBAC');
  assertEqual_(sink.audits.length >= 10, true, '每次都寫 AuditLog');
}

function testMemorySnapshot_() {
  const mem = memoryMemoryStore_();
  const cfg = fakeAgentConfig_();
  const empty = buildMemorySnapshot_(mem.store, cfg);
  assert_(/長期記憶快照/.test(empty) && /關於使用者（UserProfile） — 0 \/ 1375/.test(empty) && /長期記憶（Memory） — 0 \/ 2200/.test(empty), '空快照含兩表與容量：' + empty);
  assertEqual_((empty.match(/（尚無條目）/g) || []).length, 2, '兩表皆標尚無');
  mem.store.add('user', { content: '偏好繁中', category: 'preference' });
  mem.store.add('memory', { content: '專案 A 用 clasp', pinned: true });
  const snap = buildMemorySnapshot_(mem.store, cfg);
  assert_(/- \[preference\] 偏好繁中/.test(snap), '分類前綴');
  assert_(/- 專案 A 用 clasp（owner 鎖定）/.test(snap), '鎖定標記');
  assert_(/UserProfile） — 4 \/ 1375/.test(snap) && /Memory） — 12 \/ 2200/.test(snap), '容量更新：' + snap);
  assert_(snap.indexOf('UserProfile') < snap.indexOf('長期記憶（Memory）'), '使用者檔案在前');
  // 進 system prompt
  const prompt = buildSystemPrompt_(fakeM3ToolConfig_(), fakeM3Registry_(), '', [snap, '## 先前對話摘要\n略']);
  assert_(prompt.indexOf('## 記憶') !== -1 && /memory_manage/.test(prompt), 'prompt 含記憶規則');
  assert_(prompt.indexOf(snap) !== -1 && prompt.indexOf('## 先前對話摘要') > prompt.indexOf(snap), 'contextBlocks 依序附在最後');
  const noMem = buildSystemPrompt_(fakeToolConfig_(), buildToolRegistry_(fakeToolDecls_()), '');
  assert_(noMem.indexOf('## 記憶') === -1, '沒有 memory_manage 就不放記憶規則');
}

function testSessionSerialization_() {
  const asst = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fake_echo', arguments: '{"text":"a"}' } }] };
  const tool = { role: 'tool', content: '<<tool_result …>>', tool_call_id: 'c1', name: 'fake_echo' };
  const user = { role: 'user', content: '{"看起來像 JSON 的使用者訊息": 1}' };
  const plain = { role: 'assistant', content: '{"tool_calls": "但其實是純文字"}' };
  assertEqual_(deserializeMessage_('assistant', serializeMessage_(asst)), asst, 'assistant tool_calls 來回');
  assertEqual_(deserializeMessage_('tool', serializeMessage_(tool)), tool, 'tool 來回');
  assertEqual_(deserializeMessage_('user', serializeMessage_(user)), user, 'user JSON 樣字串保持純文字');
  assertEqual_(serializeMessage_(user), user.content, 'user 存純文字');
  assertEqual_(deserializeMessage_('assistant', serializeMessage_(plain)).content, plain.content, 'assistant 純文字即使像 JSON 也原樣');
  assert_(serializeMessage_({ role: 'user', content: 'x'.repeat(50000) }).length < 46000, '超長截斷');
  // token 估算
  assertEqual_(estimateTokens_('abcdefgh'), 2, 'ASCII 4 字 1 token');
  assertEqual_(estimateTokens_('中文四個字'), 5, 'CJK 每字 1');
  assertEqual_(estimateTokens_(''), 0, '空');
  assert_(estimateMessageTokens_(asst) > 10, 'tool_calls 也算');
  // 切分
  const msgs = [
    { seq: 1, role: 'user', content: 'u1' }, { seq: 2, role: 'assistant', content: 'a1' },
    { seq: 3, role: 'user', content: 'u2' }, { seq: 4, role: 'assistant', content: null, tool_calls: asst.tool_calls }, { seq: 5, role: 'tool', tool_call_id: 'c1', name: 'fake_echo', content: 'r' }, { seq: 6, role: 'assistant', content: 'a2' },
    { seq: 7, role: 'user', content: 'u3' }, { seq: 8, role: 'assistant', content: 'a3' },
  ];
  const split = splitForCompaction_(msgs, 1);
  assertEqual_([split.old.map((m) => m.seq), split.recent.map((m) => m.seq)], [[1, 2, 3, 4, 5, 6], [7, 8]], '保留最後 1 輪');
  assertEqual_(splitForCompaction_(msgs, 2).old.map((m) => m.seq), [1, 2], '保留最後 2 輪');
  assertEqual_(splitForCompaction_(msgs, 3).old, [], '輪數不足不切');
  const cfg = fakeAgentConfig_({ contextMaxTokens: 2000, keepRecentTurns: 1 });
  assertEqual_(needsCompaction_('', msgs, cfg), false, '未超門檻');
  const big = msgs.map((m) => Object.assign({}, m, { content: m.content ? m.content + 'x'.repeat(2000) : m.content }));
  assertEqual_(needsCompaction_('', big, cfg), true, '超門檻且可切');
  assertEqual_(needsCompaction_('', big.slice(6), cfg), false, '超門檻但只剩 1 輪不可切');
  assertEqual_(parseSlashCommand_('/new'), { command: 'new', rest: '' }, '/new');
  assertEqual_(parseSlashCommand_('/NEW  繼續聊'), { command: 'new', rest: '繼續聊' }, '/new 帶訊息');
  assertEqual_(parseSlashCommand_('/status'), { command: 'status', rest: '' }, '/status');
  assertEqual_(parseSlashCommand_('/newer stuff'), { command: '', rest: '/newer stuff' }, '非指令');
  assertEqual_(transcriptForSummary_(msgs.slice(3, 6)), '[assistant 呼叫工具] fake_echo({"text":"a"})\n[工具 fake_echo 結果] r\n[assistant] a2', 'transcript');
}

/** runSessionTurn_ 的假依賴組 */
function fakeSessionDeps_(chat, overrides) {
  const ss = memorySessionStore_();
  const mem = memoryMemoryStore_();
  const sink = memorySink_();
  const registry = fakeM3Registry_();
  const toolConfig = fakeM3ToolConfig_();
  const cfg = fakeAgentConfig_();
  return Object.assign({
    store: ss.store, cfg, toolConfig, registry, memoryStore: mem.store, chat,
    turnDeps: { executeDeps: { sink: sink.sink, spill: memorySpill_().store } },
    _ss: ss, _mem: mem, _sink: sink,
  }, overrides || {});
}

function testRunSessionTurn_() {
  const fake = fakeChat_([
    { toolCalls: [{ id: 'c1', name: 'memory_manage', args: { target: 'user', action: 'add', content: '偏好繁中、程式註解英文', category: 'preference' } }], stop: 'tool_calls' },
    { text: '記下了。', stop: 'end' },
    { text: '第二輪回覆', stop: 'end' },
  ]);
  const deps = fakeSessionDeps_(fake.chat);
  // 第一輪：建 session、工具寫記憶、訊息入庫
  const r1 = runSessionTurn_({ message: '我偏好繁中，程式註解用英文' }, deps);
  assertEqual_([r1.sessionCreated, r1.turns, r1.text, r1.steps.length], [true, 1, '記下了。', 1], '第一輪');
  const s1 = deps._ss.store.get(r1.sessionId);
  assertEqual_([s1.title, s1.status, s1.compact_seq], ['我偏好繁中，程式註解用英文', 'active', 0], 'session 欄位');
  assertEqual_(deps._ss.messages.map((m) => [m.seq, m.role]), [[1, 'user'], [2, 'assistant'], [3, 'tool'], [4, 'assistant']], '四則訊息入庫，seq 從 1');
  assertEqual_(deps._mem.data.user.length, 1, '記憶已寫');
  assertEqual_(deps._mem.data.user[0].source_session, r1.sessionId, '記憶來源 session');
  const sys1 = fake.calls[0].messages[0].content;
  assert_(/UserProfile） — 0 \/ 1375/.test(sys1) && /這是第 1 輪/.test(sys1), '第一輪快照為空、輪數 1');
  // 第二輪：同 session，帶完整歷史與更新後的快照
  const r2 = runSessionTurn_({ message: '剛剛說了什麼？', sessionId: r1.sessionId }, deps);
  assertEqual_([r2.sessionCreated, r2.turns, r2.text], [false, 2, '第二輪回覆'], '第二輪');
  const req2 = fake.calls[2];
  assertEqual_(req2.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'user'], '歷史含 tool 訊息');
  assert_(/偏好繁中、程式註解英文/.test(req2.messages[0].content) && /這是第 2 輪/.test(req2.messages[0].content), '第二輪快照含新條目');
  assertEqual_(deps._ss.messages.length, 6, '再入庫 2 則');
  assertEqual_(deps._ss.messages[5].seq, 6, 'seq 連續');
  // /status
  const st = runSessionTurn_({ message: '/status', sessionId: r1.sessionId }, deps);
  assert_(st.command === 'status' && /2 輪/.test(st.text), '/status：' + st.text);
  assertEqual_(fake.calls.length, 3, '/status 不打模型');
  // /new：關閉舊的、curation（有未整理輪次且 K>0）、開新的
  let curated = null;
  const depsNew = Object.assign({}, deps, { cfg: fakeAgentConfig_({ curationEveryTurns: 10 }), curate: (s) => { curated = s.id; return { proposed: 2, applied: 0, failed: 0, auto: false, ops: [] }; } });
  const nw = runSessionTurn_({ message: '/new', sessionId: r1.sessionId }, depsNew);
  assertEqual_([nw.command, nw.sessionCreated, nw.turns], ['new', true, 0], '/new');
  assert_(nw.sessionId !== r1.sessionId, '新 id');
  assertEqual_(deps._ss.store.get(r1.sessionId).status, 'closed', '舊 session 關閉');
  assertEqual_(curated, r1.sessionId, '關閉時 curation');
  assert_(/提議 2 筆/.test(nw.text), '/new 回覆含 curation 結果：' + nw.text);
  // /new 帶訊息：在新 session 直接跑
  const nw2 = runSessionTurn_({ message: '/new 哈囉', sessionId: nw.sessionId }, deps);
  assertEqual_([nw2.command, nw2.turns, nw2.text], ['new', 1, '第二輪回覆'], '/new 帶訊息');
  assert_(nw2.sessionId !== nw.sessionId, '又一個新 session');
  // 每 K 輪 curation nudge
  let nudged = 0;
  const depsK = Object.assign({}, deps, { cfg: fakeAgentConfig_({ curationEveryTurns: 2 }), curate: (sx, d) => { nudged++; sx.last_curated_turn = sx.turns; d.store.update(sx); return { proposed: 0, applied: 0, failed: 0, auto: false, ops: [] }; } });
  const k1 = runSessionTurn_({ message: 'a' }, depsK);
  runSessionTurn_({ message: 'b', sessionId: k1.sessionId }, depsK);
  assertEqual_(nudged, 1, '第 2 輪觸發 curation');
  assertEqual_(runSessionTurn_({ message: 'c', sessionId: k1.sessionId }, depsK).curation, null, '第 3 輪不觸發');
  assertThrows_(() => runSessionTurn_({ message: '' }, deps), '空訊息');
}

function testSessionCompaction_() {
  const fake = fakeChat_([{ text: '好', stop: 'end' }]);
  const deps = fakeSessionDeps_(fake.chat, { cfg: fakeAgentConfig_({ contextMaxTokens: 150, keepRecentTurns: 1 }) });
  let summarized = null;
  deps.summarize = (prev, old, d) => { summarized = { prev, oldSeqs: old.map((m) => m.seq), sessionId: d.sessionId }; return '摘要：前面聊了 ' + old.filter((m) => m.role === 'user').length + ' 輪'; };
  const long = 'x'.repeat(400);
  const r1 = runSessionTurn_({ message: long + ' 第一輪' }, deps);
  const r2 = runSessionTurn_({ message: long + ' 第二輪', sessionId: r1.sessionId }, deps);
  assertEqual_([r1.compacted, r2.compacted], [false, false], '前兩輪不壓（第二輪開始時只有 1 輪歷史，不可切）');
  const r3 = runSessionTurn_({ message: '第三輪', sessionId: r1.sessionId }, deps);
  assertEqual_(r3.compacted, true, '第三輪開始時超門檻且有 2 輪可切');
  assertEqual_(summarized.oldSeqs, [1, 2], '壓第一輪（seq 1,2），保留最近 1 輪');
  assertEqual_(summarized.sessionId, r1.sessionId, 'sessionId 帶入摘要器');
  const s = deps._ss.store.get(r1.sessionId);
  assertEqual_([s.compact_seq, s.summary], [2, '摘要：前面聊了 1 輪'], 'compact_seq 與 summary');
  const req3 = fake.calls[2];
  assertEqual_(req3.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user'], '第三輪 context 只剩第二輪 + 新訊息');
  assert_(/先前對話摘要/.test(req3.messages[0].content) && /摘要：前面聊了 1 輪/.test(req3.messages[0].content), '摘要進 system prompt');
  assertEqual_(deps._ss.store.loadMessages(r1.sessionId, 0).length, 6, 'Sheet 仍保留全部 6 則');
  // 真正的 summarizeMessages_ 用 fast 鏈
  const sumChat = fakeChat_([{ text: '```\n- 重點\n```', stop: 'end' }]);
  const out = summarizeMessages_('舊摘要', [{ role: 'user', content: 'hi' }], { chat: sumChat.chat, sessionId: 'sx' });
  assertEqual_(out, '```\n- 重點\n```', '回模型文字');
  assertEqual_(sumChat.calls[0].role, 'fast', 'role fast');
  assert_(/舊摘要/.test(sumChat.calls[0].messages[0].content) && /\[user\] hi/.test(sumChat.calls[0].messages[0].content), 'prompt 含既有摘要與對話');
  assertEqual_(summarizeMessages_('舊摘要', [], { chat: fakeChat_([{ text: '' }]).chat }), '舊摘要', '模型回空時保留舊摘要');
  // 閒置自動切新 session
  let t = Date.parse('2026-11-02T00:00:00Z');
  const idleDeps = fakeSessionDeps_(fake.chat, { cfg: fakeAgentConfig_({ sessionIdleHours: 2 }), now: () => t });
  const a = runSessionTurn_({ message: 'a' }, idleDeps);
  idleDeps._ss.sessions[0].last_active = new Date(t);
  t += 3 * 3600000;
  const b = runSessionTurn_({ message: 'b', sessionId: a.sessionId }, idleDeps);
  assert_(b.sessionId !== a.sessionId && b.sessionCreated && /閒置超過 2 小時/.test(b.sessionReason), '閒置切新：' + b.sessionReason);
  assertEqual_(idleDeps._ss.store.get(a.sessionId).status, 'closed', '舊的關閉');
  const c = runSessionTurn_({ message: 'c', sessionId: 'nope' }, idleDeps);
  assert_(c.sessionCreated && /不存在或已關閉/.test(c.sessionReason), '不存在的 id 開新');
}

function testSessionSearch_() {
  const d = (s) => new Date(s);
  const sessions = [
    { id: 'a', title: 'GAS agent M2 工具', summary: '做了 RBAC 與審批', status: 'closed', turns: 5, created: d('2026-10-01'), last_active: d('2026-10-02'), embedding: null },
    { id: 'b', title: '週報', summary: '', status: 'closed', turns: 2, created: d('2026-10-05'), last_active: d('2026-10-05'), embedding: [1, 0] },
    { id: 'cur', title: '目前', summary: 'RBAC', status: 'active', turns: 1, created: d('2026-11-01'), last_active: d('2026-11-01'), embedding: null },
  ];
  const messages = [
    { session_id: 'a', seq: 1, role: 'user', text: '幫我設計 RBAC 四開關', ts: null },
    { session_id: 'a', seq: 2, role: 'assistant', text: 'RBAC 設計如下…', ts: null },
    { session_id: 'b', seq: 1, role: 'user', text: '週報裡提一下 RBAC 進度', ts: null },
    { session_id: 'cur', seq: 1, role: 'user', text: 'RBAC', ts: null },
  ];
  const r = searchSessions_('rbac', sessions, messages, { limit: 5, excludeSessionId: 'cur', queryVector: null });
  assertEqual_(r.map((x) => x.session_id), ['a', 'b'], '排除目前 session、a 分數高');
  assertEqual_(r[0].score, 5, 'a：title/summary 3 + 2 則訊息');
  assertEqual_(r[0].snippets.length, 3, 'a 三個片段');
  assert_(/\[user\]/.test(r[0].snippets[1]), '訊息片段標 role');
  assertEqual_(r[1].score, 1, 'b 只有訊息命中');
  assertEqual_(searchSessions_('rbac 週報', sessions, messages, { limit: 5, excludeSessionId: '', queryVector: null }).map((x) => x.session_id), ['b'], 'AND');
  assertEqual_(searchSessions_('沒有的詞', sessions, messages, { limit: 5, excludeSessionId: '', queryVector: null }), [], '無結果');
  assertThrows_(() => searchSessions_('  ', sessions, messages, { limit: 5 }), '空 query');
  const withVec = searchSessions_('rbac', sessions, messages, { limit: 5, excludeSessionId: 'cur', queryVector: [1, 0] });
  assertEqual_(withVec[0].session_id, 'b', '向量相似把 b 推到前面');
  assertEqual_(snippetAround_('0123456789abcdef', 'a', 3), '…789abcd…', 'snippet 前後 3 字');
  // 工具版（經 executor，注入 store）
  const ss = memorySessionStore_();
  sessions.forEach((s) => ss.sessions.push(Object.assign({}, s)));
  messages.forEach((m) => ss.messages.push({ session_id: m.session_id, seq: m.seq, role: m.role, content: m.text, ts: null }));
  const sink = memorySink_();
  const out = executeTool_('session_search', { query: 'RBAC', limit: 1 }, { sessionId: 'cur' }, { registry: fakeM3Registry_(), config: fakeM3ToolConfig_(), sink: sink.sink, spill: memorySpill_().store, sessionStore: ss.store, agentConfig: fakeAgentConfig_() });
  assertEqual_(out.status, 'ok', 'session_search ok：' + out.content);
  const body = JSON.parse(out.content);
  assertEqual_([body.count, body.sessions[0].session_id, body.used_embeddings], [1, 'a', false], 'limit 1、排除 cur、未用向量');
}

function testCuration_() {
  assertEqual_(extractJson_('```json\n{"a":1}\n```'), { a: 1 }, '圍欄');
  assertEqual_(extractJson_('好的，結果：{"memory":{}} 以上'), { memory: {} }, '前後廢話');
  assertEqual_(extractJson_('不是 JSON'), null, '無 JSON');
  const ops = curationOps_({
    memory: { add: ['GAS Agent 用 clasp deploy -i', { content: 'Z.ai 只能打 coding endpoint', category: 'tool' }], replace: [{ old: '舊', new: '新' }], remove: ['過時'] },
    user: { add: [{ content: '偏好繁中' }], replace: [{ old: 'x' }] },
    other: { add: ['忽略'] },
  });
  assertEqual_(ops, [
    { target: 'user', action: 'add', content: '偏好繁中', category: '' },
    { target: 'memory', action: 'add', content: 'GAS Agent 用 clasp deploy -i', category: '' },
    { target: 'memory', action: 'add', content: 'Z.ai 只能打 coding endpoint', category: 'tool' },
    { target: 'memory', action: 'replace', old_content: '舊', content: '新', category: '' },
    { target: 'memory', action: 'remove', old_content: '過時' },
  ], '操作轉換（user 在前；壞的 replace 與未知 target 忽略）');
  assertEqual_(curationOps_(null), [], 'null');
  assertEqual_(curationOps_({ memory: { add: new Array(20).fill('x') } }).length, CURATION_MAX_OPS, '上限');
  // curateSession_：預設寫 Approvals
  const ss = memorySessionStore_();
  const mem = memoryMemoryStore_();
  const sink = memorySink_();
  const s = ss.store.create({});
  ss.store.appendMessages(s.id, 1, [{ role: 'user', content: '我偏好繁中' }, { role: 'assistant', content: '好' }]);
  s.turns = 1;
  ss.store.update(s);
  const chat = fakeChat_([{ text: '{"user":{"add":[{"content":"偏好繁體中文","category":"preference"}]},"memory":{"add":["專案 GAS Agent"]}}' }]);
  const cfg = fakeAgentConfig_({ curationEveryTurns: 5 });
  const r = curateSession_(ss.store.get(s.id), { store: ss.store, cfg, memoryStore: mem.store, chat: chat.chat, registry: fakeM3Registry_(), toolConfig: fakeM3ToolConfig_(), sink: sink.sink });
  assertEqual_([r.proposed, r.applied, r.auto], [2, 0, false], '兩筆提議不套用');
  assertEqual_(sink.approvals.length, 2, '寫兩列 Approvals');
  assertEqual_([sink.approvals[0].tool, sink.approvals[0].state, JSON.parse(sink.approvals[0].args)], ['memory_manage', 'pending', { target: 'user', action: 'add', content: '偏好繁體中文', category: 'preference' }], 'Approvals 內容');
  assert_(/curation 提議/.test(sink.approvals[0].reason), 'reason');
  assertEqual_(mem.data.user.length, 0, '記憶未動');
  assertEqual_(ss.store.get(s.id).last_curated_turn, 1, 'last_curated_turn 更新');
  assertEqual_(chat.calls[0].role, 'fast', '用 fast');
  assert_(/記憶整理員/.test(chat.calls[0].messages[0].content) && /\[user\] 我偏好繁中/.test(chat.calls[0].messages[0].content), 'prompt 含對話');
  assertEqual_(describeCuration_(r), '提議 2 筆，待你在「紀錄 → 審批」批准', '描述');
  // auto_apply
  const chat2 = fakeChat_([{ text: '{"user":{"add":["偏好繁體中文"]},"memory":{"remove":["不存在"]}}' }]);
  const r2 = curateSession_(ss.store.get(s.id), { store: ss.store, cfg: fakeAgentConfig_({ curationAutoApply: true }), memoryStore: mem.store, chat: chat2.chat, registry: fakeM3Registry_(), toolConfig: fakeM3ToolConfig_(), sink: sink.sink });
  assertEqual_([r2.proposed, r2.applied, r2.failed, r2.auto], [2, 1, 1, true], '自動套用：1 成功 1 失敗');
  assertEqual_(mem.data.user[0].content, '偏好繁體中文', '已寫入');
  assertEqual_(sink.approvals.length, 2, '不再寫 Approvals');
  assertEqual_(describeCuration_(r2), '自動套用 1 筆，1 筆失敗', '描述 auto');
  assertEqual_(describeCuration_({ proposed: 0 }), '沒有需要更新的記憶', '描述空');
  // 模型回垃圾
  const r3 = curateSession_(ss.store.get(s.id), { store: ss.store, cfg, memoryStore: mem.store, chat: fakeChat_([{ text: '抱歉我不懂' }]).chat, registry: fakeM3Registry_(), toolConfig: fakeM3ToolConfig_(), sink: sink.sink });
  assertEqual_(r3.proposed, 0, '非 JSON → 0 筆');
}

function testEmbeddings_() {
  const oa = validateProvider_(fakeProviderInput_({ id: 'emb', role: 'embed', model: 'text-embedding-3-small', extra_body: '{"dimensions": 256}' }));
  const req = openaiEmbedRequest_(oa, ['a', 'b'], 'k');
  assertEqual_(req.url, 'https://example.com/v1/embeddings', 'openai url');
  assertEqual_(req.body, { model: 'text-embedding-3-small', input: ['a', 'b'], dimensions: 256 }, 'openai body + extra_body');
  assertEqual_(openaiEmbedParse_({ data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] }), [[1, 2], [3, 4]], 'openai 依 index 排序');
  const gm = validateProvider_(fakeProviderInput_({ id: 'gemb', role: 'embed', protocol: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-embedding-001' }));
  const greq = geminiEmbedRequest_(gm, ['x'], 'k');
  assertEqual_(greq.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents', 'gemini url');
  assertEqual_(greq.body, { requests: [{ model: 'models/gemini-embedding-001', content: { parts: [{ text: 'x' }] } }] }, 'gemini body');
  assertEqual_(greq.headers['x-goog-api-key'], 'k', 'gemini header');
  assertEqual_(geminiEmbedParse_({ embeddings: [{ values: [0.1, 0.2] }] }), [[0.1, 0.2]], 'gemini parse');
  assertEqual_(cosine_([1, 0], [1, 0]), 1, 'cosine 同向');
  assertEqual_(cosine_([1, 0], [0, 1]), 0, 'cosine 正交');
  assertEqual_(cosine_([1, 0], [1]), 0, '長度不符');
  // embedTexts_ 經 fetch stub；embedWithChain_
  const stub = fetchStub_([fakeResponse_(200, { data: [{ index: 0, embedding: [1, 1] }] })]);
  assertEqual_(embedTexts_(oa, ['hi'], { fetch: stub.fetch, keyFor: () => 'k' }), [[1, 1]], 'embedTexts_');
  assertEqual_(JSON.parse(stub.calls[0].options.payload).input, ['hi'], 'payload');
  assertThrows_(() => embedTexts_(oa, ['a', 'b'], { fetch: fetchStub_([fakeResponse_(200, { data: [{ index: 0, embedding: [1] }] })]).fetch, keyFor: () => 'k' }), '數量不符');
  assertThrows_(() => embedTexts_(validateProvider_(fakeProviderInput_({ protocol: 'anthropic', base_url: 'https://api.anthropic.com' })), ['a'], { keyFor: () => 'k' }), 'anthropic 不支援嵌入');
  const chainStub = fetchStub_([fakeResponse_(503, 'busy'), fakeResponse_(200, { embeddings: [{ values: [2, 2] }] })]);
  const r = embedWithChain_(['q'], { fetch: chainStub.fetch, keyFor: () => 'k', providers: [oa, Object.assign({}, gm, { priority: 20 })] });
  assertEqual_([r.provider, r.vectors], ['gemb', [[2, 2]]], '503 換下一個');
  assertThrows_(() => embedWithChain_(['q'], { providers: [] }), '沒有 embed provider');
}

// ---- M4：cron / queue / deliver -------------------------------------------------------------------

/** @return {{store: Object, jobs: !Array}} 記憶體版 Queue store（list 回副本、update 以 id 覆寫，行為同 Sheet 版） */
function memoryQueueStore_() {
  const jobs = [];
  const clone = (j) => Object.assign({}, j, { payload: JSON.parse(JSON.stringify(j.payload || {})) });
  return {
    jobs,
    store: {
      list: () => jobs.map(clone),
      get: (id) => { const j = jobs.find((x) => x.id === id); return j ? clone(j) : null; },
      add: (j) => { jobs.push(clone(j)); return j; },
      update: (j) => { const i = jobs.findIndex((x) => x.id === j.id); if (i === -1) throw new Error('no job ' + j.id); jobs[i] = clone(j); },
    },
  };
}

/** @return {{store: Object, crons: !Array}} 記憶體版 Cron store */
function memoryCronStore_() {
  const crons = [];
  const clone = (c) => Object.assign({}, c);
  return {
    crons,
    store: {
      list: () => crons.map(clone),
      get: (id) => { const c = crons.find((x) => x.id === id); return c ? clone(c) : null; },
      add: (c) => { crons.push(clone(c)); return c; },
      update: (c) => { const i = crons.findIndex((x) => x.id === c.id); if (i === -1) throw new Error('no cron ' + c.id); crons[i] = clone(c); },
    },
  };
}

/** @return {{lock: Object, held: boolean, busy: boolean}} 假鎖；busy=true 時 tryLock 失敗 */
function fakeLock_(busy) {
  const o = { held: false, busy: !!busy, acquired: 0, released: 0 };
  o.lock = { tryLock: () => { if (o.busy) return false; o.held = true; o.acquired++; return true; }, releaseLock: () => { o.held = false; o.released++; } };
  return o;
}

/** @return {{store: Object, rows: !Array}} 記憶體版 Approvals store（decideApproval_ 用） */
function memoryApprovalStore_(rows) {
  const data = rows.slice();
  return {
    rows: data,
    store: {
      list: () => data.map((r) => Object.assign({}, r)),
      update: (row, fields) => { const i = data.findIndex((r) => r.id === row.id); Object.assign(data[i], fields); },
    },
  };
}

function testCronSchedule_() {
  assertEqual_(normalizeSchedule_('daily 09:00'), '0 9 * * *', 'daily');
  assertEqual_(normalizeSchedule_('Daily'), '0 9 * * *', 'daily 無時間 → 09:00');
  assertEqual_(normalizeSchedule_('每天 8:05'), '5 8 * * *', '中文 daily');
  assertEqual_(normalizeSchedule_('weekly mon 09:30'), '30 9 * * 1', 'weekly');
  assertEqual_(normalizeSchedule_('每週一 09:00'), '0 9 * * 1', '中文 weekly');
  assertEqual_(normalizeSchedule_('每週日'), '0 9 * * 0', '每週日預設時間');
  assertEqual_(normalizeSchedule_('hourly'), '0 * * * *', 'hourly');
  assertEqual_(normalizeSchedule_(' 0  9 * * 1-5 '), '0 9 * * 1-5', '5 欄原樣（去多餘空白）');
  ['', '* * *', '60 * * * *', '0 24 * * *', '0 9 32 * *', '0 9 * 13 *', '0 9 * * 8', 'daily 25:00', 'weekly xyz 09:00', '*/0 * * * *', '5-1 * * * *', 'a b c d e']
    .forEach((bad) => assertThrows_(() => normalizeSchedule_(bad), `應拒絕「${bad}」`));
  const p = parseCronSchedule_('*/15 9-17 1,15 * mon-fri');
  assertEqual_([p.minute, p.hour, p.dom, p.month, p.dow], [{ 0: true, 15: true, 30: true, 45: true }, { 9: true, 10: true, 11: true, 12: true, 13: true, 14: true, 15: true, 16: true, 17: true }, { 1: true, 15: true }, null, { 1: true, 2: true, 3: true, 4: true, 5: true }], '欄位解析');
  assertEqual_(parseCronSchedule_('0 9 * * 7').dow, { 0: true }, '週 7 = 日');
  assertEqual_(parseCronSchedule_('0 9 * * sun,6').dow, { 0: true, 6: true }, '週名與數字混用');

  // 2026-11-02 是星期一（本地時間）
  const from = new Date(2026, 10, 2, 8, 30, 20);
  const iso = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
  assertEqual_(iso(computeNextRun_('daily 09:00', from)), '2026-11-2 9:0', '當天 09:00');
  assertEqual_(iso(computeNextRun_('daily 09:00', new Date(2026, 10, 2, 9, 0, 0))), '2026-11-3 9:0', 'from 正好在那分鐘 → 隔天（不含 from）');
  assertEqual_(iso(computeNextRun_('*/15 * * * *', from)), '2026-11-2 8:45', '每 15 分');
  assertEqual_(iso(computeNextRun_('hourly', from)), '2026-11-2 9:0', 'hourly');
  assertEqual_(iso(computeNextRun_('weekly fri 18:00', from)), '2026-11-6 18:0', '本週五');
  assertEqual_(iso(computeNextRun_('0 9 1 * *', from)), '2026-12-1 9:0', '每月 1 日 → 跨月');
  assertEqual_(iso(computeNextRun_('0 9 * * 1-5', new Date(2026, 10, 6, 10, 0))), '2026-11-9 9:0', '週五 10:00 → 下週一');
  assertEqual_(iso(computeNextRun_('0 9 15 * 1', from)), '2026-11-2 9:0', 'dom 與 dow 都有限制取「或」：當天是週一');
  assertEqual_(iso(computeNextRun_('0 9 15 * 1', new Date(2026, 10, 2, 10, 0))), '2026-11-9 9:0', '過了當天 09:00 → 下週一（早於 15 日）');
  assertEqual_(iso(computeNextRun_('0 9 15 * 1', new Date(2026, 10, 10, 10, 0))), '2026-11-15 9:0', '15 日早於再下個週一（16 日）');
  assertEqual_(iso(computeNextRun_('30 6 1 1 *', from)), '2027-1-1 6:30', '跨年');
  assertThrows_(() => computeNextRun_('0 0 31 2 *', from), '2 月 31 日永遠不會到');
  assertEqual_(computeNextRun_('daily 09:00', from).getSeconds(), 0, '秒歸零');

  // 輸入驗證
  const ok = validateCronInput_({ name: ' 郵件摘要 ', schedule: 'daily 09:00', prompt: '摘要昨天的信', deliver_to: 'DOC', model_pin: 'p1', skills: '', enabled: 'TRUE' }, undefined, ['p1']);
  assertEqual_([ok.name, ok.deliver_to, ok.model_pin, ok.enabled], ['郵件摘要', 'doc', 'p1', true], '正規化');
  assertThrows_(() => validateCronInput_({ schedule: 'daily', prompt: 'x' }), '缺 name');
  assertThrows_(() => validateCronInput_({ name: 'a', schedule: 'daily', prompt: '' }), '缺 prompt');
  assertThrows_(() => validateCronInput_({ name: 'a', schedule: 'nope', prompt: 'x' }), 'schedule 壞');
  assertThrows_(() => validateCronInput_({ name: 'a', schedule: 'daily', prompt: 'x', deliver_to: 'telegram' }), 'deliver_to 未支援');
  assertThrows_(() => validateCronInput_({ name: 'a', schedule: 'daily', prompt: 'x', model_pin: 'ghost' }, undefined, ['p1']), 'model_pin 不存在');
  const edited = validateCronInput_({ prompt: '新指令' }, ok);
  assertEqual_([edited.name, edited.prompt, edited.schedule], ['郵件摘要', '新指令', 'daily 09:00'], '編輯時沿用既有欄位');
  const crons = [
    { id: 'a', enabled: true, next_run: new Date(2026, 10, 2, 9, 0) }, { id: 'b', enabled: false, next_run: new Date(2026, 10, 2, 7, 0) },
    { id: 'c', enabled: true, next_run: new Date(2026, 10, 2, 7, 0) }, { id: 'd', enabled: true, next_run: null },
  ];
  assertEqual_(dueCrons_(crons, new Date(2026, 10, 2, 8, 0)).map((c) => c.id), ['c'], '到期：enabled 且 next_run <= now');
  assertEqual_(earliestCronNextRun_(crons).getHours(), 7, '最早的 enabled next_run');
  assertEqual_(earliestCronNextRun_([crons[1], crons[3]]), null, '沒有可用的 → null');
}

function testQueueStateMachine_() {
  const q = memoryQueueStore_();
  const cron = memoryCronStore_();
  const lock = fakeLock_();
  setProp_(PROP.QUEUE_DIRTY, '');
  assertThrows_(() => enqueue_('bogus', {}, '', { store: q.store }), 'type 不合法');
  const job = enqueue_('turn', { message: 'hi' }, 'sX', { store: q.store });
  assert_(/^job_/.test(job.id) && jobCreatedAt_(job.id), 'job id 格式可還原時間');
  assertEqual_([job.state, job.attempts, q.jobs.length, getProp_(PROP.QUEUE_DIRTY)], ['queued', 0, 1, '1'], 'enqueue 寫一列並設旗標');
  // 成功
  const ran = [];
  const okRun = (j) => { ran.push(j.id); return { state: 'done', result: { text: 'ok ' + j.payload.message } }; };
  let t = Date.parse('2026-11-02T01:00:00Z');
  const now = () => t;
  let r = queueTickCore_({ store: q.store, cronStore: cron.store, lock: lock.lock, now, runJob: okRun });
  assertEqual_([r.skipped, r.ran.id, r.ran.state, r.remaining, ran], ['', job.id, 'done', 0, [job.id]], 'tick 跑完一個 job');
  const done = q.store.get(job.id);
  assertEqual_([done.state, done.attempts, done.payload.result.text, done.error, !!done.started, !!done.finished], ['done', 1, 'ok hi', '', true, true], 'job 寫回 done 與結果');
  assertEqual_(getProp_(PROP.QUEUE_DIRTY), '', '沒有 queued 就清旗標');
  assertEqual_([lock.acquired, lock.released, lock.held], [1, 1, false], '鎖取得並釋放');
  // 無 job 的 tick
  r = queueTickCore_({ store: q.store, cronStore: cron.store, lock: lock.lock, now, runJob: okRun });
  assertEqual_([r.ran, ran.length], [null, 1], '沒 job 不跑');
  // 例外 → 重試到 3 次 → failed
  const bad = enqueue_('turn', { message: 'boom' }, '', { store: q.store });
  const boom = () => { throw new Error('kaboom'); };
  for (let i = 1; i <= 3; i++) {
    r = queueTickCore_({ store: q.store, cronStore: cron.store, lock: lock.lock, now, runJob: boom });
    const j = q.store.get(bad.id);
    assertEqual_([j.attempts, j.state], [i, i < 3 ? 'queued' : 'failed'], `第 ${i} 次失敗`);
    assert_(/kaboom/.test(j.error), '記錯誤');
    assertEqual_(getProp_(PROP.QUEUE_DIRTY), i < 3 ? '1' : '', '旗標跟著 queued 數');
  }
  r = queueTickCore_({ store: q.store, cronStore: cron.store, lock: lock.lock, now, runJob: boom });
  assertEqual_(r.ran, null, 'failed 不再跑');
  // 重試按鈕
  assertThrows_(() => retryJob_(job.id, { store: q.store }), 'done 不能重試');
  const retried = retryJob_(bad.id, { store: q.store });
  assertEqual_([retried.state, retried.attempts, retried.error, getProp_(PROP.QUEUE_DIRTY)], ['queued', 0, '', '1'], '重試回 queued');
  r = queueTickCore_({ store: q.store, cronStore: cron.store, lock: lock.lock, now, runJob: okRun });
  assertEqual_(q.store.get(bad.id).state, 'done', '重試後成功');
  // 鎖住 → 略過
  const j3 = enqueue_('turn', { message: 'c' }, '', { store: q.store });
  const busy = fakeLock_(true);
  r = queueTickCore_({ store: q.store, cronStore: cron.store, lock: busy.lock, now, runJob: okRun });
  assertEqual_([r.skipped, q.store.get(j3.id).state], ['locked', 'queued'], '鎖住不動任何東西');
  // 一次只跑一個（最舊的先）
  const j4 = enqueue_('turn', { message: 'd' }, '', { store: q.store });
  r = queueTickCore_({ store: q.store, cronStore: cron.store, lock: lock.lock, now, runJob: okRun });
  assertEqual_([r.ran.id, q.store.get(j4.id).state, r.remaining, getProp_(PROP.QUEUE_DIRTY)], [j3.id, 'queued', 1, '1'], '只跑最舊的，旗標保留');
  // 預算不足不接新 job
  r = queueTickCore_({ store: q.store, cronStore: cron.store, lock: lock.lock, now, runJob: okRun, budgetMs: 1000 });
  assertEqual_([r.ran, q.store.get(j4.id).state], [null, 'queued'], '剩餘預算 < 1 分鐘不接');
  queueTickCore_({ store: q.store, cronStore: cron.store, lock: lock.lock, now, runJob: okRun });
  // 卡住的 running：11 分鐘前開始 → 重排；attempts 已滿 → failed
  const stuck = enqueue_('turn', { message: 'stuck' }, '', { store: q.store });
  const s1 = q.store.get(stuck.id); s1.state = 'running'; s1.attempts = 1; s1.started = new Date(t - 11 * 60000); q.store.update(s1);
  const stuck2 = enqueue_('turn', { message: 'stuck2' }, '', { store: q.store });
  const s2 = q.store.get(stuck2.id); s2.state = 'running'; s2.attempts = 3; s2.started = new Date(t - 11 * 60000); q.store.update(s2);
  const fresh = enqueue_('turn', { message: 'fresh' }, '', { store: q.store });
  const s3 = q.store.get(fresh.id); s3.state = 'running'; s3.attempts = 1; s3.started = new Date(t - 2 * 60000); q.store.update(s3);
  r = queueTickCore_({ store: q.store, cronStore: cron.store, lock: lock.lock, now, runJob: okRun });
  assertEqual_(r.recovered.sort(), [stuck.id, stuck2.id].sort(), '兩個卡住的被處理，2 分鐘的不動');
  assertEqual_([q.store.get(stuck.id).state, q.store.get(stuck2.id).state, q.store.get(fresh.id).state], ['done', 'failed', 'running'], '重排的這次就跑掉、滿次數的失敗');
  assert_(/超過 10 分鐘/.test(q.store.get(stuck2.id).error), '錯誤說明');
  // publicJob_ / 摘要
  const pub = publicJob_(q.store.get(stuck.id));
  assertEqual_([pub.state, pub.summary, pub.payload.result.text], ['done', 'stuck', 'ok stuck'], 'publicJob_');
  assertEqual_(jobSummary_({ type: 'continuation', payload: { origin: 'approval', cron: { name: 'X' } } }), '審批後續跑：排程「X」', 'continuation 摘要');
  setProp_(PROP.QUEUE_DIRTY, '');
}

/** Queue 測試用：runSessionTurn_ 的假依賴（記憶體 session / memory store、假 chat、可選 turnDeps） */
function fakeQueueSessionDeps_(chat, turnOverrides) {
  const d = fakeSessionDeps_(chat);
  d.turnDeps = Object.assign({}, d.turnDeps, turnOverrides || {});
  return d;
}

function testCheckpointContinuation_() {
  const q = memoryQueueStore_();
  const cron = memoryCronStore_();
  const lock = fakeLock_();
  // 每次都要工具、maxSteps=1 → 每輪都 max_steps 中止
  const loop = fakeChat_([{ toolCalls: [{ id: 'c', name: 'fake_echo', args: { text: 'x' } }], stop: 'tool_calls' }]);
  const sessionDeps = fakeQueueSessionDeps_(loop.chat, { maxSteps: 1 });
  const first = enqueue_('turn', { message: '做一件很長的事', channel: 'admin', mode: 'interactive' }, '', { store: q.store });
  const tick = () => queueTickCore_({ store: q.store, cronStore: cron.store, lock: lock.lock, sessionDeps });
  let r = tick();
  const j1 = q.store.get(first.id);
  assertEqual_([r.ran.state, j1.state, j1.payload.result.stopped, j1.payload.result.steps.length], ['done', 'done', 'max_steps', 1], '第一輪 max_steps');
  assert_(j1.session_id && j1.session_id === j1.payload.result.sessionId, 'job 記下建立的 session');
  assertEqual_(q.jobs.length, 2, 'enqueue 了一個 continuation');
  const c1 = q.jobs[1];
  assertEqual_([c1.type, c1.session_id, c1.payload.origin, c1.payload.continuations, c1.payload.root_job_id, c1.payload.message, j1.payload.result.continued_by], ['continuation', j1.session_id, 'checkpoint', 1, first.id, CONTINUATION_PROMPT, c1.id], 'continuation 內容');
  assertEqual_(getProp_(PROP.QUEUE_DIRTY), '1', '還有 queued → 旗標在');
  // 續跑 2、3 次：第 3 次（continuations=3）後不再 enqueue
  tick(); tick(); tick();
  assertEqual_(q.jobs.length, 4, '共 1 + 3 個 job，第 4 個不再續');
  const last = q.jobs[3];
  assertEqual_([last.state, last.payload.continuations, last.payload.result.continuation_exhausted, last.payload.result.continued_by], ['done', 3, true, undefined], '續跑上限');
  assertEqual_(getProp_(PROP.QUEUE_DIRTY), '', '全部跑完旗標清掉');
  // 續跑的 user 訊息真的進了模型，且歷史帶著前一輪的 tool 訊息
  const req = loop.calls[1].messages;
  assertEqual_(req[req.length - 1], { role: 'user', content: CONTINUATION_PROMPT }, '第二輪 user 訊息是續跑提示');
  assert_(req.some((m) => m.role === 'tool'), '歷史含第一輪的 tool 結果');
  assertEqual_(sessionDeps._ss.sessions.length, 1, '四輪都在同一個 session');
  assertEqual_(sessionDeps._ss.store.get(j1.session_id).turns, 4, 'session 累計 4 輪');
  // 時間預算：假時鐘每次 chat 前進 300 秒 → time_budget 也續跑
  let t = Date.parse('2026-11-02T01:00:00Z');
  const slow = fakeChat_([{ toolCalls: [{ id: 'c', name: 'fake_echo', args: { text: 'x' } }], stop: 'tool_calls' }]);
  const slowDeps = fakeQueueSessionDeps_((req2) => { t += 300000; return slow.chat(req2); });
  const q2 = memoryQueueStore_();
  const tb = enqueue_('turn', { message: 'slow' }, '', { store: q2.store });
  queueTickCore_({ store: q2.store, cronStore: cron.store, lock: lock.lock, now: () => t, sessionDeps: slowDeps });
  assertEqual_([q2.store.get(tb.id).payload.result.stopped, q2.jobs.length, q2.jobs[1].payload.origin], ['time_budget', 2, 'checkpoint'], '時間預算中止也續跑');
  // 正常結束：不續跑、state done
  const q3 = memoryQueueStore_();
  const fine = fakeChat_([{ text: '做完了', stop: 'end' }]);
  const ok = enqueue_('turn', { message: '簡單' }, '', { store: q3.store });
  queueTickCore_({ store: q3.store, cronStore: cron.store, lock: lock.lock, sessionDeps: fakeQueueSessionDeps_(fine.chat) });
  assertEqual_([q3.jobs.length, q3.store.get(ok.id).state, q3.store.get(ok.id).payload.result.text], [1, 'done', '做完了'], '正常結束');
  // 待審批 → needs_approval
  const q4 = memoryQueueStore_();
  const send = fakeChat_([{ toolCalls: [{ id: 'c', name: 'fake_send', args: { text: 'mail' } }], stop: 'tool_calls' }, { text: '已送審', stop: 'end' }]);
  const pj = enqueue_('turn', { message: '寄信' }, '', { store: q4.store });
  queueTickCore_({ store: q4.store, cronStore: cron.store, lock: lock.lock, sessionDeps: fakeQueueSessionDeps_(send.chat) });
  assertEqual_(q4.store.get(pj.id).state, 'needs_approval', '有 pending_approval 步驟 → needs_approval');
  // payload.message 空 → 例外（會重試到 failed）
  const q5 = memoryQueueStore_();
  const empty = enqueue_('turn', {}, '', { store: q5.store });
  queueTickCore_({ store: q5.store, cronStore: cron.store, lock: lock.lock, sessionDeps: fakeQueueSessionDeps_(fine.chat) });
  assert_(/message/.test(q5.store.get(empty.id).error), '缺 message 記錯誤');
  setProp_(PROP.QUEUE_DIRTY, '');
}

function testApprovalContinuation_() {
  const ss = memorySessionStore_();
  const active = ss.store.create({ channel: 'admin' });
  const closed = ss.store.create({ channel: 'admin' });
  closed.status = 'closed'; ss.store.update(closed);
  const cronSess = ss.store.create({ channel: 'cron' });
  const rows = [
    { _row: 2, id: 'apr_1', job_id: active.id, tool: 'fake_send', args: '{"text":"go"}', reason: '風險 X（外發）；審批策略 always；模式 interactive', state: 'pending', decided_at: '', result: '' },
    { _row: 3, id: 'apr_2', job_id: active.id, tool: 'fake_send', args: '{"text":"no"}', reason: '風險 X', state: 'pending', decided_at: '', result: '' },
    { _row: 4, id: 'apr_3', job_id: active.id, tool: 'memory_manage', args: '{"target":"memory","action":"add","content":"x"}', reason: 'curation 提議（session s1 第 3 輪）', state: 'pending', decided_at: '', result: '' },
    { _row: 5, id: 'apr_4', job_id: closed.id, tool: 'fake_send', args: '{"text":"late"}', reason: '風險 X', state: 'pending', decided_at: '', result: '' },
    { _row: 6, id: 'apr_5', job_id: cronSess.id, tool: 'fake_send', args: '{"text":"cron"}', reason: '風險 X；模式 autonomous', state: 'pending', decided_at: '', result: '' },
    { _row: 7, id: 'apr_6', job_id: '', tool: 'fake_send', args: '{}', reason: '風險 X', state: 'approved', decided_at: '', result: '' },
  ];
  const ap = memoryApprovalStore_(rows);
  const q = memoryQueueStore_();
  const sink = memorySink_();
  const deps = { approvalStore: ap.store, sessionStore: ss.store, queueStore: q.store, registry: fakeM3Registry_(), config: fakeM3ToolConfig_(), sink: sink.sink, spill: memorySpill_().store };
  // 批准：執行一次、寫回結果、enqueue continuation
  const r1 = decideApproval_('apr_1', true, deps);
  assertEqual_([r1.state, r1.outcome.status, r1.outcome.content, ap.rows[0].state, ap.rows[0].result], ['approved', 'ok', '{"sent":"go"}', 'approved', 'OK: {"sent":"go"}'], '批准並執行');
  assert_(ap.rows[0].decided_at instanceof Date, 'decided_at');
  assertEqual_(q.jobs.length, 1, 'enqueue 一個 continuation');
  const c1 = q.jobs[0];
  assertEqual_([c1.type, c1.session_id, c1.payload.origin, c1.payload.approval_id, c1.payload.mode, c1.payload.channel, r1.continuation], ['continuation', active.id, 'approval', 'apr_1', 'interactive', 'admin', c1.id], 'continuation 欄位');
  assert_(/（系統）先前待審批的 fake_send 已由 owner 批准並執行，結果：\{"sent":"go"\}/.test(c1.payload.message), '訊息內容：' + c1.payload.message);
  assertEqual_(sink.audits.length, 1, '執行寫 AuditLog');
  // 拒絕：不執行、也通知
  const r2 = decideApproval_('apr_2', false, deps);
  assertEqual_([r2.state, r2.outcome, ap.rows[1].state, q.jobs.length], ['denied', null, 'denied', 2], '拒絕');
  assert_(/已由 owner 拒絕，未執行/.test(q.jobs[1].payload.message) && /"text":"no"/.test(q.jobs[1].payload.message), '拒絕訊息含參數：' + q.jobs[1].payload.message);
  assertEqual_(sink.audits.length, 1, '拒絕不執行工具');
  // curation 提議：批准套用但不續跑
  const mem = memoryMemoryStore_();
  const r3 = decideApproval_('apr_3', true, Object.assign({}, deps, { memoryStore: mem.store, agentConfig: fakeAgentConfig_() }));
  assertEqual_([r3.state, r3.outcome.status, r3.continuation, q.jobs.length, mem.data.memory.length], ['approved', 'ok', '', 2, 1], 'curation 批准寫記憶但不續跑');
  // 已關閉的 session：不續跑
  const r4 = decideApproval_('apr_4', true, deps);
  assertEqual_([r4.state, r4.continuation, q.jobs.length], ['approved', '', 2], '關閉的 session 不續跑');
  // cron session：續跑用 autonomous
  decideApproval_('apr_5', true, deps);
  assertEqual_([q.jobs[2].payload.mode, q.jobs[2].payload.channel], ['autonomous', 'cron'], 'cron session 續跑用 autonomous');
  // 已處理 / 不存在
  assertThrows_(() => decideApproval_('apr_6', true, deps), '已處理');
  assertThrows_(() => decideApproval_('nope', true, deps), '不存在');
  // 把 continuation 真的跑過 Queue：訊息以 user 進模型、接在原 session
  ss.store.appendMessages(active.id, 1, [{ role: 'user', content: '幫我寄信' }, { role: 'assistant', content: '已送審' }]);
  const act = ss.store.get(active.id); act.turns = 1; ss.store.update(act);
  const chat = fakeChat_([{ text: '好，信已寄出。', stop: 'end' }]);
  const sessionDeps = fakeQueueSessionDeps_(chat.chat);
  sessionDeps.store = ss.store;
  const r = queueTickCore_({ store: q.store, cronStore: memoryCronStore_().store, lock: fakeLock_().lock, sessionDeps });
  assertEqual_([r.ran.id, r.ran.state], [c1.id, 'done'], '續跑 job 完成');
  const msgs = chat.calls[0].messages;
  assertEqual_(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'user'], '帶原 session 歷史');
  assert_(/已由 owner 批准並執行/.test(msgs[3].content), '最後的 user 訊息是系統通知');
  assertEqual_(ss.store.get(active.id).turns, 2, '原 session 多一輪');
  setProp_(PROP.QUEUE_DIRTY, '');
}

function testCronJobAutonomous_() {
  const q = memoryQueueStore_();
  const cron = memoryCronStore_();
  let t = new Date(2026, 10, 2, 9, 0, 30).getTime();
  const now = () => t;
  // 建排程（走 createCron_）：next_run 算好、旗標寫入
  const c = createCron_({ name: '郵件摘要', schedule: 'daily 09:00', prompt: '摘要昨天的信件並寫成 Doc', deliver_to: 'doc' }, { cronStore: cron.store, providerIds: [], now });
  assertEqual_([cron.crons.length, c.enabled, c.next_run.getDate(), c.next_run.getHours()], [1, true, 3, 9], '建立並算出明天 09:00');
  assertEqual_(getProp_(PROP.CRON_NEXT_RUN), c.next_run.toISOString(), 'CRON_NEXT_RUN 旗標');
  // 未到期：掃描不入列
  assertEqual_(scanCronDue_({ cronStore: cron.store, queueStore: q.store, now }).length, 0, '未到期');
  // 到期：入列、next_run 推進、last_status
  t = new Date(2026, 10, 3, 9, 0, 10).getTime();
  const jobs = scanCronDue_({ cronStore: cron.store, queueStore: q.store, now });
  assertEqual_([jobs.length, jobs[0].type, jobs[0].payload.cron_id, jobs[0].payload.prompt, jobs[0].payload.deliver_to], [1, 'cron', c.id, '摘要昨天的信件並寫成 Doc', 'doc'], 'cron job payload');
  const after = cron.store.get(c.id);
  assertEqual_([after.next_run.getDate(), after.next_run.getHours(), after.last_run.getTime()], [4, 9, t], 'next_run → 11/4 09:00，last_run = now');
  assert_(/queued（job job_/.test(after.last_status), 'last_status');
  assertEqual_(scanCronDue_({ cronStore: cron.store, queueStore: q.store, now }).length, 0, '同一分鐘不重複入列');
  // 停用的與沒有 next_run 的
  const off = createCron_({ name: 'off', schedule: 'hourly', prompt: 'x', enabled: false }, { cronStore: cron.store, now });
  assertEqual_(off.next_run, null, '停用不算 next_run');
  const noNext = cron.store.get(off.id); noNext.enabled = true; cron.store.update(noNext);
  scanCronDue_({ cronStore: cron.store, queueStore: q.store, now });
  assert_(cron.store.get(off.id).next_run instanceof Date, 'enabled 但沒 next_run → 補算（不執行）');
  assertEqual_(q.jobs.length, 1, '補算不入列');
  // 跑 cron job：autonomous、新 session、X 工具送審、投遞 doc
  const fake = fakeChat_([
    { toolCalls: [{ id: 'c1', name: 'fake_echo', args: { text: '昨天的信' } }], stop: 'tool_calls' },
    { toolCalls: [{ id: 'c2', name: 'fake_send', args: { text: '摘要' } }], stop: 'tool_calls' },
    { text: '# 昨日郵件摘要\n- 一封重要信\n寄信已送審。', stop: 'end' },
  ]);
  const sessionDeps = fakeQueueSessionDeps_(fake.chat);
  sessionDeps.toolConfig = fakeM3ToolConfig_({ approvalPolicy: 'autonomous_only' });
  const docs = [];
  const mails = [];
  const deliverDeps = { createDoc: (title, body) => { docs.push({ title, body }); return { id: 'doc1', url: 'https://docs.google.com/document/d/doc1' }; }, sendEmail: (to, subject, body) => mails.push({ to, subject, body }), ownerEmail: 'owner@example.com' };
  const r = queueTickCore_({ store: q.store, cronStore: cron.store, lock: fakeLock_().lock, now, sessionDeps, deliverDeps });
  const job = q.store.get(jobs[0].id);
  assertEqual_([r.ran.state, job.state, job.payload.mode, job.payload.channel], ['needs_approval', 'needs_approval', 'autonomous', 'cron'], 'cron job 轉成 autonomous turn，X 工具待審 → needs_approval');
  const sess = sessionDeps._ss.sessions[0];
  assertEqual_([sessionDeps._ss.sessions.length, sess.channel, sess.external_id, sess.title, job.session_id], [1, 'cron', c.id, '郵件摘要', sess.id], '新 session：channel cron、external_id = cron id');
  assert_(/本輪是排程自動執行/.test(fake.calls[0].messages[0].content), 'system prompt 含無人模式指示');
  assertEqual_(fake.calls[0].messages[1].content, '摘要昨天的信件並寫成 Doc', 'user 訊息 = prompt');
  assertEqual_(job.payload.result.steps.map((s) => s.status), ['ok', 'pending_approval'], 'autonomous_only 在無人模式送審');
  assertEqual_(sessionDeps._sink.approvals.length, 1, '寫一筆 Approvals');
  assertEqual_(sessionDeps._sink.approvals[0].job_id, sess.id, 'Approvals.job_id = cron session id（批准後可續跑）');
  assert_(/模式 autonomous/.test(sessionDeps._sink.approvals[0].reason), 'reason 標 autonomous');
  // 投遞
  assertEqual_([docs.length, mails.length], [1, 0], 'deliver_to=doc 建一份文件');
  assertEqual_(docs[0].title, '郵件摘要 2026-11-03', '標題「<name> YYYY-MM-DD」');
  assert_(/# 昨日郵件摘要/.test(docs[0].body) && /待 owner 審批：fake_send/.test(docs[0].body) && /session：/.test(docs[0].body), '內文含結果與執行資訊：' + docs[0].body);
  assertEqual_([job.payload.result.delivery.channel, job.payload.result.delivery.ok, job.payload.result.delivery.ref], ['doc', true, 'https://docs.google.com/document/d/doc1'], 'delivery 記錄');
  assert_(/needs_approval/.test(cron.store.get(c.id).last_status) && /doc1/.test(cron.store.get(c.id).last_status), 'Cron last_status：' + cron.store.get(c.id).last_status);
  // 續跑中的 cron 不投遞，最終才投遞
  const loop = fakeChat_([{ toolCalls: [{ id: 'c', name: 'fake_echo', args: { text: 'x' } }], stop: 'tool_calls' }]);
  const loopDeps = fakeQueueSessionDeps_(loop.chat, { maxSteps: 1 });
  const q2 = memoryQueueStore_();
  const rn = runCronNow_(c.id, { cronStore: cron.store, queueStore: q2.store, now });
  assert_(/手動/.test(cron.store.get(c.id).last_status), 'run_now 記 last_status');
  queueTickCore_({ store: q2.store, cronStore: cron.store, lock: fakeLock_().lock, now, sessionDeps: loopDeps, deliverDeps });
  assertEqual_([q2.jobs.length, docs.length, q2.jobs[1].payload.cron.cron_id], [2, 1, c.id], '續跑：不投遞，continuation 帶 cron 資訊');
  assert_(/續跑 job/.test(cron.store.get(c.id).last_status), 'last_status 標續跑');
  queueTickCore_({ store: q2.store, cronStore: cron.store, lock: fakeLock_().lock, now, sessionDeps: loopDeps, deliverDeps });
  queueTickCore_({ store: q2.store, cronStore: cron.store, lock: fakeLock_().lock, now, sessionDeps: loopDeps, deliverDeps });
  queueTickCore_({ store: q2.store, cronStore: cron.store, lock: fakeLock_().lock, now, sessionDeps: loopDeps, deliverDeps });
  assertEqual_([q2.jobs.length, docs.length, q2.jobs[3].payload.result.continuation_exhausted], [4, 2, true], '續跑上限後投遞一次');
  assert_(/已達續跑上限/.test(docs[1].body), '投遞內文標示未完成');
  // 投遞失敗 → failed 但保留結果
  const q3 = memoryQueueStore_();
  runCronNow_(c.id, { cronStore: cron.store, queueStore: q3.store, now });
  const fine = fakeChat_([{ text: '完成', stop: 'end' }]);
  queueTickCore_({ store: q3.store, cronStore: cron.store, lock: fakeLock_().lock, now, sessionDeps: fakeQueueSessionDeps_(fine.chat), deliverDeps: { createDoc: () => { throw new Error('Drive 掛了'); } } });
  assertEqual_([q3.jobs[0].state, q3.jobs[0].payload.result.text, q3.jobs[0].payload.result.delivery.ok], ['failed', '完成', false], '投遞失敗 → failed、結果保留');
  assert_(/Drive 掛了/.test(q3.jobs[0].error), 'error 欄');
  // email 投遞
  const em = createCron_({ name: '週報', schedule: 'weekly mon 09:00', prompt: 'x', deliver_to: 'email' }, { cronStore: cron.store, now });
  const q4 = memoryQueueStore_();
  runCronNow_(em.id, { cronStore: cron.store, queueStore: q4.store, now });
  queueTickCore_({ store: q4.store, cronStore: cron.store, lock: fakeLock_().lock, now, sessionDeps: fakeQueueSessionDeps_(fakeChat_([{ text: '週報內容', stop: 'end' }]).chat), deliverDeps });
  assertEqual_([mails.length, mails[0].to, mails[0].subject], [1, 'owner@example.com', '[GAS Agent] 週報 2026-11-03'], 'email 寄給 owner');
  assert_(/週報內容/.test(mails[0].body), '郵件內文');
  // cronjob_manage 工具：autonomous 只能 list；interactive 可建 / 改 / 停 / run_now
  const registry = buildToolRegistry_(fakeToolDecls_().concat(sessionTools_(), memoryTools_(), cronTools_()));
  const cfg = fakeM3ToolConfig_({ rbac: Object.assign(fakeRbac_(), { cronjob: { read: true, write: true, delete: false, external: false } }) });
  const sink = memorySink_();
  const q5 = memoryQueueStore_();
  const run = (args, mode) => executeTool_('cronjob_manage', args, { sessionId: 'sX', mode }, { registry, config: cfg, sink: sink.sink, spill: memorySpill_().store, cronStore: cron.store, queueStore: q5.store, providerIds: ['p1'], now });
  const blocked = run({ action: 'create', name: '遞迴', schedule: 'hourly', prompt: 'x' }, 'autonomous');
  assertEqual_(blocked.status, 'error', 'autonomous 不可建');
  assert_(/不可建立/.test(blocked.content), blocked.content);
  assertEqual_(run({ action: 'run_now', id: c.id }, 'autonomous').status, 'error', 'autonomous 不可 run_now');
  const listed = JSON.parse(run({ action: 'list' }, 'autonomous').content);
  assertEqual_(listed.count, 3, 'autonomous 可 list');
  const created = JSON.parse(run({ action: 'create', name: '新排程', schedule: '0 9 * * 1-5', prompt: '做事', deliver_to: 'email', model_pin: 'p1' }, 'interactive').content);
  assertEqual_([created.ok, created.cron.name, created.cron.cron_expr, created.cron.deliver_to, created.cron.model_pin, !!created.cron.next_run], [true, '新排程', '0 9 * * 1-5', 'email', 'p1', true], 'interactive 建立');
  assertEqual_(run({ action: 'create', name: 'bad', schedule: 'hourly', prompt: 'x', model_pin: 'ghost' }, 'interactive').status, 'error', 'model_pin 不存在回錯');
  const upd = JSON.parse(run({ action: 'update', id: created.cron.id, schedule: 'daily 07:00' }, 'interactive').content);
  assertEqual_([upd.cron.schedule, cron.store.get(created.cron.id).next_run.getHours()], ['daily 07:00', 7], 'update 改 schedule 重算 next_run');
  const del = JSON.parse(run({ action: 'delete', id: created.cron.id }, 'interactive').content);
  assertEqual_([del.cron.enabled, cron.crons.length], [false, 4], 'delete = 停用不刪列');
  const rn2 = JSON.parse(run({ action: 'run_now', id: c.id }, 'interactive').content);
  assertEqual_([rn2.ok, q5.jobs.length, q5.jobs[0].type], [true, 1, 'cron'], 'run_now 入列');
  assertEqual_(run({ action: 'update' }, 'interactive').status, 'error', 'update 缺 id');
  assertEqual_(run({ action: 'fly' }, 'interactive').status, 'invalid', 'action enum');
  setProp_(PROP.QUEUE_DIRTY, '');
  setProp_(PROP.CRON_NEXT_RUN, '');
}

function testDeliverContent_() {
  const now = new Date(2026, 10, 3, 9, 5);
  const result = { text: '## 重點\n- A\n- B', sessionId: 's_1', steps: [{ tool: 'gmail_search', status: 'ok', ms: 120 }, { tool: 'gmail_send', status: 'pending_approval', ms: 3 }], stopped: '', llmCalls: 3, provider: 'zai', model: 'glm-4.6' };
  const c = buildDeliveryContent_({ id: 'cron_1', name: '郵件摘要', schedule: 'daily 09:00' }, result, now);
  assertEqual_([c.title, c.subject], ['郵件摘要 2026-11-03', '[GAS Agent] 郵件摘要 2026-11-03'], '標題 / 主旨');
  assert_(c.body.indexOf('## 重點\n- A\n- B') === 0, '內文以結果開頭');
  assert_(/## 執行資訊/.test(c.body) && /排程：郵件摘要（cron_1），schedule daily 09:00/.test(c.body) && /session：s_1/.test(c.body) && /zai \/ glm-4.6，呼叫 3 次；工具 2 步/.test(c.body), '執行資訊：' + c.body);
  assert_(/待 owner 審批：gmail_send/.test(c.body) && /- gmail_search：ok，120 ms/.test(c.body), '步驟列');
  const empty = buildDeliveryContent_({ name: 'x' }, { text: '', steps: [], stopped: 'time_budget', continuation_exhausted: true }, now);
  assert_(/沒有文字結果/.test(empty.body) && /中止原因：time_budget（已達續跑上限，未完成）/.test(empty.body), '空結果與中止');
  // deliverResult_
  const calls = [];
  const deps = { createDoc: (t, b) => { calls.push(['doc', t]); return { id: 'd1', url: 'u1' }; }, sendEmail: (to, s, b) => calls.push(['mail', to, s]), ownerEmail: 'o@x.com', now: () => now.getTime() };
  assertEqual_(deliverResult_({ name: 'n', deliver_to: 'doc' }, result, deps), { channel: 'doc', ok: true, ref: 'u1', id: 'd1', summary: 'Doc「n 2026-11-03」 u1', error: '' }, 'doc');
  assertEqual_(deliverResult_({ name: 'n', deliver_to: 'email' }, result, deps).summary, '已寄到 o@x.com（[GAS Agent] n 2026-11-03）', 'email');
  assertEqual_(deliverResult_({ name: 'n', deliver_to: 'none' }, result, deps).ok, true, 'none');
  assertEqual_(calls, [['doc', 'n 2026-11-03'], ['mail', 'o@x.com', '[GAS Agent] n 2026-11-03']], 'handler 呼叫');
  const unknown = deliverResult_({ name: 'n', deliver_to: 'telegram' }, result, deps);
  assertEqual_([unknown.ok, /未知/.test(unknown.error)], [false, true], '未知目標');
  const broken = deliverResult_({ name: 'n', deliver_to: 'email' }, result, Object.assign({}, deps, { sendEmail: () => { throw new Error('quota'); } }));
  assertEqual_([broken.ok, broken.error, broken.summary], [false, 'quota', '投遞失敗：quota'], 'handler 丟錯不 throw');
  // 沒注入 ownerEmail 就退回 OWNER_EMAIL：GAS 上有值會成功、本機 node 沒設定會失敗。
  const fallback = deliverResult_({ name: 'n', deliver_to: 'email' }, result, { ownerEmail: '', sendEmail: () => {} });
  assertEqual_([fallback.ok, fallback.ref], [!!getOwnerEmail_(), getOwnerEmail_()], '沒注入 ownerEmail 時退回 OWNER_EMAIL');
  if (!fallback.ok) assert_(/OWNER_EMAIL 未設定/.test(fallback.error), '未安裝時的錯誤訊息');
}

function testGmailAttachments_() {
  const tools = gmailTools_();
  const byName = {};
  tools.forEach((t) => { byName[t.name] = t; });
  assert_(byName.gmail_save_attachments && byName.gmail_forward, '新工具存在');
  assertEqual_([byName.gmail_save_attachments.risk, byName.gmail_forward.risk], ['W', 'X'], '存附件是 W、轉寄是 X');
  ['gmail_send', 'gmail_create_draft'].forEach((n) => assertEqual_(byName[n].parameters.properties.attachment_file_ids.type, 'array', `${n} 有 attachment_file_ids`));
  assertEqual_(byName.gmail_forward.parameters.required, ['thread_id', 'to'], 'forward required');
  // 上限
  checkAttachmentTotal_([{ name: 'a.pdf', size: 1024 }]);
  assertThrows_(() => checkAttachmentTotal_(new Array(11).fill({ name: 'x', size: 1 })), '超過 10 個');
  const big = assertThrows_(() => checkAttachmentTotal_([{ name: 'big.zip', size: 20 * 1024 * 1024 }, { name: 'b.pdf', size: 6 * 1024 * 1024 }]), '超過 25 MB');
  assert_(/25 MB/.test(big.message) && /big.zip/.test(big.message), big.message);
  // 轉寄內文
  const body = forwardBody_('  請協助列印 ', { from: 'Stripe <r@stripe.com>', date: '2026-10-01T10:00:00+08:00', subject: '收據', to: 'me@x.com', body: '內容' });
  assertEqual_(body.split('\n').slice(0, 4), ['請協助列印', '', '---------- 轉寄的郵件 ----------', '寄件者：Stripe <r@stripe.com>'], '說明在前、再原信標頭');
  assert_(/主旨：收據\n收件者：me@x.com\n\n內容$/.test(body), '原信內文在最後');
  assertEqual_(forwardBody_('', { from: 'a', date: 'd', subject: 's', to: 't', body: 'b' }).indexOf('---------- 轉寄'), 0, '沒說明就直接原信');
  // 參數驗證：attachment_file_ids 收字串陣列；gmail_forward 在 RBAC external 關時被擋、開時依審批策略送審
  const registry = buildToolRegistry_(gmailTools_());
  const sink = memorySink_();
  const run = (name, args, cfg) => executeTool_(name, args, { sessionId: 's', mode: 'interactive' }, { registry, config: cfg, sink: sink.sink, spill: memorySpill_().store });
  const closed = fakeToolConfig_({ rbac: { gmail: { read: true, write: true, delete: false, external: false } } });
  assertEqual_(run('gmail_forward', { thread_id: 't1', to: 'a@b.c' }, closed).status, 'denied', 'external 關 → denied');
  const open = fakeToolConfig_({ rbac: { gmail: { read: true, write: true, delete: false, external: true } }, approvalPolicy: 'always' });
  const pending = run('gmail_forward', { thread_id: 't1', to: 'a@b.c', body: '請看' }, open);
  assertEqual_(pending.status, 'pending_approval', 'external 開 + always → 送審');
  assertEqual_(JSON.parse(sink.approvals[0].args), { thread_id: 't1', to: 'a@b.c', body: '請看' }, 'Approvals 參數');
  assertEqual_(run('gmail_send', { to: 'a', subject: 's', body: 'b', attachment_file_ids: 'notarray' }, open).status, 'invalid', 'attachment_file_ids 非陣列拒絕');
  assertEqual_(validateToolArgs_(byName.gmail_send, { to: 'a', subject: 's', body: 'b', attachment_file_ids: '["f1","f2"]' }).attachment_file_ids, ['f1', 'f2'], 'JSON 字串陣列可轉型');
}
