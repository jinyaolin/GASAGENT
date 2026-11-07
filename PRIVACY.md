# GAS Agent 隱私權政策與服務條款

GAS Agent 是一個開源的個人 agent，程式碼在 <https://github.com/jinyaolin/GASAGENT>。它以 Google Apps Script 的形式安裝在**使用者自己的 Google 帳號**裡，由使用者本人部署、本人授權、本人使用。

## 隱私權政策

- **資料存放**：對話、記憶、設定、紀錄全部存在使用者自己 Google Drive 裡的試算表與資料夾；API 金鑰與 token 只存在該 Apps Script 專案的 Script Properties。開發者（本專案作者）無法存取任何使用者的資料。
- **安裝服務**：<https://zaistudio.tw/agent> 只在使用者授權後，暫存一組 Apps Script 專案的授權（最多 24 小時），供使用者自己的 agent 領取，領取後立即刪除；不保存其他任何資料。
- **資料用途**：Gmail、Drive、文件、試算表、簡報、日曆等權限只用於執行使用者本人（或其授權的通道，例如本人的 Telegram）下達的任務。
- **第三方**：使用者自行設定的 AI 模型供應商（例如 OpenAI 相容服務、Anthropic、Google Gemini、Z.ai）會收到使用者交付任務時提供的內容；除此之外不會把資料傳給任何第三方，也沒有任何分析或追蹤。
- **程式更新**：`/upgrade` 功能只會從上述 GitHub repo **讀取**程式碼（公開檔案），不會上傳任何資料。
- **刪除**：使用者可隨時刪除 Apps Script 專案、Drive 裡的「GAS Agent」資料夾與試算表，即完全移除所有資料。

## 服務條款

- 本軟體依 repo 內授權條款以「現狀」提供，不附任何明示或默示的保證。
- 使用者須自行負責其 Google 帳號、AI 供應商帳號與 Telegram bot 的安全與費用。
- 使用者對 agent 代為執行的動作（寄信、建立或修改檔案等）負完全責任；本軟體預設把高風險動作送審批，但最終決定權與責任在使用者。
- 本服務目前為公測，不提供服務水準承諾，內容與方案可能變更。

聯絡：jinyao.lin@gmail.com

> 本文件與安裝服務的站內頁 <https://zaistudio.tw/agent/privacy>（`installer/src/pages.js` 的 `privacy()`）內容一致，修改時兩邊一起改。
