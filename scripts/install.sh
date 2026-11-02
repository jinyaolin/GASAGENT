#!/usr/bin/env bash
# 把目前這版 GAS Agent 安裝到一個 Google 帳號：登入 → 建 Apps Script 專案 → push → （手動）授權 installAgent() →
# 建部署 A（管理頁，只限我）與部署 B（Telegram webhook，任何人）→ 寫 accounts/<name>/{clasp.json,deploy.json}。
#
# 用法：scripts/install.sh --account <name> [--title "GAS Agent"] [--no-webhook] [--skip-login]
#   <name>  這個帳號在本機的代號（clasp -u <name> 的憑證名；之後 scripts/deploy.sh --account <name> 用）
# 需要人工的兩步（Google 沒有 API 可代勞）：瀏覽器登入 Google、在編輯器執行 installAgent() 按「允許」。
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$REPO_DIR"

ACCOUNT=""; TITLE="GAS Agent"; WEBHOOK=1; LOGIN=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --account) ACCOUNT="$2"; shift 2;;
    --title) TITLE="$2"; shift 2;;
    --no-webhook) WEBHOOK=0; shift;;
    --skip-login) LOGIN=0; shift;;
    -h|--help) sed -n '2,9p' "$0"; exit 0;;
    *) die "不認得的參數 $1";;
  esac
