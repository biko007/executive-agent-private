# OpenClaw Executive Agent — Infra-Referenz

Detaillierte Infra-Daten: nginx-Routing, Datenpfade, Deployment, Standort.
Kurzüberblick: CLAUDE.md §2. Shared-Infra (VPS, Postgres, MinIO): docs/SHARED_PLATFORM.md.

---

## Netzwerk / nginx

Alle externen Endpoints laufen über nginx + Let's Encrypt SSL (app.bikobickel.de:443).
Kein Service bindet extern — alles auf 127.0.0.1, nginx proxied:

```
/api/internal/*                       → 127.0.0.1:18789  (Gateway, localhost-only deny all)
/api/                                 → 127.0.0.1:18800  (Dashboard, Catch-All)
/dashboard/*                          → 127.0.0.1:18800  (Dashboard)
/location                             → 127.0.0.1:18790  (Location-API, POST)
/withings/callback                    → 127.0.0.1:18789  (Withings OAuth — Handler fehlt, F-009)
/oura/callback                        → 127.0.0.1:8081   (Oura OAuth, direkt zum temp-server)
/n8n/                                 → 127.0.0.1:5678   (n8n Web-UI)
```

Reihenfolge: spezifischere Locations (internal) VOR dem /api/ Catch-All.
Dashboard proxied Modul-Routen (/api/health/*, /api/assets/*, etc.) intern an Core 18789
weiter (Double-Hop mit Bearer CORE_SERVICE_TOKEN).

**Tote Routen via nginx (Dashboard hat keinen Handler, nur direkt auf 18789 erreichbar):**
```
POST /api/health/withings-sync       — n8n-Caller deaktiviert
GET  /api/health/sync-status         — kein externer Caller
```

Backlog: Single-Hop-Optimierung (nginx → Gateway direkt) optional, funktioniert via Double-Hop.

```
nginx-Config:   /etc/nginx/sites-enabled/openclaw.conf (konsolidiert)
Cert:           Let's Encrypt (auto-renew via certbot)
Reload:         sudo nginx -t && sudo systemctl reload nginx
```

---

## Datenpfade (verifiziert 2026-07-20)

```
Trips:        artifacts/personal/travel/<trip-id>.json  (JSON)
Health:       Postgres health_logs, health_withings_tokens, health_oura_tokens
Settings:     Postgres system_settings (V035) — PRIMÄR
              artifacts/personal/health/settings.json — READ-ONLY FALLBACK, NICHT SCHREIBEN
Loc-History:  Postgres location_events (V032); Legacy: archived (Sprint 11.6)
Fleet:        artifacts/personal/fleet/vehicles.json  (JSON — Sprint 6 offen)
Assets:       Postgres properties/units/leases/... (V022-V024) — PRIMÄR
              artifacts/personal/assets/properties.json — ARCHIVED, NICHT SCHREIBEN
              artifacts/personal/assets/leases.json — ARCHIVED, NICHT SCHREIBEN
              artifacts/personal/assets/operating-costs/<id>-<year>.json — ARCHIVED, NICHT SCHREIBEN
Bilder:       artifacts/personal/images/<entityType>-<entityId>.jpg  (JSON/File)
Mail-Parse:   artifacts/personal/mail-parsing/processed.json  (JSON)
Links:        Postgres entity_links (V033); Legacy: archived (Sprint 11.6)
SP-Index:     Postgres sharepoint_files (V034); Legacy: archived (Sprint 11.6)
Drafts:       artifacts/personal/mail-drafts/<id>.json  (JSON)
Instagram:    Postgres insta_drafts, insta_tokens, insta_style_profile (Sprint 3)
              artifacts/personal/instagram/insights-cache.json  (File, Cache only)
              artifacts/personal/instagram/media-cache.json     (File, Cache only)
              artifacts/personal/instagram/content-calendar.json (File, Cache only)
NK-Snapshots: artifacts/personal/nk-snapshots/<run_id>.json.gz  (Sprint 5.5b)
NK-PDFs:      artifacts/personal/nk-statements/<PROP_CODE>/<YEAR>/run-<RUN_ID>/<lease-ID|owner>.pdf
Memory:       Postgres conversation_log, owner_memory (V041/V042)
```

---

## Datenschicht (Store-Dateien)

```
travel-store.ts         Trips + Segmente
assets-store.ts         Immobilien, Units, Mietverträge, NK-Abrechnung (ARCHIVED JSON, neu: Postgres)
fleet-store.ts          Fuhrpark, Service, TÜV, Versicherung (JSON)
sharepoint-store.ts     SP Graph-API Helpers (listSites, listDrives, crawlFolder)
src/modules/sharepoint/store.ts    SP fullSync, UPSERT, markMissingSince (Postgres)
src/modules/sharepoint/queries.ts  SP searchFiles (pg_trgm), listSites/Drives/Files (Postgres)
src/modules/sharepoint/routes.ts   SP HTTP-API für Dashboard-Proxy
src/modules/sharepoint/key.ts      buildSpItemKey() — canonical key builder
link-store.ts           Entity-Dokument-Verknüpfungen (ARCHIVED JSON, neu: Postgres)
src/modules/instagram/store.ts     Instagram Business API, Drafts, Tokens, Style (Postgres)
src/modules/health/store.ts        Gewicht, Schlaf, HRV, Readiness, Trends, Alerts (Postgres)
src/modules/health/withings.ts     Withings OAuth2 + API, Tokens (Postgres) — weight-only
src/modules/health/oura.ts         Oura Ring OAuth2 + API v2, Tokens (Postgres) — primary health
src/modules/nk/engine.ts          NK-Berechnung: computeNk(), Personentage, Pro-Rata, HeizKV
src/modules/nk/heating.ts         HeizKV §7/§8/§9, Method A/B, Verbrauchsberechnung
src/modules/nk/snapshot.ts        Snapshot Build + Read/Write (gzip, SHA-256)
src/modules/nk/routes.ts          NK HTTP-Endpoints (Preview, Finalize, Serve, Re-Render)
src/modules/nk/pdf-template.ts    Handlebars HTML-Template für NK-Abrechnungen
src/modules/nk/alerts.ts          §556-Fristüberwachung + Telegram-Alerts
src/modules/nk/precheck.ts        nkPreCheck() — 11 Blocker-Checks vor Berechnung
src/pdf-worker.ts                  Standalone PDF-Worker (Playwright Chromium)
```

---

## Deployment

```bash
# Standard-Deploy (gateway — Default):
scripts/deploy.sh

# Mehrere Services:
scripts/deploy.sh openclaw-gateway openclaw-pdf-worker

# Dashboard oder Trading (nur wenn explizit gewünscht):
scripts/deploy.sh openclaw-dashboard
scripts/deploy.sh openclaw-trading
```

Das Skript (`scripts/deploy.sh`) führt automatisch durch:
1. **Dirty-Tree-Check** — Abbruch bei uncommittierten Änderungen (tracked files)
2. **Build** — `npm run build` pro betroffenem Build-Dir; für executive-agent zusätzlich `verify:commands` + `npm test`
3. **Restart** — `systemctl --user restart` NUR für benannte Services
4. **Health-Check** — `systemctl --user is-active` + Port antwortet (`curl` HTTP-Code ≠ 000)
5. **Smoke-Test** — `bun run scripts/smoke-test.ts` (exit 0 = ALL PASS erforderlich)
6. **Erfolg** → Marker `~/.deploy-markers/.deploy-last-good-<service>` mit Deploy-SHA; Telegram „DEPLOY OK"
7. **Fehler** → Auto-Rollback auf LAST_GOOD: `git checkout $LAST_GOOD -- .` (nur Arbeitsbaum), rebuild, restart; Telegram „ROLLBACK auf <sha>" oder „ROLLBACK FAILED = ALARM"

Exit-Codes: `0` = OK, `1` = Deploy fehlgeschlagen (Rollback OK), `2` = Rollback fehlgeschlagen (Alarm).

Rollback (manuell): `git revert <commit>`; bei Migrationen zusätzlich Migrations-Runbook konsultieren.

---

## Standort-Fallback

```typescript
const DEFAULT_LOCATION = { lat: 47.9838, lon: 8.8234, label: "Tuttlingen" };
```

Dynamisch: Postgres `system_settings` → `location` (via Telegram Location Message oder POST /location).
Fallback-Kette: system_settings → location_events (letzter Eintrag) → DEFAULT_LOCATION.

---

## Telegram-Notify aus Skripten/Claude Code

```bash
~/.scripts/notify 'Nachricht' [info|warn|error]
```

Endpoint: `POST /api/internal/notify` (localhost only, nginx-Whitelist).
Body: `{ "message": "...", "severity": "info"|"warn"|"error" }`

---

## Claude Code Hooks

Versioniert in `hooks/` (executive-agent-Repo). Live-Pfad: `~/.claude/hooks/`.

| Hook | Typ | Funktion |
|------|-----|----------|
| `deny-destructive.sh` | PreToolUse | Destruktiv-Sperre + Red-Zone-Guard (Strang-aware seit 2026-07-20) |
| `telegram-notify.sh` | Notification | Sendet bei `permission_prompt` / `idle_prompt` an bikosoc-dev |

**Install (idempotent):**
```bash
bash scripts/install-hooks.sh
# meldet pro Hook: installed / unchanged / updated
```

**Drift-Check:** Smoke-Test Check #15 — vergleicht sha256 live vs. Repo.
Abweichung oder fehlender Hook → ❌ mit Hinweis `scripts/install-hooks.sh ausführen`.
