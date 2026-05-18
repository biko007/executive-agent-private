/**
 * E2 — Instagram callback dispatch routing tests.
 *
 * Pure unit tests verifying that parseCallbackEvent correctly routes
 * all Instagram callback patterns (icraft_, iscan_, isub_).
 * No DB, no DI, no handler execution.
 */
import { describe, expect, test } from 'bun:test';
import { parseCallbackEvent } from '../../../shared/telegram-callback/index.js';

const mkEvent = (content: string | undefined, senderId = '12345') => ({
  content,
  metadata: { senderId },
});

describe('Instagram callback dispatch routing', () => {
  // ── icraft_ ──────────────────────────────────────────────────────────

  test('1. icraft_go_ dispatches with sessionId', () => {
    const cb = parseCallbackEvent(mkEvent('icraft_go_sess-123'), 'icraft');
    expect(cb).not.toBeNull();
    expect(cb!.prefix).toBe('icraft');
    expect(cb!.payload.startsWith('go_')).toBe(true);
    const sessionId = cb!.payload.slice(3);
    expect(sessionId).toBe('sess-123');
  });

  test('2. icraft_::ja dispatches with correct args', () => {
    const cb = parseCallbackEvent(mkEvent('icraft_sess-123::ja'), 'icraft');
    expect(cb).not.toBeNull();
    expect(cb!.args).toEqual(['sess-123', 'ja']);
  });

  test('3. icraft_::anpassen dispatches with correct args', () => {
    const cb = parseCallbackEvent(mkEvent('icraft_sess-123::anpassen'), 'icraft');
    expect(cb).not.toBeNull();
    expect(cb!.args).toEqual(['sess-123', 'anpassen']);
  });

  test('4. icraft_::abbrechen dispatches with correct args', () => {
    const cb = parseCallbackEvent(mkEvent('icraft_sess-123::abbrechen'), 'icraft');
    expect(cb).not.toBeNull();
    expect(cb!.args).toEqual(['sess-123', 'abbrechen']);
  });

  // ── iscan_ ───────────────────────────────────────────────────────────

  test('5. iscan_ask_::craft dispatches with craft action', () => {
    const cb = parseCallbackEvent(mkEvent('iscan_ask_sess::craft'), 'iscan');
    expect(cb).not.toBeNull();
    expect(cb!.prefix).toBe('iscan');
    expect(cb!.payload.startsWith('ask_')).toBe(true);
    // args[0] = 'ask_sess', extract sessionId
    const askSessionId = cb!.args[0].slice(4);
    expect(askSessionId).toBe('sess');
    expect(cb!.args[1]).toBe('craft');
  });

  test('6. iscan_ask_::scan dispatches with scan action', () => {
    const cb = parseCallbackEvent(mkEvent('iscan_ask_sess::scan'), 'iscan');
    expect(cb).not.toBeNull();
    expect(cb!.payload.startsWith('ask_')).toBe(true);
    expect(cb!.args[1]).toBe('scan');
  });

  test('7. iscan_dir_ dispatches with sessionId', () => {
    const cb = parseCallbackEvent(mkEvent('iscan_dir_sess-123'), 'iscan');
    expect(cb).not.toBeNull();
    expect(cb!.payload.startsWith('dir_')).toBe(true);
    const sessionId = cb!.payload.slice(4);
    expect(sessionId).toBe('sess-123');
  });

  test('8. iscan_go_ dispatches with sessionId', () => {
    const cb = parseCallbackEvent(mkEvent('iscan_go_sess-123'), 'iscan');
    expect(cb).not.toBeNull();
    expect(cb!.payload.startsWith('go_')).toBe(true);
    const sessionId = cb!.payload.slice(3);
    expect(sessionId).toBe('sess-123');
  });

  test('9. iscan_::<proposalId> dispatches with args', () => {
    const cb = parseCallbackEvent(mkEvent('iscan_sess-123::p1'), 'iscan');
    expect(cb).not.toBeNull();
    expect(cb!.args).toEqual(['sess-123', 'p1']);
  });

  // ── isub_ ────────────────────────────────────────────────────────────

  test('10. isub_ dispatches with sessionId', () => {
    const cb = parseCallbackEvent(mkEvent('isub_sess-123'), 'isub');
    expect(cb).not.toBeNull();
    expect(cb!.prefix).toBe('isub');
    expect(cb!.args).toEqual(['sess-123']);
  });

  // ── Negative cases ───────────────────────────────────────────────────

  test('11. Non-instagram prefix returns null for all', () => {
    const event = mkEvent('segdel_abc::yes');
    expect(parseCallbackEvent(event, 'icraft')).toBeNull();
    expect(parseCallbackEvent(event, 'iscan')).toBeNull();
    expect(parseCallbackEvent(event, 'isub')).toBeNull();
  });

  test('12. Undefined content returns null for all', () => {
    const event = mkEvent(undefined);
    expect(parseCallbackEvent(event, 'icraft')).toBeNull();
    expect(parseCallbackEvent(event, 'iscan')).toBeNull();
    expect(parseCallbackEvent(event, 'isub')).toBeNull();
  });

  test('13. iscan_ask_ without separator has args.length 1 (guard)', () => {
    const cb = parseCallbackEvent(mkEvent('iscan_ask_sess'), 'iscan');
    expect(cb).not.toBeNull();
    expect(cb!.payload.startsWith('ask_')).toBe(true);
    // No '::' → single arg, dispatcher should guard on args.length < 2
    expect(cb!.args.length).toBe(1);
    expect(cb!.args[0]).toBe('ask_sess');
  });
});
