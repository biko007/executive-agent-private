# cc-Übergabe — Stand 19.10.2026, 11:40

Diese Datei ist der **erste Lesestoff der nächsten cc-Sitzung nach einem
`/clear`**. Sie löst `cc-Uebergabe-20261016.md` ab; was dort noch offen war und
inzwischen erledigt ist, steht hier nicht mehr. Was in Git-Historie, CHANGELOG
oder TODO ohnehin steht, ist nicht wiederholt.

**Vorgänger:** `docs/projekt/cc-Uebergabe-20261016.md` (mit Nachtrag 17.10.) —
dort stehen die V043-Werte, der Dropbox-Umstieg und das Agenten-Backend
ausführlich. Beides zusammen lesen, wenn es um diese drei Themen geht.

---

## 1. Was auf den Owner wartet

| Was | Wo | Seit |
|---|---|---|
| **7 Mailentwürfe prüfen und senden** | Postfach `juergen.bickel@bikolino.com`, Ordner Entwürfe | 16./19.10.2026 |
| **Vier Portale abrufen** — DATEV Arbeitnehmer online (Lohnsteuerbescheinigung 2025), comdirect PostBox, ING-Postbox, Meine LKH | nur per Login erreichbar, keine Mail möglich | 19.10.2026 |
| **ads-tec: Controller-Verbleib klären** | der Entwurf liegt bereit, Frist 23.10.2026 | 19.10.2026 |
| **V043 anwenden + Steckbrief befüllen** | Owner gibt `/arm`, dann cc | 16.10.2026 |
| **Rettenbacher 120 € ab 01.03.2025** | undokumentierte Erhöhung; nichts angefasst | 16.10.2026 |
| **Gebäude-/Bodenanteil** | Anfrage an den Steuerberater ist auf Owner-Weisung **unterblieben** | 16.10.2026 |
| **`artifacts/personal/fleet/vehicles.json` löschen?** | Datenlöschung, bleibt Owner-Sache | TODO.md |
| **Alte Dropbox-Zugangsdaten freigeben** | frühestens **23.10.2026**, siehe Abschnitt 5 | 16.10.2026 |
| **B&S BauKult: woher kommt die Zinszahl 2025?** | keine Quelle in keinem System | 19.10.2026 |
| **DZ Privatbank: besteht das Depot noch?** | nur über die Volksbank Donau-Neckar klärbar | 19.10.2026 |

**Die sieben offenen Entwürfe** (alle `isDraft=true`, reiner Text, ohne Anhang):

| angelegt | Betreff (gekürzt) | An |
|---|---|---|
| 16.10. 09:16 | Versicherungsscheine Gebäudeversicherung – Bitte um aktuellen Stand | Vohrer |
| 19.10. 09:19 | Case 2985 / Auftrag 8000002257 – Controller bezahlt … Frist 23.10.2026 | K.Sulejmani@ads-tec-energy.com |
| 19.10. 09:28 | Vertrag 6550287 – Basisrentenbeiträge 2025 | scp@alte-leipziger.de |
| 19.10. 09:28 | Vertrag 70 747173605 – Steuer- und Beitragsbescheinigung 2025 | lebenprivatkunden@ruv.de |
| 19.10. 09:28 | Vertrag P 10 224 730-5 – Beitrags-/Steuerbescheinigung 2025 | hus-vertrag@wgv.de |
| 19.10. 09:28 | Vertrag 34304014 001 – 2025 gezahlte Beiträge | service@axa.de |
| 19.10. 09:28 | Referenznummer 9502432722 – Jahressteuerbescheinigung 2025 | deutsche.bank@db.com |
| 19.10. 09:28 | EEG-Abrechnungen 2025 – abc-raum und Nonnenburgstraße 24 | vertrieb@swtenergie.de |

Beim Stadtwerke-Entwurf ist das **Cc-Feld bewusst leer**: Eine Mailadresse von
„Herrn Haus" ist nicht ermittelbar, und bei einer Mail nach außen wird nicht
geraten.

**Die zwei Canopy-Entwürfe vom 19.10. sind nicht mehr im Ordner — der Owner hat
sie um 09:01 gesendet.**

---

## 2. Stand der Repositories

**Alles gepusht** (Prüfung 19.10.2026, 11:40: vier Repos, je 0 unpushed).

