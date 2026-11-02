#!/usr/bin/env bash
# 幫既有帳號補建部署 B（Telegram webhook，任何人）並寫回 accounts/<name>/deploy.json。
# 用法：scripts/add-webhook.sh --account <name>
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$REPO_DIR"
[[ "${1:-}" == "--account" && -n "${2:-}" ]] || die "用法：scripts/add-webhook.sh --account <name>"
ACCOUNT="$2"
need_tools
use_account "$ACCOUNT"
[[ -z "$(deploy_json_get "$ACCOUNT" deployB)" ]] || die "accounts/$ACCOUNT 已有部署 B：$(deploy_json_get "$ACCOUNT" deployB)"
trap manifest_restore EXIT
[[ "$(manifest_access)" == "MYSELF" ]] || die "manifest 的 webapp.access 不是 MYSELF"
step "帳號 ${ACCOUNT}：建立部署 B（任何人）"
manifest_set_access ANYONE_ANONYMOUS
clasp_u "$ACCOUNT" push -f >/dev/null
OUT="$(clasp_u "$ACCOUNT" --json deploy -d "Telegram webhook（任何人）" 2>&1 || true)"
DEPLOY_B="$(printf '%s' "$OUT" | parse_deployment_id)"
manifest_restore
clasp_u "$ACCOUNT" push -f >/dev/null
[[ -n "$DEPLOY_B" ]] || { echo "$OUT"; die "建立部署 B 失敗"; }
python3 - "$(account_dir "$ACCOUNT")/deploy.json" "$DEPLOY_B" <<'PY'
import json,sys
p,b=sys.argv[1:3]; d=json.load(open(p)); d["deployB"]=b; d["webhookExecUrl"]=f"https://script.google.com/macros/s/{b}/exec"
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PY
echo "部署 B：$DEPLOY_B"; echo "填進管理頁「通道」的網址：$(exec_url "$DEPLOY_B")"
