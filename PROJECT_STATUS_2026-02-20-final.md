# Executive Agent — Project Status
**Stand: 2026-02-20 (Europe/Berlin) — FINAL**

---

## Inhaltsverzeichnis

1. [Ziel & Überblick](#1-ziel--überblick)
2. [Infrastruktur](#2-infrastruktur)
3. [Secrets & Umgebungsvariablen](#3-secrets--umgebungsvariablen)
4. [Modus Operandi — Pflichtlektüre](#4-modus-operandi--pflichtlektüre)
5. [Deployment-Workflow](#5-deployment-workflow)
6. [Tooling & Arbeitsweise](#6-tooling--arbeitsweise)
7. [Modul: Mail](#7-modul-mail)
8. [Modul: Kalender & Meetings](#8-modul-kalender--meetings)
9. [Modul: Executive Brief (unified snapshot)](#9-modul-executive-brief-unified-snapshot)
10. [Modul: Travel (Reiseplanung)](#10-modul-travel-reiseplanung)
11. [Modul: Health & Withings](#11-modul-health--withings)
12. [Alle Befehle — Kurzübersicht](#12-alle-befehle--kurzübersicht)
13. [Offene Punkte (Backlog)](#13-offene-punkte-backlog)
14. [Bekannte Eigenheiten & Stolperfallen](#14-bekannte-eigenheiten--stolperfallen)

---

## 1. Ziel & Überblick

**OpenClaw Executive System** auf einem Hetzner VPS.
Steuerfläche: **Telegram** (Mobilgerät + Desktop).

### Aktive Fähigkeiten (heute vollständig implementiert)

| Bereich | Status |
|---|---|
| Unified Inbox (M365 + Yahoo) | ✅ stabil |
| Draft-Lifecycle (create → approve → send) | ✅ stabil |
| Kalender lesen + Frei/Belegt | ✅ stabil |
| Meetings erstellen mit Konflikt-Erkennung | ✅ stabil |
| Natürlichsprachige Meeting-Eingabe | ✅ stabil |
| **Travel: KI-Anreicherung + Wettervorschau** | ✅ heute |
| **Health: manuelle Einträge (Gewicht, Schlaf, …)** | ✅ heute |
| **Withings OAuth2 + automatischer Datensync** | ✅ heute |
| **Tägliches Briefing (Wetter + Kalender + Health + Drafts)** | ✅ heute |
| **Auto-Briefing per Telegram um 07:00 Uhr** | ✅ heute |

---

## 2. Infrastruktur

### Server

```
Anbieter:   Hetzner Cloud VPS (CCX33)
OS:         Ubuntu 24.04 LTS
Öffentliche IP: 46.62.153.181
Tailscale:  100.121.45.4
HTTPS:      Tailscale Serve → Port 443 → 127.0.0.1:18789
```

### Sicherheit

- SSH-Key only (Passwort-Login deaktiviert)
- Root-Login deaktiviert
- UFW aktiv (Port 22, 443, 8080 erlaubt)
- Fail2ban aktiv
- Gateway: Token-Authentifizierung
- **Einzige Secrets-Quelle:** `~/.config/openclaw/env`
- Keine Secrets in Code, pluginConfig, Workspace oder Chat

### OpenClaw

```
Version:    2026.2.14
Service:    openclaw-gateway.service (systemd user unit)
Sessions:   ~/.openclaw/agents/main/sessions/
Logs:       /tmp/openclaw/openclaw-YYYY-MM-DD.log
```

### Extension

```
Quellcode:  ~/.openclaw/workspace/.openclaw/extensions/executive-agent/
Entry:      dist/index.js
Plugin-ID:  executive-agent
```

---

## 3. Secrets & Umgebungsvariablen

**Datei:** `~/.config/openclaw/env`
Wird via `EnvironmentFile=` in die systemd-Unit geladen → alle Werte stehen in `process.env.*` zur Verfügung.

```
Variable                  Beschreibung
─────────────────────────────────────────────────────────────
OPENAI_API_KEY            OpenAI (Fallback, aktuell nicht aktiv genutzt)
ANTHROPIC_API_KEY         Claude Haiku — KI-Anreicherung bei /tripnew
OPENCLAW_GATEWAY_TOKEN    Auth-Token für den OpenClaw Gateway
M365_TENANT_ID            Microsoft 365 Azure AD Tenant
M365_CLIENT_ID            M365 Azure App Client-ID
M365_CLIENT_SECRET        M365 Azure App Secret
M365_USER                 juergen.bickel@bikolino.com
YAHOO_USER                jbickel2@yahoo.de
YAHOO_APP_PASSWORD        Yahoo App-Passwort (kein normales Passwort!)
YAHOO_IMAP_HOST           imap.mail.yahoo.com
YAHOO_IMAP_PORT           993
YAHOO_SMTP_HOST           smtp.mail.yahoo.com
YAHOO_SMTP_PORT           587
WITHINGS_CLIENT_ID        Withings API Client-ID
WITHINGS_CLIENT_SECRET    Withings API Client-Secret
```

### Secret hinzufügen oder ändern

```bash
# Bearbeiten:
nano ~/.config/openclaw/env

# Danach Service neu starten damit die Werte geladen werden:
systemctl --user restart openclaw-gateway.service
```

### Prüfen ob ein Secret geladen ist

```bash
systemctl --user show openclaw-gateway.service -p Environment | grep -o 'VARNAME=[^ ]*'
# Beispiel:
systemctl --user show openclaw-gateway.service -p Environment | grep -o 'ANTHROPIC_API_KEY=[^ ]*'
```

---

## 4. Modus Operandi — Pflichtlektüre

> **Wichtig:** Niemals große Textblöcke mit nano direkt in index.ts eintippen. Das führt zu Dateikorruption. Stattdessen immer über Claude Code (dieses Werkzeug) Änderungen vornehmen.

### Grundregeln

1. **Git snapshot vor jeder Änderung** (Sicherheitsnetz)
2. Änderungen immer über Claude Code einpflegen
3. Nach jeder Änderung: Build-Gate durchlaufen
4. Keine Secrets in Code, Config oder Chat eingeben
5. Bei Problemen: `git log --oneline -5` zeigt letzte Commits → Rollback möglich

### Wichtige Dateien

```
index.ts          ← Einzige Quelle aller Plugin-Logik (NICHT direkt bearbeiten)
dist/index.js     ← Wird automatisch gebaut (NICHT manuell bearbeiten)
travel-store.ts   ← Travel-Datenschicht
health-store.ts   ← Health-Datenschicht
withings-store.ts ← Withings OAuth + API
openclaw.plugin.json ← Plugin-Manifest
```

### Datenspeicher

```
Reisen:     ~/.openclaw/workspace/artifacts/personal/travel/<trip-id>.json
Gesundheit: ~/.openclaw/workspace/artifacts/personal/health/health-log.jsonl
Withings:   ~/.openclaw/workspace/artifacts/personal/health/withings-tokens.json
Einstellungen: ~/.openclaw/workspace/artifacts/personal/health/settings.json
Mail-Drafts: ~/.openclaw/workspace/artifacts/mail-drafts/<id>.json
```

---

## 5. Deployment-Workflow

### Schritt-für-Schritt nach jeder Code-Änderung

```bash
# 1. Build
cd ~/.openclaw/workspace/.openclaw/extensions/executive-agent
npm run build

# 2. (Optional) Node-Syntax-Check
npm run check:node

# 3. Service neu starten
systemctl --user restart openclaw-gateway.service

# 4. Status prüfen (sollte "active (running)" zeigen)
systemctl --user status openclaw-gateway.service --no-pager

# 5. Log prüfen (sollte "loaded v14" zeigen ohne Fehler)
journalctl --user -u openclaw-gateway.service -n 20 --no-pager | tail -10
```

### Git-Workflow

```bash
cd ~/.openclaw/workspace/.openclaw/extensions/executive-agent

# Snapshot vor Änderungen:
git add index.ts travel-store.ts health-store.ts withings-store.ts
git commit -m "snapshot: beschreibung"

# Nach erfolgreichem Test:
git add -A
git commit -m "feat: was wurde gemacht"
```

### Rollback (wenn etwas schiefläuft)

```bash
# Letzten 5 Commits anzeigen:
git log --oneline -5

# Zu einem bestimmten Commit zurück:
git checkout <commit-hash> -- index.ts
npm run build && systemctl --user restart openclaw-gateway.service
```

### Withings OAuth-Callback: Port 8080 öffnen

```bash
# Einmalig (falls noch nicht gemacht):
sudo ufw allow 8080/tcp
sudo ufw status
```

---

## 6. Tooling & Arbeitsweise

### Entwicklungsumgebung

| Werkzeug | Version | Zweck |
|---|---|---|
| **VS Code** | aktuell | Editor, Remote-SSH-Verbindung zum VPS |
| **Remote-SSH Extension** | aktuell | Direkte Datei-Bearbeitung auf dem Server |
| **Claude Code** | v2.1.49 | Alle Dateioperationen im integrierten VS-Code-Terminal |
| **Claude.ai Pro** | (dieser Chat) | Planung, Architektur, komplexe Implementierungen |

### Wie die Tools zusammenspielen

```
Claude.ai Pro (Browser)
  └── Planung, Architektur, neue Ideen, Fehlerstrategie
        │
        ▼
VS Code Remote-SSH → VPS (46.62.153.181)
  └── Integriertes Terminal
        └── Claude Code v2.1.49
              ├── Liest und schreibt Dateien direkt (index.ts, *.ts, *.md)
              ├── Führt npm run build aus
              ├── Führt systemctl --user restart ... aus
              └── Führt git add / git commit aus
```

### Wichtige Unterscheidung: Was macht wer?

**Claude Code (Terminal) — übernimmt selbstständig:**
- Alle Dateiänderungen (`index.ts`, `*.ts`, `*.md`, `*.json`)
- `npm run build`
- `systemctl --user restart openclaw-gateway.service`
- `journalctl ...` (Log-Prüfung)
- `git add / git commit`

**User führt manuell im Terminal aus — weil sudo nötig:**
```bash
sudo ufw allow 8080/tcp
sudo ufw status
sudo apt install ...
sudo systemctl ...   # (system-weite Services, nicht user-Services)
```

**Faustregel:** Alles mit `sudo` → manuell im Terminal eingeben.
Alles ohne `sudo` → Claude Code erledigt es.

### VS Code Remote-SSH einrichten (Referenz)

Falls die Verbindung neu aufgebaut werden muss:

1. VS Code öffnen
2. `F1` → `Remote-SSH: Connect to Host`
3. `biko@46.62.153.181` eingeben
4. SSH-Key wird automatisch verwendet (liegt in `~/.ssh/`)
5. Im VS Code Terminal:

```bash
cd ~/.openclaw/workspace/.openclaw/extensions/executive-agent
```

### Claude Code starten

```bash
# Im integrierten VS Code Terminal (bereits auf dem VPS):
claude
```

Claude Code startet im aktuellen Verzeichnis und kennt alle Projektdateien.

### Session fortsetzen nach Unterbrechung

Claude Code speichert keinen Kontext zwischen Sessions. Beim nächsten Start kurz orientieren:

```bash
# Letzten Git-Stand anzeigen:
git log --oneline -5

# Service-Status prüfen:
systemctl --user status openclaw-gateway.service --no-pager | tail -5

# Letzte Log-Zeilen:
journalctl --user -u openclaw-gateway.service -n 10 --no-pager | tail -5
```

Dann einfach die aktuelle PROJECT_STATUS-Datei als Kontext mitgeben:
> "Lies PROJECT_STATUS_2026-02-20-final.md und mach weiter mit [Aufgabe]"

### Modus Operandi — Kernregeln für dieses Projekt

> Diese Regeln entstanden aus der Erfahrung mit diesem spezifischen Setup.
> Sie gelten unabhängig davon, welcher Claude-Stand geöffnet ist.

1. **Niemals `nano` oder `vi` für große Dateien verwenden.**
   Direktes Editieren von `index.ts` in der Shell führt zu Zeichenkodierungsproblemen und Dateikorruption. Immer Claude Code verwenden.

2. **Immer kopierfertige Befehle.**
   Keine abstrakten Anweisungen wie "starte den Service neu". Immer den exakten Befehl liefern.

3. **Erst bauen, dann prüfen, dann neu starten.**
   Reihenfolge ist Pflicht — nie den Service neu starten ohne vorherigen Build.

4. **Secrets nie in Chat, Code oder Config.**
   Einzige Quelle: `~/.config/openclaw/env`. Secrets werden dort via `nano` eingetragen.

5. **Bei Unsicherheit: Git-Snapshot zuerst.**
   ```bash
   git add -A && git commit -m "snapshot vor änderung"
   ```

6. **Neue Funktionen immer in Claude.ai Pro planen, dann in Claude Code umsetzen.**
   Claude.ai Pro hat den großen Kontext für Architekturentscheidungen.
   Claude Code hat direkten Dateizugriff für die Umsetzung.

---

## 7. Modul: Mail

### Yahoo

- IMAP (ImapFlow) für ungelesene Nachrichten
- SMTP (Nodemailer 8.0.1) für Versand
- Port 587 + STARTTLS

### Microsoft 365

- Graph API (App-Credentials, kein delegierter Benutzer)
- Token-Cache im Speicher (45 Min TTL)
- Automatischer Token-Refresh
- 20s Timeout auf alle Graph-Calls (verhindert hängende Befehle)
- Retry-Logik: 429/503/504 mit exponential backoff

### Befehle

```
/inbox [n]                  Unified Inbox: ungelesene Mails (Standard: 10)
/inbox last [24h] [n]       Letzte Mails im Zeitfenster
/yinbox [n]                 Yahoo ungelesene Mails
/yverify                    Yahoo SMTP-Verbindung testen
/ytest <email>              Yahoo Test-Draft erstellen
/mailstatus                 M365 + Yahoo Verbindungsstatus
```

### Draft-Lifecycle

```
/draftcreate account=yahoo|m365 to=a@b.com subject=... body=...
/draftlist [n]              Offene Drafts anzeigen
/draftshow <id>             Draft-Inhalt anzeigen
/draftedit <id> subject=... body=... to=...
/draftapprove <id>          Draft freigeben
/draftsend <id>             Freigegebenen Draft senden
```

> **Pflichtablauf:** create → approve → send (requireApproval=true)

---

## 8. Modul: Kalender & Meetings

### Kalender lesen

```
/calendar                   Nächste 7 Tage (gruppiert nach Tag)
/brief                      Snapshot: Inbox + nächste 3 Termine + Drafts
```

### Meetings erstellen

```
/meet heute 14:00 Projektcall
/meet morgen 9:30 45min Design-Review
/meet mo 10:00 1h Budget-Meeting
/meet 27.02 14:00 60 Strategic Call
/meetf <gleiche Syntax>     Erzwingen trotz Konflikt

/free 27.02 14:00-18:00     Freie Zeitfenster prüfen
```

### Natürliche Datumseingabe

| Eingabe | Bedeutung |
|---|---|
| `heute 14:00` | heutiges Datum |
| `morgen 9:30` | morgiges Datum |
| `mo 10:00` | nächsten Montag |
| `di`, `mi`, `do`, `fr`, `sa`, `so` | nächster Wochentag |
| `27.02 14:00` | explizites Datum |

### Dauer-Angaben

| Eingabe | Bedeutung |
|---|---|
| `60` | 60 Minuten |
| `45min` oder `45m` | 45 Minuten |
| `1h` oder `1.5h` | Stunden |
| *(leer)* | Standard: 60 Minuten |

### Konflikt-Erkennung

- Scannt ±12h um den gewünschten Termin
- Prüft Überlappungen lokal (robuste Methode)
- Zeigt Konflikt-Details + `/meetf`-Vorschlag
- Teams-Meeting wird automatisch erstellt

---

## 9. Modul: Executive Brief (unified snapshot)

### /brief — Schnell-Überblick

```
/brief
```

Zeigt in einem Block:
- Top 5 ungelesene Mails (M365 + Yahoo, neueste zuerst)
- Nächste 3 Kalendertermine (7 Tage)
- Top 5 offene Drafts

### /briefing — Tages-Briefing

```
/briefing
```

Zeigt in einem Block:
- Aktuelles Wetter Tuttlingen (Open-Meteo, kostenlos, kein API-Key nötig)
- 3-Tage-Vorschau
- Heutige Kalendertermine
- Letzte Gesundheitswerte (Gewicht, Schlaf, Schritte, Herzfrequenz)
  - Heutiger Wert: kein Datum-Hinweis
  - Gestriger Wert: `(gestern)`
  - Ältere Werte: `(YYYY-MM-DD)`
- Offene Drafts

### Auto-Briefing einrichten

Das Briefing wird automatisch täglich um eine konfigurierbare Uhrzeit (Europe/Berlin) per Telegram verschickt.

**Schritt 1:** Einfach irgendeine Nachricht an den Bot senden. Der Bot merkt sich automatisch die Chat-ID.

**Schritt 2:** Uhrzeit einstellen (Standard ist 07:00):
```
/briefingtime 07:00
```

Weitere Beispiele:
```
/briefingtime 06:30
/briefingtime 08:15
```

Die Einstellung wird dauerhaft in `settings.json` gespeichert und überlebt auch Service-Neustarts.

---

## 10. Modul: Travel (Reiseplanung)

### Reise anlegen

**Automatischer Modus (empfohlen) — mit KI + Wetter:**

```
/tripnew New York 2026-03-03 2026-03-05
/tripnew Tokyo 2026-05-10 2026-05-20
/tripnew Mallorca 2026-07-01 2026-07-14
```

Der Bot liefert automatisch (via Claude Haiku):
- Destination + Ländercode
- Klima-Kategorie
- Empfohlene Aktivitäten
- Währung + Wechselkurs (EUR)
- Visum-Info für deutschen Pass
- Luftlinie ab Tuttlingen
- Empfohlenes Verkehrsmittel
- Haustür-zu-Haustür Zeitschätzung
- 7-Tage Wettervorschau (Open-Meteo)

**Manueller Modus (ohne KI):**

```
/tripnew Tokyo 2026-05-10 2026-05-20 Tokyo cold leisure,city
#  Format: /tripnew <Name> <YYYY-MM-DD> <YYYY-MM-DD> <Destination> <Klima> <Aktivitäten>
```

Mögliche Klima-Werte: `tropical`, `temperate`, `cold`, `desert`, `mixed`
Mögliche Aktivitäten: `business`, `leisure`, `outdoor`, `beach`, `city` (kommasepariert)

### Reisen verwalten

```
/trips                          Alle Reisen anzeigen
/tripshow <id>                  Detail-Ansicht einer Reise
/tripadd <id> flight 2026-05-10T10:30 Europe/Berlin LH716-FRA-NRT ABC123
/pack <id>                      Packliste generieren
```

### Segmente hinzufügen (/tripadd)

Format:
```
/tripadd <trip-id> <typ> <YYYY-MM-DDTHH:MM> <Timezone> <Titel> [Bestätigungsnummer]
```

Typen: `flight`, `hotel`, `activity`, `transfer`, `note`

Beispiele:
```
/tripadd tokyo-2026-05 flight 2026-05-10T10:30 Europe/Berlin LH716 FRA-NRT
/tripadd tokyo-2026-05 hotel 2026-05-11T15:00 Asia/Tokyo Shinjuku-Hotel 12345
/tripadd tokyo-2026-05 activity 2026-05-12T10:00 Asia/Tokyo Tsukiji Markt Tour
```

### Packliste

```
/pack tokyo-2026-05
```

Generiert automatisch eine Packliste basierend auf Klima und Aktivitäten.

### KI-Anreicherung — Technische Details

- Modell: `claude-haiku-4-5-20251001` (Anthropic API)
- API-Key: `ANTHROPIC_API_KEY` in `~/.config/openclaw/env`
- Wettervorhersage: Open-Meteo API (kostenlos, kein Key benötigt)
- Koordinaten kommen vom LLM (Breitengrad/Längengrad der Destination)

---

## 11. Modul: Health & Withings

### Architektur

```
Datenspeicher: append-only JSONL
Datei: ~/.openclaw/workspace/artifacts/personal/health/health-log.jsonl
Tokens: ~/.openclaw/workspace/artifacts/personal/health/withings-tokens.json
Settings: ~/.openclaw/workspace/artifacts/personal/health/settings.json
```

### Manuelle Einträge

```
/weight                     Letztes Gewicht anzeigen
/weight 78.5                Gewicht manuell eintragen (kg)
/sleep 7.5                  Schlafdauer eintragen (Stunden)
/sleep 7.5 4                Mit Qualität 1–5
/symptom Kopfschmerzen      Symptom notieren
/healthlog Heute gut gefühlt  Freitext-Eintrag
```

### Auswertung

```
/healthweek                 Zusammenfassung letzte 7 Tage
/healthmonth                Zusammenfassung letzte 30 Tage
```

### Withings-Verbindung einrichten (Einmalig)

**Schritt 1:** OAuth-Flow starten

```
/withingsauth
```

Der Bot startet einen temporären HTTP-Server auf Port 8080 (läuft 60 Sekunden).

**Schritt 2:** Den angezeigten Link im Browser öffnen.

**Schritt 3:** Bei Withings anmelden und Zugriff bestätigen.

**Schritt 4:** Browser wird zu `http://46.62.153.181:8080/withings/callback` weitergeleitet. Bei Erfolg zeigt die Seite `✅ Withings erfolgreich verbunden!`

**Schritt 5:** Im Telegram-Chat:
```
/healthsync
```

> **Fallback (falls Browser-Redirect nicht funktioniert):**
> Nach dem Withings-Login in der Browser-Adressleiste den `code=`-Parameter kopieren und eingeben:
> ```
> /withingstoken <code>
> ```
> Oder die komplette URL einfügen:
> ```
> /withingstoken https://46.62.153.181:8080/withings/callback?code=abc123&state=xyz
> ```

### Withings-Daten importieren

```
/healthsync              Sync ab letztem Sync (oder 30 Tage)
/healthsync 7            Sync letzte 7 Tage
/healthsync 90           Sync letzte 90 Tage
```

Importiert automatisch:
- Gewicht + Körperfett + Körperfettmasse
- Herzfrequenz (aus Waagen-Messung)
- Schlaf (Gesamtdauer, Tiefschlaf, REM, Leichtschlaf, Sleep-Score)
- Tagessschritte + Distanz + Kalorien + Herzfrequenz
- Workouts (Typ, Dauer, Schritte, Distanz, Kalorien, HR)

Token-Refresh erfolgt automatisch (5 Min vor Ablauf).

---

## 12. Alle Befehle — Kurzübersicht

### Mail
| Befehl | Beschreibung |
|---|---|
| `/inbox [n]` | Ungelesene Mails |
| `/inbox last [24h] [n]` | Letzte Mails |
| `/yinbox [n]` | Yahoo ungelesene |
| `/yverify` | SMTP-Test |
| `/ytest <email>` | Test-Draft |
| `/mailstatus` | Verbindungsstatus |
| `/draftcreate ...` | Draft anlegen |
| `/draftlist [n]` | Drafts anzeigen |
| `/draftshow <id>` | Draft lesen |
| `/draftedit <id> ...` | Draft bearbeiten |
| `/draftapprove <id>` | Freigeben |
| `/draftsend <id>` | Senden |

### Kalender
| Befehl | Beschreibung |
|---|---|
| `/calendar` | Nächste 7 Tage |
| `/free DD.MM HH:MM-HH:MM` | Freie Slots |
| `/meet <datum> <zeit> [dauer] <titel>` | Meeting erstellen |
| `/meetf ...` | Meeting erzwingen |

### Executive Brief
| Befehl | Beschreibung |
|---|---|
| `/brief` | Snapshot: Inbox + Termine + Drafts |
| `/briefing` | Wetter + Kalender + Health + Drafts |
| `/briefingtime HH:MM` | Auto-Briefing-Zeit setzen |

### Travel
| Befehl | Beschreibung |
|---|---|
| `/trips` | Alle Reisen |
| `/tripnew <name> <start> <end>` | Neue Reise (KI-Modus) |
| `/tripnew <name> <start> <end> <dest> <klima> <aktivitäten>` | Manuell |
| `/tripshow <id>` | Reise-Details |
| `/tripadd <id> <typ> <datetime> <tz> <titel>` | Segment hinzufügen |
| `/pack <id>` | Packliste |

### Health & Withings
| Befehl | Beschreibung |
|---|---|
| `/weight [kg]` | Gewicht anzeigen / eintragen |
| `/sleep <h> [q]` | Schlaf eintragen |
| `/symptom <text>` | Symptom notieren |
| `/healthlog <text>` | Freitext |
| `/healthweek` | 7-Tage-Übersicht |
| `/healthmonth` | 30-Tage-Übersicht |
| `/withingsauth` | OAuth-Flow starten |
| `/withingstoken <code>` | Code manuell einlösen |
| `/healthsync [tage]` | Withings-Daten importieren |

---

## 13. Offene Punkte (Backlog)

### 🔴 Hohe Priorität

**Mail-Parsing für Buchungsbestätigungen**
- Flug- und Hotel-Bestätigungen aus dem Postfach automatisch parsen
- Erkannte Buchungen direkt als Trip-Segmente anlegen
- Trigger: `/inbox scan` oder automatisch beim `/healthsync`

**Natürliche Sprache für Travel**
- Statt `/tripnew New York 2026-03-03 2026-03-05` einfach:
  `"Reise nach New York, 3. bis 5. März"`
- NLP-Parsing mit Claude Haiku
- Datumsformate: `3. März`, `nächsten Montag`, `übernächste Woche`

### 🟡 Mittlere Priorität

**Assets-Modul**
- Finanzüberblick: Depots, Konten, Immobilien
- Speicher: `~/.openclaw/workspace/artifacts/personal/assets/`
- Mögliche Datenquellen: manuelle Eingabe, CSV-Import
- Befehle: `/networth`, `/asset add`, `/asset list`

**Health: Trends & Alerts**
- Gewichts-Trend über 7/30 Tage
- Alert wenn Schlaf < 6h oder > 10h
- Wöchentlicher Health-Report automatisch per Telegram

**Travel: Kalender-Integration**
- Trip-Segmente automatisch als Kalendertermine in M365 anlegen
- Erinnerungen (z.B. 24h vor Abflug)

### 🟢 Niedrige Priorität

**Multi-User-Support**
- Aktuell: Single-User (Chat-ID = erste empfangene Nachricht)
- Erweiterung: Whitelist mehrerer Chat-IDs

**Withings: Live-Alarm**
- Herzfrequenz-Warnung bei Anomalien
- Schlafqualität-Trend

**Web-Dashboard**
- Readonly-View über HTTPS
- Port: Tailscale Serve oder 443

---

## 14. Bekannte Eigenheiten & Stolperfallen

### Withings OAuth

- Der temporäre Callback-Server läuft nur **60 Sekunden** nach `/withingsauth`
- Port 8080 muss in UFW erlaubt sein: `sudo ufw allow 8080/tcp`
- Bei Timeout: `/withingsauth` erneut ausführen

### Auto-Briefing

- Die Chat-ID wird beim **ersten eingehenden Telegram-Befehl** automatisch gespeichert
- Das Auto-Briefing startet erst, wenn eine Chat-ID bekannt ist
- Prüfen: `cat ~/.openclaw/workspace/artifacts/personal/health/settings.json`
- Nach Service-Neustart läuft das `setInterval` wieder an — kein manueller Eingriff nötig

### Withings Token

- Token-Lebensdauer: ~3 Stunden (Withings), automatischer Refresh < 5 Min vor Ablauf
- Falls Refresh fehlschlägt: `/withingsauth` erneut ausführen

### M365 Graph API

- Alle Calls haben 20s Timeout (kein hängendes Telegram)
- Bei 401: automatisch einmaliger Token-Refresh
- Bei 429/503/504: exponential backoff bis 8s

### Service-Neustart nötig nach:

- Änderungen an `~/.config/openclaw/env`
- Änderungen an `index.ts` (nach `npm run build`)
- OpenClaw-Updates

```bash
systemctl --user restart openclaw-gateway.service
```

### Build schlägt fehl?

```bash
# Fehler anzeigen:
npm run build 2>&1

# Typische Ursachen:
# - TypeScript-Fehler in index.ts (z.B. fehlender Typ)
# - Import-Pfad falsch (muss .js enden, z.B. "./travel-store.js")
```

### Log-Analyse

```bash
# Live-Log:
journalctl --user -u openclaw-gateway.service -f

# Letzte 50 Zeilen:
journalctl --user -u openclaw-gateway.service -n 50 --no-pager

# Nur Fehler:
journalctl --user -u openclaw-gateway.service -n 100 --no-pager | grep -i error
```

---

*Generiert am 2026-02-20 | Executive Agent v14 | OpenClaw 2026.2.14*
