# Executive Agent — CLAUDE.md

**Stand: 2026-05-20**

## Stand 2026-05-20

Sprint 1 + 2 + 3 + 4 + 5 (5.5a + 5.5b) + 10 + 11 + 2.10-A vollständig abgeschlossen.

- **Sprint 1 (Plattform-Hardening):** nginx konsolidiert, n8n gehärtet, Audit-Log-Infra,
  Borg-Backup auf Hetzner Storage Box (daily/weekly/monthly + Restore-Drill),
  Health Monitor mit Telegram-Alerts, Sub-Commands, Smoke-Test, Deploy-Skript,
  Dashboard Status-Widget.
- **Sprint 2 (Code-Refactor):** index.ts 9.357 → 2.165 Zeilen (-77%), 10 Module extrahiert,
  19 audit.log() Calls in 4 Modulen, Approval-Hard-Rule im Code + CI-Test.
- **Sprint 3 (Instagram Postgres):** Instagram-Modul auf Postgres migriert.
  3 Tabellen (insta_drafts, insta_tokens, insta_style_profile). store.ts mit 10 pool.query,
  0 File-IO für Drafts/Tokens. Token Guardian via n8n-Workflow (daily 08:00).
  Status-Enum: englisch (draft/review/approved/published/archived).
- **Sprint 4 (Health Postgres):** Health-Modul auf Postgres migriert.
  2 Tabellen (health_logs 407 Einträge, health_withings_tokens). store.ts mit 13 dbQuery,
  withings.ts mit 7 dbQuery/getClient, 0 File-IO. pg_advisory_lock(42) für Sync-Schutz.
  Withings-Sync via n8n-Workflow `health-withings-sync-daily` (Cron daily 07:00 UTC).
  Core-Endpoints: POST /api/health/withings-sync, GET /api/health/sync-status.
  Retry-on-401 mit Single-Refresh + Fatal-Error-Pfad (Telegram-Notify).
- **Sprint 5.5a (Asset CRUD + NK PreCheck):** Assets-Modul auf Postgres migriert (V022+V023).
  Properties, Units, Leases, Tenants, Allocation Rules, Cost Categories, Expense Bookings,
  Meters, Readings, Unit Residents, Lease Charges, Heating Config, NK Period Obligations.
  CRUD-Endpoints mit Approval-Workflow, Idempotency, Audit-Log.
  nkPreCheck() mit 11 Blocker-Checks. Dashboard ENDPOINT_MAP für Assets.
- **Sprint 5.5b (NK-Engine + PDF):** Volle Nebenkostenabrechnung (13 Etappes a-m).
  NK-Engine: computeNk() mit Personentage, Vorauszahlung, Pro-Rata, HeizKV §7/§8/§9.
  V024 Schema: nk_statement_runs, nk_statements, nk_statement_items, nk_alert_log + Lock-Trigger.
  Endpoints: Preview, Finalize (Approval+Idempotency), Read, PDF, Re-Render, Serve, Run-List/Detail.
  PDF-Worker: Standalone Playwright Chromium Service, Handlebars-Template, atomisches Schreiben.
  §556-Cron: Fristüberwachung mit Telegram-Alerts (30d/14d/7d/1d/expired).
  Telegram: /nebenkostenabrechnung preview|status.
  54 Tests über 6 Dateien, 21/21 Smoke.
- **Sprint 10 (SharePoint Postgres):** SharePoint-Index (12.088 Dateien, 10 Sites) von JSON auf
  Postgres migriert. V034 Schema: `sharepoint_files` mit `pg_trgm` GIN-Index (`search_haystack`),
  Soft-Delete via `missing_since`, `sharepoint_sync_runs` Audit-Tabelle.
  Advisory-Lock(44) für Sync-Schutz. Canonical Key: `${siteId}::${driveId}::${path}`.
  One-Shot Import (12.088 in 1.0s). Golden Test: 41/41 entity_links resolven.
  Neue Module: store.ts (fullSync, UPSERT), queries.ts (searchFiles mit pg_trgm),
  routes.ts (HTTP API für Dashboard-Proxy). Polling entfernt (Q2).
  Dashboard SP-Routes auf proxyToCore umgestellt. 24/24 Smoke.
