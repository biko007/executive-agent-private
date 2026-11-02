#!/usr/bin/env bash
# cc-start.sh — Claude Code für den Fachstrang bikosoc starten (02.11.2026).
#
# ANLASS: Am 01.11.2026 lief die Anmeldung von Claude Code ab („Login
# expired"). Seit 02.11. gibt es ein langlebiges OAuth-Token in
# ~/.claude-oauth-token (chmod 600). Dieses Skript ist der eine Startweg, der
# das Token setzt — bisher wurde claude in tmux von Hand gestartet.
#
#   ~/bin/cc-start.sh            im aktuellen Terminal starten (exec claude)
#   ~/bin/cc-start.sh --tmux     tmux-Sitzung bikosoc, Fenster claude anlegen,
#                                falls nötig, und dort dieses Skript starten
#   ~/bin/cc-start.sh --status   nur anzeigen: Token-Datei, Rechte, Ablauf, Sitzung
#
# Das Token wird NIE ausgegeben, protokolliert oder auf die Befehlszeile gelegt
# (dort stünde es in `ps`). Es geht nur über die Umgebungsvariable
# CLAUDE_CODE_OAUTH_TOKEN an den claude-Prozess. `set -x` ist hier verboten.
#
# Ablaufdatum: ~/.claude-oauth-token.expires (ISO-Datum, eine Zeile). Der
# Smoke-Test (Prüfung „cc-Login") warnt 21 Tage vorher.

set -euo pipefail
set +x

TOKEN_DATEI="${HOME}/.claude-oauth-token"
ABLAUF_DATEI="${HOME}/.claude-oauth-token.expires"
ARBEITSVERZEICHNIS="${HOME}/.openclaw/workspace"
SESSION="bikosoc"
WINDOW="claude"

fehler() { echo "cc-start: $*" >&2; exit 1; }

pruefe_token_datei() {
  [[ -f "$TOKEN_DATEI" ]] || fehler "Token-Datei fehlt: $TOKEN_DATEI (claude setup-token)"
  [[ -s "$TOKEN_DATEI" ]] || fehler "Token-Datei ist leer: $TOKEN_DATEI"
  local rechte
  rechte="$(stat -c '%a' "$TOKEN_DATEI")"
  [[ "$rechte" == "600" ]] || fehler "Token-Datei hat Rechte $rechte statt 600 — chmod 600 $TOKEN_DATEI"
}

ablauf_hinweis() {
  if [[ ! -f "$ABLAUF_DATEI" ]]; then
    echo "cc-start: Hinweis — Ablaufdatum unbekannt ($ABLAUF_DATEI fehlt)"
    return
  fi
  local ablauf ablauf_s tage
  ablauf="$(head -1 "$ABLAUF_DATEI" | tr -d '[:space:]')"
  if ! ablauf_s="$(date -d "$ablauf" +%s 2>/dev/null)"; then
    echo "cc-start: Hinweis — Ablaufdatum nicht lesbar: $ablauf"
    return
  fi
  tage=$(( (ablauf_s - $(date +%s)) / 86400 ))
  if (( tage < 0 )); then
    echo "cc-start: WARNUNG — Token laut $ABLAUF_DATEI abgelaufen am $ablauf (claude setup-token)"
  elif (( tage < 21 )); then
    echo "cc-start: WARNUNG — Token läuft am $ablauf ab (in $tage Tagen)"
  else
    echo "cc-start: Token gültig bis $ablauf ($tage Tage)"
  fi
}

sitzung_status() {
  if tmux has-session -t "=${SESSION}" 2>/dev/null; then
    local cmd
    cmd=$(tmux display-message -p -t "${SESSION}:${WINDOW}" '#{pane_current_command}' 2>/dev/null || echo "?")
    echo "cc-start: Sitzung ${SESSION}:${WINDOW} läuft (Prozess: ${cmd})"
  else
    echo "cc-start: Sitzung ${SESSION} läuft nicht"
  fi
}

case "${1:-}" in
  --status)
    if [[ -f "$TOKEN_DATEI" ]]; then
      echo "cc-start: Token-Datei vorhanden, Rechte $(stat -c '%a' "$TOKEN_DATEI")"
    else
      echo "cc-start: Token-Datei fehlt"
    fi
    ablauf_hinweis
    sitzung_status
    exit 0
    ;;
  --tmux)
    pruefe_token_datei
    # Eine laufende Instanz kann mitten in einem Auftrag sein — nie beenden.
    if tmux has-session -t "=${SESSION}" 2>/dev/null \
       && tmux list-windows -t "=${SESSION}" -F '#{window_name}' | grep -qx "${WINDOW}"; then
      cmd=$(tmux display-message -p -t "${SESSION}:${WINDOW}" '#{pane_current_command}' 2>/dev/null || echo "?")
      if [[ "$cmd" != "bash" && "$cmd" != "zsh" && "$cmd" != "sh" ]]; then
        echo "cc-start: ${SESSION}:${WINDOW} läuft bereits (Prozess: ${cmd}) — keine Änderung."
        exit 0
      fi
    elif tmux has-session -t "=${SESSION}" 2>/dev/null; then
      tmux new-window -d -t "${SESSION}:" -n "${WINDOW}" -c "${ARBEITSVERZEICHNIS}"
    else
      tmux new-session -d -s "${SESSION}" -n "${WINDOW}" -c "${ARBEITSVERZEICHNIS}"
    fi
    tmux set-window-option -t "${SESSION}:${WINDOW}" automatic-rename off >/dev/null
    # Nur der Skriptpfad wird eingetippt, nie das Token.
    tmux send-keys -t "${SESSION}:${WINDOW}" "${HOME}/bin/cc-start.sh" Enter
    echo "cc-start: in ${SESSION}:${WINDOW} gestartet"
    exit 0
    ;;
  "")
    ;;
  *)
    fehler "unbekannter Schalter: $1 (erlaubt: --status, --tmux)"
    ;;
esac

pruefe_token_datei
ablauf_hinweis
cd "$ARBEITSVERZEICHNIS"
CLAUDE_CODE_OAUTH_TOKEN="$(<"$TOKEN_DATEI")"
export CLAUDE_CODE_OAUTH_TOKEN
exec claude --permission-mode auto
