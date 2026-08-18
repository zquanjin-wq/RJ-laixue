#!/usr/bin/env bash
# Pulls the newest validated :main image from Tencent TCR and lets Compose
# recreate only services whose image changed. Safe to run from a systemd timer.
set -Eeuo pipefail

readonly APP_DIR="/opt/laixue"
readonly IMAGE="ccr.ccs.tencentyun.com/laixue-ruijie/web:main"

cd "$APP_DIR"
test -f .env.deploy || { echo "Missing $APP_DIR/.env.deploy" >&2; exit 1; }

export LAIXUE_IMAGE="$IMAGE"
docker compose -f docker-compose.server.yml --env-file .env.deploy pull laixue
docker compose -f docker-compose.server.yml --env-file .env.deploy up -d --remove-orphans

for _ in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1/api/health >/dev/null; then
    echo "Mainland image healthy: $IMAGE"
    exit 0
  fi
  sleep 2
done

docker compose -f docker-compose.server.yml --env-file .env.deploy logs --tail=150 laixue caddy >&2
exit 1