| Repo | Branch | HEAD | lokal geändert |
|---|---|---|---|
| `executive-agent` | `master` | `803731e` | nein |
| `executive-dashboard` | `master` | `7789194` | nein |
| `openclaw-banking-fints` | `master` | `93e6ec2` | nein |
| `hdcc` | `main` | `72f0fce` | **ja, 2 Dateien** |

**Die zwei offenen Dateien in `hdcc`** sind nicht von cc in dieser Sitzung
angefasst worden und gehören nicht zu bikosoc:
`M scripts/backfill-transcript-status.ts` und
`?? scripts/refresh-ig-token.ts`. **Nicht blind committen** — erst klären,
woher sie kommen.

**Die 17 Commits der letzten 48 Stunden** (alle in `executive-agent`, dazu
einer im Dashboard) — das ist der inhaltliche Zuwachs seit der letzten
Übergabe:

```
803731e 18.10. 21:41 docs(todo): Dropbox-Vollzugriff eingerichtet, Stichtag 23.10.
f7c83bb 18.10. 21:24 fix(steckbrief): keine eingefrorene Prozentzahl bei der Rendite
f87e413 18.10. 20:51 docs(steckbrief): warum der Energieausweis L19 fehlt
c48869c 18.10. 19:58 docs: welche Postfaecher Graph erreicht
128b520 18.10. 19:35 chore(reise-import): Unit-Beschreibung
3c03388 18.10. 19:34 fix(reise-import): aus /Austausch/reisen lesen
a75a40c 18.10. 19:14 feat(reise-import): Reisedateien aus Dropbox uebernehmen
fe2a79b 18.10. 18:30 feat(mail-register): Weiterleitungen an data@ nach Dropbox
ee0eefe 18.10. 15:23 feat(mail-register): Sammelstelle data@bikolino.com
2d9b842 18.10. 14:46 prompt-inbox: Kennung eines Mail-Auftrags
699cf37 18.10. 14:08 mail-eingang: Laufzeitdaten nach artifacts/personal
1a9c182 18.10. 14:07 feat(mail-eingang): Eingangskanal des Owners per E-Mail
b691dd9 17.10. 23:52 docs: Aufteilung der Yahoo-Ablage
bbb71ec 17.10. 23:52 yahoo: Ablage in Jahresordner aufteilen und gegenpruefen
5bd9459 17.10. 18:15 docs: Postfach-Inventar in ARCHITECTURE
1974c07 17.10. 18:15 mail: Kopfdaten eines Postfachs einsammeln
6237ed4 17.10. 16:22 Fuhrpark: Symbol und Pruefungsname je Fahrzeugart
7789194 18.10. 19:14 feat(dashboard): Reisen-Tab (executive-dashboard)
```

---

## 3. Dienste und Timer — Stand 19.10.2026, 11:34

**Alles, was laufen soll, läuft.** Geprüft mit `systemctl --user`.

| Einheit | Zustand | Takt | letzter Lauf |
|---|---|---|---|
| `mail-eingang.timer` | **active, enabled** | 5 min | 19.10. 09:29 |
| `mail-register.timer` | **active, enabled** | 5 min | 19.10. 09:30 |
| `reise-import.timer` | **active, enabled** | 10 min | 19.10. 09:25 |
| `prompt-inbox.timer` | active | 10 s | laufend |
| `docs-mirror.timer` | active | täglich 04:30 | 19.10. 02:31 |
| `openclaw-sharepoint-sync.timer` | active | täglich | 19.10. 02:40 |
| `openclaw-nk-obligations-daily.timer` | active | täglich 09:00 | 19.10. 07:00 |
| `openclaw-backup-daily/weekly/monthly` | active | täglich/wöchentlich/monatlich | 19.10. 03:04 |

**Zwei Dinge, die man leicht falsch sucht:**

- **Der Report-Watcher ist kein eigener Dienst.** Er läuft im
  **`openclaw-gateway.service`** (`index.ts`, Abschnitt „Report Watcher",
  ab Zeile ~3640). `systemctl --user status report-watcher` liefert
  `not-found` — das ist kein Fehler.
- **Die Fristüberwachung ist ebenfalls kein eigener Timer.** Die
  Fahrzeug- und Objektfristen hängen am Digest im Gateway (60-Tage-Fenster
  für den Fuhrpark) und an `openclaw-nk-obligations-daily.timer` für die
  NK-Pflichten.
