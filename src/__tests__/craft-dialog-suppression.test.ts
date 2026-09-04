import { describe, expect, test } from 'bun:test';

/**
 * E4b-v2 — Craft-dialog suppression for before_prompt_build.
 *
 * Suppresses LLM for ANY active (non-expired) craft dialog, regardless of step.
 * Step-agnostic because the message_received handler mutates step synchronously
 * (~575ms before before_prompt_build fires), causing a race condition where the
 * hook would see 'generating' instead of 'awaiting_direction'.
 *
 * Only guard: dialog exists AND TTL not expired.
 */

interface CraftDialogState {
  step: 'awaiting_direction' | 'generating' | 'plan_ready' | 'adjusting' | 'executing';
  expiresAt: number;
}

function shouldSuppressForCraftDialog(
  prompt: string,
  dialogs: Map<string, CraftDialogState>,
): boolean {
  const match = prompt.match(/id:(\d{5,})/);
  if (!match) return false;
  const senderId = match[1];
  const state = dialogs.get(senderId);
  if (!state || Date.now() > state.expiresAt) return false;
  return true;
}

// Realistic envelope prefix used in all tests
const ENV = '[Telegram Juergen Bickel id:123456789 2026-05-18T13:31:25]';
const SENDER_ID = '123456789';
const VALID_EXPIRY = Date.now() + 30 * 60_000; // 30 min from now

describe('shouldSuppressForCraftDialog — step-agnostic suppression (E4b-v2)', () => {
  // Positive: all steps with valid TTL suppress
  test('suppresses when step is awaiting_direction', () => {
    const dialogs = new Map<string, CraftDialogState>();
    dialogs.set(SENDER_ID, { step: 'awaiting_direction', expiresAt: VALID_EXPIRY });
    expect(shouldSuppressForCraftDialog(`${ENV} Warme Farben, herbstliche Stimmung`, dialogs)).toBe(true);
  });

  test('suppresses when step is adjusting', () => {
    const dialogs = new Map<string, CraftDialogState>();
    dialogs.set(SENDER_ID, { step: 'adjusting', expiresAt: VALID_EXPIRY });
    expect(shouldSuppressForCraftDialog(`${ENV} Mehr Kontrast bitte`, dialogs)).toBe(true);
  });

  test('suppresses when step is generating (race condition case)', () => {
    const dialogs = new Map<string, CraftDialogState>();
    dialogs.set(SENDER_ID, { step: 'generating', expiresAt: VALID_EXPIRY });
    expect(shouldSuppressForCraftDialog(`${ENV} some text`, dialogs)).toBe(true);
  });

  test('suppresses when step is plan_ready', () => {
    const dialogs = new Map<string, CraftDialogState>();
    dialogs.set(SENDER_ID, { step: 'plan_ready', expiresAt: VALID_EXPIRY });
    expect(shouldSuppressForCraftDialog(`${ENV} some text`, dialogs)).toBe(true);
  });

  test('suppresses when step is executing', () => {
    const dialogs = new Map<string, CraftDialogState>();
    dialogs.set(SENDER_ID, { step: 'executing', expiresAt: VALID_EXPIRY });
    expect(shouldSuppressForCraftDialog(`${ENV} some text`, dialogs)).toBe(true);
  });

  // Negative: expired dialog
  test('does not suppress when dialog has expired', () => {
    const dialogs = new Map<string, CraftDialogState>();
    dialogs.set(SENDER_ID, { step: 'awaiting_direction', expiresAt: Date.now() - 1000 });
    expect(shouldSuppressForCraftDialog(`${ENV} some text`, dialogs)).toBe(false);
  });

  // Negative: no dialog for sender
  test('does not suppress when no dialog exists for sender', () => {
    const dialogs = new Map<string, CraftDialogState>();
    expect(shouldSuppressForCraftDialog(`${ENV} some text`, dialogs)).toBe(false);
  });

  // Negative: no senderId in prompt
  test('does not suppress when prompt has no senderId', () => {
    const dialogs = new Map<string, CraftDialogState>();
    dialogs.set(SENDER_ID, { step: 'awaiting_direction', expiresAt: VALID_EXPIRY });
    expect(shouldSuppressForCraftDialog('plain text without envelope', dialogs)).toBe(false);
  });

  // Negative: different senderId (no matching dialog)
  test('does not suppress when senderId does not match any dialog', () => {
    const dialogs = new Map<string, CraftDialogState>();
    dialogs.set('999999999', { step: 'awaiting_direction', expiresAt: VALID_EXPIRY });
    expect(shouldSuppressForCraftDialog(`${ENV} some text`, dialogs)).toBe(false);
  });
});