- **Sprint 11 (Closure + Housekeeping, 7 Etappen):**
  - **11.1:** Bulk-Readings atomar (BEGIN/COMMIT), idempotent (idempotency_keys), audit-pflicht
    (audit_log INSERT innerhalb Transaction). Pool-Release via `finally`.
  - **11.2:** SharePoint-Modul Hybrid aufgelöst — kein JSON mehr. Alle Reads aus Postgres.
    `sharepoint-index.json` + 2 Snapshots archiviert nach `archive/`.
  - **11.3:** Settings nach Postgres (V035). `system_settings` Tabelle (key TEXT PK, value JSONB).
    In-Memory-Cache (Single-Process, 60s Refresh). Caveat: Cache-Drift bei Multi-Instance.
  - **11.4:** Dashboard SP-Default-Site backend-resolved via `system_settings.sp_default_site_id`.
    Fallback: erster Site aus `sharepoint_files`. nextTick-Wraps für Vue-Reaktivität.
  - **11.5:** Migrations-Konvention dokumentiert (Dual-Pattern: V-Prefix One-Shot + 0xx Boot-Time).
    Drift-Detector (`npm run verify-schema`) als Sprint-Cut-Checkliste.
  - **11.6:** Housekeeping: 4 Legacy-JSON-Archive (instagram-drafts, location-history, links,
    sharepoint-index). Neuer Endpoint `POST /api/sharepoint/cleanup-missing` mit 2x-Sync-Schutz,
    Dry-Run-Default, LIMIT-50-Cap, entity_links-Ausschluss, Telegram-Notify.
    Hard-Delete Phase 1 (Dry-Run only). Phase 2 BEDINGT an 3 synthetische Tests.
  - **11.7:** Closure-Docs. Smoke 28/28. Drift-Detector clean. CLAUDE.md finalisiert.
  Archive-Status: `history.jsonl`, `links.json`, 3× `sharepoint-index*.json`, 6× Instagram-Drafts.
- **Sprint 2.10-A (Banking Session Reuse):** FinTS BPD/UPD-Cache Passthrough.
  Etappen: d (encryption) → a (findReusableSession) → c (decideReuse + advisory-lock) →
  b (sidecar-client + tan-bridge clientDataB64 passthrough) → g (sidecar fetch_tan_mechanisms fix).
  Session-Reuse: `decideReuse()` findet existierende Session mit gültigem encrypted State,
  `clientDataB64` wird durch routes → tan-bridge → sidecar-client → Python-Sidecar geschleust.
  Python-Sidecar gibt `from_data` an python-fints Library weiter → kein TAN bei Reuse.
  `ConnectResponse` Typ, `redactClientData()` Log-Redaction (Hard Rule 8).
  Advisory-Lock(46) für User+Institution-Serialisierung. Decrypt-Failure-Policy mit
  `markSessionStateInvalid()` + Audit. 71 Tests (Agent 35 + Sidecar 36).
  E2E: KSK Tuttlingen, 12 Konten, HAPPY PATH ohne TAN (Tag `2.10-a-e2e-passed`).
  Sidecar-Fix (Etappe g): `fetch_tan_mechanisms()` bei Reuse übersprungen — Library setzt
  blind `set_tan_mechanism('999')` was den aus `from_data` restaurierten Mechanismus zerstört.
  ~~Tech-Debt: TD-3 Sidecar GitHub-Remote (Sprint 2.10-F Backlog).~~ Erledigt 2026-06-25.

### Module (14)

| Modul | Pfad | Commands | DI |
|-------|------|----------|----|
| assets | src/modules/assets/ | 7 | Postgres, NK-Engine |
| banking | src/modules/banking/ | — (via routes.ts) | Postgres, Encryption, Python-Sidecar (FinTS) |
| calendar | src/modules/calendar/ | 4 | M365 |
| executive | src/modules/executive/ | Health Monitor, Briefing-Scheduler | — |
| fleet | src/modules/fleet/ | 10 | Links |
| health | src/modules/health/ | 12 | sendTelegram, Postgres |
| instagram | src/modules/instagram/ | 21 | sendTelegram, Meta API, Voice, Postgres |
| links | src/modules/links/ | — | Postgres |
| location | src/modules/location/ | — | Postgres |
| mail | src/modules/mail/ | 12 | M365, Yahoo, Telegram |
| nk | src/modules/nk/ | — (via assets) | Postgres, Playwright, Handlebars |
| pe | src/modules/pe/ | 5 | self-contained |
| sharepoint | src/modules/sharepoint/ | 8 | M365, Telegram, Postgres, pg_trgm |
| travel | src/modules/travel/ | 8 | M365, Telegram, Links |

### Daten-Hygiene

- `artifacts/personal/*` ist .gitignore'd. Tokens nicht mehr im Repo.
- Daten via borg auf Hetzner Storage Box gesichert (daily/weekly/monthly).
- Secrets ausschließlich in `~/.config/openclaw/env`.

### Postgres-User-Modell (Stand 2026-05-11)

EINE Instanz `n8n-docker-postgres-1`, zwei DBs.
- **n8n:** Bootstrap-Superuser, nur für pg_dump
- **n8n_app:** App-User für n8n-Service, nur Rechte auf n8n-DB
- **openclaw:** App-User für Core, nur Rechte auf openclaw_core
- **postgres:** Notfall-Superuser (Maintenance), Passwort in 1P

Regel: `n8n_app` niemals GRANT auf `openclaw_core` geben. Smoke-Test prüft das (`scripts/smoke-test.ts`, Check 14+15).

### Token Guardian (Sprint 3)

- n8n-Workflow `instagram-token-health-daily` (Cron daily 08:00 UTC)
- Core-Endpoints: `GET /api/instagram/token-health`, `POST /api/instagram/token-refresh`
- Auth: Bearer `CORE_SERVICE_TOKEN` (in `~/.config/openclaw/env`)
- nginx-Routing: `/api/instagram/(token-health|token-refresh)` → Core (18789)

### Instagram Status-Enum (Sprint 3)

`draft` | `review` | `approved` | `published` | `archived`

