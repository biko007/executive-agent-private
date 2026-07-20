#!/usr/bin/env bash
# install-hooks.sh — Idempotenter Claude Code Hook Installer
# Kopiert hooks/*.sh nach ~/.claude/hooks/, setzt chmod +x.
# Meldet pro Hook: installed / unchanged / updated
# Aufruf: bash scripts/install-hooks.sh (aus EA-Repo-Root)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_HOOKS="$(cd "$SCRIPT_DIR/.." && pwd)/hooks"
LIVE_HOOKS="$HOME/.claude/hooks"

if [ ! -d "$REPO_HOOKS" ]; then
  echo "ERROR: hooks/ not found at $REPO_HOOKS" >&2
  exit 1
fi

mkdir -p "$LIVE_HOOKS"

any_change=false

for hook in "$REPO_HOOKS"/*.sh; do
  [ -f "$hook" ] || continue
  name="$(basename "$hook")"
  dest="$LIVE_HOOKS/$name"

  if [ ! -f "$dest" ]; then
    cp "$hook" "$dest"
    chmod +x "$dest"
    echo "installed:  $name"
    any_change=true
  elif ! cmp -s "$hook" "$dest"; then
    cp "$hook" "$dest"
    chmod +x "$dest"
    echo "updated:    $name"
    any_change=true
  else
    echo "unchanged:  $name"
  fi
done

echo ""
if $any_change; then
  echo "Done. Geänderte Hooks sind aktiv (PreToolUse wiring ohne Neustart)."
else
  echo "Done. Alle Hooks aktuell — kein Update nötig."
fi
