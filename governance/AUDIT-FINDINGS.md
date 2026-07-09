# Audit-Findings — bikosoc

**Stand: 2026-07-09**
**Scope: bikosoc (Executive Agent)**
**Methode: spec-auditor-v2-final.md §2.2**

---

## Findings-Tabelle

| ID | Titel | Schwere | Status | Entscheidung | Gefunden | Erledigt |
|----|-------|---------|--------|--------------|----------|----------|
| F-001 | Architektur-Doku: PDF-Aktualität prüfen | niedrig | offen | eigenes Paket (niedrige Prio) | 2026-07-09 | — |
| F-002 | Doku-Cochange-Warnung als Git-Hook | mittel | akzeptiert | Backlog (Hook später) | 2026-07-09 | — |
| F-003 | openclaw-workspace-state.json untracked | niedrig | erledigt | .gitignore (Laufzeit-State) | 2026-07-09 | 2026-07-09 |
| F-004 | Verwaiste openclaw_test_* DBs | niedrig | erledigt | Bereits bereinigt (0 DBs gefunden) | 2026-07-09 | 2026-07-09 |
| F-005 | Telegram-Commands 112 vs Bot-Limit 100 | mittel | erledigt | Kuratiertes Menü (29 Cmds), alle 112 funktional | 2026-07-09 | 2026-07-09 |

---

## Detailblätter

### F-001: Architektur-Doku: PDF-Aktualität prüfen

**Beschreibung:** Spec beanstandet, dass Architektur-Doku nur als PDF vorliegt.
Tatsächlich existiert `docs/ARCHITECTURE.md` als Markdown-Master — die PDF ist
laut CLAUDE.md "abgeleitet (nur bei Bedarf generiert), die .md ist kanonisch".

**Prüfung:** Zu verifizieren ob die PDF aktuell ist und ob der Markdown-Master
vollständig ist.

**Entscheidung:** Niedrige Priorität, eigenes Paket. .md existiert und ist kanonisch.

**Betroffene Regeln:** GOV-001 (Doku im selben Commit)

---

### F-002: Doku-Cochange-Warnung als Git-Hook

**Beschreibung:** GOV-001 (Doku im selben Commit wie Code) wird aktuell nur
durch Disziplin durchgesetzt. Ein pre-commit Hook könnte warnen, wenn Code
in `src/` geändert wird ohne dass `docs/` im selben Commit enthalten ist.

**Entscheidung:** Akzeptiert als Backlog. Hook wird in einem späteren Sprint
implementiert.

**Betroffene Regeln:** GOV-001

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