### Withings Sync (Sprint 4)

- n8n-Workflow `health-withings-sync-daily` (Cron daily 07:00 UTC)
- Core-Endpoints: `POST /api/health/withings-sync`, `GET /api/health/sync-status`
- Auth: Bearer `CORE_SERVICE_TOKEN`
- nginx-Routing: `/api/health/(withings-sync|sync-status)` → Core (18789)
- Sync-Lock: `pg_advisory_lock(42)` / `pg_advisory_unlock(42)` — verhindert parallele Syncs
- Retry-on-401: Single-Refresh-Attempt, dann Fatal-Error mit Telegram-Notify
- Token-Rotation: Transaction (UPDATE active=false, INSERT new active=true)

### SharePoint Sync (Sprint 10)

- DB-Tabellen: `sharepoint_files` (12.088 Einträge), `sharepoint_sync_runs`
- Sync-Lock: `pg_advisory_lock(44)` / `pg_advisory_unlock(44)` — session-level, `finally`-Block
- Canonical Key: `sp_item_key = ${siteId}::${driveId}::${path}` (identisch mit `entity_links.sp_item_id`)
- Soft-Delete: `missing_since` Timestamp; Hard-Delete via `cleanup-missing` (Sprint 11.6)
- Suche: `search_haystack` generated column + GIN trgm Index (ILIKE per Term, AND-Verknüpfung)
- Kein JSON mehr: Legacy `sharepoint-index.json` + 2 Snapshots archiviert (Sprint 11.2/11.6)
- Core-Endpoints (Bearer `CORE_SERVICE_TOKEN`):
  - `GET /api/sharepoint/sites` — Sites mit File-Count
  - `GET /api/sharepoint/drives/:siteId` — Drives für Site
  - `GET /api/sharepoint/files/:siteId/:driveId` — Files mit Pagination
  - `GET /api/sharepoint/search?q=` — pg_trgm Suche
  - `POST /api/sharepoint/upsert-uploaded` — Einzel-File nach Upload
  - `GET /api/sharepoint/default-site` — resolves default site+drive from `system_settings.sp_default_site_id`, validates against `sharepoint_files`, fallback to first site (Sprint 11.4)
  - `POST /api/sharepoint/cleanup-missing?dry_run=true|false` — Hard-Delete missing >30d (Sprint 11.6)
    Safety: 2x-Sync-Schutz, NOT EXISTS entity_links, LIMIT 50, Telegram-Notify.
    Phase 1: Dry-Run only. Phase 2 bedingt an 3 synthetische Tests (siehe Runbook).
- Import-Script: `npx tsx src/modules/sharepoint/import-sprint10.ts` (one-shot, nicht im Boot)
- Polling entfernt (30-min setInterval aus commands.ts gelöscht, Q2-Entscheidung)

### Banking Session Reuse (Sprint 2.10-A)

- DB-Tabellen: `banking_institutions`, `banking_sessions`, `banking_accounts`, `banking_pending_challenges`, `banking_sync_reminders` (V027-V029)
- Session-Reuse: `decideReuse()` in store.ts findet existierende Session mit gültigem encrypted State
  - Kriterien: `session_format = 'fints5'`, `last_success_at < 30d`, `session_expires_at > NOW()`, User-Match (decrypt + timingSafeEqual)
  - Decrypt-Failure-Policy: `markSessionStateInvalid()` (last_success_at = NULL) + Audit, nächste Candidate
- Advisory-Lock: `pg_advisory_lock(46, hash(userId:institutionId))` — serialisiert parallele decideReuse-Calls
- Encryption: AES-256-GCM, Key aus `BANKING_ENCRYPTION_KEY` (64 hex), AAD = sessionId + field-name
- Sidecar: Python FastAPI (`~/openclaw-banking-fints`, Port 18794), python-fints Library
  - `from_data` restauriert BPD/UPD/TAN-Mechanismus aus `client_data_b64`
  - WICHTIG: `fetch_tan_mechanisms()` bei Reuse NICHT aufrufen (setzt blind '999', Etappe g)
  - Parked-Client-Pattern für decoupled pushTAN (3955/3956)
- Log-Redaction: `redactClientData()` in sidecar-client.ts — redacts `client_data`/`client_data_b64` in connect request/response logs
- Core-Endpoints (Bearer `CORE_SERVICE_TOKEN`):
  - `POST /api/banking/connect` — Dashboard-Flow (blz/user_id/pin) oder Telegram-Flow (session_id)
  - `POST /api/banking/complete-tan` — TAN-Eingabe
  - `GET /api/banking/institutions` — Institutionen-Liste
  - `GET /api/banking/accounts` — Konten-Liste
  - `GET /api/banking/accounts/:id/transactions` — Umsätze
  - `DELETE /api/banking/session/:id` — Sidecar-Session cancel (fire-and-forget)

### Settings (Sprint 11)

