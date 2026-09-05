#!/usr/bin/env bash
# PreToolUse deny hook — fail-closed.
# Blocks destructive Bash commands before they execute.
# Exit 2 = block tool call (stderr shown to model).
# Exit 0 + no output = allow (normal permission flow).
set -euo pipefail

# ── Strang-Notify-Plumbing (2026-09-05, "Notify entlärmen") ───────────────────
# ACHTUNG: Dieser Block ist absichtlich in deny-destructive.sh UND
# telegram-notify.sh identisch dupliziert. Ein gemeinsames lib-File wäre ein
# dritter Hook-Dateiname; der Drift-Check (scripts/smoke-test.ts Check #15) ist
# auf genau zwei Dateien fixiert, und Gate-Änderungen sind REVIEW-pflichtig (C8).
# Zusätzlich würde ein fehlendes lib-File hier unter `set -e` die Fail-Closed-
# Sperre aushebeln. Bei Änderung BEIDE Dateien anpassen, dann install-hooks.sh.
#
# Regeln:
#   - Blockade-Meldungen (fail-closed / not armed / unbekannter Strang) gehen
#     NIE nach Telegram — nur ins Log. cc sieht den Grund im Tool-Output.
#   - Nach Telegram geht nur: "Armed-Flag verbraucht durch <Aktion>",
#     an den operativen Chat des erkannten Strangs.
#   - Unbekannter Strang → niemals an eine Dev-Gruppe, nur Log.
#   - Identische Meldung innerhalb HOOK_DEDUPE_WINDOW → nur einmal gesendet.
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

# hook_dedupe <key> — 0 = senden, 1 = identische Meldung ist jünger als das Fenster.
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

# hook_send_hdcc <rolle> <text> — Telegram-Versand für den HDCC-Strang.
# Secrets werden ausschließlich in der aufrufenden Subshell gesourct (C5).
hook_send_hdcc() {
  local role="$1" text="$2" chat payload
  case "$role" in dev|operativ) ;; *) return 0 ;; esac
  # shellcheck disable=SC1090
  source "$HOME/.config/hdcc/env" 2>/dev/null || true
  [ -n "${HDCC_TELEGRAM_BOT_TOKEN:-}" ] || return 0
  [ -n "${HDCC_DATABASE_OWNER_URL:-}" ] || return 0
  chat=$(timeout 5 psql "$HDCC_DATABASE_OWNER_URL" -t -A -c \
    "SELECT telegram_chat_id FROM workspace_telegram_bindings WHERE status='active' AND role='${role}' LIMIT 1" \
    2>/dev/null || true)
  [ -n "$chat" ] || return 0
  payload=$(jq -nc --arg c "$chat" --arg t "$text" '{chat_id:$c,text:$t}' 2>/dev/null || true)
  [ -n "$payload" ] || return 0
  timeout 5 curl -s -X POST "https://api.telegram.org/bot${HDCC_TELEGRAM_BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" --data-raw "$payload" >/dev/null 2>&1 || true
}

# hook_notify <strang> <rolle> <text> — EINZIGER Telegram-Ausgang der Hooks.
# Unbekannter Strang oder Dublette → nur Log, kein Versand.
hook_notify() {
  local strand="$1" role="$2" text="$3"
  if [ "$strand" != "bikosoc" ] && [ "$strand" != "hdcc" ]; then
    hook_log NOTIFY "${strand:-unknown}" "kein Telegram (Strang unbekannt): $text"
    return 0
  fi
  if ! hook_dedupe "$strand|$role|$text"; then
    hook_log NOTIFY "$strand" "kein Telegram (Dublette < ${HOOK_DEDUPE_WINDOW}s): $text"
    return 0
  fi
  hook_log NOTIFY "$strand" "-> telegram/$role: $text"
  case "$strand" in
    bikosoc) ( timeout 5 "$HOME/.scripts/notify" "$text" info "$role" >/dev/null 2>&1 || true ) & ;;
    hdcc)    ( hook_send_hdcc "$role" "$text" ) & ;;
  esac
  return 0
}
# ── Ende Strang-Notify-Plumbing ───────────────────────────────────────────────

