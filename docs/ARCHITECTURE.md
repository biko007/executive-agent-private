# OpenClaw / bikosoc — Architektur

> **Führende Quelle — ersetzt PDF-Doku.** Dieses Markdown ist das Single Source of Truth
> für die OpenClaw-Architektur. Das PDF (`openclawarchitektur_v32.pdf`) ist veraltet und
> wird nicht mehr gepflegt. Alle Architektur-Änderungen landen hier.
>
> Geteilte Plattform-Infrastruktur (VPS, Postgres-Instanz, nginx, MinIO, ffmpeg, Ports):
> autoritativ in **`SHARED_PLATFORM.md`**, hier nur referenziert.
>
> Governance-Framework: **`governance/AUDIT-CHECKLIST.md`** (Regel-Registry) +
> **`governance/AUDIT-FINDINGS.md`** (Findings-Tracker).

**Status-Konvention** — gilt pro Abschnitt, einzelne Zeilen können abweichen:
- ✅ **Verifiziert** auf VPS am Datum — Quelle benannt
- ⏳ **Zu verifizieren** — Prüfschritt benannt

**Verifikations-Pässe:** 2026-06-26 · 2026-07-10 (F-001 Konsolidierung) · 2026-07-12 (Betriebsautomatisierung).

---

## 1. Zweck und Scope

**Status:** ✅ stabil (Konzept)