- DB-Tabelle: `system_settings` (key TEXT PK, value JSONB)
- `loadSettings()` liest sync aus In-Memory-Cache (populiert beim Boot)
- `setSetting(key, value)` schreibt atomar in DB (UPSERT + audit_log in einer Transaktion)
- Cache-Refresh: Hintergrund-Intervall alle 60s
- WARNUNG: Cache ist prozesslokal (Single-Process). Bei mehreren Instanzen Cache-Drift moeglich.
- Key-Convention: snake_case im DB (`briefing_time`), camelCase im TS-Interface (`briefingTime`)
- `sp_default_site_id` als Seed fuer Etappe 4 (Dashboard Site-Resolution)

### Schema-Migration-Konvention (Sprint 11.5)

**Dual Pattern:**

1. **V-Prefix (`Vxxx__name.sql`):** One-Shot-Migrationen mit Daten-Import via `migrate-sprintX` / `migrate-vXXX`-Skripte.
   Manuell ausgeführt (`bun run scripts/migrate-*.ts --apply`). Enthalten DDL + DML (Tabellen + Daten).
   Schema-Version wird vom Skript oder nachtraeglich in `schema_version` eingetragen.

2. **0xx-Prefix (`0xx_name.sql`):** Boot-Time-DDL-only via `runMigrations()` in `src/shared/db/index.ts`.
   Idempotent (`IF NOT EXISTS`), automatisch bei jedem Gateway-Start. Nur DDL, keine Daten.

**Migrate-Skripte (One-Shot, manuell):**

| Skript | Modul | Versions |
|--------|-------|----------|
| `scripts/migrate-sprint3-instagram.ts` | instagram | 020_insta_tables.sql |
| `scripts/migrate-sprint4-health.ts` | health | V021 |
| `scripts/migrate-sprint5-assets.ts` | assets | V022, V023, V024 |
| `src/modules/fleet/migrate-v025.ts` | fleet | V025 |
| (manual) | fleet | V026__fleet_tire_sets.sql |
| `src/modules/banking/migrate-v027.ts` | banking | V027, V028, V029 |
| `src/modules/assets/migrate-v030.ts` | assets | V030 |
| `src/modules/assets/migrate-v031.ts` | assets | V031 |
| (manual) | assets | V036__properties_polish_fields.sql |
| (manual) | fleet | V037__vehicles_fuel_type.sql |
| (manual) | instagram | V037_insta_media_edits.sql |
| `scripts/migrate-sprint8-location.ts` | location | V032 |
| `scripts/migrate-sprint9-links.ts` | links | V033 |

**Boot-Time-Migrationen (automatisch via `runMigrations()`):**

| Aufruf in index.ts | Modul | Versions |
|---------------------|-------|----------|
| `src/shared/migrations` | shared | 001 |
| `src/shared/settings/migrations` | settings | 035 |
| `src/modules/executive/migrations` | executive | 001 |
| `src/modules/location/migrations` | location | 032 |
| `src/modules/links/migrations` | links | 033 |
| `src/modules/sharepoint/migrations` | sharepoint | 034 |

**DR-Pfad:** `pg_dump --format=custom` als Wahrheits-Quelle, unabhaengig vom Migration-Runner.
Borg-Backup sichert den Dump taeglich.

**Drift-Detector:** `npm run verify-schema` (`scripts/verify-schema-versions.ts`).
Vergleicht SQL-Files auf Disk mit `schema_version`-Tabelle. Exit 0 = clean, Exit 1 = drift.
**Sprint-Cut-Checkliste:** Drift-Detector mit Exit 0 ist Pflicht vor jedem Commit/Release.

### Offene TODOs

- ~~n8n-Postgres separat im Borg-Backup (Spec §15.4)~~ — erledigt 2026-05-11
- ~~Helper-Endpoint POST /api/internal/notify~~ — erledigt 2026-05-11
- ~~Spec V3 §3 erweitern um 5 neue Module~~ — erledigt 2026-05-11 (v3.1)
- ~~Sprint 3 Instagram auf Postgres~~ — erledigt 2026-05-12
- ~~Sprint 4 Health auf Postgres~~ — erledigt 2026-05-12
- ~~Sprint 5.5a Asset CRUD + NK PreCheck~~ — erledigt 2026-05-12
- ~~Sprint 5.5b NK-Engine + PDF V1.3~~ — erledigt 2026-05-13
- ~~Sprint 10 SharePoint Postgres~~ — erledigt 2026-05-16
- ~~Sprint 11 Closure + Housekeeping~~ — erledigt 2026-05-17 (7 Etappen, 28/28 Smoke)
- Etappe n (Real-Test L19 2024): wartet auf L19 Datenpflege
- SP Hard-Delete Phase 2: 3 synthetische Tests Pflicht VOR n8n-Workflow auf `dry_run=false` (siehe Runbook)
- n8n-Workflow `nk-obligations-alert-daily` anlegen (Cron 07:00 → POST /api/assets/nk-trigger/obligations-alert)
- Optional: Meta-Token rotieren (User-Entscheidung)
- Bekannt: `bun test` Parallelismus-Problem (POSTGRES_URL Konflikte zwischen Test-Dateien) — einzeln grün
- **Callback-Prefix-Liste (E4):** `before_agent_start` in index.ts unterdrückt LLM für Telegram-Callback-Buttons.
  Bekannte Prefixes: `icraft_`, `iscan_`, `isub_`, `segdel_`, `booking_`, `bsync_`. Bei neuem Callback-Prefix hier UND in
  `CALLBACK_PREFIXES` (index.ts, before_agent_start) ergänzen.