# Read stdin completely
INPUT=$(cat) || exit 2

# Extract the command field via jq
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""') || exit 2

# Empty command — nothing to check
[ -z "$COMMAND" ] && exit 0

# Normalize: remove backslash escapes, strip `command ` / `env ` prefixes
NORM="$COMMAND"
NORM=$(echo "$NORM" | sed 's/\\//g')
NORM=$(echo "$NORM" | sed 's/\bcommand  *//g')
NORM=$(echo "$NORM" | sed 's/\benv  *//g')
NORM=$(echo "$NORM" | sed 's/\bbuiltin  *//g')

# Case-insensitive version for SQL checks
NORM_LOWER=$(echo "$NORM" | tr '[:upper:]' '[:lower:]')

DENY_REASON=""

# --- Recursive delete ---
if echo "$NORM" | grep -qE 'rm\s+-(r|rf|fr)\b'; then
  DENY_REASON="recursive delete (rm -r/-rf)"
fi

# --- SQL destructive ---
if echo "$NORM_LOWER" | grep -qiE '\bdrop\s+table\b'; then
  DENY_REASON="SQL DROP TABLE"
elif echo "$NORM_LOWER" | grep -qiE '\bdrop\s+database\b'; then
  DENY_REASON="SQL DROP DATABASE"
elif echo "$NORM_LOWER" | grep -qiE '\btruncate\b'; then
  DENY_REASON="SQL TRUNCATE"
elif echo "$NORM_LOWER" | grep -qiE '\bdelete\s+from\b' && ! echo "$NORM_LOWER" | grep -qiE '\bwhere\b'; then
  DENY_REASON="SQL DELETE FROM without WHERE"
fi

# --- Git destructive ---
if echo "$NORM" | grep -qE 'push\s+(--force|-f)\b'; then
  DENY_REASON="git push --force"
elif echo "$NORM" | grep -qE 'push\s+.*-f\b'; then
  DENY_REASON="git push -f"
elif echo "$NORM" | grep -qE 'reset\s+--hard\b'; then
  DENY_REASON="git reset --hard"
elif echo "$NORM" | grep -qE 'clean\s+-f\b'; then
  DENY_REASON="git clean -f"
elif echo "$NORM" | grep -qE '\bgit\s+checkout\s+\.\s*$'; then
  DENY_REASON="git checkout ."
elif echo "$NORM" | grep -qE '\bgit\s+restore\s+\.\s*$'; then
  DENY_REASON="git restore ."
fi

# --- System rights on protected paths ---
if echo "$NORM" | grep -qE '(chmod|chown)\s+.*(/etc|/usr|/var|/sys|/boot)'; then
  DENY_REASON="chmod/chown on system path"
fi

# --- Remote exec (pipe to shell) ---
if echo "$NORM" | grep -qE 'curl.*\|.*\b(sh|bash)\b'; then
  DENY_REASON="remote exec via curl|sh"
elif echo "$NORM" | grep -qE 'wget.*\|.*\b(sh|bash)\b'; then
  DENY_REASON="remote exec via wget|sh"
fi

# --- Miscellaneous destructive ---
if echo "$NORM" | grep -qE '\bmkfs\b'; then
  DENY_REASON="mkfs"
elif echo "$NORM" | grep -qE '\bdd\s+if='; then
  DENY_REASON="dd if="
elif echo "$NORM" | grep -qF ':(){ :|:& };:'; then
  DENY_REASON="fork bomb"
fi

# --- Red Zone Guard (2026-07-15, Strang-Fix 2026-07-20, Notify-Fix 2026-09-05) ---
# Blocks git push touching red paths and red direct commands,
# unless the owner has armed via /arm (one-shot flag).
# Armed flag is strand-specific:
#   ~/hdcc                → ~/.armed-hdcc
#   ~/.openclaw/workspace → ~/.armed-bikosoc
# Fail-closed (Repo-Pfad/Diff nicht auflösbar) blockiert IMMER — auch mit Flag,
# weil dann gar nicht feststeht, welcher Diff gepusht würde.
RED_ZONE_CONF="$HOME/.config/openclaw/red-zone.conf"

