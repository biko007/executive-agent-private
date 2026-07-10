# Audit-Findings — bikosoc

**Stand: 2026-07-10**
**Scope: bikosoc (Executive Agent)**
**Methode: spec-auditor-v2-final.md §2.2**

---

## Findings-Tabelle

| ID | Titel | Schwere | Status | Entscheidung | Gefunden | Erledigt |
|----|-------|---------|--------|--------------|----------|----------|
| F-001 | Architektur-Doku: PDF-Aktualität prüfen | niedrig | erledigt | ARCHITECTURE.md als führende Quelle konsolidiert | 2026-07-09 | 2026-07-10 |
| F-002 | Doku-Cochange-Warnung als Git-Hook | mittel | erledigt | pre-commit Hook (Warnung, kein Block) | 2026-07-09 | 2026-07-10 |
| F-003 | openclaw-workspace-state.json untracked | niedrig | erledigt | .gitignore (Laufzeit-State) | 2026-07-09 | 2026-07-09 |
| F-004 | Verwaiste openclaw_test_* DBs | niedrig | erledigt | Bereits bereinigt (0 DBs gefunden) | 2026-07-09 | 2026-07-09 |
| F-005 | Telegram-Commands 112 vs Bot-Limit 100 | mittel | erledigt | Kuratiertes Menü (29 Cmds), alle 112 funktional | 2026-07-09 | 2026-07-09 |

---

## Detailblätter

### F-001: Architektur-Doku: PDF-Aktualität prüfen [ERLEDIGT]

**Beschreibung:** Spec beanstandet, dass Architektur-Doku nur als PDF vorliegt.

**Lösung:** `docs/ARCHITECTURE.md` als führende Quelle konsolidiert. Header
"Führende Quelle — ersetzt PDF-Doku" gesetzt. Abgleich gegen reale Struktur:
Services/Ports via systemd, 56 Tabellen via Postgres, 15 Module via Verzeichnisbaum,
Schema-Versionen. Fehlende Abschnitte ergänzt: Meeting-Calendar-Path (§10),
Owner-Memory (§11), Governance-Framework (§12), Command-Guard (§12).
Veraltetes korrigiert: Gateway-Version, n8n-Workflows, Token-Guardian-Status,
Advisory-Lock-Registry. CLAUDE.md-Verweis aktualisiert.

**Erledigt:** 2026-07-10

---

### F-002: Doku-Cochange-Warnung als Git-Hook [ERLEDIGT]

**Beschreibung:** GOV-001 (Doku im selben Commit wie Code) wird aktuell nur
durch Disziplin durchgesetzt.

**Lösung:** Pre-commit Hook in `scripts/hooks/pre-commit`. Warnt gelb wenn
`*.ts` geändert aber kein `*.md` im Commit. Blockiert NICHT (exit 0).
Versioniert im Repo, Installation via `git config core.hooksPath scripts/hooks`.
CLAUDE.md Doku-Disziplin-Abschnitt mit Hook-Referenz aktualisiert.

**Betroffene Regeln:** GOV-001

**Erledigt:** 2026-07-10

---

### F-003: openclaw-workspace-state.json untracked [ERLEDIGT]

**Beschreibung:** `openclaw-workspace-state.json` lag untracked im Workspace.

**Lösung:** In `.gitignore` des Parent-Repos aufgenommen (Laufzeit-State,
gehört nicht ins Repo).

**Erledigt:** 2026-07-09

---

### F-004: Verwaiste openclaw_test_* DBs [ERLEDIGT]

**Beschreibung:** Spec meldete 9 verwaiste `openclaw_test_*` Datenbanken.

**Prüfung:** `\l` gegen Postgres zeigt 0 Datenbanken mit Pattern `openclaw_test_*`.
Nur vorhandene DBs: `n8n`, `openclaw_core`, `hdcc_core`, `hdcc_test`, `postgres`,
`template0`, `template1`. Alle produktiv/system — keine verwaisten Test-DBs.

**Lösung:** Bereits bereinigt (vermutlich durch früheren manuellen Eingriff).

**Erledigt:** 2026-07-09

---

### F-005: Telegram-Commands 112 vs Bot-Limit 100 [ERLEDIGT]

**Beschreibung:** `verify:commands` zeigt 112 registrierte Handler. Telegram
Bot API hat ein Limit von 100 Commands in `setMyCommands`.

**Lösung:** Kuratiertes Menü mit 29 owner-relevanten Commands via `setMyCommands`
gesetzt. Alle 112 Handler bleiben funktional — das Menü ist nur die Autocomplete-
Vorschlagsliste in der Telegram-App, kein funktionaler Filter.

**Menü-Commands (29):**
brief, briefingtime, calendar, meet, inbox, weight, sleep, healthlog,
healthweek, healthtrend, ourasync, banking, tan, trade, tradepos, tradeperf,
tradekill, fleet, tuev, trips, tripnew, properties, costs, sharepoint,
spsync, memory, insta, instadrafts, pe

**Erledigt:** 2026-07-09
