# OpenClaw Executive Agent — Changelog

Sprint-Historie und Feature-Narrative. Aktuelle Regeln und Betriebsstatus: CLAUDE.md.

---

## Stand 2026-10-05 — Briefing-Kalender: Zeitzone und Ganztagstermine (P1-5)

Core-Anteil von Paket P1-5 der Dashboard-Überarbeitung (Befund F).
Report: `~/bikosoc-spec/report-dashboard-p1-5-0735.md`.

**Befund.** Derselbe Termin erschien im Dashboard als „05.10. 22:00–21:30" und im
Telegram-Briefing als „Di 06.10. 00:00 (23.5h)". Graph liefert dazu
`start.dateTime = "2026-10-05T22:00:00.0000000"` mit `timeZone: "UTC"` — ein naiver
String **ohne** Zonensuffix. `new Date(string)` interpretiert ihn in der Zone der
Laufzeitumgebung: im Browser (Europe/Berlin) falsch, auf diesem Server (Etc/UTC)
zufällig richtig. Das Briefing war also nur durch die Serverzone korrekt und genauso
fehleranfällig.

Richtig ist 06.10.2026, 00:00–23:30 Europe/Berlin (23,5 Std.). Der Termin ist
**kein** Ganztagstermin — Graph meldet `isAllDay: false`.

