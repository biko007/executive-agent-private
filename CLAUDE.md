# Executive Agent — CLAUDE.md

**Stand: 2026-05-12**

## Stand 2026-05-12

Sprint 1 + 2 + 3 vollständig abgeschlossen.

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
  16/16 Tests, 15/15 Smoke.

### Module (10)

| Modul | Pfad | Commands | DI |
|-------|------|----------|----|
| executive | src/modules/executive/ | Health Monitor, Briefing-Scheduler | — |
| instagram | src/modules/instagram/ | 21 | sendTelegram, Meta API, Voice, Postgres |
| assets | src/modules/assets/ | 7 | self-contained |
| health | src/modules/health/ | 12 | sendTelegram |
| fleet | src/modules/fleet/ | 10 | Links |
| travel | src/modules/travel/ | 8 | M365, Telegram, Links |
| pe | src/modules/pe/ | 5 | self-contained |
| mail | src/modules/mail/ | 12 | M365, Yahoo, Telegram |
| calendar | src/modules/calendar/ | 4 | M365 |
| sharepoint | src/modules/sharepoint/ | 8 | M365, Telegram |

(Spec V3 §3 listete nur 5 — wird in Batch 3 ergänzt.)

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

### Offene TODOs

- ~~n8n-Postgres separat im Borg-Backup (Spec §15.4)~~ — erledigt 2026-05-11
- ~~Helper-Endpoint POST /api/internal/notify~~ — erledigt 2026-05-11
- ~~Spec V3 §3 erweitern um 5 neue Module~~ — erledigt 2026-05-11 (v3.1)
- ~~Sprint 3 Instagram auf Postgres~~ — erledigt 2026-05-12
- Optional: Meta-Token rotieren (User-Entscheidung)

### Lessons

- **Postgres-Bootstrap-User:** `ALTER ROLE n8n NOSUPERUSER` → `permission denied to alter role`.
  Lösung: separater App-User `n8n_app` mit GRANT-Modell. Smoke-Test verhindert Rückfall.

## Telegram-Notify aus Skripten/Claude Code

```bash
~/.scripts/notify 'Nachricht' [info|warn|error]
```

Endpoint: `POST /api/internal/notify` (localhost only, nginx-Whitelist).
Body: `{ "message": "...", "severity": "info"|"warn"|"error" }`

## Architektur-Disziplin (Manifest)

Diese Regeln stehen über allem, was in Implementierungs-Sessions vorgeschlagen wird:

1. **Eine Schraube pro Sprint.** Niemals zwei Module gleichzeitig migrieren.
2. **n8n bleibt dumm.** Nur Trigger an `/api/n8n/trigger/*`. Linter erzwingt das.
3. **Modul-Grenzen sind heilig.** ESLint erzwingt — nicht Disziplin.
4. **Backup-Restore vor Backup-Schreiben.** Jedes neue Backup-Ziel: erst Restore-Test.
5. **Tests für Geld.** Alles, was IBANs oder Posts ins Internet schickt, hat Tests.
6. **Audit-Log ist Pflicht.** Wer hat was wann geändert? Immer beantwortbar.
7. **Klein anfangen, groß denken.** Modularer Monolith jetzt — Microservices wenn Wartung wehtut.
8. **Idempotency vor Side-Effects.** Jeder externe Call braucht einen Idempotency-Key.
9. **Sensitive Daten klassifiziert.** Nie in Logs, callback_data oder n8n-Logs.
10. **Auto-Rollback im Deploy.** Jedes Deploy-Skript prüft sich selbst.

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
health-store.ts     Gewicht, Schlaf, Trends, Alerts
sharepoint-store.ts SP-Index, Suche, Sync
link-store.ts       Entity-Dokument-Verknüpfungen
withings-store.ts   Withings OAuth2 + API
src/modules/instagram/store.ts  Instagram Business API, Drafts, Tokens, Style (Postgres-backed)
```

## Datenpfade

```
Trips:       artifacts/personal/travel/<trip-id>.json
Health:      artifacts/personal/health/health-log.jsonl
Withings:    artifacts/personal/health/withings-tokens.json
Settings:    artifacts/personal/health/settings.json (inkl. Standort)
Loc-History: artifacts/personal/location/history.jsonl
Fleet:       artifacts/personal/fleet/vehicles.json
Assets:      artifacts/personal/assets/properties.json
             artifacts/personal/assets/leases.json
             artifacts/personal/assets/operating-costs/<id>-<year>.json
Bilder:      artifacts/personal/images/<entityType>-<entityId>.jpg
Mail-Parse:  artifacts/personal/mail-parsing/processed.json
Links:       artifacts/personal/links/links.json
SP-Index:    artifacts/personal/sharepoint/sharepoint-index.json
Drafts:      artifacts/personal/mail-drafts/<id>.json
Instagram:   Postgres insta_drafts, insta_tokens, insta_style_profile (Sprint 3)
             artifacts/personal/instagram/insights-cache.json  (File)
             artifacts/personal/instagram/media-cache.json     (File)
             artifacts/personal/instagram/content-calendar.json (File)
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

nginx-Configs:  /etc/nginx/sites-available/app-bikobickel
                /etc/nginx/sites-available/openclaw-withings (Legacy IP:8443)
Cert:           Let's Encrypt (auto-renew via certbot)
Reload:         sudo nginx -t && sudo systemctl reload nginx
```

## Deployment

```bash
npm run build
systemctl --user restart openclaw-gateway.service
systemctl --user status openclaw-gateway.service --no-pager
journalctl --user -u openclaw-gateway.service -n 20 --no-pager
bun run scripts/smoke-test.ts
```

Nach jedem Build + Restart IMMER `bun run scripts/smoke-test.ts` ausführen.
Bei Exit-Code 1: Deployment als fehlgeschlagen betrachten,
Fehler beheben bevor "Erledigt" gemeldet wird.

## CI-Tests — MUSS GRÜN BLEIBEN

```bash
npm test   # bun test — 16 Tests über 3 Dateien
```

**Pflicht-Tests (Spec §17):**
- `src/modules/instagram/__tests__/approval-hard-rule.test.ts` — Spec §17.2
  Prüft: Draft ohne Freigabe kann NICHT veröffentlicht werden.
  NIEMALS löschen oder deaktivieren. Nutzt echte Postgres-Test-DB.
- `src/modules/instagram/__tests__/insta-store-db.test.ts` — Sprint 3 §6.1
  Prüft: Roundtrip insert → load → update → filter gegen echte Postgres-DB.
- `src/modules/executive/__tests__/health-monitor.test.ts`
  Prüft: Alert-Throttling für Service-Monitoring.

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

Sprint 1 + 2 + 3 vollständig abgeschlossen (2026-05-12). Details siehe "Stand" oben.
Smoke Test: 15/15 PASS, npm test: 16/16 PASS.

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
  openclaw-trading (18793), ibgateway (7497), xvfb (:1)
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