done
[[ -n "$ACCOUNT" ]] || die "請給 --account <name>（例：--account work）"
[[ "$ACCOUNT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "account 只能用小寫字母 / 數字 / - / _"
need_tools
DIR="$(account_dir "$ACCOUNT")"
if [[ -f "$DIR/deploy.json" ]]; then
  die "accounts/$ACCOUNT 已存在（scriptId $(deploy_json_get "$ACCOUNT" scriptId)）。要更新程式請用 scripts/deploy.sh --account $ACCOUNT；要重裝請先把該資料夾移走。"
fi
mkdir -p "$DIR"
trap manifest_restore EXIT
[[ "$(manifest_access)" == "MYSELF" ]] || die "manifest 的 webapp.access 不是 MYSELF，先手動確認 $MANIFEST"

step "0/6 本機 pure 測試"
node scripts/local-tests.js >/dev/null || die "本機測試失敗，停止"

if [[ $LOGIN -eq 1 ]]; then
  step "1/6 以新帳號登入 clasp（憑證名 $ACCOUNT；瀏覽器會開 Google 登入，請選**要安裝到的那個 Gmail**）"
  clasp_u "$ACCOUNT" login
fi
EMAIL="$(clasp_u "$ACCOUNT" show-authorized-user 2>/dev/null | python3 -c 'import re,sys; m=re.search(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", sys.stdin.read()); print(m.group(0) if m else "")' || true)"
echo "目前憑證：${EMAIL:-（讀不到 email，繼續）}"

step "2/6 開啟 Apps Script API（每個帳號只需一次）"
echo "請用**同一個帳號**開 https://script.google.com/home/usersettings 把「Google Apps Script API」切成開啟。"
command -v open >/dev/null && open "https://script.google.com/home/usersettings" || true
read -r -p "開好了按 Enter 繼續… " _

step "3/6 建立 Apps Script 專案「$TITLE」並推送程式碼"
BACKUP=""
if [[ -f .clasp.json ]]; then BACKUP=".clasp.json.bak.$$"; mv .clasp.json "$BACKUP"; fi
if ! clasp_u "$ACCOUNT" create-script --type standalone --title "$TITLE" --rootDir src; then
  [[ -n "$BACKUP" ]] && mv "$BACKUP" .clasp.json
  die "建立專案失敗：通常是 Apps Script API 還沒開（等一分鐘再試），或登入的帳號不對。"
fi
cp .clasp.json "$DIR/clasp.json"
[[ -n "$BACKUP" ]] && rm -f "$BACKUP"
SCRIPT_ID="$(python3 -c 'import json;print(json.load(open(".clasp.json"))["scriptId"])')"
clasp_u "$ACCOUNT" push -f >/dev/null
echo "scriptId：$SCRIPT_ID（已推 $(ls src | wc -l | tr -d ' ') 個檔案）"

step "4/6 授權：在編輯器執行 installAgent()"
cat <<MSG
瀏覽器會開 Apps Script 編輯器。請：
  1. 上方函式下拉選「installAgent」→ 按「執行」。
  2. 跳出授權畫面 → 選同一個帳號 → 「進階」→「前往 $TITLE（不安全）」→ 勾選全部 → 允許（這是你自己的 script）。
  3. 執行紀錄印出 JSON（owner / DB url / trigger.created: true / skills.installed）就完成。
MSG
clasp_u "$ACCOUNT" open-script >/dev/null 2>&1 || echo "（開不了瀏覽器就手動開 https://script.google.com/d/$SCRIPT_ID/edit）"
read -r -p "installAgent() 跑完後按 Enter 繼續… " _

step "5/6 建立部署 A（管理頁，只限我）"
OUT_A="$(clasp_u "$ACCOUNT" --json deploy -d "管理頁（只限我）" 2>&1 || true)"
DEPLOY_A="$(printf '%s' "$OUT_A" | parse_deployment_id)"
[[ -n "$DEPLOY_A" ]] || { echo "$OUT_A"; die "建立部署 A 失敗（上面是 clasp 的輸出）"; }
echo "部署 A：$DEPLOY_A"

DEPLOY_B=""
if [[ $WEBHOOK -eq 1 ]]; then
  step "6/6 建立部署 B（Telegram webhook，任何人）"
  manifest_set_access ANYONE_ANONYMOUS
  clasp_u "$ACCOUNT" push -f >/dev/null
  OUT_B="$(clasp_u "$ACCOUNT" --json deploy -d "Telegram webhook（任何人）" 2>&1 || true)"
  DEPLOY_B="$(printf '%s' "$OUT_B" | parse_deployment_id)"
  manifest_restore
  clasp_u "$ACCOUNT" push -f >/dev/null
  [[ -n "$DEPLOY_B" ]] || { echo "$OUT_B"; die "建立部署 B 失敗（上面是 clasp 的輸出）；部署 A 已建好，之後可用 scripts/add-webhook.sh --account $ACCOUNT 補"; }
  echo "部署 B：$DEPLOY_B"
else
  echo "（--no-webhook：略過部署 B）"
fi

python3 - "$DIR/deploy.json" "$ACCOUNT" "${EMAIL:-}" "$SCRIPT_ID" "$DEPLOY_A" "$DEPLOY_B" <<'PY'
import json,sys,datetime
path,acct,email,sid,a,b=sys.argv[1:7]
url=lambda d: f"https://script.google.com/macros/s/{d}/exec" if d else ""
json.dump({"account":acct,"email":email,"scriptId":sid,"deployA":a,"deployB":b,"adminUrl":url(a),"webhookExecUrl":url(b),
           "created":datetime.date.today().isoformat()},open(path,"w"),ensure_ascii=False,indent=2)
PY

cat <<MSG

✅ 安裝完成（設定存在 accounts/$ACCOUNT/，之後更新程式用 scripts/deploy.sh --account $ACCOUNT "說明"）

管理頁（用這個帳號登入開）：$(exec_url "$DEPLOY_A")
$( [[ -n "$DEPLOY_B" ]] && echo "部署 B（Telegram webhook 用，填進管理頁「通道」）：$(exec_url "$DEPLOY_B")" )

接下來在管理頁：
  1. Doctor 分頁 → 全綠（第一次會寫入內建技能）→ 跑 smoke tests。
  2. 模型分頁 → 新增 provider、貼 API key → 測試連線。
  3. 工具分頁 → 視需要開 gmail / drive 的 external（寄信 / 分享要審批）。
  4. 通道分頁 → Telegram：@BotFather 建 bot 取 token、白名單填自己的 user id、部署 B 網址貼上面那個 → 儲存 → 設定 webhook。
     Email：啟用、建立標籤 agent/inbox。
MSG
