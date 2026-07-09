# Audit-Findings — bikosoc

**Stand: 2026-07-09**
**Scope: bikosoc (Executive Agent)**
**Methode: spec-auditor-v2-final.md §2.2**

---

## Findings-Tabelle

| ID | Titel | Schwere | Status | Entscheidung | Gefunden | Erledigt |
|----|-------|---------|--------|--------------|----------|----------|
| F-001 | Architektur-Doku nur als PDF — docs/ARCHITECTURE.md existiert (verify) | niedrig | offen | pending | 2026-07-09 | — |
| F-002 | Doku-Cochange-Warnung als Git-Hook (Backlog) | mittel | offen | pending | 2026-07-09 | — |
| F-003 | openclaw-workspace-state.json untracked | niedrig | offen | pending | 2026-07-09 | — |
| F-004 | 9 verwaiste openclaw_test_* DBs | niedrig | offen | pending | 2026-07-09 | — |
| F-005 | Telegram-Commands 112 vs Bot-Limit 100 | mittel | offen | pending | 2026-07-09 | — |

---

## Detailblätter

### F-001: Architektur-Doku nur als PDF

**Beschreibung:** Spec beanstandet, dass Architektur-Doku nur als PDF vorliegt.
Tatsächlich existiert `docs/ARCHITECTURE.md` als Markdown-Master — die PDF ist
laut CLAUDE.md "abgeleitet (nur bei Bedarf generiert), die .md ist kanonisch".

**Prüfung:** Zu verifizieren ob die PDF aktuell ist und ob der Markdown-Master
vollständig ist.

**Betroffene Regeln:** GOV-001 (Doku im selben Commit)

---

### F-002: Doku-Cochange-Warnung als Git-Hook

**Beschreibung:** GOV-001 (Doku im selben Commit wie Code) wird aktuell nur
durch Disziplin durchgesetzt. Ein pre-commit Hook könnte warnen, wenn Code
in `src/` geändert wird ohne dass `docs/` im selben Commit enthalten ist.

**Betroffene Regeln:** GOV-001

---

### F-003: openclaw-workspace-state.json untracked

**Beschreibung:** `openclaw-workspace-state.json` liegt untracked im Workspace.
Klärung nötig: Soll es gitignored, committed, oder gelöscht werden?

**Betroffene Regeln:** —

---

### F-004: 9 verwaiste openclaw_test_* DBs

**Beschreibung:** 9 Test-Datenbanken (`openclaw_test_*`) existieren in der
Postgres-Instanz und werden nicht aufgeräumt. Vermutlich Relikte aus
`bun test`-Läufen.

**Betroffene Regeln:** GOV-019 (Postgres-Isolation)

---

### F-005: Telegram-Commands 112 vs Bot-Limit 100

**Beschreibung:** `verify:commands` zeigt 112 registrierte Handler. Telegram
Bot API hat ein Limit von 100 Commands in `setMyCommands`. Klärung nötig:
Werden alle 112 via `setMyCommands` gesetzt, oder nur eine Teilmenge?

**Betroffene Regeln:** GOV-005 (Command-Registration bidirektional)
