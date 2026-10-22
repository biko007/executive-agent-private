# cc-Übergabe — Stand 22.10.2026, 10:15 (Korrektur 10:45: zweites OAuth-Ablaufdatum)

**Nachfolger von `cc-Uebergabe-20261019.md`.** Dieses Dokument **ersetzt dort
die Abschnitte 1 bis 5** (Owner-Punkte, Repositories, Dienste, offene
technische Punkte, Datenänderungen). **Die Abschnitte 6 bis 9 der Fassung vom
19.10. gelten weiter** (Eigenheiten und Fallen, Ablageorte, stehende Regeln,
Fachstand); was seither dazukam, steht hier in den Abschnitten 7 bis 9.
Lesereihenfolge nach `/clear`: dieses Dokument, dann 19.10. ab Abschnitt 6.

Alle Zeiten deutsch, wo nicht „UTC“ steht.

---

## 1. Die nächsten Tage — Termine

| Wann | Was | Wer |
|---|---|---|
| **Fr 23.10.** | **ads-tec**: Frist der Mail vom 19.10. (Controller bezahlt, keine Rückmeldung). Bleibt sie stumm → Chat formuliert Nachfass, cc legt Entwurf an | Owner/Chat |
| **Fr 23.10. 19:24** (17:24 UTC) | **Smoke-Test meldet Codex-Anmeldung** (weniger als 3 Tage Restlaufzeit von `~/.codex/auth.json`). Kein Fehler, sondern die Erinnerung | — |
| **So 25.10. 05:00** (03:00 UTC) | **OAuth-Profil der Agenten-Route läuft ab** — `openclaw models status`: `openai:default … expiresAt 2026-10-25 03:00 UTC`, Profil in `~/.openclaw/state/openclaw.sqlite`. **Früher als `auth.json`, und der Smoke-Test sieht es nicht.** Vorher erneuern: `openclaw models auth login` (interaktiv → Owner per `!`). Ob es sich selbst erneuert, ist nicht belegt | **Owner, bis Sa 24.10.** |
| **ab Fr 23.10.** | **Alte Dropbox-App**: Entfernen von `EA_DROPBOX_*` darf **vorgeschlagen** werden (sieben fehlerfreie Tage). Env-Datei = Rote Zone, nur mit Freigabe | cc schlägt vor |
| **Mo 26.10. 13:45** | **Erster Banking-Wochencheck** schreibt `report-banking-wochencheck-20261026.md` | Timer |
| **Mo 26.10. 18:24** (17:24 UTC) | **Codex-Anmeldung läuft ab** (`~/.codex/auth.json`). Vorher `codex login` — interaktiv, also Owner per `! codex login` | Owner |
| **Di 27.10.** | **energiekonzept**: Rückmeldefrist im Nachfass N24 (sofern gesendet) | — |

## 2. Was auf den Owner wartet

| Was | Stand / Fundstelle |
|---|---|
| **Volksbank neu verbinden** + SecureGo-Freigabe | Abruf im Verbindungsdialog ist eingespielt; erst damit kommen Volksbank-Umsätze. `report-banking-umsatzabruf-im-verbindungsdialog-20261020.md` |
| **KSK-PIN wechseln**, danach KSK neu verbinden | Hintergrund: PIN-Leck im Log am 20.10., behoben in `58378ba`; Log bereinigt, Journal nicht einzeln bereinigbar. Nach Neuverbinden volle Historie inkl. fehlender 71 € Stromkonto 30.03.2026 |
| **9 Mailentwürfe** im Ordner Entwürfe | siehe Tabelle unten |
| **Canopy**: Maxim um DTC-Übertragsformular bitten, UBS-Einlieferungsinstruktionen holen | Maxim-Konto …4705 seit 19.10. offen, 14.222 Aktien. `report-canopy-shares-ubs-nachpruefung-20261022.md` |
| **Vier Portale** (DATEV Arbeitnehmer online, comdirect, ING, Meine LKH) | Steuerbelege 2025. `report-steuer-2025-fehlende-belege-nachpruefung-20261022.md` |
| **Zugangsdaten-Vorschläge 1 und 2** | TeamViewer-Mail aus `/Austausch` löschen; Fiehn um neues festes Passwort bitten. `report-pruefung-zugangsdaten-ablage-20261022.md` |
| Entscheidung **La Perla (…4295) privat oder Gesellschaft** | Privatausgaben Runde 4, 66 Buchungen / 30.280 € als privat gezählt |
| Entscheidung **Reisedaten im Dashboard bearbeitbar?** | Empfehlung nein (eine Wahrheit in Dropbox). `report-dashboard-reisen-tab-nachpruefung-20261021.md` |
| Freigabe: **Notiz E0 MG24 berichtigen** | „Faktor 10 vermutet“ ist durch Fiehn (20.10.) überholt: Impulszähler, Impulsverlust |
| Freigabe: **Laufzeilen 11/12** `banking_sync_runs` auf ABORTED | stehen seit 20.10. auf RUNNING (verwaist) |
| `/arm`: **Migration `institution_id` nullable** in `banking_sessions` | Prod erlaubt NULL seit Handänderung 22.06., V027 nicht; Test bildet es nach. Rote Zone |
| aus 19.10. weiter offen | V043 + Steckbrief (`/arm`), Rettenbacher 120 €, Gebäude-/Bodenanteil, `fleet/vehicles.json`, B&S BauKult Zinszahl, DZ Privatbank |