**Änderungen in `index.ts` (Abschnitt „Kalender-Zeitlogik").**
- Neue Zeitlogik, die die mitgelieferte Zone auswertet; DST-fest über `Intl`
  (am 25.10.2026 wechselt Europe/Berlin von +02:00 auf +01:00).
- `kalenderZeitraum()` liefert Tagesschlüssel, Zeittext, Spanne, Dauer und ein
  Kennzeichen für unplausible Zeiten. Ganztagstermine werden als „ganztägig"
  ausgegeben, mit Graph-Semantik des **exklusiven** Endes.
- Der Kalenderblock des Briefings nutzt diese Logik. Vorher rechnete er Dauer und
  Uhrzeit aus naiv geparsten Strings und kannte keine Ganztagstermine.
- `$select` um `isAllDay` ergänzt — das Feld wurde bisher nicht abgefragt,
  Ganztagstermine waren im Briefing deshalb nicht erkennbar.
- Abfragefenster beginnt um Mitternacht Europe/Berlin statt `setHours(0,0,0,0)` auf
  der Serverzone. Damit verwenden Briefing und Dashboard dasselbe Fenster und sind
  vergleichbar.

Dieselbe Logik liegt im Dashboard in `public/js/zeit.js`. Ein Gleichheitstest
vergleicht beide Umsetzungen gegen dieselbe Graph-Antwort: **12 Termine, 0
Abweichungen** (vier echte plus acht Grenzfälle, darunter Ganztagstermine über
mehrere Tage, Termine über Mitternacht, Ende vor Beginn und beide Seiten der
Zeitumstellung).

Gates: `npm run build` Exit 0, `npm test` 645 pass / 0 fail, `verify:commands`
118/118, `verify-schema` ohne Drift, Smoke-Test 31/31.

---

## Stand 2026-10-04 — Dashboard-Überarbeitung P1-1: Statuszustände und Datenstand

Core-Anteil von Paket P1-1 der Dashboard-Überarbeitung
(`executive-dashboard/prompts/dashboard-ueberarbeitung/`, Owner-Spec vom 04.10.2026).
Report: `~/bikosoc-spec/report-dashboard-p1-1-1846.md`.

**Befund B1 behoben — `/api/system-status` (`index.ts`).** Zwei Ursachen:

1. Der Handler las `data.ibkr?.connected` aus der Antwort des Trading-Service. Der liefert
   `connected` auf oberster Ebene (`trading-agent/src/index.ts`), ein `ibkr`-Objekt existiert
   nicht. Der Wert war damit immer `undefined` und das IB Gateway dauerhaft „down", während
   der Trading-Bereich des Dashboards gleichzeitig „Verbunden" meldete.
2. Die Live-Prüfung griff nur bei fehlendem Eintrag (`if (!entry) push`). Ein einmal in
   `service_health` geschriebener Zustand hätte damit dauerhaft gewonnen. Jetzt setzt die
   Live-Prüfung den Eintrag unabhängig davon — für Postgres ebenso wie für das IB Gateway.

Der Zustand ist jetzt dreiwertig, damit „unbekannt" nie als Erfolg erscheint: verbunden →
`up`, erreichbar aber nicht verbunden → `down`, Trading-Service nicht erreichbar → `unknown`.
Jeder Diensteintrag trägt zusätzlich `source` (`live` | `db`) und `checked_at`. Der bisher
gelieferte `uptime_seconds` ist bei DB-Zeilen nur das Alter der Zeile und keine gemessene
Laufzeit — das steht jetzt im Code und die Oberfläche zeigt den Wert nur bei Live-Prüfung.

**Neu: `GET /api/sharepoint/sync-status`** (`src/modules/sharepoint/routes.ts`, lesend).
Liefert letzten Synchronisationslauf, letzten Erfolgszeitpunkt und Anzahl aktiver Dateien,
damit das Dashboard den Datenstand der Dokumentenliste benennen kann. Bestand: ein einziger
Lauf vom 16.05.2026 mit 12.089 Dateien.

Gates: `npm run build` Exit 0, `npm test` 645 pass / 0 fail, `verify:commands` 118/118,
`verify-schema` ohne Drift, Smoke-Test 31/31.

---

## Stand 2026-10-03 (später) — Quellwiki bei Nuveon geleert

Nach dem verifizierten Import wurde das Quellwiki auf Owner-Direktive geleert. Report:
`~/bikosoc-spec/report-nuveon-loeschung-20261003-*.md`, Löschliste:
`~/bikosoc-spec/nuveon-loeschliste-20261003.md`.

Neu: `scripts/wiki-import/nuveon-purge.ts` — die einzige Stelle im Repo, die gegenüber
Nuveon schreibend arbeitet. Der Importer bleibt strikt lesend.

Vor dem ersten Löschen geprüft und belegt: Import vollständig (48 = Index 86 − 38), alle
139 Anhänge mit sha256 lokal, `_raw/` vollständig (48/48), Borg-Umfang erfasst, und ein
frischer Tageslauf `daily-2026-10-03_210520`, in dem **187 von 187** Originaldateien
einzeln nachgewiesen sind.

Ergebnis: 139 Anhänge, 48 Inhaltsseiten, 27 Systemseiten gelöscht, 0 Fehler. Verbleibend
10 Seiten (3 Passwortseiten laut Ausnahme, 5 beim Import leere Seiten ohne lokales
Gegenstück, 2 von JSPWiki geschützte Systemseiten), 0 Anhänge. Unabhängig nachgeprüft
durch Einzelabfrage aller 86 Originalnamen.

Eine Lücke im eigenen Schutz: der Abgleich „kein Löschen ohne lokale Kopie" wirkt je
Eintrag, nicht über die Trägerbeziehung. `LeftMenuLogo/Logo151.gif` wurde als Anhang
übersprungen, die Trägerseite danach als Systemseite gelöscht — und nahm den Anhang mit.
Betroffen war das Skin-Logo, kein Inhalt des Eigentümers. In ARCHITECTURE.md §15 vermerkt.

---

## Stand 2026-10-03 — Wiki-Import durchgeführt; Prompt-Inbox schickte nie ab

Zwei Arbeitspakete. Report: `~/bikosoc-spec/report-wiki-migration-20261003-*.md`.

### A — Nuveon-Import abgeschlossen

48 Inhaltsseiten und 139 Anhänge (5,16 GB) importiert und verifiziert; Nuveon ist
ablösbar. Beim Import traten sechs Fehler im eigenen Code zutage, die der Probelauf
gegen Fixtures nicht zeigen konnte — alle am echten Bestand gefunden und behoben:

1. **Falsches `textarea`.** Die Editor-Seite führt drei; nur `name="_editedtext"` trägt
   den Inhalt. Mit dem ersten fielen **41 von 57** Seiten in den HTML-Fallback und wären
   als Fließtext statt als Markup importiert worden.
2. **Falscher Markup-Dialekt.** Das Wiki läuft mit **Creole**, nicht klassischem JSPWiki.
   Entscheidend: `[[Ziel|Text]]` stellt das Ziel voran, `[Text|Ziel]` den Text — jeder
   Link wäre verdreht worden. Erhoben über alle 81 Seiten mit Inhalt (298 Creole-Links
   gegen 40 klassische, 78 Creole-Überschriften gegen 1). Details: ARCHITECTURE.md §15.
3. **Sensibel-Erkennung mit Lücke.** Mehrere Seiten führen Zugangsdaten in Tabellen mit
   der Spalte `| PW|`. Die Erkennung verlangte `PW:` oder `PW=` und hätte diese Seiten
   als unbedenklich an das Sprachmodell gegeben. Jetzt 11 statt 4 sensible Seiten.
4. **22 tote interne Links.** JSPWiki löst Seitennamen normalisiert auf
   (`[[IP Adressen L19]]` = Seite `IPAdressenL19`). Behoben über `normalizePageName()`
   und einen Zweipass-Import, der den endgültigen Seitenbestand kennt. Ziele, die es
   nicht gibt, werden jetzt als Text ohne Link gerendert.
5. **Größenabgleich unmöglich.** Der AnhangIndex führt nur Namen. Quelle ist
   `PageInfo.jsp`; dabei zwei Fallstricke: JSPWiki rechnet **dezimal** (kB = 1000 Byte,
   an zwei Dateien gegengeprüft), und vor der gesuchten Tabelle steht die Upload-Maske,
   die „Size" ebenfalls enthält. Jetzt alle 139 Größen gegen die Quelle bestätigt.
6. **DXF als Bild eingestuft.** `image/vnd.dxf` ist formal richtig, hätte aber die
   Bildergalerie des Dashboards mit sechs unlesbaren Vorschauen gefüllt. Jetzt
   `application/dxf` — Ablage und Download, wie im Auftrag vorgesehen.

Neu: `scripts/wiki-import/verify.ts` prüft einen abgeschlossenen Import nach (Zähler,
sha256, Größe gegen die Quelle, Vorschauen, PDF-Texte), `--offline` ohne Quellzugriff.

### B — Prompt-Inbox und `/do` schickten den Auftrag nie ab

`tmux send-keys -t bikosoc -- "<text>" Enter` übergibt Text und Wagenrücklauf in **einem**
Leseschub. Gegen eine Shell ist das gleichwertig — deshalb sah die bisherige Testlage
(die gegen eine Shell prüfte) nichts. Eine TUI wie Claude Code unterscheidet: ein Schub
aus Text **und** Wagenrücklauf ist ein Einfügevorgang und erzeugt einen Zeilenumbruch im
Eingabefeld; erst ein Wagenrücklauf in einem **eigenen** Schub ist ein Tastendruck.

Im Rohmodus nachgemessen:

```
ein send-keys-Aufruf   → ein Schub:   "PROMPT-A\r"   (9 Byte)
zwei send-keys-Aufrufe → zwei Schübe: "PROMPT-B", dann "\r"
```

Folge: Datei-Drops nach `~/inbox/` und `/do <text>` trugen den Auftrag ein, schickten ihn
aber nicht ab. Der Poller verschob die Datei trotzdem nach `done/` und meldete „Prompt
uebergeben" — der Auftrag blieb unbemerkt liegen. Belegt durch
`~/inbox/done/2026-10-03T19-51-20-907Z-wiki-import.txt`: verarbeitet, nie ausgeführt.

Behoben in `cc-prompt-dispatch`: zwei getrennte Aufrufe mit 400 ms Pause. Denselben
Zweischritt verwendet der Bypass-Pfad in `index.ts` seit Längerem — die Prompt-Übergabe
hatte ihn nur nie bekommen.

**Drei bestehende Tests schrieben das defekte Verhalten fest** und sind korrigiert
(`cc-prompt-dispatch`, `prompt-inbox`, `arm-push`). Neu: E2E-Test über echtes tmux mit
Gegenprobe (das alte Muster führt nachweislich NICHT aus) und 16 Non-Owner-Negativtests
für die Kontrollfläche (C7).

**C7-Hinweis:** Teil B berührt eine Kontrollfläche und ist damit REVIEW-pflichtig —
Owner-Freigabe vor Push, auch wenn der Auftrag AUTO lautete (Präzedenz: Hard Rules über
Auftragsklassen).

---

## Stand 2026-09-28 — Modul `wiki`: Ablösung des JSPWiki bei Nuveon

Neues Modul `wiki` (Schema-Version 1) mit Dashboard-Oberfläche und zwei Nur-Lese-Agententools.
Ziel: das gehostete JSPWiki 2.8.4 unter `https://asp.nuveon.de/biko/` (letzte inhaltliche
Änderung 2016) kündbar machen. Architekturdetails: `docs/ARCHITECTURE.md §15`.
Auftrag: `~/bikosoc-spec/spec-wiki-migration-20260928.md`.

**Was steht:**

- **Datenmodell:** `wiki_pages`, `wiki_page_revisions`, `wiki_attachments` in `openclaw_core`,
  deutsche `tsvector`-Spalten (generiert, `to_tsvector('german'::regconfig, …)` — die
  einargumentige Variante wäre nur STABLE und in generierten Spalten nicht zulässig) mit
  GIN-Indizes. Dateipfade relativ zu `artifacts/personal/wiki/`.
- **Konverter** `src/modules/wiki/convert.ts`: JSPWiki-Markup → Markdown (Überschriften,
  Auszeichnung, Listen, Tabellen, Links, Code, Umbruch, Trennlinie). Plugins `[{…}]` werden
  entfernt **und gezählt** — ihre Auswertung setzt einen JSPWiki-Server voraus, also wird
  nichts stillschweigend geschluckt. Originalmarkup bleibt in `source_markup` erhalten.
- **Import** `scripts/wiki-import/import.ts`: strikt lesend, einziger POST ist die Anmeldung,
  max. 2 parallele Anfragen, Abbruch nach 2 Fehlanmeldungen, Passwortseiten werden nicht
  einmal geladen, wiederaufnahmefähig, je Slug idempotent. Ohne Zugangsdaten Exit 3 **vor**
  jeder Netzaktivität.
- **Dashboard:** Tab „Wiki" (Übersicht nach Kategorie, Volltextsuche inkl. PDF-Inhalte,
  Seitenansicht, Bearbeiten mit Revisionierung, neue Seite, Revisionsliste, Anhänge mit
  Galerie/Download/Upload). Markdown wird **serverseitig** gerendert (`marked`) und mit
  `sanitize-html` auf eine Erlaubnisliste reduziert.