- **Die bikosoc-Einheiten liegen unter `~/.config/systemd/user/`, nicht
  unter `/etc/systemd/system/`.** Dort stehen nur `hdcc-cc-idle`, `n8n`,
  `ibgateway`, `xvfb`. Wer mit `systemctl` ohne `--user` sucht, findet nichts.

---

## 4. Offene technische Punkte

### 4.1 Deny-Hook: kein Rückfall auf das Arbeitsverzeichnis

`~/.claude/hooks/deny-destructive.sh` löst bei `git push` den Repo-Pfad aus
dem Befehl auf — entweder aus `git -C /abs/pfad` (mehrzeilig möglich) oder aus
einem vorangestellten `cd /pfad`. **Findet er keinen, greift fail-closed:**

```
RED_ZONE_HIT="git push: Repo-Pfad nicht auflösbar"
RED_ZONE_FAILCLOSED=true
```

Ein nacktes `git push` im bereits richtigen Arbeitsverzeichnis wird also
blockiert. **Der naheliegende Rückfall — Arbeitsverzeichnis des Hooks per
`git rev-parse --show-toplevel` — ist nicht eingebaut.** Praktische Folge:
Pushes immer als `git -C /abs/pfad push` schreiben. Eine Änderung am Hook ist
**Rote Zone** und braucht Owner-Freigabe.

### 4.2 Watcher-Versandprüfung (C7-pflichtig)

Der Report-Watcher merkt sich je Dateiname den Zeitpunkt der Zustellung in
`~/bikosoc-spec/.report-sent.json` und vergleicht **`st.mtimeMs > lastSent`**.

**Die Folge, die in dieser Sitzung dreimal zugeschlagen hat: Wer eine schon
zugestellte Reportdatei nachträglich bearbeitet, löst eine erneute Zustellung
aus.** Der Owner hat einen Report dreifach und einen zweifach bekommen.
Dazu greift `REPORT_RATE_MS = 60_000` — höchstens eine Datei je Minute, der
Rest wird mit „Rate-limited, deferring" verschoben.

**Stehende Arbeitsregel daraus:** Korrekturen gehören in einen **neuen**
Report, nicht in einen bereits zugestellten.

**Offen:** ob der Vergleich auf einen Inhalts-Hash umgestellt werden soll,
damit eine Tippfehlerkorrektur keine Zustellung auslöst. Jede Änderung an
dieser Stelle ist **review- und negativtestpflichtig (C7)**; der Bestand an
Tests liegt in `src/__tests__/report-sent-map.test.ts`.

### 4.3 Codex/OAuth — Ablauf 26.10.2026 17:24 UTC

Die Anmeldung des Agenten-Backends ist am 16.10.2026 17:24 UTC erneuert worden
und gilt **zehn Tage, also bis 26.10.2026 17:24 UTC** (`~/.codex/auth.json`,
Feld `exp` des Zugangstokens). Der Smoke-Test (Abschnitt 18) schlägt an,
sobald **weniger als drei Tage** bleiben — das ist der **23.10.2026, 17:24
UTC**. Er liest nur das Ablaufdatum, nie den Token.

**Agentenpfad läuft** (Korrektur 19.10.2026, 12:00 — die erste Fassung dieses
Abschnitts hatte den Stand vor dem 16.10. 18:00 übernommen):

- `codex-cli` **0.163.0** (`codex --version`), gehoben am 16.10.2026
  (`report-codex-cli-update-20261016.md`); OpenClaw unverändert **2026.9.1**.
- `openclaw models status`: Standardmodell `openai/gpt-5.6-sol`, Route
  „openai via codex … status=usable", **keine „Model route issues"**.
- Probelauf 18.10.2026 23:39/23:40 UTC: `result: success`,
  `authMode: auth-profile` — über die OAuth-Anmeldung, ohne API-Schlüssel
  (`report-auftrag-codex-cli-update-20261019.md`).
- Smoke: **ALL PASS 37/37** im Lauf vom 19.10. (gleicher Report); die
  Abschnitte 18 und 19 am 19.10. 12:00 erneut nur lesend nachvollzogen: beide grün.

**Einzig offen:** die erneute Anmeldung (`codex login`) vor dem 26.10.2026 —
der Smoke meldet sich ab dem 23.10.

### 4.4 Alte Dropbox-App — Stichtag 23.10.2026

