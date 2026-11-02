#!/usr/bin/env bash
# install.sh / deploy.sh 共用：帳號設定檔、manifest 翻轉、clasp 包裝。
# 每個 Google 帳號一份 accounts/<name>/clasp.json（scriptId）與 deploy.json（部署 ID）；
# 執行前把 clasp.json 複製成根目錄 .clasp.json（clasp 3 不允許專案檔的 rootDir 指到資料夾外），憑證用 clasp -u <name>。

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$REPO_DIR/src/appsscript.json"

die() { echo "✗ $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

need_tools() {
  command -v node >/dev/null || die "需要 Node.js（https://nodejs.org）"
  command -v clasp >/dev/null || die "需要 clasp：npm i -g @google/clasp"
  command -v python3 >/dev/null || die "需要 python3（解析 JSON）"
}

# clasp_u <account> <args…>：以該帳號的憑證執行
clasp_u() { local acct="$1"; shift; clasp -u "$acct" "$@"; }

account_dir() { echo "$REPO_DIR/accounts/$1"; }

CLASP_JSON="$REPO_DIR/.clasp.json"
CLASP_JSON_BACKUP=""

# clasp_json_script_id <path>：讀 clasp.json 的 scriptId
clasp_json_script_id() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("scriptId",""))' "$1" 2>/dev/null || true; }

# 把帳號的 clasp.json 複製成根目錄 .clasp.json（M7-A 多帳號隔離）：
#   1. clasp.json 與 deploy.json 的 scriptId 必須一致，且不得與其他帳號的 scriptId 相同 —— 否則拒絕，避免把程式推到別的帳號的專案；
#   2. 先備份原本的根目錄 .clasp.json，腳本結束由 restore_clasp_json 還原，之後手動 `clasp push` 不會打到剛部署的那個帳號。
use_account() {
  local acct="$1" dir sid dsid other oname osid; dir="$(account_dir "$acct")"
  [[ -f "$dir/clasp.json" ]] || die "找不到 $dir/clasp.json；先跑 scripts/install.sh --account $acct"
  sid="$(clasp_json_script_id "$dir/clasp.json")"
  [[ -n "$sid" ]] || die "accounts/$acct/clasp.json 沒有 scriptId"
  if [[ -f "$dir/deploy.json" ]]; then
    dsid="$(deploy_json_get "$acct" scriptId)"
    [[ -z "$dsid" || "$dsid" == "$sid" ]] || die "accounts/$acct 的 clasp.json（$sid）與 deploy.json（$dsid）scriptId 不一致，拒絕推送：請確認這個資料夾沒有被別的帳號的檔案覆蓋"
  fi
  for other in "$REPO_DIR"/accounts/*/; do
    oname="$(basename "$other")"
    [[ "$oname" == "$acct" || ! -f "$other/deploy.json" ]] && continue
    osid="$(deploy_json_get "$oname" scriptId)"
    [[ -z "$osid" || "$osid" != "$sid" ]] || die "scriptId $sid 同時出現在 accounts/$acct 與 accounts/$oname：兩個帳號指到同一個 Apps Script 專案，請先釐清再部署"
  done
  if [[ -z "$CLASP_JSON_BACKUP" && -f "$CLASP_JSON" ]]; then CLASP_JSON_BACKUP="$(mktemp)"; cp "$CLASP_JSON" "$CLASP_JSON_BACKUP"; fi
  cp "$dir/clasp.json" "$CLASP_JSON"
}

# 還原 use_account 之前的根目錄 .clasp.json（沒有備份就不動）。
restore_clasp_json() {
  if [[ -n "$CLASP_JSON_BACKUP" && -f "$CLASP_JSON_BACKUP" ]]; then cp "$CLASP_JSON_BACKUP" "$CLASP_JSON"; rm -f "$CLASP_JSON_BACKUP"; CLASP_JSON_BACKUP=""; fi
}

# deploy_json_get <account> <key>
deploy_json_get() {
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get(sys.argv[2],""))' "$(account_dir "$1")/deploy.json" "$2" 2>/dev/null || true
}

manifest_access() { grep -o '"access": "[A-Z_]*"' "$MANIFEST" | sed 's/.*: "//; s/"//'; }
manifest_set_access() { sed -i '' "s/\"access\": \"[A-Z_]*\"/\"access\": \"$1\"/" "$MANIFEST"; }
manifest_restore() { manifest_set_access MYSELF; }

# 從 clasp deploy 的輸出（--json 或純文字 "Deployed <id> @N"）抓 deploymentId
parse_deployment_id() {
  python3 -c '
import json,re,sys
raw=sys.stdin.read()
def walk(o):
    if isinstance(o,dict):
        if "deploymentId" in o: return o["deploymentId"]
        for v in o.values():
            r=walk(v)
            if r: return r
    if isinstance(o,list):
        for v in o:
            r=walk(v)
            if r: return r
try:
    r=walk(json.loads(raw))
    if r: print(r); sys.exit(0)
except Exception: pass
m=re.search(r"Deployed\s+(AKfy[A-Za-z0-9_-]+)",raw) or re.search(r"(AKfy[A-Za-z0-9_-]{30,})",raw)
print(m.group(1) if m else "")
'
}

exec_url() { echo "https://script.google.com/macros/s/$1/exec"; }
