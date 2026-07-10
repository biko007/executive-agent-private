# Evidence Bundle: Doku-Konsolidierung F-001 + F-002

**Datum:** 2026-07-10
**Autor:** Claude Code (cc-Pane bikosoc)

## Commits

| Hash | Message |
|------|---------|
| (this commit) | docs(architecture): consolidate to ARCHITECTURE.md + doc-cochange warning hook |

## Betroffene Regeln

- GOV-001: Doku im selben Commit wie Code — Hook warnt bei Verstoß
- BIK-011: Human-Reviewability — sprechende Abschnitte, Status-Marker

## Aenderungen

### F-001: ARCHITECTURE.md als fuehrende Quelle

| Aenderung | Detail |
|-----------|--------|
| Header | "Fuehrende Quelle — ersetzt PDF-Doku", Governance-Verweis |
| §1 Scope | 15 Module aufgezaehlt (war unvollstaendig) |
| §3 Services | Gateway-Version v2026.2.14 → v2026.6.11 |
| §4 Data Layer | 53 → 56 Tabellen, Memory-Modul ergaenzt, Schema-Versionen aktualisiert (memory@42) |
| §6 n8n | Alle Workflows inactive (war: 2 aktiv). Token-Guardian-Entfernung dokumentiert |
| §8 HDCC | Token-Auto-Refresh entfernt, Health-Monitor prueft weiterhin Expiry |
| §10 NEU | Mail-Scanner Meeting-Detection + Calendar-Path |
| §11 NEU | Owner-Memory (dynamisches Gedaechtnis) |
| §12 NEU | Governance-Framework (Audit-Checklist, Findings, Evidence-Bundles, Command-Guard) |
| §13 Roadmap | Abgeschlossene Items ergaenzt, veraltete Eintraege bereinigt |
| §14 Verifikation | Datum 2026-07-10, Aenderungsprotokoll |
| Advisory-Lock-Registry | Komplett: 42/43/44/46/47/48 (war: 42/44/46/47) |
| CLAUDE.md | Verweis "Fuehrende Quelle", PDF veraltet, Hook-Referenz |

### F-002: Doc-Cochange Warning Hook

| Datei | Aenderung |
|-------|-----------|
| `scripts/hooks/pre-commit` | **NEU** — warnt wenn *.ts ohne *.md im Commit |
| CLAUDE.md | Hook-Installation dokumentiert |
| `git config core.hooksPath` | Gesetzt auf `scripts/hooks` |

### Findings aktualisiert

| Datei | Aenderung |
|-------|-----------|
| `governance/AUDIT-FINDINGS.md` | F-001 erledigt, F-002 erledigt |

## Empirische Verifikation (2026-07-10)

| Pruefpunkt | Ergebnis |
|------------|----------|
| `systemctl --user` Services | 8 Units (5 active, 3 backup) |
| `ss -tlnp` Ports | 18789, 18793, 18794, 18800, 5678 belegt |
| `pg_tables` Count | **56** Tabellen |
| `schema_version` | 26 Eintraege, hoechste: memory@42, health@40, banking@39 |
| Gateway-Version | v2026.6.11 (systemd unit description) |
| Advisory Locks in Code | 42, 43, 44, 46, 47, 48 |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` (src/shared/utils/index.ts:83) |
| Module directories | 15 (assets banking calendar executive fleet health instagram links location mail memory nk pe sharepoint travel) |

## Gate-Outputs

- `npm run build`: clean (0 errors)
- `npm run verify:commands`: 112/112 bidirektional konsistent
- Smoke: 28/28 PASS
- Gateway: active (running), kein Restart noetig (reine Doku+Hook)

## Owner-Approval

- [ ] Owner hat Aenderungen reviewed

## Offene Risiken

- Keine (reine Doku-Konsolidierung + nicht-blockierender Hook)
