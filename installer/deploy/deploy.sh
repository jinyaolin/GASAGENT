#!/usr/bin/env bash
# 把 installer/ 推到伺服器並重啟：
#   installer/deploy/deploy.sh [ssh-host]     預設 host 別名 zaistudio（~/.ssh/config）
# 第一次會建使用者、systemd unit、/opt/gas-agent-installer；.env 不會被覆蓋（沒有就從 .env.example 複製，之後請到伺服器填 GOOGLE_CLIENT_*）。
set -euo pipefail
HOST="${1:-zaistudio}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE=/opt/gas-agent-installer

echo "== 測試"
(cd "$DIR" && node --test >/dev/null) || { echo "測試失敗，停止"; exit 1; }

echo "== 同步到 $HOST:$REMOTE"
ssh "$HOST" "mkdir -p $REMOTE && id -u gasinstaller >/dev/null 2>&1 || useradd --system --home $REMOTE --shell /usr/sbin/nologin gasinstaller"
rsync -az --delete --exclude .env --exclude data --exclude node_modules "$DIR/" "$HOST:$REMOTE/"
ssh "$HOST" "set -e; cd $REMOTE; [ -f .env ] || { cp .env.example .env; echo '⚠️ 新建 .env：請填 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET'; }; mkdir -p data; chown -R gasinstaller:gasinstaller $REMOTE; chmod 700 data; chmod 600 .env; cp deploy/gas-agent-installer.service /etc/systemd/system/gas-agent-installer.service; systemctl daemon-reload; systemctl enable --now gas-agent-installer >/dev/null; systemctl restart gas-agent-installer; sleep 1; systemctl is-active gas-agent-installer; curl -fsS http://127.0.0.1:8790/healthz; echo"
echo "完成。"
