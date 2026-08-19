#!/usr/bin/env bash
# Installs only the runtime files required on the Beijing host.
# Source code and secrets are deliberately not part of this bundle.
set -Eeuo pipefail

readonly BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly APP_DIR="/opt/laixue"

install -d -m 755 "$APP_DIR/deploy" "$APP_DIR/scripts"
install -m 644 "$BUNDLE_DIR/docker-compose.server.yml" "$APP_DIR/docker-compose.server.yml"
install -m 644 "$BUNDLE_DIR/deploy/Caddyfile" "$APP_DIR/deploy/Caddyfile"
install -m 755 "$BUNDLE_DIR/scripts/reconcile-mainland-image.sh" "$APP_DIR/scripts/reconcile-mainland-image.sh"
install -m 644 "$BUNDLE_DIR/deploy/laixue-image-sync.service" /etc/systemd/system/laixue-image-sync.service
install -m 644 "$BUNDLE_DIR/deploy/laixue-image-sync.timer" /etc/systemd/system/laixue-image-sync.timer

systemctl daemon-reload
echo "RUNTIME_FILES_READY"
