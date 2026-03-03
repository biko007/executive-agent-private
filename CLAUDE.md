# Executive Agent — CLAUDE.md

**Stand: 2026-03-03**

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
instagram-store.ts  Instagram Business API, Drafts, Content-Kalender
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
Instagram:   artifacts/personal/instagram/tokens.json
             artifacts/personal/instagram/insights-cache.json
             artifacts/personal/instagram/media-cache.json
             artifacts/personal/instagram/content-calendar.json
Insta-Drafts:artifacts/personal/instagram/drafts/<id>.json
```

## Netzwerk / nginx

```
Alle externen Endpoints laufen über nginx + Let's Encrypt SSL (app.bikobickel.de:443).
Kein Service bindet extern — alles auf 127.0.0.1, nginx proxied:

  /dashboard/*  → 127.0.0.1:18800  (Dashboard)
  /location     → 127.0.0.1:18790  (Location-API, POST)
  /withings/*   → 127.0.0.1:18789  (Withings Callback, via Legacy-Config)

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
```

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

Keine laufenden Arbeiten.
