#!/usr/bin/env bash
# install-docs-mirror.sh — idempotente Einrichtung des Docs-Mirror.
#
# Richtet beide Ausloeser ein:
#   (a) git post-commit in allen drei Repos. executive-agent nutzt bereits
#       core.hooksPath=scripts/hooks; fuer executive-dashboard und workspace
#       wird core.hooksPath auf genau dieses Verzeichnis gesetzt (absoluter
#       Pfad), damit der Hook versioniert bleibt und nicht in .git/hooks
#       kopiert werden muss.
#   (b) systemd-user-Timer docs-mirror.timer, taeglich 04:30 Europe/Berlin.
#
# Aufruf: bash scripts/install-docs-mirror.sh   (aus dem EA-Repo-Root)
set -euo pipefail

EA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="${EA_DIR}/scripts/hooks"
UNIT_DIR="${HOME}/.config/systemd/user"
WS_DIR="${HOME}/.openclaw/workspace"
DASH_DIR="${WS_DIR}/.openclaw/extensions/executive-dashboard"

echo "== (a) git post-commit =="
for repo in "$EA_DIR" "$DASH_DIR" "$WS_DIR"; do
  if [ ! -e "$repo/.git" ]; then
    echo "  uebersprungen (kein Repo): $repo"
    continue
  fi
  ist="$(git -C "$repo" config --local core.hooksPath || true)"
  if [ "$repo" = "$EA_DIR" ]; then
    soll="scripts/hooks"      # relativ, so wie bisher eingerichtet
  else
    soll="$HOOKS_DIR"         # absolut, zeigt auf das EA-Repo
  fi
  if [ "$ist" = "$soll" ]; then
    echo "  unchanged: $(basename "$repo") -> $soll"
  else
    git -C "$repo" config --local core.hooksPath "$soll"
    echo "  gesetzt:   $(basename "$repo") -> $soll"
  fi
done

echo "== (b) systemd-user-Timer =="
mkdir -p "$UNIT_DIR"
changed=false
for unit in docs-mirror.service docs-mirror.timer; do
  src="${EA_DIR}/scripts/systemd/${unit}"
  dest="${UNIT_DIR}/${unit}"
  if [ ! -f "$dest" ] || ! cmp -s "$src" "$dest"; then
    cp "$src" "$dest"
    echo "  installiert/aktualisiert: $unit"
    changed=true
  else
    echo "  unchanged: $unit"
  fi
done
if $changed; then systemctl --user daemon-reload; fi
systemctl --user enable --now docs-mirror.timer >/dev/null
systemctl --user list-timers docs-mirror.timer --no-pager | sed -n '1,3p'

echo "== fertig =="
echo "Erstlauf von Hand:  bun scripts/docs-mirror.ts"