**Die neun Entwürfe** (alle ungesendet, Stand 22.10. 10:00):

| angelegt | Betreff (gekürzt) | An |
|---|---|---|
| 22.10. | AW: TEST-Abrechnungen 2025 – Nonnenburgstraße 24 (Nachfass, Cc + Huber) | s.schlager@ekonzept.eu |
| 20.10. | AW: Zählerfragen MG24 und N24 – bitte prüfen | matthias.bauser@bikolino.com |
| 20.10. | **WG: Stromkonto** — **ohne Empfänger**, Herkunft nicht in den Reports; nicht von cc beauftragt dokumentiert | — |
| 19.10. | sechs Steuer-Anforderungen (Alte Leipziger, R+V, WGV, AXA, Deutsche Bank, Stadtwerke; Cc Stadtwerke leer) | je Versicherer/Bank |
| 16.10. | Versicherungsscheine Gebäudeversicherung | andreas.kurz@vohrer.de |

Gesendet seit 19.10. (vom Owner): Canopy an Maxim und Brannan (19.10. 11:01),
ads-tec (19.10. 11:37).

## 3. Repositories — Commits seit 19.10.2026 11:40

| Repo | Commits |
|---|---|
| executive-agent | `6a02643` Wochencheck · `b07349c` Schlüsselübergang/Sitzungsablösung/Sperre · `58378ba` PIN nie im Log (C5) · `27899cd` Volksbank verbindbar · `d82302b`, `0c5c1e7` Korrekturskript · `9756a1a` Wochencheck Anfangsstand · `b433e0e` **Umsatzabruf im Verbindungsdialog** + Kartenkonten-Skript · `1f6c22f` angehängte Mails als `.eml` |
| executive-dashboard | `c3b56ab` Bankauswahl KSK/Volksbank · `272f3cb` nächste Frist im Reisekopf |
| openclaw-banking-fints (Sidecar) | `1d219f2` Schlüssel v2 + Auszugssalden · `e9159d0` SecureGo plus · `6ec33ea` Diagnose-Protokoll · `5a72b2a` **Abruf im Dialog** · `a522b39` DELETE 204 ohne Inhalt |
| workspace | Zeiger `f26d0ad`, `fb81669` |

Alles gepusht. Tests zuletzt: executive-agent **1837/0**, Sidecar **78/0**,
Dashboard **8/0**, Smoke **37/37** (20.10.).

## 4. Dienste und Timer

| Dienst | Stand |
|---|---|
| `openclaw-banking-fints` (Sidecar 18794) | neu gestartet 20.10.; hält Dialog nach „Bank verbinden“ bis 120 s offen, Aufräumer alle 30 s |
| `mail-eingang.timer`, `mail-register.timer` | 5 min, fehlerfrei; seit 21.10. werden **angehängte Mails als `.eml`** mit abgelegt |
| `reise-import.timer` | 10 min, liest `/Austausch/reisen/`; vereinzelt Dropbox-500 (2× in 7 Tagen), überspringt den Lauf korrekt |
| **`banking-wochencheck.timer`** | **neu aktiv seit 20.10.**, Mo 13:45; Merkdatei `artifacts/personal/banking-wochencheck/stand.json` |
| Report-Watcher, dropbox-inbox | unverändert |

