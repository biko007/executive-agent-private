/**
 * banking/etappe-2.10a.test.ts — Store-Layer: findReusableSession + markSessionStateInvalid.
 * 8 tests (T1-T8) covering session reuse lookup, user verification,
 * decrypt-failure policy, and roundtrip integrity.
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

// ── Helper: create a session with state for reuse tests ───────────────────────

async function createSessionWithState(opts: {
  blz: string;
  bankName: string;
  userId: string;
  pin?: string;
  clientDataB64: string;
  sessionFormat?: string;
  lastSuccessAt?: string;
  sessionExpiresAt?: string;
}) {
  const { upsertInstitution, createSession, updateSessionState } = await import('../store.js');
  const { query } = await import('../../../shared/db/index.js');

  const inst = await upsertInstitution(opts.blz, opts.bankName, null, 'https://example.com/fints');
  const session = await createSession(inst.id, opts.userId, opts.pin || 'PIN123', 'test-product');

  await updateSessionState(
    session.id,
    opts.clientDataB64,
    opts.sessionFormat || 'fints5',
    '4.1.0',
    opts.sessionExpiresAt || new Date(Date.now() + 86400000).toISOString(),
  );

  // Override last_success_at / session_expires_at if specified
  if (opts.lastSuccessAt) {
    await query(
      `UPDATE banking_sessions SET last_success_at = $1 WHERE id = $2`,
      [opts.lastSuccessAt, session.id],
    );
  }
  if (opts.sessionExpiresAt) {
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1 WHERE id = $2`,
      [opts.sessionExpiresAt, session.id],
    );
  }

  // Override session_format if non-default
  if (opts.sessionFormat && opts.sessionFormat !== 'fints5') {
    await query(
      `UPDATE banking_sessions SET session_format = $1 WHERE id = $2`,
      [opts.sessionFormat, session.id],
    );
  }

  return { institution: inst, session };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('findReusableSession + markSessionStateInvalid', () => {
  test('T1: happy path — valid row, user matches → returns ReusableSession', async () => {
    const { findReusableSession } = await import('../store.js');

    const b64 = 'dGVzdC1jbGllbnQtZGF0YQ=='; // base64 of "test-client-data"
    const { institution } = await createSessionWithState({
      blz: '10000001',
      bankName: 'T1 Bank',
      userId: 'USER_T1',
      clientDataB64: b64,
    });

    const result = await findReusableSession(institution.id, 'USER_T1');

    expect(result).not.toBeNull();
    expect(result!.clientDataB64).toBe(b64);
    expect(result!.sessionId).toBeGreaterThan(0);
    expect(result!.lastSuccessAt).toBeDefined();
    expect(result!.sessionExpiresAt).toBeDefined();
  });

  test('T2: user mismatch — row exists but different user → returns null + audit', async () => {
    const { findReusableSession } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const { institution } = await createSessionWithState({
      blz: '10000002',
      bankName: 'T2 Bank',
      userId: 'USER_T2_ACTUAL',
      clientDataB64: 'c29tZS1kYXRh',
    });

    const result = await findReusableSession(institution.id, 'USER_T2_WRONG');
    expect(result).toBeNull();

    // Check audit log for user_mismatch
    const { rows } = await query(
      `SELECT * FROM audit_log WHERE action = 'session.user_mismatch' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [String(institution.id)],
    );
    expect(rows.length).toBe(1);
    const after = rows[0].after_jsonb;
    expect(after.candidatesChecked).toBe(1);
  });

  test('T3: expired session (session_expires_at in past) → returns null', async () => {
    const { findReusableSession } = await import('../store.js');

    const { institution } = await createSessionWithState({
      blz: '10000003',
      bankName: 'T3 Bank',
      userId: 'USER_T3',
      clientDataB64: 'ZXhwaXJlZA==',
      sessionExpiresAt: new Date(Date.now() - 3600000).toISOString(), // 1h ago
    });

    const result = await findReusableSession(institution.id, 'USER_T3');
    expect(result).toBeNull();
  });

  test('T4: stale session (last_success_at > 30d ago) → returns null', async () => {
    const { findReusableSession } = await import('../store.js');

    const { institution } = await createSessionWithState({
      blz: '10000004',
      bankName: 'T4 Bank',
      userId: 'USER_T4',
      clientDataB64: 'c3RhbGU=',
      lastSuccessAt: new Date(Date.now() - 31 * 86400000).toISOString(), // 31 days ago
    });

    const result = await findReusableSession(institution.id, 'USER_T4');
    expect(result).toBeNull();
  });

  test('T5: format mismatch (session_format = fints4) → returns null', async () => {
    const { findReusableSession } = await import('../store.js');

    const { institution } = await createSessionWithState({
      blz: '10000005',
      bankName: 'T5 Bank',
      userId: 'USER_T5',
      clientDataB64: 'Zm9ybWF0NA==',
      sessionFormat: 'fints4',
    });

    const result = await findReusableSession(institution.id, 'USER_T5');
    expect(result).toBeNull();
  });

  test('T6: multiple candidates — first user mismatch, second matches → returns second', async () => {
    const { findReusableSession } = await import('../store.js');

    // Both sessions share the same institution
    const blz = '10000006';
    const b64Match = 'bWF0Y2hlZA=='; // "matched"

    // First session: wrong user
    const { institution } = await createSessionWithState({
      blz,
      bankName: 'T6 Bank',
      userId: 'USER_T6_WRONG',
      clientDataB64: 'bm90LXRoaXM=',
    });

    // Second session: right user (same institution)
    const { upsertInstitution: _, createSession, updateSessionState } = await import('../store.js');
    const session2 = await createSession(institution.id, 'USER_T6_RIGHT', 'PIN', 'test-product');
    await updateSessionState(
      session2.id,
      b64Match,
      'fints5',
      '4.1.0',
      new Date(Date.now() + 86400000).toISOString(),
    );

    const result = await findReusableSession(institution.id, 'USER_T6_RIGHT');

    expect(result).not.toBeNull();
    expect(result!.clientDataB64).toBe(b64Match);
    expect(result!.sessionId).toBe(session2.id);
  });

  test('T7: decrypt failure on first candidate, second matches → first invalidated, second returned', async () => {
    const { findReusableSession, upsertInstitution, createSession, updateSessionState } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const b64Good = 'Z29vZC1kYXRh'; // "good-data"

    // Create institution
    const inst = await upsertInstitution('10000007', 'T7 Bank', null, 'https://example.com/fints');

    // Good session first (lower id, earlier last_success_at)
    const goodSession = await createSession(inst.id, 'USER_T7', 'PIN', 'test-product');
    await updateSessionState(
      goodSession.id,
      b64Good,
      'fints5',
      '4.1.0',
      new Date(Date.now() + 86400000).toISOString(),
    );

    // Corrupted session second (higher id, later last_success_at → comes first in ORDER BY)
    const badSession = await createSession(inst.id, 'USER_T7', 'PIN', 'test-product');
    await updateSessionState(
      badSession.id,
      'aXJyZWxldmFudA==',
      'fints5',
      '4.1.0',
      new Date(Date.now() + 86400000).toISOString(),
    );

    // Corrupt the second session's user_id_encrypted directly in DB
    await query(
      `UPDATE banking_sessions SET user_id_encrypted = $1 WHERE id = $2`,
      ['{"ciphertext":"AAAA","iv":"AAAA","authTag":"AAAA","keyVersion":1}', badSession.id],
    );

    const result = await findReusableSession(inst.id, 'USER_T7');

    // Good candidate returned (after skipping the corrupted one)
    expect(result).not.toBeNull();
    expect(result!.clientDataB64).toBe(b64Good);
    expect(result!.sessionId).toBe(goodSession.id);

    // Corrupted candidate was invalidated (last_success_at = NULL)
    const { rows: invalidated } = await query(
      `SELECT last_success_at FROM banking_sessions WHERE id = $1`,
      [badSession.id],
    );
    expect(invalidated[0].last_success_at).toBeNull();

    // Audit entries: decrypt_failed + marked_invalid
    const { rows: auditRows } = await query(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'session.state.%' ORDER BY id`,
      [String(badSession.id)],
    );
    const actions = auditRows.map((r: any) => r.action);
    expect(actions).toContain('session.state.decrypt_failed');
    expect(actions).toContain('session.state.marked_invalid');
  });

  test('T9: all candidates decrypt-fail → decideReuse returns fresh, no session.reused audit', async () => {
    const { decideReuse, upsertInstitution, createSession, updateSessionState } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const inst = await upsertInstitution('10000009', 'T9 Bank', null, 'https://example.com/fints');

    // Create two sessions, both with corrupted user_id_encrypted
    const s1 = await createSession(inst.id, 'USER_T9', 'PIN', 'test-product');
    await updateSessionState(s1.id, 'c3RhdGUx', 'fints5', '4.1.0', new Date(Date.now() + 86400000).toISOString());
    await query(
      `UPDATE banking_sessions SET user_id_encrypted = $1 WHERE id = $2`,
      ['{"ciphertext":"AAAA","iv":"AAAA","authTag":"AAAA","keyVersion":1}', s1.id],
    );

    const s2 = await createSession(inst.id, 'USER_T9', 'PIN', 'test-product');
    await updateSessionState(s2.id, 'c3RhdGUy', 'fints5', '4.1.0', new Date(Date.now() + 86400000).toISOString());
    await query(
      `UPDATE banking_sessions SET user_id_encrypted = $1 WHERE id = $2`,
      ['{"ciphertext":"BBBB","iv":"BBBB","authTag":"BBBB","keyVersion":1}', s2.id],
    );

    // Clear any prior audit entries for these sessions
    await query(`DELETE FROM audit_log WHERE entity_id IN ($1, $2)`, [String(s1.id), String(s2.id)]);

    const ctx = await decideReuse(inst.id, 'USER_T9', 'PIN', 'test-product');

    // Must be fresh — all candidates were corrupt
    expect(ctx.reuseMode).toBe('fresh');
    expect(ctx.clientDataB64).toBeNull();
    // New session created (different from s1/s2)
    expect(ctx.sessionId).not.toBe(s1.id);
    expect(ctx.sessionId).not.toBe(s2.id);

    // Both corrupted sessions got decrypt_failed audit
    const { rows: decryptAudit } = await query(
      `SELECT entity_id FROM audit_log WHERE action = 'session.state.decrypt_failed' AND entity_id IN ($1, $2)`,
      [String(s1.id), String(s2.id)],
    );
    expect(decryptAudit.length).toBe(2);

    // No session.reused audit for ANY session in this institution
    const { rows: reusedAudit } = await query(
      `SELECT * FROM audit_log WHERE action = 'session.reused' AND entity_id IN ($1, $2, $3)`,
      [String(s1.id), String(s2.id), String(ctx.sessionId)],
    );
    expect(reusedAudit.length).toBe(0);
  });

  test('T8: roundtrip — encrypt(b64) → DB → decrypt → identical b64 string', async () => {
    const { findReusableSession } = await import('../store.js');

    // A real-ish base64 string (simulated client_data)
    const originalB64 = Buffer.from(
      JSON.stringify({ dialogId: 'D123', systemId: 'SYS456', msgNo: 42 }),
    ).toString('base64');

    const { institution } = await createSessionWithState({
      blz: '10000008',
      bankName: 'T8 Bank',
      userId: 'USER_T8',
      clientDataB64: originalB64,
    });

    const result = await findReusableSession(institution.id, 'USER_T8');

    expect(result).not.toBeNull();
    // Byte-exact match
    expect(result!.clientDataB64).toBe(originalB64);
    // Verify the decoded content is valid JSON
    const decoded = JSON.parse(Buffer.from(result!.clientDataB64, 'base64').toString('utf-8'));
    expect(decoded.dialogId).toBe('D123');
    expect(decoded.systemId).toBe('SYS456');
    expect(decoded.msgNo).toBe(42);
  });
});
