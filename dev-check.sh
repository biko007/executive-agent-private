#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "==> build (tsc -p tsconfig.json)"
npm run -s build

echo "==> node syntax check dist/index.js"
npm run -s check:node

echo "==> restart service"
systemctl --user restart openclaw-gateway.service

echo "==> status (first lines)"
systemctl --user --no-pager --full status openclaw-gateway.service | sed -n '1,18p' || true

echo "==> tail log (if present)"
LOG="/tmp/openclaw/openclaw-$(date +%F).log"
if [[ -f "$LOG" ]]; then
  tail -n 120 "$LOG"
else
  echo "(no log file at $LOG)"
fi

echo "OK"
