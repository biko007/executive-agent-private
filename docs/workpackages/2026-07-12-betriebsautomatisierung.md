# Evidence Bundle: Betriebsautomatisierung (Portierung HDCC)

**Datum:** 2026-07-12
**Scope:** Report-Watcher, Wait-Notifier, /report, /ccstop

## Commits

- (pending — wird nach Erstellung ergaenzt)

## Betroffene Regeln

- GOV-001 (Doc-Cochange): ARCHITECTURE.md + CLAUDE.md im selben Commit
- GOV-002 (Evidence-Bundle): dieses Dokument
- BIK-001 (Secrets): keine Klartext-Secrets — env-Referenzen only
- BIK-003 (Command-Guard): verify:commands 114/114 gruen

## Gate-Outputs

### npm run build
```
> tsc -p tsconfig.json
(exit 0)
```

### npm run verify:commands
```
Handlers found:              114
Unique handler names:         114
REGISTERED_COMMANDS entries:   114
All commands are bidirectionally consistent.
(exit 0)
```

### systemctl --user restart openclaw-gateway
```
Active: active (running) since Sun 2026-07-12 09:22:54 UTC
```

### bun run scripts/smoke-test.ts
```
RESULT: ALL PASS (28/28)
```

### Selftest (Report-Watcher)
```
Created ~/report-selftest-1783848202.md
[report-watcher] Delivered: report-selftest-1783848202.md (5s delay, auto-detect)
File cleaned up after delivery confirmation.
```

## Neue Features

| Feature | Implementierung | Guard |
|---------|-----------------|-------|
| Report-Watcher | index.ts (fs.watch, scanAndDeliverReports, seedReportSentMap) | `__ea_reportWatcherRegistered` |
| Wait-Notifier | index.ts (tmux capture-pane, 30s interval) | `__ea_waitNotifierRegistered` |
| /report | index.ts (registerCommand) | REGISTERED_COMMANDS |
| /ccstop | index.ts (registerCommand) | REGISTERED_COMMANDS |
| sendTelegramDocument | index.ts (FormData, Telegram Bot API) | — |

## Doku-Aenderungen

- `CLAUDE.md`: Stand aktualisiert, Betriebsautomatisierung + Report-Konvention hinzugefuegt
- `docs/ARCHITECTURE.md`: §9 Betriebsautomatisierung, Roadmap update, Verifikations-Pass

## Gateway-Version

**Befund:** OpenClaw Gateway v2026.6.11 (bestaetigt via systemd Description, npm-Package,
OPENCLAW_SERVICE_VERSION env, laufender Prozess PID, `~/.openclaw/openclaw.json` lastTouchedVersion).
Quelle der Angabe in ARCHITECTURE.md: systemd unit file Description + env-Variable.
Upgrade von v2026.2.14 am 2026-07-03 (Report: `~/bikosoc-spec/gateway-update-done-2026-07-03.md`).

## Offene Risiken

- Wait-Notifier Pattern-Matching ist heuristisch (kann false-positives bei Terminal-Output produzieren).
  Mitigiert durch 5min-Cooldown + Content-Hash-Dedup.
- fs.watch auf Linux ist inotify-basiert — bei sehr vielen Dateien in ~ kann das Watcher-Limit
  relevant werden (aktuell: 103 seeded files, kein Problem).

## Owner-Approval

- [ ] Owner hat Report in Telegram erhalten und bestaetigt
