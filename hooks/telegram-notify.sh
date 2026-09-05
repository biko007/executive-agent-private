#!/usr/bin/env bash
# Claude Code Notification hook — Warte-Ereignisse (permission_prompt/idle_prompt).
#
# Seit 2026-09-05 ("Notify entlärmen") schreibt dieser Hook NUR ins Log und
# sendet NICHTS mehr nach Telegram:
#   - Der Warte-Kanal des Owners ist der Wait-Notifier im Executive Agent
#     (index.ts, 30s-Poll auf tmux bikosoc + HDCC:claude, max 1 Meldung/5min,
#     Rolle dev mit Operativ-Fallback). Dieser Hook war dazu eine Dublette.
#   - Einziger Telegram-Ausgang der Hook-Ebene ist jetzt deny-destructive.sh
#     mit "Armed-Flag verbraucht durch <Aktion>" an den operativen Chat.
# Rückbau (falls der Owner die Hook-Meldung zurück will): hook_notify aus
# deny-destructive.sh hierher übernehmen und am Ende
#   hook_notify "$STRAND" dev "[$STRAND] $TEXT"
# aufrufen — unbekannter Strang bleibt dann trotzdem Log-only.
#
# Non-fatal: exits 0 on any failure (hook must not block cc).
set -euo pipefail

# ── Strang-Notify-Plumbing (2026-09-05, "Notify entlärmen") ───────────────────
# ACHTUNG: Dieser Block ist der gemeinsame Unterbau der Hooks und absichtlich
# byte-identisch mit dem gleichnamigen Block in deny-destructive.sh dupliziert
# (dort zusätzlich hook_notify/hook_send_hdcc — der einzige Telegram-Ausgang).
# Grund für die Duplikation statt eines lib-Files: der Drift-Check
# scripts/smoke-test.ts Check #15 ist auf genau zwei Hook-Dateien fixiert, und
# Gate-Änderungen sind REVIEW-pflichtig (C8); außerdem würde ein fehlendes
# lib-File in deny-destructive.sh unter `set -e` die Fail-Closed-Sperre
# aushebeln. Bei Änderung BEIDE Dateien anpassen, dann install-hooks.sh.
HOOK_LOG="${HOOK_LOG:-$HOME/.claude/hooks.log}"
HOOK_DEDUPE_DIR="${HOOK_DEDUPE_DIR:-$HOME/.cache/claude-hooks}"
HOOK_DEDUPE_WINDOW="${HOOK_DEDUPE_WINDOW:-300}"
HOOK_STRAND_CONF="${HOOK_STRAND_CONF:-$HOME/.config/openclaw/strands.conf}"

# hook_log <LEVEL> <STRANG> <TEXT> — schreibt eine Zeile ins Hook-Log.
# Nie fatal: jeder Fehler wird geschluckt, der Hook darf daran nicht scheitern.
hook_log() {
  local dir size
  dir=$(dirname "$HOOK_LOG")
  mkdir -p "$dir" 2>/dev/null || true
  # Rotation bei > 1 MB, damit das Log nicht unbegrenzt wächst.
  if [ -f "$HOOK_LOG" ]; then
    size=$(stat -c %s "$HOOK_LOG" 2>/dev/null || echo 0)
    if [ "$size" -gt 1048576 ]; then mv -f "$HOOK_LOG" "$HOOK_LOG.1" 2>/dev/null || true; fi
  fi
  printf '%s [%s] [%s] %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" >> "$HOOK_LOG" 2>/dev/null || true
}

