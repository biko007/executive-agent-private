#!/usr/bin/env bash
# PreToolUse deny hook — fail-closed.
# Blocks destructive Bash commands before they execute.
# Exit 2 = block tool call (stderr shown to model).
# Exit 0 + no output = allow (normal permission flow).
set -euo pipefail

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

# --- Red Zone Guard (2026-07-15, Strang-Fix 2026-07-20) ---
# Blocks git push touching red paths and red direct commands,
# unless the owner has armed via /arm (one-shot flag).
# Armed flag is strand-specific:
#   ~/hdcc                → ~/.armed-hdcc
#   ~/.openclaw/workspace → ~/.armed-bikosoc
#   unknown repo          → fail-closed, no flag accepted
RED_ZONE_CONF="$HOME/.config/openclaw/red-zone.conf"

if [ -z "$DENY_REASON" ] && [ -f "$RED_ZONE_CONF" ]; then
  RED_ZONE_HIT=""
  RED_ZONE_REPO=""   # git --show-toplevel des betroffenen Repos; leer = unbekannt → fail-closed

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
    REPO_PATH=""
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
      RED_ZONE_HIT="git push: Repo-Pfad nicht auflösbar — fail-closed"
    elif ! CHANGED_FILES=$(git -C "$REPO_PATH" diff --name-only '@{u}..HEAD' 2>/dev/null); then
      # git diff fehlgeschlagen (kein Upstream, kein gültiges Repo, etc.) → fail-closed
      RED_ZONE_HIT="git push: diff-Prüfung fehlgeschlagen ($REPO_PATH) — fail-closed"
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

  # Strang-Erkennung → passendes Armed-Flag wählen
  # Unbekannter Strang (leeres RED_ZONE_REPO oder kein Match) → fail-closed, kein Flag akzeptiert.
  if [ -n "$RED_ZONE_HIT" ]; then
    STRAND_FLAG=""
    STRAND_BLOCKED=false
    if [ -z "$RED_ZONE_REPO" ]; then
      STRAND_BLOCKED=true
    else
      _HDCC_TOP=$(realpath -m "$HOME/hdcc" 2>/dev/null || echo "$HOME/hdcc")
      _EA_TOP=$(realpath -m "$HOME/.openclaw/workspace" 2>/dev/null || echo "$HOME/.openclaw/workspace")
      if [ "$RED_ZONE_REPO" = "$_HDCC_TOP" ] || [[ "$RED_ZONE_REPO" == "${_HDCC_TOP}/"* ]]; then
        STRAND_FLAG="$HOME/.armed-hdcc"
      elif [ "$RED_ZONE_REPO" = "$_EA_TOP" ] || [[ "$RED_ZONE_REPO" == "${_EA_TOP}/"* ]]; then
        STRAND_FLAG="$HOME/.armed-bikosoc"
      else
        STRAND_BLOCKED=true
      fi
    fi

    if $STRAND_BLOCKED; then
      ( timeout 5 "$HOME/hdcc/scripts/cc-notify.sh" ROTE_ZONE "[HOOK] Rote Zone: unbekannter Strang — fail-closed: $RED_ZONE_HIT" 2>/dev/null || true ) &
      DENY_REASON="Red Zone: $RED_ZONE_HIT (unbekannter Strang — fail-closed)"
    elif [ -f "$STRAND_FLAG" ]; then
      rm -f "$STRAND_FLAG"
      ( timeout 5 "$HOME/hdcc/scripts/cc-notify.sh" ROTE_ZONE "[HOOK] Rote Zone: Armed-Flag verbraucht ($STRAND_FLAG) durch: $RED_ZONE_HIT" 2>/dev/null || true ) &
    else
      ( timeout 5 "$HOME/hdcc/scripts/cc-notify.sh" ROTE_ZONE "[HOOK] Rote Zone BLOCKIERT ($STRAND_FLAG): $RED_ZONE_HIT — /arm noetig" 2>/dev/null || true ) &
      DENY_REASON="Red Zone: $RED_ZONE_HIT (not armed — use /arm)"
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