## 5. Banking — Stand 22.10.

| | |
|---|---|
| Institute | KSK (id 1), **Volksbank Schwarzwald-Donau-Neckar (id 29)** |
| Sitzungen | KSK **20** aktiv (18, 19 abgelöst), Volksbank **21** aktiv |
| Volksbank aktiv | 107 (…0028 Giro), 129 (…0001), 130 (…0010), 132 (…0036), 133 (…0109), **134 (…0125, Visa …6047)**, **135 (…0133, MC …7303)**, 136 (…0702), **137 (…4112, Karte …6411, Claudia, zahlt Owner)** |
| Volksbank archiviert | 122–128, 138–140 = **Dritte – nicht auswerten**; 108/109 = leere PDF-Kartenkonten |
| Abruf | **Volksbank lehnt jeden neuen Dialog ab (9050/9340)** — deshalb holt der Sidecar Umsätze **im Verbindungsdialog**. Volle Historie ab 2015 nur, wenn der Dialog mit 3955-Freigabe eröffnet wurde, sonst 89 Tage. Nie TAN anfordern |
| Umsatzschlüssel | v2 `v2_{datum}_{betrag}_{sha16}` (+ `_n`), `legacy_transaction_id` daneben |
| Spaltenfalle | Sidecar legt MT940-`entry_date` (Buchungstag) in **`value_date`**, MT940-`date` (Valuta) in **`booking_date`** |
| Sperre | Advisory Lock 43 auf eigener Verbindung (`nimmAbgleichSperre`) |
| Review-Reste (gering) | Zeitlimit 900 s: Sidecar arbeitet bei Ablauf weiter; PDF-Verknüpfung ±3 Tage verfehlt Fremdwährungsfälle → Saldenprobe zeigt es |
| Privatausgaben | Runde 4 vorbereitet, nicht gerechnet (wartet auf Volksbank-Daten): Sammelbelastung …6411 27.901,63 € erst nach Einzelumsätzen umbuchen; Einzugskonto …6047/…7303 unbekannt |

## 6. Offene technische Punkte

| # | Punkt | Stand |
|---|---|---|
| 6.1 | Deny-Hook ohne Repo-Pfad-Rückfall | unverändert (19.10. Abschnitt 4.1); Pushes immer `git -C /abs/pfad push` |
| 6.2 | Watcher-Versandprüfung (C7) | unverändert (19.10. 4.2); Korrekturen = neuer Report |
| 6.3 | Codex/OAuth | **Zwei Abläufe:** OpenClaw-OAuth-Profil (trägt die Route) **25.10.2026 03:00 UTC**; `~/.codex/auth.json` 26.10.2026 17:24 UTC. Der Smoke-Test (Abschnitt 18) liest nur `auth.json`. Vorschlag: Prüfung um das OpenClaw-Profil erweitern (`openclaw models status --json`, `.auth.oauth.profiles[].expiresAt`) — Gate-Skript, REVIEW-pflichtig (C8) |
| 6.4 | Alte Dropbox-App | Stichtag **23.10.**; nur Vorschlag, env = Rote Zone |
| 6.5 | Migration `institution_id` nullable | Rote Zone, `/arm` |
| 6.6 | Laufzeilen 11/12 RUNNING | wartet auf Freigabe |
| 6.7 | `Posteingang/Proton` im Geschäftspostfach | tauchte nach Löschung am 18.10. wieder auf, am 21.10. erneut gelöscht; bikosoc legt ihn nicht an; Regeln nicht lesbar (403) |
| 6.8 | Mail-Eingangskanal: Abschnitt „Mail-Eingang“ im Report | nicht automatisiert; Empfehlung an Owner: so lassen |
| 6.9 | Reise-Import: ersetztes PDF | kommt erst mit höherer `version`; README ergänzt |

## 7. Datenänderungen seit 19.10.2026 (DB und Dateien)