- ~~**TD-3:** Sidecar (`~/openclaw-banking-fints`) hat kein GitHub-Remote. Lokaler Commit only. Sprint 2.10-F Backlog.~~ Erledigt 2026-06-25: `biko007/openclaw-banking-fints-private.git`, 5 Commits gepusht.

### Sprint-Roadmap

| Sprint | Inhalt | Status |
|--------|--------|--------|
| 1 | Plattform-Hardening | abgeschlossen |
| 2 | Code-Refactor | abgeschlossen |
| 3 | Instagram Postgres | abgeschlossen |
| 4 | Health Postgres | abgeschlossen |
| 5.5a | Asset CRUD + NK PreCheck | abgeschlossen |
| 5.5b | NK-Engine + PDF V1.3 | abgeschlossen (Etappe n pending) |
| 10 | SharePoint Postgres (pg_trgm, soft-delete, V034) | abgeschlossen |
| 11 | Closure + Housekeeping (7 Etappen, V035) | abgeschlossen |
| 2.10-A | Banking Session Reuse (5 Etappen, 71 Tests, E2E KSK) | abgeschlossen |
| 6 | Fleet auf Postgres | offen |
| 7a | Banking-CSV | offen |

### Lessons

- **Postgres-Bootstrap-User:** `ALTER ROLE n8n NOSUPERUSER` → `permission denied to alter role`.
  Lösung: separater App-User `n8n_app` mit GRANT-Modell. Smoke-Test verhindert Rückfall.
- **python-fints fetch_tan_mechanisms() bei Reuse:** `fetch_tan_mechanisms()` setzt blind
  `set_tan_mechanism('999')`. Bei `from_data`-Restore mit bestehendem `system_id` wird
  `_ensure_system_id()` zum No-Op → kein Server-Roundtrip korrigiert den Mechanismus →
  `KeyError: '999'`. Fix: Skip bei Reuse — TAN-Mechanismus kommt aus dem gespeicherten State.
- **Mock-Sidecar ≠ Library-Edge-Cases:** Bun.serve()-Mocks validieren HTTP-Contract, fangen
  aber keine Library-Interaktions-Bugs. E2E gegen echte Bank ist unersetzlich für FinTS.

## Telegram-Notify aus Skripten/Claude Code

```bash
~/.scripts/notify 'Nachricht' [info|warn|error]
```

Endpoint: `POST /api/internal/notify` (localhost only, nginx-Whitelist).
Body: `{ "message": "...", "severity": "info"|"warn"|"error" }`

## Architektur-Disziplin (Manifest)

Diese Regeln stehen über allem, was in Implementierungs-Sessions vorgeschlagen wird:

1. **Eine Schraube pro Sprint.** Niemals zwei Module gleichzeitig migrieren.
2. **n8n bleibt dumm.** n8n macht nur Trigger + Routing, keine Business-Logik. n8n ruft dedizierte, Bearer-`CORE_SERVICE_TOKEN`-geschützte Core-Endpoints auf (z.B. `/api/internal/banking/*`, `/api/sharepoint/cleanup-missing`, `/api/health/*`, `/api/instagram/*`). Der Core bindet ausschließlich auf `127.0.0.1`; `/api/internal/*` ist zusätzlich per nginx-IP-Whitelist (127.0.0.1) abgesichert. Es gibt KEINE Linter-Regel für Routen — ESLint erzwingt nur Modul-Grenzen (`no-deep-module-import`).
3. **Modul-Grenzen sind heilig.** ESLint erzwingt — nicht Disziplin.
4. **Backup-Restore vor Backup-Schreiben.** Jedes neue Backup-Ziel: erst Restore-Test.
5. **Tests für Geld.** Alles, was IBANs oder Posts ins Internet schickt, hat Tests.
6. **Audit-Log ist Pflicht.** Wer hat was wann geändert? Immer beantwortbar.
7. **Klein anfangen, groß denken.** Modularer Monolith jetzt — Microservices wenn Wartung wehtut.
8. **Idempotency vor Side-Effects.** Jeder externe Call braucht einen Idempotency-Key.
9. **Sensitive Daten klassifiziert.** Nie in Logs, callback_data oder n8n-Logs.
10. **Auto-Rollback im Deploy.** Jedes Deploy-Skript prüft sich selbst.
11. **Human-Reviewability (Hard Rule).** All code must be traceable by a human reviewer: descriptive names instead of cryptic identifiers; comments explain the *why* for non-obvious logic (triggers, guards, security paths); no clever one-liners where a readable form exists; one commit per etappe, never bundled. No code goes to `origin` unreviewed.

## Projekt

OpenClaw Executive Agent (Telegram Bot) auf Hetzner VPS (CCX33, Helsinki).
User: `biko` | IP: `46.62.153.181` | Tailscale: `100.121.45.4`
Dashboard: `https://app.bikobickel.de/dashboard/?token=<DASHBOARD_TOKEN>`
Location-API: `https://app.bikobickel.de/location` (POST, Bearer-Auth)