# hook_strand_conf <pfad> — optionale Owner-Karte ~/.config/openclaw/strands.conf.
# Format je Zeile: <glob-pfadmuster> = <strang>   (# = Kommentar)
# Beispiel:        /home/biko = bikosoc
hook_strand_conf() {
  local path="$1" line pattern value
  [ -r "$HOOK_STRAND_CONF" ] || return 0
  while IFS= read -r line; do
    line="${line%%#*}"
    case "$line" in *=*) ;; *) continue ;; esac
    pattern=$(printf '%s' "${line%%=*}" | xargs 2>/dev/null || true)
    value=$(printf '%s' "${line#*=}" | xargs 2>/dev/null || true)
    if [ -z "$pattern" ] || [ -z "$value" ]; then continue; fi
    # shellcheck disable=SC2254  # Muster soll bewusst globben
    case "$path" in
      $pattern|$pattern/*) printf '%s' "$value"; return 0 ;;
    esac
  done < "$HOOK_STRAND_CONF"
  return 0
}

# hook_strand <pfad> [<pfad> …] — erster auflösbarer Pfad gewinnt.
# Gibt "bikosoc", "hdcc" oder "unknown" aus. Ein Unterverzeichnis eines Repos
# wird vorher auf den Repo-Root gehoben, damit auch tiefe cwd-Werte greifen.
hook_strand() {
  local raw p top mapped
  for raw in "$@"; do
    [ -n "$raw" ] || continue
    p="$raw"
    case "$p" in "~"*) p="${HOME}${p#\~}" ;; esac
    top=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null || true)
    if [ -n "$top" ]; then p="$top"; fi
    p=$(realpath -m "$p" 2>/dev/null || printf '%s' "$raw")
    mapped=$(hook_strand_conf "$p")
    if [ -n "$mapped" ]; then printf '%s' "$mapped"; return 0; fi
    case "$p" in
      "$HOME/hdcc"|"$HOME/hdcc"/*)                 printf 'hdcc';    return 0 ;;
      */executive-agent|*/executive-agent/*)       printf 'bikosoc'; return 0 ;;
      */openclaw/workspace|*/openclaw/workspace/*) printf 'bikosoc'; return 0 ;;
      # Der Live-Pfad ist ~/.openclaw/workspace — der Punkt verhindert, dass das
      # Muster oben greift (dort muesste ein / direkt vor "openclaw" stehen).
      */.openclaw/workspace|*/.openclaw/workspace/*) printf 'bikosoc'; return 0 ;;
    esac
  done
  printf 'unknown'
}

# hook_dedupe <key> — 0 = melden, 1 = identische Meldung ist jünger als das Fenster.
hook_dedupe() {
  local sum marker now last
  sum=$(printf '%s' "$1" | sha256sum 2>/dev/null | cut -d' ' -f1 || true)
  [ -n "$sum" ] || return 0
  mkdir -p "$HOOK_DEDUPE_DIR" 2>/dev/null || return 0
  marker="$HOOK_DEDUPE_DIR/$sum"
  now=$(date +%s)
  if [ -f "$marker" ]; then
    last=$(cat "$marker" 2>/dev/null || echo 0)
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    if [ "$(( now - last ))" -lt "$HOOK_DEDUPE_WINDOW" ]; then return 1; fi
  fi
  printf '%s' "$now" > "$marker" 2>/dev/null || true
  find "$HOOK_DEDUPE_DIR" -type f -mmin +60 -delete 2>/dev/null || true
  return 0
}
# ── Ende Strang-Notify-Plumbing ───────────────────────────────────────────────

INPUT=$(cat) || exit 0
NOTIF_TYPE=$(printf '%s' "$INPUT" | jq -r '.notification_type // ""' 2>/dev/null) || exit 0

case "$NOTIF_TYPE" in
  permission_prompt) TEXT="cc wartet auf BERECHTIGUNG" ;;
  idle_prompt)       TEXT="cc wartet auf Eingabe" ;;
  *)                 exit 0 ;;
esac

# Strang aus dem Hook-Payload ableiten; $PWD als letzter Rückfall.
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || true)
STRAND=$(hook_strand "$CWD" "$PWD")

# Dedupe: identisches Warte-Ereignis innerhalb des Fensters nur einmal loggen.
if hook_dedupe "wait|$STRAND|$TEXT"; then
  hook_log WAIT "$STRAND" "$TEXT (cwd=${CWD:-?})"
fi

exit 0
