# Audit-Findings — bikosoc

**Stand: 2026-07-13**
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
| F-006 | /report + /ccstop: acceptsArgs fehlte, falsches Handler-Signatur | hoch | erledigt | acceptsArgs: true + ctx-Pattern, E2E offen | 2026-07-12 | 2026-07-12 |
| F-007 | Report-Watcher Chunk-Duplikat (concurrent scan) | mittel | erledigt | reportScanInProgress Guard | 2026-07-12 | 2026-07-12 |
| F-008 | Command-Guard deckt acceptsArgs nicht ab | niedrig | akzeptiert | Statisch nicht sinnvoll pruefbar, Owner-Akzeptanz 12.07. Mitigation: Claude-E2E-Pflicht nach Command-Aenderungen | 2026-07-12 | 2026-07-12 |
| F-009 | Withings OAuth-Callback-Route defekt | niedrig | zurückgestellt | Refresh-Token funktional (~1 Jahr gültig). Fix non-trivial, kein akuter Handlungsbedarf. | 2026-07-12 | — |

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

---

### F-006: /report + /ccstop: acceptsArgs fehlte, falsches Handler-Signatur [ERLEDIGT]

**Beschreibung:** E2E-Test via Telegram Web ergab:
- `/report 1` → "Command not found" (gateway routet nicht ohne `acceptsArgs: true`)
- `/report` → "Command failed" (Handler-Signatur `(args: string)` statt `(ctx: any)`)

**Root Cause:**
1. Gateway-Framework erfordert `acceptsArgs: true` fuer Commands mit Argumenten. Ohne
   dieses Flag wird `/report 1` als unbekannter Command behandelt (nur exaktes `/report` matcht).
2. Handler-Signatur war `(args: string, ctx: any)` — das Framework uebergibt aber ein einziges
   `ctx`-Objekt. Der erste Parameter war somit das ctx-Objekt, `.trim()` darauf wirft TypeError.

**Lösung:**
- `acceptsArgs: true` zu beiden Commands hinzugefuegt
- Handler-Signatur auf `(ctx: any)` geaendert, Args via `String(ctx?.args || '').trim()`
- Muster von `/healthsync`, `/trademode` und weiteren Arg-Commands uebernommen

**Betroffene Regeln:** GOV-005 (Command-Registration) — Guard prueft NUR Existenz, nicht
Korrektheit. Ergaenzung: F-008 dokumentiert die Luecke.

**Erledigt:** 2026-07-12

---

### F-007: Report-Watcher Chunk-Duplikat [ERLEDIGT]

**Beschreibung:** Bei der Erstlauf-Zustellung wurde Text-Chunk "2/2" doppelt gesendet.
Journal zeigt zwei `Delivered:` Zeilen im selben Millisekunden-Fenster.

**Root Cause:** `scanAndDeliverReports()` wurde von beiden fs.watch-Debounce-Timern
(Home + Spec) quasi-gleichzeitig aufgerufen. Ohne Concurrency-Guard konnte die Funktion
parallel laufen, wobei beide Instanzen die sentMap VOR dem Persistieren lasen und beide
die Datei als "ungesendet" sahen.

**Lösung:** `reportScanInProgress`-Flag als Mutex. Zweiter Aufruf wird sofort abgebrochen
(`if (reportScanInProgress) return`). try/finally stellt Reset sicher.

**Erledigt:** 2026-07-12

---

### F-008: Command-Guard deckt acceptsArgs nicht ab [AKZEPTIERT]

**Beschreibung:** `verify:commands` (GOV-005) prueft bidirektional ob Handler und
REGISTERED_COMMANDS-Eintrag existieren. Es prueft NICHT:
- Vorhandensein von `acceptsArgs: true` bei Arg-Commands
- Korrekte Handler-Signatur (`(ctx: any)` vs `(args: string)`)
- Laufzeit-Verhalten (ob Handler wirft)

**Analyse:** Eine statische Pruefung waere moeglich (AST-Parse nach `acceptsArgs`), aber
nicht proportional zum Risiko: es gibt 114 Commands, davon ~80 mit `acceptsArgs`. Jeder
neue Command wird gegen existierende Muster geprueft. Das E2E-Risiko ist gering nach
der heutigen Korrektur (Pattern ist jetzt klar dokumentiert).

**Entscheidung:** AKZEPTIERT — Risiko dokumentiert, Convention in CLAUDE.md verstaerkt.
Keine Gate-Erweiterung noetig. E2E-Pruefung neuer Commands bleibt Owner-Verantwortung.

**Owner-Akzeptanz:** 2026-07-12, bestaetigt durch Owner.
**Mitigation:** Claude-E2E-Pflicht nach jeder Command-Aenderung (manueller Telegram-Test).

---

### F-009: Withings OAuth-Callback-Route defekt [ZURÜCKGESTELLT]

**Beschreibung:** Die nginx-Route `/withings/callback` leitet auf Port 18789 (Gateway) weiter,
aber der Gateway hat keinen Handler fuer diesen Pfad registriert. Der temp-Server fuer
Withings-OAuth (`/withingsauth`) lauscht auf Port 8080 — nginx kennt diese Route nicht.

**Auswirkung:** Bei Ablauf des Refresh-Tokens (~1 Jahr Gueltigkeit) schlaegt Re-Consent fehl.
Token ID 142 ist aktiv und rotiert automatisch alle ~6h. Kein akuter Ausfall.

**Loesung (wenn noetig):**
- (a) Gateway-Route `/withings/callback` registrieren, die auf temp-Server (Port 8080) proxied, ODER
- (b) `WITHINGS_REDIRECT_URI` auf einen Port aendern, den der temp-Server direkt bedient
  (analog `/oura/callback` → Port 8081)

**Entscheidung:** ZURÜCKGESTELLT — Refresh-Token funktional, Auto-Rotation aktiv. Fix ist
nicht dringend (~1 Jahr Fenster). Wird als Backlog-Item gefuehrt.

**Gefunden:** 2026-07-12
**Betroffene Regeln:** keine (Betriebsrisiko, nicht Compliance)