## Starten

```bash
claude --allowedTools "Write,Edit,Bash,Read"
```

## Wichtige Pfade

```
Hauptdatei:   index.ts  (einzige Quelle aller Plugin-Logik)
Build-Output: dist/index.js  (NICHT manuell bearbeiten)
Secrets:      ~/.config/openclaw/env
Daten:        ~/.openclaw/workspace/artifacts/personal/
```

## Datenschicht

```
travel-store.ts     Trips + Segmente
assets-store.ts     Immobilien, Units, Mietverträge, NK-Abrechnung
fleet-store.ts      Fuhrpark, Service, TÜV, Versicherung
sharepoint-store.ts SP Graph-API Helpers (listSites, listDrives, crawlFolder)
src/modules/sharepoint/store.ts    SP fullSync, UPSERT, markMissingSince (Postgres-backed, Sprint 10)
src/modules/sharepoint/queries.ts  SP searchFiles (pg_trgm), listSites/Drives/Files (Postgres-backed)
src/modules/sharepoint/routes.ts   SP HTTP-API für Dashboard-Proxy (Sprint 10)
src/modules/sharepoint/key.ts      buildSpItemKey() — canonical key builder
link-store.ts       Entity-Dokument-Verknüpfungen
src/modules/instagram/store.ts  Instagram Business API, Drafts, Tokens, Style (Postgres-backed)
src/modules/health/store.ts     Gewicht, Schlaf, Trends, Alerts (Postgres-backed)
src/modules/health/withings.ts  Withings OAuth2 + API, Tokens (Postgres-backed)
src/modules/nk/engine.ts       NK-Berechnung: computeNk(), Personentage, Pro-Rata, HeizKV (Postgres-backed)
src/modules/nk/heating.ts      HeizKV §7/§8/§9, Method A/B, Verbrauchsberechnung
src/modules/nk/snapshot.ts     Snapshot Build + Read/Write (gzip, SHA-256)
src/modules/nk/routes.ts       NK HTTP-Endpoints (Preview, Finalize, Serve, Re-Render)
src/modules/nk/pdf-template.ts Handlebars HTML-Template für NK-Abrechnungen
src/modules/nk/alerts.ts       §556-Fristüberwachung + Telegram-Alerts
src/modules/nk/precheck.ts     nkPreCheck() — 11 Blocker-Checks vor Berechnung
src/pdf-worker.ts              Standalone PDF-Worker (Playwright Chromium)
```

## Datenpfade

```
Trips:       artifacts/personal/travel/<trip-id>.json
Health:      Postgres health_logs, health_withings_tokens (Sprint 4)
Settings:    artifacts/personal/health/settings.json (inkl. Standort)
Loc-History: Postgres location_entries (Sprint 8), Legacy: archived (Sprint 11.6)
Fleet:       artifacts/personal/fleet/vehicles.json
Assets:      artifacts/personal/assets/properties.json
             artifacts/personal/assets/leases.json
             artifacts/personal/assets/operating-costs/<id>-<year>.json
Bilder:      artifacts/personal/images/<entityType>-<entityId>.jpg
Mail-Parse:  artifacts/personal/mail-parsing/processed.json
Links:       Postgres entity_links (Sprint 9), Legacy: archived (Sprint 11.6)
SP-Index:    Postgres sharepoint_files (Sprint 10), Legacy: archived (Sprint 11.6)
Drafts:      artifacts/personal/mail-drafts/<id>.json
Instagram:   Postgres insta_drafts, insta_tokens, insta_style_profile (Sprint 3)
             artifacts/personal/instagram/insights-cache.json  (File)
             artifacts/personal/instagram/media-cache.json     (File)
             artifacts/personal/instagram/content-calendar.json (File)
NK-Snapshots: artifacts/personal/nk-snapshots/<run_id>.json.gz (Sprint 5.5b)
NK-PDFs:      artifacts/personal/nk-statements/<PROP_CODE>/<YEAR>/run-<RUN_ID>/<lease-ID|owner>.pdf
```

## Netzwerk / nginx

```
Alle externen Endpoints laufen über nginx + Let's Encrypt SSL (app.bikobickel.de:443).
Kein Service bindet extern — alles auf 127.0.0.1, nginx proxied:

  /dashboard/*                          → 127.0.0.1:18800  (Dashboard)
  /location                             → 127.0.0.1:18790  (Location-API, POST)
  /withings/*                           → 127.0.0.1:18789  (Withings Callback, via Legacy-Config)
  /api/instagram/token-health           → 127.0.0.1:18789  (Token Guardian, Sprint 3)
  /api/instagram/token-refresh          → 127.0.0.1:18789  (Token Guardian, Sprint 3)
  /api/health/withings-sync             → 127.0.0.1:18789  (Withings Sync, Sprint 4)
  /api/health/sync-status               → 127.0.0.1:18789  (Sync Status, Sprint 4)

nginx-Config:   /etc/nginx/sites-enabled/openclaw.conf (konsolidiert)
Cert:           Let's Encrypt (auto-renew via certbot)
Reload:         sudo nginx -t && sudo systemctl reload nginx
```

