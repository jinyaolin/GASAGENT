# GAS Agent

跑在 Google Apps Script（GAS）上的個人 agent，精神原型是 [hermes-agent](https://github.com/nousresearch/hermes-agent)：
零伺服器、常駐於自己的 Google 帳號，用 Google Sheet 當長期記憶、Drive 資料夾放技能，
透過只有本人能開的管理頁設定多組 AI provider，並有 Gmail / Drive / Docs / Slides / Sheets / Calendar 工具與排程。

完整規格與里程碑在本機 vault：`~/vault/20-projects/gas-agent.md`。目前進度：**M1 多 provider**。

## 設計要點

- **純 JavaScript `.gs` + JSDoc，零 npm runtime 依賴**；前端 vanilla JS 單頁。開發只用全域安裝的 `clasp` 同步到 git。
- **安全**：管理頁部署為「以我執行 / 只限我」，後端每個 `google.script.run` 入口第一行 `assertOwner()`；金鑰只進 Script Properties，其他設定放 Sheet。模型不執行自生程式碼，一律白名單工具（M2）。
- **兩個 Web App 部署**（M6 才需要第二個）：管理頁「只限我」；Telegram webhook 另開一個「任何人」部署並在 URL 帶 secret，`doGet` 依 `?src=telegram` 分流，回應用 `HtmlService` 避免 302。
- **Queue runner**：每分鐘 time trigger 跑 `queueTick()`，無 job 時只讀一個 Script Property 就 return，省 trigger 每日 90 分鐘配額。

## 檔案

```
src/
  appsscript.json   # OAuth scopes、webapp 預設（USER_DEPLOYING / MYSELF）、Asia/Taipei、V8
  Config.gs         # Script Properties 封裝、APP_VERSION、REQUIRED_SCOPES、assertOwner()
  Db.gs             # 開/建「GAS Agent DB」spreadsheet、DB_SCHEMA（11 個 tab）、幂等補 schema、以表頭為鍵的列讀寫
  Providers.gs      # M1：三個 adapter（openai / anthropic / gemini）、備援鏈、Usage 記錄、runChatTurn_()
  Queue.gs          # queueTick() 空殼（M4 放 job 狀態機）
  Setup.gs          # installAgent()：寫 OWNER_EMAIL、建 DB、裝每分鐘 trigger（可重跑）
  Admin.gs          # doGet 路由 + admin* 後端入口
  AdminPage.html / admin_js.html / admin_css.html   # 管理頁 SPA（檔名避開與 Admin.gs 撞名）
  Doctor.gs         # runDoctor()：Properties / tabs / trigger / scopes / 時區 / provider 健檢
  Tests.gs          # runSmokeTests()：M0 10 項 + M1 adapter 格式互轉、備援鏈（fetch stub）11 項
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

## 開發流程

```bash
clasp push
```

```bash
clasp status
```

- 編輯 `src/` 下的檔案 → `clasp push` → `clasp deploy -i <deploymentId> -d "…"` → 用管理頁 URL 驗證 → `git commit`。只在編輯器測函式時可省略 deploy。
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

## 里程碑

- [x] M0 骨架：repo + clasp、scopes、`installAgent()`、管理頁空殼、Doctor、smoke tests
- [x] M1 多 provider（OpenAI 相容 / Anthropic / Gemini）、備援鏈、Usage、模型分頁、聊天台（單輪、同步）
- [ ] M2 工具與 RBAC、審批
- [ ] M3 記憶（Memory / UserProfile、context 壓縮、session_search）
- [ ] M4 排程與非同步 Queue
- [ ] M5 技能（Drive `skills/`）
- [ ] M6 通道（Telegram webhook 部署 B、Email 指令信）
- [ ] M7 加固與維運
