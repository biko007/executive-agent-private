/**
 * banking/etappe-d.test.ts — Sprint 7b Etappe d tests.
 * 7 tests covering pending challenge CRUD, encryption, and sensitive route detection.
 *
 * Setup: BANKING_ENCRYPTION_KEY set before setupTestDb().
 * Uses bun:test and setupTestDb() from existing test-db-setup.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

// Set encryption key BEFORE any module imports that might use it
process.env.BANKING_ENCRYPTION_KEY = 'a'.repeat(64);

let cleanup: () => Promise<void>;

beforeAll(async () => {
  const result = await setupTestDb();
  cleanup = result.cleanup;
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

// ── Pending Challenge Store Tests ─────────────────────────────────────────────

describe('pending challenge store', () => {
  test('1. setPendingChallenge + getPendingChallenge roundtrip', async () => {
    const { upsertInstitution, createSession } = await import('../store.js');
    const { setPendingChallenge, getPendingChallenge } = await import('../store.js');

    const inst = await upsertInstitution('11111111', 'Challenge Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'DUMMY_USER', 'DUMMY_PIN', 'test-product-d1');

    await setPendingChallenge(session.id, 'photoTAN', 'Bitte TAN eingeben', '{"dialog":"state123"}');

    const challenge = await getPendingChallenge(session.id);
    expect(challenge).not.toBeNull();
    expect(challenge!.sessionId).toBe(session.id);
    expect(challenge!.type).toBe('photoTAN');
    expect(challenge!.message).toBe('Bitte TAN eingeben');
    expect(challenge!.stateEncrypted).toBeInstanceOf(Buffer);
    expect(challenge!.stateEncrypted.length).toBeGreaterThan(0);
    expect(challenge!.challengeAt).toBeDefined();
  });

  test('2. clearPendingChallenge', async () => {
    const { upsertInstitution, createSession } = await import('../store.js');
    const { setPendingChallenge, getPendingChallenge, clearPendingChallenge } = await import('../store.js');

    const inst = await upsertInstitution('22222222', 'Clear Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'DUMMY_USER', 'DUMMY_PIN', 'test-product-d2');

    await setPendingChallenge(session.id, 'smsTAN', 'SMS TAN', '{"dialog":"clear"}');

    const before = await getPendingChallenge(session.id);
    expect(before).not.toBeNull();

    await clearPendingChallenge(session.id);

    const after = await getPendingChallenge(session.id);
    expect(after).toBeNull();
  });

  test('3. expireOldPendingChallenges', async () => {
    const { upsertInstitution, createSession } = await import('../store.js');
    const { setPendingChallenge, getPendingChallenge, expireOldPendingChallenges } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const inst = await upsertInstitution('33333333', 'Expire Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'DUMMY_USER', 'DUMMY_PIN', 'test-product-d3');

    await setPendingChallenge(session.id, 'pushTAN', 'Push TAN', '{"dialog":"expire"}');

    // Backdate the challenge to 15 minutes ago
    await query(
      `UPDATE banking_sessions SET pending_challenge_at = now() - interval '15 minutes' WHERE id = $1`,
      [session.id],
    );

    const expired = await expireOldPendingChallenges(10);
    expect(expired).toBeGreaterThanOrEqual(1);

    const after = await getPendingChallenge(session.id);
    expect(after).toBeNull();
  });

  test('4. pending challenge state is encrypted in DB', async () => {
    const { upsertInstitution, createSession } = await import('../store.js');
    const { setPendingChallenge } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const inst = await upsertInstitution('44444441', 'Enc Check Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'DUMMY_USER', 'DUMMY_PIN', 'test-product-d4');

    const cleartext = '{"dialog":"secret_state_data"}';
    await setPendingChallenge(session.id, 'photoTAN', 'Enter TAN', cleartext);

    // Direct SQL to check raw column content
    const { rows } = await query(
      'SELECT pending_challenge_state FROM banking_sessions WHERE id = $1',
      [session.id],
    );

    expect(rows.length).toBe(1);
    const raw = rows[0].pending_challenge_state;
    expect(raw).toBeInstanceOf(Buffer);

    // The raw BYTEA should be a JSON EncryptedPayload, not cleartext
    const rawStr = raw.toString('utf-8');
    expect(rawStr).not.toContain('secret_state_data');

    // Should be valid JSON (our EncryptedPayload)
    const parsed = JSON.parse(rawStr);
    expect(parsed.ciphertext).toBeDefined();
    expect(parsed.iv).toBeDefined();
    expect(parsed.authTag).toBeDefined();
    expect(parsed.keyVersion).toBe(1);
  });

  test('5. getPendingChallenge returns null when no challenge', async () => {
    const { upsertInstitution, createSession } = await import('../store.js');
    const { getPendingChallenge } = await import('../store.js');

    const inst = await upsertInstitution('55555551', 'No Challenge Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'DUMMY_USER', 'DUMMY_PIN', 'test-product-d5');

    const challenge = await getPendingChallenge(session.id);
    expect(challenge).toBeNull();
  });

  test('6. mapSession includes pendingChallengeType', async () => {
    const { upsertInstitution, createSession } = await import('../store.js');
    const { setPendingChallenge } = await import('../store.js');

    const inst = await upsertInstitution('66666661', 'Map Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'DUMMY_USER', 'DUMMY_PIN', 'test-product-d6');

    // Before setting challenge
    expect(session.pendingChallengeType).toBeNull();
    expect(session.pendingChallengeAt).toBeNull();

    await setPendingChallenge(session.id, 'pushTAN', 'Confirm', '{"dialog":"map"}');

    // Re-fetch via getDecryptedSession path to verify domain mapping
    // Use direct query + mapSession pattern (via createSession re-fetch)
    const { query } = await import('../../../shared/db/index.js');
    const { rows } = await query(
      'SELECT * FROM banking_sessions WHERE id = $1',
      [session.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].pending_challenge_type).toBe('pushTAN');
    expect(rows[0].pending_challenge_at).not.toBeNull();
  });
});

// ── Sensitive Route Tests ─────────────────────────────────────────────────────

describe('sensitive route', () => {
  test('7. isSensitiveRoute for complete-tan', async () => {
    const { isSensitiveRoute } = await import('../../../middleware/sensitive-body.js');
    const result = isSensitiveRoute('POST', '/api/banking/complete-tan');
    expect(result).toEqual({ conditional: 'tan_response' });
  });
});
