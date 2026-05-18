/**
 * E3 — Travel + Booking callback dispatch routing tests.
 *
 * Pure unit tests verifying that parseCallbackEvent correctly routes
 * segdel_ and booking_ callback patterns.
 * No DB, no DI, no handler execution.
 */
import { describe, expect, test } from 'bun:test';
import { parseCallbackEvent } from '../../../shared/telegram-callback/index.js';

const mkEvent = (content: string | undefined, senderId = '12345') => ({
  content,
  metadata: { senderId },
});

describe('segdel_ callback dispatch routing', () => {
  test('1. segdel_::yes dispatches with delKey and action', () => {
    const cb = parseCallbackEvent(mkEvent('segdel_abc123::yes'), 'segdel');
    expect(cb).not.toBeNull();
    expect(cb!.prefix).toBe('segdel');
    expect(cb!.args).toEqual(['abc123', 'yes']);
    // Dispatcher reconstructs: delKey = `segdel_${args[0]}` = 'segdel_abc123'
    expect(`segdel_${cb!.args[0]}`).toBe('segdel_abc123');
  });

  test('2. segdel_::no dispatches with correct args', () => {
    const cb = parseCallbackEvent(mkEvent('segdel_abc123::no'), 'segdel');
    expect(cb).not.toBeNull();
    expect(cb!.args).toEqual(['abc123', 'no']);
  });

  test('3. segdel_ without separator has args.length 1 (guard)', () => {
    const cb = parseCallbackEvent(mkEvent('segdel_abc123'), 'segdel');
    expect(cb).not.toBeNull();
    // No '::' → single arg, dispatcher should guard on args.length < 2
    expect(cb!.args.length).toBe(1);
    expect(cb!.args[0]).toBe('abc123');
  });
});

describe('booking_ callback dispatch routing', () => {
  test('4. booking_::new dispatches with bookingKey and action', () => {
    const cb = parseCallbackEvent(mkEvent('booking_def456::new'), 'booking');
    expect(cb).not.toBeNull();
    expect(cb!.prefix).toBe('booking');
    expect(cb!.args).toEqual(['def456', 'new']);
    // Dispatcher reconstructs: bookingKey = `booking_${args[0]}` = 'booking_def456'
    expect(`booking_${cb!.args[0]}`).toBe('booking_def456');
  });

  test('5. booking_::existing dispatches with correct args', () => {
    const cb = parseCallbackEvent(mkEvent('booking_def456::existing'), 'booking');
    expect(cb).not.toBeNull();
    expect(cb!.args).toEqual(['def456', 'existing']);
  });

  test('6. booking_::ignore dispatches with correct args', () => {
    const cb = parseCallbackEvent(mkEvent('booking_def456::ignore'), 'booking');
    expect(cb).not.toBeNull();
    expect(cb!.args).toEqual(['def456', 'ignore']);
  });

  test('7. booking_::trip_0 dispatches with correct args', () => {
    const cb = parseCallbackEvent(mkEvent('booking_def456::trip_0'), 'booking');
    expect(cb).not.toBeNull();
    expect(cb!.args).toEqual(['def456', 'trip_0']);
  });
});

describe('Negative cases', () => {
  test('8. Non-matching prefix returns null for both', () => {
    const event = mkEvent('icraft_sess::ja');
    expect(parseCallbackEvent(event, 'segdel')).toBeNull();
    expect(parseCallbackEvent(event, 'booking')).toBeNull();
  });

  test('9. Undefined content returns null for both', () => {
    const event = mkEvent(undefined);
    expect(parseCallbackEvent(event, 'segdel')).toBeNull();
    expect(parseCallbackEvent(event, 'booking')).toBeNull();
  });
});
