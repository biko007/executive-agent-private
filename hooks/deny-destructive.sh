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
RED_ZONE_BEFEHL=""

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
  RED_ZONE_IST_PUSH=false    # true = Treffer stammt aus der Pruefung in (A)
  REPO_PATH=""               # erster genannter Repo-Pfad (Meldung, Strang)
  REPO_PATHS=""              # alle genannten Repo-Pfade, einer je Zeile

  # (A) git push — FAIL-CLOSED: nur durchlassen wenn Diff-Status SICHER gruen ist.
  # Kein REPO_PATH / Diff-Fehler / Variable im Pfad → BLOCK (nicht allow).
  # Das Unterkommando muss von Leerraum umgeben sein. Mit \b allein galt
  # auch `git add scripts/hooks/pre-push` als Uebertragung, weil der
  # Bindestrich eine Wortgrenze setzt (13.10.2026).
  if echo "$NORM" | grep -qE '\bgit\b.*(^|[[:space:]])push([[:space:]]|$)'; then
    RED_ZONE_IST_PUSH=true
    # Shell-Suffixe entfernen (2>&1, || true, && ..., ; ...) vor dem Parsen
    NORM_PUSH=$(printf '%s' "$NORM" \
      | sed 's/[[:space:]]*2>[>&]*[0-9]*//g' \
      | sed 's/[[:space:]]*||.*//' \
      | sed 's/[[:space:]]*&&.*//' \
      | sed 's/[[:space:]]*;.*//')

    # Nur absolute Pfade akzeptieren — $VAR / "$VAR" werden abgelehnt.
    # ALLE Vorkommen werden gesammelt. Nennt ein Befehl zwei Repos — etwa weil
    # er mehrzeilig ist und in jeder Zeile ein `git -C /pfad` steht —, nahm die
    # frühere Fassung jede passende Zeile und die Kommandosubstitution
    # verkettete sie zu einem Pfad, den es nicht gibt. Der Hook blockierte dann
    # fail-closed mit "diff-Prüfung fehlgeschlagen (/a\n/b)" und prüfte keines
    # der beiden Repos. Festgestellt am 13.10.2026, erneut am 14.10.2026
    # 10:17 Uhr. Jetzt wird jeder genannte Pfad einzeln geprüft.
    if echo "$NORM_PUSH" | grep -qE '\bgit\s+-C\s+/'; then
      REPO_PATHS=$(printf '%s\n' "$NORM_PUSH" \
        | grep -oE '\bgit[[:space:]]+-C[[:space:]]+/[^[:space:]]+' \
        | sed -E 's/^.*[[:space:]]//' \
        | awk '!gesehen[$0]++' || true)
      REPO_PATH=$(printf '%s\n' "$REPO_PATHS" | head -n1)
    elif echo "$NORM_PUSH" | grep -qE '^\s*cd\s+[~/]'; then
      REPO_PATH=$(echo "$NORM_PUSH" | sed -n 's/^\s*cd\s\+\([^; &]*\).*/\1/p' | head -n1)
    fi

    # Expand tilde to $HOME
    if [[ "$REPO_PATH" == "~"* ]]; then
      REPO_PATH="${HOME}${REPO_PATH#\~}"
    fi

    # Der cd-Zweig nennt genau einen Pfad; die Tilde-Erweiterung oben betrifft
    # nur ihn. Beim git -C-Zweig steht die Liste bereits.
    if [ -z "$REPO_PATHS" ] && [ -n "$REPO_PATH" ]; then
      REPO_PATHS="$REPO_PATH"
    fi

    if [ -z "$REPO_PATH" ]; then
      # Kein aufloesbarer Repo-Pfad → fail-closed
      RED_ZONE_HIT="git push: Repo-Pfad nicht auflösbar"
      RED_ZONE_FAILCLOSED=true
    else
      # Jeder genannte Pfad wird für sich geprüft: ein fehlgeschlagener Diff
      # ist fail-closed, ein roter Treffer in einem der Repos blockiert.
      while IFS= read -r REPO_EINS; do
        [ -z "$REPO_EINS" ] && continue
        if ! CHANGED_FILES=$(git -C "$REPO_EINS" diff --name-only '@{u}..HEAD' 2>/dev/null); then
          # git diff fehlgeschlagen (kein Upstream, kein gültiges Repo, etc.) → fail-closed
          RED_ZONE_HIT="git push: diff-Prüfung fehlgeschlagen ($REPO_EINS)"
          RED_ZONE_FAILCLOSED=true
          break
        fi
        # leeres Diff (nichts zu pushen) → kein RED_ZONE_HIT → weiter
        [ -z "$CHANGED_FILES" ] && continue
        # Diff erfolgreich und Dateien vorhanden — gegen rote Pfade prüfen
        IN_PATHS=false
        while IFS= read -r cfgline; do
          # Nur Leerraum abschneiden. Frueher stand hier `xargs` — das entfernt
          # auch Backslashes, und damit wurde aus einem Muster mit \s still eines
          # ohne: Es traf nie wieder. Zwei der sechs roten Befehle waren dadurch
          # seit jeher wirkungslos (festgestellt 16.10.2026 durch den
          # Verankerungstest).
          cfgline=$(echo "$cfgline" | sed -E 's/#.*//; s/^[[:space:]]+//; s/[[:space:]]+$//')
          [ -z "$cfgline" ] && continue
          [ "$cfgline" = "[red-paths]" ] && IN_PATHS=true && continue
          [[ "$cfgline" == \[* ]] && IN_PATHS=false && continue
          if $IN_PATHS; then
            while IFS= read -r f; do
              [ -z "$f" ] && continue
              # shellcheck disable=SC2254
              if [[ "$f" == $cfgline ]]; then
                RED_ZONE_HIT="red path: $f matches $cfgline"
                # Strang-Repo nur bei echtem red-path Treffer setzen
                RED_ZONE_REPO=$(git -C "$REPO_EINS" rev-parse --show-toplevel 2>/dev/null || true)
                break 3
              fi
            done <<< "$CHANGED_FILES"
          fi
        done < "$RED_ZONE_CONF"
      done <<< "$REPO_PATHS"
    fi
  fi

# ── Befehlsposition: wo ein rotes Muster ueberhaupt greifen darf ───────────
#
# Reihenfolge: Trennzeichen, Leerraum, beliebig viele Vorsaetze, optional ein
# Pfad. Erst dann darf das Muster aus red-zone.conf beginnen.
ANKER_TRENNER='(^|[;&|(]|\$\()[[:space:]]*'
ANKER_VORSATZ='(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|sudo|env|nohup|time|timeout[[:space:]]+[0-9]+[smhd]?|xargs|npx|bunx|bun[[:space:]]+run|bun|node|tsx|ts-node|deno[[:space:]]+run|bash[[:space:]]+-c|sh[[:space:]]+-c)[[:space:]]+["'"'"']?)*'
ANKER_PFAD='([^[:space:];&|"'"'"']*/)?'
ANKER="${ANKER_TRENNER}${ANKER_VORSATZ}${ANKER_PFAD}"

# Der ausloesende Befehl fuer die Quittung: eine Zeile, gekuerzt, ohne
# offensichtliche Geheimnisse. Er geht an den Owner-Chat, deshalb die Filter.
befehl_kurz() {
  printf '%s' "$1" \
    | tr '\n' ' ' \
    | sed -E 's/(password|passwd|token|secret|key|pin|tan)=[^[:space:]]*/\1=***/gI' \
    | sed -E 's/(-p|--password)[[:space:]]+[^[:space:]]+/\1 ***/gI' \
    | sed -E 's/[[:space:]]+/ /g' \
    | cut -c1-160
}

  # (B) Red direct commands — match normalized command against regex patterns
  if [ -z "$RED_ZONE_HIT" ]; then
    IN_CMDS=false
    while IFS= read -r cfgline; do
      cfgline=$(echo "$cfgline" | sed -E 's/#.*//; s/^[[:space:]]+//; s/[[:space:]]+$//')
      [ -z "$cfgline" ] && continue
      [ "$cfgline" = "[red-commands]" ] && IN_CMDS=true && continue
      [[ "$cfgline" == \[* ]] && IN_CMDS=false && continue
      if $IN_CMDS; then
        # -i seit 2026-10-10: die Muster in red-zone.conf duerfen kein
        # (?i)-Prefix tragen (POSIX-ERE kennt das nicht und das Muster waere
        # unwirksam). Gross-/Kleinschreibung wird deshalb hier erledigt.
        #
        # VERANKERUNG seit 2026-10-16 (Owner-Entscheidung, Variante a). Bis
        # dahin verglich der Hook das Muster gegen den gesamten Befehlstext.
        # Damit verbrauchte schon eine ERWAEHNUNG die Freigabe: Ein `grep`,
        # das in einer Datei nach einem Schalter suchte, und ein Report, der
        # ein Muster in einer Tabelle zitierte, haben am 16.10.2026 je eine
        # Owner-Freigabe vernichtet, ohne irgendetwas auszufuehren.
        #
        # Jetzt muss der Treffer an einer BEFEHLSPOSITION liegen: am Anfang
        # einer Zeile, nach ; & | ( oder $( — und nach den ueblichen
        # Vorsaetzen (sudo, env, timeout, nohup, npx, bunx, bun run, node,
        # tsx, bash -c, sh -c, VAR=wert). Ein Pfad davor ist erlaubt, sonst
        # fiele `bun run scripts/migrate-x.ts --apply` durch.
        #
        # Ein Muster, das BEWUSST ueberall greifen soll, beginnt in der
        # Konfiguration mit einer Tilde — etwa die Loeschbefehle gegen die
        # Produktiv-Datenbank, die in jeder Verpackung rot bleiben sollen.
        if [ "${cfgline:0:1}" = "~" ]; then
          EFFEKTIV="${cfgline:1}"
        else
          EFFEKTIV="${ANKER}${cfgline}"
        fi
        if echo "$NORM" | grep -qiE "$EFFEKTIV"; then
          RED_ZONE_HIT="red command: $cfgline"
          # Bug 3 (Owner, 16.10.2026): Die Quittung nannte bisher nur eine
          # allgemeine Beschreibung — und behauptete eine Migration, wo gar
          # nichts migriert wurde. Jetzt wird der tatsaechlich ausloesende
          # Befehl mitgefuehrt, gekuerzt und ohne Geheimnisse.
          RED_ZONE_BEFEHL=$(befehl_kurz "$NORM")
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
        # Eine Freigabe gilt fuer den Vorgang, der unmittelbar folgt — nicht
        # unbegrenzt. Ohne Verfall autorisiert ein liegengebliebenes Flag Tage
        # spaeter eine voellig andere Aktion. Genau das ist am 13.10.2026
        # passiert: Freigabe vom 11.10. 07:32 Uhr, verbraucht am 13.10. 12:37
        # Uhr durch einen Push, fuer den sie nie gedacht war.
        ARM_TTL="${ARM_TTL:-900}"
        FLAG_ALTER=$(( $(date +%s) - $(stat -c %Y "$STRAND_FLAG" 2>/dev/null || echo 0) ))
        if [ "$FLAG_ALTER" -gt "$ARM_TTL" ]; then
          # Eine abgelaufene Freigabe wird verworfen, nicht aufgeschoben: Sie
          # darf auch beim naechsten Versuch nicht mehr greifen.
          rm -f "$STRAND_FLAG"
          hook_log BLOCK "$STRAND" \
            "Freigabe abgelaufen (${FLAG_ALTER}s > ${ARM_TTL}s), verworfen: $RED_ZONE_HIT"
          DENY_REASON="Red Zone: $RED_ZONE_HIT (Freigabe abgelaufen — war ${FLAG_ALTER}s alt, Grenze ${ARM_TTL}s; /arm erneut geben)"
        elif $RED_ZONE_IST_PUSH; then
          # Hier bleibt das Flag liegen. Verbraucht wird es vom git-Hook
          # scripts/hooks/pre-push, der erst laeuft, wenn der Vorgang
          # tatsaechlich stattfindet. Verschwaende es schon hier, pruefte der
          # pre-push-Hook gegen ein fehlendes Flag und blockierte genau das,
          # was dieser Hook gerade durchgelassen hat.
          hook_log ARMED "$STRAND" \
            "Freigabe gueltig (Alter ${FLAG_ALTER}s), Verbrauch ueberlassen an pre-push: $RED_ZONE_HIT"
        else
          rm -f "$STRAND_FLAG"
          hook_log ARMED "$STRAND" \
            "Armed-Flag verbraucht ($STRAND_FLAG, Alter ${FLAG_ALTER}s) durch: $RED_ZONE_HIT${RED_ZONE_BEFEHL:+ | Befehl: $RED_ZONE_BEFEHL}"
          # Klartext statt Rohbefund (14.10.2026). Das Gateway setzt Symbol und
          # Fettschrift und uebersetzt den Grund; faellt es aus, greift der
          # alte Textweg ueber hook_notify.
          if [ -x "$HOME/bin/notify-system" ]; then
            ( timeout 8 "$HOME/bin/notify-system" ok "Freigabe genutzt" \
                --grund "$RED_ZONE_HIT" \
                --zeile "genutzt nach ${FLAG_ALTER} s" \
                ${RED_ZONE_BEFEHL:+--zeile "Befehl: $RED_ZONE_BEFEHL"} >/dev/null 2>&1 || true ) &
            hook_log NOTIFY "$STRAND" "-> telegram/operativ (gestaltet): Freigabe genutzt"
          else
            hook_notify "$STRAND" operativ \
              "Freigabe genutzt nach ${FLAG_ALTER} s"
          fi
        fi
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