Der Vollzugriff über `BikosOpenClawFA` läuft seit 16.10.2026, 18:49. Nach
Owner-Vorgabe wird das Entfernen der alten Werte **erst nach sieben
fehlerfreien Tagen** vorgeschlagen — **ab 23.10.2026**. Zu entfernen wären
dann `EA_DROPBOX_APP_KEY`, `EA_DROPBOX_APP_SECRET` und
`EA_DROPBOX_REFRESH_TOKEN` in `~/.config/openclaw/env` und danach der
Rückfallzweig in `src/adapters/dropbox-zugang.ts`. **Beides nur mit
ausdrücklicher Freigabe — die env-Datei ist Rote Zone.** Betriebsbilanz am
18.10. (Tag 3 von 7): 123 Report-Uploads erfolgreich, 0 fehlgeschlagen; ein
einziger Fehler im `dropbox-inbox.service` am 17.10. (HTTP 500, vorübergehend).

---

## 5. Datenänderungen seit dem 16.10.2026

**Eine Datenbankänderung** (Korrektur 19.10.2026, Nachprüfung
privatausgaben-bericht): Am **18.10.2026 um 15:06** wurden die beiden
Kreditkarten importiert — `banking_accounts` id **108/109**, **317 Zeilen**
in `banking_transactions` mit `source = 'kk_pdf_import'`, Audit **2712**
(Auftrag privatausgaben-runde2). Rückweg:
`delete from banking_transactions where source = 'kk_pdf_import';` dann
`delete from banking_accounts where id in (108, 109);`. Sonst waren die
Aufträge vom 17. bis 19.10. Recherche, Prüfung und Dokumentenbeschaffung.

| Wann | Was | Umkehrbar durch |
|---|---|---|
| 17./18.10. | **Yahoo-Ablage in Jahresordner aufgeteilt** — 54.691 Nachrichten verschoben, gegengeprüft, nichts verloren (Commit `bbb71ec`) | IMAP-Rückverschiebung, Protokoll in Dropbox `transfer/postfach/yahoo/verschiebung/` |
| 18.10. | **mail-eingang, mail-register, reise-import** eingerichtet und aktiv | Timer deaktivieren |
| 18.10. | M365: Ordner **`Posteingang/Proton`** angelegt (HTTP 201) | Ordner löschen |
| 18.10. | Proton-Weiterleitung auf `data@bikolino.com` aktiv (Bestätigung 18.10. 15:10) | in Proton abschalten |
| 19.10. | **9 Entwürfe** im Postfach angelegt; 2 davon hat der Owner gesendet | Entwürfe löschen |
| 19.10. | Dropbox `/Austausch/canopy/` — 4 Belege (2,9 MB) | Ordner löschen |
| 19.10. | Dropbox `/Austausch/adstec/` — 4 Belege (1,73 MB) | Ordner löschen |
| 19.10. | Dropbox `/Austausch/steuer-2025/` — 2 Belege (2,01 MB) | Ordner löschen |
| 19.10. | Dropbox `transfer/volksbank/2025/` — 12 Kontoauszüge mit den Originalnamen der Bank (976 kB) | Ordner löschen |
| 19.10. | Dropbox `/Austausch/l19-nk2025-kostenrohliste-20261019.csv` (7,4 kB) | Datei löschen |
| 17.–19.10. | ~50 Reports in `~/bikosoc-spec/`, gespiegelt nach Dropbox | Dateien löschen |

**In SharePoint wurde nichts geschrieben.** Dateien wurden ausschließlich
gelesen. Die Ablage dort bleibt bis zu einer Owner-Freigabe gesperrt.

---

## 6. Eigenheiten und Fallen

Das hat in dieser Sitzung Zeit gekostet — jede Zeile ist belegt:

**Umgebung und Datenbank**

- `set -a; . /home/biko/.config/openclaw/env; set +a` **vor jedem** Skript.
  Ohne das fehlen alle Zugänge, und der Fehler sieht nach einem
  Berechtigungsproblem aus.
- Die Graph-Schlüssel heißen **`M365_TENANT_ID` / `M365_CLIENT_ID` /
  `M365_CLIENT_SECRET`** — nicht `EA_MS_*`. Falsche Namen erzeugen ein
  `InvalidAuthenticationToken`, das wie ein abgelaufener Token aussieht.