## Deployment

```bash
npm run build
systemctl --user restart openclaw-gateway.service
systemctl --user restart openclaw-pdf-worker.service
systemctl --user status openclaw-gateway.service --no-pager
systemctl --user status openclaw-pdf-worker.service --no-pager
journalctl --user -u openclaw-gateway.service -n 20 --no-pager
bun run scripts/smoke-test.ts
```

Nach jedem Build + Restart IMMER `bun run scripts/smoke-test.ts` ausführen.
Bei Exit-Code 1: Deployment als fehlgeschlagen betrachten,
Fehler beheben bevor "Erledigt" gemeldet wird.

## CI-Tests — MUSS GRÜN BLEIBEN

```bash
npm test   # bun test — 345 test blocks über 34 Dateien
```

**Hinweis:** Paralleler `bun test` hat ein bekanntes Problem: mehrere Test-Dateien ändern
`POSTGRES_URL` (eigene Test-DB), was bei Parallelisierung Konflikte verursacht. Alle 345 Tests
sind grün wenn sie einzeln/sequenziell laufen.

**Pflicht-Tests (Spec §17):**
- `src/modules/instagram/__tests__/approval-hard-rule.test.ts` — Spec §17.2
  Prüft: Draft ohne Freigabe kann NICHT veröffentlicht werden.
  NIEMALS löschen oder deaktivieren. Nutzt echte Postgres-Test-DB.
- `src/modules/instagram/__tests__/insta-store-db.test.ts` — Sprint 3 §6.1
  Prüft: Roundtrip insert → load → update → filter gegen echte Postgres-DB.
- `src/modules/health/__tests__/health-store-db.test.ts` — Sprint 4 §5
  Prüft: Health-Entry Roundtrip (weight, sleep, steps, heartrate, alerts) gegen echte Postgres-DB.
- `src/modules/executive/__tests__/health-monitor.test.ts`
  Prüft: Alert-Throttling für Service-Monitoring.
- `src/modules/nk/__tests__/engine.test.ts` — Sprint 5.5b §11
  Prüft: 6 Goldfile-Szenarien, 11 Blocker-Tests, Personentage, Vorauszahlung.
- `src/modules/nk/__tests__/e2e-lifecycle.test.ts` — Sprint 5.5b §11
  Prüft: Preview → Finalize → Snapshot → Re-Render → Serve → Lock → Version-Cascade.
- `src/modules/assets/__tests__/bulk-readings.test.ts` — Sprint 11.1
  Prüft: Atomicity (BEGIN/COMMIT), Idempotency-Replay, Audit innerhalb TX, Pool-Release.
- `src/modules/banking/__tests__/etappe-2.10a.test.ts` — Sprint 2.10-A
  Prüft: findReusableSession (9 Tests: happy path, user-mismatch, expired, stale, format-mismatch,
  multi-candidate, decrypt-failure + invalidation, roundtrip, all-decrypt-fail → fresh).
- `src/modules/banking/__tests__/etappe-2.10b.test.ts` — Sprint 2.10-A
  Prüft: clientDataB64 passthrough (8 Tests: sidecar connect with/without b64, redactClientData,
  initiateConnect passthrough, E2E state persistence, log-redaction spy).
- `src/modules/banking/__tests__/etappe-2.10c.test.ts` — Sprint 2.10-A
  Prüft: decideReuse + advisory-lock (7 Tests: fresh/reuse modes, lock release, concurrency).

**Vor jedem Merge: `npm test` MUSS grün sein.**

## Grundregeln

- Git Snapshot VOR jeder Änderung
- Keine Secrets in Code oder Chat
- Nach Abschluss: alle drei Repos committen + pushen
- Rollback: `git log --oneline -5` dann `git checkout <hash> -- index.ts`
- Keine Services auf 0.0.0.0 binden — immer 127.0.0.1, nginx proxied extern

## Git-Commit am Ende

Alle Änderungen committen und pushen — alle drei Repos (Agent, Dashboard, Parent). Dann `git status` zeigen.

## Standort-Fallback

```typescript
const DEFAULT_LOCATION = { lat: 47.9838, lon: 8.8234, label: "Tuttlingen" };
```

Dynamisch: `settings.json` → `location` (via Telegram Location Message oder POST /location)

## Laufende Arbeiten
<!-- Hier aktuelle Session-Aufgaben festhalten damit Claude Code nach
Reconnect den Kontext findet -->

Sprint 1 + 2 + 3 + 4 + 5.5a + 5.5b + 10 + 11 + 2.10-A vollständig abgeschlossen (2026-05-20). Details siehe "Stand" oben.
Banking Tests: 71/71 PASS (Agent 35 + Sidecar 36). E2E: KSK Tuttlingen HAPPY PATH (Tag `2.10-a-e2e-passed`).
Archive: 6× Instagram-Drafts, history.jsonl, links.json, 3× sharepoint-index in `archive/`.
Nächste Schritte: Sprint 2.10 Backlog (B/C/E), Etappe n (L19 Datenpflege).
SP Hard-Delete Phase 2 wartet auf 3 synthetische Tests (siehe Runbook).

## Role

