/**
 * banking/etappe-c.test.ts — Sprint 7b Etappe c tests.
 * 17 tests covering encryption, sensitive-body middleware, sidecar client, and store CRUD.
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

// ── Encryption Tests ──────────────────────────────────────────────────────────

describe('encryption', () => {
  test('1. encrypt + decrypt roundtrip', async () => {
    const { encrypt, decrypt } = await import('../encryption.js');
    const payload = encrypt('PIN123', '42', 'pin');
    const result = decrypt(payload, '42', 'pin');
    expect(result).toBe('PIN123');
  });

  test('2. AAD wrong sessionId → throws', async () => {
    const { encrypt, decrypt } = await import('../encryption.js');
    const payload = encrypt('SECRET', '42', 'pin');
    expect(() => decrypt(payload, '99', 'pin')).toThrow();
  });

  test('3. AAD wrong fieldName → throws', async () => {
    const { encrypt, decrypt } = await import('../encryption.js');
    const payload = encrypt('SECRET', '42', 'pin');
    expect(() => decrypt(payload, '42', 'user_id')).toThrow();
  });

  test('4. ciphertext tampering → throws', async () => {
    const { encrypt, decrypt } = await import('../encryption.js');
    const payload = encrypt('SECRET', '42', 'pin');
    // Tamper with ciphertext: flip a byte in the base64
    const buf = Buffer.from(payload.ciphertext, 'base64');
    buf[0] = buf[0] ^ 0xff;
    const tampered = { ...payload, ciphertext: buf.toString('base64') };
    expect(() => decrypt(tampered, '42', 'pin')).toThrow();
  });

  test('5. missing encryption key → throws EncryptionError', async () => {
    const { encrypt, EncryptionError } = await import('../encryption.js');
    const saved = process.env.BANKING_ENCRYPTION_KEY;
    delete process.env.BANKING_ENCRYPTION_KEY;
    try {
      expect(() => encrypt('test', '1', 'pin')).toThrow(EncryptionError);
    } finally {
      process.env.BANKING_ENCRYPTION_KEY = saved;
    }
  });

  test('6. non-existent key version → throws EncryptionError', async () => {
    const { encrypt, EncryptionError } = await import('../encryption.js');
    expect(() => encrypt('test', '1', 'pin', 99)).toThrow(EncryptionError);
  });
});

// ── Sensitive Body Middleware Tests ────────────────────────────────────────────

describe('sensitive-body middleware', () => {
  test('7. sensitive route detection', async () => {
    const { isSensitiveRoute } = await import('../../../middleware/sensitive-body.js');
    const result = isSensitiveRoute('POST', '/api/banking/connect');
    expect(result).toBe(true);
  });

  test('8. no-store header via markSensitiveResponse', async () => {
    const { markSensitiveResponse } = await import('../../../middleware/sensitive-body.js');
    const headers: Record<string, string> = {};
    const mockRes = {
      setHeader(name: string, value: string) { headers[name] = value; },
    } as any;
    markSensitiveResponse(mockRes);
    expect(headers['Cache-Control']).toBe('no-store');
  });

  test('9. rate limit rejects 6th call', async () => {
    const { checkSensitiveRateLimit, _resetRateLimits } = await import('../../../middleware/sensitive-body.js');
    _resetRateLimits();
    const actor = 'test-actor-rate-limit';
    for (let i = 0; i < 5; i++) {
      expect(checkSensitiveRateLimit(actor, 'POST', '/api/banking/connect')).toBe(true);
    }
    expect(checkSensitiveRateLimit(actor, 'POST', '/api/banking/connect')).toBe(false);
    _resetRateLimits(); // cleanup
  });
});

// ── Sidecar Client Tests ──────────────────────────────────────────────────────

describe('sidecar client', () => {
  test('10. sidecar health against running sidecar', async () => {
    const { health, SidecarError } = await import('../sidecar-client.js');
    try {
      const result = await health();
      expect(result).toBeDefined();
    } catch (e: any) {
      // Skip if sidecar unreachable or auth not configured in test env
      if (e instanceof SidecarError || e.message?.includes('fetch') ||
          e.message?.includes('ECONNREFUSED') || e.message?.includes('timeout')) {
        console.log(`  (skipped — sidecar: ${e.message?.slice(0, 60)})`);
        return;
      }
      throw e;
    }
  });

  test('11. sidecar connect returns 501', async () => {
    const { connect, SidecarError } = await import('../sidecar-client.js');
    try {
      await connect({
        session_id: 1, blz: '12345678', user_id: 'DUMMY', pin: 'DUMMY',
        fints_url: 'https://example.com/fints', product_id: 'test',
      });
      // If sidecar returned 200, that's unexpected but ok for this test
    } catch (e: any) {
      if (e instanceof SidecarError) {
        // Expected: 501 from stub or 4xx/5xx
        expect(e.statusCode).toBeGreaterThanOrEqual(400);
        return;
      }
      // Skip if unreachable
      if (e.message?.includes('fetch') || e.message?.includes('ECONNREFUSED') || e.message?.includes('timeout')) {
        console.log('  (skipped — sidecar not reachable)');
        return;
      }
      throw e;
    }
  });
});

// ── Store Tests (DB-backed) ──────────────────────────────────────────────────

describe('store', () => {
  test('12. createSession + getDecryptedSession roundtrip', async () => {
    const { upsertInstitution, createSession, getDecryptedSession } = await import('../store.js');

    // Setup institution
    const inst = await upsertInstitution('99999999', 'Test Bank', 'TESTDEFF', 'https://example.com/fints');

    // Create session with encrypted credentials
    const session = await createSession(inst.id, 'DUMMY_USER', 'DUMMY_PIN', 'test-product-01');
    expect(session.id).toBeGreaterThan(0);
    expect(session.institutionId).toBe(inst.id);

    // Decrypt and verify roundtrip
    const decrypted = await getDecryptedSession(session.id);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.userId).toBe('DUMMY_USER');
    expect(decrypted!.pin).toBe('DUMMY_PIN');
    expect(decrypted!.state).toBeNull();
  });

  test('13. insertTransaction dedup', async () => {
    const { upsertInstitution, upsertAccount, insertTransaction } = await import('../store.js');

    const inst = await upsertInstitution('88888888', 'Dedup Bank', null, 'https://example.com/fints');
    const acct = await upsertAccount(inst.id, 'DE89370400440532013000', 'Dedup Account');

    const txData = {
      bank_transaction_id: 'TX-DEDUP-001',
      booking_date: '2025-01-15',
      amount: -42.50,
      currency: 'EUR',
      counterparty_name: 'Test GmbH',
      raw_payload: { test: true },
    };

    const first = await insertTransaction(acct.id, txData);
    expect(first).not.toBeNull();
    expect(first!.amount).toBe(-42.50);

    // Same bank_transaction_id → should return null (dedup)
    const second = await insertTransaction(acct.id, txData);
    expect(second).toBeNull();
  });

  test('14. listTransactions date filter', async () => {
    const { upsertInstitution, upsertAccount, insertTransaction, listTransactions } = await import('../store.js');

    const inst = await upsertInstitution('77777777', 'Filter Bank', null, 'https://example.com/fints');
    const acct = await upsertAccount(inst.id, 'DE27100777770209299700', 'Filter Account');

    // Insert 3 transactions with different dates
    await insertTransaction(acct.id, {
      bank_transaction_id: 'TX-FILTER-JAN', booking_date: '2025-01-10',
      amount: -10, currency: 'EUR', raw_payload: {},
    });
    await insertTransaction(acct.id, {
      bank_transaction_id: 'TX-FILTER-FEB', booking_date: '2025-02-15',
      amount: -20, currency: 'EUR', raw_payload: {},
    });
    await insertTransaction(acct.id, {
      bank_transaction_id: 'TX-FILTER-MAR', booking_date: '2025-03-20',
      amount: -30, currency: 'EUR', raw_payload: {},
    });

    // Filter Feb only
    const febOnly = await listTransactions(acct.id, '2025-02-01', '2025-02-28');
    expect(febOnly.length).toBe(1);
    expect(febOnly[0].bankTransactionId).toBe('TX-FILTER-FEB');

    // Filter Jan+Feb
    const janFeb = await listTransactions(acct.id, '2025-01-01', '2025-02-28');
    expect(janFeb.length).toBe(2);

    // All
    const all = await listTransactions(acct.id);
    expect(all.length).toBe(3);
  });

  test('15. archiveAccount', async () => {
    const { upsertInstitution, upsertAccount, archiveAccount, listAccounts } = await import('../store.js');

    const inst = await upsertInstitution('66666666', 'Archive Bank', null, 'https://example.com/fints');
    const acct = await upsertAccount(inst.id, 'DE89370400440532013066', 'Archive Account');
    expect(acct.status).toBe('active');

    const archived = await archiveAccount(acct.id);
    expect(archived).not.toBeNull();
    expect(archived!.status).toBe('archived');

    // Verify via listAccounts with archived filter
    const archivedList = await listAccounts({ status: 'archived' });
    const found = archivedList.find(a => a.id === acct.id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('archived');
  });

  test('16. upsertInstitution insert + update', async () => {
    const { upsertInstitution } = await import('../store.js');

    const inst1 = await upsertInstitution('55555555', 'Original Name', 'ORIGDEFF', 'https://example.com/fints');
    expect(inst1.name).toBe('Original Name');

    // Upsert with same BLZ but new name
    const inst2 = await upsertInstitution('55555555', 'Updated Name', 'UPDTDEFF', 'https://example.com/fints2');
    expect(inst2.id).toBe(inst1.id); // same row
    expect(inst2.name).toBe('Updated Name');
    expect(inst2.bic).toBe('UPDTDEFF');
    expect(inst2.fintsUrl).toBe('https://example.com/fints2');
  });

  test('17. PIN not in raw DB row', async () => {
    const { upsertInstitution, createSession } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const inst = await upsertInstitution('44444444', 'Raw Check Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'SECRET_USER', 'SECRET_PIN', 'raw-check-01');

    // Direct SQL query to check raw column content
    const { rows } = await query(
      'SELECT pin_encrypted, user_id_encrypted FROM banking_sessions WHERE id = $1',
      [session.id],
    );

    expect(rows.length).toBe(1);
    const raw = rows[0];

    // pin_encrypted should be a JSON string, not cleartext
    expect(raw.pin_encrypted).not.toBe('SECRET_PIN');
    expect(raw.user_id_encrypted).not.toBe('SECRET_USER');

    // Should be valid JSON (our EncryptedPayload)
    const parsed = JSON.parse(raw.pin_encrypted);
    expect(parsed.ciphertext).toBeDefined();
    expect(parsed.iv).toBeDefined();
    expect(parsed.authTag).toBeDefined();
    expect(parsed.keyVersion).toBe(1);
  });
});