- Die Umsatztabelle heißt **`banking_transactions`** (nicht
  `bank_transactions`), die Spalten **`amount`** als `numeric` (nicht
  `amount_cents`) und **`counterparty_name`**. Weitere Fallen aus dieser
  Sitzung: `expected_amount` statt `amount_due`, `last_modified_at` statt
  `last_modified`, `reference` statt `purpose`, `vehicle_code` statt `code`;
  `bank_name` gibt es nicht. In Joins sind `id` und `status` mehrdeutig —
  immer qualifizieren.
- `LIKE` kann an einem **eingebetteten Wagenrücklauf** scheitern, wenn ein
  Textfeld aus einem Import stammt (`'(belegt\r)'`).

**Microsoft Graph**

- `$filter=contains(subject,…)` wird mit **`InefficientFilter`** abgelehnt.
  `$search="…"` funktioniert, ist aber **unscharf** — „ING" trifft „Klasing"
  und „Mahnung". Für belastbare Treffer **`$search="from:domain.tld"`**
  verwenden oder das Vollinventar in Dropbox auswerten.
- `itemAttachments` brauchen
  `$expand=microsoft.graph.itemAttachment/item`, sonst fehlt der Inhalt.
- **Die Vollinventare sind die bessere Quelle als jede Suche:**
  `transfer/postfach/postfach-inventar-vollstaendig.csv` (13.938 Zeilen, M365)
  und `transfer/postfach/yahoo/yahoo-inventar-vollstaendig.csv` (58.706
  Zeilen, Yahoo, mit Anhangsnamen). Beide in Dropbox, greifbar mit
  `downloadFile` und `grep`.

**Yahoo / IMAP**

- `ImapFlow` mit `getMailboxLock(box, { readOnly: true })` und `BODY.PEEK`
  lesen, dann entsteht **kein Lesevermerk**. Das ist bei jedem Lesezugriff
  einzuhalten.
- `tail -40` auf eine Ordnerliste kann eine Zeile abschneiden und den
  Eindruck erzeugen, ein Ordner sei gelöscht. Gegenprobe immer mit `STATUS`.

**Dropbox**

- **Es gibt zwei parallele `transfer`-Bäume:**
  `/Apps/bikosoc-reports/transfer/` (8 Ordner) und
  `/Apps/bikosoc-reports/bikosoc-reports/transfer/` (21 Einträge). Gleiche
  relative Namen, **verschiedener Inhalt.** Vor jedem Zugriff prüfen, welcher
  gemeint ist.
- `dropboxZugang()` arbeitet mit Präfix `/bikosoc-reports`,
  **`dropboxVollzugang()` ohne Präfix** — nur damit ist `/Austausch`
  erreichbar. Der Adapter liegt in `src/adapters/dropbox-zugang.ts`, die
  Methoden sind `uploadFile({path, body, contentType})`, `downloadFile`,
  `listFolder`, `createFolder`, `moveFile`. **Eine `search`-Methode gibt es
  nicht** — `listFolder` rekursiv verwenden.
- Einträge aus `listFolder` tragen **`tag`**, nicht `['.tag']`. Wer auf
  `['.tag']` prüft, hält jeden Ordner für eine Datei der Größe 0.
- Die automatische Doku-Spiegelung legt nach
  **`/bikosoc-reports/docs/repo/<repo>/…`** ab (post-commit-Hook plus
  `docs-mirror.timer`).
- **Die Spiegelung ist nicht rekursiv.** `src/modules/docs-mirror/index.ts`
  nimmt `CLAUDE.md`, `README.md` und alle `*.md` **direkt** in `docs/` und
  `governance/` — **Unterordner nicht**. Diese Übergabe liegt in
  `docs/projekt/` und wird daher **nicht automatisch gespiegelt**; sie muss
  von Hand nach Dropbox geladen werden. Geprüft am 19.10.2026: im
  Spiegelpfad liegt kein `docs/projekt` — auch der Vorgänger vom 16.10. war
  dort nie angekommen.

**NK-Engine (unverändert gültig)**

- `computeNk(propertyId, year, isFinalizeMode=false)` rechnet ohne zu
  schreiben; `nkPreCheck` davor.
- `allocateBySqm()` nutzt **`living_area_qm`**, niemals
  `allocation_area_qm`.
- `calculateAdvances()` fällt auf die Lease-Felder **nur dann** zurück, wenn
  **keine** `lease_charges`-Zeile existiert.
