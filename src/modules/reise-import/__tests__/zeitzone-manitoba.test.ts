/**
 * Zeitzonenabstand aus dem System-tzdata statt Laufzeit-ICU
 * (09.11.2026: Manitoba dauerhaft UTC−5, ICU-tz 2026a rechnet noch −6).
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import { ortszeitNachUtc, ortszeitText, versatzMin } from '../kalender.js';
import { tzdataVersatzMin } from '../../../shared/utils/tzif.js';

const SYS = fs.existsSync('/usr/share/zoneinfo/America/Winnipeg');

describe.if(SYS)('Winnipeg nach System-tzdata', () => {
  test('10.11.2026 09:00 Ortszeit → 14:00 UTC', () => {
    expect(ortszeitNachUtc('2026-11-10', '09:00', 'America/Winnipeg')).toBe('2026-11-10T14:00:00Z');
  });
  test('Abstand −300 nach dem 01.11.2026, −300 im Sommer davor', () => {
    expect(tzdataVersatzMin('America/Winnipeg', Date.parse('2026-11-10T14:00:00Z'))).toBe(-300);
    expect(tzdataVersatzMin('America/Winnipeg', Date.parse('2026-07-01T12:00:00Z'))).toBe(-300);
    expect(tzdataVersatzMin('America/Winnipeg', Date.parse('2025-12-01T12:00:00Z'))).toBe(-360);
  });
  test('Anzeige in Ortszeit', () => {
    expect(ortszeitText('2026-11-10T14:00:00Z', 'America/Winnipeg')).toBe('10.11. 09:00');
  });
});

describe.if(SYS)('Britisch-Kolumbien nach System-tzdata (dauerhaft UTC−7 seit 2026b)', () => {
  test('Victoria/Vancouver 15.11.2026 10:00 → 17:00 UTC', () => {
    expect(ortszeitNachUtc('2026-11-15', '10:00', 'America/Vancouver')).toBe('2026-11-15T17:00:00Z');
  });
});

describe('unveränderte Zonen', () => {
  test('Berlin Winter/Sommer, Los Angeles, Zürich', () => {
    expect(ortszeitNachUtc('2026-11-07', '13:20', 'Europe/Berlin')).toBe('2026-11-07T12:20:00Z');
    expect(ortszeitNachUtc('2027-07-01', '12:00', 'Europe/Berlin')).toBe('2027-07-01T10:00:00Z');
    expect(ortszeitNachUtc('2026-11-24', '19:30', 'America/Los_Angeles')).toBe('2026-11-25T03:30:00Z');
    expect(versatzMin('Europe/Zurich', Date.parse('2026-11-24T12:00:00Z'))).toBe(60);
  });
  test('unbekannte Zone → null, Rückfall Intl', () => {
    expect(tzdataVersatzMin('Mars/Olympus', Date.now())).toBeNull();
    expect(tzdataVersatzMin('../etc/passwd', Date.now())).toBeNull();
  });
});
