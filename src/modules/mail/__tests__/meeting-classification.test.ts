import { describe, expect, test } from 'bun:test';
import { formatMeetingMessage, formatBookingMessage, isMeeting } from '../../travel/enrichment.js';
import type { ParsedMeeting } from '../../travel/types.js';
import type { ParsedBooking } from '../../travel/types.js';

// ── Fixtures: realistic BvCW Zoom meeting mails ──────────────────────────────

const ZOOM_MAIL_1 = {
  subject: 'BvCW-Zoom-Meeting: Mitgliederversammlung',
  from: 'info@bvcw.de',
  body: `Sehr geehrte Mitglieder,

hiermit laden wir Sie herzlich zum BvCW-Zoom-Meeting ein:

Thema: Mitgliederversammlung
Datum: 12. August 2026, 13:00 Uhr
Dauer: ca. 90 Minuten

Zoom-Einwahldaten:
https://us06web.zoom.us/j/12345678901?pwd=abc123
Meeting-ID: 123 4567 8901
Kenncode: 456789

Wir freuen uns auf Ihre Teilnahme.

Mit freundlichen Grüßen
BvCW e.V.`,
};

const ZOOM_MAIL_2 = {
  subject: 'Einladung: BvCW Zoom-Meeting Arbeitskreis Digitalisierung',
  from: 'vorstand@bvcw.de',
  body: `Liebe Kolleginnen und Kollegen,

wir möchten Sie zum nächsten Zoom-Meeting des Arbeitskreises Digitalisierung einladen.

Termin: 15. Juli 2026, 19:00 Uhr
Dauer: 60 Minuten

Beitreten über Zoom:
https://zoom.us/j/98765432100
Meeting-ID: 987 6543 2100
Passcode: 112233

Tagesordnung:
1. Begrüßung
2. Statusbericht Digitalisierungsprojekte
3. Verschiedenes

Beste Grüße
Der Vorstand`,
};

// ── Fixture: a real ticket booking (should stay EVENT) ────────────────────────

const TICKET_BOOKING_MAIL = {
  subject: 'Ihre Buchungsbestätigung: Konzertkarten Elbphilharmonie',
  from: 'noreply@eventim.de',
  body: `Ihre Buchung war erfolgreich!

Veranstaltung: Berliner Philharmoniker — Silvesterkonzert
Datum: 31.12.2026, 20:00 Uhr
Ort: Elbphilharmonie Hamburg, Großer Saal
Platz: Reihe 12, Platz 5-6
Buchungsnummer: EVT-2026-789456
Gesamtpreis: EUR 280,00

Ihre Tickets sind auch in der eventim App verfügbar.

Vielen Dank für Ihren Einkauf!
eventim.de`,
};

// ── 1. isMeeting type guard ──────────────────────────────────────────────────

describe('isMeeting type guard', () => {
  test('returns true for ParsedMeeting', () => {
    const meeting: ParsedMeeting = {
      _kind: 'meeting',
      title: 'Test Meeting',
      startDate: '2026-08-12T13:00:00+02:00',
      endDate: null,
      durationMin: 60,
      link: 'https://zoom.us/j/123',
      organizer: 'test@example.com',
    };
    expect(isMeeting(meeting)).toBe(true);
  });

  test('returns false for ParsedBooking', () => {
    const booking: ParsedBooking = {
      type: 'EVENT',
      title: 'Concert',
      destination: 'Hamburg',
      startDate: '2026-12-31T20:00:00+01:00',
      endDate: null,
      confirmationNumber: 'EVT-123',
      provider: 'eventim',
    };
    expect(isMeeting(booking)).toBe(false);
  });
});

// ── 2. formatMeetingMessage formatting ───────────────────────────────────────

