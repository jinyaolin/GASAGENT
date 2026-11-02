#!/usr/bin/env bash
# 推送程式碼並更新某個帳號的兩個 Web App 部署：
#   部署 A（管理頁）：appsscript.json 的 webapp.access = MYSELF（只限我）
#   部署 B（Telegram webhook）：webapp.access = ANYONE_ANONYMOUS（任何人）
# Apps Script 的存取等級寫在 manifest 裡、一個版本一種，所以 B 要在翻轉 manifest 後另推一個版本；trap 保證翻回。
# 用法：scripts/deploy.sh [--account <name>] "說明"      # 預設帳號 default；部署 ID 讀 accounts/<name>/deploy.json
#       DRY=1 scripts/deploy.sh "說明"                    # 只印出會執行的 clasp 指令
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$REPO_DIR"

ACCOUNT="${ACCOUNT:-default}"
if [[ "${1:-}" == "--account" ]]; then ACCOUNT="$2"; shift 2; fi
DESC="${1:-update}"
need_tools
use_account "$ACCOUNT"
DEPLOY_A="$(deploy_json_get "$ACCOUNT" deployA)"
DEPLOY_B="$(deploy_json_get "$ACCOUNT" deployB)"
[[ -n "$DEPLOY_A" ]] || die "accounts/$ACCOUNT/deploy.json 沒有 deployA"

run() { if [[ -n "${DRY:-}" ]]; then echo "  (dry) $*"; else "$@"; fi; }
trap manifest_restore EXIT
[[ "$(manifest_access)" == "MYSELF" ]] || die "manifest 的 webapp.access 不是 MYSELF，先手動確認 $MANIFEST"

step "本機 pure 測試"
node scripts/local-tests.js >/dev/null || die "本機測試失敗，停止"

step "帳號 $ACCOUNT：部署 A（只限我）$DEPLOY_A"
run clasp_u "$ACCOUNT" push -f >/dev/null
run clasp_u "$ACCOUNT" deploy -i "$DEPLOY_A" -d "$DESC"

if [[ -n "$DEPLOY_B" ]]; then
  step "部署 B（任何人；Telegram webhook）$DEPLOY_B"
  manifest_set_access ANYONE_ANONYMOUS
  run clasp_u "$ACCOUNT" push -f >/dev/null
  run clasp_u "$ACCOUNT" deploy -i "$DEPLOY_B" -d "$DESC（webhook）"
  manifest_restore
  run clasp_u "$ACCOUNT" push -f >/dev/null   # 讓編輯器裡的 manifest 回到 MYSELF
else
  echo "（這個帳號沒有部署 B，略過）"
fi
echo; echo "完成。管理頁：$(exec_url "$DEPLOY_A")"
