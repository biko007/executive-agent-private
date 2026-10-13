#!/usr/bin/env bash
# install-ops-bin.sh — Idempotenter Installer fuer die Betriebsskripte.
#
# Kopiert ops/bin/* nach ~/bin/, setzt chmod 700.
# Meldet je Datei: installed / unchanged / updated
# Aufruf: bash scripts/install-ops-bin.sh (aus dem EA-Repo-Root)
#
# WARUM KOPIEREN UND NICHT VERLINKEN. Ein Symlink ins Repo waere kuerzer, aber
# er zeigt ins Leere, sobald das Repo umzieht, auf einem anderen Stand steht
# oder gerade nicht ausgecheckt ist. Die Skripte sind Betriebswerkzeuge — sie
# muessen auch dann funktionieren. Denselben Weg geht scripts/install-hooks.sh.
#
# RECHTE 700, NICHT 755. casameta-credentials nimmt ein Passwort entgegen; die
# Datei selbst enthaelt zwar keines, aber sie schreibt eine Datei, die eines
# enthaelt. Es gibt keinen Grund, sie fuer andere lesbar zu halten.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_BIN="$(cd "$SCRIPT_DIR/.." && pwd)/ops/bin"
LIVE_BIN="$HOME/bin"

if [ ! -d "$REPO_BIN" ]; then
  echo "ERROR: ops/bin nicht gefunden unter $REPO_BIN" >&2
  exit 1
fi

mkdir -p "$LIVE_BIN"

any_change=false

for quelle in "$REPO_BIN"/*; do
  [ -f "$quelle" ] || continue
  name="$(basename "$quelle")"
  ziel="$LIVE_BIN/$name"

  if [ ! -f "$ziel" ]; then
    cp "$quelle" "$ziel"
    chmod 700 "$ziel"
    echo "installed:  $name"
    any_change=true
  elif ! cmp -s "$quelle" "$ziel"; then
    cp "$quelle" "$ziel"
    chmod 700 "$ziel"
    echo "updated:    $name"
    any_change=true
  else
    # Rechte auch dann nachziehen, wenn der Inhalt stimmt.
    chmod 700 "$ziel"
    echo "unchanged:  $name"
  fi
done

echo ""
if $any_change; then
  echo "Done. Die Betriebsskripte in ~/bin sind aktuell."
else
  echo "Done. Alle Betriebsskripte aktuell — kein Update noetig."
fi
