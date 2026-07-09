# Audit-Checklist — bikosoc

**Stand: 2026-07-09**
**Scope: bikosoc (Executive Agent)**
**Methode: spec-auditor-v2-final.md §2.1**

---

## Teil A: Regel-Registry

Autoritative Quelle aller prüfbaren Regeln. Chat-Beschlüsse gelten erst
nach Überführung in diese Registry.

| ID | Regel (Kurzform) | Klasse | Quelle |
|----|------------------|--------|--------|
| GOV-001 | Doku im selben Commit wie Code | I | CLAUDE.md Doku-Disziplin |
| GOV-002 | Human-Reviewability: kein Code zu origin unreviewed | I | CLAUDE.md Manifest §11 |
| GOV-003 | Approval-Hard-Rule (Instagram publish) | M | approval-hard-rule.test.ts |
| GOV-004 | Secrets nie in Code/Chat/Logs/Reports | I | CLAUDE.md Grundregeln + Manifest §9 + Task Output |
| GOV-005 | Command-Registration bidirektional | M | verify-commands.ts |
| GOV-006 | Schema-Drift clean | M | verify-schema |
| GOV-007 | TypeScript Build fehlerfrei | M | tsc |
| GOV-008 | Smoke-Test 28/28 | M | smoke-test.ts |
| GOV-009 | npm test grün vor Merge | M | bun test |
| GOV-010 | Sprechende IDs verbindlich | I→M | CLAUDE.md Manifest §12 |
| GOV-011 | Eine Schraube pro Sprint | I | CLAUDE.md Manifest §1 |
| GOV-012 | n8n bleibt dumm (nur Trigger+Routing) | I | CLAUDE.md Manifest §2 |
| GOV-013 | Modul-Grenzen heilig (ESLint) | M | ESLint no-deep-module-import |
| GOV-014 | Backup-Restore vor Backup-Schreiben | I | CLAUDE.md Manifest §4 |
| GOV-015 | Tests für Geld (IBAN/Post-Tests) | I | CLAUDE.md Manifest §5 |
| GOV-016 | Audit-Log Pflicht | I | CLAUDE.md Manifest §6 |
| GOV-017 | Idempotency vor Side-Effects | I | CLAUDE.md Manifest §8 |
| GOV-018 | Services nur 127.0.0.1 binden | I | CLAUDE.md Grundregeln + Netzwerk |
| GOV-019 | Postgres-Isolation (n8n_app ≠ openclaw_core) | M | smoke-test.ts Check 14+15 |
| GOV-020 | Naming Conventions PFLICHT (YYMMDD) | I | CLAUDE.md Naming Conventions |
| GOV-021 | Plan Mode bei >3 Dateien/neuen Features | I | CLAUDE.md Plan Mode |
| GOV-022 | Alpine CSP: x-if Single-Root | I | CLAUDE.md Alpine CSP §1 |

**Legende:**
- **I** = Inspektions-Regel (manuell prüfbar, Review/Stichprobe)
- **M** = Maschinelle Regel (automatisiert prüfbar, Gate/CI)
- **I→M** = aktuell Inspektion, Ziel maschinelle Absicherung

---

## Teil B: Prüfpunkte

6 Standard-Prüfpunkte je Audit-Durchlauf (spec §2.1):

### B1. Meta-Check
- [ ] Audit-Checklist vorhanden und aktuell?
- [ ] Regelquelle-Verweis in CLAUDE.md?
- [ ] Findings-Tabelle existiert?

### B2. Vorbefund-Status
- [ ] Alle offenen Findings (F-xxx) mit aktuellem Status?
- [ ] Fällige Findings eskaliert?

### B3. Gate-Gesundheit
- [ ] `npm run build` → Exit 0?
- [ ] `npm run verify:commands` → Exit 0?
- [ ] `npm run verify-schema` → Exit 0?
- [ ] `bun run scripts/smoke-test.ts` → 28/28?
- [ ] `npm test` → grün (ggf. sequenziell)?

### B4. Disziplin-Stichprobe
- [ ] Letzter Commit: Doku im selben Commit wie Code? (GOV-001)
- [ ] Keine Secrets in letzten 5 Commits? (GOV-004)
- [ ] Sprechende IDs in neuen Entitäten? (GOV-010)

### B5. Doku-Drift
- [ ] ARCHITECTURE.md Status-Marker aktuell?
- [ ] SHARED_PLATFORM.md Status-Marker aktuell?
- [ ] CLAUDE.md Sprint-Status korrekt?

### B6. Backlog-Zombies
- [ ] Offene TODOs in CLAUDE.md: noch relevant?
- [ ] Findings älter als 30 Tage: Eskalation nötig?

---

## Teil C: bikosoc-Annex

Zusätzliche Regeln spezifisch für bikosoc (nicht in allgemeiner Registry):

| ID | Regel | Quelle |
|----|-------|--------|
| BIK-001 | Banking-Sync nur manuell via Telegram, kein Auto-Trigger | CLAUDE.md Banking Telegram-Trigger |
| BIK-002 | Callback-Prefixes in CALLBACK_PREFIXES eintragen | CLAUDE.md Banking Telegram-Trigger |
| BIK-003 | Live Trading nur nach schriftlicher Freigabe | CLAUDE.md Trading Safety |
| BIK-004 | Kill-Switch (/tradekill) hat höchste Priorität | CLAUDE.md Trading Safety |
| BIK-005 | Memory: Journal loggt nur IDs/Counts, keine Fakten-Klartexte | CLAUDE.md Owner-Memory Phase 3 |

---

## Offene Fragen (Owner-Entscheidung)

Diese Punkte wurden bewusst NICHT als Regel eingetragen — sie erfordern
eine Owner-Entscheidung, ob sie audit-fähig sind:

1. Ist "Git Snapshot VOR jeder Änderung" eine prüfbare Regel oder nur Workflow-Empfehlung?
2. Sind die Engineering Principles (minimale Änderungen, production-grade) Audit-Regeln oder allgemeine Guidance?
3. Ist "Debugging: Hypothesen nach Wahrscheinlichkeit" audit-fähig?