- **Agententools:** `wiki_search`, `wiki_read` über `api.registerTool` — erste Nutzung dieser
  API in diesem Repo, dafür `typebox` als Dependency und `contracts.tools` im Plugin-Manifest
  (in 2026.9.1 Pflicht). Beide nur lesend.
- **Zugangsdaten shell-korrekt einlesen** (`nuveon-credentials.ts`): die Env-Datei wird mit
  `printf %q` geschrieben und ist damit shell-zitiert. Ein eigener Parser hätte `P&w!2026$x`
  als `P\&w\!2026\$x` gelesen — Login gescheitert trotz richtigem Passwort, Import nach zwei
  Versuchen gestoppt. Jetzt wertet bash die Datei aus; 18 Tests decken das ab, davon zwölf
  `printf %q`-Rundläufe mit echtem bash.

**Sicherheitsgrenze.** Sensible Seiten (erkannt über Muster für Passwort, PIN, WLAN-Schlüssel,
IBAN, API-Key …) sind für den Agenten **nicht erreichbar** — `AND sensitive = false` steht hart
in den SQL-Bedingungen von `searchForAgent`/`readForAgent`, auch für Textausschnitte aus
Anhängen. `wiki_read` antwortet für eine sensible Seite wortgleich wie für eine nicht
vorhandene. Der BITE-Test `src/modules/wiki/__tests__/agent-filter.test.ts` ist Pflicht-Test:
mit entferntem Filter fallen 7 Tests um (nachgewiesen, nicht behauptet).

**Nebenwirkungen im Bestand:**

- `scripts/verify-schema-versions.ts`: Modul `wiki` in `MIGRATION_DIRS` ergänzt. Ohne den
  Eintrag hätte der Drift-Detektor die neue DB-Version als ORPHAN gemeldet. Additiv, keine
  Aufweichung eines Gates.
- `poppler-utils` (`pdftotext`) auf dem VPS nachinstalliert — der bestehende pdf-worker
  rendert HTML→PDF und kann keinen Text extrahieren.

