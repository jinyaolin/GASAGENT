# gas-agent-installer

GAS Agent 的安裝 / 升級授權服務。零依賴 Node ≥ 20，掛在 Caddy 的 `https://zaistudio.tw/agent` 底下。

**為什麼需要它**：Apps Script API 不接受用「預設 GCP 專案」的腳本自己的 token（403 `has not been used in project …`），所以 agent 不能用 `ScriptApp.getOAuthToken()` 改寫自己。做法和 clasp 一樣：用**本服務的 OAuth client** 替使用者換一個 token（只要 `script.projects` / `script.deployments`），交給 agent 自己保管、自己 refresh。使用者不用建 GCP 專案、不用 clasp。

## 兩個流程

| 流程 | 入口 | 服務做的事 | 使用者拿到 |
|---|---|---|---|
| 全新安裝 | `GET /install`（準備頁）→ `GET /install/start` | Google 授權 → `projects.create` → 從 GitHub release 灌程式（驗 sha256）→ 建版 → 部署 A（MYSELF）→ 翻 manifest → 建版 → 部署 B（ANYONE_ANONYMOUS）→ manifest 還原 | 管理頁網址、webhook 網址、取件碼 |
| 既有 agent 取升級授權 | `GET /upgrade/start`（Telegram `/upgrade login` 給的連結） | Google 授權 → 取件碼 | 取件碼 → Telegram `/upgrade code XXXX-XXXX` |

agent 用 `POST /pickup {code}` 領走 `{refresh_token, client_id, client_secret, email, scope}`，服務即刪；24 小時沒領也刪。服務**不保存任何使用者資料**；取件碼待領期間放 `DATA_DIR/pickups.json`（0600）。

## 檔案

| 路徑 | 說明 |
|---|---|
| `src/server.js` | 路由：`/`（產品頁）、`/install`（安裝前準備）、`/privacy`、`/install/start`、`/upgrade/start`、`/oauth/callback`、`POST /pickup`、`/healthz` |
| `src/google.js` | Google OAuth（授權網址、換 token、userinfo）、Apps Script API client、錯誤訊息 |
| `src/release.js` | release.json 解析、以 commit 釘住抓檔驗 sha256、manifest access 翻轉、`installFresh` |
| `src/pickup.js` | 取件碼（檔案）、OAuth state（記憶體）、速率限制 |
| `src/pages.js` | 繁中頁面（Zai Studio「暗夜書房」風格：暖墨黑、燭光金、宋體）：產品頁、準備頁、完成頁上手清單、升級授權、錯誤、隱私權與條款；`setBaseUrl()` 讓站內連結帶 `/agent` 前綴 |
| `deploy/gas-agent-installer.service` / `deploy/deploy.sh` | systemd unit、rsync 部署 |

## 一次性設定（維護者）

1. GCP 專案（例 `gas-agent-updater`）：啟用 **Apps Script API**；OAuth 同意畫面「外部」、**發布到正式版**（測試中會七天過期）、不上傳標誌（上傳就要送驗證）。
2. 憑證 → 建立 OAuth 用戶端 ID → 類型「網頁應用程式」→ 已授權的重新導向 URI 填 `https://zaistudio.tw/agent/oauth/callback` → 取得 client id / secret。
3. 伺服器 `/opt/gas-agent-installer/.env`（0600）填 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `BASE_URL`。**client secret 只在這裡，不進 repo。**
4. Caddy：`redir /agent /agent/ 308` 與 `handle_path /agent/* { reverse_proxy 127.0.0.1:8790 }`（放在主站 catch-all 前面）。
5. `installer/deploy/deploy.sh` 部署；`curl https://zaistudio.tw/agent/healthz` 看 `configured: true`。

## 測試

```bash
cd installer && node --test
```

假 Google / 假 GitHub / 假 Apps Script API 全部注入 `fetch`，不碰網路。

## 使用者流程（頁面）

1. **產品頁** `/`：介紹、功能、運作方式、安全與隱私、方案（公測期間個人版免費 / 團隊導入洽詢）、常見問題。
2. **安裝前準備** `/install`：開 Apps Script API、預告「Google 尚未驗證」畫面與權限範圍；兩個勾選框都勾才能按「用 Google 登入並安裝」（沒 JS 時按鈕照常可用）。
3. **Google 授權 → 自動建置**（`/install/start` → `/oauth/callback`，約 20–40 秒）。
4. **完成頁**：四步上手清單（打開管理頁授權並安裝 → 接模型 → 接 Telegram → `/upgrade code`），管理頁 / webhook / 取件碼都可一鍵複製。

隱私權與條款頁 `/privacy` 與 repo 根目錄的 `PRIVACY.md` 內容一致，修改時兩邊一起改。
