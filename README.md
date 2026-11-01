# GAS Agent

跑在 Google Apps Script（GAS）上的個人 agent，精神原型是 [hermes-agent](https://github.com/nousresearch/hermes-agent)：
零伺服器、常駐於自己的 Google 帳號，用 Google Sheet 當長期記憶、Drive 資料夾放技能，
透過只有本人能開的管理頁設定多組 AI provider，並有 Gmail / Drive / Docs / Slides / Sheets / Calendar 工具與排程。

完整規格與里程碑在本機 vault：`~/vault/20-projects/gas-agent.md`。目前進度：**M0 骨架**。

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
  Db.gs             # 開/建「GAS Agent DB」spreadsheet、DB_SCHEMA（11 個 tab）、幂等補 schema
  Queue.gs          # queueTick() 空殼（M4 放 job 狀態機）
  Setup.gs          # installAgent()：寫 OWNER_EMAIL、建 DB、裝每分鐘 trigger（可重跑）
  Admin.gs          # doGet 路由 + admin* 後端入口
  AdminPage.html / admin_js.html / admin_css.html   # 管理頁 SPA（檔名避開與 Admin.gs 撞名）
  Doctor.gs         # runDoctor()：Properties / tabs / trigger / scopes / 時區 健檢
  Tests.gs          # runSmokeTests()
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

部署後複製「網頁應用程式 URL」。之後每次 `clasp push` 後要讓線上管理頁更新，需「部署 → 管理部署作業 → 編輯 → 版本：新版本」，或用：

```bash
clasp create-deployment --description "m0"
```

> 注意：`clasp create-deployment` 會建立一個**新的**部署（新 URL）。要更新既有部署請用 `clasp update-deployment <deploymentId>`（`clasp list-deployments` 可查 id）。

### 5. 打開管理頁，看 Doctor

用本人 Google 帳號開「網頁應用程式 URL」→ 左側「Doctor」分頁。全部綠燈代表 M0 完成：

- OWNER_EMAIL / DB_SPREADSHEET_ID 已設定
- DB spreadsheet 可開啟，11 個 tab 表頭完整
- 每分鐘 trigger 恰好 1 支
- 已授權 scopes 涵蓋 `appsscript.json`
- 時區 Asia/Taipei；Web App 已部署（黃燈僅提醒）

驗收另一半：用另一個 Google 帳號開同一 URL，應被 Google 擋在登入 / 權限頁，看不到管理頁。

## 開發流程

```bash
clasp push
```

```bash
clasp status
```

- 編輯 `src/` 下的檔案 → `clasp push` → 在編輯器或管理頁驗證 → `git commit`。
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
| DB 被誤刪 | `installAgent()` 偵測到檔案在垃圾桶會建新的；要救回舊資料請先從垃圾桶還原再執行 |

## 里程碑

- [x] M0 骨架：repo + clasp、scopes、`installAgent()`、管理頁空殼、Doctor、smoke tests
- [ ] M1 多 provider（OpenAI 相容 / Anthropic / Gemini）、聊天台
- [ ] M2 工具與 RBAC、審批
- [ ] M3 記憶（Memory / UserProfile、context 壓縮、session_search）
- [ ] M4 排程與非同步 Queue
- [ ] M5 技能（Drive `skills/`）
- [ ] M6 通道（Telegram webhook 部署 B、Email 指令信）
- [ ] M7 加固與維運