You are the engineering partner for the OpenClaw Executive System.
The operator is Juergen Bickel — non-technical, works exclusively via
Claude and Claude Code. Your counterpart is not a developer.

System: Private executive agent "Hans_Dampf" running on a Hetzner VPS
(Helsinki). Single-user, production system, always-on.

Your job: Design, implement, debug and extend OpenClaw. Translate
operator intent into production-grade code. Own the technical decisions.
Flag risks before implementing. Never wait for permission to apply
engineering best practices.

## System Topology

- VPS: Hetzner Helsinki, Ubuntu 24.04, User: biko
- Services: openclaw-gateway (18789), openclaw-dashboard (18800),
  openclaw-pdf-worker, openclaw-trading (18793), ibgateway (7497), xvfb (:1)
- Reverse Proxy: nginx → app.bikobickel.de
- Runtime: Node.js/TypeScript, Bun
- Secrets: ~/.config/openclaw/env
- Git: 3 Repos (workspace, executive-agent, executive-dashboard)

## Plan Mode

- Bei komplexen Aufträgen (>3 Dateien oder neue Features): IMMER Plan Mode verwenden — kein direktes Implementieren ohne Review
- Plan Mode aktivieren: `Shift+Tab` zweimal drücken vor der Eingabe
- Ausnahmen: triviale Edits (Config, Token), Bug-Fixes mit klarer Diagnose

## Engineering Principles

- Minimale, inkrementelle Änderungen — keine unrelated Refactors
- Ein logischer Schritt pro Auftrag
- Production-grade Code — keine Platzhalter, kein Pseudo-Code
- Explizites Error-Handling, keine hidden Side Effects
- Secrets immer aus ~/.config/openclaw/env — nie hardcoded, nie geloggt
- Bestehende Architektur erhalten — neue Patterns nur wenn klar begründet

## Task Output Protocol (mandatory — cc and Codex)

- Every cc/Codex task writes its complete result to ONE timestamped file:
  cc → `~/bikosoc-spec/<task>.md`, Codex → `~/codex-audit/bikosoc/<date>-<type>.md`.
- Terminal output is ONLY: `DONE → <path>`. No result content, no diffs, no logs to stdout.
- Owner uploads the FILE for review — never raw terminal scrollback.
- Secrets NEVER go to stdout, logs, or report files. If a secret must be handed over:
  write it to a chmod-600 temp file (or 1Password/op), reference the path, shred after use.

## Alpine CSP Hard Rules (gilt für alle Dashboard-JS-Files)

1. **x-if Template: EXAKT 1 direktes Kind-Element** (Single-Root-Constraint).
   Mehrere Siblings → in Wrapper-Div einschließen.
2. **x-show/x-text/x-if: keine &&/||/+/Regex/Globals** (Number, Date, Array-Methods).
   Alles via Alpine-Methods auslagern.
3. **Kein `<style>`-Block im Template-String.**
4. **Vor jedem Dashboard-Commit prüfen:**
   `grep -n "x-if" public/js/*.js` → jede x-if auf Single-Root prüfen.

## Debugging

- Hypothesen nach Wahrscheinlichkeit geordnet
- Konkrete Check-Befehle, Schritt für Schritt einengen
- Keine voreiligen Schlüsse

## Push Back wenn

- Unnötige Komplexität eingeführt würde
- Eine einfachere Lösung existiert
- Widerspruch zu bestehenden Architektur-Entscheidungen

## Naming Conventions (PFLICHT — gilt für alle Entities)

Alle IDs und Dateinamen starten mit YYMMDD.

### IDs

Format: `YYMMDD-<subject>-<location>`

Kontext = erster bedeutsamer Begriff aus: Ort, Anlass, Thema, Caption, Titel.
Kleinbuchstaben, nur a-z und Bindestriche, max 30 Zeichen gesamt.

Beispiele:
- `260506-sub-sannicandro`   (Instagram Submission)
- `260506-insta-solaredge`   (Instagram Draft)
- `260415-trip-barcelona`    (Reise)
- `260304-fleet-service`     (Fuhrpark-Eintrag)
- `260101-lease-mueller`     (Mietvertrag)

Fallback wenn kein Kontext: `YYMMDD-<prefix>`
Niemals: zufällige Zeichenketten, reine Timestamps, UUIDs oder andere
nicht-lesbare Formate.

### Dateinamen (PFLICHT)

Format: `YYMMDD-<kontext>-<nummer>.<ext>`

Beispiele:
- `260509-jb-01.jpg`   (erste Datei in Session)
- `260509-jb-02.mp4`   (zweite Datei)
- `260506-sub-strand-01.jpg` (Submission-Bild)

Nummerierung in Upload-Reihenfolge, zweistellig (01, 02, ...).
Niemals: Hashes, UUIDs, Timestamps allein, Telegram-interne Dateinamen
(z.B. `file_60---AgACAgIAAxkDAAIC.jpg`).

## Trading Safety

- Paper Trading Account: DUP514636 — kein echtes Geld
- Live Trading nur nach expliziter schriftlicher Freigabe durch Operator
- Kill-Switch (/tradekill) hat immer höchste Priorität
