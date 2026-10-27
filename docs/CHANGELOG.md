# OpenClaw Executive Agent — Changelog

Sprint-Historie und Feature-Narrative. Aktuelle Regeln und Betriebsstatus: CLAUDE.md.

---

## Stand 2026-10-27 (5) — Neuheiten-Sekretariat Stufe 1

Spec Neuheiten-Sekretariat v1 (Owner-Freigabe 12:11). KI-Bewertung je Neuheit mit
Kontext (claude-sonnet-4-6), Vorgänge (Thread hart, sonst KI), zweites Netz,
Statuskette mit Alarm, Nicht-relevant-Ablage, Kostenprotokoll, Deckel 60/h.
Migration `vorgaenge`/`vorgang_elemente` angemeldet (Rote Zone), bis dahin JSONL.
Tests: `sekretariat.test.ts` (35).

Review-Befunde behoben (c5bea9e, ab17afe): abbruchfeste Statuskette, Deckel je
API-Aufruf, drei Versuche dann Einzelmeldung, Thread vor Relevanz (nur direkter
Verweis), IBAN-Maskierung in Prompt und Antwort, Gesundheit über den ganzen Text,
Mieter ohne Mail im Kontext und ohne Namen in Report/Telegram, Einstellung nur bei
`modus: "ki"` aktiv, Abgleich Register ↔ Sekretariat.

## Stand 2026-10-27 (4) — Report-Watcher holt zurückgestellte Reports selbst nach

Owner-Freigabe 27.10.2026 ~11:37 (Vorschlag aus report-admin-kanal-20261026.md).

- Rate-Limit-Zweig plant einen Nachlauf zum Ende der Minute
  (`erzeugeNachlauf` in `src/modules/report-telegram`); vorher blieb ein
  zurückgestellter Report bis zum nächsten Dateiereignis liegen.
- Ein Scan-Auslöser während eines laufenden Scans wird vermerkt und nachgeholt.
- Rate-Limit (1/min), Reihenfolge (älteste zuerst) und Doppelschutz (sentMap)
  unverändert. Tests: `nachlauf.test.ts` (12, mit Nachbildung der Schleife).

## Stand 2026-10-27 (3) — Abendbriefing nur per Telegram

Owner-Vorgabe 27.10.2026 ~11:37: Das Abendbriefing kommt per Telegram, nicht
per Mail.

- Mailversand des Abendbriefings entfernt (`briefing/mail.ts`, `alsMailText`,
  Mailzweig im Taktgeber). `briefings.mail_ok` bleibt als Spalte, neue
  Einträge tragen `null`.
- Die Ausnahme von der Entwurfsregel (26.10.2026) ist zurückgenommen:
  CLAUDE.md §8, Nachtrag in `docs/projekt/cc-Uebergabe-20261019.md`.
- Tests: statische Prüfung, dass Briefing-Modul und Taktgeber keinen
  Mailversand enthalten.

## Stand 2026-10-27 (2) — Dokumentenablagen stündlich, gemeinsame Neuheiten-Meldung

Owner-Anweisung 27.10.2026, 10:45.

- SharePoint und OneDrive (Graph-Delta) sowie die Dropbox-Kontowurzel
  (`listChanges`, neu im Adapter, nur lesend) werden stündlich auf neue oder
  geänderte Dateien seit 18.10.2026 geprüft; Register je Quelle mit Dedup über
  id + Hash.
- Relevanzregeln für Dateien als Block `dokumente` in derselben
  `relevanz.json`; Vorschlag a–f, Freigabe `Freigabe Dok <id> <a–f>`.
- Mails und Dokumente melden gemeinsam: `scripts/neuheiten-stunde.ts`, Timer
  `neuheiten-stunde.timer`, Report `report-neuheiten-stunde-*.md`. Der Mailteil
  ist unverändert nach `neuheiten/mail-lauf.ts` umgezogen;
  `scripts/mail-register-stunde.ts` und sein Timer entfallen.
- Tests: `doc-register.test.ts` (37), `neuheiten.test.ts` (8).

## Stand 2026-10-27 — Mail-Register stündlich mit Verarbeitungsvorschlag

Owner-Anweisung 27.10.2026, 10:26.

- juergen.bickel@ (Graph) und Yahoo (IMAP `readOnly`) werden stündlich und nur
  lesend registriert (`m365.jsonl`, `yahoo.jsonl`), Doppel über die Message-ID
  gegen alle drei Register.
- Relevanzregeln als editierbare `relevanz.json`; je relevanter Mail ein
  Vorschlag aus dem Katalog a–f, Freigabe `Freigabe Mail <id> <a–f>`.
- Owner-DM und `report-mail-stunde-*.md` nur bei relevanten Mails; Erstlauf
  `--nachlauf` seit 18.10.2026.
- Tests: `relevanz.test.ts` (37), `lesend.test.ts` (14, mit Dedup und
  Schreibschutz für Graph und IMAP).

## Stand 2026-10-26 (2) — Admin-Kanal in der Prompt-Inbox

Owner-Freigabe 26.10.2026 ~13:51 „ADMIN-Kanal".

- `prompt-admin-*.txt` geht an die tmux-Sitzung `admin` (eigene
  Claude-Code-Instanz in `~/admin`, eigene CLAUDE.md, Start
  `~/admin/start-admin.sh`); alle anderen Dateien unverändert an `bikosoc`.
- Eigene Bereitschaftsprüfung und „eine Datei pro Lauf" je Kanal; fehlt die
  Admin-Sitzung, bleibt die Datei liegen. Der Leerlauf-Wächter zählt
  Admin-Aufträge nicht mit.
- Tests: `admin-kanal.test.ts` (12, mit Negativfällen nach C7).

## Stand 2026-10-26 — Briefing-Ausbau: Fehlerverhalten, neue Abschnitte, Abendbriefing, Ablage

Owner-Freigabe 26.10.2026 ~13:50 (Grundlage report-morgenbriefing-analyse-20261026,
Option A für die Mail).

- **Fehlerverhalten:** Ausfallende Quellen zeigen „⚠️ … nicht abrufbar" statt
  einer Leerstelle (Wetter, Postfach M365/Yahoo, Kalender, Entwürfe, Fuhrpark,
  Gewicht, Schlaf, Warnungen). Gesundheitsaufrufe sind einzeln abgefangen.
  Neuer Taktgeber: Zustand je Art und Tag in der Tabelle `briefings`; fehlt
  ein Briefing 15 min nach Sollzeit → ein Nachholversuch, sonst kurze
  Fehlermeldung (Regel `src/modules/briefing/planer.ts`).
- **Morgenbriefing erweitert:** offene cc-Aufträge der letzten 24 h
  (Reportköpfe bikosoc + HDCC), NK-/Objektfristen ≤ 30 Tage, Kontensumme
  ohne Darlehen + Warnung bei Salden älter 2 Tage, Trading (Paper):
  Verbindung + Vortag als Änderung der Nettoliquidation aus dem Tagesbuch,
  Reisen ≤ 7 Tage, Gewichts-Messdatum ab 2 Tagen Alter.
- **NK-Meldung:** Der Tageslauf (08:00) sendet nur noch selbst, wenn das
  Morgenbriefing des Tages nicht zugestellt ist; Statuswechsel auf `expired`
  bleibt.
- **Abendbriefing** 21:00 (`abendBriefingTime`, `/abendbriefingtime`):
  cc-Tagesrückblick, Termine morgen, Fristen ≤ 14 Tage; Telegram und Mail
  an das eigene M365-Postfach (einzige Ausnahme von der Entwurfsregel, fester
  Empfänger in `briefing/mail.ts`).
- **Ablage + Dashboard:** Boot-Migration Modul `briefing` (001_briefings.sql),
  Route `GET /api/briefing?tage=7`, Panel „Briefing" in der Tagesübersicht.

## Stand 2026-10-23 (6) — Rückfall in deploy.sh exakt auf den Rückfallpunkt, 2 × 20 € nachgetragen

Owner-Freigabe 23.10.2026 23:09 „Freigabe Rollback-Fix und 2x20 nachtragen"
(report-rollback-fix-und-2x20-nachtragen-20261023).

- **Rückfall (`scripts/deploy-rueckfall.sh`, eingebunden in `deploy.sh`):**
  `git restore --source=<LAST_GOOD> --staged --worktree -- .` statt
  `git checkout <LAST_GOOD> -- .`. Seit dem Rückfallpunkt hinzugekommene
  versionierte Dateien verschwinden, nicht versionierte und ignorierte
  bleiben. Anlass: Eine neue Testdatei blieb neben dem alten Code liegen,
  der Testlauf des Rückfalls scheiterte, Telegram meldete zweimal falsch
  „ROLLBACK FAILED". Der Ablauf von deploy.sh steht jetzt in `hauptablauf()`.
- **Mietkonto …9268:** zwei Lastschriften über −20,00 € (15.07.2024,
  15.08.2024) aus der PDF-Umsatzliste nachgetragen, Herkunft `pdf_import`
  (`scripts/banking-2x20-nachtragen-20261023.ts`, Audit 3174).

## Stand 2026-10-23 (5) — Paket Abend: MT940-Tagesversatz, PDF-Toleranz, Kontostatus „neu", Darlehen, Auszugssalden

Owner-Freigabe 23.10.2026 21:40 „Freigabe Paket Abend"
(report-banking-paket-abend-20261023).

- **MT940-Tagesversatz (Sidecar `_auszuege_auswerten`):** Die KSK datiert
  :60F: auf den ersten Buchungstag des Auszugs. Liegt eine Buchung des
  Auszugs am Saldodatum oder davor, gilt der Anfangssaldo ab dem Vortag der
  ersten Buchung. Die vier Abweichungen vom 23.10. (…4288, …4305, …4295,
  …9268) waren je genau die Summe des 02.09.2024, des ersten gelieferten Tags.
- **Probe je Auszug:** Der Sidecar merkt sich bei :60F:/:62F: die Position in
  der Umsatzliste, auch über mehrere Antwortseiten, und liefert `auszuege`
  (Anfang, Ende, Zahl, Summe, Probe). Der Kern speichert sie in
  `banking_statement_balances` (V041), bestmöglich — ein Fehler hält den
  Abruf nicht auf.
- **PDF-Verknüpfung:** Abstand bis 5 Tage (vorher 3); Kartenumsatz mit
  unplausiblem Umsatzjahr (> 300 Tage, anderes Jahr) gilt im Buchungsjahr
  (`umsatzdatumFuerVergleich`). Gegenprüfung über alle Konten: 0 zusätzliche
  Verknüpfungen.
- **Kontostatus `neu` (V041):** Das Verbinden legt von der Bank erstmals
  gemeldete Konten als `neu` an — ausgeblendet, nicht abgerufen, nicht in
  Summen, in der Telegram-Meldung genannt. Aktiv erst nach Zuordnung durch den
  Owner (per Auftrag; keine Schaltfläche).
- **Darlehen:** Kontoart `darlehen` zählt im Dashboard nicht zur Summe der
  Konten und steht getrennt als „Verbindlichkeiten (Darlehen)".
- Datenteil: `scripts/banking-paket-abend-20261023.ts` (Audit 3154, 3155).
  Prüfabruf: `scripts/banking-auszugsprobe-20261023.ts`.

## Stand 2026-10-23 (4) — Kennung trimmen, Fehlertext 9340, CAMT-Datum, Freigabe je Konto

**Kennung:** Dashboard (`bankingVerbindenBody`) und Gateway (`bereinigeKennung`,
nach `checkApproval`) entfernen Leerraum am Anfang und Ende der Kennung,
auch Tab, Zeilenumbruch und geschütztes Leerzeichen. Die PIN bleibt
unverändert. Anlass: Das automatische Ausfüllen hängte bei der KSK ein
Leerzeichen an, die Bank lehnte dreimal mit 9340 ab, obwohl die PIN stimmte.

**Fehlertext:** python-fints wirft bei 9340 dieselbe PIN-Ausnahme wie bei
9942. Der Sidecar schneidet die 9xxx-Codes je Aufruf mit (`mit_bankcodes`,
Haken in `_protokolliere_segmentart`). Bei 9340 ohne echten PIN-Code
(9942/9931/9930/9910) meldet er jetzt „Bank lehnt die Anmeldung ab (9340) –
bitte Kennung und PIN prüfen“.

**CAMT-Saldenprobe:** Der Eröffnungssaldo der Volksbank trägt das Datum des
ersten Buchungstags und gilt ab dessen Beginn. `_camt_salden` setzt ihn auf
den Vortag, wenn der Saldo am Tag der ersten Buchung der Datei oder später
liegt. Ein Vortagsabschluss mit Vortagsdatum bleibt unverändert. Die sieben
Abweichungen vom 23.10. ergeben damit 0.

**Freigabe je Konto:**
- Der Sidecar fordert die Freigabe für die volle Historie je Konto an, jeweils
  mit bis zu 120 s Wartezeit. Bei Ablehnung oder Zeitablauf bekommt dieses
  Konto 89 Tage, dann folgt das nächste.
- Das Gateway gibt Auswahl und Reihenfolge vor (`kontenFuerHistorie`):
  Kartenkonten, dann das Giro, dann die übrigen, jeweils nach Endziffern.
  Ohne Konten, deren Historie ein früherer Abruf schon ab 2015 geliefert hat.
- Der Abrufstatus enthält n, m und das Konto. Das Dashboard zeigt „Freigabe n
  von m in der App bestätigen – Konto …xxxx“ und einen Abbrechen-Knopf. Der
  Knopf setzt einen Abbruch-Wunsch, danach bekommen die übrigen Konten
  89 Tage.
- Zeitlimit Gateway → Sidecar 30 Minuten.
- Der Wochenabgleich bleibt unverändert und fordert nie eine Freigabe an.
- **Grenze:** Antwortet die Bank auf eine abgelehnte Freigabe mit einem
  PIN-Code (9942), sperrt python-fints die PIN für diesen Dialog. Dann endet
  die Reihe, die übrigen Konten bleiben unangefragt. Wie die Volksbank auf
  eine Ablehnung antwortet, ist nicht belegt.
- Scheitert die Kontenauswahl im Gateway, läuft der Abruf ohne Historie. Das
  Dashboard wertet „bereit“ nach 150 s als beendet. Eine leere Kennung lehnt
  das Gateway mit 400 ab.

**Formular:** Der PIN-Hinweis beschreibt jetzt den tatsächlichen Stand.
Kennung und PIN werden AES-256-GCM-verschlüsselt in `banking_sessions`
gespeichert, damit der Wochenabgleich ohne erneute Eingabe läuft.

Daten: KSK-Sitzungen 23 und 25 abgelöst (Audit 3081). Owner-Freigabe
23.10.2026 18:42.

---

## Stand 2026-10-23 (3) — Zweite Freigabe für die Historie, Kontonamen ohne IBAN

**Zweite Freigabe (Sidecar `abruf_im_dialog`):** Die Volksbank verlangte am
23.10. für die Umsätze ab 2015 eine weitere App-Freigabe (3955). python-fints
verschluckte das, weil die Bank für Umsätze laut Parametern kein
Freigabe-Segment verlangt. Die Push-Nachricht kam aufs Telefon, wurde aber
nie abgefragt, und der Abruf kürzte auf 89 Tage.
- Die erste Anfrage nach der vollen Historie geht jetzt mit Freigabe-Segment
  hinaus. Bei 3955 fragt der Sidecar den Status höchstens 120 s ab, einmal je
  Verbinden. Bei Ablehnung oder Zeitablauf kürzt er wie bisher auf 89 Tage.
- Die Phase des Abrufs ist abfragbar (`GET /fints/abruf-status/:id` →
  `GET /api/banking/abruf-status/:id`). Das Dashboard zeigt nach „verbunden“
  den Hinweis „Bitte zweite Freigabe in der App bestätigen – lädt Umsätze ab
  2015“.
- Als abgelehnt gilt die Freigabe auch, wenn die Bank danach eine
  9xxx-Meldung oder erneut 3955 schickt oder keine Umsatzantwort liefert
  (python-fints wirft dabei nicht immer). Sperrt python-fints die PIN, endet
  der Abruf, die übrigen Konten bleiben unangefragt. Scheitert der Abruf mit
  Freigabe-Segment, gelten für alle übrigen Konten 89 Tage.
- **Grenze:** Verlangt die Bank nach der Bestätigung für ein weiteres Konto
  erneut eine Freigabe, wird sie nicht angefordert. Die Bank kann dann eine
  zweite Push-Nachricht schicken, die niemand abfragt. Die übrigen Konten
  laufen danach mit 89 Tagen.
- Der Wochenabgleich fordert weiterhin keine Freigabe an. Neu ist dort nur der
  CAMT-Saldenmitschnitt (siehe unten): Die Saldenprobe läuft für die
  Volksbank künftig mit, sobald deren CAMT-Dateien Salden tragen.

**Salden bei CAMT:** Die Salden der CAMT-Dateien werden mitgeschnitten
(`_camt_mit_salden`, PRCD/OPBD → Anfang, CLBD → Ende). Fehlen sie, prüft die
Bezugsprobe (`bezugsprobe`): Kontostand vom letzten Abruf plus seither
übernommene Umsätze minus HKSAL-Saldo.

**Kontonamen:**
- Neue Konten heißen „<Bank> …1234“ (`neueKontoBezeichnung`); der Sidecar
  meldet die IBAN als Namen. Ein Name ohne Kontonummer (etwa ein
  Produktname) bliebe stehen.
- Die Kennung von `account.upsert` im Audit ist die Konto-ID statt der IBAN.
- Das Audit kürzt volle IBANs (Prüfziffer Modulo 97) in freigegebenen
  Textfeldern und in `entity_id` (`kuerzeIbansImText`).
- Umbenennung der 12 Bestandskonten: `scripts/banking-kontonamen-kuerzen-20261023.ts`.

Owner-Freigabe 23.10.2026 17:04.

---

## Stand 2026-10-23 (2) — PDF-Verknüpfung paarweise

