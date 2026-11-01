# GAS Agent

跑在 Google Apps Script（GAS）上的個人 agent，精神原型是 [hermes-agent](https://github.com/nousresearch/hermes-agent)：
零伺服器、常駐於自己的 Google 帳號，用 Google Sheet 當長期記憶、Drive 資料夾放技能，
透過只有本人能開的管理頁設定多組 AI provider，並有 Gmail / Drive / Docs / Slides / Sheets / Calendar 工具與排程。

完整規格與里程碑在本機 vault：`~/vault/20-projects/gas-agent.md`。目前進度：**M2 工具與 RBAC**。

## 設計要點

- **純 JavaScript `.gs` + JSDoc，零 npm runtime 依賴**；前端 vanilla JS 單頁。開發只用全域安裝的 `clasp` 同步到 git。
- **安全**：管理頁部署為「以我執行 / 只限我」，後端每個 `google.script.run` 入口第一行 `assertOwner()`；金鑰只進 Script Properties，其他設定放 Sheet。模型不執行自生程式碼，一律白名單工具；每個 toolset 有 RBAC 四開關，外發動作（寄信 / 分享）走審批（見下方「工具與 RBAC」「審批」）。
- **兩個 Web App 部署**（M6 才需要第二個）：管理頁「只限我」；Telegram webhook 另開一個「任何人」部署並在 URL 帶 secret，`doGet` 依 `?src=telegram` 分流，回應用 `HtmlService` 避免 302。
- **Queue runner**：每分鐘 time trigger 跑 `queueTick()`，無 job 時只讀一個 Script Property 就 return，省 trigger 每日 90 分鐘配額。

## 檔案

```
src/
  appsscript.json   # OAuth scopes、webapp 預設（USER_DEPLOYING / MYSELF）、Asia/Taipei、V8
  Config.gs         # Script Properties 封裝、APP_VERSION、REQUIRED_SCOPES、assertOwner()、Config sheet 讀寫
  Db.gs             # 開/建「GAS Agent DB」spreadsheet、DB_SCHEMA（11 個 tab）、幂等補 schema、以表頭為鍵的列讀寫
  Providers.gs      # M1：三個 adapter（openai / anthropic / gemini）、備援鏈、Usage 記錄、runChatTurn_()
  ToolRegistry.gs   # M2：工具宣告 {name, toolset, description, parameters, risk, handler}、無重名檢查、轉中立工具格式
  ToolExecutor.gs   # M2：參數驗證 → RBAC → 審批策略 → 執行 → AuditLog → 溢寫；Config 設定讀寫；Approvals 決定
  Tools_Drive.gs  Tools_Docs.gs  Tools_Sheets.gs  Tools_Slides.gs
  Tools_Gmail.gs  Tools_Calendar.gs  Tools_Web.gs  Tools_Session.gs   # M2：八個 toolset 的 handler
  Agent.gs          # M2：runTurn_() 工具呼叫迴圈、system prompt、步數 / 時間 / 熔斷
  Queue.gs          # queueTick() 空殼（M4 放 job 狀態機）
  Setup.gs          # installAgent()：寫 OWNER_EMAIL、建 DB、裝每分鐘 trigger、補工具設定預設值（可重跑）
  Admin.gs          # doGet 路由 + admin* 後端入口
  AdminPage.html / admin_js.html / admin_css.html   # 管理頁 SPA（檔名避開與 Admin.gs 撞名）
  Doctor.gs         # runDoctor()：Properties / tabs / trigger / scopes / 時區 / provider / 工具 registry 與 RBAC 健檢
  Tests.gs          # runSmokeTests()：M0 10 項 + M1 11 項 + M2 14 項；標 'pure' 的可在本機跑
scripts/local-tests.js   # node 跑 Tests.gs 的 pure 測試（stub 掉 GAS 全域物件），push 前先驗
.clasp.json.example # clasp 綁定範本（.clasp.json 本身不進 git）
```

## 安裝

### 0. 前置

- Node.js 與 `clasp` 3.x：`npm i -g @google/clasp`
- 到 <https://script.google.com/home/usersettings> 開啟「Google Apps Script API」

### 1. 登入與綁定

```bash
clasp login
```

```bash
clasp show-authorized-user
```

第一次 clone 這個 repo 時把範本複製成 `.clasp.json`（scriptId 已填好；若要建自己的專案，改用 `clasp create-script --type standalone --title "GAS Agent" --rootDir src`）：

```bash
cp .clasp.json.example .clasp.json
```

### 2. 推送程式碼

```bash
clasp push
```

第一次 push 會問是否覆寫 manifest（`appsscript.json`），回答 yes；或直接 `clasp push -f`。

### 3. 在編輯器執行 `installAgent()` 並授權

```bash
clasp open-script
```

1. 在 Apps Script 編輯器上方選擇函式 `installAgent`，按「執行」。
2. Google 會跳出授權畫面，列出 `appsscript.json` 的全部 scopes（Drive、Docs、Sheets、Slides、Gmail、Calendar、外部連線、trigger、email），以本人帳號核准。
   未驗證應用程式會出現警告，點「進階 → 前往 GAS Agent（不安全）」即可，這是自己的 script。
3. 執行紀錄會印出 JSON：`owner`、DB spreadsheet 的 `url`、`schema.createdTabs`（第一次應為 11 個 tab）、`trigger.created: true`。
4. 重跑 `installAgent()` 是安全的：不會重建 DB、不會多裝 trigger，只補缺的 tab / 欄位。

可順手執行 `runDoctor()` 與 `runSmokeTests()`，在執行紀錄看結果。

### 4. 部署管理頁（部署 A）

編輯器右上「部署 → 新增部署作業」：

| 欄位 | 值 |
|---|---|
| 類型 | 網頁應用程式 |
| 執行身分 | **我** |
| 具有存取權的使用者 | **只有我自己** |

部署後複製「網頁應用程式 URL」。**這個 URL 綁定某一個版本號**：之後 `clasp push` 只更新編輯器裡的程式碼，線上頁面不會變。要讓線上更新，用既有部署 ID 推新版本（URL 不變）：

```bash
clasp deployments
```

```bash
clasp deploy -i <deploymentId> -d "說明"
```

> 不要再按「新增部署作業」或 `clasp deploy` 不帶 `-i`：那會產生**另一個** URL，舊 URL 永遠停在舊版本（且保留當時的存取權設定）。多出來的舊部署請到「管理部署作業」封存，或 `clasp undeploy <deploymentId>`。
>
> 用 `clasp deploy -i` 更新時，Web App 的「執行身分 / 存取權」會依 `appsscript.json` 的 `webapp` 區段（USER_DEPLOYING / MYSELF）設定。

### 5. 打開管理頁，看 Doctor

用本人 Google 帳號開「網頁應用程式 URL」→ 左側「Doctor」分頁。全部綠燈代表 M0 完成：

- OWNER_EMAIL / DB_SPREADSHEET_ID 已設定
- DB spreadsheet 可開啟，11 個 tab 表頭完整
- 每分鐘 trigger 恰好 1 支
- 已授權 scopes 涵蓋 `appsscript.json`
- 時區 Asia/Taipei；Web App 已部署（黃燈僅提醒）

驗收另一半：用另一個 Google 帳號開同一 URL，應被 Google 擋在登入 / 權限頁，看不到管理頁。

## 設定 provider（M1）

模型設定存在 DB 的 `Providers` tab，**API key 只進 Script Properties `PROVIDER_KEY_<id>`**，管理頁寫入後只顯示末 4 碼，不進 sheet、不進 repo。全部在管理頁「模型」分頁操作，不用手改 sheet。

### 欄位

| 欄位 | 說明 |
|---|---|
| `id` | 小寫字母 / 數字 / `_` / `-`，存檔後不可改（key 綁 `PROVIDER_KEY_<id>`） |
| `protocol` | `openai`（chat/completions 相容：OpenAI、OpenRouter、Z.ai GLM、DeepSeek…）/ `anthropic`（Messages API）/ `gemini`（generateContent） |
| `base_url` | `openai`：到 `/v1` 層級為止，程式接 `/chat/completions`；`anthropic` / `gemini`：只到網域，程式接 `/v1/messages`、`/v1beta/models/<model>:generateContent` |
| `model` | 模型名 |
| `role` | `main` 主模型 / `fast` 快模型（之後摘要、curation 用）/ `embed` 嵌入（M3） |
| `priority` | 同角色依數字由小到大組成**備援鏈** |
| `enabled` | 停用的不進備援鏈 |
| `extra_headers` | JSON，額外 HTTP header（OpenRouter 的 `HTTP-Referer` / `X-Title` 等） |
| `extra_body` | JSON，合併進請求 body；值為 `null` 可移除程式預設帶的欄位（例如 `{"max_tokens": null}`） |
| `max_tokens` | 回覆上限。**建議一定要設**：GAS 的 UrlFetch 不能設 timeout、單次執行上限 6 分鐘 |
| `cost_in_per_m` / `cost_out_per_m` | 選填，USD / 百萬 tokens，用來算 `Usage.cost_est`；沒填就 0 |

### 備援鏈

聊天台選「自動」時走 `main` 角色的備援鏈：第一個失敗就換下一個，直到成功。會換下一個的情況：key 未設定、網路例外、HTTP 401 / 403（key 失效）、408 / 429（忙）、5xx。**HTTP 400 / 404 / 422 等「請求本身有問題」不會換**，直接回錯。每次嘗試（成功或失敗）都寫一列 `Usage`（`ok` 欄），失敗另寫 `AuditLog`（`tool=llm:<id>`）方便查原因。

### 範例：Z.ai GLM（coding plan）

| 欄位 | 值 |
|---|---|
| id | `zai-glm` |
| protocol | `openai` |
| base_url | `https://api.z.ai/api/coding/paas/v4` |
| model | `glm-4.6` |
| role / priority | `main` / `10` |
| max_tokens | `4096` |
| extra_body | `{"thinking": {"type": "disabled"}}` |

> Z.ai coding plan 的 key **只能打這個 coding endpoint**，拿去打官方 `open.bigmodel.cn` 的一般 endpoint 會 401。GLM 系列預設會開 thinking，推理一長就可能撞到 GAS 6 分鐘上限，所以用 `extra_body` 關掉，或至少把 `max_tokens` 設低。

### 範例：Anthropic / Gemini（當備援與 fast 角色）

| 欄位 | Anthropic | Gemini |
|---|---|---|
| protocol | `anthropic` | `gemini` |
| base_url | `https://api.anthropic.com` | `https://generativelanguage.googleapis.com` |
| model | `claude-sonnet-4-5` 等 | `gemini-2.5-flash` 等 |
| 備註 | `max_tokens` 必填，沒設程式用 1024 | key 走 `x-goog-api-key` header，不進 URL |

管理頁「新增 provider」有這幾個範本可一鍵帶入，再貼上 key 儲存即可。

### 驗證

1. 「模型」分頁每列有「測試連線」：送一句極短訊息，回延遲、tokens 與回覆。
2. 「聊天台」選特定 provider 或「自動」對話；回覆下方顯示實際回答的 provider / model、tokens、耗時，若有備援會列出被跳過的原因。
3. Doctor 新增兩項：至少一個啟用的 `main` provider、其 key 已設定。
4. 驗收備援：把 priority 最小的 main provider 的 key 清掉（編輯 → 清除 key），聊天台選「自動」送訊息，應由下一個回答並顯示「備援：…API key 未設定」。

## 工具與 RBAC（M2）

模型只能透過白名單工具做事，不執行任何自生程式碼。每個工具在 `ToolRegistry.gs` 宣告 `{name, toolset, description, parameters(JSON Schema), risk, handler}`，風險等級 **R 讀 / W 寫 / D 刪 / X 外發**。全部工具用內建服務（DriveApp / DocumentApp / SpreadsheetApp / SlidesApp / GmailApp / CalendarApp / UrlFetchApp），不開 advanced services。

### 工具清單

| toolset | 工具（風險） |
|---|---|
| drive | `drive_search`(R) `drive_list`(R) `drive_read_text`(R，Docs / Sheets / Slides / 純文字 / PDF OCR) `drive_create_folder`(W) `drive_move`(W) `drive_rename`(W) `drive_export_pdf`(W) `drive_share`(**X**) |
| docs | `docs_create`(W) `docs_read`(R) `docs_append`(W) `docs_replace_text`(W) `docs_insert_table`(W) `docs_outline`(R) |
| sheets | `sheets_create`(W) `sheets_read_range`(R) `sheets_write_range`(W) `sheets_append_rows`(W) `sheets_set_formula`(W) `sheets_add_chart`(W) |
| slides | `slides_create_deck`(W，一次收整份 deck；類型 title / section / content / two_column / quote / closing，上限 40 頁) `slides_read`(R) `slides_add_slide`(W) `slides_replace_text`(W) |
| gmail | `gmail_search`(R) `gmail_read_thread`(R) `gmail_create_draft`(W) `gmail_send`(**X**) `gmail_label`(W) `gmail_archive`(W) —— **沒有任何刪除工具** |
| calendar | `calendar_list_events`(R) `calendar_create_event`(W，不寄邀請) `calendar_update_event`(W) |
| web | `web_fetch`(R，域名白名單；HTML 轉純文字並截長) |
| session | `session_spill_read`(R，分頁讀溢寫檔) |

M2 沒有任何 D 類工具（刻意不開放刪除）。`docs_create` / `docs_append` 的內容支援輕量 markdown（`#` / `##` / `###` 標題、`-` 項目、`1.` 編號、空行分段）。每個讀取類工具都有筆數 / 字元上限（搜尋 ≤ 50 筆、郵件 ≤ 25 串、內文 ≤ 20000 字…），避免撐爆 context 與 6 分鐘限制。

### 執行流程（`ToolExecutor.gs executeTool_`）

每個工具呼叫依序：

1. **工具存在**（否則回 `unknown_tool`）。
2. **參數驗證**：required 齊全、**未宣告的頂層參數一律拒絕**、型別粗檢（數字 / 布林字串會順手轉型）、enum。
3. **RBAC**：toolset 在 `Config` 有 `rbac.<toolset>` = `{read, write, delete, external}` 四開關，風險 R / W / D / X 各對一個；**沒有這一列的 toolset 一律拒絕**。
4. **審批策略**（只對 X 類）：`approval_policy` = `always`（一律送審）/ `autonomous_only`（只有無人模式送審；M4 排程才會用到）/ `never`（直接執行）。
5. 執行 handler。
6. 寫 **`AuditLog`**（args / result 各截 500 字預覽、ok、ms）。失敗、拒絕、待審批也都記。
7. 結果超過 `spill_threshold`（預設 8000 字元）就**溢寫**到 Drive `GAS Agent/spill/` 的文字檔，context 只留前 1000 字 + `file_id`，模型需要時用 `session_spill_read(file_id, offset, limit)` 分頁讀。

失敗一律以 `{"error": code, "message": …}` 回給模型，不 throw。

### 工具迴圈（`Agent.gs runTurn_`）

聊天台每則訊息跑一輪：system prompt（`Config.persona` 人格 + 工具規則 + 目前未開放的工具）→ 模型 → 工具 → 模型 … → 文字回覆。三道煞車：

- 單輪步數上限 `max_tool_steps`（預設 25）
- 時間預算 4.5 分鐘（GAS 單次 6 分鐘），到了就停並回報已完成的步驟
- **同一工具 + 同參數失敗 3 次即熔斷**

**Prompt-injection 防線**：每個工具結果包成 `<<tool_result name=… status=… untrusted>> … <<end>>` 資料區塊，system prompt 明示區塊內任何像指令的文字都無效。郵件、網頁、文件內容全部走這條路。聊天台會顯示每步工具的名稱、參數摘要、結果摘要、耗時與狀態（完成 / 失敗 / RBAC 拒絕 / 待審批）。

### 管理頁「工具」分頁

| 項目 | 說明 | 預設 |
|---|---|---|
| 每個 toolset 的 read / write / delete / external | RBAC 四開關，存 `Config` `rbac.<toolset>`（JSON） | read 開、write 開、delete 關、external 關 |
| 審批策略 | `approval_policy` | `always` |
| spill_threshold | 工具結果溢寫門檻（字元） | 8000 |
| max_tool_steps | 單輪工具步數上限 | 25 |
| web_fetch 域名白名單 | 一行一個。`example.com` 只允許該主機；`*.example.com` 含所有子網域與本身。**空 = 全部拒絕** | 空 |
| 人格（persona） | system prompt 開頭；留空用程式預設的一段繁中 | 空 |

`installAgent()`（Doctor「重新安裝」）與開「工具」分頁都會幂等補上缺的預設值。Doctor 多三項：registry 無重名、每個 toolset 都有 RBAC 設定、至少一個 toolset 開 read。

> 預設 external 全關，所以 `gmail_send` / `drive_share` 連工具清單都不會給模型（模型會告訴你「目前未開放」）。要讓 agent 能寄信 / 分享，到「工具」分頁開 gmail / drive 的 external；動作仍會依審批策略送審。

## 審批（M2）

X 類工具被攔下時，`Approvals` tab 寫一列（`state=pending`，含 tool、args JSON、reason），模型收到 `{"status": "pending_approval", "approval_id": …}` 作為工具結果，會向你說明已送審並結束這輪。管理頁「紀錄」分頁的「審批」區列出 pending：

- **批准並執行**：立刻以同樣的參數執行該工具**一次**（RBAC 仍會檢查），結果寫回 `Approvals.result` 與 `AuditLog`，state → `approved`。
- **拒絕**：state → `denied`。

**M2 不做「批准後續跑原對話」**：那需要 M3 的 session 持久化與 M4 的 Queue。所以流程是「agent 準備好草稿 → 要寄出時停在審批 → 你在紀錄分頁批准 → 信寄出」，agent 不會再回來跟你說「已寄出」；要確認就看審批卡片的執行結果。同一輪裡模型若重複要求同一個被攔的動作，不會再寫第二筆。

「紀錄」分頁下方同時列最近 50 筆 `AuditLog`（每次工具執行一列，失敗列紅底）。

### M2 驗收步驟（請在瀏覽器操作）

1. Doctor → 「重新安裝」（`Approvals` 多了 `result` 欄、`Config` 要補 RBAC 預設值）→ Doctor 全綠（含新的三項）→ 「跑 smoke tests」35 項全過。
2. 「工具」分頁確認八個 toolset 都有開關；要測寄信審批就把 **gmail 的 external 打開**，儲存。
3. 「聊天台」輸入：`找出上週收到關於 X 的信，整理成一份 Doc，並草擬回信`（X 換成真實主題）。預期回覆上方顯示 `gmail_search` → `gmail_read_thread` → `docs_create` → `gmail_create_draft` 等步驟，回覆附 Doc 連結與草稿摘要。
4. 接著輸入 `把那封回信寄出`。預期出現 `gmail_send` 步驟標「待審批」，回覆說明已送審。到「紀錄」分頁看到 pending 卡片；按「拒絕」（或「批准並執行」真的寄出）。
5. 「紀錄」的 AuditLog 應有上述每一步。

## 開發流程

```bash
clasp push
```

```bash
clasp status
```

```bash
node scripts/local-tests.js
```

- 編輯 `src/` 下的檔案 → `node scripts/local-tests.js`（pure 測試，不碰 Google 服務）→ `clasp push` → `clasp deploy -i <deploymentId> -d "…"` → 用管理頁 URL 驗證 → `git commit`。只在編輯器測函式時可省略 deploy。
- `clasp push -w` 可監看自動推送。
- 改 `appsscript.json` 的 scopes 時，`Config.gs` 的 `REQUIRED_SCOPES` 要同步，並重新執行 `installAgent()` 以觸發重新授權。
- 不要把 `.clasp.json`（含 scriptId）以外的任何金鑰放進 repo；金鑰只進 Script Properties。

## 疑難排解

| 現象 | 處理 |
|---|---|
| `clasp push` 回 `User has not enabled the Apps Script API` | 到 <https://script.google.com/home/usersettings> 開啟 API，等一分鐘重試 |
| 管理頁顯示「尚未安裝」 | 回編輯器執行 `installAgent()` |
| Doctor「scopes」紅燈 | 在編輯器重新執行 `installAgent()`，讓 Google 重新要求授權 |
| Doctor「trigger」顯示 0 支 | 執行 `installAgent()`；若要清掉重裝可先 `removeAgentTriggers()` |
| `installAgent()` 說 owner 不符 | 這個 script 已綁別的帳號；到「專案設定 → 指令碼屬性」刪 `OWNER_EMAIL` 再執行 |
| 側欄分頁點了整頁空白、網址變成 `…script.googleusercontent.com/userCodeAppPanel#/…` | 線上是舊版本：`clasp deploy -i <deploymentId>` 推新版本。根因是 HtmlService 注入 `<base target="_top">`，導航已改為 `preventDefault` + 自設 `location.hash` |
| 沒登入的瀏覽器也看得到管理頁 | 該部署存取權被設成「任何人」。「以我執行」下 `getEffectiveUser()` 永遠是 owner，`assertOwner()` 因此改用 `getActiveUser()`（匿名為空字串即拒絕）；仍請把部署改回「只有我自己」 |
| DB 被誤刪 | `installAgent()` 偵測到檔案在垃圾桶會建新的；要救回舊資料請先從垃圾桶還原再執行 |
| 升到 M1 後 Doctor 說 `Providers` / `Usage` tab 缺欄位 | 新版本加了欄位：Doctor 分頁按「重新安裝」（或編輯器執行 `installAgent()`）往右補欄，既有資料不動 |
| 測試連線 / 聊天台等很久才回錯 | UrlFetch 無法設 timeout；請把該 provider 的 `max_tokens` 調低、GLM 類在 `extra_body` 關 thinking |
| Z.ai 回 401 | coding plan 的 key 只能打 `https://api.z.ai/api/coding/paas/v4`，不能打 bigmodel.cn 一般 endpoint |
| 聊天台選「自動」回「沒有可用的 provider」 | 沒有 enabled 的 `main` provider；到「模型」分頁新增或啟用 |
| 聊天台說某工具「目前未開放」/ 步驟顯示「RBAC 拒絕」 | 該 toolset 的對應開關關著（預設 external 全關）。到「工具」分頁開啟並儲存；Doctor 若說「缺 rbac」就按「重新安裝」 |
| `web_fetch` 回「白名單是空的」 | 到「工具」分頁填 `web_fetch 域名白名單`（一行一個） |
| 聊天台跑了很久才回「系統中止：已達單輪時間預算」 | 一輪工具太多或某個工具（PDF OCR、大試算表）太慢。拆成幾則訊息下指令，或調低讀取類工具的 max_* 參數 |
| 回覆說「同一工具以相同參數連續失敗 3 次，已熔斷」 | 看回覆上方該步的結果摘要（通常是參數錯或找不到 id），修正後重下 |
| 升到 M2 後 Doctor 說 `Approvals` 缺欄位 / 缺 rbac | 按「重新安裝」補 `result` 欄與 RBAC 預設值 |

## 里程碑

- [x] M0 骨架：repo + clasp、scopes、`installAgent()`、管理頁空殼、Doctor、smoke tests
- [x] M1 多 provider（OpenAI 相容 / Anthropic / Gemini）、備援鏈、Usage、模型分頁、聊天台（單輪、同步）
- [x] M2 工具與 RBAC（八個 toolset、registry / executor、審批、溢寫、工具迴圈、工具 / 紀錄分頁）—— 批准後續跑對話留到 M3/M4
- [ ] M3 記憶（Memory / UserProfile、context 壓縮、session_search）
- [ ] M4 排程與非同步 Queue
- [ ] M5 技能（Drive `skills/`）
- [ ] M6 通道（Telegram webhook 部署 B、Email 指令信）
- [ ] M7 加固與維運