describe('formatMeetingMessage', () => {
  test('formats meeting with all fields — shows Berlin time 13:00', () => {
    const meeting: ParsedMeeting = {
      _kind: 'meeting',
      title: 'BvCW Mitgliederversammlung',
      startDate: '2026-08-12T13:00:00+02:00',
      endDate: '2026-08-12T14:30:00+02:00',
      durationMin: 90,
      link: 'https://zoom.us/j/123',
      organizer: 'info@bvcw.de',
    };
    const msg = formatMeetingMessage(meeting);
    expect(msg).toContain('Termin erkannt');
    expect(msg).toContain('BvCW Mitgliederversammlung');
    expect(msg).toContain('13:00'); // Berlin time, NOT 11:00 UTC
    expect(msg).toContain('14:30'); // Berlin end time
    expect(msg).toContain('info@bvcw.de');
    expect(msg).toContain('https://zoom.us/j/123');
  });

  test('formats meeting without end date — shows Berlin time 19:00', () => {
    const meeting: ParsedMeeting = {
      _kind: 'meeting',
      title: 'Quick Sync',
      startDate: '2026-07-15T19:00:00+02:00',
      endDate: null,
      durationMin: 30,
      link: null,
      organizer: 'vorstand@bvcw.de',
    };
    const msg = formatMeetingMessage(meeting);
    expect(msg).toContain('Termin erkannt');
    expect(msg).toContain('19:00'); // Berlin time
    expect(msg).toContain('30 Min');
    expect(msg).not.toContain('Link:');
  });
});

// ── 3. formatBookingMessage still works for EVENT bookings ───────────────────

describe('formatBookingMessage — EVENT type unchanged', () => {
  test('formats EVENT booking with ticket data', () => {
    const booking: ParsedBooking = {
      type: 'EVENT',
      title: 'Berliner Philharmoniker — Silvesterkonzert',
      destination: 'Hamburg',
      startDate: '2026-12-31T20:00:00+01:00',
      endDate: null,
      confirmationNumber: 'EVT-2026-789456',
      provider: 'eventim',
    };
    const msg = formatBookingMessage(booking);
    expect(msg).toContain('Buchungsbestätigung erkannt');
    expect(msg).toContain('eventim');
    expect(msg).toContain('EVT-2026-789456');
    expect(msg).toContain('Hamburg');
  });
});

// ── 4. LLM prompt structure (static analysis — no API call) ─────────────────

describe('analyzeMailForBooking prompt structure', () => {
  // Read the source file and verify the prompt contains the critical distinctions
  test('prompt excludes meetings from BOOKING category', async () => {
    const src = await Bun.file(
      new URL('../../travel/enrichment.ts', import.meta.url).pathname,
    ).text();

    // Prompt must mention these meeting-related exclusions
    expect(src).toContain('NICHT: interne Meetings, Video-Calls, Besprechungseinladungen');

    // Prompt must define MEETING as separate category
    expect(src).toContain('"category": "MEETING"');

    // Prompt must mention Zoom, Teams, Meet in MEETING definition
    expect(src).toContain('Zoom');
    expect(src).toContain('Microsoft Teams');
    expect(src).toContain('Google Meet');

    // EVENT must be restricted to ticketed events
    expect(src).toContain('gekauftes Event-Ticket');
  });
});

// ── 5. Meeting callback payload — timezone-correct (dry-run, no M365 call) ──

/**
 * Replicate toBerlinLocalIso() from calendar/commands.ts for test assertions.
 * M365 Graph API interprets dateTime in the specified timeZone, so we must
 * provide Berlin-local values, NOT UTC via toISOString().
 */