Bei der Übernahme einer FinTS-Zeile blieben gleichwertige PDF-Kandidaten
unverknüpft („mehrdeutig"). Gruppen gleich hoher Buchungen zählten dadurch
doppelt: fünf Allianz-Verträge zu je 30 € im Monat und zwei Leasingraten am
selben Tag auf …0028 (9.217,16 €), auf dem Kartenkonto …0125 eine
Gutschrift, die die Bank 16 Tage nach dem Umsatz buchte (402,01 € mit einem
zweiten Fall). Jetzt `verknuepfePdfZeile`:
- paarweise, jede FinTS-Zeile nimmt die nächste freie PDF-Zeile;
- Rangfolge: Gegenpartei, gleicher Zweck (die PDF-Zeile trägt davor die
  IBAN), Abstand, Datum;
- bei Kartenabrechnungen zählt der Abstand zum „Umsatz vom …" aus dem Zweck
  der Bankzeile.

`verknuepfePdfNachtraeglich` holt das für den Bestand nach
(`scripts/banking-pdf-nachverknuepfen-20261023.ts`, ohne Schalter
Trockenlauf). Owner-Freigabe 23.10.2026 17:01.

---

## Stand 2026-10-23 — Abgleichstatus je Institut, Sitzungswahl

Der Wochenabgleich schrieb den **Gesamtstatus** und die **Gesamtsummen** in die
Laufzeile jedes Instituts. Scheiterte die Volksbank (sie lehnt neue
Abrufdialoge ab), stand auch der fehlerfreie KSK-Lauf auf IMPORT_FAILED, und
der Wochencheck hätte einen KSK-Fehler gemeldet. Jetzt bekommt jede Zeile
Status und Summen aus den eigenen Kontoergebnissen (`instErgebnis`);
übersprungene Institute nach einem globalen Stopp behalten ihren Status, die
Zustellung wird nachgetragen. Der Gesamtstatus (Rückgabe, Telegram, Audit)
bleibt. Der TAN-Knopf zeigt auf die Laufzeile des Instituts, das die TAN
verlangt hat — vorher auf die erste Zeile (womöglich falsches Institut).

`listActiveSessions` zieht Sitzungen mit Erfolg vor: Eine gescheiterte
Neuverbindung (KSK-Sitzung 22, 23.10.) verdrängte sonst die funktionierende
Sitzung, weil der Abgleich je Institut nur die erste nimmt. Befund E1 (neue
erfolgreiche Sitzung zuerst) bleibt erhalten.

---

## Stand 2026-10-20 — Umsatzabruf im Verbindungsdialog

Die Volksbank lehnt jeden neuen Abrufdialog ab (9050/9340), den Dialog nach
der SecureGo-Freigabe beim „Bank verbinden“ nimmt sie an. Deshalb hält der
Sidecar diesen Dialog nach erfolgreichem Verbinden bis zu 120 s offen
(`_offene_dialoge`, Aufräumer alle 30 s im Lifespan). Das Gateway ruft darin
sofort Salden und Umsätze aller aktiven Konten ab
(`banking/abruf-nach-verbinden.ts`, Endpunkt `POST /fints/abruf-im-dialog`).
Ausgeblendete Konten (Dritte) werden nicht angefragt.

**Zeitraum:** Die volle Historie ab 2015 wird nur verlangt, wenn der Dialog
selbst mit einer Freigabe (3955) eröffnet wurde, sonst höchstens 89 Tage.
Verlangt die Bank eine weitere Freigabe, wird einmal mit 89 Tagen
wiederholt, danach werden die übrigen Konten nicht mehr angefragt. Es wird
nie eine TAN angefordert oder gesendet (C3). Die Übernahme läuft wie im
Wochenabgleich (v2-Schlüssel, PDF-Verknüpfung, jetzt auch für
`kk_pdf_import`). Je Konto gibt es eine Abrufprobe (Lieferung lückenlos?) und
eine Saldenprobe (Bestand), dazu eine Telegram-Meldung nur mit Endziffern.
Die Abgleich-Sperre 43 wird gehalten; ist sie belegt, wird der Dialog sofort
geschlossen.

---

## Stand 2026-10-16 — Dropbox mit Vollzugriff, neue App ohne Secret

Bisher sah bikosoc nur seinen eigenen App-Ordner. Was dort nicht lag, war nicht
erreichbar — Unterlagen in der Dropbox mussten erst hineinkopiert werden, und
beim Suchen fehlte der halbe Bestand. Das Konto dient ausschließlich bikosoc,
also entschied der Owner am 16.10.2026, den Zugriff auf die ganze Dropbox zu
öffnen.

**Neue App „BikosOpenClawFA"** (Scoped App, Full Dropbox). Ihr Besonderheit:
Sie arbeitet **ohne App-Secret**. Der Token kommt über OAuth2 mit PKCE
(`scripts/dropbox_auth_pkce.py`), der Code-Verifier lebt nur für die Dauer des
Aufrufs im Arbeitsspeicher. Damit liegt auf dem Rechner kein dauerhaftes
Geheimnis der App mehr — beim alten Zugang war das Secret eine Zeile in der
Env-Datei. Der Owner autorisiert selbst im Browser; das Skript zeigt nur
Kontoname und Anzahl der Einträge, nie den Token.

**Der Stolperstein waren die Pfade.** Im App-Ordner-Betrieb ist `/bikosoc-reports`
die Wurzel; mit Vollzugriff zeigt derselbe Pfad in das Wurzelverzeichnis des
Kontos, der bisherige Bestand liegt dagegen unter `/Apps/bikosoc-reports`. Ohne
Gegenmaßnahme hätte der erste Report eine neue, leere Ordnerstruktur neben der
alten angelegt. Deshalb setzt der Adapter das Präfix `DROPBOX_BASE` vor jeden
ausgehenden Pfad und nimmt es aus den Antworten wieder heraus: Der übrige Code
rechnet weiter mit den gewohnten Pfaden, und **verschoben wird kein Ordner**.
Acht Tests halten das fest, darunter der Fall des doppelten Präfixes.

**Beide Zugänge parallel.** `dropboxZugang()` wählt: Stehen `DROPBOX_APP_KEY`
und `DROPBOX_REFRESH_TOKEN` in der Env-Datei, gilt die neue App mit Präfix;
sonst der alte Weg über `EA_DROPBOX_*` ohne Präfix. Die alten Werte bleiben
vorerst stehen — erst nach sieben fehlerfreien Tagen fragt der Agent, ob sie weg
dürfen. Der Rückweg bis dahin ist das Entfernen der zwei neuen Zeilen.

**Unverändert:** Gelöscht wird in der Dropbox weiterhin nur auf das Owner-Wort
„löschen". Der `healthCheck` legt mit gesetzter Basis keine Testdatei mehr an,
sondern liest nur — eine Testdatei im Wurzelverzeichnis des Kontos wäre das
Letzte, was hier entstehen soll.

---

## Stand 2026-10-15 — Mietforderungen, Zahlungsabgleich und Lämpchen

Bisher zeigte das Dashboard je Einheit nur die Kaltmiete, und ob ein Mieter gezahlt hat,
stand nirgends. Der Abgleich lief über die Kontoauszüge von Hand — so sind fünf
ausgefallene Monatsmieten erst im Oktober 2026 aufgefallen, die älteste zehn Monate alt.

**Neu (V042, wartet auf /arm):** Aus jedem Mietvertrag entsteht für jeden Monat eine
Forderung mit getrennten Bestandteilen; Bankeingänge werden ihr zugeordnet; je Mieter und
Objekt zeigt ein Lämpchen grün oder rot. Die vier Einheiten des Eigentümers tragen das
Vertragsmerkmal `owner_hauptmieter` und gelten stets als bezahlt — kein Code, der Namen
kennt, denn die L19-Einheiten werden demnächst umgewandelt.

**Die Zuordnungsregel in drei Stufen:** IBAN schlägt alles; sonst der Name, wenn er auf
genau ein Mietverhältnis passt; sonst Name plus Stichwort aus dem Verwendungszweck. Eine
vierte Stufe fängt gekürzte Banknamen über den Nachnamen ab, aber nur wenn dieser im
Bestand eindeutig ist — „Rettenbacher" ja, „Bickel" nein. Kautionen und
Abrechnungsnachzahlungen sind ausdrücklich keine Mieten: Ohne diese Sperre tilgte eine
Kaution die ältesten Monate und ließ die jüngsten offen stehen.

**Umsatzanzeige berichtigt.** Der Owner sah im Oktober scheinbar vertauschte Spalten. Die
Ursache lag nicht in der Anzeige: 40 Buchungen standen doppelt im Bestand — einmal aus dem
Kontoauszug nachgetragen, einmal später von FinTS geliefert —, und 235 nachgetragene
Zeilen kamen mit vertauschten Feldern an. Der Nachtrag prüft auf vorhandene Umsätze, die
spätere Synchronisierung prüft das umgekehrt nicht. Gelöscht wird nichts: Die unterlegene
Zeile bekommt einen Verweis auf die führende und verschwindet nur aus der Anzeige, die
jetzt dreizeilig ist — Datum und Gegenseite, Verwendungszweck, Buchungsart mit Zuordnung
und Quelle.

Gates: Build, Command-Guard, 1.335 Tests, Smoke 34/34. Schema-Drift ist erwartet, solange
V042 nicht angewandt ist.

---

## Stand 2026-10-15 — Vorauszahlungen lassen sich korrigieren

`lease_charges` kannte nur Anlegen und Lesen. Eine einmal erfasste
Betriebskosten-Vorauszahlung war damit nicht mehr zu berichtigen — und genau das war
noetig, als die DATEV-Buchungsliste 2025 zeigte, dass die Vorauszahlung eines MG24-Mieters
erst einen Monat spaeter zu laufen begann als hinterlegt: Fuer Mai 2025 ist keine Zahlung
eingegangen, die 3.580,00 EUR vom 30.04. sind die vertragliche Kaution.

`PATCH /api/assets/leases/:id/charges/:chargeId` aendert jetzt Betrag, Gueltigkeit, Art,
Steuersatz, Notiz und `archived_at`, mit Audit-Eintrag wie ueberall sonst.

Gates: Build, Command-Guard, 1.304 Tests.

---

## Stand 2026-10-15 — Die Dropbox-Liste verschwieg Unterordner

`scripts/dropbox-holen.ts liste` filterte Ordnereintraege heraus und zeigte nur Dateien.
Ein Ordner, der ausschliesslich Unterordner enthaelt, sah damit aus wie ein leerer Ordner.
Genau das ist am 15.10.2026 passiert: `transfer` zeigte sieben Dateien, der Unterordner
`SWT-Rechnungen` mit 52 Belegen blieb unsichtbar, und der Report behauptete daraufhin, die
beiden gesuchten SWT-Rechnungen lägen nicht mehr vor. Sie lagen die ganze Zeit dort.

Die Liste nennt jetzt zuerst die Unterordner (`[Ordner] name/`) und dann die Dateien, mit
beiden Anzahlen in der Kopfzeile. Die Lehre daneben gilt unabhaengig vom Code: Eine leere
Trefferliste belegt nicht, dass nichts da ist — sie belegt nur, dass die Abfrage nichts
gefunden hat.

---

## Stand 2026-10-15 — Umlageregeln lassen sich korrigieren, nicht nur archivieren

Die Owner-Regel vom 14.10.2026 stellt das Schmutzwasser von der Fläche auf den Verbrauch
um. Für N24 war das nicht durchführbar: Der Ausschluss-Index
`allocation_rules_no_overlap` verbietet zwei Regeln derselben Kostenart im selben
Zeitraum und **ignoriert dabei archivierte Regeln**. Archivieren und neu anlegen — der
Weg, den die Routen sonst für Buchungen vorschreiben — scheitert deshalb bei einer Regel,
die für denselben Zeitraum gilt. Eine Gegenroute zum Archivieren gab es nicht.

`PATCH /api/assets/allocation-rules/:id` nimmt jetzt zusätzlich `archived_at` an. Damit
ist eine Regel mit falschem Schlüssel an ihrer Stelle korrigierbar und reaktivierbar; die
Änderung landet wie jede andere im Audit-Log. Das ist auch die sachlich richtige Form:
Eine von Anfang an falsche Regel ist keine zeitliche Änderung, sondern eine Berichtigung.

Gates: Build, Command-Guard, 1.304 Tests, Schema-Drift, Smoke 34/34 — alle grün.

---

## Stand 2026-10-13 — MG24 Hausstrom erstes Halbjahr: keine Umlage

Zwei Owner-Entscheidungen in den Buchungen festgehalten.

**Der Hausstrom vom 01.01. bis 16.06.2025 wird nicht umgelegt.** Er lief über einen
gemeinsamen Zählpunkt; ein eigener Allgemeinstromzähler besteht erst ab 24.06.2025.
Welcher Teil der 900 kWh auf den Allgemeinstrom entfiel, ist nicht zu belegen — statt
weiter zu schätzen, trägt der Eigentümer die vollen 450,08 EUR.

Das ist mehr als ein Vermerk: Der Betrag war bereits gebucht und nach einer
Arbeitsannahme geteilt (93,19 zu 6,81 Prozent, also 419,42 EUR umlagefähig und 30,66 EUR
nicht). Die Entscheidung kippt den umlagefähigen Teil. **MG24 2025 sinkt dadurch von
13.853,17 auf 13.433,75 EUR** — die Differenz ist genau diese 419,42 EUR. Die
Arbeitsannahme ist gegenstandslos, weitere Recherche zur Aufteilung entfällt.

**Der Hilfsstrom der Pelletanlage bleibt im Allgemeinstrom.** Keine Herauslösung in die
Heizkosten; er wird weiter nach BetrKV § 2 Nr. 11 nach Fläche verteilt.

---

## Stand 2026-10-13 — N24 aus dem EnergyPortal: die PV-Rechnung steht auf Messwerten

Drei Platzhalter haben ihre Nummer bekommen (Whg. 5 `1LGZ0064308150`, Erzeugung
`1MCS0010125166`, alter Summenzähler `1MCS0010125156`), 24 Stände sind erfasst, fünf
Vermerke gesetzt.

**Die PV-Wirtschaftlichkeit beruht für N24 nicht mehr auf Annahmen.** Statt der
unterstellten 1.000 kWh/kWp stehen jetzt gemessene Werte: Erzeugung 2024
**23.039,5 kWh** (813 kWh/kWp), Einspeisung **7.721,4 kWh**, Netzbezug
**14.075,65 kWh**, PV-Eigenverbrauch 15.318,1 kWh. Das Rechenskript nimmt eine
gemessene Einspeisung jetzt direkt entgegen, statt sie aus Verbrauch minus
Netzbezug abzuleiten — der Umweg unterschlug die Verluste, bei N24 immerhin
863 kWh im Jahr.

Der Wert der Anlage sinkt damit von 3.396 auf **2.921 EUR/Jahr**: Es wird
deutlich weniger eingespeist als angenommen (7.721 statt 13.279 kWh). Die
Rangfolge der Szenarien bleibt — B schlägt alles.

**Die EEG-Gegenprobe wird dadurch schärfer, nicht stimmiger.** Für die gemessenen
7.721 kWh wären 578 EUR fällig; eingegangen sind 2025 aber 1.545 EUR. Die
Differenz von rund 967 EUR lässt sich nicht mehr mit einer zu hoch angenommenen
Erzeugung erklären. Klärung nur über die Einspeiseabrechnung.

**Wärmepumpenstrom 2025 bleibt unbestimmbar.** Der Stand zum 31.12.2025 ist
nirgends belegt — das Portal zeigt nur den letzten Stand (01.06.2026), die
Jahresabrechnung 2025 ist nicht erstellt, die RLM-Daten beginnen erst 04/2026.
Eingegrenzt auf 17.195,8 bis 40.988,2 kWh, aber nicht zeitanteilig teilbar: Eine
Wärmepumpe zieht im Winter ein Vielfaches des Sommerwerts. Es wird nichts
geschätzt; der Befund steht am Zähler und als Warnung in der Vorprüfung.

---

## Stand 2026-10-13 — L19: die beiden unbekannten Zähler sind identifiziert

Eine SWT-Ablesebestätigung vom 08.07.2025 nannte sechs Stände, von denen vier nicht zu
bikosoc passten — darunter zwei Zähler, die hier gar nicht geführt wurden. Die Rechnungen
der beiden Wohnungsverträge klären beides.

**L19 hat fünf Stromzählpunkte, nicht zwei.** Neben Wärmestrom (64128135) und
Allgemeinstrom (64128140) gibt es den Haushaltsstrom der beiden Wohnungen im zweiten
Obergeschoss, geführt auf dem Vertrag des Eigentümers: `1ISK0068679824` (2. OG links,
am 29.09.2025 gegen `1ISK0086922705` getauscht) und `64128137` (2. OG rechts). Alle drei
sind jetzt mit insgesamt 18 Ständen von 2023 bis 2026 erfasst und als nicht NK-relevant
gekennzeichnet.

Damit passt die Ablesebestätigung in ihrer **Struktur** genau: fünf Stromregister
(64128135 mit HT und NT, dazu 64128137, 64128140 und 1ISK0068679824) plus Wasser.

**Ihre Werte stimmen trotzdem für drei der fünf Register nicht** — und zwar um
Größenordnungen: gemeldet HT 13.904 gegen abgerechnete 83.755. Entscheidend ist, dass
diese Meldung **in keine Rechnung eingegangen** ist: Die Stadtwerke rechnen für den 30.06.
und 31.07.2025 mit eigenen Hochrechnungen weiter. An den erfassten Ständen ist deshalb
nichts geändert; sie stammen aus den Rechnungen, nach denen tatsächlich abgerechnet wird.
Die Abweichung steht als Vermerk an beiden Zählern.

Ein Zählertausch war am 13.03.2025 für 64128140 angekündigt, ist aber bis mindestens
31.07.2026 nicht erfolgt — die Rechnungen führen den Zähler durchgehend.

---

## Stand 2026-10-13 — MG24 aus dem EnergyPortal, und der erste Allgemeinstrom in der Umlage

Das Portal ist die genauere Quelle als die Abrechnung: Es führt die Stände auf drei
Nachkommastellen, die Abrechnung rundet. Zwei Stände sind darauf geschärft (667 → 666,575
und 3.558 → 3.557,731), zwei neue Stände vom 01.09.2026 kamen dazu.

**Die Owner-Ablesung vom 31.12.2025 steht jetzt als eigener Stand neben dem Portalwert**,
nicht mehr nur in dessen Notiz. Beide sind an diesem Tag richtig — der eine ist, was am
Gerät stand, der andere, womit energiekonzept rechnet. Unterschieden werden sie über
`reader_name`; die Differenz von 2 bis 10 kWh bleibt damit sichtbar, statt in einer Notiz
zu verschwinden.

**Erster Allgemeinstrom in der MG24-Umlage:** 413,33 EUR brutto für 24.06.–31.12.2025,
umlagefähig nach BetrKV § 2 Nr. 11, Kostenart `beleuchtung`. Dazu war eine Umlageregel
nötig — eine umlagefähige Kostenart ohne Regel sperrt die Abrechnung
(ALLOCATION_RULE_GAP). Angelegt nach Fläche, wie alle anderen flächenbezogenen Kostenarten
in MG24. MG24 2025 steigt dadurch von 13.439,84 auf 13.853,17 EUR, also um genau den
gebuchten Betrag. Der Preisansatz bleibt vorläufig: Angesetzt ist der Mieterstromtarif,
den der Vermieter sich selbst in Rechnung stellt.

**Der alte Einspruchsgrund gegen die Stadtwerke ist als überholt gekennzeichnet.** Die
Abrechnung der Kundenanlage rechnet selbst mit dem Wandlerfaktor 50 — er ist also richtig,
und die dort vermutete Rückforderung von rund 4.744 EUR besteht nicht. Der Widerspruch
bleibt, aber aus einem anderen Grund: Nicht der Faktor ist falsch, sondern der Ablesewert.

Die Mieterstromrechnungen 2025 liegen im Portal nur als Testrechnung vor und tauchen in
keiner Mahnung von März bis September 2026 auf. Sie sind an den Zählern als offene
Forderung mit dem Status „Versand ungeklärt" vermerkt — als Ertrag ist nichts gebucht.

---

## Stand 2026-10-13 — Owner-Ablesung MG24 und die Frage, wer in N24 abliest

Zwei fehlende Stände erfasst, sechs Ablesungen um die Owner-Ablesung vom 31.12.2025
ergänzt. Dabei sind drei Dinge aufgeklärt worden, die vorher offen waren.

**Der Wandlerfaktor 50 ist bestätigt.** Die Mail an energiekonzept vom 07.01.2026 nennt
die Rohanzeige des Summenzählers 1LGZ0071678615 zum 31.12.2025: 1.8.0 = 66,9 und
2.8.0 = 101,9. Mal 50 sind das 3.345 und 5.095 kWh — dieselben Werte, mit denen die
Abrechnung rechnet. Das Portal von energiekonzept nimmt die Rohanzeige gar nicht an,
sondern verlangt den bereits umgerechneten Wert.

**Die SWT-Endabrechnung für MG24 ist damit widerlegbar.** Sie setzt für dasselbe
Bezugsregister bereits zum 21.08.2025 den Stand 243,993 an und rechnet daraus 12.200 kWh
ab. Der Eigentümer hat am 16.09.2025 8,3 und am 31.12.2025 66,9 abgelesen. Ein Zählwerk
läuft nicht rückwärts. Der Stand vom 16.09.2025 ist jetzt erfasst.

**Die 79 kWh am PV-Zähler waren kein Ablesefehler.** Das Gerät ist ein Zweiwegezähler und
stand auf 1.8.0 = 4.421 und 2.8.0 = 79 kWh. Das Portal lässt dort nur ein Feld
„Einspeisung" zu, also wurden die 79 gemeldet. Die Erzeugung steht auf 1.8.0.

**Wer liest in N24 ab?** Niemand vor Ort. Die Rechnungen zeigen den Unterschied: N24
zahlt eine GSM-Gebühr für die Miete eines Gateways, MG24 nicht. Dazu schreibt
energiekonzept selbst, die Ablesung der Stromzähler sei „nur erforderlich, sofern diese
nicht durch uns auslesbar sind". In MG24 fährt deshalb jemand hin, in N24 nicht.

Zu den Ständen vom 31.12.2025: Für MG24 war je ein Stand aus der Abrechnung der
Kundenanlage erfasst. Die Owner-Ablesung desselben Tages weicht um 1 bis 10 kWh ab. Der
erfasste Wert bleibt der der Abrechnung — nicht weil er richtiger wäre, sondern weil er
mit dem Anfangsstand und der abgerechneten Menge zusammenpasst. Die Owner-Ablesung steht
vollständig in der Notiz des jeweiligen Standes.

---

## Stand 2026-10-13 — Was die PV-Anlagen einbringen, und was eine Umstellung brächte

Reine Rechnung, keine Datenänderung. `scripts/pv-wirtschaftlichkeit.ts` macht die
Arithmetik des Reports wiederholbar: alle Eingangsgrößen als benannte Konstanten mit
Quellenkommentar, Ausgabe als Szenariotabelle je Objekt.

Gerechnet wird als Jahressaldo aus Sicht des Eigentümers — Erlöse minus Kosten,
einschließlich des Stroms, den er für sich selbst bezieht. Der Saldo ist bei N24 deshalb
negativ; er ist kein Gewinn, sondern der Nettoaufwand der Stromversorgung. Vergleichbar
sind die Szenarien nur, weil in jedem dieselben Posten stecken. Eine Nulllinie „keine PV,
keine Kundenanlage" macht die Tabelle erst lesbar.

Ergebnis: Die Anlagen bringen gegenüber keiner PV **3.396 €/Jahr** (N24) und
**3.463 €/Jahr** (MG24). Die einzige Änderung, die sich rechnet, ist in beiden Häusern
dieselbe — die Abrechnung selbst machen, Messstellenbetrieb lassen: **+622** und
**+760 €/Jahr**. Volleinspeisung und Rückzug aus dem Mieterstrom sind beide schlechter.
Die Rangfolge hält in allen acht Preisvarianten der Sensitivität ±20 %.

Zwei Stellen, an denen die Rechnung bewusst nicht so tut, als wüsste sie mehr: Für N24 ist
die PV-Erzeugung nirgends gemessen, und die Gegenprobe über die tatsächlich eingegangenen
EEG-Zahlungen ergibt 1.260 kWh/kWp — zu viel, um zu stimmen. Szenario D unterstellte
zunächst perfekte zeitliche Deckung des Eigenbedarfs; das ist bei einer Wärmepumpe falsch,
die im Winter läuft, während die Anlage im Sommer liefert. Jetzt steht dort ein
Deckungsgrad mit Spanne 40–60 %, und er ist der empfindlichste Hebel des Szenarios.

---

## Stand 2026-10-13 — Die Stromzähler der Kundenanlagen sind erfasst

19 Stromzähler mit 35 Ständen angelegt — bis dahin war von den beiden
Mieterstromanlagen in bikosoc nichts abgebildet.

**Der Zähler, um den es ging, ist gefunden.** Die N24-Wärmepumpe hängt an Submeter
`1LGZ0064308208` (energiekonzept-Vertrag 341-V008). Verbrauch 2024: **13.961,7 kWh**,
19.10.–31.12.2023: 3.234,1 kWh. Der Allgemeinstrom läuft über `1LGZ0064308209` mit
4.438,1 kWh in 2024. Beide werden auf die Kundennummer der La Perla GmbH selbst
abgerechnet, zum Mieterstromtarif von 31,54 ct/kWh. Der Stand zum 31.12.2025 fehlt
weiterhin — für 2025 gibt es keine Jahresabrechnung der Kundenanlage.

**Auch die MG24-Lücke ist geschlossen.** Der Allgemeinstrom vom 01.01. bis 16.06.2025
lief über `1EMH0012291975` (Stadtwerke Kd 133224-348661, Wandlerfaktor 50): 900,0 kWh,
378,22 EUR netto. Gebucht ist davon nichts — der Auftrag verbietet Kostenbuchungen mit
geschätztem Preis, und für den Mieterstromtarif 2025 fehlt der Beleg.

**Fehlalarm in der Vorprüfung behoben.** `zwischenablesungFehlt()` verlangte eine
Wechselablesung für *jeden* Wohnungszähler — auch für Stromzähler. Das blosse Erfassen
der N24-Mieterstromzähler sperrte dadurch die Abrechnung 2025: N24 fiel von „bereit,
0 Blocker" auf einen Blocker. Mieterstrom wird aber nie zwischen Vor- und Nachmieter
aufgeteilt; er läuft über einen eigenen Liefervertrag und kommt in der
Nebenkostenabrechnung nicht vor. Strom ist jetzt ausgenommen, Gas bewusst nicht — eine
Etagenheizung wird sehr wohl umgelegt. Zwei Zeilen weiter oben in derselben Datei war
Strom längst ausgenommen; die Stelle war schlicht übersehen worden. Vier Tests dazu.

**L19 Ultramess — Bauart geklärt, Medium bewusst unverändert.** Das Zählerfoto vom
23.12.2025 zeigt für `53650734` dasselbe Typenschild wie für den Wärmemengenzähler
`53650511`: Ultramess C, Art. 1100104803, Θ 0–105 °C, ΔΘ 3–100 K, dazu der Aufdruck
„Heat Meter". Die vier Geräte, die eddi24 als „KWZ" abrechnet, sind also Wärmezähler;
die erfassten m³ sind deren Volumenregister. Ein Wärmezähler führt beide Register, die
Einheit allein unterscheidet daher nicht zwischen Trink- und Heizwasser. Welches Volumen
das Register zählt — Warmwasserzapfung oder Heizkreis —, ist weiter offen; deshalb bleibt
das Medium unverändert. Eine Umtypisierung ohne Beleg würde die Abrechnung verfälschen.

---

## Stand 2026-10-13 — Mieterstrom N24 und MG24: drei Leseskripte, ein Befund

Recherche zum Mieterstrommodell beider Objekte. Keine Datenänderung — aber ein Befund, der
die Abrechnung 2025 betrifft: **Für N24 und MG24 ist 2025 keine einzige Stromkostenbuchung
vorhanden, und N24 hat in bikosoc keinen einzigen Stromzähler**, obwohl das Messkonzept
acht Submeter vorsieht, darunter einen eigenen für „Wärmepumpe + Heizung".

Die Konstruktion in beiden Häusern ist eine Kundenanlage nach § 3 Nr. 24a EnWG.
energiekonzept ortenau verkauft dabei keinen Strom, sondern betreibt die Messstellen und
rechnet ab; Stromlieferant gegenüber den Mietern ist der Eigentümer selbst (N24: La Perla
GmbH, MG24: Jürgen Bickel). Deshalb enthält keine energiekonzept-Rechnung eine
Kilowattstunde — sie sind reine Dienstleistungsrechnungen.

Für die Recherche sind drei Leseskripte entstanden, die auch künftig taugen:

- `suche-mail-energiekonzept.ts` — Postfachsuche über Microsoft Graph `$search`, gibt
  Datum, Absender, Betreff und Anhangsnamen aus. `$search` durchsucht auch Anhangsnamen,
  deshalb findet eine Suche nach einer Kundennummer auch die Rechnung, die sie nur im
  PDF-Namen trägt.
- `hole-sharepoint-datei.ts` — lädt eine Datei aus SharePoint über den Pfad aus
  `sharepoint_files`. Über den Pfad und nicht über die Graph-Item-ID, weil die Tabelle für
  die meisten Einträge keine ID führt.
- `hole-mail-anhang.ts` — lädt Mailanhänge, die auf ein Namensmuster passen.

Alle drei schreiben nichts — weder ins Postfach noch in SharePoint noch in die Datenbank.

Bericht: `report-mieterstrom-energiekonzept-recherche-20261013.md`.

---

## Stand 2026-10-13 — L19: die Zähler der Stadtwerke gefunden, die bisherigen waren die falschen

Die Restlückenliste der Zählererfassung stellte sechs Fragen. Fünf sind beantwortet, und
die Antwort fiel anders aus als erwartet: **Die drei Zähler, die in L19 als
Liegenschaftszähler geführt wurden, sind nicht die Zähler, nach denen die Stadtwerke
abrechnen.**

Gesucht waren die Stände 31.12.2024 der beiden Apator-Zähler aus dem Zählerschrank.
Gefunden wurde, dass diese beiden Geräte in **keiner** Versorgerrechnung vorkommen.
Abgerechnet wird über drei andere Zähler, jeder mit eigener Kundennummer und eigenem
Vertrag:

| Zähler | Was | Vertrag | Verbrauch 2025 |
|---|---|---|---|
| `64128135` | Wärmestrom Wärmepumpe (HT+NT) | 133224-237713 / 106952 | 12.708 kWh |
| `64128140` | Allgemeinstrom Gemeinschaftsanlage | 133224-237714 / 106953 | 419 kWh |
| `Z2001676` | Wasser und Schmutzwasser | 133224-239992 / 108963+108964 | 476 m³ |

Alle drei sind mit je fünf Ständen angelegt, Anfangs- und Endstand 2025 belegt. Die
Endstände zum 31.12.2025 standen in den Rechnungen vom 17.08.2026: Die Stadtwerke mussten
den Abrechnungszeitraum 01.08.2025–31.07.2026 am Preiswechsel zum 01.01.2026 teilen und
weisen deshalb einen Stand zum 31.12.2025 aus. Plausibilitätsprobe Wärmestrom: 12.708 kWh
gegen 12.742 kWh Brennstoffbezug in der eddi24-Abrechnung 2024.

`Z2001676` ist der Zenner-Zähler aus dem Hausfoto vom 23.12.2025, dessen Funktion offen
war — auf dem Gerät steht „20-2001676", die Stadtwerke führen ihn als „Z2001676".

**Der bisherige „Gemeindewasserzähler" 40450611 verliert das Kennzeichen Hauptzähler.**
Er zählt 2025 nur 37,865 m³ gegen 476 m³ am Hausanschluss — ein Zwölftel. Zwei Hauptzähler
für dasselbe Medium hätten zwei Nenner nebeneinander gestellt und die Verbrauchsverteilung
doppelt gezählt.

**Die vier „Kaltwasserzähler" der Wohnungen sind Wärmezähler.** Ihre Typenschilder auf den
Zählerfotos tragen dieselbe Artikelnummer wie die vier Wärmemengenzähler des Hauses und die
Angaben Θ 0–105 °C sowie ΔΘ 3–100 K — Temperaturangaben, die ein Trinkwasserzähler nicht
führt. Die Mengenprobe bestätigt das: zusammen 26,345 m³ im Jahr, also 6,6 m³ je Wohnung,
etwa 18 Liter am Tag. Das ist für einen Haushalt unmöglich und für einen Heizkreis normal.
Folge: **L19 hat keine Trinkwasserzähler in den Wohnungen.** Wasser und Schmutzwasser 2025
lassen sich nicht nach Verbrauch verteilen. Die Geräte bleiben unverändert erfasst, damit
die bisherige Datenlage nachvollziehbar bleibt; der Schlüssel ist eine Owner-Entscheidung.

Nebenbefund aus den Rechnungen: Die Verträge **237710** und **237712** sind der
Haushaltsstrom der beiden Wohnungen im 2. Obergeschoss, geführt auf den Eigentümer.

Für S28 sind die Stände des alten und des neuen Hauptstromzählers aus der Rechnung vom
08.01.2026 dokumentiert — der letzte Stand des alten Zählers (13.299 kWh am 26.11.2025)
ist eine echte Ablesung des Netzbetreibers. Der Stand des neuen Zählers zum 31.12.2025
bleibt offen: Die Endabrechnung vom 19.02.2026 rechnet nur Wasser und Abwasser ab, der
Stromvertrag läuft weiter.

---

## Stand 2026-10-13 — L19 und S28: 20 Zähler mit 53 Ständen erfasst

Für L19 und S28 war bisher kein einziger Zähler in bikosoc. Jetzt stehen dort **20 Zähler
mit 53 Ständen**, jeder Stand mit Belegpfad.

L19 (11 Zähler): vier Wärmemengenzähler, vier Wasserzähler, der Gemeindewasserzähler und
**zwei** Liegenschaftsstromzähler — Wärmepumpe und Allgemeinstrom. Deren Zählernummern
standen in keinem Dokument; sie sind aus dem Zählerschrankfoto vom 23.12.2025 abgelesen.
Die Stände 31.12.2023 und 31.12.2024 stammen aus der eddi24-Abrechnung 2024, die
Jahresendstände 2025 Bild für Bild aus den Zählerfotos.

S28 (9 Zähler): Hauptwasserzähler, vier Wohnungswasserzähler, zwei Warmwasserzähler und
drei Stromzähler — darunter der am 24.04.2025 ausgebaute Zwischenzähler und der am
27.11.2025 getauschte Hauptstromzähler.

**`document_path` fehlte in der Ablesungsroute.** Die Spalte existierte, aber weder die
Bulk- noch die Einzelanlage noch die Änderung führten sie. Ein Zählerstand ohne Beleg ist
nicht nachprüfbar — bei einem Foto oder einer Versorgerrechnung ist der Pfad die einzige
Spur zurück zur Quelle. Alle drei Wege führen das Feld jetzt.

---

## Stand 2026-10-13 — Verbrauch nach Protokoll, Umlage nach Vertrag

Owner-Entscheidung vom 13.10.2026. Zwei Schnitte, die bisher derselbe waren, laufen jetzt
auseinander:

- **Verbrauch** (Heizung, Warmwasser, Wasser) wird an der **Übergabe** geschnitten.
  Verbrauchen kann nur, wer die Schlüssel hat; wer am 27.10. auszieht, heizt danach nicht
  mehr.
- **Kosten nach Fläche und nach Wohnungen** laufen weiter nach **Vertrag**. Der Vormieter
  trägt die Grundkosten bis zum Vertragsende, auch wenn er schon ausgezogen ist.

Umgesetzt in **einer Funktion**: `nutzungsAbschnitt()` bildet den Verbrauchsabschnitt und
liest dafür jetzt `handover_at` und `actual_move_out` statt `start_date` und `end_date`.
Die Flächenrechnung läuft über `calculateProRata()` und bleibt unberührt. Kein neues Feld,
keine Migration, kein zusätzliches Mietverhältnis.

Beide Felder existierten und waren überall mit den Vertragsdaten identisch belegt — bei
MG24 und den übrigen N24-Wohnungen ändert sich dadurch nichts.

**Die Lücke zwischen Auszug und Einzug gehört keinem Mietverhältnis** und fällt damit in
den Eigentümerblock. Das ist die Zwischenmiete, ohne ein Mietverhältnis zu erfinden, das
sich mit den beiden anderen überschneidet. Bei N24 W6 sind das **421 kWh Heizung,
10,4 % des Jahresverbrauchs der Wohnung**.

Die Vorprüfung folgt demselben Tag: `MISSING_INTERIM_READING_FOR_CHANGEOVER` verlangt die
Zwischenablesung jetzt am Übergabetermin, ersatzweise am Vertragsende — die am 12.10.
eingeführte umgekehrte Reihenfolge ist damit überholt. Stünden Vorprüfung und
Verbrauchsabschnitt auf verschiedenen Tagen, verlangte die eine eine Ablesung, mit der die
andere nicht rechnet.

Die Mietvertrags-Route führt zusätzlich `handover_at`; ohne das wäre eine Korrektur des
Übergabetermins nur an der Route vorbei möglich gewesen.

---

## Stand 2026-10-12 — Nicht umlagefähige Kosten sperrten die Abrechnung

`ALLOCATION_RULE_GAP` prüfte ALLE gebuchten Kostenarten darauf, ob ein Verteilschlüssel
hinterlegt ist — auch die nicht umlagefähigen. Eine Reparatur wird aber nie verteilt; ein
Verteilschlüssel dafür wäre sinnlos.

Die Folge: Wer die Kosten des Objekts vollständig erfasst, sperrt damit die Abrechnung.
Umgehen ließ sich das nur, indem man Reparaturen gar nicht buchte — dann fehlt die
Kostenseite — oder eine Regel anlegte, die nichts tut. Bei N24 2025 sperrte die erste
gebuchte Reparatur die ganze Abrechnung.

Geprüft werden jetzt nur noch die Kostenarten, aus denen umlagefähige Buchungen stammen.

---

## Stand 2026-10-12 — N24 2025: 17 Belege gefunden und gebucht

Im Bericht `n24-kosten-umlage-2025` stand, für N24 gebe es in SharePoint keine Belege
für 2025. Das war falsch: Die Suche traf mehr, als die abgeschnittene Ausgabe zeigte, und
der Ordner `N24/N24 - Gebäudeakte/8. Rechnungen/` blieb dadurch unbemerkt.

Gebucht sind jetzt **11 umlagefähige Belege über 8.192,31 €** und **6 nicht umlagefähige
über 6.017,14 €**, jeder mit Belegpfad. Zugeordnet ist über den Leistungszeitraum, nicht
über den Zahltag — zwei Belege zeigen, warum: Die Störungsrechnung von Schmitt + Sohn vom
04.03.2025 betrifft einen Einsatz am 17.11.2024, und die Maurer-Rechnung über 1.786,49 €
vom Februar 2025 ist die Wartung 2024.

---

## Stand 2026-10-12 — Der Anteil ausgeschlossener Mietverhältnisse wurde doppelt gezählt

Beim Freischalten von N24 2025 verteilte die Abrechnung **3.815,44 €**, obwohl nur
**3.237,59 €** gebucht waren. Ursache: `allocateCosts()` bekommt nur die abzurechnenden
Mietverhältnisse. Was auf eine inklusive vermietete Wohnung entfällt, bleibt dort
unverteilt und kommt als `vacancyAmount` zurück — und anschließend legte die Engine
denselben Betrag ein zweites Mal als `excluded_billing_mode` in den Eigentümerblock.

Die Mieterbeträge waren richtig. Falsch waren der Eigentümerblock und die Objektsumme,
also genau die Zahl, die gegen die Rechnungen stimmen muss. Betroffen sind nur Objekte
mit inklusive vermieteten Wohnungen: **N24 und L19**. MG24 hat keine und bleibt
unverändert.

Beide Posten bleiben erhalten — der Eigentümer soll sehen, was Leerstand ist und was auf
die inklusive vermieteten Wohnungen entfällt. Gezählt wird der Betrag nur einmal: Der
Leerstandsposten wird um die Anteile der inklusive-Mietverhältnisse vermindert. Übersteigt
der ausgeschlossene Anteil den unverteilten Rest, meldet die Engine
`EXCLUDED_SHARE_EXCEEDS_VACANCY` statt still zu verschieben.

Das Goldfile-Szenario 6 prüft jetzt, dass die Summe aller Posten dem gebuchten Betrag
entspricht — die Prüfung fehlte, und genau deshalb blieb der Fehler unbemerkt.

---

## Stand 2026-10-12 — N24 W6: Nutzerwechsel gemessen statt geschätzt

Die sechs Blocker für N24 2025 sind weg. Der M-Bus-Logger zeichnet **wöchentlich** auf,
montags um 00:00 Uhr; die Aufzeichnung vom **01.12.2025, 00:00:20 Uhr** ist damit der
Stand am Ende des 30.11.2025 — auf zwanzig Sekunden genau der Vertragsschnitt zwischen
Schweigert-Hasi und Westhauser. Quelle sind die Exporte, die Fa. Maurer am 08.01.2026
bereits entlang der Vertragsgrenze geteilt aus dem Logger gezogen hat.

Nebenbei ist damit eine offene Frage vom Vortag beantwortet: Die Zählerreihen aus dem
Logger lagen zum Jahresende durchweg unter den im Zähler gespeicherten Stichtagswerten.
Es ist keine Skalenfrage — der letzte Logeintrag des Jahres ist der **29.12.**, nicht der
31.12.

---

## Stand 2026-10-12 — N24 2025: Umlageregeln und die ersten Kostenbuchungen

Elf Umlageregeln für N24 ab 2025, nach dem Vorbild der eddi24-Abrechnung 2024 für
dieselbe Liegenschaft: NHN (Nutzfläche) → `sqm`, VKW (Verbrauch Kaltwasser) →
`consumption`, WNZ (Wohnungen nach Nutzungszeit) → `units`, Heizung und Warmwasser
0/100 über `heating_split`. Dazu fünf Kostenbuchungen aus den drei vorliegenden
SWT-Rechnungen (3.237,59 €) und die Stände des Gemeindewasserzählers.

Drei Lücken im Code standen dem im Weg:

1. **Eine 0/100-Regel war über die Route nicht anzulegen.** Die Anteile wurden mit
   `body.base_share_percent || null` gesetzt — aus der 0 wurde NULL, und die
   Prüfbedingung der Tabelle (beide Anteile gesetzt, Summe 100) ließ den Datensatz
   nicht zu. Die 0/100-Regeln von MG24 mussten deshalb seinerzeit von Hand in die
   Datenbank. Jetzt `?? null`: „nicht angegeben" und „null Prozent" sind zwei
   verschiedene Dinge. Vier Tests halten das fest.
2. **`document_path` führte die Buchungsroute nicht.** Eine Kostenbuchung ohne Beleg
   ist in einer Nebenkostenabrechnung nicht belegbar — der Mieter hat ein
   Einsichtsrecht. Das Feld existierte in der Tabelle, aber weder POST noch PATCH
   kannten es. Beide jetzt, mit Audit.
3. **Die Testdatenbank ist bei `allocation_rules` zwei Migrationen hinter der
   Produktion** (`setupTestDb()` spielt nur V022 ein, der Rahmen 50–70 % aus § 7
   HeizkostenV wurde erst mit V041 geöffnet). Der neue Test spielt die
   Prüfbedingung aus V041 auf seiner eigenen Testdatenbank selbst ein, damit kein
   anderer Test berührt wird.

**Zum Leistungszeitraum.** Eine Rechnung über zwei Kalenderjahre wird an den
Zeitraumzeilen der Rechnung selbst geteilt, nicht tageweise: Menge und Preis je m³
unterscheiden sich in den Teilzeiträumen. Die SWT-Wasserrechnung für
01.10.2024–30.09.2025 trägt für 2025 genau 380 m³ zu 2,470 €, nicht den
Tagesdurchschnitt.

---

## Stand 2026-10-12 — N24: 38 Zähler erfasst, drei Vorprüfungen korrigiert

Für N24 waren bisher **keine** Zähler angelegt. Jetzt stehen 36 Wohnungszähler und zwei
Liegenschaftszähler mit je drei Ständen in der Datenbank (31.12.2024 aus Casameta,
31.12.2025 als Stichtagswert aus dem M-Bus-Logger, 12.10.2026 als Live-Wert). Angelegt
über `scripts/zaehler-n24.ts`, ausschließlich über die bestehenden Routen mit Audit;
der Lauf ist wiederholbar und überschreibt nichts.

Die Warmwasserzähler sind **Wärmezähler**: Sie messen die Energie zum Erwärmen in kWh,
nicht das Volumen — wie in Casameta 2024. Deshalb `medium = 'heat'` mit
`submetering_purpose = 'warm_water_heat'`. Damit greift Methode B (§ 9 Abs. 1
HeizkostenV, getrennte Messung) statt der Schätzformel nach § 9 Abs. 2.

Beim Rechnen kamen drei Fehler in der Vorprüfung heraus:

1. **`HAUPTZAEHLER_OHNE_ENDSTAND` (neu).** Der Hauptzähler am Hausanschluss ist der
   NENNER der Verbrauchsverteilung. Fehlte sein Stand zum Periodenende, gab
   `calculateConsumption()` null zurück — und der volle Rechnungsbetrag wurde nach den
   Wohnungszählern verteilt, die ungemessene Differenz also den Mietern zugerechnet.
   Genau dieser Fehler war bei MG24 am 11.10.2026 behoben worden; über einen fehlenden
   Stand wäre er still zurückgekommen. Blocker, wenn eine Kostenart nach diesem Medium
   verteilt; sonst Warnung — der Gesamt-Wärmezähler dient bei getrennter Messung nur dem
   Abgleich, und ein Blocker würde eine rechenbare Abrechnung ohne Nutzen aufhalten.
2. **`MISSING_WW_METERS` meldete die Schätzformel, wo gemessen wird.** Die Regel sah nur
   Volumenzähler (`warm_water`) und übersah Wärmezähler mit dem Zweck
   `warm_water_heat`. Bei N24 behauptete sie damit das Gegenteil dessen, was die Engine
   tut.
3. **Bereitschaft und Engine widersprachen sich.** `MISSING_INTERIM_READING_FOR_CHANGEOVER`
   stand in der Vorprüfung als Warnung, während die Engine denselben Befund unbedingt zum
   Blocker hochstuft. Für N24 2025 hieß das: „bereit, 0 Blocker" — und ein Abbruch mit
   HTTP 422. Jetzt ist der Befund auch in der Bereitschaft ein Blocker. Das verschärft
   nichts; gesperrt war die Abrechnung schon, es stand nur nicht in der Bereitschaft.

Nebenbei ist die Tabelle `VERBRAUCHSMEDIEN` aus `engine.ts` nach `types.ts` gewandert,
damit die Vorprüfung dieselbe Tabelle lesen kann, ohne einen Importzyklus zu erzeugen —
statt einer dritten Kopie.

---

## Stand 2026-10-12 — Zwischenablesung: der Schnitt liegt am Vertragsende

Die Vorprüfung `MISSING_INTERIM_READING_FOR_CHANGEOVER` verlangte bisher *irgendeine*
Ablesung vom Typ `move_out` an den Zählern der Wohnung — ohne Datumsbezug und am falschen
Tag orientiert. Zwei Fehler in einer Regel:

- **Ohne Datum.** Eine Ablesung vom Februar erfüllte die Regel für einen Auszug im
  November. Die Sperre war damit faktisch wirkungslos.
- **Am falschen Tag.** Maßgeblich war `actual_move_out`, also der Übergabetermin. Für die
  Abrechnung zählt aber das **Vertragsende**: Bis dahin trägt der Vormieter die Kosten.
  Bei N24 W6 liegen die beiden 15 Tage auseinander (Übergabe 15.11.2025, Vertragsende
  30.11.2025) — eine Ablesung vom Übergabetag würde die Abrechnung 15 Tage zu früh
  schneiden und den Verbrauch dieser Tage dem Nachmieter zuschlagen.

Neu ist die reine Funktion `zwischenablesungFehlt()`: Sie ankert am `end_date` des
endenden Mietverhältnisses (Rückfall `actual_move_out`, wenn kein Vertragsende erfasst
ist), sucht je Zähler eine Ablesung innerhalb von **± 3 Tagen** und zählt dabei **jede**
Ablesung — was zählt, ist der Stand an diesem Tag, nicht das Etikett beim Erfassen.
Fallen Vertragsende und Übergabe auseinander, nennt die Meldung beide Daten.

`actual_move_out` bleibt als Übergabedatum informativ und geht in die Kostenverteilung
nicht ein.

---

## Stand 2026-10-12 — Mietverhältnisse: Vertragsparteien und Dokumentpfad nachtragbar

Zwei Lücken in den Routen, die beim N24-Nachtrag aufgefallen sind und beide nur den Weg
an der Route vorbei gelassen hätten:

1. **`contract_document_path` war über keine Route zu setzen.** Das Feld existiert seit
   jeher in der Tabelle; die Änderungsroute führte es nicht, und `mapLeaseRow()` lieferte
   es nicht aus. Beides ergänzt — jetzt ist eine gesetzte Verknüpfung auch von außen
   sichtbar.
2. **`lease_tenants` wurde nur beim ANLEGEN eines Mietverhältnisses gefüllt.** Fehlte
   eine Vertragspartei, war sie nicht mehr nachzutragen. Neue Route
   `GET|POST /api/assets/leases/:id/vertragsparteien` mit Audit-Eintrag
   (`lease_tenant.create`). Entfernt wird dort nichts: Eine Vertragspartei verschwindet
   nicht, sie wechselt allenfalls — und das ist ein neues Mietverhältnis.

Angewandt auf N24: zweite Vertragspartei bei W5 nachgetragen, Dokumentpfade für fünf
Mietverhältnisse gesetzt.

---

## Stand 2026-10-11 — Skala der Zählerreihen belegt: absoluter Zählerstand

Zwei Reports vom selben Tag behandelten die Skala der Fiehn-Reihen unterschiedlich: W1
Süd/West als Jahresverbrauch (Foto minus Stichtag), W2 direkt als Zählerstand. Beides
zugleich kann nicht stimmen.

**Belegt ist die absolute Skala, aus zwei unabhängigen Quellen:**

1. Die Spaltenüberschrift im Fiehn-Monatsbericht lautet **„Zählerstand aktuell (Wh)"**;
   daneben steht eine eigene, leere Spalte „Verbrauch Vormonat".
2. Die Reihen laufen über den Jahreswechsel **weiter** statt neu anzusetzen — W1 Süd/West
   9.222.000 Wh am 27.12.2025, 9.422.000 Wh am 01.01.2026. Geprüft für alle sieben Zähler
   mit Daten.

W1 Süd/West ist deshalb korrigiert: Anfangsstand 01.01.2025 = **2.772 kWh** (Stichtagswert
31.12.2024 vom Foto) statt null, Einzugsstand = **3.781 kWh** statt 1.009. Der Verbrauch
2025 dieses Zählers sinkt damit von 9.417 auf **6.645 kWh**. W2 bleibt unverändert.

**Die Nebenwirkung ist größer als die Korrektur.** Die Anfangsstände aller acht
Wärmemengenzähler stammten aus einer Ableitung über die GLT-Spalte „Vorjahr" und ergaben
exakt null. Das Foto widerlegt diese Ableitung für einen Zähler — damit ist sie als
Methode entwertet, auch für die übrigen sechs aktiven. Neuer Hinweis
`HEAT_METER_START_FROM_GLT_DERIVATION` in jeder Abrechnung, bis die Stichtagswerte
vorliegen.

Eine zweite Spur stützt den Verdacht: Mit den Null-Ankern ergibt sich für den Pelletkessel
ein Jahresnutzungsgrad von **98 Prozent** (63.478 kWh Wärme aus 64.700 kWh Brennstoff).
Für einen Pelletkessel sind 80 bis 90 Prozent der Erwartungsbereich; bei 85 Prozent wären
rund 8.500 kWh weniger Wärme zu erwarten. Die gemessene Wärme ist also insgesamt zu hoch
— genau das, was zu niedrige Anfangsstände bewirken.

**Wirkung MG24 2025:** W1 860,43 → 644,96 € · W2 296,47 → 382,03 € · W3 unverändert
1.213,48 € · Eigentümer 3.669,46 → 3.799,37 €.

Die Zwischenstände-CSV führt jetzt in jeder Zeile die Spalte `skala`.

---

## Stand 2026-10-11 — Owner-Fotos W1: drei Korrekturen und eine Methodenänderung

Die Fotos der W1-Zähler widerlegen drei Angaben, die ich aus dem handschriftlichen
Übergabeprotokoll übernommen hatte. Der Fehler lag im Protokoll, die ungeprüfte
Übernahme bei mir.

| Protokoll (falsch) | Foto (richtig) |
|---|---|
| „Wasser 33050523 = 3,78 m³" | **Wärmemengenzähler** 33050523, 3,781 **MWh** |
| „Warmwasser 24035938 = 0,412" | **Kaltwasser** 9WGNWG24035938, 0,412 m³ |
| — | Warmwasser 9WGNWG24037785, **0,334 m³** |
| „Heizung: Zähler wird noch eingebaut" | gilt nur für den **zweiten** Zähler |

**Der Zähler 33050523 lief bereits 2024** — Stichtagswert 31.12.2024: 2,772 MWh. Damit
ist er der Zähler, der ab Mai 2025 in den Fiehn-Berichten auftaucht, also **Süd/West**;
der zweite (Nord/Ost) erscheint erst ab 30.09.2025 und ist der, auf den sich der
Protokollvermerk bezog.

**Eine Skalenfalle, die beinahe 2.772 kWh gekostet hätte:** Die Reihe in bikosoc stammt
aus den Fiehn-Berichten und beginnt 2025 bei null; der physische Zähler steht um den
2024er Bestand höher. Eingetragen ist deshalb der Januarverbrauch 3.781 − 2.772 =
**1.009 kWh** als Einzugsstand, nicht der Zählerstand. Hätte ich 2.772 als Anfangsstand
und 3.781 als Einzugsstand gesetzt, wäre der Jahresverbrauch um 2.772 kWh zu niedrig
herausgekommen.

**Methodenänderung: je Zähler statt alles oder nichts.** Bis dahin galt: Hat nur einer
von zwei Wärmemengenzählern eine Zwischenablesung, wird auch sie verworfen. Bei W1 kostete
das die vorhandene Messung für Süd/West. Jetzt nimmt **jeder Zähler die beste Grundlage,
die er hat**; die Wohnung summiert die Mengen. `anteilAusStuetzpunkten()` nimmt dafür
Reihen mit eigener Zwischenablesung entgegen und meldet, ob alle gemessen sind.

**Wirkung MG24 2025** (nach W1- und W2-Korrektur zusammen):

| | vor beiden Korrekturen | nachher |
|---|---:|---:|
| W1 | 1.153,86 € | 860,43 € |
| W2 | 356,90 € | 296,47 € |
| W3 | 1.213,48 € | 1.213,48 € |
| Eigentümer | 3.315,60 € | 3.669,46 € |

**Befund zur Rückrechnung:** Sie liegt nicht systematisch zu niedrig, sondern meist zu
HOCH — in vier von fünf vergleichbaren Fällen. Beim Wasser um das Zehnfache: Der
Zeitanteil unterstellt einer leeren Wohnung den Verbrauch einer bewohnten.

---

## Stand 2026-10-11 — Übergabefotos W2, Zählerzuordnung über den GLT-Verlauf

Vier Zählerstände zum Einzug W2 am 01.04.2025, aus Fotos des Owners. Damit ist auch W2
gemessen statt geschätzt; nur W3 bleibt beim Stützpunktverfahren.

**Die Zuordnung der beiden Wärmemengenzähler war offen** — Seriennummern sind in bikosoc
nirgends dokumentiert. Entschieden über den GLT-Verlauf: Der Stand 6.983 kWh am
01.04.2025 passt in das Fenster **genau eines** Wohnungszählers (W2 Nord/Ost, 0 am 01.01.
→ 7.470 am 31.05.). W1 Nord/Ost steht am 30.09. erst bei 5.929, W1 Süd/West am 31.05. bei
6.710, die W3-Zähler im dreistelligen Bereich. Der zweite Zähler ist damit durch
Ausschluss Süd/West. Beide Seriennummern stehen jetzt in den Stammdaten, ebenso die der
Wasserzähler.

**Der gemeldete Widerspruch löst sich auf:** 6.983 kWh liegt über den bisher verwendeten
5.882 kWh — aber das waren nie Messwerte, sondern der rechnerische Einzugsstand aus dem
Stützpunktverfahren. Die Schätzung lag 1.101 kWh zu niedrig; der Mieter hätte
Bautrocknung mitgetragen. Gegen die GLT-Reihe ist der Fotowert widerspruchsfrei
(monoton, plausibel).

| W2 | Schätzung | Foto 01.04. | Differenz |
|---|---:|---:|---:|
| Nord/Ost | 5.882 kWh | 6.983 kWh | +1.101 |
| Süd/West | 3.090 kWh | 2.784 kWh | −306 |
| Kaltwasser | 3,513 m³ | 0,325 m³ | −3,188 |
| Warmwasser | 2,306 m³ | 0,243 m³ | −2,063 |

Beim Wasser lag die Schätzung weit daneben: Eine leere Wohnung verbraucht fast nichts.
Heizung sinkt um 795 kWh, Wasser steigt um gut 5 m³ — unter dem Strich **−60,43 €** für
W2, derselbe Betrag mehr beim Eigentümer.

---

## Stand 2026-10-11 — Übergabeprotokoll W1: echte Zwischenablesung

Der Owner hat das Wohnungsübergabeprotokoll W1 vom 25.01.2025 bereitgestellt. Es enthält
genau das, was § 9b Abs. 1 HeizkostenV verlangt — eine Ablesung zum Nutzerwechsel:

| Zähler | Stand 25.01.2025 | Herstellernummer |
|---|---:|---|
| Kaltwasser | 3,780 m³ | 33050523 |
| Warmwasser | 0,412 m³ | 24035938 |
| Heizung | **nicht eingebaut** | — |

**Die Toleranz für eine Zwischenablesung steigt von drei auf sieben Tage.** Eine
Wohnungsübergabe liegt üblicherweise einige Tage vor dem Monatsersten, zu dem der Vertrag
beginnt — hier sieben. Der Übergabetermin ist dabei der sachlich richtige Anker: Ab da
hat der Mieter die Schlüssel. Mehr als eine Woche wird nicht zugelassen; sieben
Januartage sind knapp vier Prozent des Jahresheizbedarfs.

**Die beiden Wärmemengenzähler W1 waren am Übergabetag nicht vorhanden** („Zähler wird
noch eingebaut"). Ihr `installed_at` stand auf 15.10.2024 — falsch und jetzt geleert, mit
dem Sachverhalt in der Notiz. Für die Abrechnung folgt daraus: Was diese Zähler später
gezählt haben, fällt vollständig in die Mietzeit. Erfasst ist das als Stand 0 zum
25.01.2025 mit dem Vermerk ABGELEITET, nicht abgelesen.

**Wirkung MG24 2025** (bei 0/100):

| | vorher | nachher | Differenz |
|---|---:|---:|---:|
| W1 | 728,25 € | 1.153,86 € | **+425,61 €** |
| W2 | 356,90 € | 356,90 € | 0 |
| W3 | 1.213,48 € | 1.213,48 € | 0 |
| Eigentümer | 3.741,21 € | 3.315,60 € | −425,61 € |

W1 trägt jetzt seine volle gemessene Wärme (17.017 kWh statt 79,47 % davon) und beim
Wasser nur noch den Verbrauch ab Übergabe. Die Schätzung ist durch Messung ersetzt.

**Zwei Stellen rechneten danach anders als die Engine** und sind nachgezogen: das
Casameta-Eingabeblatt (sagte weiter „Zwischenablesung fehlt") und das Skript für die
Zwischenstände. Beide kennen jetzt dieselbe Rangfolge — Zwischenablesung vor
Stützpunktverfahren. Zwei Aussagen über denselben Sachverhalt sind in einer Abrechnung
schlimmer als eine unbequeme.

---

## Stand 2026-10-11 — MG24 auf 0/100 umgestellt

Owner-Entscheidung vom 10.10.2026, erneut bestätigt am 11.10.2026 um 14:05: Heizung und
Warmwasser werden bei MG24 zu **100 Prozent nach Verbrauch** verteilt, ohne
Grundkostenanteil. Die Zwischenlösung 30/70 „bis zur Klärung der W3-Wärmemengenzähler"
ist aufgehoben. Casameta steht bereits auf „nur nach Verbrauch".

Geändert über die bestehenden Routen (`heating-config` 2025 und 2026,
`allocation-rules` für `heizung` und `warmwasser`), je mit Audit-Eintrag. Die Abweichung
von § 7 Abs. 1 HeizkostenV bleibt als Befund `HEATING_SPLIT_OUTSIDE_HEIZKOSTENV` in jeder
Abrechnung stehen; der Owner trägt das Kürzungsrisiko aus § 12 bewusst.

**Wirkung MG24 2025:**

| | 30/70 | 0/100 | Differenz |
|---|---:|---:|---:|
| W1 | 556,95 € | 728,25 € | +171,30 € |
| W2 | 245,60 € | 356,90 € | +111,30 € |
| W3 | 1.392,22 € | 1.213,48 € | −178,74 € |
| Eigentümer | 3.845,07 € | 3.741,21 € | −103,86 € |

W3 wird entlastet, W1 und W2 werden belastet — genau umgekehrt zur Erwartung bei einem
normalen Haus. Grund: W3 hat keine funktionierenden Wärmemengenzähler und trägt an der
Raumwärme deshalb **0 €**. Mit 30/70 zahlte es wenigstens noch den Grundkostenanteil nach
Fläche (43,7 %), bei 0/100 fällt auch der weg.

Beim Einpflegen ist mir ein Fehler unterlaufen: Der erste Aufruf überschrieb das Feld
`notes` der Heizungskonfiguration und löschte damit die Anlagenbeschreibung (KWB
Combifire, Puffer, Inbetriebnahmedaten). Sofort korrigiert — der technische Text steht
wieder drin, die Entscheidung ist angehängt statt an seine Stelle gesetzt.

---

## Stand 2026-10-11 — Endbestand Brennstoff nach FIFO

Beim Abgleich der Casameta-Eingabe fiel auf, dass das Portal den Endbestand nach FIFO
bewertet, bikosoc dagegen pauschal zum Preis der letzten Lieferung. FIFO ist richtig:
Im Lager liegen 5,00 t, die letzte Lieferung brachte aber nur 4,02 t — die restlichen
0,98 t stammen zwangsläufig aus der Lieferung davor und waren billiger.

| | bisher | FIFO |
|---|---:|---:|
| Endbestand 31.12.2025 | 2.187,75 € | **2.146,41 €** |
| Heizkosten 2025 | 4.943,22 € | **4.984,56 €** |

FIFO-Zusammensetzung: 4,020 t aus Lieferung 109505 vom 15.12.2025 zu 437,55 €/t
(1.758,95 €) und 0,980 t aus 106971 vom 25.09.2025 zu 395,37 €/t (387,46 €).

`scripts/pelletbestand-mg24.ts` rechnet jetzt mit `endbestandFifo()` und bricht ab, wenn
sich der Bestand nicht vollständig aus den bekannten Lieferungen decken lässt — eine
unvollständige Lieferliste soll keine stille Teilbewertung ergeben.

**Umsetzung über zwei Buchungen statt einer Betragsänderung.** Die PATCH-Route für
Kostenbuchungen lässt den Betrag bewusst nicht ändern („das wäre eine andere Buchung").
Also: alte Buchung archiviert, neue angelegt. Der `source_key` trägt jetzt die
Bewertungsmethode (`…-endbestand-fifo`), weil die Eindeutigkeitsregel auch für
archivierte Buchungen gilt und der alte Schlüssel dauerhaft belegt bleibt. Beide
Fassungen stehen damit nebeneinander nachvollziehbar.

**Wirkung MG24 2025:** W1 544,25 → 556,95 · W2 237,09 → 245,60 · W3 1.385,90 → 1.392,22 ·
Eigentümer 3.831,26 → 3.845,07 €. Objektsumme 13.439,84 €.

**Abgleich mit Casameta geht auf:** 13.439,84 € abzüglich 618,55 € ungemessenem
Wasser- und Abwasserrest = **12.821,29 €** — genau der Wert, den das Portal erwartet.

---

## Stand 2026-10-11 — SWT-Wasserzähler abgelesen, Objektzähler in der Ansicht

Der Eigentümer hat den Abrechnungszähler der Stadtwerke (8ZRI2316739802) vor Ort
abgelesen: **884,9 m³ am 11.10.2026**. Damit ist der Endstand 451 m³ zum 31.12.2025
bestätigt — die Alternative 151 m³ hätte 734 m³ Verbrauch in neun Monaten 2026 bedeutet.
Die SWT-Wasserrechnung 2025 über 2.353,01 € ist richtig.

**Der GLT-Zähler am Hausanschluss ist offenbar um den Faktor 10 falsch skaliert.** 2026
bis zum 10.10.: GLT 43,11 m³, mit Faktor 10 also 431,1 m³ gegenüber 433,90 m³ beim
Abrechnungszähler — **0,6 % Abweichung**. Das ist kein „misst woanders", sondern eine
Skalierung. (Beleg, keine Gewissheit: ein zweiter Vergleichszeitraum fehlt.)

**Wasserbilanz** — der ungemessene Anteil ist deutlich gefallen:

| | abgerechnet | in Wohnungen gemessen | ungemessen |
|---|---:|---:|---:|
| 2025 | 437,00 m³ | 315,19 m³ | 121,81 m³ (**27,9 %**) |
| 2026 bis 10.10. | 433,90 m³ | 382,81 m³ | 51,09 m³ (**11,8 %**) |

2025 enthält Inbetriebnahme, Spülen und Leerstand; 11,8 % im laufenden Betrieb sind für
ein Dreifamilienhaus immer noch viel, aber eine andere Größenordnung.

**Neu in der Abrechnungsansicht:** ein Block „Zähler des Objekts" mit Versorgerzähler,
Hausanschluss und den beiden Zählern der Heizzentrale — samt Wasserbilanz direkt darunter.
Diese Zähler gehören keiner Wohnung und waren deshalb in der Ansicht bisher unsichtbar,
obwohl sie die Kontrollwerte der ganzen Abrechnung sind.

Der Befund „Teil des Verbrauchs ist keiner Wohnung zugeordnet" trägt jetzt den
objektbezogenen Nachtrag, dass der Abrechnungszähler bestätigt ist. Die Zuordnung des
Rests bleibt unverändert bei Variante A: beim Eigentümer.

---

## Stand 2026-10-11 — Eingabeblatt: Zählertabelle und Ablageort

Die Zählertabelle des Casameta-Eingabeblatts nennt jetzt je Zähler Kennung, Wohnung,
Medium in Klartext, Lage, Stand 01.01., Stand 31.12., Verbrauch und Einheit. Die Lage
kommt aus der Kennung, soweit sie etwas hergibt (Heizkreis Nord/Ost bzw. Süd/West,
Heizzentrale, Hausanschlussraum) — sonst steht „nicht erfasst" statt einer erfundenen
Raumangabe. Die Spalte K-Wert ist entfallen: Bei MG24 hängen Wärmemengenzähler, dort gibt
es keinen.

**Ablageort geändert (Owner-Entscheidung 11.10.2026).** Das Blatt enthält Mieternamen und
blieb deshalb bisher auf dem Server. Zulässig ist jetzt zusätzlich eine Kopie im privaten
App-Ordner des Owners unter `/Apps/bikosoc-reports/.../transfer/casameta/`, weil der
Claude-Chat sie dort für die Portaleingabe braucht. Der Hinweis im Kopf der Datei sagt das
jetzt auch so — vorher stand dort „gehört nicht nach Dropbox", was der Entscheidung
widerspricht. Jeder andere Dropbox-Ort bleibt ausgeschlossen, und in einen Report gehört
das Blatt weiterhin nicht.

---

## Stand 2026-10-11 — Stützpunktverfahren: messen, wo gemessen wurde

Die § 9b-Aufteilung vom selben Tag verteilte den GANZEN Jahresverbrauch nach
Gradtagszahlen bzw. Zeit — obwohl ab Mai echte Monatsablesungen vorliegen. Das
verschenkte die Messung. Beim Kaltwasser der Wohnung im 3. OG lief vor dem Einzug
praktisch nichts (Stand 4,17 m³ am 14.05., bis Ende Juni unverändert); der Zeitanteil
kürzte den gemessenen Verbrauch trotzdem auf 67 %.

**Neu:** Zwischen zwei Ablesungen ist der Verbrauch bekannt. Fällt der Nutzerwechsel in
ein solches Intervall, wird nur dieses Intervall geteilt — Wärme nach Gradtagszahlen,
Warmwasser und Wasser nach Tagen. Alles davor und danach ist gemessen.
`verbrauchImAbschnitt()` und `anteilAusStuetzpunkten()` in `nk/nutzerzeit.ts`; die Reihe
beginnt beim Anfangsstand des Zeitraums (notfalls dem beim Einbau hinterlegten Wert) und
endet beim letzten Stand.

**Rangfolge:** Zwischenablesung (± 3 Tage) → Stützpunktverfahren → Ganzjahres-§ 9b. Die
dritte Stufe greift nur noch, wenn im ganzen Jahr keine Ablesung vorliegt (bei MG24: die
abgeschalteten Zähler in W3).

**Wirkung MG24 2025** gegenüber der Ganzjahresaufteilung:

| | Ganzjahres-§ 9b | Stützpunkte | Differenz |
|---|---:|---:|---:|
| W1 | 609,03 € | 544,25 € | −64,78 € |
| W2 | 316,35 € | 237,09 € | −79,26 € |
| W3 | 864,07 € | 1.385,90 € | +521,83 € |
| Eigentümer | 4.209,05 € | 3.831,26 € | −377,79 € |

Objektsumme unverändert 13.398,50 €. W3 steigt, weil sein Wasserverbrauch nachweislich
erst nach dem Einzug anfiel; W1 und W2 sinken, weil ihre Wärmezähler bis zur ersten
Ablesung im Mai schon weit gelaufen waren.

Zwei Fallen, die beim Bauen auffielen:

- **Der Nenner.** Beginnt die Stützpunktreihe erst bei der ersten echten Ablesung, ist
  sie kleiner als der Jahresverbrauch — der Nutzer bekäme 100 % ausgewiesen. Deshalb geht
  der beim Einbau hinterlegte Anfangswert als erster Stützpunkt in die Reihe ein.
- **Der Intervallbeginn.** Ein Intervall reicht vom Tag NACH der ersten Ablesung bis zur
  zweiten: Der Verbrauch des Ablesetages steckt bereits im abgelesenen Stand. Ohne diese
  Verschiebung wird ein Tag doppelt gezählt.

Kennzeichnung mit Stützpunktdatum und Lückenanteil in der Abrechnungsansicht und im
Casameta-Eingabeblatt — dort über dieselbe Funktion gerechnet, damit Blatt und
Kontrollrechnung nicht auseinanderlaufen.

Tests: `nutzerzeit.test.ts` auf 38 erweitert, darunter die echten Reihen von W2-Wärme und
W3-Kaltwasser, der Auszugsfall, der Zählerrücksetzer und der Zählerstillstand. Gesamt
1098/0/0.

---

## Stand 2026-10-11 — Nutzeranteil nach § 9b HeizkostenV statt Zeitanteil

**Der fünfte Abrechnungsfehler, und der teuerste.** Beginnt ein Mietverhältnis mitten im
Jahr, misst der Wohnungszähler trotzdem ab Januar. Die Engine nahm dafür bisher einen
einheitlichen Zeitanteil (`active_days / Jahrestage`). Für Wärme ist das nach § 9b Abs. 3
HeizkostenV falsch: Dort gelten Gradtagszahlen, weil Januar und Juli nicht dasselbe
wiegen. Für Wasser war es sogar ganz abgeschaltet — der Kommentar begründete das mit
„gemessen wird ohnehin nur, was in dieser Zeit lief", was nur stimmt, wenn zum Einzug
abgelesen oder zurückgesetzt wird.

Neues Modul `nk/nutzerzeit.ts`:

- **Gradtagszahlen als Daten** (VDI 2067, Promille des Jahresbedarfs; Juni bis August als
  ein Block von 40 ‰, weil die Tabelle dort keine Monatswerte kennt). Summe 1000,
  tagweise gerechnet, Schaltjahr berücksichtigt.
- **`nutzerAnteilWaerme()` / `nutzerAnteilZeit()`** liefern den Anteil samt Grundlage:
  Zwischenablesung, Gradtagszahlen, Zeitabschnitte oder ganzer Zeitraum.
- **Zwischenablesung hat Vorrang** (§ 9b Abs. 1 und 2). Als solche gilt eine Ablesung bis
  drei Tage um den Einzugstag; weiter entfernt greift die Aufteilung. Liefert die
  Gebäudeleittechnik später echte Einzugsstände, ersetzen sie die Aufteilung von selbst —
  es ist keine Umstellung nötig.

`calcProRata()` ist entfallen. Alle vier Verteilstellen in `heating.ts` und die
Verbrauchsverteilung in `engine.ts` rechnen jetzt über `nutzerFaktoren()`.

**Wirkung MG24 2025** (nur die Verteilung, die Kosten sind unverändert):

| | vorher | nachher | Differenz |
|---|---:|---:|---:|
| W1 | 778,57 € | 609,03 € | −169,54 € |
| W2 | 739,23 € | 316,35 € | −422,88 € |
| W3 | 1.383,37 € | 864,07 € | −519,30 € |
| Eigentümer | 3.097,33 € | 4.209,05 € | +1.111,72 € |

**Plausibilitätsprobe W2** (Zähler Nord/Ost 7.404 kWh am 23.05., Süd/West 3.812 kWh am
24.05., zusammen 11.216 kWh): Die Gradtagszahlen erwarten für 01.01.–23.05. 56,0 % des
Jahresverbrauchs von 17.877 kWh, also 10.005 kWh. Gemessen sind 11.216 kWh — 12,1 %
darüber, erklärbar mit der Bautrocknung in den ersten Monaten. Vom Gemessenen entfallen
rund 2.198 kWh auf die Mietzeit ab 01.04. und rund 9.018 kWh auf den Leerstand davor.

**Neuer Blocker `NUTZERWECHSEL_OHNE_AUFTEILUNG`:** Ein unterjähriges Mietverhältnis ohne
Zwischenablesung UND ohne anwendbare § 9b-Aufteilung sperrt die Abrechnung. In der Praxis
greift immer eine der beiden Grundlagen; die Sperre fängt den Fall ab, in dem keine von
beiden trägt.

**Kennzeichnung:** Die Wohnungskarte in der Abrechnungsansicht trägt den Satz
„§ 9b-Aufteilung, Zwischenablesung fehlt" mit beiden Anteilen; dasselbe steht als Zeile im
Casameta-Eingabeblatt und in dessen Lückenliste, damit Portal und Kontrollrechnung nicht
auseinanderlaufen.

Tests: `nutzerzeit.test.ts` (28). Zwei Erwartungen in `consumption-allocation.test.ts`
beschrieben den alten Zustand (16,0 : 12,0 : 72,0 Prozent) und sind mit Begründung auf die
korrigierten Werte gesetzt. Gesamt 1087/0/0.

---

## Stand 2026-10-11 — Anfangsstände der Wärmemengenzähler aus dem GLT-Jahreszähler

Die Sperre aus dem vorigen Abschnitt ist aufgelöst, und zwar mit einem Beleg statt mit
einer Annahme. Die Gebäudeleittechnik führt je Zähler „Stand", „Jahr aktuell" und
„Vorjahr"; dass „Vorjahr" ein echter Jahreszähler ist, war in Paket 2 (Abschnitt 1f) am
Kaltwasser-Hausanschluss bewiesen. Damit gilt

```
Stand(01.01.2025) = Stand(Ablesetag) − Jahr aktuell − Vorjahr
```

Für alle acht Wärmemengenzähler ergibt das **exakt 0 kWh** — die Zähler standen zum
Jahresbeginn 2025 auf null. `scripts/anfangsstaende-wmz-mg24.ts` rechnet das nach und
erfasst die Stände über die bestehende Route
`POST /api/assets/meters/:id/readings/bulk` (Idempotency-Key, Audit-Eintrag); das Skript
ist wiederholbar und überspringt bereits erfasste Tage.

**Die Beträge ändern sich dadurch nicht** (W1 778,57 · W2 739,23 · W3 1.383,37 €,
Eigentümer 3.097,33 €). Geändert hat sich die Grundlage: Die Null ist jetzt ein belegter
Wert mit benannter Quelle und kein stiller Rückfall mehr. Die Sperre
`HEAT_METER_NO_DOCUMENTED_START` bleibt für künftige Jahre in Kraft.

Damit ist auch die Befürchtung ausgeräumt, der gesamte Zählerstand seit Einbau werde dem
Mieter angelastet: Vor dem 01.01.2025 steht auf diesen Zählern nichts. Der Verbrauch der
Zeit VOR Mietbeginn innerhalb von 2025 bleibt davon unberührt — den trägt über den
Zeitanteil der Eigentümer.

---

## Stand 2026-10-11 — Altauftrags-Stupse, Leerstandsanteil Heizung, Sperre ohne Anfangsstand

**Der Leerlauf-Wächter stupste erledigte Aufträge.** Am 11.10.2026 kamen zwei
„weiter mit …" zu Aufträgen, die am 08.10. abgeschlossen waren. Zwei Ursachen
zusammen:

1. **Namensabweichung.** Die Datei heißt `prompt-<stamm>-<datum>.txt`, der
   Report `report-<stamm>-<datum>.md` — ohne das Wort `prompt`. Die Zuordnung
   suchte `report-prompt-<stamm>-` und fand nie etwas. Jetzt vergleicht
   `hatReport()` gegen Kennung UND Stamm; das Datum im Reportnamen zählt nicht
   mit, ein Nachtrag oder ein Report vom Folgetag gilt ebenso.
2. **Kein Beobachtungsfenster.** Ein frisch ausgerollter Wächter holte die
   Aufträge der letzten drei Tage nach, von denen er nicht weiß, wie sie
   ausgegangen sind. `beobachtetSeit` steht ab dem ersten Lauf auf der
   Zustellzeit des jüngsten Auftrags; Älteres wird nie gestupst. Ohne diese
   Grenze hätte allein die Namensbehebung nicht gereicht — zum Zeitpunkt der
   Prüfung galten 24 Altaufträge als offen, die meisten ohne eigenen Report
   (Nachträge, Entscheidungen, Freigaben).

**Vierter Abrechnungsfehler: der Leerstandsanteil der Heizkosten verschwand.**
`heatingAllocation()` lieferte ausschließlich Posten mit `lease_id`, und die
Engine reichte nur solche weiter. Der Teil, auf den kein Mietzeitraum entfällt,
fiel ersatzlos weg — bei MG24 2025 **999,72 € von 4.943,22 €**. Die Objektsumme
war zu niedrig (12.398,78 € statt 13.398,50 €) und der Eigentümer sah seinen
eigenen Anteil nirgends. Bei allen anderen Kostenarten wird derselbe Rest seit
jeher als `vacancy_owner_share` ausgewiesen; die Heizung war die Ausnahme. Ein
Mantel um `heatingAllocation()` bildet die Differenz zwischen Buchungssumme und
verteilter Summe — damit gilt für Methode A, Methode B und die Grundaufteilung
dasselbe, ohne eine davon anzufassen. Die Mieteranteile ändern sich nicht.

**Sperre statt Hinweis bei Wärmezählern ohne Anfangsstand.** Fehlt der Stand zum
Periodenbeginn, weist `calculateConsumption()` den GESAMTEN Zählerstand als
Verbrauch des Zeitraums aus — bei MG24 also auch Estrichtrocknung, Bauheizung und
Leerstand nach der Sanierung. Das ist nicht „etwas zu hoch", sondern als
Abrechnung unbrauchbar, und die Zahl sieht aus wie gemessen. Neuer Blocker
`HEAT_METER_NO_DOCUMENTED_START`. Nicht gesperrt wird, wenn eine Ablesung am oder
vor dem Periodenbeginn vorliegt oder der Zähler im Zeitraum eingebaut wurde und
einen hinterlegten Anfangswert hat.

Damit der Owner trotzdem SIEHT, woran es liegt, fängt die Abrechnungsansicht den
Abbruch ab: Sie zeigt Zählerstände und Sperrgründe, markiert die betroffenen
Zähler rot — und keinen einzigen Betrag.

Nebenbefund: Die Abfrage der Ablesungen in `nkPreCheck` begann erst am 1. Januar,
während die Prüfung auf einen Anfangsstand ab November des Vorjahres suchte. Eine
Ablesung vom Dezember war damit nie zu sehen. Die Abfrage beginnt jetzt im
November.

Tests: `waermezaehler-anfangsstand.test.ts` (10), Leerstandsanteil in
`heizkosten-split.test.ts` (5), Warteschlange um 12 Fälle erweitert. Gesamt
1058/0/0.

---

## Stand 2026-10-11 — Nachzug Cue-Anzeigename ohne nickname

Der Auftrag „Anzeigename Agent <Name>" vom 08.10.2026 (`59db621`) hatte eine Stelle
offen gelassen: Die Erfolgsmeldung von `/cue_setup` setzte den Namen direkt ein und
meldete bei einem Agenten ohne `nickname` „Eingerichtet: Agent (ohne Namen)". Jetzt
läuft auch sie über `agentLabel()` und sagt „Agent Cue" wie jede andere
Owner-Nachricht des Moduls.

In der Kandidatenliste (`formatAgentList`) bleibt „(ohne Namen)" stehen: Dort stehen
die ROHEN Namen zur Auswahl, kein Anzeigelabel. Ebenso im Ergebnisobjekt, das ins
`audit_log` fließt.

---

## Stand 2026-10-11 — Abrechnung je Wohnung und Zwischenabrechnung (Teil C und D)

**Teil C — Darstellung je Wohnung.** Neuer Unterbereich „Abrechnung je Wohnung"
im Immobilien-Tab, gespeist aus `GET /api/assets/properties/:code/abrechnung-ansicht`.
Je Wohnung: Zählerstände Anfang und Ende mit Verbrauch (Wärme, Warmwasser,
Kaltwasser), Kostenarten mit ihrem Verteilschlüssel im Klartext, Vorauszahlung,
Saldo und die verlinkten Belege. Dazu der Anteil des Eigentümers und die
Befunde der Rechnung.

Drei Entscheidungen prägen die Ansicht:

- **Zählerstände statt Brüche.** „26,96 von 437" sagt einem Mieter nichts, „Ihr
  Kaltwasserzähler lief von 0 auf 26,96 m³" schon.
- **Der Verteilschlüssel im Klartext.** Nicht `sqm`, sondern „nach Wohnfläche";
  nicht `methodA(…30/70)`, sondern „Heizkosten: 30 % nach Wohnfläche, 70 % nach
  Verbrauch".
- **Gerechnet wird nicht neu.** Die Beträge kommen unverändert aus der Engine
  (`computeNk` ohne Finalisierung). Wer in der Darstellung rechnet, bekommt zwei
  Wahrheiten.

Zwei Lücken, die die Ansicht benennt statt zu verdecken: ein Zähler ohne
Anfangsstand (gerechnet wird mit dem Endstand allein — der Verbrauch ist damit
eher zu hoch) und Buchungen ohne Belegnachweis. Die Befunde sind nach Prüfcode
gebündelt; vierzehnmal derselbe Satz untereinander liest niemand.

**Teil D — Zwischenabrechnung zu beliebigem Stichtag.** `computeNk` nimmt
optional einen Zeitraum innerhalb des Jahres entgegen; alles Weitere rechnet
unverändert weiter, weil die Engine ohnehin auf `periodStart`/`periodEnd`
arbeitet. Im Dashboard genügt ein Stichtag im Datumsfeld.

Die Schätzanteile werden ausgewiesen, nicht versteckt:

- `INTERIM_BILLING_PERIOD` — keine Schlussabrechnung; was später im Jahr
  anfällt, fehlt vollständig.
- `INTERIM_COST_PRORATED` — welche Rechnungen nur anteilig zählen, mit Betrag.
  Taggenau ist nicht verbrauchsgerecht: Heizkosten fallen im Januar anders an
  als im Juli.
- `INTERIM_READING_STALE` / `INTERIM_READING_MISSING` — Zähler ohne aktuellen
  bzw. ohne jeden Stand zum Stichtag. Hochgerechnet wird bewusst nicht: Der
  Auftrag lautet, aus vorhandenen Ablesungen zu rechnen, und eine erfundene
  Zahl wäre in einer Mieterauskunft schlechter als eine benannte Lücke.

`pruefeZeitraum` ist fail-closed und verweigert insbesondere die Finalisierung:
Eine Zwischenabrechnung ist eine Auskunft, kein Dokument, aus dem eine Forderung
folgt. Ebenso abgelehnt werden Zeiträume über den Jahreswechsel (Heizkosten-
konfiguration, Vorprüfung und Belegauswahl hängen am Jahr) und Scheindaten wie
`2025-02-30`, die JavaScript stillschweigend auf den 2. März verschieben würde.

Tests: `zwischenabrechnung.test.ts` (17). Gesamt 1030/0/0, Smoke 31/31.

---

## Stand 2026-10-11 — V041 angewendet, Armierungsbedarf über Tatsachen (Teil A und B)

**V041 angewendet.** Der Verbrauchsanteil bei `heating_split` darf jetzt 0 bis
100 Prozent betragen; `verify-schema` meldet kein Drift mehr. MG24 bleibt nach
Owner-Entscheidung bei 30/70, bis die W3-Wärmemengenzähler geklärt sind — die
Sperre ist weg, die Umstellung ist eine eigene Entscheidung.

**Neues Modul `arm-status`.** Es schließt die Lücke, die der Protokollweg offen
ließ: Hat Claude Code den roten Schritt nie versucht, steht nichts im
Hook-Protokoll. Gefragt wird deshalb nach Tatsachen:

1. Liegt in den noch nicht gepushten Commits ein roter Pfad?
   (`git diff --name-only @{upstream}..HEAD` gegen die Muster aus
   `red-zone.conf` — maßgeblich bleibt allein diese Datei, eine zweite Liste im
   Code wäre der Weg, auf dem beide auseinanderlaufen.)
2. Liegt eine Migrationsdatei vor, deren Version nicht in `schema_version`
   steht?

Das Modul liegt bewusst NICHT in der Prompt-Inbox: Ein statischer Guard
verbietet ihr jeden eigenen Unterprozess, damit aller tmux-Zugriff an einer
Stelle bleibt — Git-Aufrufe gehören nach derselben Logik dorthin, wo sie
sichtbar sind.

**Drei Entscheidungen, die den Unterschied machen:**

- **Ohne Datenbankantwort wird geschwiegen** statt geraten. Sonst erzeugte
  jeder Datenbankausfall eine Meldung.
- **Boot-Zeit-Migrationen (`0xx_`-Vorsatz) zählen nicht** — die wendet der
  Dienst beim Start selbst an; sie würden dauerhaft gemeldet.
- **Versionen werden je MODUL verglichen.** V037 gibt es bei Fleet und bei
  Instagram, V043 bei Memory und bei telegram-binding. Ein Vergleich nur über
  die Zahl würde eine angewendete Migration für offen halten.

**Ein Fehler, den der eigene Test gefunden hat:** Die Übersetzung der
bash-Globs in reguläre Ausdrücke benutzte ein Leerzeichen als Platzhalter für
`**`. Der Übersetzer machte daraus zwei verschiedene unsichtbare Zeichen,
sodass kein einziges `**`-Muster mehr traf — `.claude/hooks/**` hätte also nie
angeschlagen. Behoben, indem der Platzhalter entfällt: In bash überspannt schon
ein einzelnes `*` auch Schrägstriche, `**` bedeutet dort nichts anderes.

**Tests:** 33 neue, davon ein Drittel Fehlalarm-Fälle (gewöhnliche
Quelldateien, Dateien mit „migration" im Namen außerhalb des Ordners, Tests zu
Migrationen, leere Konfiguration, Datenbankfehler). Gesamt 1013/0/0.

---

## Stand 2026-10-11 — Wächter meldet eine wartende Armierung (Ergänzung Teil Q)

Owner-Ergänzung zur C7-Freigabe von Teil Q.

**Warum ein Stups hier nicht hilft:** Wartet Claude Code auf `/arm`, lässt sich
der rote Schritt nicht ausführen. Ein „weiter mit …" würde nur denselben
blockierten Versuch wiederholen. Gebraucht wird der Owner — einmal und sofort,
ohne die zehn Minuten Leerlauf abzuwarten.

**Erkannt am Protokoll des Deny-Hooks**, nicht an Textdeutung in Berichten: Der
Hook schreibt bei jedem blockierten roten Pfad oder Befehl eine `[BLOCK]`-Zeile
mit `not armed` und beim Einlösen eine `[ARMED]`-Zeile. Eine Blockade gilt nur
als offen, wenn danach keine Armierung mehr verbraucht wurde — ohne diese
Prüfung käme die Meldung noch Stunden nach dem Erledigen. Zeitfenster sechs
Stunden, Meldung je Blockade genau einmal.

**Die Meldung trägt einen antippbaren Link:**
`https://t.me/share/url?url=%2Farm%20push` öffnet im Telegram-Client ein
Eingabefeld mit dem vorbereiteten Befehl; der Owner wählt nur noch den Chat.
Ein echter Befehlslink ist in Telegram nicht möglich.

**Der zweite Erkennungsweg aus der Owner-Ergänzung — „der letzte Report nennt
`wartet auf /arm`" — ist gebaut, geprüft und wieder entfernt worden.** In einem
Markdown-Bericht ist ein ganzer Absatz EINE Zeile; jeder Bericht, der diese
Mechanik erklärt, enthält `/arm` und Wörter wie „wartet auf" mehrfach. Dazu
entstehen abgeschnittene Zeilenfragmente, weil Anfang und Ende der Datei
getrennt gelesen werden. Drei Fassungen mit immer engeren Mustern schlugen jedes
Mal auf einem Prosaabsatz des Teil-Q-Berichts an und nannten in der Meldung
einen Satzfetzen statt einer Aufgabe. Eine Meldung, die alle zehn Sekunden
Fehlalarm gibt, wird ignoriert — und hilft dann auch im echten Fall nicht.

Das Hook-Protokoll bleibt als einziger Weg: Es ist ein Tatsachenbeleg und deckt
jeden Fall ab, in dem der rote Schritt wirklich versucht wurde. Die offene
Lücke — Claude Code versucht es gar nicht, weil es die Blockade vorhersieht —
liesse sich über Tatsachen schliessen statt über Textdeutung: „liegt in den
nicht gepushten Commits ein roter Pfad?" und „liegt eine Migrationsdatei vor,
deren Version nicht in schema_version steht?". Als Vorschlag vermerkt, nicht
gebaut.

**Tests:** 10 neue, darunter der Fall „nach der Blockade wurde armiert" (darf
nicht melden) und „dieselbe Blockade zweimal" (meldet nur einmal). Gesamt
980/0/0.

---

## Stand 2026-10-11 — Brennstoff nach Lagerbestand (Entscheidungen zu Paket 3c)

**Lagerbestandsrechnung statt Lieferdatum.** § 7 Abs. 2 HeizkostenV legt „die
Kosten der verbrauchten Brennstoffe" um — nicht die Kosten der im
Abrechnungsjahr gelieferten. Owner-Entscheidung 11.10.2026; sie ersetzt die
Entscheidung „Pellets nach Lieferdatum" vom 10.10.2026.

```
Anfangsbestand 01.01.2025   5,00 t   1.695,84 EUR  (Preis Lieferung 910222)
Zukauf 2025                12,94 t   5.435,13 EUR  (3 Lieferungen)
Endbestand 31.12.2025      -5,00 t  -2.187,75 EUR  (Preis Lieferung 109505)
                           ───────  ─────────────
Verbrauch                  12,94 t   4.943,22 EUR  = 64.700 kWh bei Hi 5 kWh/kg
```

Die Differenz von −491,91 Euro kommt **nicht aus der Menge, sondern aus dem
Preis**: Beide Bestände sind mit 5,00 t angesetzt, der Anfangsbestand aber zu
339,17 EUR/t und der Endbestand zu 437,55 EUR/t. Verbraucht wurde das billige
alte Lager, liegen blieb das teurere neue — genau das bildet die Rechnung ab.

**Umsetzung über zwei zusätzliche Buchungen** statt über eine Änderung der
Lieferbuchungen: Die drei Lieferungen bleiben als Zukauf stehen, dazu kommen
der Anfangsbestand als Zugang und der Endbestand als Abgang (negativer Betrag).
So bleibt jede Rechnung einzeln nachvollziehbar und die Bestandsrechnung ist an
den Buchungen selbst ablesbar. `scripts/pelletbestand-mg24.ts` prüft nach dem
Lauf, dass die Heizungskosten im Zeitraum genau dem errechneten Verbrauch
entsprechen.

**Beide Bestände sind Arbeitsannahmen** und als solche gekennzeichnet — in der
Buchungsnotiz, in `system_settings.brennstoffbestand` und im Eingabeblatt. Der
Endbestand ist eine offene Owner-Frage.

**Weitere Entscheidungen eingearbeitet:** Die Casameta-Abrechnungsgebühr ist als
umlagefähige Heizkosten-Nebenposition vorgesehen (Betrag nach der Abrechnung).
Aus dem Allgemeinstrom wird KEIN Schätzanteil für den Betriebsstrom der Heizung
abgespalten — der Posten bleibt „nicht getrennt erfasst". MG24 bleibt bei 30/70,
bis die W3-Wärmemengenzähler geklärt sind; das Ziel 0/100 steht als offener
Punkt in der Dashboard-Kachel und wartet auf Fa. Fiehn.

**Probe 2025 danach:** W1 778,57 · W2 739,23 · W3 1.383,37 · Eigentümer
2.097,61 Euro.

---

## Stand 2026-10-11 — Prompt-Inbox stellt nur noch bei Bereitschaft zu (Teil Q)

**REVIEW-pflichtig nach C7** — gebaut, getestet, NICHT gepusht.

**Was bisher passierte** (gemessen, nicht vermutet): Die Inbox tippte eine
Datei über `tmux send-keys` ins Pane, ohne zu prüfen, was dort läuft. Acht
Aufträge gingen so mitten in laufende Durchgänge. Ergebnis der Messung: Claude
Code nimmt den Text als Zwischennachricht auf und arbeitet ihn im selben
Durchgang ab — nichts geht verloren, nichts wird zusammengeführt.

**Zwei Risiken blieben.** Erstens: Steht ein Dialog mit numerierten Optionen
offen, ist getippter Text keine Nachricht, sondern eine ANTWORT — die erste
Zeile eines Auftrags würde eine Option auswählen, die niemand gewählt hat. Das
ist der gefährliche Fall, nicht der verlorene Auftrag. Zweitens war die
Reihenfolge nicht zugesichert: sortiert wurde nach Dateiname, und der trägt den
Zeitstempel der Dropbox-Übergabe statt den der Ablage.

**Jetzt:** `prompt-inbox/bereitschaft.ts` prüft den Pane-Text (reine Funktionen,
ohne tmux testbar). Zugestellt wird nur bei ruhendem Pane, und dann höchstens
EINE Datei pro Lauf — nach der Zustellung arbeitet Claude Code, eine zweite
Datei träfe genau den Zustand, den die Prüfung verhindern soll. Bei Unklarheit
wird nicht zugestellt: Ein leeres Pane heißt tmux nicht erreichbar, und ins
Leere zu tippen verliert den Auftrag still. Reihenfolge nach Dateizeit.

Die Dialogerkennung ist eng gefasst: Eine numerierte Liste aus einem
Auftragstext im Scrollback darf nicht sperren — eine Sperre, die immer greift,
ist so schlimm wie keine.

**Leerlauf-Wächter:** 10 Minuten untätig und ein übergebener Auftrag ohne
zugehörigen Report → `weiter mit <Datei>`. Nach dem zweiten erfolglosen Stups
Telegram an operativ, danach ruht der Wächter für diesen Auftrag. Grund für die
Grenze: Die Zuordnung Auftrag → Report ist eine Annäherung, ein Nachtrag
bekommt oft keinen eigenen Report — ohne Grenze wäre das ein Dauerstups.
Nachts identisch.

**Ein Guard hat gegriffen, wie er soll:** `kontrollflaeche.test.ts` verbietet
der Inbox jeden eigenen tmux-Aufruf. Der erste Entwurf las das Pane direkt und
verstiess dagegen; das Pane-Lesen ist als `lesePaneInhalt()` nach
`cc-prompt-dispatch` gewandert, wo aller tmux-Zugriff liegt. Ein zweiter Guard
verglich die Importzeile wörtlich und schlug an einer Formatierung an — er
prüft jetzt die Sache (Helfer aus cc-prompt-dispatch, nichts direkt aus
child_process) statt die Schreibweise. Geschwächt ist nichts.

**Tests:** 30 neue, davon sechs Missbrauchsfälle nach C7 in beiden Richtungen.
Dazu ein Lauf mit zwei Dummy-Aufträgen gegen das ECHTE Pane der laufenden
Sitzung: während der Arbeit wurde nichts getippt, danach beide in richtiger
Reihenfolge. Gesamt 970/0/0.

---

## Stand 2026-10-11 — Casameta-Hybrid und der dritte Abrechnungsfehler (Paket 3c)

**Abrechnungsarchitektur hybrid.** bikosoc hält Daten, Belege und
Kontrollrechnung; Casameta erzeugt das rechtsverbindliche Mieter-PDF. Eine
Schnittstelle gibt es nicht — deshalb ein **Eingabeblatt** mit allen
Portalfeldern in Portalreihenfolge: `docs/casameta-mapping.md` für das Warum,
`system_settings.casameta_mapping` für die Daten, `src/modules/assets/casameta.ts`
für die Erzeugung. Dieselbe Funktion nutzen Kommandozeile und Core-Route, damit
beide Wege nie auseinanderlaufen. Eine Lücke wird als `FEHLT` ausgewiesen und
nicht geschätzt: Ein leeres Feld im Portal fällt auf, ein erfundener Wert nicht.

Das erzeugte Blatt enthält Mieternamen und liegt deshalb in
`~/bikosoc-spec/casameta/` — einem Unterordner, den der Report-Watcher nicht
liest (er nimmt nur `report-*.md` direkt im Ordner und arbeitet nicht
rekursiv; nachgeprüft).

**V041 geschrieben, nicht angewendet** (Rote Zone): Der CHECK auf
`allocation_rules` schrieb bei `heating_split` 50 bis 70 Prozent
Verbrauchsanteil vor — den Rahmen des § 7 Abs. 1 HeizkostenV. Der Owner hat
sich bewusst dagegen entschieden und trägt das Risiko aus § 12 selbst. An die
Stelle der Datenbanksperre tritt der Befund
`HEATING_SPLIT_OUTSIDE_HEIZKOSTENV` in jeder Abrechnung: Eine Sperre, die eine
bewusste Eigentümerentscheidung blockiert, wäre falsch — eine stillschweigende
Abweichung aber auch. Die Summe aus Grund- und Verbrauchsanteil muss weiter
genau 100 Prozent ergeben; das ist Arithmetik, keine Rechtsfrage.

### Der dritte Fehler in der Abrechnungslogik

§ 9 Abs. 2 HeizkostenV lässt die Schätzformel Q = 2,5 · V · (tw − 10) nur zu,
wenn die Wärmemenge für das Warmwasser NICHT gemessen wird. MG24 hat einen
Zähler dafür — die Engine hat ihn ignoriert und geschätzt: 18.331 kWh nach der
Formel gegen 9.151 kWh gemessen, durch die Kappung bei 50 Prozent verdeckt. Dem
Warmwasser wurde damit die Hälfte aller Heizkosten zugeordnet statt der
gemessenen 31 Prozent. Weil Warmwasser nach den Warmwasserzählern und Raumwärme
nach den Wärmemengenzählern verteilt wird, verschob das Geld zwischen den
Wohnungen: W3 trug 414 Euro zu viel, W1 und W2 entsprechend zu wenig.

Behoben: Messwert vor Formel, Nenner ist die Summe der gemessenen Kreise (der
Hauptzähler misst bei MG24 nur den Heizkreis — ihn als Nenner zu nehmen hiesse,
das Warmwasser doppelt zu zählen). Befund `HEATING_WW_MEASURED` weist Messwert
und Formelwert nebeneinander aus.

**Zur Umstellung auf 0/100 bei MG24: vorerst nicht empfohlen.** W3 trägt heute
Grundkosten bei NULL Verbrauchsanteil, weil seine Wärmemengenzähler nach
Owner-Entscheidung E2 abgeschaltet sind. Bei 0/100 fiele dieser Betrag weg und
ginge an W1 und W2 — das Gegenteil der Absicht. Erst nach Klärung mit Fa. Fiehn.

**Neue Routen:** `GET …/belege` (Belegliste aus Archivindex und `entity_links`),
`GET …/mieterstrom`, `GET …/abrechnungsbereitschaft?jahr=`,
`POST …/casameta-eingabeblatt?jahr=`, `POST /api/assets/cost-categories`
(protokolliert, weil an Kostenarten Umlageregeln und damit Geld hängen).
Dazu `scripts/setze-einstellung.ts`, das über `setSetting()` schreibt und damit
den Audit-Eintrag in derselben Transaktion erzeugt.

**Zwischenabrechnung bei Mieterwechsel: kann die Engine nicht.** `computeNk()`
nimmt ausschliesslich ein Kalenderjahr; Gradtagszahlen kommen im Code nicht vor,
der Zeitanteil ist linear. Für einen Auszug Ende Juni ist das zu grob —
Folgeauftrag mit Aufwand M bis L im Report beschrieben.

**Tests:** 11 neue (0/100, 30/70, 50/50, Befund bei Abweichung in beide
Richtungen, Messwert vor Formel). Gesamt 940/0/0.

---

## Stand 2026-10-11 — SWT-Belegarchiv und zwei Fehler in der Verbrauchsverteilung (Paket 3b)

**Belegarchiv ohne neue Tabelle.** `entity_links` trug schon Objekt, Belegart und
entweder SharePoint-Referenz oder lokale Datei; die fachlichen Felder (Sparte,
Vertrag, Leistungszeitraum, Verbrauch, Zählernummer, SHA-256) stehen im Index
`artifacts/personal/assets/belege/index-swt.json` daneben. 47 SWT-Rechnungen
samt Textfassungen archiviert, 43 Verknüpfungen, 10 Rechnungen auch in
SharePoint (vermerkt, nicht doppelt abgelegt). `scripts/archiv-swt-rechnungen.ts`
lädt nichts erneut, was schon im Archiv liegt.

Ausgeliefert werden die Dateien über `GET /api/belege/:code` am Dashboard —
Metadaten vom Core, Datei vom Dashboard-Server, Pfad gegen das
Belegverzeichnis geprüft. Dazu `GET /api/links/by-code/:code` im Core und der
neue Dashboard-Unterbereich *Belege & Strom*.

**MG24-Buchungen auf die Rechnungen umgestellt** (`scripts/buchungen-mg24-swt.ts`,
alles über Core-Routen mit Audit). Vier Buchungen stillgelegt, zehn neu. Der
Fehler dahinter: In Paket 2 wurde der ZAHLBETRAG mit dem ZAHLTAG als Zeitraum
gebucht. Kosten sind aber die Rechnungssumme, und der Leistungszeitraum ist der
abgerechnete — die Wasserjahresrechnung für 2025 lag dadurch im Jahr 2026 und
damit in keiner Abrechnung 2025. Kontrollsummen 2.353,01 € und 5.462,08 €
stimmen auf den Cent; die Stromschlussrechnung ist nach den Preisblöcken der
Rechnung in fünf Zeiträume geteilt, nicht geschätzt.

Neue Kostenart `niederschlagswasser` (BetrKV §2 Nr. 3) mit Flächenschlüssel,
angelegt über die neue, protokollierte Route `POST /api/assets/cost-categories`.
Niederschlagswasser wird nach versiegelter Fläche erhoben; unter
`entwaesserung` wäre es nach Wasserverbrauch verteilt worden.
`PATCH …/expense-bookings/:id` kann jetzt Umlagefähigkeit, Leistungszeitraum,
Notiz und `archived` setzen — stilllegen statt löschen, die Spur bleibt.

### Zwei Fehler in der Verbrauchsverteilung, beide mit Geldwirkung

**Der Nenner war die Summe der Wohnungszähler statt der abgerechneten Menge.**
Damit wurde der volle Rechnungsbetrag auf die Wohnungen verteilt: Bei MG24
berechnen die Stadtwerke für 2025 437 m³, die Wohnungszähler messen 315 m³ —
die Mieter trugen auch die Kosten der 122 ungemessenen Kubikmeter. Der
Kommentar an `allocateByConsumption` behauptete seit dem 10.10.2026 das
Richtige, der Code tat es nicht. Jetzt ist der Hauptzähler der Nenner, der
ungemessene Rest bleibt beim Eigentümer, und drei neue Befunde machen die Lage
sichtbar: `CONSUMPTION_UNMEASURED_REMAINDER`,
`CONSUMPTION_MAIN_METER_BELOW_UNITS` (Hauptzähler kleiner als die
Wohnungszähler — physikalisch unmöglich, wird nicht verwendet) und
`CONSUMPTION_NO_MAIN_METER`.

**Die Kostenart `wasser` zählte nur Kaltwasserzähler.** Der Versorger
berechnet aber alles Wasser durch den Hausanschluss, und das Warmwasser der
Wohnung kommt durch denselben Anschluss. Das gemessene Warmwasservolumen der
Mieter blieb dadurch als ungemessener Rest beim Eigentümer — bei MG24 rund
280 € im Jahr. Doppelt berechnet wird nichts: Volumen über `wasser` und
`entwaesserung`, Wärme über `warmwasser`.

Zwei Tests hielten das alte Verhalten fest und sind mit Begründung korrigiert,
nicht entfernt. Dazu der SWT-Abrechnungszähler 8ZRI2316739802 als Hauptzähler
mit seinen beiden Jahresständen; der GLT-Zähler am Hausanschluss ist
Beobachtungszähler geworden, weil er für 2025 nur 34,5 m³ zeigt und damit
weniger als die Wohnungen hinter ihm.

**Tests:** 9 neue. Gesamt 929/0/0.

---

## Stand 2026-10-11 — Korrektur der Belegzuordnung (Reizner, vierte Pelletlieferung)

Owner-Korrektur zum Nachtrag. Beide Punkte waren Zuordnungen, die ich mangels
Beleg offen gelassen hatte und die der Owner aus Paket 1 und 2 auflösen konnte.

**Reizner 128,46 € ist MG24, nicht N24.** Rechnung 178-2025 vom 26.09.2025,
„Netzwerkanschluss Heizung" — belegt in Paket 1 C2 und Paket 2 K7. Einmalige
Herstellung und damit nicht umlagefähig, Kostenart `heizung`. Der offene
Vorschlag ist über die Selbstheilung von N24 auf MG24 umgestellt worden, ohne
dass eine Zeile von Hand angefasst werden musste. Die N24-Rechnungen 054-2025
(161,78 €) und 223-2025 (174,87 €) stehen ausdrücklich NICHT in der Liste —
ihre Kostenart und Umlagefähigkeit sind nicht belegt; sie sind nur im Hinweis
vermerkt, damit sie nicht wieder verloren gehen.

**Die Zahlung vom 03.01.2025 über 1.695,84 € ist zugeordnet:** Koch-Rechnung
910222 vom 20.12.2024, 5,00 t Holzpellets. Nach dem Leistungsprinzip liegt sie
in **2024** und fällt damit aus der Abrechnung 2025 — die enthält jetzt drei
Lieferungen über 5.435,13 €. Verbrannt wurden die Pellets allerdings 2025.
Ohne Lagerbestandsführung ist das Leistungsprinzip bei Pellets systematisch
ungenau; die Entscheidung über eine Lagerbestandsrechnung fällt in Paket 3c.

**Eine Stelle nachgezogen:** Die Selbstheilung vergleicht jetzt auch die
Rechnungsnummer. Wird eine zunächst unbekannte Nummer nachgetragen — genau der
Fall bei Reizner —, trug der Vorschlag sonst weiter „Sammelüberweisung" statt
des Belegs.

**Tests:** 6 neue. Gesamt 926/0/0.

---

## Stand 2026-10-10 — Nachtrag zu Paket 3: Einstufungen und Rechnungsabgleich

Owner-Entscheidungen zu den drei Vorschlagsgruppen, dazu zwei Erweiterungen am
Vorschlagswesen. Keine Migration, keine Rote Zone — die Regeln sind Daten, das
Buchungs-Update läuft über eine neue Core-Route mit Audit.

**Einstufungen korrigiert.** SWT-Vertrag 387849 ist laut Kundenportal
„Marktgasse 24 (Wasser)" — Kostenart `wasser`, umlagefähig; dazu die
Gegenstückregel für 387847 (Abwasser) aus der Spartentrennung ab 2026.
Energiekonzept KNr 11142 ist **kein Wärmeposten**, sondern der Abrechnungsdienst
der Mieterstrom-Kundenanlage einschließlich 600 € Einrichtung: Betreiberkosten
des Mieterstrommodells, kein BetrKV-Posten. Regel umbenannt, Kostenart
`sonstige_betrkv`, vorerst nicht umlagefähig; die in Paket 2 angelegte Buchung
über 2.841,22 € ebenfalls. Allgemeinstrom 348661 bleibt gesperrt, bis Paket 3b
die Schlussrechnung nach den drei Zeiträumen aufteilt.

**Neue Core-Route** `PATCH /api/assets/properties/:code/expense-bookings/:id`
für Umlagefähigkeit, Leistungszeitraum und Notiz. Betrag, Objekt und Kostenart
bleiben außen vor — das wäre eine andere Buchung.

**Rechnungsabgleich für Sammelüberweisungen.** Die Pelletrechnungen werden über
Sammelüberweisungen bezahlt; dort liefert die Bank weder Gegenpartei noch
Verwendungszweck, nur den Buchungsschlüssel `SAMMELUEBERWEISUNG` und bei
mehreren Posten „ANZAHL n". Eine Regel auf die Gegenpartei kann dort
grundsätzlich nicht greifen — der größte Nebenkostenposten von MG24 wäre
dauerhaft ohne Vorschlag geblieben.

Eine Regel kann deshalb statt Mustern eine Liste `rechnungen` tragen (Nummer,
Betrag, Lieferdatum). Der Abgleich erklärt den Zahlbetrag aus einer Rechnung
oder aus einem Paar — und das Paar darf aus **verschiedenen Regeln** stammen:
Die Überweisung über 1.630,85 € bestand tatsächlich aus einer Pelletrechnung
über 1.502,39 € (MG24) und einer Elektrorechnung über 128,46 € (N24). Jede
beteiligte Rechnung erzeugt ihren eigenen Vorschlag mit eigener Kostenart und
eigenem Objekt. Der Leistungszeitraum ist das **Lieferdatum der Rechnung**, nicht
der Zahltag.

**Mehrdeutigkeit führt zu keinem Treffer.** Lassen sich mehrere
Zusammenstellungen auf denselben Betrag bringen, wird nicht geraten — die
Zahlung bleibt ohne Vorschlag und das steht in der Meldung. Ein geratener Beleg
wäre schlimmer als keiner.

**Abgleich gegen vorhandene Buchungen.** Die 16 Buchungen aus Paket 2 dürfen
nicht doppelt entstehen. Zwei Stufen, weil die Datenlage zwei Fälle kennt:

- **zahlungsgenau** (gleiches Objekt, gleicher Betrag, Zahltag im Abstand von
  höchstens drei Tagen) → der Vorschlag wird zurückgezogen und nennt die
  Buchung. 11 Vorschläge über 24.747 € sind so stillgelegt worden, darunter alle
  fünf Pelletrechnungen.
- **nur Zeitraum-Überschneidung** (gleiche Kostenart, überschneidender
  Leistungszeitraum) → **nicht** zurückgezogen, sondern mit einer ausdrücklichen
  Warnung in der Begründung versehen. Das betrifft die drei Sammelbuchungen aus
  Paket 2, die mehrere Zahlungen zusammenfassen; still unterdrücken könnte einen
  echten zusätzlichen Posten verschlucken. 46 von 60 offenen Vorschlägen tragen
  diese Warnung.

Ein eigener Status „bereits gebucht" wäre eine Schemaänderung und damit Rote
Zone gewesen; Stufe 1 nutzt deshalb `verworfen` mit sprechender Notiz. Für den
Owner ist der Vorschlag damit wie gefordert nicht mehr offen, und der Grund
steht dabei.

**Wirkung auf die Probe-Abrechnung 2025** (Energiekonzept nicht mehr
umlagefähig): Saldo W1 1.100,98 → 372,60 € · W2 998,03 → 391,79 € · W3
1.449,67 → 616,95 € · Eigentümer 2.021,72 → 1.347,84 €. Die Summe der
Entlastungen ist exakt 2.841,22 €.

**Tests:** 27 neue (Rechnungsabgleich, Buchungsabgleich, korrigierte
Einstufungen). Gesamt 920/0/0.

---

## Stand 2026-10-10 — Umsatz-Nachtrag und Buchungsvorschläge (Paket 3, Teile 3 und 5)

Migration **V040** (Rote Zone, Owner-Freigabe): `banking_transactions.source`
und die Tabelle `expense_booking_proposals`.

**Warum die Herkunftsspalte.** Bis hierher konnten Umsätze ausschließlich aus
der FinTS-Synchronisierung kommen; der Bestand endete deshalb am 29.06.2026,
obwohl die Kontoauszüge als PDF vorlagen. Ohne `source` ließe sich ein
nachgetragener Umsatz später nicht von einem synchronisierten unterscheiden —
und damit auch nicht gezielt zurücknehmen.

**Nachtrag aus Kontoauszügen** (`src/modules/banking/import.ts`,
`POST /api/internal/banking/import-transactions`). Nachgetragen wurden
1.722 Zeilen aus zwei Auszügen, davon **235 neu** (173 auf Konto …9268,
62 auf …4295); der Bestand wuchs von 1.633 auf 1.868 Umsätze.

Der Abgleich läuft in zwei Durchgängen, der strengere zuerst: gleicher Betrag
am gleichen Buchungstag, danach ein Fenster von ±3 Tagen gegen Buchungs- UND
Wertstellungsdatum — das fängt die Fälle, in denen FinTS die Wertstellung als
Buchungsdatum geführt hat (47 Treffer). Entscheidend ist, dass die Zuordnung
**eineindeutig** ist: Ein Bestandssatz kann nur eine Importzeile erklären.
Ohne diese Regel gälten zwei gleich hohe Mietzahlungen innerhalb einer Woche
beide als Dublette, und eine davon fehlte danach dauerhaft. Nachgewiesen über
einen Monatsvergleich: In allen 24 überlappenden Monaten beider Konten hält
der Bestand mindestens so viele Umsätze wie der Auszug.

**Buchungsvorschläge** (`src/modules/assets/expense-rules.ts`,
`proposals.ts`, `/api/assets/expense-proposals`, Dashboard-Unterbereich
„Kostenvorschläge"). Nach jedem erfolgreichen Bankabgleich — an einer Stelle in
`runWeeklySyncWithReport`, damit kein Aufrufweg vergessen wird — laufen die
Regeln über die Umsätze und legen Vorschläge mit Status `offen` an. **Gebucht
wird nichts.** Erst ein Klick des Owners macht aus einem Vorschlag genau eine
`expense_booking`; ein zweiter Klick erzeugt keine zweite.

Die **Regeln sind Daten** in `system_settings.expense_rules` — eine neue
Gegenpartei oder Vertragsnummer kostet kein Deployment. Startbestand: elf
Regeln für MG24, jede auf einem Beleg oder einer im Bestand nachgewiesenen
Gegenpartei. Daraus 65 Vorschläge über 28.672,27 €.

**Drei Entscheidungen, die den Unterschied machen:**
- **Betriebsbeginn als Regelgrenze.** Alle MG24-Betriebskostenregeln beginnen
  am 05.11.2024, dem Tag nach der Schlussabnahme (K8). Dieselbe Wasserrechnung
  ist davor Herstellungsaufwand und danach umlagefähige Nebenkosten; ohne
  diese Grenze schlug die erste Fassung Baukosten als Nebenkosten vor.
- **Leistungsprinzip statt Zahlungszeitpunkt.** Eine Wasserjahresrechnung für
  2025, abgebucht im März 2026, gehört in die Abrechnung 2025. Der Zeitraum
  kommt aus dem Verwendungszweck; fehlt dort das Jahr, gilt bei Zahlung im
  ersten Halbjahr das Vorjahr. Abschläge laufen dagegen über den
  Zahlungsmonat — die erste Fassung gab ihnen das Vorjahr.
- **Keine Regel auf eine ungeklärte Objektzuordnung.** Die drei
  Abfall-Buchungszeichen im Bestand gehören NICHT zu MG24 (das trägt
  73 058 488/001). Eine Regel darauf hätte Kosten dem falschen Haus
  zugeordnet, und das fällt in einer fertigen Abrechnung niemandem mehr auf.

**Selbstheilung.** Weil die Regeln änderbar sind, hält jeder Lauf die offenen
Vorschläge gegen den aktuellen Regelstand: Trifft eine Regel nicht mehr, wird
der Vorschlag zurückgezogen; haben sich Betrag, Kostenart oder Zeitraum
geändert, wird er angepasst. Bestätigte und verworfene Vorschläge bleiben
unberührt — sonst stünden nach einer Korrektur genau die Vorschläge da, die
sie beheben sollte.

**Kontonamen.** `PATCH /api/banking/accounts/:id` (eigener, protokollierter
Weg, weil `upsertAccount` den Anzeigenamen bewusst per COALESCE erhält).
Konto 4 → „La Perla GmbH — Geschäftsgiro", Konto 7 → „Immobilien Bickel —
Mietkonto".

**Tests:** 55 neue (15 Dublettenabgleich, 27 Regelauswertung, 13 Lebenszyklus
gegen eine echte Datenbank). Gesamt 893/0/0.

**Rückweg:** `bun run scripts/rollback-v040.ts --apply` (bricht ab, solange
nachgetragene Umsätze oder bestätigte Vorschläge vorhanden sind) ·
`pg_restore` aus `~/backups/openclaw-20261010-204811.dump` ·
`git revert` je Commit.

---

## Stand 2026-10-10 — Automatischer Zählerimport (Paket 3, Teil 2)

Owner-Leitprinzip: Was dauerhaft anfällt, läuft ohne Handgriff; gemeldet wird
nur, was abweicht. Neues Modul `src/modules/meter-import/`.

**Was es tut.** Es holt die Monatsberichte von Fa. Fiehn aus dem Postfach,
liest je Zähler den letzten Stand des Berichtsmonats und trägt ihn als
`meter_readings` ein (Wh → kWh, `annual` zum Jahreswechsel, sonst `interim`,
Quelle `automatic`, Mail-Kennung in `notes`). Je Zähler ein Audit-Eintrag
`meter_reading.auto_import`.

**Zuordnung als Daten.** `system_settings.meter_import_mapping` bildet
Berichtsüberschrift → Objekt und Spaltenüberschrift → `meter_number` ab. Für
N24, L19 und S28 kommt später ein Block dazu, kein Code. Fehlt die Zuordnung,
wird nicht geraten: Der Bericht bleibt liegen und das wird gemeldet.

**Vier Prüfungen**, alle mit Schwellen aus derselben Konfiguration:
Monotonie · Bilanz Haupt- gegen Unterzähler · Verbrauchssprung · fehlender
Monatsbericht. Eine Abweichung verhindert den Import NICHT — der Stand wird
geschrieben und die Abweichung gemeldet, sonst entstünden Lücken in der
Zeitreihe, die später niemand mehr schließt.

**Drei Entscheidungen, die den Unterschied machen:**
- Die Bilanz vergleicht **kumulierte Zählerstände**, keine Monatsdifferenzen.
  Die Berichte protokollieren je Zähler unterschiedlich weit in den Monat
  hinein; in der Heizperiode sind zwei Tage mehrere hundert Kilowattstunden,
  und eine Monatsbilanz schlüge dauernd grundlos an.
- Der Sprungtest gilt **nur für Wasser**. Heizung ist saisonal: zwei
  Kilowattstunden im August, zweihundertsechzig im Oktober — das ist der
  Normalfall, und eine Meldung darüber würde bald ignoriert.
- Bekannte, bereits gemeldete Abweichungen stehen mit Stichtag und Begründung
  in der Konfiguration (`bekannteAbweichungen`). Die Wasserbilanz von MG24 ist
  so bis zur Antwort von Fa. Fiehn abgehakt — sonst käme bei jedem Lauf
  dieselbe Nachricht.

**Auslöser.** Der bestehende Mail-Intervall in `index.ts`, kein neuer Dienst
und kein neuer Timer. Eigenes Flag `METER_IMPORT_ENABLED` (Vorgabe: an) —
`MAIL_BOOKING_SCAN_ENABLED` schaltet die Buchungserkennung ab, und wer die
pausiert, will nicht zugleich die Zählerstände verlieren.

**Wochenbericht.** `buildWeeklySummary()` zeigt eine Zeile „Zählerstände
importiert: n", gelesen aus dem Audit-Log. Ohne sie sähe man nie, DASS der
Import läuft.

**Erster Lauf gegen das echte Postfach:** 40 Mails, 56 neue Stände; der zweite
Lauf 0 neue und 212 erkannte Doppel — idempotent und still.

---

## Stand 2026-10-10 — NK-Engine: Verbrauchsschlüssel und Torwächter (Paket 3, Teil 1 und 4)

Zwei Befunde aus Paket 2 behoben, beide geldrelevant und deshalb mit Tests.
Report: `~/bikosoc-spec/report-paket3-nk-automatisierung-20261010.md`.

**`consumption` wird jetzt gerechnet.** `allocateCosts()` kannte die Fälle `sqm`,
`persons`, `units`, `mea`, `fixed` und `direct`. Eine Regel mit
`key_type = 'consumption'` fiel in den Vorgabezweig und verteilte nach Fläche —
für Heizung und Warmwasser unauffällig (die laufen über `heatingAllocation()`),
für **Kaltwasser und Entwässerung** aber genau an den Zählern vorbei. Bei MG24
verschiebt der Unterschied rund 600 Euro zwischen den Wohnungen.

Neu ist `allocateByConsumption()`. Die Medienzuordnung steht als Tabelle an einer
Stelle (`wasser` → cold_water, `entwaesserung` → cold_water + warm_water,
`warmwasser` → warm_water). Der Hauptzähler am Hausanschluss verteilt **nicht**
mit — er dient dem Abgleich mit der Versorgerrechnung. Was kein Wohnungszähler
erfasst, bleibt beim Eigentümer statt auf die Mieter verteilt zu werden; bei MG24
ist das die bislang ungeklärte Differenz zwischen Stadtwerke-Abrechnung und
Summe der Wohnungszähler.

**Zwei neue Vorprüfungsbefunde.** `CONSUMPTION_READING_MISSING` (Blocker) greift,
wenn ein Zählerstand fehlt — es wird NICHT mehr still auf Fläche ausgewichen.
`CONSUMPTION_START_ASSUMED_ZERO` (Warnung) greift, wenn der Anfangsstand fehlt,
am Zähler aber ein Anfangswert hinterlegt ist. Ohne diese Ausnahme wäre die
Abrechnung 2025 für MG24 gesperrt: Die Protokollierung beginnt dort erst im Mai
2025, der Nullstart zum 01.01.2025 ist über den Jahreszähler der
Gebäudeleittechnik und die Brennstoffbilanz belegt.

**`MISSING_UNIT_RESIDENTS` blockt nur noch, wenn es etwas bewirkt.** `computeNk()`
stufte die Warnung immer zum Blocker hoch. Rechnerisch nötig ist die Personenzahl
aber nur beim Schlüssel `persons`. Bei MG24 verteilt keine einzige Regel nach
Personen — die Abrechnung scheiterte an einem Torwächter ohne Rechenbezug. Die
Vorprüfung liefert dafür neu das Feld `uses_person_key`.

**Ein Nebenbefund mit Wirkung auf alle Verbrauchsrechnungen.** `calculateConsumption()`
las das Periodenende als Mitternacht: Eine Ablesung vom 31.12. um 22:41 Uhr fiel
aus dem Zeitraum heraus und der Jahresverbrauch war zu klein. Genau so stehen die
Stände aus den Monatsberichten in der Datenbank. Gerechnet wird jetzt bis zum
Tagesende. Die sechs Goldfile-Szenarien bleiben unverändert grün.

**Routen ergänzt.** `PATCH /api/assets/meters/:id` akzeptiert jetzt `active` und
`initial_reading`. `active` wird gebraucht, um einen strittigen Zähler aus der
Rechnung zu nehmen, ohne ihn über `/archive` als ausgebaut zu kennzeichnen.

**Tests.** Neue Datei `consumption-allocation.test.ts` mit zwölf Fällen, darunter
drei mit den echten Zählerständen von MG24 2025. `engine.test.ts`: B5 geändert
(blockt jetzt mit Personenregel), B5b neu (blockt ohne Personenregel nicht).
820 Tests grün.

---

## Stand 2026-10-10 — NK-Datenübernahme MG24 (Paket 2)

Erste vollständige Befüllung der Nebenkosten-Fachdaten für ein Objekt. MG24 ist
seitdem für 2025 und 2026 **abrechnungsreif** (`nk-readiness`: 0 Blocker).
Report: `~/bikosoc-spec/report-paket2-nk-uebernahme-mg24-20261010.md`.

**Angelegt** (ausschließlich über die Core-Routen, jede Anlage mit `audit_log`-Eintrag):
`property_heating_config` 2025 + 2026 (central_pellets, 30/70) · 15 `meters` ·
9 `allocation_rules` · 16 `expense_bookings` · 3 `lease_charges` ·
168 `meter_readings` · `properties.ownership_start` korrigiert.

**Codeänderung.** `PATCH /api/assets/properties/:code` akzeptierte `ownership_end`,
aber nicht `ownership_start` — obwohl das Feld existiert und die Liste es ausliefert.
Für MG24 stand dort der Vermietungsbeginn statt der Grundbucheintragung. Ohne diese
Zeile bliebe als Korrekturweg nur ein Eingriff an der Datenbank vorbei an Route und
Audit-Log. Ergänzt in `src/modules/assets/routes.ts`.

**Drei Befunde an der NK-Engine, nicht in diesem Paket behoben:**
1. `allocateCosts()` kennt keinen Fall `consumption`. Eine Umlageregel mit
   `key_type = 'consumption'` fällt für NICHT-Heizkostenarten in den Vorgabezweig und
   verteilt nach Fläche. Betroffen sind Kaltwasser und Entwässerung — genau die
   Kostenarten, für die Zähler vorhanden sind. Heizung und Warmwasser sind nicht
   betroffen, die laufen über `heatingAllocation()`.
2. `MISSING_UNIT_RESIDENTS` ist in der Vorprüfung eine Warnung, wird in `computeNk()`
   aber zum harten Blocker hochgestuft. Ohne `unit_residents` rechnet die Engine
   nicht — auch dann nicht, wenn keine einzige Umlageregel nach Personen verteilt.
3. Die Monatsberichte von Fa. Fiehn führen in der Spalte „Verbrauch Vormonat" nur
   die Differenz über das protokollierte Fenster (oft wenige Tage), nicht über den
   Monat. Für die Abrechnung sind allein die Zählerstände brauchbar; die Übernahme
   arbeitet deshalb ausschließlich mit absoluten Ständen.

---

## Stand 2026-10-10 — Einmalige Auswertung des Montagslaufs (Paket 1, Teil D)

Der echte Montagsabgleich um 13:00 Berliner Zeit ist seit dem 07.10.2026 im Core
umgesetzt (`70c4f05`), aber noch nie gelaufen: `banking_sync_runs` endet am
29.06.2026, der Buchungsbestand ebenfalls. Der 12.10.2026 ist die erste Probe.
Damit das Ergebnis nicht von Hand zusammengesucht werden muss, wertet ein
**einmaliger** systemd-user-Timer den Tag automatisch aus.

**Neu**
- `scripts/montagslauf-auswertung.ts` — liest `banking_sync_runs`,
  `banking_sessions`, `banking_transactions` und die gefilterten Journalzeilen des
  Gateways und schreibt EINEN Report nach
  `~/bikosoc-spec/report-montagslauf-<YYYYMMDD>.md`. Der Report-Watcher stellt ihn zu.
- `scripts/systemd/montagslauf-auswertung.{service,timer}` —
  `OnCalendar=2026-10-12 15:00:00 Europe/Berlin` (der Server laeuft auf UTC, die Zone
  steht deshalb ausdruecklich im Ausdruck). `RemainAfterElapse=no` plus
  `ExecStartPost=systemctl --user disable …` — der Timer raeumt sich selbst ab.

**Grenzen, bewusst gesetzt**
- Rein lesend: kein FinTS-Aufruf, kein Abgleich, keine TAN. Ein ausgebliebener Lauf
  wird gemeldet, nicht nachgeholt.
- C5: Der Report nennt nur Zaehlungen, Status und Zeitpunkte. Konten erscheinen mit
  den letzten vier Stellen, Gegenparteien und Verwendungszwecke gar nicht. Der
  Journalfilter hat eine Ausschlussliste (Standort-, Gesundheits- und Kontodaten) —
  ein erster Entwurf mit dem Suchbegriff `tan` traf „S**tan**dort" und haette
  Standortdaten in den Report geschrieben.

**Rueckweg:** `systemctl --user disable --now montagslauf-auswertung.timer`.

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