**Offen:** Der eigentliche Datenimport. `~/.config/openclaw/nuveon-wiki.env` existiert, beide
Variablen sind aber leere Platzhalter. Tabellen, Oberfläche und Tools sind fertig und getestet;
sobald die Zugangsdaten stehen, genügt ein Lauf des Import-Skripts.

---

## Stand 2026-09-05 — `/arm push`: armen und Push anstoßen in einem Schritt

Neue Argument-Variante des bestehenden `/arm`-Kommandos. Fix-Report:
`~/bikosoc-spec/report-bypass-armpush-*.md`.

Anlass: nach `/arm` musste der Owner den Push separat anstoßen — in der Praxis zwei Nachrichten
im Chat Hans_Dampf, zwischen denen das one-shot-Flag ungenutzt stehen bleibt.

- `/arm` **ohne Argument bleibt unverändert**: Flag `~/.armed-bikosoc` setzen, Telegram-Quittung
  „Rote Zone SCHARFGESTELLT …", kein Dispatch.
- `/arm push` armt **und** schickt anschließend „push" + Enter an die tmux-Session `bikosoc` —
  über denselben Helfer wie `/do` (`sendPromptToBikosocTmux`, `execFileSync` mit `--`-Separator,
  keine Shell). Telegram-Quittung: „Armed + push dispatched."
- Reihenfolge ist bewusst **erst armen, dann dispatchen**: schlägt der Dispatch fehl, bleibt das
  one-shot-Flag gesetzt und der Owner kann „push" selbst nachreichen. Der umgekehrte Weg liefe in
  den Red-Zone-Block. Bei Dispatch-Fehler meldet die Quittung genau das und behauptet keinen Push.
- Ein **unbekanntes Argument armt nicht** (fail-closed) — ein Tippfehler wie `/arm pusch` darf die
  Rote Zone nicht unbemerkt scharfstellen.
- Owner-Gate (`assertBoundOwner`) steht unverändert vor jeder Wirkung, für beide Pfade.

Test `src/__tests__/arm-push.test.ts` (15 Fälle): beide Pfade, Argument-Normalisierung,
Dispatch-Fehler, fail-closed bei unbekanntem Argument, Non-Owner-Negativtests für beide Pfade
(C7), exakte tmux-argv über den echten Helfer, plus statische Guards gegen `index.ts`.

C7 (Kontrollflächen-Schutz) gilt: Änderung an einer Kontrollfläche → Owner-Freigabe vor Push,
hier über `/arm` selbst.

---

## Stand 2026-09-05 — Report-Watcher: Delivered-Index race-frei

Fix fuer die Alt-Report-Schleife vom 2026-09-04 (239 Zustellungen zwischen 07:01 und 12:39 UTC
ueber nur 68 verschiedene Dateien, teils 5x). Diagnose: `~/bikosoc-spec/report-gateway-restart-1257.md`,
Fix-Report: `~/bikosoc-spec/report-watcher-index-fix-*.md`.

Der Delivered-Index `~/bikosoc-spec/.report-sent.json` wurde mehrmals taeglich komplett verloren.
Zwei Defekte griffen ineinander:

- `saveReportSentMap()` schrieb per `writeFileSync` direkt auf die Zieldatei. Der Schreibvorgang
  leert sie und befuellt sie neu — ein gleichzeitiger Leser sieht unvollstaendiges JSON. Leser gibt
  es reichlich: drei `fs.watch`-Watcher mit eigenem Debounce, und die Datei liegt selbst im
  ueberwachten `~/bikosoc-spec/`.
- `loadReportSentMap()` fiel bei *jedem* Fehler auf eine leere Map zurueck. Der Scan hielt daraufhin
  den gesamten Bestand fuer unzugestellt, lieferte aus und schrieb die fast leere Map zurueck — der
  Verlust wurde persistiert und die Schleife begann von vorn.

Behoben:

- **Atomarer Write:** `.report-sent.json.tmp` + `renameSync`. Das Ziel wird nur noch als Ganzes
  ausgetauscht. Die `.tmp`-Datei faellt nicht in die Scan-Whitelist (`report-*.md`) und wird im
  Fehlerfall entfernt.
- **Fail-closed Read:** nur `ENOENT` gilt als Erstlauf (leere Map). Lese-/Parse-Fehler und
  strukturell falsches JSON (`null`, Array, Skalar) werden geloggt und geworfen.
- **Beide Aufrufer ueberspringen ihren Lauf:** `scanAndDeliverReports()` bricht vor dem Ausliefern
  ab, `seedReportSentMap()` seedet nicht auf Basis einer unbekannten Map. Ein defekter Index legt
  die Zustellung damit still, statt den Bestand erneut zu verschicken — die Datei ist dann zu
  reparieren oder zu entfernen (Log: `sent-map defekt`/`sent-map unlesbar`).

Test `src/__tests__/report-sent-map.test.ts` (19 Faelle): spiegelt die Implementierung gegen echte
Dateien (Konvention wie `callback-suppression.test.ts`) und sichert `index.ts` zusaetzlich mit
statischen Guards gegen Drift ab. `npm test` 449 pass / 0 fail (vorher 430).

---

## Stand 2026-09-04 — OpenClaw-Upgrade 2026.6.11 → 2026.9.1

Direkt-Upgrade auf Produktion (Owner-Risikoentscheidung, kein Staging). Ablauf und Rohbelege:
`~/bikosoc-spec/report-upgrade-9.1-20260904-*.md`, Artefakte `~/upgrade-artifacts/20260904-up/`.

