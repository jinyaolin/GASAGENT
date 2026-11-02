# GAS Agent

跑在 Google Apps Script（GAS）上的個人 agent，精神原型是 [hermes-agent](https://github.com/nousresearch/hermes-agent)：
零伺服器、常駐於自己的 Google 帳號，用 Google Sheet 當長期記憶、Drive 資料夾放技能，
透過只有本人能開的管理頁設定多組 AI provider，並有 Gmail / Drive / Docs / Slides / Sheets / Calendar 工具與排程。

完整規格與里程碑在本機 vault：`~/vault/20-projects/gas-agent.md`。目前進度：**M6 通道程式完成，待本人驗收；之後 M7 加固與維運**。

## 設計要點

- **純 JavaScript `.gs` + JSDoc，零 npm runtime 依賴**；前端 vanilla JS 單頁。開發只用全域安裝的 `clasp` 同步到 git。
- **安全**：管理頁部署為「以我執行 / 只限我」，後端每個 `google.script.run` 入口第一行 `assertOwner()`；金鑰只進 Script Properties，其他設定放 Sheet。模型不執行自生程式碼，一律白名單工具；每個 toolset 有 RBAC 四開關，外發動作（寄信 / 分享）走審批（見下方「工具與 RBAC」「審批」）。
- **兩個 Web App 部署**：管理頁「只限我」（部署 A）；Telegram webhook 另開一個「任何人」部署（部署 B）並在 URL 帶 secret，`doGet` / `doPost` 依 `?src=telegram` 分流，回應用 `HtmlService` 避免 302。存取等級寫在 manifest 裡、每個版本只能一種，所以用 `scripts/deploy.sh` 翻轉 manifest 分別推兩個版本（見「通道」）。
- **Queue runner**：每分鐘 time trigger 跑 `queueTick()`，無 job 且沒有排程到期時只讀兩個 Script Property（`QUEUE_DIRTY` / `CRON_NEXT_RUN`）就 return，省 trigger 每日 90 分鐘配額。長任務每 4.5 分鐘 checkpoint 一次由續跑 job 接手（見「Queue 與排程」）。

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
  Tools_Cron.gs     # M4：cronjob_manage 宣告（toolset cronjob）
  Tools_Skills.gs   # M5：skill_load / skill_manage 宣告（toolset skill；skill_manage 帶 proposal hook）
  Skills.gs         # M5：Drive skills 資料夾 store、SKILL.md frontmatter 解析、索引快取、注入區塊、提案 / 自動提案、內建範例技能
  Channels.gs       # M6：通道設定（Config）、job 結束後依 channel 投遞回覆
  Channels_Telegram.gs  # M6：doPost webhook 入口、secret / 白名單驗證、/new /status /model /skills、排 Queue、審批 inline button、setWebhook
  Channels_Email.gs     # M6：Gmail 標籤掃描（EMAIL_NEXT_SCAN 旗標）、指令內文清理、thread 回覆
  Agent.gs          # M2：runTurn_() 工具呼叫迴圈、system prompt、步數 / 時間 / 熔斷
  Sessions.gs       # M3：Sessions / Messages 持久化、CacheService 熱快取、context 壓縮、/new、runSessionTurn_()
  Memory.gs         # M3：Memory / UserProfile 上限與快照、memory_manage、session_search、curation
  Queue.gs          # M4：job 狀態機、LockService、queueTick()、checkpoint 續跑、turn / cron / continuation / curation runner
  Cron.gs           # M4：schedule 解析（5 欄 cron + 捷徑）、computeNextRun_、Cron store、到期掃描、cronjob_manage handler
  Deliver.gs        # M4：cron 結果投遞（doc / email / none）
  Setup.gs          # installAgent()：寫 OWNER_EMAIL、建 DB、裝每分鐘 trigger、補工具設定預設值、對齊 CRON_NEXT_RUN、寫入內建技能（可重跑）
  Admin.gs          # doGet 路由 + admin* 後端入口
  AdminPage.html / admin_js.html / admin_css.html   # 管理頁 SPA（檔名避開與 Admin.gs 撞名）
  Doctor.gs         # runDoctor()：Properties / tabs / trigger / scopes / 時區 / provider / 工具 RBAC / 記憶容量 / session / Queue / Cron / 技能健檢
  Tests.gs          # runSmokeTests()：M0 10 項 + M1 11 項 + M2 14 項 + M3 9 項 + M4 6 項 + M5 6 項 + M6 4 項；標 'pure' 的可在本機跑
scripts/local-tests.js   # node 跑 Tests.gs 的 pure 測試（stub 掉 GAS 全域物件），push 前先驗
scripts/deploy.sh        # M6：跑測試 → push → 更新部署 A（只限我）→ 翻 manifest 推部署 B（任何人）→ 翻回；--account 選帳號
scripts/install.sh       # 一鍵安裝到新 Google 帳號（登入 → 建專案 → push → 授權提示 → 建部署 A / B → 寫 accounts/<name>/）
scripts/add-webhook.sh   # 幫既有帳號補建部署 B
scripts/lib.sh           # 以上三支共用（帳號設定檔、manifest 翻轉、clasp -u 包裝）
accounts/<name>/         # 每個 Google 帳號的 clasp.json（scriptId）與 deploy.json（部署 ID、網址）；不進 git
.clasp.json.example # clasp 綁定範本（.clasp.json 本身不進 git）
```

## 安裝

### 一鍵安裝到一個 Google 帳號（建議）

```bash
scripts/install.sh --account <代號>
```

`<代號>` 是這個帳號在本機的名字（例 `work`、`family`），同時是 `clasp -u <代號>` 的憑證名；之後更新程式用 `scripts/deploy.sh --account <代號> "說明"`。腳本會：

1. 跑本機 pure 測試。
2. `clasp -u <代號> login`：瀏覽器登入 Google，**選要安裝到的那個 Gmail**。
3. 請你到 <https://script.google.com/home/usersettings> 開「Google Apps Script API」（每個帳號一次；腳本會幫你開網頁，開好按 Enter）。
4. `clasp create-script` 建一個 standalone Apps Script 專案「GAS Agent」並 `push` 全部程式碼。
5. 開編輯器請你**手動執行 `installAgent()` 並按允許**（OAuth 授權畫面只能本人按；未驗證應用程式警告點「進階 → 前往 GAS Agent」即可）。它會建 DB spreadsheet、11 個 tab、每分鐘 trigger、Config 預設值、Drive `GAS Agent/skills` 與兩個內建技能。跑完按 Enter。
6. 建部署 A（管理頁，「以我執行 / 只限我」）與部署 B（Telegram webhook，「任何人」；manifest 翻轉後另推一版再翻回；`--no-webhook` 可略過）。
7. 把 scriptId 與兩個部署 ID 寫進 `accounts/<代號>/{clasp.json,deploy.json}`（**不進 git**），印出管理頁網址與部署 B 網址，以及接下來在管理頁要做的四件事（Doctor → 模型 → 工具 → 通道）。

前置：Node.js、`npm i -g @google/clasp`（3.x）、python3（macOS 內建）。目前這台機器上原本的帳號已遷成 `default`（`accounts/default/`），`scripts/deploy.sh` 不帶 `--account` 就是它。多帳號共用同一個 checkout：所有腳本執行前會把該帳號的 `clasp.json` 複製成根目錄 `.clasp.json`，憑證各自存在 `~/.clasprc.json` 的不同名字下，互不干擾。既有帳號要補部署 B：`scripts/add-webhook.sh --account <代號>`。

### 手動安裝（腳本做不到的環境）

#### 0. 前置

- Node.js 與 `clasp` 3.x：`npm i -g @google/clasp`
- 到 <https://script.google.com/home/usersettings> 開啟「Google Apps Script API」

#### 1. 登入與綁定

```bash
clasp login
```

```bash
clasp show-authorized-user
```

要接到**既有**的專案把範本複製成 `.clasp.json`（scriptId 已填好）；要建自己的專案改用 `clasp create-script --type standalone --title "GAS Agent" --rootDir src`：

```bash
cp .clasp.json.example .clasp.json
```

#### 2. 推送程式碼

```bash
clasp push -f
```

#### 3. 在編輯器執行 `installAgent()` 並授權

```bash
clasp open-script
```

1. 在 Apps Script 編輯器上方選擇函式 `installAgent`，按「執行」。
2. Google 會跳出授權畫面，列出 `appsscript.json` 的全部 scopes（Drive、Docs、Sheets、Slides、Gmail、Calendar、外部連線、trigger、email），以本人帳號核准。
   未驗證應用程式會出現警告，點「進階 → 前往 GAS Agent（不安全）」即可，這是自己的 script。
3. 執行紀錄會印出 JSON：`owner`、DB spreadsheet 的 `url`、`schema.createdTabs`（第一次應為 11 個 tab）、`trigger.created: true`、`skills.installed`。
4. 重跑 `installAgent()` 是安全的：不會重建 DB、不會多裝 trigger，只補缺的 tab / 欄位 / 設定。

可順手執行 `runDoctor()` 與 `runSmokeTests()`，在執行紀錄看結果。

#### 4. 部署管理頁（部署 A）與 webhook（部署 B）

編輯器右上「部署 → 新增部署作業」：類型「網頁應用程式」、執行身分「**我**」、存取權「**只有我自己**」→ 部署 A。部署 B 同樣步驟但存取權「**任何人**」（Telegram webhook 用；注意新編輯器會把這個選擇寫進 `appsscript.json` 的 `webapp.access`，兩個部署要各自建版本）。

**每個 URL 綁定某一個版本號**：之後 `clasp push` 只更新編輯器裡的程式碼，線上頁面不會變。要讓線上更新，用既有部署 ID 推新版本（URL 不變）：

```bash
clasp deployments
```

```bash
clasp deploy -i <deploymentId> -d "說明"
```

> 不要再按「新增部署作業」或 `clasp deploy` 不帶 `-i`：那會產生**另一個** URL，舊 URL 永遠停在舊版本。多出來的舊部署請到「管理部署作業」封存，或 `clasp undeploy <deploymentId>`。
>
> 用 `clasp deploy -i` 更新時，Web App 的「執行身分 / 存取權」依**當時** `appsscript.json` 的 `webapp` 區段；更新部署 B 前要把 `access` 改成 `ANYONE_ANONYMOUS`，更新 A 前改回 `MYSELF`。`scripts/deploy.sh` 就是在做這件事。

### 5. 打開管理頁，看 Doctor

用本人 Google 帳號開「網頁應用程式 URL」→ 左側「Doctor」分頁。全部綠燈代表安裝完成：

- OWNER_EMAIL / DB_SPREADSHEET_ID 已設定
- DB spreadsheet 可開啟，11 個 tab 表頭完整
- 每分鐘 trigger 恰好 1 支
- 已授權 scopes 涵蓋 `appsscript.json`
- 時區 Asia/Taipei；Web App 已部署（黃燈僅提醒）
- 技能資料夾可讀、兩個內建技能可解析

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
| drive | `drive_search`(R) `drive_list`(R) `drive_read_text`(R，Docs / Sheets / Slides / 純文字 / PDF 與圖片 OCR) `drive_create_folder`(W) `drive_move`(W) `drive_rename`(W) `drive_export_pdf`(W) `drive_share`(**X**) |
| docs | `docs_create`(W) `docs_read`(R) `docs_append`(W) `docs_replace_text`(W) `docs_insert_table`(W) `docs_outline`(R) |
| sheets | `sheets_create`(W) `sheets_read_range`(R) `sheets_write_range`(W) `sheets_append_rows`(W) `sheets_set_formula`(W) `sheets_add_chart`(W) |
| slides | `slides_create_deck`(W，一次收整份 deck，可套範本；類型 title / section / content(可左文右圖) / two_column / quote / image / image_full / table / closing，上限 40 頁，項目以 `> ` 開頭為第二層) `slides_read`(R) `slides_add_slide`(W，可指定位置) `slides_update_slide`(W，整頁重寫) `slides_move_slide`(W) `slides_delete_slide`(**D**，預設關) `slides_replace_text`(W，可限單頁) |
| gmail | `gmail_search`(R) `gmail_read_thread`(R) `gmail_save_attachments`(W，附件存到 Drive `GAS Agent/attachments/`) `gmail_create_draft`(W) `gmail_send`(**X**) `gmail_forward`(**X**，轉寄含原附件) `gmail_label`(W) `gmail_archive`(W) —— `send` / `create_draft` 可用 `attachment_file_ids` 附 Drive 檔案（≤ 10 個、25 MB；Google 文件轉 PDF）；**沒有任何刪除工具** |
| calendar | `calendar_list_events`(R) `calendar_create_event`(W，不寄邀請) `calendar_update_event`(W) |
| web | `web_fetch`(R，域名白名單；HTML 轉純文字並截長) |
| session | `session_spill_read`(R，分頁讀溢寫檔) `session_search`(R，M3：搜過去的對話) |
| memory | `memory_manage`(W，M3：add / replace / remove，無 read) |
| cronjob | `cronjob_manage`(W，M4：list / create / update / delete(停用) / run_now；排程任務執行中只能 list) |
| skill | `skill_load`(R，M5：載技能全文) `skill_manage`(W，M5：create / patch **只提案**，owner 批准後才寫入) |

唯一的 D 類工具是 `slides_delete_slide`（刪簡報某一頁；RBAC delete 預設關，要用自己開），Gmail / Drive 沒有任何刪除工具。`docs_create` / `docs_append` 的內容支援輕量 markdown（`#` / `##` / `###` 標題、`-` 項目、`1.` 編號、空行分段）。每個讀取類工具都有筆數 / 字元上限（搜尋 ≤ 50 筆、郵件 ≤ 25 串、內文 ≤ 20000 字…），避免撐爆 context 與 6 分鐘限制。

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
| 審批策略 | `approval_policy`：`autonomous_only` = 只有排程（無人模式）送審，聊天台直接執行 | `always` |
| spill_threshold | 工具結果溢寫門檻（字元） | 8000 |
| max_tool_steps | 單輪工具步數上限 | 25 |
| web_fetch 域名白名單 | 一行一個。`example.com` 只允許該主機；`*.example.com` 含所有子網域與本身。**空 = 全部拒絕** | 空 |
| 人格（persona） | system prompt 開頭；留空用程式預設的一段繁中 | 空 |
| 簡報範本 | `slides_template_id`：一份設好主題 / 配色 / 字型的 Google Slides（id 或網址），`slides_create_deck` 會複製它再填內容 | 空（Google 預設白底） |

`installAgent()`（Doctor「重新安裝」）與開「工具」分頁都會幂等補上缺的預設值。Doctor 多三項：registry 無重名、每個 toolset 都有 RBAC 設定、至少一個 toolset 開 read。

> 預設 external 全關，所以 `gmail_send` / `drive_share` 連工具清單都不會給模型（模型會告訴你「目前未開放」）。要讓 agent 能寄信 / 分享，到「工具」分頁開 gmail / drive 的 external；動作仍會依審批策略送審。

## 審批（M2）

X 類工具被攔下時，`Approvals` tab 寫一列（`state=pending`，含 tool、args JSON、reason），模型收到 `{"status": "pending_approval", "approval_id": …}` 作為工具結果，會向你說明已送審並結束這輪。管理頁「紀錄」分頁的「審批」區列出 pending：

- **批准並執行**：立刻以同樣的參數執行該工具**一次**（RBAC 仍會檢查），結果寫回 `Approvals.result` 與 `AuditLog`，state → `approved`。
- **拒絕**：state → `denied`。

**M4 起批准 / 拒絕後會續跑原對話**：若 `Approvals.job_id`（存 session id）對應的 session 仍 active，會排一個 `continuation` job，以 user 訊息「（系統）先前待審批的 X 已由 owner 批准並執行，結果：…」（拒絕則「已由 owner 拒絕，未執行」）接回該 session，由 trigger 一分鐘內跑完；到聊天台切到該 session 就看得到 agent 的後續回覆。curation 提議（`memory_manage`）批准只套用、不續跑。同一輪裡模型若重複要求同一個被攔的動作，不會再寫第二筆。

「紀錄」分頁下方同時列最近 50 筆 `AuditLog`（每次工具執行一列，失敗列紅底）。

**提案型工具（M5）**：工具宣告可帶 `proposal(args, ctx)` hook（目前只有 `skill_manage`）。未批准時 executor 不執行 handler，改呼叫 hook 驗證參數並取得 reason（以「技能提案」開頭），寫一列 `Approvals` 後回 `pending_approval`；批准時才以 `approved=true` 執行 handler。與 X 類共用同一條路（去重、`needs_approval` job 狀態、AuditLog），但不看 `approval_policy`，而且批准後**不續跑**原對話（與 curation 相同）。「紀錄」的審批卡片對 `skill_manage` 顯示 diff 預覽：create 顯示全文、patch 顯示「找到 → 取代成」。

### M2 驗收步驟（請在瀏覽器操作）

1. Doctor → 「重新安裝」（`Approvals` 多了 `result` 欄、`Config` 要補 RBAC 預設值）→ Doctor 全綠（含新的三項）→ 「跑 smoke tests」全過。
2. 「工具」分頁確認八個 toolset 都有開關；要測寄信審批就把 **gmail 的 external 打開**，儲存。
3. 「聊天台」輸入：`找出上週收到關於 X 的信，整理成一份 Doc，並草擬回信`（X 換成真實主題）。預期回覆上方顯示 `gmail_search` → `gmail_read_thread` → `docs_create` → `gmail_create_draft` 等步驟，回覆附 Doc 連結與草稿摘要。
4. 接著輸入 `把那封回信寄出`。預期出現 `gmail_send` 步驟標「待審批」，回覆說明已送審。到「紀錄」分頁看到 pending 卡片；按「拒絕」（或「批准並執行」真的寄出）。
5. 「紀錄」的 AuditLog 應有上述每一步。

## 記憶與 session（M3）

### Session

聊天台每則訊息屬於一個 **session**（DB `Sessions` 一列、`Messages` 每則訊息一列，中立格式：user / assistant / assistant+tool_calls / tool 全存）。`runSessionTurn_()`（[Sessions.gs](src/Sessions.gs)）是聊天台與日後 Queue runner 的共同入口：

1. 載入或建立 session。閒置超過 `session_idle_hours`（預設 6）自動關掉舊的開新的。
2. **Context 壓縮**：summary + 活訊息的估算 tokens 超過 `context_max_tokens`（預設 24000）時，用 **fast** 模型（沒有就 main）把較早的輪次併進 `Sessions.summary`，只保留最近 `keep_recent_turns`（預設 4）輪；`compact_seq` 之前的訊息不再進 context，但仍留在 Sheet 供搜尋。
3. 把記憶快照、先前對話摘要、session 資訊附進 system prompt，跑 M2 的 `runTurn_()`。
4. 這輪新增的訊息批次寫入 `Messages`，更新 session 的 turns / token_est / title，CacheService 快取最近訊息（真相仍在 Sheet）。
5. **Curation nudge**：每 `curation_every_turns`（預設 10）輪、或 `/new` 關閉 session 時，跑一次記憶整理（見下）。

聊天指令：`/new`（關閉目前 session 並開新的；後面可直接接訊息）、`/status`。聊天台的 session 下拉可切回舊 session 繼續聊。

### Memory / UserProfile

沿 hermes 的設計：**兩表、字元上限、快照注入、工具沒有 read**。

| 表 | 放什麼 | 上限（Config） |
|---|---|---|
| `UserProfile` | 關於你：身分、偏好、溝通風格、慣用工具 | `profile_max_chars` 1375 |
| `Memory` | 專案脈絡、決定、工作方式、重要事實 | `memory_max_chars` 2200 |

- 每輪開始把兩表快照（含容量）放進 system prompt，模型自然看得到，所以工具只有寫入。
- `memory_manage(target, action, content, old_content, category)`：`add` / `replace` / `remove`。replace / remove 用 `old_content` 比對既有條目，需**唯一命中**；單條 ≤ 500 字；容量不足回錯誤要模型先整併。
- 管理頁「記憶」分頁可直接增修刪兩表，並可把條目**鎖定（pinned）**：agent 不能改或刪，只有你能。
- `session_search(query, limit)`：關鍵字 AND 搜 session 標題、摘要與訊息，回 session 與片段；排除目前 session。開 `session_embeddings` 且有 `role=embed` 的 provider（openai / gemini）時，curation 會為 session 摘要算向量，搜尋加上 cosine 相似度。

### Curation

用 fast 模型讀最近的對話與目前快照，輸出 JSON 提議（add / replace / remove）。**預設不直接套用**：每筆提議寫成一列 `Approvals`（tool=`memory_manage`），到「紀錄 → 審批」批准才寫入；Config `curation_auto_apply` 開了才直接套用。「記憶」分頁每個 session 有「整理記憶」「關閉」按鈕可手動觸發。

### 管理頁「設定」分頁

| 項目 | Config key | 預設 |
|---|---|---|
| Memory / UserProfile 容量 | `memory_max_chars` / `profile_max_chars` | 2200 / 1375 |
| context 壓縮門檻（估算 tokens） | `context_max_tokens` | 24000 |
| 壓縮時保留最近幾輪 | `keep_recent_turns` | 4 |
| 每幾輪 curation（0 關） | `curation_every_turns` | 10 |
| curation 直接套用 | `curation_auto_apply` | 關 |
| session 閒置幾小時自動切新（0 關） | `session_idle_hours` | 6 |
| session 向量搜尋 | `session_embeddings` | 關 |
| 單輪時間預算（秒） | `turn_budget_seconds`（M4；到了就停並由 Queue 續跑） | 270 |

token 估算很粗（CJK 每字 1、其餘每 4 字元 1），只用來決定何時壓縮。Doctor 加：兩表容量、Sessions 可讀、有 fast provider（沒有只是提醒）、開了向量搜尋就要有 embed provider。

### M3 驗收步驟（請在瀏覽器操作）

1. Doctor → 「重新安裝」（`Sessions` 多 4 欄、Config 補 M3 設定）→ 全綠 → 「跑 smoke tests」44 項全過。
2. 「模型」分頁建議加一個 `role=fast` 的便宜模型（例如 GLM 的 flash 或 gemini-2.5-flash）；沒有也能跑，壓縮與 curation 會用 main。
3. 聊天台（session A）：「我偏好繁體中文，程式註解用英文」→ 預期出現 `memory_manage` 步驟（target=user）。到「記憶」分頁看到該條目。
4. 聊天台輸入 `/new` → 回「已開新 session」；再問「我的偏好是什麼？」→ 應直接從快照回答，不需查詢。
5. 問「上個月我們聊過哪個專案？」→ 預期 `session_search` 步驟並列出先前 session。
6. 「記憶」分頁對 session A 按「整理記憶」→ 「紀錄」分頁出現 `memory_manage` 的待審批（或回「沒有需要更新的記憶」）。

## Queue 與排程（M4）

### Queue runner

`installAgent()` 裝的每分鐘 trigger 跑 `queueTick()`（[Queue.gs](src/Queue.gs)）。閒置時只讀兩個 Script Property：`QUEUE_DIRTY`（有 queued job）與 `CRON_NEXT_RUN`（最早到期的排程），都沒到就不開 spreadsheet。有事要做時一次 tick：

1. `LockService.tryLock` 防重入（trigger 與管理頁「處理一個 job」同時跑時後者略過）。
2. 掃 `Cron` tab：`next_run <= now` 且啟用的排程各排一個 `cron` job，`next_run` 推到下一次。
3. 卡在 `running` 超過 10 分鐘的 job（執行被 GAS 中止）重排；嘗試滿 3 次就判 `failed`。
4. 取**最舊的一個** `queued` job → `running` → 依 type 執行 → `done` / `needs_approval`（有工具停在審批）/ `failed`。整個 tick 預算 4.5 分鐘；程式例外會重試，`attempts ≥ 3` 不再重試。
5. 沒有 queued 就清 `QUEUE_DIRTY`。

`Queue` tab 欄位：`id / type / session_id / payload(JSON) / state / attempts / started / finished / error`；結果寫在 `payload.result`（文字、工具步驗摘要、`stopped`、`sessionId`、`continued_by`、`delivery`）。

| type | 來源 | 做什麼 |
|---|---|---|
| `turn` | 聊天台勾「背景執行」 | `runSessionTurn_()` 一輪（interactive；審批策略照常） |
| `cron` | 排程到期 / 立即執行 | 建**新 session**（channel `cron`、`external_id` = 排程 id、`model_override` = model_pin），`mode='autonomous'` 跑 prompt，結束後依 `deliver_to` 投遞並寫回 `Cron.last_status` |
| `continuation` | checkpoint 或審批決定 | 在**同一 session** 再跑一輪，user 訊息是系統提示 |
| `curation` | 預留（目前 curation 仍同步跑） | `curateSession_()` |

### Checkpoint 續跑

`runTurn_` 到時間預算（Config `turn_budget_seconds`，預設 270 秒）或步數上限會停，這一輪的訊息已由 `runSessionTurn_` 寫進 `Messages`。Queue 看到 `stopped` 是 `time_budget` / `max_steps` 就排一個 `continuation` job，帶「（系統）上一輪因時間預算或步數上限而中止…請接續完成」提示接回同一 session；**上限續跑 3 次**，之後標 `continuation_exhausted`。cron 任務只在最終那一輪（不再續跑）投遞；續跑中 `last_status` 會顯示「running（續跑 job …）」。

要驗證續跑，到「設定」把 `turn_budget_seconds` 暫時調到 20–40 秒，再把一個會呼叫幾個工具的任務用「背景執行」送出；驗完記得調回 270。

### 排程（`Cron` tab）

欄位：`id / name / schedule / next_run / prompt / skills / deliver_to / model_pin / enabled / last_run / last_status`。管理頁「排程」分頁可新增 / 編輯 / 啟停 / 立即執行，`cronjob_manage` 工具（toolset `cronjob`）讓 agent 在聊天中代勞（`delete` 只停用不刪列）。

`schedule` 寫法（[Cron.gs](src/Cron.gs) `computeNextRun_` 純函式，時區 Asia/Taipei）：

| 寫法 | 意思 |
|---|---|
| `0 9 * * *` | 5 欄 cron：分 時 日 月 週；支援 `*`、數字、`,`、`-`、`*/n`；週 0 或 7 = 日，也接受 `mon`..`sun`。日與週都有限制時取「或」（cron 慣例） |
| `daily 09:00` / `每天 09:00` | 每天固定時間（省略時間 = 09:00） |
| `weekly mon 09:00` / `每週一 09:00` | 每週固定日 |
| `hourly` / `每小時` | 每小時整點 |

排程任務在**無人模式**跑：system prompt 會加「沒有使用者在線、不要提問、輸出可直接交付的結果」；X 類工具依 `approval_policy` 處理（`always` / `autonomous_only` 都會送審，結果文件裡會列出待審批的動作，批准後會續跑該 session）。**排程任務執行中 `cronjob_manage` 只能 `list`**，不能再建 / 改 / 觸發排程（避免遞迴）。`skills` 欄（逗號分隔技能名）在執行時把技能**全文**注入 system prompt，續跑 job 也會帶著；找不到的技能列在結果的 `skills.missing` 與投遞文件的執行資訊裡。

### 投遞（`Deliver.gs`）

| `deliver_to` | 做法 |
|---|---|
| `telegram` | M6：送到 owner 的 Telegram chat（Config `telegram_owner_chat_id`，沒有就用白名單第一個 user id） |
| `doc` | 在 Drive `GAS Agent/reports/` 建一份 Google 文件，標題「`<name> YYYY-MM-DD`」，內文 = agent 的最終回覆（輕量 markdown）+「執行資訊」（session、模型、工具步驟、待審批、中止原因） |
| `email` | 同樣內容寄給 `OWNER_EMAIL`。**只寄給 owner 自己不算外發**，不走 `gmail_send` 工具也不走審批 |
| `none` | 不投遞；結果仍在 Queue job 與該 session 裡 |

投遞失敗時 job 標 `failed`（結果保留、`error` 欄記原因），不會自動重跑模型；Telegram 投遞留 M6。

### 管理頁

- **排程**：列表（下次 / 上次 / 狀態）、新增 / 編輯 / 啟停、「立即執行」會排 job 並輪詢到完成，顯示投遞結果與 Doc 連結。
- **紀錄 → Queue**：最近 30 個 job、狀態、失敗原因、「重試」（failed → queued）、「處理一個 job」（不想等 trigger 時手動跑一次 tick）。
- **聊天台 → 背景執行**：勾了就排 `turn` job 並每 5 秒輪詢 `adminGetJob`，續跑會自動跟到下一個 job，證明 Queue 路徑可用。
- **Doctor** 加三項：Queue 沒有卡在 running 超過 10 分鐘的 job、Cron 的 schedule 都能解析、`CRON_NEXT_RUN` 旗標與 Cron tab 一致（黃燈提醒）。

### M4 驗收步驟（請在瀏覽器操作）

1. Doctor → 「重新安裝」（Config 補 `rbac.cronjob` 與 `turn_budget_seconds`、對齊 `CRON_NEXT_RUN`）→ 全綠 → 「跑 smoke tests」50 項全過。
2. 「排程」→「新增排程」：名稱 `每日郵件摘要`、schedule `daily 09:00`、投遞 `doc`、任務指令 `搜尋昨天收到的信件（newer_than:1d），挑出重要的 5–10 封，整理成「重點 / 待回覆 / 可忽略」三段摘要。` → 新增。列表應顯示下次 = 明天 09:00。
3. 按該列「立即執行」→ 狀態從「排隊中」變「執行中」再變「完成」（trigger 每分鐘跑一次，約 1–3 分鐘；或到「紀錄」按「處理一個 job」立刻跑）→ 出現「Doc「每日郵件摘要 YYYY-MM-DD」」連結，點開確認內容；Drive `GAS Agent/reports/` 裡有這份文件；排程列的「上次 / 狀態」更新。
4. 「設定」把 `turn_budget_seconds` 調成 30 → 儲存。「聊天台」勾「背景執行」，輸入一個要呼叫幾個工具的任務（例：`列出我 Drive 最近 10 個檔案，逐一讀出前 200 字，最後整理成一份 Doc`）→ 送出。預期：氣泡顯示 job id 與輪詢秒數；「紀錄 → Queue」看到第一個 job `done`、結果標「中止 time_budget」「續跑 → job_…」，接著出現 `continuation` job；全部跑完後聊天台顯示合併的回覆（各段以「— 續跑 —」分隔）與 `Queue job：job_a → job_b` 鏈。驗完把 `turn_budget_seconds` 調回 270。
5. 審批後續跑：聊天台（不勾背景）要求寄一封信給自己 → 停在審批 → 「紀錄」按「批准並執行」→ 卡片下方出現「已排續跑 job …」→ 一分鐘後聊天台切回該 session（或重新整理），最後一則是 agent 根據「已由 owner 批准並執行」的系統訊息做的收尾。

## 技能（M5）

沿 hermes 的設計：技能是 Drive 上的 `SKILL.md`（[agentskills.io](https://agentskills.io) 格式），**system prompt 只放啟用技能的名稱與一行描述**，模型要用時才 `skill_load` 載全文；複雜任務做完後 agent 會評估「值得存成技能嗎」，值得就提案，owner 批准才寫入。

### 檔案與格式

資料夾預設 `GAS Agent/skills/`（Config `skills_folder_id` 可改；「技能」分頁「更換資料夾」），每個技能一個子資料夾：`<name>/SKILL.md`。

```markdown
---
name: weekly-report
description: "產出本週週報 Google 文件：讀本週 Calendar 事件與寄出的郵件，整理成固定章節。"
triggers: [週報, weekly report]
version: 1.0
enabled: true
---
# 週報格式
（給模型照做的 markdown：步驟、要用的工具與參數要點、輸出格式、注意事項）
```

- `name` 必填：小寫字母 / 數字 / 連字號，與資料夾名相同，也是聊天指令 `/<name>`。`description` 必填（≤ 300 字，會進 system prompt）。`triggers` / `version` / `enabled` 選填；`enabled: false` 的技能不列入 system prompt，但 `/<name>` 明確指定時仍可用。
- 索引（名稱 / 描述 / 啟停 / file id / 更新時間）快取在 CacheService 15 分鐘；管理頁或 `skill_manage` 寫入都會清快取，直接在 Drive 改檔請按「重新索引」。
- 第一次 `installAgent()` 或開「技能」分頁時資料夾若為空，會寫入兩個內建範例：**`weekly-report`**（週報：讀本週 Calendar 事件與寄出的信，產出固定章節的 Doc）與 **`deck-planning`**（原本寫在 system prompt 的簡報規劃規則，現在搬成技能；system prompt 只剩一行「做簡報前先 skill_load deck-planning」）。

### 用法

| 入口 | 行為 |
|---|---|
| 聊天台一般訊息 | system prompt 多一段「## 可用技能」（啟用技能的名稱 + 描述）與「## 技能」規則；模型判斷任務符合某技能就 `skill_load` 載全文照做 |
| 聊天台 `/<name> 訊息` | 直接把該技能**全文**注入 system prompt，斜線拿掉後的文字當訊息（沒有文字就用「請依照上方技能的指示執行」）。找不到該技能回錯誤文字並列出可用技能，不打模型、不算一輪 |
| 排程 `skills` 欄 | 逗號分隔技能名，執行時全文注入；續跑 job 也帶著 |
| `skill_load(name)` | 回 frontmatter 與全文（停用的會標註） |
| `skill_manage(action=create\|patch, …)` | **只提案**：驗證後寫一列 `Approvals`（reason「技能提案：新建 / 修補「name」— 描述」），owner 批准後才建 / 改檔。`patch` 用 `patch_find` → `patch_replace`（原文片段需唯一命中）或整份 `content`，也可只改 `description` / `triggers` |

toolset 叫 **`skill`**（不是 skills）：registry 要求工具名以 `<toolset>_` 開頭，而工具名沿 hermes 叫 `skill_load` / `skill_manage`；RBAC key 是 `rbac.skill`，預設 read / write 開。

### 自動提案

一輪結束後若 **工具呼叫 ≥ 5 步、順利結束（沒被中止）、至少一步成功、這個 session 還沒評估過、本輪沒花超過 3 分鐘、`skill_manage` 可用**，`runSessionTurn_` 會再打一次模型（帶本輪完整歷史，預算 60 秒、最多 2 步）請它評估「這個流程值得存成技能嗎」，值得就呼叫 `skill_manage create` 提案。這次評估的訊息**不寫進 Messages**（避免污染對話），結果放在回傳的 `skillProposal`（聊天台 meta 顯示「技能提案已送審（apr_…）」或模型的評估文字），提案本身在「紀錄 → 審批」。同 session 只評估一次：`Sessions.skill_proposed_turn` 記第幾輪問過（新欄位，Doctor 會提醒「重新安裝」補欄）。

### 管理頁「技能」分頁

列表（名稱 / 描述 / 觸發 / 版本 / 更新時間 / 開啟 Drive 檔 / 編輯 / 啟停；壞檔標原因）、「新增技能」「編輯」表單（名稱、描述、觸發詞、版本、啟用、正文 markdown → 組成 frontmatter + 正文寫入 Drive，owner 直接寫不走審批）、「重新索引」、「更換資料夾」。Doctor 加三項：`skills_folder_id` 有效、資料夾可讀、每個 SKILL.md 可解析。

### M5 驗收步驟（請在瀏覽器操作）

1. Doctor → 「重新安裝」（`Sessions` 補 `skill_proposed_turn` 欄、Config 補 `rbac.skill` 與 `skills_folder_id`、Drive 建 `GAS Agent/skills` 並寫入兩個內建技能）→ 全綠（含技能三項）→ 「跑 smoke tests」56 項全過。
2. 「技能」分頁應列出 `weekly-report` 與 `deck-planning`，都啟用；「開啟 Drive 檔」能看到 SKILL.md。按「編輯」改一個字儲存，再按「重新索引」確認更新時間變了。
3. 聊天台輸入 `/weekly-report` → 預期步驟含 `calendar_list_events`、`gmail_search`、`docs_create`，回覆附一份「週報 YYYY-MM-DD ～ MM-DD」Doc 連結，章節為「本週重點 / 會議與活動 / 本週完成 / 待辦與下週計畫 / 風險與需要決定的事」；meta 顯示「技能：weekly-report」。輸入 `/nope` 應回「找不到技能」並列出可用技能。
4. 聊天台（不帶斜線）輸入一個會用到 ≥ 5 次工具的任務（例：`列出我 Drive 最近 6 個檔案，逐一讀出前 200 字，最後整理成一份 Doc`）→ 回覆 meta 出現「技能提案已送審（apr_…）」（或「技能提案評估：不需要…」，那就換個更像固定流程的任務再試一次新 session）→ 「紀錄 → 審批」出現 `skill_manage` 卡片，顯示新建技能的名稱、描述與全文預覽 → 「批准並執行」→ 「技能」分頁多了該技能，Drive `GAS Agent/skills/<name>/SKILL.md` 存在。卡片不會出現「已排續跑 job」。
5. 聊天台輸入「幫我把 weekly-report 技能的『本週重點（3 條以內…）』改成 5 條以內」→ 預期 `skill_manage patch` 步驟標「待審批」→ 審批卡片顯示「找到 → 取代成」→ 批准 → 開 Drive 檔確認已改。
6. 排程：新增一個排程，技能欄填 `weekly-report`，任務指令「產出本週週報」，投遞 doc → 「立即執行」→ 結果 Doc 的「執行資訊」有「載入技能：weekly-report」。

## 通道（M6）

所有入口都只做一件事：**驗證 → 寫一筆 Queue `turn` job → 立刻回覆**；agent 由每分鐘 trigger 的 `queueTick()` 跑，跑完由 `deliverTurnToChannel_`（[Channels.gs](src/Channels.gs)）把文字送回原通道。通道 job 的 session 以 `channel` + `external_id`（Telegram chat id / Gmail thread id）識別，同一個 chat / thread 沿用同一個 active session（閒置 `session_idle_hours` 後自動切新）。續跑（checkpoint、審批後）的 job 也帶著通道識別，每一輪的回覆都會送回去。

### Telegram（webhook，部署 B）

| 項目 | 說明 |
|---|---|
| 部署 B | 「以我執行 / **任何人**」的 Web App。Apps Script 的存取等級寫在 `appsscript.json` 的 `webapp.access`，一個版本只能一種，所以 `scripts/deploy.sh` 先以 `MYSELF` 更新部署 A，再把 manifest 翻成 `ANYONE_ANONYMOUS` 推一個版本給部署 B，最後翻回。目前的部署 B：`AKfycbypDGHfZ6Ez0HktdBY0WcysnAEePAyBuaLtDU_maOW5ovPtWvFhHcFlLEjqPpagkkqkug`（版本 18） |
| webhook URL | `<部署 B /exec>?src=telegram&key=<32 字元 secret>`。GAS 的 `doPost` 拿不到 HTTP header，所以 secret 放 query；`doPost` 比對 `e.parameter.key` 與 Script Property `TELEGRAM_WEBHOOK_SECRET`，再比對 `message.from.id` 是否在 Config `telegram_allowed_user_ids`。不符一律丟掉、不回話、記 `AuditLog`（tool `telegram:webhook`） |
| 回應 | 一律 `HtmlService.createHtmlOutput('ok')`，第一跳就是 200（`ContentService` 會 302，Telegram 會不斷重送）。每分鐘最多 30 個 update（CacheService 計數） |
| 流程 | 文字訊息 → `enqueue_('turn', {channel:'telegram', telegram_chat_id, …})`（預設不先回話；Config `telegram_ack` 開了才先回「收到，處理中…」）；trigger 跑完 → 回覆文字（超過 3900 字自動切段）。待審批的動作附 **inline button「批准 / 拒絕」**，按下走 `callback_query` → `decideApproval_` → 回結果並拿掉按鈕；批准後的續跑結果也會送回 |
| 群組 | 把 bot 加進群組後，只在 **@bot、回覆 bot 的訊息、或 /指令** 時反應（私聊不變；Telegram 的 bot 隱私模式開著時本來也只收得到這些）。回覆會掛在觸發的那則訊息下。白名單成員在群組裡用 `/group` 切模式（`/group` 看狀態）：<br>• `/group on` **群聊模式**（Config `telegram_open_groups`）：全群共用一個 session，任何成員 @bot 都能請 agent 用工具幫忙；但**非白名單成員觸發的那一輪** R 以外的工具（寫入 / 刪除 / 寄信 / 分享）一律送 owner 審批（審批按鈕任何人看得到，按下仍要過白名單）、不注入 owner 的記憶快照、system prompt 提醒不透露 owner 私人資料、不 curation 不自動提案；成員的 /指令忽略，附件照常存 Drive<br>• `/group guest` **訪客模式**（Config `telegram_guest_groups`）：非白名單成員獨立 session（`external_id = <chat id>:guest`）、RBAC 全關沒有任何工具、不注入記憶與技能；訪客的 /指令與附件不處理<br>• `/group off` 只有白名單成員叫得到<br>bot 的 username 由 `getMe` 取得存 Config `telegram_bot_username` |
| 附件 | 傳照片 / PDF / 文件 / 語音（Bot API 下載上限 20 MB）→ webhook 用 `getFile` 下載存到 Drive `GAS Agent/attachments/telegram/`，訊息 = caption（沒有就預設「請看這個附件…」）+ 附件註記（名稱、類型、`file_id`、網址），agent 用 `drive_read_text`（PDF **與圖片**走 Drive OCR）、`drive_move` / `drive_rename` 歸檔、`gmail_send` / `gmail_create_draft` 的 `attachment_file_ids` 轉寄。全部附件存檔失敗才回錯誤不排隊。目前是 OCR 文字理解，不是視覺模型看圖（多模態輸入留 M7） |
| 審批通知 | Config `telegram_notify_approvals`（預設開）：**聊天台 / Email / 排程**的任務停在審批時，也推一則帶「批准 / 拒絕」按鈕的訊息到 owner 的 Telegram（來源、工具、參數摘要、session）；從 Telegram 批准後 agent 的續跑回覆仍回到原通道（Email 回信、排程投遞）。Telegram 自己來的任務回覆本身就有按鈕，不重複推 |
| 指令 | `/new`（關閉目前 session 開新的，可直接接訊息）、`/status`、`/model [provider id \| auto]`（這個 session 的模型）、`/skills`、`/help`；其他 `/xxx`（例 `/weekly-report`）原樣交給 agent，走 M5 的技能注入 |
| 設定 | 管理頁「通道」：bot token（只進 Script Property `TELEGRAM_BOT_TOKEN`，顯示末 4 碼）、白名單 user id、部署 B 網址、secret（儲存時自動產生；可重新產生）、「設定 webhook」「查 webhook 狀態」「移除 webhook」「送測試訊息」。Config：`telegram_enabled` / `telegram_allowed_user_ids` / `telegram_webhook_url` / `telegram_owner_chat_id`（第一次收到白名單訊息時自動記下，`deliver_to=telegram` 用） |

### Email 指令信

| 項目 | 說明 |
|---|---|
| 觸發 | 寄件者 = `OWNER_EMAIL`（自己寄給自己）且 thread 貼有 Gmail 標籤 `agent/inbox`（Config `email_inbox_label`；可在 Gmail 設篩選器自動貼標，例如 `from:me to:me subject:[agent]`） |
| 掃描 | Script Property `EMAIL_NEXT_SCAN` 記下次掃描時間（Config `email_scan_every_minutes`，預設 5）；`queueTick` 閒置時連同 `QUEUE_DIRTY` / `CRON_NEXT_RUN` 一起看，沒到就不開 Gmail。到期 `GmailApp.search('label:agent/inbox from:<owner> newer_than:7d -is:starred')`，每個 thread 裡 owner 寄的、未加星、不是 agent 回覆（顯示名稱 `GAS Agent`）的訊息各排一個 `turn` job，**排完立刻加星（★ = 已處理）** |
| 內文 | 去掉 `>` 引用、`On … wrote:` 之後、`-- ` 簽名檔，截 8000 字；內文全是引用就用主旨 |
| 回覆 | `thread.reply(text, {name:'GAS Agent'})` 進同一 thread，寄件者是 owner 本人；送出後把自己的回覆加星避免被當成指令。待審批的動作在回信裡說明到管理頁批准（Email 沒有按鈕）；Telegram 通道開著時會同時推帶按鈕的 Telegram 通知，回信會標「也已推到 Telegram」 |
| 設定 | 管理頁「通道」：啟用、標籤、掃描間隔、「建立標籤」「立刻掃一次」 |

Doctor 加：Telegram 啟用時 token / 白名單 / webhook 是否登記且指向設定的部署 B（含 Telegram 回報的待處理數與最後錯誤）；Email 啟用時標籤存在、掃描旗標已設。

### M6 驗收步驟（請在瀏覽器與手機操作）

1. 更新：`scripts/deploy.sh "說明"` 已把部署 A（版本 17）與部署 B（版本 18）推上去。Doctor → 「重新安裝」（Config 補通道設定）→ 全綠 → smoke tests 60 項全過。
2. Telegram 建 bot：手機 Telegram 找 **@BotFather** → `/newbot` → 取得 token。找 **@userinfobot** 取得自己的 user id（或用 telegram-assistant 已知的 `1201905814`）。
3. 管理頁「通道」：勾啟用 Telegram、貼 token、白名單填 user id、部署 B 網址填 `https://script.google.com/macros/s/AKfycbypDGHfZ6Ez0HktdBY0WcysnAEePAyBuaLtDU_maOW5ovPtWvFhHcFlLEjqPpagkkqkug/exec` → 儲存（會產生 secret）→ 「設定 webhook」→ 「查 webhook 狀態」應顯示 URL 與待處理 0 → 「送測試訊息」手機應收到。
4. 手機對 bot 說 `/help` → 立刻回指令說明。再說 `找出我 Drive 最近 5 個檔案，列出名稱與修改時間` → 1–2 分鐘內收到結果（不會先回「收到」，除非在「通道」開啟）（trigger 每分鐘跑；或到管理頁「紀錄」按「處理一個 job」）。「記憶」分頁的 Sessions 應多一個 `[telegram]` session。
5. 審批按鈕：Telegram 說 `寄一封信給我自己，主旨 test，內文 hello`（gmail external 需開）→ 回覆附「✅ 批准 gmail_send / ❌ 拒絕」按鈕 → 按批准 → 回「已批准…agent 會接續回覆」→ 一分鐘內收到 agent 的收尾訊息、信件寄達。
6. `/weekly-report` 在 Telegram 也能用（技能注入）；`/new` 開新 session；`/model` 列模型。
7. Email：「通道」勾啟用 Email、間隔先設 1 → 儲存 → 「建立標籤」。用 Gmail 寄一封信給自己，主旨 `[agent] 測試`，內文 `列出我今天的行事曆事件`，寄出後到收件匣把這封信貼上標籤 `agent/inbox`（或先在 Gmail 設篩選器）→ 等 1–2 分鐘（或「通道」按「立刻掃一次」）→ 同一 thread 收到 GAS Agent 的回信；原信已加星。驗完把間隔調回 5。
8. 群組：建一個群組把 bot 與另一個人拉進來。你 `@bot 今天幾號` 應得到回覆（掛在你的訊息下）；另一個人 `@bot 你好` 沒反應。你輸入 `/group on` → 對方 `@bot 幫我查今天行事曆` → agent 用工具回答（同一個群組對話）；對方 `@bot 幫我寄信給 X` → 回「待審批」，你的私聊收到帶按鈕的審批通知；對方輸入 `/status` 沒反應。`/group guest` → 對方 `@bot 你是誰` 得到不帶工具的回答。`/group off` 後對方又沒反應。
9. 跨通道審批：用 Email 指令信要求寄一封信給自己 → Telegram 收到「⏸ 來自 Email 指令信的任務需要你審批」+ 按鈕 → 按批准 → Email thread 收到 agent 的收尾回信。
10. 排程投遞：新增一個排程 `deliver_to = telegram` → 「立即執行」→ Telegram 收到「📋 <名稱> 日期」+ 內容。

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

- 編輯 `src/` 下的檔案 → `node scripts/local-tests.js`（54 項 pure 測試，不碰 Google 服務）→ `scripts/deploy.sh [--account <代號>] "說明"`（push + 更新該帳號的部署 A 與 B；等同 `clasp push` 加兩次 `clasp deploy -i`）→ 用管理頁 URL 驗證 → `git commit`。只在編輯器測函式時可省略 deploy。多個帳號用 `scripts/deploy.sh --all "說明"` 一次推完 `accounts/` 底下全部。
- **不要**手動把 `appsscript.json` 的 `webapp.access` 留在 `ANYONE_ANONYMOUS` 後 `clasp deploy -i` 部署 A，那會讓管理頁變成任何人可達（雖然 `assertOwner()` 仍會擋，但少了第一道門）。`scripts/deploy.sh` 用 trap 保證翻回。
- `clasp push -w` 可監看自動推送。
- 改 `appsscript.json` 的 scopes 時，`Config.gs` 的 `REQUIRED_SCOPES` 要同步，並重新執行 `installAgent()` 以觸發重新授權。
- 不要把 `.clasp.json`（含 scriptId）以外的任何金鑰放進 repo；金鑰只進 Script Properties。

## 疑難排解

| 現象 | 處理 |
|---|---|
| `clasp push` 回 `User has not enabled the Apps Script API` | 到 <https://script.google.com/home/usersettings> 開啟 API，等一分鐘重試 |
| `scripts/install.sh` 在 `create-script` 失敗 | 同上（API 沒開或剛開還沒生效）；或登入的不是目標帳號：`clasp -u <代號> logout` 後重跑 |
| 多帳號切換後 `clasp` 指令打到錯的專案 | 根目錄 `.clasp.json` 是最後一次腳本複製進來的帳號；一律透過 `scripts/deploy.sh --account <代號>` 操作，或手動 `cp accounts/<代號>/clasp.json .clasp.json` |
| 管理頁顯示「尚未安裝」 | 回編輯器執行 `installAgent()` |
| Doctor「scopes」紅燈 | 在編輯器重新執行 `installAgent()`，讓 Google 重新要求授權。**沒有跳出授權畫面**：先把編輯器分頁整頁重新整理（clasp 推的 manifest 不會自動載入），再執行；還是沒跳就在編輯器執行 **`reauthorize()`**（它會實際呼叫 Gmail / Calendar / Drive 等服務，runtime 一定會要缺的 scope）；最後手段是到 <https://myaccount.google.com/permissions> 移除「GAS Agent」的存取權後再執行一次 |
| Doctor「trigger」顯示 0 支 | 執行 `installAgent()`；若要清掉重裝可先 `removeAgentTriggers()` |
| `installAgent()` 說 owner 不符 | 這個 script 已綁別的帳號；到「專案設定 → 指令碼屬性」刪 `OWNER_EMAIL` 再執行 |
| 側欄分頁點了整頁空白、網址變成 `…script.googleusercontent.com/userCodeAppPanel#/…` | 線上是舊版本：`clasp deploy -i <deploymentId>` 推新版本。根因是 HtmlService 注入 `<base target="_top">`，導航已改為 `preventDefault` + 自設 `location.hash` |
| 沒登入的瀏覽器也看得到管理頁 | 該部署存取權被設成「任何人」。「以我執行」下 `getEffectiveUser()` 永遠是 owner，`assertOwner()` 因此改用 `getActiveUser()`（匿名為空字串即拒絕）；仍請把部署改回「只有我自己」 |
| DB 被誤刪 | `installAgent()` 偵測到檔案在垃圾桶會建新的；要救回舊資料請先從垃圾桶還原再執行 |
| 升到 M1 後 Doctor 說 `Providers` / `Usage` tab 缺欄位 | 新版本加了欄位：Doctor 分頁按「重新安裝」（或編輯器執行 `installAgent()`）往右補欄，既有資料不動 |
| 測試連線 / 聊天台等很久才回錯 | UrlFetch 無法設 timeout；請把該 provider 的 `max_tokens` 調低、GLM 類在 `extra_body` 關 thinking |
| Z.ai 回 401 | coding plan 的 key 只能打 `https://api.z.ai/api/coding/paas/v4`，不能打 bigmodel.cn 一般 endpoint |
| 新增第二個同協定 provider 後第一個不見了 | 舊版會以 id 覆寫（範本預設 id 相同）。現在新增時 id 重複會被拒絕、範本會自動帶 `gemini-2` 之類的 id；被覆寫的那組請重新新增並貼 key |
| 聊天台選「自動」回「沒有可用的 provider」 | 沒有 enabled 的 `main` provider；到「模型」分頁新增或啟用 |
| 聊天台說某工具「目前未開放」/ 步驟顯示「RBAC 拒絕」 | 該 toolset 的對應開關關著（預設 external 全關）。到「工具」分頁開啟並儲存；Doctor 若說「缺 rbac」就按「重新安裝」 |
| `web_fetch` 回「白名單是空的」 | 到「工具」分頁填 `web_fetch 域名白名單`（一行一個） |
| 聊天台跑了很久才回「系統中止：已達單輪時間預算」 | 一輪工具太多或某個工具（PDF OCR、大試算表）太慢。拆成幾則訊息下指令，或調低讀取類工具的 max_* 參數 |
| 回覆說「同一工具以相同參數連續失敗 3 次，已熔斷」 | 看回覆上方該步的結果摘要（通常是參數錯或找不到 id），修正後重下 |
| 升到 M2 後 Doctor 說 `Approvals` 缺欄位 / 缺 rbac | 按「重新安裝」補 `result` 欄與 RBAC 預設值 |
| 升到 M3 後 Doctor 說 `Sessions` 缺欄位 | 按「重新安裝」補 `compact_seq` / `turns` / `last_curated_turn` / `embedding` |
| agent 說「容量不足」不肯記 | 到「記憶」分頁整併或刪舊條目，或在「設定」調高上限 |
| `memory_manage` 回「命中 N 條」 | 模型給的 old_content 太短；通常會自己重試，否則在「記憶」分頁手動改 |
| 聊天台回「前一個 session 閒置超過 N 小時」 | 正常：超過 `session_idle_hours` 自動開新 session；要延長到「設定」調 |
| 壓縮 / curation 很慢或很貴 | 加一個 `role=fast` 的便宜 provider；沒有 fast 會用 main |
| 排程「立即執行」一直「排隊中」 | trigger 沒在跑：Doctor 看 trigger 是否 1 支；或到「紀錄」按「處理一個 job」手動跑。`QUEUE_DIRTY` 旗標若被清掉（Doctor 黃燈），重新 enqueue 或手動 tick 即可 |
| 排程到點沒執行 | 排程未啟用、`schedule` 無法解析（Doctor 紅燈）、或 `CRON_NEXT_RUN` 旗標不對（開一次「排程」分頁或「重新安裝」會對齊） |
| Queue job 標 `failed`、error 寫「running 超過 10 分鐘」 | 該次執行被 GAS 6 分鐘上限中止（通常是某個工具或模型回應太慢）。按「重試」；長任務請靠續跑而非一步到底，或調低 `turn_budget_seconds` |
| cron 任務的信沒寄出 / 文件沒分享 | 無人模式下 X 類工具依審批策略送審：到「紀錄」批准，agent 會續跑收尾。投遞到 owner 自己的 `email` 不受此限 |
| agent 做的簡報很素 / 沒有規劃 | 到「工具」分頁填「簡報範本」（先在 Drive 用 Slides 主題庫做一份喜歡的範本）；system prompt 已要求先回大綱確認、每頁一重點、交錯版面並寫講者備忘。要圖就在指令裡給 Drive 圖片或公開網址 |
| agent 在排程任務裡說「不可建立排程」 | 刻意限制：排程任務執行中 `cronjob_manage` 只能 list，避免遞迴排程 |
| `/weekly-report` 回「找不到技能」 | 技能資料夾空的或快取舊：開一次「技能」分頁（會寫入內建技能）或按「重新索引」；Doctor 看 `skills_folder_id` 是否指到錯的資料夾 |
| 技能分頁某列標紅字「缺少 SKILL.md」/「缺 description」 | Drive 裡該子資料夾沒有 SKILL.md 或 frontmatter 不完整；用分頁「編輯」重寫或在 Drive 修檔後「重新索引」 |
| agent 說「skill_manage 只能以提案方式進行」 | 刻意限制：技能新建 / 修補一律進審批，到「紀錄 → 審批」批准 |
| 複雜任務做完沒有技能提案 | 觸發條件是 ≥ 5 步、順利結束、同 session 第一次；或模型評估為不值得（meta 會顯示評估文字）。開新 session 再試，或直接要求「把這個流程存成技能」 |
| 升到 M5 後 Doctor 說 `Sessions` 缺 `skill_proposed_turn` / 缺 `rbac.skill` | 按「重新安裝」 |
| Telegram 白名單填了兩個以上 id，儲存後只剩一個或變怪數字 | 舊版 Config 寫入被 Sheets 當千分位數字轉型；已改成 value 欄純文字格式。更新後到「通道」重新填一次白名單儲存即可 |
| Telegram 說了話沒反應 | 依序看：「通道」→「查 webhook 狀態」有沒有 URL 與最後錯誤；Doctor 的 Telegram 三項；「紀錄 → AuditLog」有無 `telegram:webhook` 列（`rejected user_not_allowed` = 白名單沒填對、`bad_secret` = 重新「設定 webhook」）；「紀錄 → Queue」有沒有 job |
| Telegram 回「收到」但一直沒結果 | trigger 沒跑或 job 失敗：Doctor 看 trigger、「紀錄 → Queue」看該 job 的狀態與錯誤；Telegram 回覆失敗會記在 job 的 error（例如 token 失效） |
| Telegram webhook 狀態顯示 `Wrong response from the webhook: 302` | 部署 B 不是「任何人」或網址填成部署 A 的；用 `scripts/deploy.sh` 重推 B，確認「通道」填的是部署 B 的 `/exec` |
| 寄給自己的指令信沒被處理 | 沒貼標籤、寄件者不是 OWNER_EMAIL、已加星、或超過 7 天；「通道」按「立刻掃一次」看報告；Doctor 看旗標 |
| agent 把自己的回信當成指令迴圈 | 不該發生：回信顯示名稱 `GAS Agent` 會被排除且已加星；若手動把星星拿掉就會重跑 |

## 里程碑

- [x] M0 骨架：repo + clasp、scopes、`installAgent()`、管理頁空殼、Doctor、smoke tests
- [x] M1 多 provider（OpenAI 相容 / Anthropic / Gemini）、備援鏈、Usage、模型分頁、聊天台（單輪、同步）
- [x] M2 工具與 RBAC（八個 toolset、registry / executor、審批、溢寫、工具迴圈、工具 / 紀錄分頁）—— 批准後續跑對話留到 M3/M4
- [x] M3 記憶：Sessions / Messages 持久化、context 壓縮、Memory / UserProfile 上限與快照、memory_manage、session_search（可選向量）、curation 進審批、記憶 / 設定分頁
- [x] M4 排程與非同步 Queue：job 狀態機、checkpoint 續跑、審批後續跑、Cron 解析與到期掃描、`cronjob_manage`、投遞 doc / email、排程 / Queue 分頁、背景執行
- [x] M5 技能：Drive `skills/<name>/SKILL.md`、索引快取、system prompt 只放名稱 + 描述、`skill_load` / `/<skill>` / cron skills 全文注入、`skill_manage` 提案進審批、≥ 5 步自動提案、技能分頁
- [x] M6 通道：Telegram webhook（部署 B「任何人」+ URL secret + 白名單、/new /status /model /skills、審批 inline button）、Email 指令信（標籤掃描、thread = session、回信加星）、通道分頁、`deliver_to=telegram`、`scripts/deploy.sh` —— 程式完成，待本人驗收
- [ ] M7 加固與維運
