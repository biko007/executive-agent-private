#!/usr/bin/env bash
# cc-sitzung-start.sh — Claude Code in einer per Autostart angelegten
# tmux-Sitzung starten (Prompt-Inbox, Spec Cowork-Platform §13.1).
#
# Aufruf durch die Inbox:  tmux new-session -d -s <sitzung> -c <verzeichnis> <dieses Skript>
# Arbeitsverzeichnis = aktuelles Verzeichnis (von tmux -c gesetzt).
# Anmeldung wie Sitzung bikosoc über scripts/cc-anmeldung.sh. Über tmux läuft
# nur dieser Pfad, nie ein Token.

set -euo pipefail
set +x
# shellcheck source=cc-anmeldung.sh
source "$(dirname "$(readlink -f "$0")")/cc-anmeldung.sh"
# Dieselbe Installation wie bikosoc (~/.npm-global). Nicht `command -v`: Im
# tmux-Server steht /usr/bin vorn, dort liegt eine alte Fassung (05.11.2026:
# 2.1.143 statt 2.1.318).
CLAUDE_BIN="${HOME}/.npm-global/bin/claude"
[[ -x "$CLAUDE_BIN" ]] || CLAUDE_BIN="$(command -v claude)"
exec "$CLAUDE_BIN" --dangerously-skip-permissions
