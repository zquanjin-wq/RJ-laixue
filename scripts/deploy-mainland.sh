#!/usr/bin/env bash
# Runs only on the mainland production server. It intentionally does not copy
# secrets: .env.deploy is created once on that server and remains outside Git.
set -Eeuo pipefail

readonly APP_DIR="/opt/laixue/app"
readonly REVISION="${1:?usage: deploy-mainland.sh <git-sha>}"

cd "$APP_DIR"
test -f .env.deploy || { echo "Missing $APP_DIR/.env.deploy" >&2; exit 1; }

git fetch --quiet origin main
git checkout --detach --quiet "$REVISION"

export LAIXUE_IMAGE_TAG="$REVISION"
docker compose --env-file .env.deploy config --quiet
docker compose --env-file .env.deploy build laixue
docker compose --env-file .env.deploy up -d --remove-orphans

for _ in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1/api/health >/dev/null; then
    echo "Deployment healthy: $REVISION"
    exit 0
  fi
  sleep 2
done

docker compose --env-file .env.deploy logs --tail=150 laixue caddy >&2
echo "Deployment did not become healthy: $REVISION" >&2
exit 1
