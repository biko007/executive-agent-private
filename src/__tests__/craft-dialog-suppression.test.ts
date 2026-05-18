import { describe, expect, test } from 'bun:test';

/**
 * E4b — Craft-dialog suppression for before_agent_start.
 *
 * When a user is in an active craft dialog (awaiting_direction or adjusting),
 * their free-text input is consumed by the message_received handler. The
 * before_agent_start hook must suppress the LLM to prevent duplicate responses.
 *
 * This mirrors the logic added to before_agent_start in index.ts.
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
  return state.step === 'awaiting_direction' || state.step === 'adjusting';
}

// Realistic envelope prefix used in all tests
const ENV = '[Telegram Juergen Bickel id:123456789 2026-05-18T13:31:25]';
const SENDER_ID = '123456789';
const VALID_EXPIRY = Date.now() + 30 * 60_000; // 30 min from now

describe('shouldSuppressForCraftDialog — craft dialog state detection', () => {
  // Positive: states where handler consumes input
  test('suppresses when step is awaiting_direction with valid expiry', () => {
    const dialogs = new Map<string, CraftDialogState>();
    dialogs.set(SENDER_ID, { step: 'awaiting_direction', expiresAt: VALID_EXPIRY });
    expect(shouldSuppressForCraftDialog(`${ENV} Warme Farben, herbstliche Stimmung`, dialogs)).toBe(true);
  });

  test('suppresses when step is adjusting with valid expiry', () => {
    const dialogs = new Map<string, CraftDialogState>();
    dialogs.set(SENDER_ID, { step: 'adjusting', expiresAt: VALID_EXPIRY });
    expect(shouldSuppressForCraftDialog(`${ENV} Mehr Kontrast bitte`, dialogs)).toBe(true);
  });

  // Negative: states where handler does NOT consume input
  test('does not suppress when step is generating', () => {
    const dialogs = new Map<string, CraftDialogState>();
    dialogs.set(SENDER_ID, { step: 'generating', expiresAt: VALID_EXPIRY });
    expect(shouldSuppressForCraftDialog(`${ENV} some text`, dialogs)).toBe(false);
  });

  test('does not suppress when step is plan_ready', () => {
    const dialogs = new Map<string, CraftDialogState>();
    dialogs.set(SENDER_ID, { step: 'plan_ready', expiresAt: VALID_EXPIRY });
    expect(shouldSuppressForCraftDialog(`${ENV} some text`, dialogs)).toBe(false);
  });

  test('does not suppress when step is executing', () => {
    const dialogs = new Map<string, CraftDialogState>();
    dialogs.set(SENDER_ID, { step: 'executing', expiresAt: VALID_EXPIRY });
    expect(shouldSuppressForCraftDialog(`${ENV} some text`, dialogs)).toBe(false);
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