function toBerlinLocalIso(d: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find(x => x.type === t)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}.000`;
}

describe('meeting → calendar event payload (timezone-correct)', () => {
  test('builds correct M365 payload from offset-bearing ISO (BvCW 13:00 Berlin)', () => {
    // LLM returns offset-bearing ISO: "13:00 Uhr" in German mail → +02:00 (MESZ)
    const meeting: ParsedMeeting = {
      _kind: 'meeting',
      title: 'BvCW Mitgliederversammlung',
      startDate: '2026-08-12T13:00:00+02:00',
      endDate: null,
      durationMin: 90,
      link: 'https://us06web.zoom.us/j/12345678901?pwd=abc123',
      organizer: 'info@bvcw.de',
    };

    // Simulate handleMeetingCallback: new Date() parses offset → UTC internally
    const start = new Date(meeting.startDate);
    const end = new Date(start.getTime() + meeting.durationMin * 60000);

    // Internal UTC representation: 13:00+02:00 = 11:00 UTC
    expect(start.toISOString()).toBe('2026-08-12T11:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-12T12:30:00.000Z');

    // M365 payload must use Berlin-local, NOT UTC
    const startLocal = toBerlinLocalIso(start);
    const endLocal = toBerlinLocalIso(end);
    expect(startLocal).toBe('2026-08-12T13:00:00.000'); // 13:00 Berlin
    expect(endLocal).toBe('2026-08-12T14:30:00.000');   // 14:30 Berlin

    const payload: any = {
      subject: meeting.title,
      start: { dateTime: startLocal, timeZone: 'Europe/Berlin' },
      end: { dateTime: endLocal, timeZone: 'Europe/Berlin' },
    };
    if (meeting.link) {
      payload.body = { contentType: 'Text', content: `Meeting-Link: ${meeting.link}` };
    }

    expect(payload.subject).toBe('BvCW Mitgliederversammlung');
    expect(payload.start.dateTime).toBe('2026-08-12T13:00:00.000');
    expect(payload.end.dateTime).toBe('2026-08-12T14:30:00.000');
    expect(payload.start.timeZone).toBe('Europe/Berlin');
    expect(payload.body.content).toContain('https://us06web.zoom.us/j/12345678901');
  });

  test('handles meeting with explicit endDate (BvCW 19:00 Berlin)', () => {
    const meeting: ParsedMeeting = {
      _kind: 'meeting',
      title: 'AK Digitalisierung',
      startDate: '2026-07-15T19:00:00+02:00',
      endDate: '2026-07-15T20:00:00+02:00',
      durationMin: 60,
      link: 'https://zoom.us/j/98765432100',
      organizer: 'vorstand@bvcw.de',
    };

    const start = new Date(meeting.startDate);
    const end = new Date(meeting.endDate!);

    expect(end.getTime() - start.getTime()).toBe(60 * 60 * 1000);
    // Berlin-local must preserve 19:00/20:00
    expect(toBerlinLocalIso(start)).toBe('2026-07-15T19:00:00.000');
    expect(toBerlinLocalIso(end)).toBe('2026-07-15T20:00:00.000');
  });
});

// ── 6. Callback prefix registry ──────────────────────────────────────────────

describe('meeting_ callback prefix registration', () => {
  test('index.ts contains meeting_ in CALLBACK_PREFIXES', async () => {
    const src = await Bun.file(
      new URL('../../../../index.ts', import.meta.url).pathname,
    ).text();

    // Verify meeting_ is in the CALLBACK_PREFIXES array
    const match = src.match(/CALLBACK_PREFIXES\s*=\s*\[([^\]]+)\]/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("'meeting_'");
  });
});

// ── 7. pendingMeetings globalThis resilience ─────────────────────────────────

describe('pendingMeetings state management', () => {
  test('pendingMeetings lives on globalThis after module load', async () => {
    // Dynamic import triggers the module-level globalThis registration
    const mod = await import('../commands.js');
    const g = globalThis as any;
    expect(g.__ea_pendingMeetings).toBeDefined();
    expect(g.__ea_pendingMeetings instanceof Map).toBe(true);
    // And the exported reference is the same object
    expect(mod.pendingMeetings).toBe(g.__ea_pendingMeetings);
  });

  test('pendingMeetings set and get with TTL', async () => {
    const { pendingMeetings } = await import('../commands.js');
    const key = 'meeting_test123';
    const entry = {
      meeting: { _kind: 'meeting' as const, title: 'Test', startDate: '2026-08-12T13:00:00Z', endDate: null, durationMin: 60, link: null, organizer: 'test' },
      source: 'm365' as const,
      mailId: 'msg-123',
      expiresAt: Date.now() + 30 * 60_000,
    };

    pendingMeetings.set(key, entry);
    expect(pendingMeetings.has(key)).toBe(true);
    expect(pendingMeetings.get(key)!.meeting.title).toBe('Test');

    // Cleanup
    pendingMeetings.delete(key);
  });
});
