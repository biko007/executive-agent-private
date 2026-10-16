#!/usr/bin/env bash
# install-hooks.sh — Idempotenter Claude Code Hook Installer
# Kopiert hooks/*.sh nach ~/.claude/hooks/, setzt chmod +x.
# Meldet pro Hook: installed / unchanged / updated
# Aufruf: bash scripts/install-hooks.sh (aus EA-Repo-Root)
#
# ──────────────────────────────────────────────────────────────────────────
# EINE DATEI, ZWEI STRÄNGE (Owner-Auftrag 16.10.2026)
#
# `~/.claude/hooks/` ist für alle Stränge dieselbe Stelle. bikosoc und HDCC
# pflegen den Deny-Hook aber in je eigenen Repos und spielen beide hierhin
# aus. Wer zuletzt installiert, gewinnt — und die Arbeit des anderen ist weg,
# ohne dass es jemand merkt.
#
# Am 16.10.2026 ist genau das beinahe passiert: Die HDCC-Sitzung hatte den
# aktiven Hook um 12:25 erweitert; ein `install-hooks.sh` aus bikosoc hätte
# die Erweiterung kommentarlos überschrieben. Aufgefallen ist es nur, weil der
# Smoke-Test Drift meldete und jemand nachgesehen hat.
#
# DIE SPERRE: Neben jedem Hook liegt eine Marke mit der Prüfsumme dessen, was
# bikosoc zuletzt selbst ausgespielt hat. Weicht der aktive Hook davon ab, war
# ein anderer am Werk — dann wird NICHT überschrieben, sondern abgebrochen.
#
# Bewusst keine stille Lösung und kein `--force` als Normalfall: Der Mensch
# soll den fremden Stand ansehen und übernehmen, bevor er ausspielt. Das ist
# genau der Weg, der heute zum richtigen Ergebnis geführt hat.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_HOOKS="$(cd "$SCRIPT_DIR/.." && pwd)/hooks"
LIVE_HOOKS="$HOME/.claude/hooks"
STRANG="bikosoc"

# Nur für den Tag gedacht, an dem der fremde Stand nachweislich verworfen
# werden SOLL. Unbequem benannt, damit er nicht aus Gewohnheit mitläuft.
VERWERFEN=false
for arg in "$@"; do
  case "$arg" in
    --fremden-stand-verwerfen) VERWERFEN=true ;;
    *) echo "Unbekanntes Argument: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -d "$REPO_HOOKS" ]; then
  echo "ERROR: hooks/ not found at $REPO_HOOKS" >&2
  exit 1
fi

mkdir -p "$LIVE_HOOKS"

pruefsumme() { sha256sum "$1" | cut -d' ' -f1; }
marke_von()  { echo "$LIVE_HOOKS/.$(basename "$1").$STRANG-stand"; }

# ── Durchgang 1: prüfen, nichts anfassen ───────────────────────────────────
#
# Erst alles bewerten, dann handeln. Bräche das Skript mitten im Kopieren ab,
# bliebe ein halb ausgespielter Zustand zurück — bei einem Schutzmechanismus
# die schlechteste aller Lagen.
FREMD=""
for hook in "$REPO_HOOKS"/*.sh; do
  [ -f "$hook" ] || continue
  name="$(basename "$hook")"
  dest="$LIVE_HOOKS/$name"
  marke="$(marke_von "$name")"

  [ -f "$dest" ] || continue                      # neu — nichts zu schützen

  live="$(pruefsumme "$dest")"

  if [ -f "$marke" ]; then
    stand="$(cat "$marke")"
    [ "$live" = "$stand" ] && continue            # unser eigener Stand
  else
    # Keine Marke: Das ist der erste Lauf nach dieser Änderung. Stimmt der
    # aktive Hook mit dem Repo überein, ist nichts strittig — die Marke wird
    # unten angelegt. Weicht er ab, wissen wir NICHT, wer ihn geschrieben hat,
    # und raten ist hier die falsche Betriebsart.
    cmp -s "$hook" "$dest" && continue
  fi

  FREMD="$FREMD$name"$'\n'
done

if [ -n "$FREMD" ] && ! $VERWERFEN; then
  {
    echo "ABBRUCH: Der aktive Hook wurde seit dem letzten Ausspielen aus $STRANG geändert."
    echo
    for name in $FREMD; do
      dest="$LIVE_HOOKS/$name"
      marke="$(marke_von "$name")"
      echo "  $name"
      echo "    aktiv:        $(pruefsumme "$dest")"
      if [ -f "$marke" ]; then
        echo "    von $STRANG:  $(cat "$marke")"
      else
        echo "    von $STRANG:  keine Marke — Stand unbekannt"
      fi
      echo "    im Repo:      $(pruefsumme "$REPO_HOOKS/$name")"
    done
    echo
    echo "~/.claude/hooks/ ist für alle Straenge dieselbe Stelle. Ein anderer Strang"
    echo "(sehr wahrscheinlich HDCC) hat den Hook erweitert. Wuerde jetzt ausgespielt,"
    echo "waere dessen Arbeit weg."
    echo
    echo "Der Weg: ERST uebernehmen, DANN ausspielen."
    echo "  1. Unterschied ansehen:"
    echo "       diff $LIVE_HOOKS/<hook> $REPO_HOOKS/<hook>"
    echo "  2. Wenn die fremde Aenderung bleiben soll, sie ins Repo holen:"
    echo "       cp $LIVE_HOOKS/<hook> $REPO_HOOKS/<hook>"
    echo "     pruefen, committen — und erst danach dieses Skript erneut starten."
    echo
    echo "Soll der fremde Stand wirklich verworfen werden, und ist das geprueft:"
    echo "  bash scripts/install-hooks.sh --fremden-stand-verwerfen"
  } >&2
  exit 4
fi

# ── Durchgang 2: ausspielen ────────────────────────────────────────────────
any_change=false

for hook in "$REPO_HOOKS"/*.sh; do
  [ -f "$hook" ] || continue
  name="$(basename "$hook")"
  dest="$LIVE_HOOKS/$name"
  marke="$(marke_von "$name")"

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

  # Marke IMMER nachziehen — auch bei „unchanged". Sonst fehlte sie nach dem
  # ersten Lauf weiterhin, und die Sperre bliebe eine Absichtserklaerung.
  ( umask 077; pruefsumme "$dest" > "$marke" )
done

echo ""
if $any_change; then
  echo "Done. Geänderte Hooks sind aktiv (PreToolUse wiring ohne Neustart)."
else
  echo "Done. Alle Hooks aktuell — kein Update nötig."
fi
