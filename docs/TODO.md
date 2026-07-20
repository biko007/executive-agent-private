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
- **cc-pre-backup.sh in AUTO-Konvention:** Skript vorhanden (`scripts/cc-pre-backup.sh`),
  Konvention dokumentiert, aber noch nicht in allen AUTO-Lauf-Checklisten als Pflicht-Erstschritt.

---

## Folgeaufträge (REVIEW-pflichtig, nicht in laufendem Auftrag)

1. **/ccgo Slug-Match-Prüfung (E3-Code):** /ccgo soll Plan-Prompt NUR bestätigen wenn Plan via
   Watcher zugestellt wurde UND Slug/Dateiname passt. Aktuell: kein Slug-Match implementiert.
2. **Deny-Hook + telegram-notify ins Repo versionieren:** `~/.claude/hooks/deny-destructive.sh` und
   `~/.claude/hooks/telegram-notify.sh` sind nicht im Repo versioniert. Folgeauftrag: ins Repo +
   Existenz- und Ausführbarkeits-Check im Smoke-Test.
3. **Deploy-Skript mit SHA-Erfassung + Auto-Rollback:** Manifest 10 ist SOLL. Aktuelles
   Deploy-Skript prüft sich nicht selbst. Folgeauftrag: SHA vor Deploy festhalten,
   Auto-Rollback bei fehlgeschlagenem Smoke.
4. ~~**Test-DB-Guard (C1) technisch implementieren:**~~ Erledigt 2026-07-20 — `src/core/db-guard.ts` (OPENCLAW_TEST=1).

---

## Offene Sprints

| Sprint | Inhalt |
|--------|--------|
| 6 | Fleet auf Postgres |
| 7a | Banking-CSV |
