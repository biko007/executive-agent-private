#!/usr/bin/env bash
# Automatic pg_dump before AUTO runs. Keeps last 10.
set -euo pipefail
source "$HOME/.config/openclaw/env"
BACKUP_DIR="$HOME/backups"
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
pg_dump "$POSTGRES_URL" -Fc -f "$BACKUP_DIR/openclaw-${STAMP}.dump"
# Rotate: keep newest 10
ls -1t "$BACKUP_DIR"/openclaw-*.dump 2>/dev/null | tail -n +11 | xargs -r rm --
echo "Backup: openclaw-${STAMP}.dump"
