# OpenClaw Executive Agent — Offene Punkte

Aktuelle offene Punkte und Folgeaufträge. Erledigte Todos: docs/CHANGELOG.md.

---

## Offene Punkte

- **Etappe n (Real-Test L19 2024):** wartet auf L19 Datenpflege durch Owner.
- **SP Hard-Delete Phase 2:** 3 synthetische Tests Pflicht VOR `dry_run=false` auf
  `POST /api/sharepoint/cleanup-missing`. Phase 1 (Dry-Run only) ist aktiv.
- **Withings OAuth-Callback-Route (F-009):** nginx `/withings/callback` → Gateway, aber kein Handler.
  Zurückgestellt ~1 Jahr. Fix: analog Oura-Pattern (Port 8080 direkt) oder Gateway-Route registrieren.
- **Meta-Token rotieren:** Optional. Owner-Entscheidung ausstehend.
- **Sprint-6-Cleanup (uebernommen aus REMINDERS.md, 2026-10-10):** am 10.10.2026 geprueft;
  zwei von drei Punkten sind damit geklaert, einer ist eine Owner-Entscheidung.
  - [x] Archiv `artifacts/.archive/fleet-pre-S6-20260515/` ist vorhanden
        (`vehicles.json` + `manifest.json`) — Backup erfuellt.
  - [x] Migration-Summary-Audit-Eintrag geprueft (`audit_log` #23,
        `fleet/system.sprint6_migration`): enthaelt ausschliesslich Zeilenzahlen je Tabelle,
        keine Fahrzeug-, Personen- oder Vertragsdaten. Keine Beanstandung.
  - [ ] **Owner-Entscheidung:** `artifacts/personal/fleet/vehicles.json` loeschen.
        Faktenlage: Produktivquelle ist seit Sprint 6 die Tabelle `vehicles` (7 Fahrzeuge);
        die Datei enthaelt den alten Stand mit 5 Fahrzeugen und wird von keinem Lesepfad mehr
        verwendet (nur `src/modules/fleet/migrate-v025.ts` liest sie, und nur beim Migrieren).
        Anomalien sind seit 15.05.2026 keine aufgetreten. Loeschen ist eine Datenloeschung und
        bleibt deshalb Owner-Sache.
- **Dropbox-Vollzugriff des Servers (geparkt, Owner-Entscheidung 10.10.2026):**
  Der Auftrag `dropbox-vollzugriff-20261010.txt` ist vom Owner am 10.10.2026 zurueckgezogen
  worden — keine Diagnose, kein Plan, keine Umsetzung. Sachstand: Das Server-Token ist auf
  einen App-Ordner beschraenkt (`/Apps/bikosoc-reports`), Dateien ausserhalb davon sind fuer
  den Agenten nicht erreichbar. Statt den Zugang zu erweitern, verschiebt der Owner seinen
  Austauschordner selbst in den App-Bereich; Zielpfad aus Agentensicht:
  `/bikosoc-reports/transfer/` (Unterordner `SWT-Rechnungen`, `Screenshots`, Umsatz-PDFs,
  weitere folgen). Damit ist der Vollzugriff fuer den laufenden Betrieb nicht erforderlich.
  Kein Codebezug: kein Transfer-Pfad ist im Repo verdrahtet (geprueft 10.10.2026).
  Wieder aufgreifen nur, wenn der Owner Dateien ausserhalb des App-Ordners freigeben will;
  dann erneut als REVIEW-Auftrag (Rote Zone: Token/env).
- **cc-pre-backup.sh in AUTO-Konvention:** Skript vorhanden (`scripts/cc-pre-backup.sh`),
  Konvention dokumentiert, aber noch nicht in allen AUTO-Lauf-Checklisten als Pflicht-Erstschritt.

---

## Folgeaufträge (REVIEW-pflichtig, nicht in laufendem Auftrag)

0. ~~**NK-Engine: `consumption` als Umlageschlüssel umsetzen:**~~ Erledigt 10.10.2026 (Paket 3,
   Teil 1a) — `allocateByConsumption()` mit Medientabelle, Hauptzähler verteilt nicht mit,
   ungemessener Rest bleibt beim Eigentümer; zwölf Tests. Ursprünglicher Befund:
   `allocateCosts()` in `src/modules/nk/engine.ts` kennt die Fälle `sqm`, `persons`,
   `units`, `mea`, `fixed` und `direct`. Eine Regel mit `key_type = 'consumption'`
   fällt in den Vorgabezweig und verteilt nach Fläche. Für Heizung und Warmwasser
   fällt das nicht auf, die laufen über `heatingAllocation()`; für **Kaltwasser und
   Entwässerung** schon — dort gibt es Zähler je Wohnung, und genau die werden
   ignoriert. Bei MG24 sind die Regeln so angelegt, wie der Owner sie entschieden
   hat; die Engine rechnet sie bis zur Umsetzung nach Fläche.
   Geld-relevant → Tests zwingend (Manifest 5), eigener Auftrag.
1. ~~**NK-Engine: `MISSING_UNIT_RESIDENTS` nur blocken, wenn nach Personen verteilt wird:**~~
   Erledigt 10.10.2026 (Paket 3, Teil 1b) über `PreCheckResult.uses_person_key`.
   Ursprünglicher Befund: `computeNk()` stuft die Warnung immer zum Blocker hoch.
   Rechnerisch nötig ist die Personenzahl aber nur bei `key_type = 'persons'`. Bei MG24
   verhindert das die Probe-Abrechnung, obwohl keine einzige Regel nach Personen verteilt.
2. **/ccgo Slug-Match-Prüfung (E3-Code):** /ccgo soll Plan-Prompt NUR bestätigen wenn Plan via
   Watcher zugestellt wurde UND Slug/Dateiname passt. Aktuell: kein Slug-Match implementiert.
3. ~~**Deny-Hook + telegram-notify ins Repo versionieren:**~~ Erledigt (nachgeprueft 10.10.2026) —
   beide Hooks liegen versioniert unter `hooks/` im Repo, `scripts/install-hooks.sh` spielt sie
   nach `~/.claude/hooks/` aus, und `scripts/smoke-test.ts` prueft je Hook Existenz,
   Ausfuehrbarkeit UND Drift gegen die Repo-Fassung (SHA-Vergleich). Die Hinweise auf diesen
   Folgeauftrag in `CLAUDE.md` §4 C6 und §8 sind damit ueberholt.
4. ~~**Deploy-Skript mit SHA-Erfassung + Auto-Rollback:**~~ Erledigt 2026-07-20 — `scripts/deploy.sh` implementiert (Dirty-Tree-Guard, SHA-Capture, Health-Check, Auto-Rollback auf LAST_GOOD, Telegram-Notify). Manifest 10 erfüllt.
5. ~~**Test-DB-Guard (C1) technisch implementieren:**~~ Erledigt 2026-07-20 — `src/core/db-guard.ts` (OPENCLAW_TEST=1).

---

## Offene Sprints

| Sprint | Inhalt |
|--------|--------|
| 6 | Fleet auf Postgres |
| 7a | Banking-CSV |