| Wann | Was | Audit / Rückweg |
|---|---|---|
| 20.10. | Banking: Schlüssel v2, Neuabruf KSK 90 Tage, Sitzungsablösung, Volksbank-Institut und Konten angelegt | Audit 2779–2929 (Banking-Einträge), Reports banking-* 20.10. |
| 20.10. | 11 Volksbank-Konten ausgeblendet (Dritte/Zuordnung offen) | 2861–2872; Sicherung `~/backups/volksbank-dritte-20261020/` |
| 20.10. | …4112 aktiv; PDF-Kartenkonten 108/109 → 134/135 (228 + 89 Zeilen) | 2925–2927; Sicherung `~/backups/banking-karten-20261020/`, Dump `~/backups/openclaw-20261020-154454.dump` |
| 21.10. | `/Austausch/reisen/dokumente/2026-07-16_eTA_Kanada.pdf` ersetzt (3 fremde Anfangsbyte entfernt) | Dropbox-Versionsgeschichte |
| 21.10. | Bauser-Ablage: zwei angehängte `.eml` nachgetragen | löschen |
| 21.10. | `Posteingang/Proton` gelöscht (leer) | wiederherstellbare Elemente |
| 22.10. | Entwurf energiekonzept-Nachfass | löschen |

SharePoint: weiterhin nichts geschrieben.

## 8. Neue Eigenheiten und Fallen (ergänzt 19.10. Abschnitt 6)

- **`psql … openclaw_core` ist roter Befehl.** DB **lesen** mit einem
  Bun-Einzeiler über `src/shared/db/index.ts` (`query()`), Umgebung vorher mit
  `set -a; . ~/.config/openclaw/env; set +a`. **Schreiben** nur über
  App-Funktionen bzw. Skripte mit Audit und Sicherung. Hilfsskripte im
  Scratchpad überleben `/clear` nicht — neu anlegen.
- **`curl … | grep` wird als „curl|sh“ geblockt** → Ausgabe erst in Datei.
- **`rm -r` ist hart geblockt**, auch im Scratchpad.
- **Zwei Dropbox-Zugänge:** `dropboxZugang` = App-Ordner (Pfade relativ zu
  `/Apps/bikosoc-reports`); `dropboxVollzugang` = Kontowurzel (`/Austausch`,
  `/Apps/...`). `transfer/mail-inbox` liegt im **Report-Baum**
  `/Apps/bikosoc-reports/bikosoc-reports/transfer/`, der übrige `transfer/`
  direkt unter `/Apps/bikosoc-reports/transfer/`.
- **Mailentwürfe immer gegenlesen** (isDraft, Empfänger, Text, Zitat,
  Gesendete Elemente vorher/nachher); Graph-Skript ohne jeden Sendeaufruf.
- **„weiter mit <Datei>“ = Nachprüfung**: Auftrag aus `~/inbox/done/` lesen,
  Report prüfen, Ist-Stand live prüfen, neuen Report `…-nachpruefung-<datum>`.
  Kommt dieselbe Datei doppelt (Telegram-Doppelzustellung), kurz bestätigen,
  **keinen** zweiten Report.
- **Graph-Suche `$search`** liefert höchstens 50 Treffer — für Vollständigkeit
  `$filter` auf `receivedDateTime` mit Seitenwechsel.
- **Yahoo per IMAP** nur `readOnly`-Lock; Pakete `imapflow` vorhanden,
  `mailparser` nicht.
- Fremde Originalnamen („Badhaus“ in Betreffzeilen von Fiehn/Bauser) bleiben
  unverändert; intern immer MG24.

## 9. Ablageorte, neu seit 19.10.

| Ort | Inhalt |
|---|---|
| `/Austausch/reisen/` | Reisedatei, `dokumente/`, `done/`, `vorlage/`, README (Import liest hier) |
| `/Austausch/mail-bauser-20261018/` | Bauser-Antworten, Fiehn-Trenddaten — **enthält TeamViewer-ID** (Vorschlag: löschen) |
| `~/backups/banking-karten-20261020/`, `~/backups/volksbank-dritte-20261020/` | JSON-Sicherungen vor C2-Änderungen |
| `artifacts/personal/banking-wochencheck/` | Merkdatei, Regelwerk |
