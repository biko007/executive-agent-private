# Executive Agent — CLAUDE.md

**Stand: 2026-05-10**

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
bun run scripts/smoke-test.ts
```

Nach jedem Build + Restart IMMER `bun run scripts/smoke-test.ts` ausführen.
Bei Exit-Code 1: Deployment als fehlgeschlagen betrachten,
Fehler beheben bevor "Erledigt" gemeldet wird.

## CI-Tests — MUSS GRÜN BLEIBEN

```bash
npm test   # bun test — 11 Tests über 2 Dateien
```

**Pflicht-Tests (Spec §17):**
- `src/modules/instagram/__tests__/approval-hard-rule.test.ts` — Spec §17.2
  Prüft: Draft ohne Freigabe kann NICHT veröffentlicht werden.
  NIEMALS löschen oder deaktivieren.
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

Sprint 2 VOLLSTÄNDIG abgeschlossen (2026-05-11), Etappe a-g + h1 + h2 + h3:
- Etappe a: src/shared/ (utils, settings, m365, links), module skeletons, K1-Fix
- Etappe b: Fleet-Modul extrahiert (store, types, commands), K2-Fix
- Etappe c: Assets-Modul extrahiert (store, types, commands), keine DI nötig
- Etappe d: Health+Withings-Modul extrahiert (store, withings, types, commands), DI für sendTelegram
- Etappe e: PE-Modul extrahiert (store, types, commands), self-contained
- Etappe f: Travel-Modul extrahiert (store, weather, enrichment, commands), DI für M365/Telegram/Links
- Etappe g: Instagram-Modul extrahiert (types, commands, index), DI für Telegram/Meta/Voice
- Etappe h1: Calendar, Mail, SharePoint Module extrahiert — Executive Cleanup
- index.ts: 9.357 → 2.165 Zeilen (-7.192)
- 10 Fleet-Commands via registerFleetCommands(), DI für Links
- 7 Assets-Commands via registerAssetsCommands(), self-contained
- 12 Health/Withings-Commands via registerHealthCommands(), inkl. Weekly Report Timer
- 5 PE-Commands via registerPECommands(), self-contained
- 8 Travel-Commands via registerTravelCommands(), DI für M365/Telegram/Links
- 21 Instagram-Commands via registerInstagramCommands(), DI für sendTelegram/Meta/Voice
- 4 Calendar-Commands via registerCalendarCommands(), DI für M365
- 12 Mail-Commands via registerMailCommands(), DI für M365/Yahoo/Telegram
- 8 SharePoint-Commands via registerSharePointCommands(), DI für M365/Telegram
- Etappe h2: Audit-Log-Integration (19 Aufrufe: Instagram 11, Assets 2, Health 4, Auth 2)
- Etappe h3: Approval-Hard-Rule CI-Test (spec §17.2), publish() validation + 5 Tests
- Smoke Test: 13/13 PASS, npm test: 11/11 PASS

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
