#!/usr/bin/env bash
# 推送程式碼並更新兩個 Web App 部署（M6 起）：
#   部署 A（管理頁）：appsscript.json 的 webapp.access = MYSELF（只限我）
#   部署 B（Telegram webhook）：webapp.access = ANYONE_ANONYMOUS（任何人）
# Apps Script 的存取等級寫在 manifest 裡，每個版本只能有一種；所以 B 要在翻轉 manifest 後另推一個版本。
# 用法：scripts/deploy.sh "說明"            # 更新 A 與 B
#       DEPLOY_B= scripts/deploy.sh "說明"  # 只更新 A（還沒有 B 時）
#       CREATE_B=1 scripts/deploy.sh "說明" # 建立新的部署 B（印出 ID，之後填進 DEPLOY_B）
set -euo pipefail
cd "$(dirname "$0")/.."
DESC="${1:-update}"
DEPLOY_A="${DEPLOY_A:-AKfycbxAKDqOAOWHi_JCm_P0EzADWLNByeEx7xlI3Hp6rx3hXlT8JfHAYbrLqwI6A26e7aPjGQ}"
DEPLOY_B="${DEPLOY_B-AKfycbypDGHfZ6Ez0HktdBY0WcysnAEePAyBuaLtDU_maOW5ovPtWvFhHcFlLEjqPpagkkqkug}"
MANIFEST=src/appsscript.json

restore() { sed -i '' 's/"access": "ANYONE_ANONYMOUS"/"access": "MYSELF"/' "$MANIFEST"; }
trap restore EXIT

grep -q '"access": "MYSELF"' "$MANIFEST" || { echo "manifest 不是 MYSELF，先手動確認 $MANIFEST"; exit 1; }
node scripts/local-tests.js >/dev/null || { echo "本機測試失敗，停止"; exit 1; }

echo "== 部署 A（只限我）"
clasp push -f >/dev/null
clasp deploy -i "$DEPLOY_A" -d "$DESC"

if [[ -n "${CREATE_B:-}" || -n "$DEPLOY_B" ]]; then
  echo "== 部署 B（任何人；Telegram webhook）"
  sed -i '' 's/"access": "MYSELF"/"access": "ANYONE_ANONYMOUS"/' "$MANIFEST"
  clasp push -f >/dev/null
  if [[ -n "${CREATE_B:-}" ]]; then
    clasp deploy -d "Telegram webhook（任何人）$DESC"
    echo "↑ 把新部署 ID 填進 scripts/deploy.sh 的 DEPLOY_B 與管理頁「通道」的部署 B 網址"
  else
    clasp deploy -i "$DEPLOY_B" -d "$DESC（webhook）"
  fi
  restore
  clasp push -f >/dev/null   # 讓編輯器裡的 manifest 回到 MYSELF
fi
echo "完成。"
