# Workpackage: Security-Lauf — Doctor-Empfehlungen + Security-Tail

**Datum:** 2026-07-12
**Scope:** Doctor-Empfehlungen (3×), Security-Tail (Withings, nk-trigger)

---

## Zusammenfassung

Drei Doctor-Empfehlungen aus `gateway-update-done-2026-07-03.md` wurden als
offen geflaggt. Diagnose ergibt: alle drei sind BEREITS umgesetzt. Zusaetzlich
wurde der Security-Tail (Withings Re-Consent, nk-trigger) geprueft.

---

## Befunde

### Doctor-Empfehlung 1: `commands.ownerAllowFrom`

- **Status:** BEREITS KONFIGURIERT
- **Nachweis:** `~/.openclaw/openclaw.json` Zeile 51-53: `["telegram:133260792"]`
- **Verifizierung:** Gateway laeuft mit dieser Config, Telegram-Commands funktional
- **Aktion:** keine

### Doctor-Empfehlung 2: Plaintext Secrets in openclaw.json

- **Status:** BEREITS MIGRIERT
- **Nachweis:** Alle Secrets in openclaw.json verwenden `{source: "env", id: "..."}` Pattern
- **Residual:** `~/.config/openclaw/jb-handover-token.txt` (chmod 600, Meta-Token-Datei)
- **Aktion:** keine

### Doctor-Empfehlung 3: KillMode

- **Status:** BEREITS KORREKT (`mixed`)
- **Nachweis:** `systemctl --user cat openclaw-gateway.service` → `KillMode=mixed`
- **Begruendung:** `mixed` ist korrekt: Main-Prozess bekommt SIGTERM (graceful),
  Kinder SIGKILL (clean teardown). `process` wuerde Kinder verwaisen lassen.
  openclaw-trading ist ein unabhaengiger Service (eigene Unit).
- **Aktion:** keine

### Security-Tail: Withings OAuth-Callback

- **Status:** F-009 ZURÜCKGESTELLT
- **Problem:** nginx `/withings/callback` → Port 18789 (Gateway), aber kein Handler.
  Temp-Server lauscht auf Port 8080. OAuth Re-Consent wuerde fehlschlagen.
- **Mitigation:** Token ID 142 aktiv, Auto-Rotation alle ~6h, Refresh-Token ~1 Jahr gueltig.
- **Aktion:** F-009 in AUDIT-FINDINGS.md dokumentiert, Backlog in CLAUDE.md

### Security-Tail: nk-trigger

- **Status:** Endpoint gesichert, n8n-Workflow fehlt (Backlog)
- **Nachweis:** `/api/internal/nk-trigger/obligations-alert` existiert,
  Bearer-Token-gesichert, localhost-only via nginx
- **Aktion:** Bereits in CLAUDE.md Backlog dokumentiert, kein Security-Concern

---

## Betroffene Regeln

- GOV-005 (Command-Registration) — verify:commands gruen
- GOV-007 (Build-Gate) — npm run build gruen
- GOV-008 (Smoke-Test) — 28/28

---

## Commits

<!-- Wird nach Commit ergaenzt -->
- [ ] EA: Security-Lauf Doctor-Empfehlungen + F-009
- [ ] Parent: Submodule-Update

---

## Gate-Outputs

- [ ] `npm run build` — Exit 0
- [ ] `npm run verify:commands` — Exit 0
- [ ] `bun run scripts/smoke-test.ts` — 28/28
- [ ] Gateway-Restart — clean

---

## Doku-Aenderungen

| Datei | Aenderung |
|-------|-----------|
| `governance/AUDIT-FINDINGS.md` | F-009 hinzugefuegt (Withings Callback, zurueckgestellt) |
| `docs/ARCHITECTURE.md` | §12 Findings-Count, §13 Roadmap, §14 Security-Lauf Verifikation |
| `CLAUDE.md` | Withings-Callback in Offene TODOs |
| `docs/workpackages/2026-07-12-security-lauf.md` | dieses Dokument |

---

## Offene Risiken

| Risiko | Schwere | Mitigation |
|--------|---------|------------|
| Withings Callback defekt (F-009) | niedrig | Refresh-Token ~1 Jahr gueltig, Auto-Rotation aktiv |
| nk-trigger n8n-Workflow fehlt | niedrig | Endpoint gesichert, Scheduling ist Backlog |
| `jb-handover-token.txt` auf Disk | niedrig | chmod 600, Meta-Token, kein Plaintext-Secret im Repo |

---

## Owner-Approval

- [ ] Befunde geprueft und akzeptiert
