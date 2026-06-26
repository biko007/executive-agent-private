# OpenClaw / bikosoc — Architektur

> **Master-Dokument** (Single Source of Truth). Das PDF ist ein abgeleitetes Artefakt
> und wird hieraus generiert — die `.md` ist der kanonische Stand.
> Geteilte Plattform-Infrastruktur (VPS, Postgres-Instanz, nginx, MinIO, ffmpeg, Ports):
> autoritativ in **`SHARED_PLATFORM.md`**, hier nur referenziert.

**Status-Konvention** — gilt pro Abschnitt, einzelne Zeilen können abweichen:
- ✅ **Verifiziert** auf VPS am Datum — Quelle benannt
- ⏳ **Zu verifizieren** — Prüfschritt benannt

**Verifikations-Pässe:** 2026-06-26 · cc-Reports `archdoc-verify-20260626-1717.md` + `archdoc-verify2-20260626-1724.md` (read-only).

---

## 1. Zweck und Scope

**Status:** ✅ stabil (Konzept)

OpenClaw („Hans Dampf") ist der persönliche Executive-KI-Agent des Owners: modularer
Monolith auf einem einzigen Hetzner-VPS, mit Telegram-Bot als primärer Schnittstelle.
Fachmodule: Trading, Banking, Health, Assets (Immobilien inkl. Nebenkosten-Engine), Fleet,
Instagram, sowie Querschnitt (Briefing, Audit, Approvals, Health-Monitor).

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

**Status:** ✅ verifiziert 2026-06-26 (`systemctl --user`, offene Ports)

OpenClaw-eigene Services (Host/nginx/Postgres-Instanz: `SHARED_PLATFORM.md`):

| Service | Port | Laufzeit | Beschreibung |
|---|---|---|---|
| openclaw-gateway (Core) | 18789 | node | Executive Agent + Telegram-Bot, Fachmodule (v2026.2.14) |
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

**Status:** ✅ vollständig verifiziert 2026-06-26

- DB `openclaw_core` (App-User `openclaw`), **53 Tabellen**. Instanz → `SHARED_PLATFORM.md §3/§4`.
- **Schema-Versionierung: pro Modul.** Tabelle `schema_version` = `(module, version,
  applied_at)`. Es gibt **keinen globalen Linearstand**. Höchste Versionen je Modul:
  banking **39** (appliziert 2026-06-25), settings **35**, fleet 37, instagram 37, assets 36,
  sharepoint 34, links 33, location 32, health 21, executive/shared 1. **Das frühere
  „V035 vs V039" ist definitiv kein Konflikt** — `settings@35` vs `banking@39`.

**Modul-Migrationsstand (verifiziert über Tabellenbestand):**

| Modul | Datenhaltung | ggü. v32 |
|---|---|---|
| Instagram | Postgres (`insta_*`) | ✓ |
| Health | Postgres (`health_logs`, `health_withings_tokens`) | ✓ |
| Assets/NK | Postgres (`properties`, `units`, `leases`, `tenants`, `nk_*`, `meters`, `expense_bookings`, `cost_categories` …) | ✓ |
| Banking | Postgres (`banking_*`, 6 Tabellen) | **neu** |
| Fleet | Postgres (`vehicles`, `vehicle_*`, `fleet_documents`) | **migriert** (v32: JSON) |
| Location | Postgres (`location_events`) | **migriert** |
| SharePoint | Postgres (`sharepoint_files`, `sharepoint_sync_runs`) | **migriert** |
| Links | Postgres (`entity_links`) | **migriert** |
| Calendar | kein lokaler Store (by design) | — |
| **Travel** | **file-basiert** (`src/modules/travel/store.ts`), keine Tabelle | nicht migriert |
| **Mail** | **file-basiert** (`src/modules/mail/store.ts`), keine Tabelle | nicht migriert |

> Der alte JSON-Pfad `artifacts/personal/` existiert **nicht mehr**. **Travel** und **Mail**
> sind die einzigen verbliebenen Nicht-Postgres-Module (eigene `store.ts`, file-basiert) —
> Postgres-Migration ausstehend, aktuell niedrigste Priorität.

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

**Status:** ✅ verifiziert 2026-06-26 (`workflow_entity`)

- Rolle: „dumme" Schicht — nur Trigger/Routing, keine Business-Logik, kein direkter
  DB-Zugriff; Endpunkte hinter Bearer-Token + nginx-Whitelist.
- **Aktive Workflows (2):** `health-withings-sync-daily`, `instagram-token-health-daily`.
- **Inaktiv:** `banking-sync-daily` (deaktiviert, Ziel-Endpoint seit E3 entfernt → strukturell
  **kein Banking-n8n** mehr) · `260509-openclaw-health-check`.
- ⏳ JSON-Artefakt `artifacts/n8n-workflows/banking-sync-daily.json`: belassen/entfernen offen
  (unkritisch).

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
  `rotated_at`; Unique-Index `uq_tokens_one_active`). Der aktive Token wird vom n8n-Workflow
  `instagram-token-health-daily` automatisch erneuert (≤7 Tage Restlaufzeit).
  > ⚠️ **Deadline-Korrektur:** Aktiver Token `expires_at` = **2026-08-25** (rotiert
  > 2026-06-26) — **nicht** das in Übergabe/Memory genannte 2026-09-06. Da OpenClaw
  > auto-refresht, gibt es **kein fixes Handover-Kalenderdatum**. Die echte Schranke: HDCC
  > hat **keinen** Refresh → nach dem Ingest bleiben HDCC max. ~60 Tage bis zum nächsten
  > nötigen (manuellen) Token-Tausch. Disconnect-Reihenfolge bleibt: **OpenClaw erst nach
  > HDCC-Ingest** abschalten (Dual-Bot-Schutz).
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