- **Node** 22.22.1 → 22.23.2 (NodeSource); 9.1 verlangt `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`.
  Nebenwirkung: das deb hat den global installierten npm 11.14.1 durch den gebündelten npm 10.9.8 ersetzt.
- **Core** via `openclaw update --tag 2026.9.1 --yes --no-restart`. Das Update installiert in den
  npm-Prefix des Users (`~/.npm-global`); die alte root-Installation `/usr/lib/node_modules/openclaw`
  bleibt auf 6.11 als Rückfallpaket bestehen. Die systemd-Unit wurde deshalb auf den neuen Pfad
  gezogen (ExecStart) und die Versions-Strings aktualisiert.
- **Hook-Migration:** `before_agent_start` existiert in 9.1 nicht mehr
  (`unknown typed hook ... ignored`). `index.ts` nutzt jetzt `before_prompt_build`
  (Event `{prompt, messages}`, Result `{prependContext, appendContext, systemPrompt, toolsAllow, ...}`,
  ctx unverändert mit `senderId`/`channelId`). Command-Guard, Callback-, Craft-Dialog- und
  Media-Suppression laufen unverändert über die neue Stage.
- **Config:** `plugins.entries.executive-agent.hooks.allowPromptInjection: true` explizit gesetzt —
  9.1 gated `before_prompt_build` über `allowConversationAccess` **und** `allowPromptInjection`.
- **Manifest/Package:** `entry`/`main` aus `openclaw.plugin.json` entfernt (in 9.1 keine
  Manifest-Felder), `openclaw.compat.pluginApi: ">=2026.8.1"` in `package.json` ergänzt.
- **Capability-Consent** (neu in 9.1): `openclaw plugins enable executive-agent --accept-capabilities`.
- Gates nach dem Upgrade: build 0 Fehler, verify:commands 118/118, verify-schema ohne Drift,
  `npm test` 430/0/0 (48 Dateien), Smoke 31/31, plugin-inspector gegen 2026.9.1: P0 = 0 (vorher 1).

---

## Stand 2026-07-16

Sprint 1 + 2 + 3 + 4 + 5 (5.5a + 5.5b) + 10 + 11 + 2.10-A + Owner-Memory Phase 3 vollständig abgeschlossen.

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
  2 Tabellen (health_logs, health_withings_tokens). store.ts mit 13 dbQuery,
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
  TD-3 erledigt 2026-06-25: `biko007/openclaw-banking-fints-private.git`, 5 Commits gepusht.
- **Owner-Memory Phase 3 (2026-07-06):** Fakten-Extraktion, Recall-Injektion, /memory Pflege live.

---

## Module (17)

| Modul | Pfad | Commands | DI |
|-------|------|----------|----|
| assets | src/modules/assets/ | 7 | Postgres, NK-Engine |
| banking | src/modules/banking/ | — (via routes.ts) | Postgres, Encryption, Python-Sidecar (FinTS) |
| calendar | src/modules/calendar/ | 4 | M365 |
| cc-prompt-dispatch | src/modules/cc-prompt-dispatch/ | — | tmux (execFileSync) |
| executive | src/modules/executive/ | Health Monitor, Briefing-Scheduler | — |
| fleet | src/modules/fleet/ | 10 | Links |
| health | src/modules/health/ | 14 | sendTelegramToRole, Postgres, Oura API, Withings API |
| instagram | src/modules/instagram/ | 19 | sendTelegramToRole, Meta API, Voice, Postgres |
| links | src/modules/links/ | — | Postgres |
| location | src/modules/location/ | — | Postgres |
| mail | src/modules/mail/ | 12 | M365, Yahoo, Telegram |
| memory | src/modules/memory/ | — | Postgres |
| nk | src/modules/nk/ | — (via assets) | Postgres, Playwright, Handlebars |
| pe | src/modules/pe/ | 5 | self-contained |
| prompt-inbox | src/modules/prompt-inbox/ | — | cc-prompt-dispatch, fs |
| sharepoint | src/modules/sharepoint/ | 8 | M365, Telegram, Postgres, pg_trgm |
| telegram-binding | src/modules/telegram-binding/ | — | Postgres |
| travel | src/modules/travel/ | 8 | M365, Telegram, Links |

---

## Daten-Hygiene

- `artifacts/personal/*` ist .gitignore'd. Tokens nicht mehr im Repo.
- Daten via borg auf Hetzner Storage Box gesichert (daily/weekly/monthly).
- Secrets ausschließlich in `~/.config/openclaw/env`.

---

## Postgres-User-Modell (Stand 2026-05-11)

EINE Instanz `n8n-docker-postgres-1`, zwei DBs.
- **n8n:** Bootstrap-Superuser, nur für pg_dump
- **n8n_app:** App-User für n8n-Service, nur Rechte auf n8n-DB
- **openclaw:** App-User für Core, nur Rechte auf openclaw_core
- **postgres:** Notfall-Superuser (Maintenance), Passwort in 1P

Regel: `n8n_app` niemals GRANT auf `openclaw_core` geben. Smoke-Test prüft das (`scripts/smoke-test.ts`, Check 14+15).

---

## Token Guardian (Sprint 3) — vollständig entfernt

