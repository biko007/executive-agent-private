# cc-anmeldung.sh — feste Env-Quelle für die Anmeldung von Claude Code
# (Spec Cowork-Platform §13.1, 05.11.2026). Wird mit `source` gelesen.
#
# Diagnose 05.11.2026: Die laufende Sitzung bikosoc bezieht ihre Anmeldung aus
# der Umgebungsvariable CLAUDE_CODE_OAUTH_TOKEN, gesetzt von ~/bin/cc-start.sh
# aus der Token-Datei ~/.claude-oauth-token (chmod 600, langlebiges OAuth-Token
# aus `claude setup-token`, Ablaufdatum in ~/.claude-oauth-token.expires).
#
# Diese Datei enthält KEIN Geheimnis — sie verweist nur auf die Token-Datei.
# Das Token wird nie ausgegeben; `set -x` ist verboten.

set +x
CC_TOKEN_DATEI="${HOME}/.claude-oauth-token"
if [[ ! -s "$CC_TOKEN_DATEI" ]]; then
  echo "cc-anmeldung: Token-Datei fehlt oder ist leer: $CC_TOKEN_DATEI" >&2
  return 1 2>/dev/null || exit 1
fi
if [[ "$(stat -c '%a' "$CC_TOKEN_DATEI")" != "600" ]]; then
  echo "cc-anmeldung: Token-Datei hat nicht die Rechte 600: $CC_TOKEN_DATEI" >&2
  return 1 2>/dev/null || exit 1
fi
CLAUDE_CODE_OAUTH_TOKEN="$(<"$CC_TOKEN_DATEI")"
export CLAUDE_CODE_OAUTH_TOKEN