---

## 10. Roadmap / Sprint-Plan

**Status:** ✅ Stand 2026-06-26

- **Abgeschlossen:** Infra (Sprint 1–2) · Instagram/Health/Assets → Postgres (S3–5) ·
  Fleet/Location/SharePoint/Links → Postgres (über v32 hinaus) · Banking E0–E3 (Weekly-Button) ·
  Anthropic-Modell-ID-Fix · Security-Tail `nk-trigger`→`/api/internal/` (`eaa7610`).
- **Veraltet/überholt:** v32-Roadmap „Banking CSV-Upload / GoCardless" → ersetzt durch
  FinTS-Sidecar + Weekly-Button-Banking (§5).
- **Offen/anstehend:** Trading Phase 3 (validierter Engine + Kill-Switch) · Trading-/Telegram-
  Diagnose + Alert-Lärm-Reduktion · Telegram-Commands < 100 (Bot-Limit) · Security-Tail-Rest
  (Gateway-Token-Rotation, Withings-Redirect-URI + Re-Consent) · Sprint-12-Backlog
  (Hard-Delete Phase 2, Runbooks ins Repo, Frontend-Polish) · `openclaw_test_*`-Cruft-DBs
  aufräumen (§11/SHARED §4).

---

## 11. Verifikationsstatus / offene Fakten

**Vollständig verifiziert 2026-06-26** über beide cc-Pässe: Services/Ports · DB-/Rollen-Liste ·
Schema-Versionierung · Modul-Migrationsstand · Banking-Commits · Modell-Fix-Push · n8n-Status ·
Insta-Token-Ablauf · Travel/Mail-Datenhaltung · OS/Host/TLS.

**Erledigt (Hygiene-Batch 2026-06-26):**
- ✅ banking-fints `/health`-Endpoint nachgerüstet (HTTP 200, kein Bank-Kontakt) — §3
- ✅ `8443/tcp` UFW-Regel entfernt — `SHARED_PLATFORM.md §1`
- ✅ 9 `openclaw_test_*` Cruft-DBs gedroppt — `SHARED_PLATFORM.md §4`
- ✅ Tailscale-Mesh + MinIO-Buckets dokumentiert — `SHARED_PLATFORM.md §1/§6`

**Offene Tails (nicht doku-blockierend, niedrige Prio):**
- Travel + Mail → Postgres migrieren — §4