Instagram Token-Guardian-Logik entfernt (Token-Rotation läuft via HDCC):
- `evaluateTokenAlert()` und `checkAndRefreshInstagramToken()` aus system-health.ts gelöscht
- Briefing-Scheduler Token Guardian (index.ts) gelöscht
- Startup Token Guardian (index.ts) gelöscht
- Meta-Token-Überwachung (`getTokenExpirations()`) und Briefing-Ablauf-Hinweis bereits 2026-06-28 entfernt
- Core-Endpoints `/api/instagram/token-health` + `/api/instagram/token-refresh` entfernt (2026-07-07)
- nginx-Routing für token-health/token-refresh entfernt (2026-07-07)
- `token-health.json` gelöscht, `getTokenHealth()` aus store.ts entfernt (2026-07-07)
- `initSystemHealth()` DI-Adapter + `InstaTokenAdapter` Interface entfernt (2026-07-07)
- IG-Token-Check aus `preFlightInstagram()` entfernt (2026-07-07)
- n8n-Workflow `instagram-token-health-daily` war bereits `active=false` in Live-DB

Das Instagram-Modul selbst (19 Commands, Drafts/Tokens/Style via Postgres) ist weiterhin vollständig aktiv.

---

## Instagram Status-Enum (Sprint 3)

`draft` | `review` | `approved` | `published` | `archived`

---

## Withings Sync (Sprint 4, auf weight-only reduziert 2026-06-27)

- Withings holt nur noch Gewicht + Körperfett (Sleep/Activity/Workouts/HR → Oura)
- n8n-Workflow `health-withings-sync-daily` deaktiviert (active=false)
- Core-Endpoints: `POST /api/health/withings-sync`, `GET /api/health/sync-status`
- Auth: Bearer `CORE_SERVICE_TOKEN`
- Sync-Lock: `pg_advisory_lock(42)` / `pg_advisory_unlock(42)` — verhindert parallele Syncs
- Retry-on-401: Single-Refresh-Attempt, dann Fatal-Error mit Telegram-Notify
- Token-Rotation: Transaction (UPDATE active=false, INSERT new active=true)

---

## Oura Sync (2026-06-27)

- Oura Ring = primäre Quelle für Schlaf, HRV, Readiness, Temperatur, Ruhe-HR, Schritte
- DB-Tabelle: `health_oura_tokens` (V040, ohne userid). `health_logs.external_id` (provider-neutral)
- Neue Typen in `health_logs`: `hrv`, `readiness`, `temperature` (V040 CHECK-Erweiterung)
- Sync-Lock: `pg_advisory_lock(47)` / `pg_advisory_unlock(47)`
- Retry-on-401: Single-Refresh-Attempt, dann Fatal-Error mit Telegram-Notify
- Core-Endpoints: `POST /api/health/oura-sync`, `GET /api/health/oura-sync-status`
- Telegram-Commands: `/ouraauth` (OAuth2 temp-server Port 8081), `/ourasync N`
- nginx: `/oura/callback` → 127.0.0.1:8081 (direkt zum temp-server, nicht Gateway)
- Briefing: HRV, Readiness, Temperatur werden angezeigt (D2: display only, keine neuen Alerts)
- Dashboard: HRV Summary-Card + Chart, Readiness Summary-Card
- Env-Vars: `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `OURA_REDIRECT_URI`

---

## SharePoint Sync (Sprint 10)

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

---

## Banking Session Reuse (Sprint 2.10-A)

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

---

## Banking Telegram-Trigger (kein zeitgesteuerter Auto-Sync)

Banking-Sync startet ausschliesslich manuell ueber Telegram — KEIN zeitgesteuerter Auto-Trigger.
n8n `banking-sync-daily` ist inaktiv/archiviert.

Callback-Prefixes (historisch, registriert in `CALLBACK_PREFIXES`, index.ts):
- `bweekly_start` — startet woechentlichen Banking-Sync (Keyboard-Button)
- `bsync_<runId>` — Re-Sync nach TAN-Bestaetigung

---

## Settings (Sprint 11)

- DB-Tabelle: `system_settings` (key TEXT PK, value JSONB)
- `loadSettings()` liest sync aus In-Memory-Cache (populiert beim Boot)
- `setSetting(key, value)` schreibt atomar in DB (UPSERT + audit_log in einer Transaktion)
- Cache-Refresh: Hintergrund-Intervall alle 60s
- WARNUNG: Cache ist prozesslokal (Single-Process). Bei mehreren Instanzen Cache-Drift moeglich.
- Key-Convention: snake_case im DB (`briefing_time`), camelCase im TS-Interface (`briefingTime`)

---

## Schema-Migration-Konvention (Sprint 11.5)

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
| (manual, psql) | health | V040 (Oura integration) |
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
| `src/modules/memory/migrations` | memory | 041, 042, 043 |
| `src/modules/telegram-binding/migrations` | telegram-binding | 043 |

**DR-Pfad:** `pg_dump --format=custom` als Wahrheits-Quelle, unabhaengig vom Migration-Runner.
Borg-Backup sichert den Dump taeglich.

**Drift-Detector:** `npm run verify-schema` (`scripts/verify-schema-versions.ts`).
Vergleicht SQL-Files auf Disk mit `schema_version`-Tabelle. Exit 0 = clean, Exit 1 = drift.

---

## Sprint-Roadmap

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
| Phase 3 | Owner-Memory (Extraktion, Recall, /memory, V042) | abgeschlossen |
| 6 | Fleet auf Postgres | offen |
| 7a | Banking-CSV | offen |

---

## Lessons

- **Postgres-Bootstrap-User:** `ALTER ROLE n8n NOSUPERUSER` → `permission denied to alter role`.
  Lösung: separater App-User `n8n_app` mit GRANT-Modell. Smoke-Test verhindert Rückfall.
- **python-fints fetch_tan_mechanisms() bei Reuse:** `fetch_tan_mechanisms()` setzt blind
  `set_tan_mechanism('999')`. Bei `from_data`-Restore mit bestehendem `system_id` wird
  `_ensure_system_id()` zum No-Op → kein Server-Roundtrip korrigiert den Mechanismus →
  `KeyError: '999'`. Fix: Skip bei Reuse — TAN-Mechanismus kommt aus dem gespeicherten State.
- **Mock-Sidecar ≠ Library-Edge-Cases:** Bun.serve()-Mocks validieren HTTP-Contract, fangen
  aber keine Library-Interaktions-Bugs. E2E gegen echte Bank ist unersetzlich für FinTS.

---

## Betriebsautomatisierung-Narrativ (2026-07-12, Portierung von HDCC)

- **Report-Watcher:** Ueberwacht `~/bikosoc-spec/` und `~` (Whitelist `report-*.md`).
  Neue/geaenderte Reports automatisch via Telegram zugestellt (Dokument + max 3 Text-Chunks).
  Digest (5 Zeilen, `generateDigest()`) wird dem Telegram-Text vorangestellt und oben im
  Dropbox-Upload als `## DIGEST`-Block eingebettet.
  Rate-Limit 1/min. Dedupe via `~/bikosoc-spec/.report-sent.json`.
  Erstlauf: bestehende Dateien werden in Dedupe-Map geseeded, NICHT gesendet.
  fs.watch mit 5s Debounce. globalThis-Guard `__ea_reportWatcherRegistered`.
