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
- **cc-pre-backup.sh in AUTO-Konvention:** Skript vorhanden (`scripts/cc-pre-backup.sh`),
  Konvention dokumentiert, aber noch nicht in allen AUTO-Lauf-Checklisten als Pflicht-Erstschritt.

---

## Folgeaufträge (REVIEW-pflichtig, nicht in laufendem Auftrag)

1. **/ccgo Slug-Match-Prüfung (E3-Code):** /ccgo soll Plan-Prompt NUR bestätigen wenn Plan via
   Watcher zugestellt wurde UND Slug/Dateiname passt. Aktuell: kein Slug-Match implementiert.
2. ~~**Deny-Hook + telegram-notify ins Repo versionieren:**~~ Erledigt (nachgeprueft 10.10.2026) —
   beide Hooks liegen versioniert unter `hooks/` im Repo, `scripts/install-hooks.sh` spielt sie
   nach `~/.claude/hooks/` aus, und `scripts/smoke-test.ts` prueft je Hook Existenz,
   Ausfuehrbarkeit UND Drift gegen die Repo-Fassung (SHA-Vergleich). Die Hinweise auf diesen
   Folgeauftrag in `CLAUDE.md` §4 C6 und §8 sind damit ueberholt.
3. ~~**Deploy-Skript mit SHA-Erfassung + Auto-Rollback:**~~ Erledigt 2026-07-20 — `scripts/deploy.sh` implementiert (Dirty-Tree-Guard, SHA-Capture, Health-Check, Auto-Rollback auf LAST_GOOD, Telegram-Notify). Manifest 10 erfüllt.
4. ~~**Test-DB-Guard (C1) technisch implementieren:**~~ Erledigt 2026-07-20 — `src/core/db-guard.ts` (OPENCLAW_TEST=1).

---

## Offene Sprints

| Sprint | Inhalt |
|--------|--------|
| 6 | Fleet auf Postgres |
| 7a | Banking-CSV |