- `loadEngineInput` lädt `meters.*` und `units.*` **einschließlich `notes`
  und `updated_at`** — eine Textänderung verändert damit den `input_hash`.
- Im Eigenanteil-Zweig von `src/modules/nk/engine.ts` steht der **irreführende
  Kommentar** „Simplified: for other key types, use unit count fallback". Ein
  solcher Rückfall existiert nicht. Nicht darauf verlassen.

**Objektnamen**

- Intern **nur die Kürzel** (MG24, N24, L19, S28, I83, D4, MG22, ZZ5, abc),
  extern ausgeschrieben. **Fremde Originale werden nie umbenannt** — das
  betraf in dieser Sitzung die 12 Kontoauszüge der Volksbank, die zuerst
  sprechende Namen bekommen hatten und wieder zurückbenannt wurden.

---

## 7. Ablageorte

| Ort | Inhalt |
|---|---|
| `~/bikosoc-spec/` | alle Reports; `.report-sent.json` ist die Zustell-Merkliste |
| Dropbox `/Austausch/` | **der Ordner, in dem Owner und Assistent arbeiten** |
| Dropbox `/Austausch/canopy/` | 4 Belege zum Aktien-/Optionsübertrag (W-8BEN, Maxim-Formular, Upload-Screenshot, Optiontrax-Anleitung) |
| Dropbox `/Austausch/adstec/` | Angebot 6000001016, unterschriebene Beauftragung, Rechnung 90002635, Zahlungsnachweis |
| Dropbox `/Austausch/steuer-2025/` | EEG-Vorjahresabrechnung mit den Anlagendaten, Jahresmeldung SV 2025 |
| Dropbox `transfer/volksbank/2025/` | 12 Kontoauszüge mit den Originalnamen der Bank |
| Dropbox `transfer/postfach/` | die beiden Postfach-Vollinventare und alle Register |
| Dropbox `/bikosoc-reports/docs/repo/` | automatische Spiegelung der Repo-Dokumentation — **ohne Unterordner**, also ohne diese Übergabe |
| Dropbox `/Austausch/docs/projekt/` | **die Übergaben**, von Hand gespiegelt (19.10. und 16.10.) |
| SharePoint `8_Jürgen Bickel privat/2-Finanzen/Steuerdokumente/<Jahr>/` | Steuerordner — **nur lesen, Ablage erst nach Owner-Freigabe** |

---

## 8. Stehende Regeln

1. **Nie senden. Nur Entwürfe.** Keine Mail verlässt das System durch cc.
   Erlaubt sind `createMessage`, `createReply` und `PATCH`; ein `send`-Aufruf
   kommt in keinem Skript vor.
   *Nachtrag 26.10.2026, zurückgenommen am 27.10.2026:* Die Ausnahme für das
   Abendbriefing an das eigene M365-Postfach gibt es nicht mehr — das
   Abendbriefing kommt nur per Telegram, `briefing/mail.ts` ist entfernt
   (CLAUDE.md §8). Es gilt die Regel ohne Ausnahme.
2. **Jeder Mailvorschlag des Chats wird gleich als Entwurf angelegt**
   (Owner-Regel vom 19.10.2026). Der Chat erteilt den Auftrag, cc legt an, cc
   sendet nie. Nach dem Anlegen wird der Entwurf **wieder ausgelesen und
   gegengelesen**: `isDraft=true`, Empfänger, Betreff, Klartext/UTF-8, keine
   Anhänge, Zitattext entfernt — und die Gesendeten Elemente geprüft.
3. **Datenbankschreiben nur mit Freigabe.** Lesen, Rechnen und Prüfen jederzeit;
   `INSERT`/`UPDATE`/`DELETE` erst auf ausdrückliche Weisung, mit Rückweg-SQL
   im Report.
4. **Rote Zone nur mit `/arm`.** Dazu gehören `~/.config/openclaw/env`, die
   Hooks, Migrationen und alles, was der Deny-Hook abfängt.
   `docs/projekt/Arm-Freigabe.md` beschreibt den Ablauf.
5. **Korrekturen gehören in einen neuen Report**, nie in einen bereits
   zugestellten (Abschnitt 4.2).
