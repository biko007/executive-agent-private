# Evidence Bundle: Meeting Detection + Calendar Path

**Datum:** 2026-07-10
**Autor:** Claude Code (cc-Pane bikosoc)

## Commits

| Hash | Message |
|------|---------|
| daf47a7 | fix(mail): meeting detection + calendar path, restrict EVENT to ticketed bookings |
| 2ef82c9 | fix(calendar): timezone handling in meeting flow — Berlin-local for M365 |

## Betroffene Regeln

- BIK-002: Callback-Prefix `meeting_` in CALLBACK_PREFIXES registriert
- BIK-011: Human-Reviewability — sprechende Variablennamen, Kommentare, ein Commit

## Aenderungen

### Dateien (10 modified, 1 new)

| Datei | Aenderung |
|-------|-----------|
| `src/modules/travel/types.ts` | `ParsedMeeting` Interface hinzugefuegt |
| `src/modules/travel/enrichment.ts` | LLM-Prompt: 3-Wege-Klassifikation (BOOKING/MEETING/null), EVENT eingeschraenkt, `formatMeetingMessage()`, `isMeeting()` |
| `src/modules/travel/index.ts` | Exports erweitert |
| `src/modules/mail/commands.ts` | `pendingMeetings` Map (globalThis), Meeting-Flow in `scanMailsForBookings`, Meeting-Buttons |
| `src/modules/mail/index.ts` | Export `pendingMeetings` |
| `src/modules/calendar/commands.ts` | `createCalendarEventDirect()` — M365-Terminerstellung mit Konflikterkennung |
| `src/modules/calendar/index.ts` | Export `createCalendarEventDirect` |
| `index.ts` | `meeting_` in CALLBACK_PREFIXES, `handleMeetingCallback`, DI-Wiring |
| `src/__tests__/callback-suppression.test.ts` | CALLBACK_PREFIXES aktualisiert |
| `src/modules/mail/__tests__/meeting-classification.test.ts` | **NEU** — 11 Tests |

### Root-Cause-Fix

Zoom-Meeting-Einladungen wurden als EVENT-Buchung klassifiziert, weil:
1. LLM-Prompt "Event/Veranstaltung" zu breit definiert war
2. Negativ-Beispiele Meeting-Einladungen nicht enthielten
3. Kein separater Meeting-Erkennungspfad existierte

### Fix

1. **Prompt A:** EVENT eingeschraenkt auf gekaufte Tickets (Konzert/Messe/Konferenz/Sport), Meeting-Keywords als Negativ-Beispiele
2. **Prompt B:** Neue MEETING-Kategorie mit eigener Rueckgabe (title, startDate, endDate, durationMin, link, organizer)
3. **Calendar-Pfad:** "In Kalender eintragen" Button → `createCalendarEventDirect()` → M365 Graph API mit Konflikterkennung
4. **Timezone-Fix (2ef82c9):** LLM-Prompt verlangt ISO8601 mit Zeitzone-Offset (+02:00 MESZ / +01:00 MEZ).
   `toBerlinLocalIso()` Helper formatiert Date-Objekte als Berlin-Lokalzeit fuer M365 Payload.
   Root-Cause: `toISOString()` liefert UTC, M365 interpretiert `dateTime` aber im angegebenen `timeZone`.

## Gate-Outputs

- `npm run build`: clean (0 errors)
- `npm run verify:commands`: 112/112 bidirektional konsistent
- `bun test meeting-classification`: 11/11 PASS
- `bun test callback-suppression`: 14/14 PASS
- Smoke: 28/28 PASS
- Gateway restart: active (running)

## Owner-Approval

- [ ] Owner hat Aenderungen reviewed

## Doku-Aenderung

- `docs/workpackages/2026-07-10-meeting-detection.md` (dieses File)
- CLAUDE.md: noch nicht aktualisiert (pending Owner-Review)

## Offene Risiken

- LLM-Klassifikation ist probabilistisch — Edge Cases moeglich (z.B. Event-Einladung die wie Meeting aussieht)
- `handleMeet` (/meet-Befehl) funktioniert korrekt auf UTC-VPS durch Zufall: User gibt Berliner Zeit ein,
  `new Date(year, month, day, hour, min)` erzeugt UTC mit denselben Zahlen, M365 interpretiert als Berlin.
  Wuerde brechen bei VPS-Timezone-Wechsel. Tech-Debt, kein akutes Risiko (Single-VPS, UTC).
