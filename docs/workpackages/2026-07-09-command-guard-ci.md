# Evidence Bundle: Command-Guard CI

**Datum:** 2026-07-09
**Arbeitspaket:** Command Registration Guard + Fix
**Autor:** Claude Opus 4.6

---

## Commits

| Hash | Nachricht |
|------|-----------|
| `937193c` | feat(ci): command registration guard + speaking-id rule |
| `d179f3d` | fix(commands): register 12 missing handlers, drop 2 dead entries |

---

## Betroffene Regeln

| ID | Regel | Bezug |
|----|-------|-------|
| GOV-005 | Command-Registration bidirektional | Neues Gate `verify-commands.ts` erzwingt bidirektionale Konsistenz |
| GOV-007 | TypeScript Build fehlerfrei | Build muss nach Änderung clean bleiben |
| GOV-008 | Smoke-Test 28/28 | Smoke nach Restart bestätigt keine Regression |

---

## Gate-Outputs

### `npm run build` (tsc)

```
> build
> tsc -p tsconfig.json
```

Exit 0 — clean.

### `npm run verify:commands`

```
🔍 Command Registration Guard
════════════════════════════════════════════════════════════════════════
   Handlers found:              112
   Unique handler names:         112
   REGISTERED_COMMANDS entries:   112

✅ All commands are bidirectionally consistent.
```

Exit 0.

### `bun run scripts/smoke-test.ts`

```
RESULT: ALL PASS (28/28)
```

Inkl. Check 14+15 (Postgres-Isolation).

### `systemctl --user status openclaw-gateway`

```
Active: active (running) since Thu 2026-07-09 10:58:22 UTC
```

---

## Beschreibung

**Commit 937193c** führt `scripts/verify-commands.ts` ein — ein bidirektionales
CI-Gate, das `api.registerCommand()` Aufrufe gegen die `REGISTERED_COMMANDS`-Liste
in `index.ts` abgleicht:
- Direction A: Handler ohne Listeneintrag → Agent antwortet statt dedizierter Handler
- Direction B: Listeneintrag ohne Handler → NO_REPLY ohne Antwort

Erster Lauf deckte 14 Findings auf (12 fehlende Einträge, 2 tote Einträge).

**Commit d179f3d** behebt die 14 Findings:
- 12 fehlende Handler in `REGISTERED_COMMANDS` nachgetragen
- 2 tote Einträge (`screenshot`, `browse`) entfernt
- Ergebnis: 112 Handler = 112 Listeneinträge, Exit 0

---

## Owner-Approval

- [ ] Review durch Owner

## Doku-Änderung

- CLAUDE.md: `verify:commands` zum Build-Gate hinzugefügt, Manifest §12 erweitert

## Offene Risiken

- F-005: 112 Commands vs Telegram Bot API Limit von 100 `setMyCommands`
