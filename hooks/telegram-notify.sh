#!/usr/bin/env bash
# Claude Code Notification hook → Telegram message (bikosoc).
# Sends a message when cc waits for permission or is idle.
# Routes to role=dev (bikosoc-dev) via Gateway notify endpoint.
# Non-fatal: exits 0 on any failure (hook must not block cc).
set -euo pipefail

INPUT=$(cat) || exit 0
NOTIF_TYPE=$(echo "$INPUT" | jq -r '.notification_type // ""' 2>/dev/null) || exit 0

case "$NOTIF_TYPE" in
  permission_prompt) TEXT="[bikosoc] cc wartet auf BERECHTIGUNG" ;;
  idle_prompt)       TEXT="[bikosoc] cc wartet auf Eingabe" ;;
  *)                 exit 0 ;;
esac

"$HOME/.scripts/notify" "$TEXT" info dev 2>/dev/null || true
exit 0