OpenClaw („Hans Dampf") ist der persönliche Executive-KI-Agent des Owners: modularer
Monolith auf einem einzigen Hetzner-VPS, mit Telegram-Bot als primärer Schnittstelle.
Fachmodule (15): Trading, Banking, Health, Assets (Immobilien inkl. Nebenkosten-Engine), Fleet,
Instagram, Calendar, Mail, Travel, SharePoint, Location, Links, Memory, PE,
sowie Querschnitt (Briefing, Audit, Approvals, Health-Monitor, Governance).

**Nicht hier:** Plattform-Infrastruktur → `SHARED_PLATFORM.md`. Nachbarsystem HDCC →
eigenes Repo/Doc, hier nur an den Kontaktpunkten (§8).

---

## 2. Systemüberblick

**Status:** ✅ verifiziert 2026-06-26 (laufende Services)

- Architektur: modularer Monolith + dedizierte Service-Prozesse (systemd-User-Services).
- Externer Zugriff ausschließlich über nginx (HTTPS 443, Let's Encrypt) — `SHARED_PLATFORM.md §5`.
- Designprinzipien (aus v32, weiterhin gültig): Routing über Ports statt direkter Exposure;
  Paper-vor-Live (Trading); n8n „dumm" (nur Trigger/Routing); Big-Bang-Migration je Modul;
  Approval-Hard-Rule für schreibende Aktionen; sprechende IDs.

---

## 3. Services und Laufzeitmodell

**Status:** ✅ verifiziert 2026-07-10 (`systemctl --user`, `ss -tlnp`)

OpenClaw-eigene Services (Host/nginx/Postgres-Instanz: `SHARED_PLATFORM.md`):

| Service | Port | Laufzeit | Beschreibung |
|---|---|---|---|
| openclaw-gateway (Core) | 18789 | node | Executive Agent + Telegram-Bot, 15 Fachmodule (v2026.6.11) |
| ↳ Location-Endpoint | 18790 | (gateway) | iOS-Standort-Ingest |
| ↳ Gateway-intern | 18792 | (gateway) | interner Port |
| openclaw-dashboard | 18800 | node | Express + Web-UI |
| openclaw-trading | 18793 | node | Trading-Modus 3 (Full Auto, Paper) |
| openclaw-banking-fints | 18794 | **python** | FinTS-Sidecar (NEU seit v32) |
| openclaw-pdf-worker | 37777 | bun | PDF-Worker (NEU seit v32) |
| ibgateway | 7497 | java | IBC + Xvfb headless |

Backup-Services (`openclaw-backup-{daily,weekly,monthly}`) existieren als systemd-Units,
getriggert per **systemd-Timer** (nicht Cron) — siehe `SHARED_PLATFORM.md §9`.

> banking-fints hat seit 2026-06-26 einen unauthentifizierten **`/health`-Endpoint** (HTTP 200,
> `{"status":"ok","service":"banking-fints"}`). Reine Prozess-Liveness — **kein** Bank-Kontakt,
> kein DB-Zugriff, kein Auth. Authentifizierter Health-Check unter `/fints/health` (Bearer).

---

## 4. Daten-Layer (OpenClaw)

**Status:** ✅ verifiziert 2026-07-10 (`pg_tables`, `schema_version`)

- DB `openclaw_core` (App-User `openclaw`), **56 Tabellen**. Instanz → `SHARED_PLATFORM.md §3/§4`.
- **Schema-Versionierung: pro Modul.** Tabelle `schema_version` = `(module, version,
  applied_at)`. Es gibt **keinen globalen Linearstand**. Höchste Versionen je Modul:
  memory **42**, health **40**, banking **39**, fleet 37, instagram 37, assets 36,
  settings **35**, sharepoint 34, links 33, location 32, executive/shared 1.

**Modul-Migrationsstand (verifiziert über Tabellenbestand):**

| Modul | Datenhaltung | ggü. v32 |
|---|---|---|
| Instagram | Postgres (`insta_*`, 4 Tabellen) | ✓ |
| Health | Postgres (`health_logs`, `health_withings_tokens`, `health_oura_tokens`) | ✓ |
| Assets/NK | Postgres (`properties`, `units`, `leases`, `tenants`, `nk_*`, `meters`, `expense_bookings`, `cost_categories` …) | ✓ |
| Banking | Postgres (`banking_*`, 6 Tabellen) | **neu** |
| Fleet | Postgres (`vehicles`, `vehicle_*`, `fleet_documents`) | **migriert** (v32: JSON) |
| Location | Postgres (`location_events`) | **migriert** |
| SharePoint | Postgres (`sharepoint_files`, `sharepoint_sync_runs`) | **migriert** |
| Links | Postgres (`entity_links`) | **migriert** |
| Memory | Postgres (`conversation_log`, `owner_memory`) | **neu** (2026-07-06) |
| Calendar | kein lokaler Store (by design) | — |
| **Travel** | **file-basiert** (`src/modules/travel/store.ts`), keine Tabelle | nicht migriert |
| **Mail** | **file-basiert** (`src/modules/mail/store.ts`), keine Tabelle | nicht migriert |

> **Travel** und **Mail** sind die einzigen verbliebenen Nicht-Postgres-Module (eigene
> `store.ts`, file-basiert) — Postgres-Migration ausstehend, aktuell niedrigste Priorität.

---

## 5. Banking / FinTS / Sidecar

**Status:** ✅ Modell live + verifiziert 2026-06-26 (Erfolgspfad real bewiesen) —
⏳ einzig der 3955-TAN-Live-Test steht aus.

**Zielmodell (Weekly-Button, Owner-Entscheidung) — ersetzt das alte Tages-Auto-Sync:**

1. **Mo 12:00 Berlin:** Core-Scheduler sendet *nur* eine Telegram-Nachricht mit Button
   „🏦 Umsatzabruf starten" — **kein Bankkontakt**.
2. Owner tippt Button (oder `/banking sync`) → Sync 1 (`startWeeklySync`).
3. Bei FinTS-Code 3955: zweite Nachricht „✅ TAN bestätigt → jetzt syncen" → nach
   pushTAN-Freigabe tippt Owner → Sync 2 (`eventResync`) → Umsätze.
4. Schleifenfähig; gebremst **nur** durch SCA-Budget 6/30 Tage (keine Tages-Obergrenze).

**Architektur-Kernaussage:** Es existiert **kein automatischer Banking-Trigger** mehr —
kein Scheduler-Sync, kein n8n (`banking-sync-daily` inaktiv, §6), kein HTTP-Auto-Endpoint.
Einziger Weg zur Bank = Owner-Button.

**Etappen-Historie (alle ✅ auf `origin/master`, 2026-06-26 verifiziert):**
E0 Safety-Envelope (`8263e67`) · E1 Alert-Verlässlichkeit (`300cc30`) · E2 Button-Re-Sync +
Tages-Guard + CB-SET/CLEAR + SCA-Budget + Lookback-Cursor (`f596a99`) · E3 Weekly-Rework
(`058fa6f`).

**Tabellen (6):** `banking_accounts`, `banking_institutions`, `banking_sessions`,
`banking_sync_reminders`, `banking_sync_runs`, `banking_transactions`.
**Es gibt keine dedizierte `*sca*`-Tabelle** — SCA-Budget/Circuit-Breaker-Zustand wird in
`banking_sync_runs` geführt.

**Sicherheits-Constraints:**
- FinTS-Sidecar Python, `127.0.0.1:18794`, aktiv (verifiziert).
- KSK Tuttlingen, BLZ 64350070. Bank-seitige Fehlversuchs-Sperrschwelle 8+. **Dieser Zähler
  liegt bank-seitig, nicht in unserer DB** — operativ überwachen, nicht aus DB ableitbar.
- SCA gilt pro Zugangsperiode (P2): frischer Web-Login unterdrückt 3955.

**Offene Tails:** ⏳ erster echter 3955-Live-Test (kommt natürlich) · `SKIPPED_ALREADY_SYNCED`
toter Code-Zweig (bewusst out of scope) · CLAUDE.md-Banking-Abschnitt nachziehen.

---

## 6. n8n / Automationen

**Status:** ✅ aktualisiert 2026-07-10

- Rolle: „dumme" Schicht — nur Trigger/Routing, keine Business-Logik, kein direkter
  DB-Zugriff; Endpunkte hinter Bearer-Token + nginx-Whitelist.
- **Aktive Workflows: 0.** Alle OpenClaw-bezogenen Workflows sind `active=false`:
  - `instagram-token-health-daily` — Token Guardian aus Code entfernt (2026-07-07),
    Core-Endpoints `/api/instagram/token-health` + `/token-refresh` gelöscht.
    Health-Monitor prüft Token-Expiry weiterhin direkt via Postgres.
  - `health-withings-sync-daily` — war nie funktionsfähig (nginx-Routing-Problem).
    Briefing-Pre-Sync läuft autark ohne n8n.
  - `banking-sync-daily` — Ziel-Endpoint seit E3 entfernt.
  - `260509-openclaw-health-check` — inaktiv.

---

## 7. Modell-IDs und LLM-Routing

**Status:** ✅ verifiziert 2026-06-26 (`origin/master`, grep)

- Zentrale Konstante `ANTHROPIC_MODEL = 'claude-sonnet-4-6'` in `src/shared/utils/index.ts:83`.
- Ersetzte die veraltete `claude-sonnet-4-20250514` (HTTP 404): **0 Restvorkommen** in `src`.
- Vision behält Override: `process.env.ANTHROPIC_VISION_MODEL || ANTHROPIC_MODEL`.
- Push-Stand: `5b5da70` auf `origin/master`, Tree clean, nichts unpushed. Künftiger
  Modellwechsel = Einzeiler.

---

## 8. Schnittstellen zu Nachbarsystemen (HDCC)

**Status:** ✅ verifiziert 2026-06-26 — Token-Deadline korrigiert (s. ⚠️)

Nur echte Kontaktpunkte — HDCC-Interna in `hdcc/docs/ARCHITECTURE.md`.

- **@jurgen_bickel Credential-Handover:** OpenClaw hält die Insta-Credential
  (`insta_tokens`, Single-Active-Token-Modell: `access_token`, `expires_at`, `active`,
  `rotated_at`; Unique-Index `uq_tokens_one_active`).
  > **Stand 2026-07-10:** Token Guardian (auto-refresh via n8n) ist **entfernt** (Code +
  > Endpoints gelöscht 2026-07-07, n8n-Workflow war bereits `active=false`).
  > Health-Monitor prüft weiterhin `expires_at` und warnt via Telegram bei Ablauf.
  > Token-Erneuerung ist aktuell **manuell** (HDCC hat nach Ingest ≤60 Tage bis zum
  > nächsten Tausch). Disconnect-Reihenfolge: **OpenClaw erst nach HDCC-Ingest** abschalten.
- **Geteilte nginx:** Route `/static/hdcc/` serviert HDCC-Medien über die *gemeinsame* nginx
  (neben `/static/instagram/` für OpenClaw) → `SHARED_PLATFORM.md §5`.
- **Geteilte Plattform:** eine Postgres-Instanz (getrennte DBs/Rollen), MinIO, ffmpeg-Binary →
  `SHARED_PLATFORM.md`.

---

## 9. Betriebsrelevante Constraints

**Status:** ✅ stabil (Workflow/Prozess)

- Trading läuft Paper (DUP514636, ~$990k NLV, Modus 3 Full-Auto). Phase 3 (Live) **nicht**
  freigeschaltet — braucht validierten Strategy-Engine + Kill-Switch. *(Inhaltliche
  Diagnose des Strategy-Engine-Stands folgt separat; Kapitel hier bewusst dünn.)*
- Approval-Hard-Rule: schreibende Aktionen brauchen explizite Freigabe, CI-getestet.
- Build-Gate: build → check → restart → smoke (cc-Standard-Eigenvorschlag nach Push).
- Diagnose-First: cc-Selbstreport unbewiesen bis Artefakt.
- Plan Mode Pflicht ab 3+ Dateien. `git add -A` je Etappe, working tree clean vor Push.

### Health-Monitor (Querschnitt)

`src/modules/executive/health-monitor.ts` — pollt alle 5 min, Alerts via Telegram.

- **Service-Health:** HTTP-Checks für Core/Dashboard/Trading/n8n. State-Transition (up↔down)
  löst Alert aus, `shouldAlert()` throttled auf 30 min pro Key.
- **Token-Expiry:** Täglich 08:00 Berlin, prüft Instagram-Token (`insta_tokens.expires_at`).
- **Location-Staleness:** Prüft `location_events.recorded_at` gegen
  `LOCATION_STALE_THRESHOLD_MS` (Default 12h). Ein WARN bei Überschreitung, eine Entwarnung
  bei frischen Daten. Wiedervorlage alle `LOCATION_STALE_RENAG_MS` (24h) solange stale.
  Leere Tabelle → kein Alert, kein Crash.

### Withings-Sync (konsolidiert 2026-06-26, auf weight-only reduziert 2026-06-27)

`src/modules/health/commands.ts` — `runWithingsSync()` holt nur noch Measures (Gewicht +
Körperfett). Sleep, Activity, Workouts und HR werden seit 2026-06-27 von Oura gezogen.
Alle Pfade routen durch `executeWithingsSync()` (Advisory Lock 42 + Retry-on-401):

- **Briefing-Pre-Sync:** 48h-Fenster, autark (kein n8n nötig). Fehler werden geloggt
  (`console.error`) und in `last_sync_error` persistiert (nicht lautlos verschluckt).
- **`/healthsync N`:** Ehrt N Tage wörtlich (`sinceMs = now - N*24h`). Kein `last_sync`-Zweig.
- **`triggerWithingsSync`:** n8n-Endpoint, 48h-Fenster.

n8n-Workflow `health-withings-sync-daily` (`uSGEPq973pNTxXtj`) deaktiviert (`active=false`) —
war nie funktionsfähig (nginx `/api/` Catch-All → Dashboard 18800 statt Gateway 18789).

### Oura-Sync (2026-06-27)

`src/modules/health/oura.ts` — Oura Ring API v2 Integration (OAuth2, Sleep, HRV, Readiness,
Activity). Oura ist primäre Quelle für Schlaf, HRV, Readiness, Temperatur und Ruhe-HR.

`src/modules/health/commands.ts` — `runOuraSync()` holt alle Oura-Datentypen:
- **Sleep** → type `sleep` (upsert per day, seconds → hours)
- **HRV** → type `hrv` (aus Sleep-Response, `average_hrv`)
- **Resting HR** → type `heartrate` (aus Sleep-Response, `lowest_heart_rate`)
- **Readiness** → type `readiness` (Score + Contributors)
- **Temperature** → type `temperature` (Deviation from baseline)
- **Steps/Activity** → type `steps` (aus Daily Activity)

Alle Pfade routen durch `executeOuraSync()` (Advisory Lock **47** + Retry-on-401):

- **Briefing-Pre-Sync:** 48h-Fenster, parallel zu Withings (`Promise.allSettled`).
- **`/ourasync N`:** Ehrt N Tage wörtlich.
- **`triggerOuraSync`:** HTTP-Endpoint `POST /api/health/oura-sync`.
- **`/ouraauth`:** Temp-Server auf Port 8081, Pfad `/oura/callback`.

DB: `health_oura_tokens` (V040, ohne `userid`). Dedup: `hasEntryForDate` für alle Typen
außer Sleep (upsert). `health_logs.external_id` (vormals `withings_id`) ist provider-neutral.

**Advisory-Lock-Registry:** 42=Withings, 43=Banking-Test, 44=SharePoint, 46=Banking-Session,
**47=Oura**, **48=Memory-Sweep**.

---

## 10. Mail-Scanner Meeting-Detection + Calendar-Path

**Status:** ✅ live seit 2026-07-10 (Evidence Bundle `docs/workpackages/2026-07-10-meeting-detection.md`)

Mail-Scanner (`src/modules/mail/commands.ts`) klassifiziert eingehende M365-Mails via
LLM (Haiku) in drei Kategorien: **BOOKING** (Reise), **MEETING** (Termin), **null** (irrelevant).

- **Prompt:** 3-Wege-Klassifikation in `src/modules/travel/enrichment.ts`. EVENT (Buchung)
  eingeschränkt auf gekaufte Tickets. Meeting-Keywords (Zoom, Teams, Meet) als Negativ-Beispiele
  für BOOKING. Zeitangaben als ISO8601 mit Zeitzone-Offset (`+02:00` MESZ / `+01:00` MEZ).
- **Meeting-Flow:** `isMeeting()` Type-Guard → `formatMeetingMessage()` → Telegram-Buttons
  ("In Kalender eintragen" / "Ignorieren") → `handleMeetingCallback` → `createCalendarEventDirect()`.
- **Calendar-Path:** `createCalendarEventDirect()` in `src/modules/calendar/commands.ts`.
  M365 Graph API `POST .../events`. Konflikterkennung über `calendarView`. Zeitzone-korrekt:
  `toBerlinLocalIso()` formatiert Date-Objekte als Berlin-Lokalzeit für M365 Payload
  (M365 interpretiert `dateTime` im angegebenen `timeZone`-Feld).
- **State:** `pendingMeetings` Map auf `globalThis` (multi-load-resilient).
- **Callback-Prefix:** `meeting_` in `CALLBACK_PREFIXES` (index.ts).
- **Type:** `ParsedMeeting` in `src/modules/travel/types.ts`.

---

## 11. Owner-Memory (dynamisches Gedächtnis)

**Status:** ✅ live seit 2026-07-06

Dynamisches Gedächtnis: EA lernt aus Owner-Konversationen (Text + Voice-Transkripte).

- **Conversation-Log:** `agent_end`-Hook persistiert Owner-Turns in `conversation_log`.
  Voice-Transkripte via `resolveTranscript()`. Fire-and-forget.
- **Fakten-Extraktion:** `extractFacts()` via LLM, max 5 Fakten/Turn, Dedup via Unique Index +
  LLM-Abgleich, Supersede statt Löschen.
- **Sweep:** `runExtractSweep()` alle 60s, Advisory Lock **48**, max 3 Versuche.
- **Recall:** Branch 7 in `before_agent_start`, max 50 Fakten / 4 KB, Cache TTL 60s.
- **Pflege:** `/memory list`, `/memory drop <id>` (Bestätigungs-Button, `memdrop_` Callback-Prefix).
- **DB:** `conversation_log`, `owner_memory` (Migration 041/042, Boot-Time-DDL).
- **Log-Disziplin:** Journal loggt nur IDs/Counts — keine Fakten-Klartexte (BIK-005).

---

## 12. Governance-Framework

**Status:** ✅ eingeführt 2026-07-09

Audit-Prozess für Regel-Compliance und Architektur-Drift.

- **Regel-Registry:** `governance/AUDIT-CHECKLIST.md` — 22 GOV-Regeln + 5 BIK-Regeln.
  Teil A (Regel-Registry), Teil B (6 Prüfpunkte), Teil C (bikosoc-Annex).
- **Findings-Tracker:** `governance/AUDIT-FINDINGS.md` — F-001 bis F-009.
- **Evidence-Bundles:** `docs/workpackages/YYYY-MM-DD-<name>.md` je Arbeitspaket.
- **Regelquelle-Verweis:** Chat-Beschlüsse gelten erst nach Überführung in die Checkliste.
- **Build-Gate (maschinell geprüft):** `npm run build` (GOV-007), `npm run verify:commands`
  (GOV-005), `bun run scripts/smoke-test.ts` (GOV-008), `npm test` (GOV-009).
- **Command-Guard:** `scripts/verify-commands.ts` prüft bidirektional:
  Direction A (`registerCommand` ohne `REGISTERED_COMMANDS` Eintrag) und
  Direction B (`REGISTERED_COMMANDS` ohne Handler). Aktuell **114/114** konsistent.
  Exit 0 Pflicht vor jedem Commit.

### Betriebsautomatisierung (portiert von HDCC, 2026-07-12)

Automatisierte Report-Zustellung und Betriebs-Überwachung für cc-Läufe:

- **Report-Watcher:** `fs.watch` auf `~/bikosoc-spec/` + `~` (Whitelist `report-*.md`).
  Automatische Telegram-Zustellung neuer/geänderter Reports (Dokument + max 3 Text-Chunks à 4000 Zeichen).
  Rate-Limit: 1 Datei/min. Dedupe-State: `~/bikosoc-spec/.report-sent.json`.
  Erstlauf-Seeding: existierende Dateien werden in Map geseeded, nicht gesendet.
  globalThis-Guard: `__ea_reportWatcherRegistered`. 5s Debounce.
- **Wait-Notifier:** 30s-Polling via `tmux capture-pane -t bikosoc`. Erkennt Input-Prompts
  (❯, (y/n), Allow/Deny, nummerierte Optionen). Telegram-Notification mit Preview.
  Cooldown: 5min. Dedup auf Content-Hash (kein Re-Notify bei unverändertem Prompt).
  globalThis-Guard: `__ea_waitNotifierRegistered`.
- **`/report [n]`:** Manueller Report-Abruf (n=1 neuester). Scannt ~/bikosoc-spec/ + ~/report-*.md.
- **`/ccstop`:** Kill-Switch für cc in tmux bikosoc (C-c + SIGTERM Kindprozesse). Owner-only.

---

## 13. Roadmap / Sprint-Plan

**Status:** ✅ Stand 2026-07-10

- **Abgeschlossen:** Infra (Sprint 1–2) · Instagram/Health/Assets → Postgres (S3–5) ·
  Fleet/Location/SharePoint/Links → Postgres (über v32 hinaus) · Banking E0–E3 (Weekly-Button) ·
  Banking 2.10-A (Session Reuse, 71 Tests, E2E KSK) · Anthropic-Modell-ID-Fix ·
  Security-Tail `nk-trigger`→`/api/internal/` · Owner-Memory Phase 3 (2026-07-06) ·
  Mail-Scanner Meeting-Detection + Calendar-Path (2026-07-10, §12) ·
  Timezone-Fix Meeting-Flow (2026-07-10) · Governance-Framework (2026-07-09, §13) ·
  Token-Guardian-Entfernung (2026-07-07) · Telegram-Commands kuratiertes Menü (29/114) ·
  Betriebsautomatisierung (2026-07-12, Report-Watcher + Wait-Notifier + /ccstop, §9) ·
  Security-Lauf Doctor-Empfehlungen (2026-07-12, F-009, §12).
- **Veraltet/überholt:** v32-Roadmap „Banking CSV-Upload / GoCardless" → ersetzt durch
  FinTS-Sidecar + Weekly-Button-Banking (§5). `openclaw_test_*`-Cruft-DBs → bereinigt.
- **Offen/anstehend:** Trading Phase 3 (validierter Engine + Kill-Switch) · Security-Tail-Rest
  (Gateway-Token-Rotation, Withings-Callback F-009 zurückgestellt) · Sprint-12-Backlog
  (Hard-Delete Phase 2, Runbooks ins Repo, Frontend-Polish) · Travel + Mail → Postgres (§4).

---

## 14. Verifikationsstatus / offene Fakten

**Verifiziert 2026-06-26** (Basis-Pass): Services/Ports · DB-/Rollen-Liste ·
Schema-Versionierung · Modul-Migrationsstand · Banking-Commits · Modell-Fix-Push · n8n-Status ·
Insta-Token-Ablauf · Travel/Mail-Datenhaltung · OS/Host/TLS.

**Aktualisiert 2026-07-10** (F-001 Konsolidierung): Tabellenzahl 53→56 · Gateway-Version ·
n8n-Workflows (alle inactive) · Token-Guardian-Entfernung · Memory-Modul · Meeting-Calendar-
Path · Governance-Framework · Command-Guard · Advisory-Lock-Registry komplett.

**Security-Lauf 2026-07-12** (Doctor-Empfehlungen): 3 Empfehlungen verifiziert (alle bereits
umgesetzt): `ownerAllowFrom` konfiguriert · Secrets als Env-Referenzen · `KillMode=mixed` korrekt.
Withings-Callback-Route als F-009 zurückgestellt (Refresh-Token ~1 Jahr gültig).
nk-trigger-Endpoint gesichert, n8n-Workflow als Backlog.

**Erledigt (Hygiene-Batch 2026-06-26):**
- ✅ banking-fints `/health`-Endpoint nachgerüstet (HTTP 200, kein Bank-Kontakt) — §3
- ✅ `8443/tcp` UFW-Regel entfernt — `SHARED_PLATFORM.md §1`
- ✅ 9 `openclaw_test_*` Cruft-DBs gedroppt — `SHARED_PLATFORM.md §4`
- ✅ Tailscale-Mesh + MinIO-Buckets dokumentiert — `SHARED_PLATFORM.md §1/§6`

**Offene Tails (nicht doku-blockierend, niedrige Prio):**
- Travel + Mail → Postgres migrieren — §4
- ⏳ erster echter 3955-Live-Test (Banking) — §5