- **Dropbox-Upload (Report + Plan Backup, ab 2026-07-17):** Reports und Plans werden zusaetzlich
  per Dropbox-API hochgeladen. Adapter: `src/adapters/dropbox.ts` (fetch-basiert, kein SDK,
  Token-Refresh + Retry). Init beim Boot via EA_DROPBOX_APP_KEY / EA_DROPBOX_APP_SECRET /
  EA_DROPBOX_REFRESH_TOKEN in `~/.config/openclaw/env`.
  - Reports → `/bikosoc-reports/<name>.md` (mit `## DIGEST`-Prefix, 5 Zeilen)
  - Plans → `/bikosoc-plans/<name>.md` (Rohinhalt, kein Digest)
  - Fremd-Strang-Plans (HDCC etc.) erreichen den Upload nie (isBikosocPlan-Filter vorgelagert).
- **Wait-Notifier (Warte-Melder):** Prueft alle 30s via `tmux capture-pane -t bikosoc` ob
  Claude Code auf Eingabe wartet. Telegram-Notification mit Preview (max 1x pro 5min, dedup
  auf Content-Hash). globalThis-Guard `__ea_waitNotifierRegistered`.
- **`/report [n]`:** Manueller Abruf von Reports. Listet alle .md in ~/bikosoc-spec/ + ~/report-*.md,
  sortiert nach mtime (neueste zuerst). Sendet als Dokument + Text-Preview.
- **`/ccstop`:** Kill-Switch fuer laufenden Claude Code in tmux bikosoc. Sendet C-c via tmux,
  dann SIGTERM an Kindprozesse. Owner-only (assertBoundOwner). Bestaetigung via Telegram.
- **`/ccgo`:** Plan-Approval in tmux bikosoc bestaetigen (Gegenstueck zu /ccstop).
  Owner-only (assertBoundOwner). Erkennt wartenden Plan-Prompt (Muster `❯ 1. Yes`), waehlt
  „Yes, and bypass permissions" (Option 1). Ohne erkannten Prompt: kein Tastendruck,
  Telegram-Meldung „kein wartender Plan-Prompt". Selftest: Prompt-Detektor, Non-Owner-Ablehnung,
  kein-Prompt-Meldung. Live-E2E (echte Plan-Bestaetigung) offen fuer naechsten REVIEW-Lauf.
- **`/do <text>`:** Sendet beliebigen Text als Prompt an die laufende cc-Session in tmux bikosoc.
  Owner-only (assertBoundOwner). Nutzt `execFileSync` mit `--` Separator (injection-sicher,
  kein Shell-Escaping). Modul: `src/modules/cc-prompt-dispatch/index.ts`.
- **Prompt-Inbox (Datei-Drop):** systemd-Timer (`prompt-inbox.timer`, 10s Intervall) pollt
  `~/inbox/*.txt`. Jede Datei wird als Prompt an tmux bikosoc dispatcht, dann nach
  `~/inbox/done/` verschoben. Report-Watcher meldet Zustellung. Standalone-Skript:
  `scripts/prompt-inbox-poll.ts`. Modul: `src/modules/prompt-inbox/index.ts`.
- **Command-Guard:** `report`, `ccstop`, `ccgo` und `do` in REGISTERED_COMMANDS. verify:commands gruen.

---

## Telegram-Binding-Narrativ (2026-07-15, Migration 043)

Hardcoded `OWNER_SENDER_ID = '133260792'` komplett entfernt. Ersetzt durch DB-basiertes
`assertBoundOwner()` via `workspace_telegram_bindings` Tabelle (Boot-Time-DDL, Migration 043).

- **DB-Tabelle:** `workspace_telegram_bindings` (binding_id, workspace_key, bot_key, role_tag,
  telegram_chat_id, telegram_user_id, chat_type, status, verification_nonce_hash, nonce_expires_at)
- **Owner-Guard:** `assertBoundOwner(ctx)` prueft ob Absender ein aktives Binding hat.
  Ersetzt alle `senderId === OWNER_SENDER_ID` Checks.
- **Sende-Target:** `sendTelegramToRole('operativ', ...)` ersetzt `sendTelegram(chatId, ...)`.
  Liest Ziel-Chat-ID aus aktivem Binding fuer die angegebene Rolle.