6. **Jeder Report trägt den Kopfblock** (`titel`, `status`, `aufgabe`,
   `ergebnis`, `aktion`, `tests`, `rote_zone`, `dauer_min`, dazu
   `durchsuchte_quellen`) und die Abschnitte „Rote Zone berührt",
   „Datenänderungen", „Rückweg", „Owner-Aktion", „DIGEST".
7. **Recherchereihenfolge, vollständig und nicht bis zum ersten Treffer:**
   bikosoc-Datenbank → SharePoint-Index → Postfach M365 → Dropbox. Die
   abgefragten Quellen stehen mit Datenstand im Reportkopf.
8. **Keine vollständigen Konto-, Depot- oder Steuernummern in Reports** —
   höchstens die letzten vier Stellen. In Mailentwürfen an das jeweilige Haus
   sind die vollen Nummern erlaubt und nötig.

---

## 9. Fachstand, der nicht im Code steht

Die drei Vorgänge, an denen die nächste Sitzung wahrscheinlich weiterarbeitet:

**ads-tec / Batteriespeicher Sannicandro.** Auftrag vom 13.07.2026 über
3.836,80 €, Rechnung erst am 30.09., bezahlt am 04.10.2026 mit 3.515,26 €.
Zwei Dinge fehlen: die beauftragten **2 Stunden Remote Support** (321,30 €)
stehen nicht auf der Rechnung, und es gibt **keinen Beleg, wo der Controller
ist** — die Rechnung nennt „EXW Klipphausen", das Angebot Neuhausen ob Eck.
Der gelieferte Controller ist ausdrücklich **refurbished**. Rechnungsempfänger
ist die **Bikolino GmbH**, gezahlt hat das **private** Konto …0028.
Alles in `report-adstec-controller-20261019.md`.

**Canopy / Übertrag auf das UBS-Depot.** Shareworks ist seit dem 31.08.2026
geschlossen, Empower hat am 28.09.2026 abgebrochen, Verwahrer der Stammaktien
ist **Maxim Group**. Eine verschlüsselte Dokumentenanforderung von Morgan
Stanley vom **25.08.2026 ist unbearbeitet**. Für 2025 sind **zwei
RSU-Vestings** signalisiert (08.06. und 15.08.), **ohne jede Zahl** in den
Mails — der nächstliegende Weg führt über die Lohnabrechnung.
`report-canopy-shares-ubs-20261019.md` und der Nachtrag.

**Steuer 2025.** Elf Belege fehlen; **keiner liegt in Mail oder Dropbox**,
acht gibt es nur im Kundenportal. Geklärt ist: Arbeitgeber **Storz & Bickel
GmbH**, Beschäftigung **01.01.–31.12.2025**, SV-Entgelt **96.600 €** (das ist
die Beitragsbemessungsgrenze, also gekappt). **PV abc-raum: 20,09 kWp**, in
Betrieb seit 31.10.2012; ZZ5: 29,75 kWp. Für eine Anlage von 2012 gilt nach
§ 52 Abs. 4 Satz 29 EStG **nicht** die heutige 30-kWp-Fassung des § 3 Nr. 72
EStG. Die **LKH-Beitragsrückerstattung von 1.792,02 €** ist am 24.10.2025
zugeflossen und mindert die Vorsorgeaufwendungen 2025.
`report-steuer-2025-fehlende-belege-20261019.md` und
`report-steuer-2025-anforderungsmails-20261019.md`.

**Kreditkarten — geklärt bis auf eine Karte** (Korrektur 19.10.2026; die
frühere Fassung „Faktor 7, unbekannter Zahlungskanal" beruhte auf zwei
Rechenfehlern). Die Karten **…6047 und …7303** kosten netto **81.081,02 €**
(96.405,04 € Belastungen minus 15.324,02 € Gutschriften) und werden laut
Mandatsreferenz von einem **nicht angebundenen Konto** eingezogen — sie sind
also zusätzliche Ausgaben und im Burn der Runde 2 (887.481 €) bereits
enthalten. Die „VISA Abrechnung" im Giro 107 sind **16 Belastungen über
27.901,63 €** (nicht 14.691 €) und gehören zu einer **dritten Karte …6411**,
von der keine Abrechnungen vorliegen. LinkedIn und FOCUS stehen in keinem
Konto — vermutlich über …6411 bezahlt (Schluss, nicht belegt); beide sind
inzwischen gekündigt (29.08. bzw. 08.10.2026).
`~/bikosoc-spec/report-auftrag-privatausgaben-bericht-20261019.md`.