if [ -z "$DENY_REASON" ] && [ -f "$RED_ZONE_CONF" ]; then
  RED_ZONE_HIT=""
  RED_ZONE_REPO=""           # git --show-toplevel des betroffenen Repos
  RED_ZONE_FAILCLOSED=false  # true = Push-Ziel unbestimmbar → Block ohne Flag-Option
  REPO_PATH=""

  # (A) git push — FAIL-CLOSED: nur durchlassen wenn Diff-Status SICHER gruen ist.
  # Kein REPO_PATH / Diff-Fehler / Variable im Pfad → BLOCK (nicht allow).
  if echo "$NORM" | grep -qE '\bgit\b.*\bpush\b'; then
    # Shell-Suffixe entfernen (2>&1, || true, && ..., ; ...) vor dem Parsen
    NORM_PUSH=$(printf '%s' "$NORM" \
      | sed 's/[[:space:]]*2>[>&]*[0-9]*//g' \
      | sed 's/[[:space:]]*||.*//' \
      | sed 's/[[:space:]]*&&.*//' \
      | sed 's/[[:space:]]*;.*//')

    # Nur absolute Pfade akzeptieren — $VAR / "$VAR" werden abgelehnt
    if echo "$NORM_PUSH" | grep -qE '\bgit\s+-C\s+/'; then
      REPO_PATH=$(echo "$NORM_PUSH" | sed -n 's/.*\bgit\s\+-C\s\+\(\/[^ ]*\).*/\1/p')
    elif echo "$NORM_PUSH" | grep -qE '^\s*cd\s+[~/]'; then
      REPO_PATH=$(echo "$NORM_PUSH" | sed -n 's/^\s*cd\s\+\([^; &]*\).*/\1/p')
    fi

    # Expand tilde to $HOME
    if [[ "$REPO_PATH" == "~"* ]]; then
      REPO_PATH="${HOME}${REPO_PATH#\~}"
    fi

    if [ -z "$REPO_PATH" ]; then
      # Kein aufloesbarer Repo-Pfad → fail-closed
      RED_ZONE_HIT="git push: Repo-Pfad nicht auflösbar"
      RED_ZONE_FAILCLOSED=true
    elif ! CHANGED_FILES=$(git -C "$REPO_PATH" diff --name-only '@{u}..HEAD' 2>/dev/null); then
      # git diff fehlgeschlagen (kein Upstream, kein gültiges Repo, etc.) → fail-closed
      RED_ZONE_HIT="git push: diff-Prüfung fehlgeschlagen ($REPO_PATH)"
      RED_ZONE_FAILCLOSED=true
    elif [ -n "$CHANGED_FILES" ]; then
      # Diff erfolgreich und Dateien vorhanden — gegen rote Pfade prüfen
      IN_PATHS=false
      while IFS= read -r cfgline; do
        cfgline=$(echo "$cfgline" | sed 's/#.*//' | xargs)
        [ -z "$cfgline" ] && continue
        [ "$cfgline" = "[red-paths]" ] && IN_PATHS=true && continue
        [[ "$cfgline" == \[* ]] && IN_PATHS=false && continue
        if $IN_PATHS; then
          while IFS= read -r f; do
            [ -z "$f" ] && continue
            # shellcheck disable=SC2254
            if [[ "$f" == $cfgline ]]; then
              RED_ZONE_HIT="red path: $f matches $cfgline"
              break 2
            fi
          done <<< "$CHANGED_FILES"
        fi
      done < "$RED_ZONE_CONF"
      # Strang-Repo nur bei echtem red-path Treffer setzen (nicht bei fail-closed)
      if [ -n "$RED_ZONE_HIT" ]; then
        RED_ZONE_REPO=$(git -C "$REPO_PATH" rev-parse --show-toplevel 2>/dev/null || true)
      fi
    fi
    # else: leeres Diff (nichts zu pushen) → kein RED_ZONE_HIT → allow
  fi

  # (B) Red direct commands — match normalized command against regex patterns
  if [ -z "$RED_ZONE_HIT" ]; then
    IN_CMDS=false
    while IFS= read -r cfgline; do
      cfgline=$(echo "$cfgline" | sed 's/#.*//' | xargs)
      [ -z "$cfgline" ] && continue
      [ "$cfgline" = "[red-commands]" ] && IN_CMDS=true && continue
      [[ "$cfgline" == \[* ]] && IN_CMDS=false && continue
      if $IN_CMDS; then
        if echo "$NORM" | grep -qE "$cfgline"; then
          RED_ZONE_HIT="red command: $cfgline"
          break
        fi
      fi
    done < "$RED_ZONE_CONF"
    # Strang-Repo via JSON-CWD ermitteln (falls Red-Command-Treffer)
    if [ -n "$RED_ZONE_HIT" ]; then
      _CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || true)
      if [ -n "$_CWD" ]; then
        RED_ZONE_REPO=$(git -C "$_CWD" rev-parse --show-toplevel 2>/dev/null || true)
      fi
    fi
  fi

  # Strang-Erkennung + Entscheidung.
  # Der Strang dient dem Log und der Kanalwahl; er wird — anders als vorher —
  # auch dann bestimmt, wenn das Push-Ziel unbestimmbar ist (dann aus cwd).
  # Ein Armed-Flag wird nur bei einem ECHTEN Rote-Zone-Treffer akzeptiert.
  if [ -n "$RED_ZONE_HIT" ]; then
    _CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || true)
    STRAND=$(hook_strand "$RED_ZONE_REPO" "$REPO_PATH" "$_CWD" "$PWD")

    if $RED_ZONE_FAILCLOSED; then
      # Push-Ziel unbestimmbar → blockieren, nur loggen, kein Telegram.
      hook_log BLOCK "$STRAND" "fail-closed: $RED_ZONE_HIT (cwd=${_CWD:-?})"
      DENY_REASON="Red Zone: $RED_ZONE_HIT — fail-closed; Push mit absolutem Pfad wiederholen (git -C /abs/pfad push)"
    else
      STRAND_FLAG=""
      case "$STRAND" in
        hdcc)    STRAND_FLAG="$HOME/.armed-hdcc" ;;
        bikosoc) STRAND_FLAG="$HOME/.armed-bikosoc" ;;
      esac

      if [ -z "$STRAND_FLAG" ]; then
        # Unbekannter Strang → blockieren, nur loggen, KEINE Dev-Gruppe.
        hook_log BLOCK unknown "Strang unbestimmbar (repo=${RED_ZONE_REPO:-?} cwd=${_CWD:-?}): $RED_ZONE_HIT"
        DENY_REASON="Red Zone: $RED_ZONE_HIT (unbekannter Strang — fail-closed)"
      elif [ -f "$STRAND_FLAG" ]; then
        rm -f "$STRAND_FLAG"
        hook_log ARMED "$STRAND" "Armed-Flag verbraucht ($STRAND_FLAG) durch: $RED_ZONE_HIT"
        hook_notify "$STRAND" operativ "[$STRAND] Armed-Flag verbraucht durch: $RED_ZONE_HIT"
      else
        # Nicht armed → blockieren, nur loggen, kein Telegram.
        hook_log BLOCK "$STRAND" "not armed ($STRAND_FLAG fehlt): $RED_ZONE_HIT"
        DENY_REASON="Red Zone: $RED_ZONE_HIT (not armed — use /arm)"
      fi
    fi
  fi
fi

# --- Decision ---
if [ -n "$DENY_REASON" ]; then
  echo "Blocked by deny-destructive hook: ${DENY_REASON}" >&2
  exit 2
fi

# No match — allow normal permission flow
exit 0
