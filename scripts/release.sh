#!/usr/bin/env bash
# 發佈一版給 Telegram /upgrade 用（Upgrade.gs）：
#   1. 跑本機 pure 測試；2. 把 src/Config.gs 的 APP_VERSION 改成新版號並 commit（code commit）；
#   3. 以該 commit 的 sha 與 src/ 每個檔的 sha256 產生 release.json 並再 commit 一次；4. --push 時推到 origin。
# 各帳號的 agent 之後 /upgrade 會抓 raw.githubusercontent.com/<repo>/<ref>/release.json，以裡面的 commit 釘住抓檔並驗 hash。
# 用法：scripts/release.sh <版本> "說明" [--push]      例：scripts/release.sh 0.8.0 "Telegram /upgrade 自我升級" --push
#       DRY=1 scripts/release.sh 0.8.0 "說明"            只印出會做的事
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$REPO_DIR"

VERSION="${1:-}"; NOTES="${2:-}"; PUSH=""
[[ "${3:-}" == "--push" ]] && PUSH=1
[[ -n "$VERSION" && -n "$NOTES" ]] || die "用法：scripts/release.sh <版本> \"說明\" [--push]"
[[ "$VERSION" =~ ^[0-9]+(\.[0-9]+)*([A-Za-z0-9.-]*)$ ]] || die "版本號格式：例 0.8.0 或 0.8.0-rc1"
command -v node >/dev/null || die "需要 Node.js"
command -v python3 >/dev/null || die "需要 python3"
[[ -z "$(git status --porcelain)" ]] || die "工作樹不乾淨，先 commit 或 stash"
[[ "$(manifest_access)" == "MYSELF" ]] || die "manifest 的 webapp.access 不是 MYSELF"
CURRENT="$(grep -o "const APP_VERSION = '[^']*'" src/Config.gs | sed "s/.*'\(.*\)'/\1/")"
[[ -n "$CURRENT" ]] || die "src/Config.gs 找不到 APP_VERSION"
[[ "$CURRENT" != "$VERSION" ]] || die "APP_VERSION 已經是 $VERSION"

run() { if [[ -n "${DRY:-}" ]]; then echo "  (dry) $*"; else "$@"; fi; }

step "本機 pure 測試"
node scripts/local-tests.js >/dev/null || die "本機測試失敗，停止"

step "APP_VERSION $CURRENT → $VERSION（code commit）"
if [[ -z "${DRY:-}" ]]; then
  sed -i '' "s/const APP_VERSION = '[^']*'/const APP_VERSION = '$VERSION'/" src/Config.gs
  git add src/Config.gs
  git commit -q -m "v$VERSION: $NOTES" ${COMMIT_TRAILER:+-m "$COMMIT_TRAILER"}
fi
CODE_SHA="$(git rev-parse HEAD)"
echo "code commit $CODE_SHA"

step "產生 release.json（release commit）"
python3 - "$VERSION" "$CODE_SHA" "$NOTES" <<'PY'
import hashlib, json, os, sys, datetime
version, sha, notes = sys.argv[1:4]
files = {}
for name in sorted(os.listdir('src')):
    p = os.path.join('src', name)
    if os.path.isfile(p):
        files['src/' + name] = hashlib.sha256(open(p, 'rb').read()).hexdigest()
rel = {'version': version, 'commit': sha, 'date': datetime.datetime.now().astimezone().isoformat(timespec='seconds'), 'notes': notes, 'files': files}
json.dump(rel, open('release.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open('release.json', 'a').write('\n')
print(f"release.json：v{version}，{len(files)} 個檔，commit {sha[:7]}")
PY
if [[ -z "${DRY:-}" ]]; then
  git add release.json
  git commit -q -m "release.json v$VERSION" ${COMMIT_TRAILER:+-m "$COMMIT_TRAILER"}
else
  git checkout -q -- release.json 2>/dev/null || rm -f release.json
fi

if [[ -n "$PUSH" ]]; then
  step "推到 origin"
  run git push -u origin "$(git rev-parse --abbrev-ref HEAD)"
fi
echo; echo "完成：v$VERSION。各帳號 Telegram 輸入 /upgrade 即可看到新版並送審批；維護者仍可用 scripts/deploy.sh 直接推。"