- **Binding-Flow:** CLI (`scripts/telegram-binding.ts create --role operativ`) → Nonce →
  `/bind <nonce>` im Telegram-Chat → aktiviert Binding.
- **parse_mode entfernt:** `parse_mode: 'Markdown'` aus allen Telegram-Sends entfernt
  (verursachte Fehler bei Sonderzeichen).
- **Modul:** `src/modules/telegram-binding/index.ts`

---

## Location-Staleness-Alert (2026-06-26)

Health-Monitor (`src/modules/executive/health-monitor.ts`) prüft im 5-min-Polling-Zyklus den
jüngsten `location_events.recorded_at`. Schwellwert: `LOCATION_STALE_THRESHOLD_MS` (12h, exportiert).
- fresh→stale: ein WARN
- Wiedervorlage alle `LOCATION_STALE_RENAG_MS` (24h) solange stale
- stale→fresh: eine Entwarnung
- Leere Tabelle: kein Alert, kein Crash
- `evaluateLocationStaleness()` als reine Funktion, getestet in `__tests__/stale-location.test.ts`

---

## Withings Sync-Konsolidierung (2026-06-26)

Root Cause: Cursor-Poisoning (`syncWithingsForBriefing()` setzte `last_sync = NOW` obwohl nur
Weight/Sleep geholt) + n8n 404 (fehlende nginx-Location). Fix: eine `runWithingsSync()` Routine
für alle Pfade, alle 3 Caller routen durch `executeWithingsSync` (Lock 42 + Retry-on-401),
`/healthsync N` ehrt N wörtlich (toter `last_sync`-Zweig entfernt), n8n-Workflow deaktiviert.
Briefing-Fehler werden geloggt + in `last_sync_error` persistiert (nicht mehr lautlos verschluckt).

---

## Oura Ring Integration (2026-06-27)

Oura Ring als primäre Quelle für Schlaf, HRV, Readiness, Temperatur, Ruhe-HR. Withings auf
Gewicht+Körperfett reduziert. 10 Etappen (V040 Migration, types, store, oura.ts, commands,
exports, briefing+routes, dashboard, nginx, tests). Advisory-Lock 47.
Schema: `health_logs.withings_id` → `external_id` (provider-neutral), neue CHECK-Werte
(hrv, readiness, temperature, oura).

---

## Message-Sink / Conversation Log (2026-07-02)

Baustein 1 fuer dynamisches Gedaechtnis. `agent_end`-Hook persistiert jeden
erfolgreichen Owner-Telegram-Turn (User-Text + Agent-Antwort) in `conversation_log`.
Fire-and-forget: Schreibfehler loggen WARN, blockieren nie den Agenten.

- DB-Tabelle: `conversation_log` (Migration 041, Modul `memory`, Boot-Time-DDL)
- Hook: `agent_end` in index.ts (feuert NACH Antwortversand)
- Voice: Transkript via `resolveTranscript()` — parst `[Audio transcript ...]: "..."` aus `firstUser.content`
- Store: `src/modules/memory/store.ts` (`insertConversationTurn()`)

---

## Owner-Memory Phase 3 (2026-07-06)

Dynamisches Gedaechtnis: EA lernt aus Owner-Konversationen. Voice-Transkripte im Klartext
persistieren, Fakten extrahieren, bei kuenftigen Nachrichten injizieren, Pflege via /memory.

- DB-Tabellen: `conversation_log` (erweitert), `owner_memory` (Migration 042)
- Advisory-Lock: `pg_advisory_lock(48)` fuer Sweep-Serialisierung
- Extraktion: `shouldExtractMemory()` Guard, `extractFacts()` LLM-gestuetzt,
  max 5 Fakten/Turn, 200 Zeichen/Fakt, temperature 0.2. Dedup: Unique Index + LLM-Abgleich.
- Sweep: `runExtractSweep()` alle 60s, `pg_advisory_lock(48)`, max 3 Versuche
- Recall: Branch 7 in `before_agent_start`, max 50 Fakten / 4 KB
- Pflege: `/memory list`, `/memory drop <id>` (Bestaetigungs-Button, `memdrop_` Callback)
- Log-Disziplin: Journal loggt nur IDs, Counts, Fehlerklassen — keine Fakten-Klartexte
- Dateien: `src/modules/memory/extract.ts`, `src/modules/memory/store.ts`, Migrations 041/042/043

---

## NK-Obligations-Alert (systemd-Timer, ab 2026-07-13)

Taeglich 07:00 UTC prueft der systemd-Timer `openclaw-nk-obligations-daily` alle
NK-Perioden-Verpflichtungen auf ablaufende Fristen und sendet Telegram-Alerts.

- **Timer:** `~/.config/systemd/user/openclaw-nk-obligations-daily.timer` (OnCalendar 07:00, Persistent)
- **Service:** oneshot-curl auf `POST /api/internal/nk-trigger/obligations-alert` (Bearer CORE_SERVICE_TOKEN)
- **Schwellwerte:** 30d (info), 14d (warn), 7d (warn), 1d (error), expired (error)
- **Idempotenz:** UNIQUE constraint auf `(obligation_id, alert_phase, alert_date)`
- **Entscheidung:** systemd-Timer statt n8n-Workflow (n8n als Docker-Container fragil)

---

## Armed-Flag-Fix (2026-07-20)

Bug: `deny-destructive.sh:85` prüfte `~/.armed-hdcc`, aber `/arm` (index.ts) legte `~/.armed-bikosoc` an.
Fix: Hook-Zeile 85 → `ARMED_FLAG="$HOME/.armed-bikosoc"`. Bite-Test bestätigt: Push-Through bei Flag, Block ohne.
