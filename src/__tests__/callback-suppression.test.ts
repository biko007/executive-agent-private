import { describe, expect, test } from 'bun:test';

/**
 * E4 — Callback prefix detection for before_agent_start suppression.
 *
 * The before_agent_start hook uses this logic to detect Telegram inline-button
 * callback content and suppress LLM forwarding. The framework wraps all prompts
 * in an envelope: "[Telegram sender timestamp] body". We match the envelope
 * boundary "] " followed by the callback prefix.
 */

const CALLBACK_PREFIXES = ['icraft_', 'iscan_', 'isub_', 'segdel_', 'booking_', 'bsync_', 'bweekly_'];

function isCallbackContent(prompt: string): boolean {
  return CALLBACK_PREFIXES.some(p => prompt.includes('] ' + p));
}

// Realistic envelope prefix used in all tests
const ENV = '[Telegram Juergen Bickel id:123456789 2026-05-18T13:31:25]';

describe('isCallbackContent — callback prefix detection (envelope-aware)', () => {
  // Positive: each known callback prefix inside envelope
  test('detects icraft_ callback in envelope', () => {
    expect(isCallbackContent(`${ENV} icraft_jb-1805::ja`)).toBe(true);
  });

  test('detects iscan_ callback in envelope', () => {
    expect(isCallbackContent(`${ENV} iscan_ask_sess::craft`)).toBe(true);
  });

  test('detects isub_ callback in envelope', () => {
    expect(isCallbackContent(`${ENV} isub_sess`)).toBe(true);
  });

  test('detects segdel_ callback in envelope', () => {
    expect(isCallbackContent(`${ENV} segdel_abc::yes`)).toBe(true);
  });

  test('detects booking_ callback in envelope', () => {
    expect(isCallbackContent(`${ENV} booking_key::new`)).toBe(true);
  });

  // Negative: normal user messages in envelope must NOT trigger
  test('does not match /instacraft command in envelope', () => {
    expect(isCallbackContent(`${ENV} /instacraft sess`)).toBe(false);
  });

  test('does not match normal text in envelope', () => {
    expect(isCallbackContent(`${ENV} Hello, how are you?`)).toBe(false);
  });

  test('does not match numeric reply in envelope', () => {
    expect(isCallbackContent(`${ENV} 3`)).toBe(false);
  });

  test('does not match empty body in envelope', () => {
    expect(isCallbackContent(`${ENV} `)).toBe(false);
  });

  // Edge cases
  test('does not match prefix without underscore in envelope', () => {
    expect(isCallbackContent(`${ENV} icraft`)).toBe(false);
  });

  test('does not match uppercase ICRAFT_ in envelope', () => {
    expect(isCallbackContent(`${ENV} ICRAFT_sess`)).toBe(false);
  });

  test('does not match bare empty string', () => {
    expect(isCallbackContent('')).toBe(false);
  });

  // New: envelope boundary protection
  test('does not match without proper envelope boundary (no space after ])', () => {
    expect(isCallbackContent('[Telegram]icraft_x')).toBe(false);
  });

  test('does not match malformed bracket mid-string', () => {
    expect(isCallbackContent('check this [malformed icraft_ thing')).toBe(false);
  });
});
