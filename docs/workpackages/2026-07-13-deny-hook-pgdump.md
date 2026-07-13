# Evidence-Bundle: Deny-Hook + pg_dump-vor-AUTO

**Datum:** 2026-07-13
**Typ:** REVIEW (HDCC-Paritaet)
**Scope:** Claude-Code-Hooks, Backup-Automatisierung

---

## Zusammenfassung

Vier Sicherheitsmechanismen von HDCC nach bikosoc portiert:
1. PreToolUse Deny-Hook blockiert destruktive Bash-Commands (rm -rf, DROP TABLE, git push --force, etc.)
2. Notification-Hook sendet Telegram-Meldung bei Permission/Idle-Prompts
3. pg_dump-vor-AUTO-Skript mit Rotation (keep 10)
4. CLAUDE.md-Dokumentation aller Konventionen

## Neue Dateien

| Datei | Zweck |
|-------|-------|
| `~/.claude/hooks/deny-destructive.sh` | PreToolUse deny hook, fail-closed |
| `~/.claude/hooks/telegram-notify.sh` | Notification hook, non-fatal |
| `scripts/cc-pre-backup.sh` | pg_dump vor AUTO-Laeufen |

## Geaenderte Dateien

| Datei | Aenderung |
|-------|-----------|
| `~/.claude/settings.json` | Hooks-Config (PreToolUse + Notification) |
| `CLAUDE.md` | Deny-Hook + pg_dump Konventionen, Open TODO |

## Selftest-Ergebnisse

| Test | Ergebnis |
|------|----------|
| Deny: `rm -rf /tmp/test` | DENY (recursive delete) |
| Deny: `npm run build` | ALLOW (kein Output, Exit 0) |
| Deny: `git push --force` | DENY (git push --force) |
| Deny: `DROP TABLE` | DENY (SQL DROP TABLE) |
| pg_dump | `openclaw-20260713-083955.dump` (566 TOC entries) |
| pg_restore --list | PASS (valid custom format) |

## Gates

| Gate | Ergebnis |
|------|----------|
| `npm run build` | Exit 0 |
| `npm run verify:commands` | 114/114 |
| Gateway-Restart | active (running) |
| Smoke-Test | 28/28 PASS |

## Sofort-Kurz-Audit

Keine neuen Befunde. Alle Aenderungen sind additive Sicherheitskontrollen
ohne Lockout-Risiko.

## HDCC-Referenz

Quellen:
- `/home/biko/hdcc/.claude/hooks/deny-destructive.sh`
- `/home/biko/hdcc/.claude/hooks/telegram-notify.sh`
- `/home/biko/hdcc/scripts/cc-pre-backup.sh`
- `/home/biko/hdcc/.claude/settings.json`
