/**
 * banking/etappe-e1.test.ts — E1 Alert-Verlässlichkeit + API-Contract tests.
 * 10 tests: global 3955-stop, alert tracking, contract fields, sync-run DB, timeout, partial failure.
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

// ── E1-1: Global 3955-Stopp inner loop ──────────────────────────────────────

describe('global 3955-stop (inner loop)', () => {
  test('E1-1. first needs_tan → second account skipped_due_to_tan', async () => {
    const { upsertInstitution, createSession, upsertAccount } =
      await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const inst = await upsertInstitution('60000001', 'E1 Inner Stop Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'USER_E1_1', 'PIN_E1_1', 'product-e1-1');

    await query(
      `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), session.id],
    );

    const acct1 = await upsertAccount(inst.id, 'DE89370400440532060001', 'E1 Konto A');
    const acct2 = await upsertAccount(inst.id, 'DE89370400440532060002', 'E1 Konto B');

    let syncCallCount = 0;
    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => 'test-chat-e1',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => {
        syncCallCount++;
        // First call: needs_tan. Second call should never happen.
        return { needs_tan: true, tan_type: 'pushTAN', transactions: [] };
      },
    });

    const result = await startWeeklySync();

    // Only 1 sidecar call (first account), second never contacted
    expect(syncCallCount).toBe(1);

    expect(result.status).toBe('TAN_REQUIRED');
    expect(result.sca_required).toBe(true);

    // First account: tan_required
    const tanAcct = result.accounts.find(a => a.account_id === acct1.id);
    expect(tanAcct).toBeDefined();
    expect(tanAcct!.result).toBe('tan_required');
    expect(tanAcct!.fints_codes).toContain('3955');

    // Second account: skipped_due_to_tan (never contacted)
    const skippedAcct = result.accounts.find(a => a.account_id === acct2.id);
    expect(skippedAcct).toBeDefined();
    expect(skippedAcct!.result).toBe('skipped_due_to_tan');
  });
});

// ── E1-2: Global 3955-Stopp outer loop ──────────────────────────────────────

describe('global 3955-stop (outer loop)', () => {
  test('E1-2. first institution 3955 → second institution all skipped, no sidecar call', async () => {
    const { upsertInstitution, createSession, upsertAccount } =
      await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    // Institution 1: will trigger 3955
    const inst1 = await upsertInstitution('60000021', 'E1 Bank Alpha', null, 'https://example.com/fints');
    const sess1 = await createSession(inst1.id, 'USER_E1_2A', 'PIN_E1_2A', 'product-e1-2a');
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), sess1.id],
    );
    await upsertAccount(inst1.id, 'DE89370400440532060021', 'Alpha Konto 1');

    // Institution 2: should be skipped entirely
    const inst2 = await upsertInstitution('60000022', 'E1 Bank Beta', null, 'https://example.com/fints');
    const sess2 = await createSession(inst2.id, 'USER_E1_2B', 'PIN_E1_2B', 'product-e1-2b');
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), sess2.id],
    );
    const acctBeta = await upsertAccount(inst2.id, 'DE89370400440532060022', 'Beta Konto 1');

    // Disable all prior sessions so startWeeklySync only sees the two institutions we care about
    await query(
      `UPDATE banking_sessions SET pending_challenge_type = 'test_disabled' WHERE id NOT IN ($1, $2)`,
      [sess1.id, sess2.id],
    );

    // Track which IBANs get sidecar calls
    const syncedIbans: string[] = [];

    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => 'test-chat-e1-2',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async (params) => {
        syncedIbans.push(params.account_iban);
        // Always return needs_tan (first institution triggers it)
        return { needs_tan: true, tan_type: 'pushTAN', transactions: [] };
      },
    });

    const result = await startWeeklySync();

    // Re-enable sessions for other tests
    await query(
      `UPDATE banking_sessions SET pending_challenge_type = NULL WHERE pending_challenge_type = 'test_disabled'`,
    );

    expect(result.status).toBe('TAN_REQUIRED');

    // At most one institution contacted — second must NOT be contacted
    expect(syncedIbans).not.toContain('DE89370400440532060022');

    // Beta account skipped
    const betaAcct = result.accounts.find(a => a.account_id === acctBeta.id);
    expect(betaAcct).toBeDefined();
    expect(betaAcct!.result).toBe('skipped_due_to_tan');
  });
});

// ── E1-3: alert_delivered=true ──────────────────────────────────────────────

describe('alert tracking', () => {
  test('E1-3. alert_delivered=true when sendTelegram succeeds', async () => {
    const { upsertInstitution, createSession, upsertAccount } =
      await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const inst = await upsertInstitution('60000031', 'E1 Alert OK Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'USER_E1_3', 'PIN_E1_3', 'product-e1-3');
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), session.id],
    );
    await upsertAccount(inst.id, 'DE89370400440532060031', 'Alert OK Konto');

    let sendTelegramCalled = false;

    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => { sendTelegramCalled = true; return true; },
      telegramChatId: () => 'test-chat-e1-3',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => ({ needs_tan: true, tan_type: 'pushTAN', transactions: [] }),
    });

    const result = await startWeeklySync();

    expect(sendTelegramCalled).toBe(true);
    expect(result.alert_delivered).toBe(true);
  });

  // ── E1-4: alert_delivered=false when sendTelegram throws ──────────────────

  test('E1-4. alert_delivered=false when sendTelegram throws', async () => {
    const { upsertInstitution, createSession, upsertAccount } =
      await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const inst = await upsertInstitution('60000041', 'E1 Alert Fail Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'USER_E1_4', 'PIN_E1_4', 'product-e1-4');
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), session.id],
    );
    await upsertAccount(inst.id, 'DE89370400440532060041', 'Alert Fail Konto');

    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => { throw new Error('Telegram API error'); },
      telegramChatId: () => 'test-chat-e1-4',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => ({ needs_tan: true, tan_type: 'pushTAN', transactions: [] }),
    });

    const result = await startWeeklySync();

    expect(result.alert_delivered).toBe(false);
    // Status still TAN_REQUIRED (alert failure doesn't change sync outcome)
    expect(result.status).toBe('TAN_REQUIRED');
  });

  // ── E1-5: alert_delivered=false when chatId missing ───────────────────────

  test('E1-5. alert_delivered=false when chatId is undefined', async () => {
    const { upsertInstitution, createSession, upsertAccount } =
      await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const inst = await upsertInstitution('60000051', 'E1 No ChatId Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'USER_E1_5', 'PIN_E1_5', 'product-e1-5');
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), session.id],
    );
    await upsertAccount(inst.id, 'DE89370400440532060051', 'No ChatId Konto');

    let sendTelegramCalled = false;

    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => { sendTelegramCalled = true; return true; },
      telegramChatId: () => undefined, // No chatId configured
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => ({ needs_tan: true, tan_type: 'pushTAN', transactions: [] }),
    });

    const result = await startWeeklySync();

    expect(sendTelegramCalled).toBe(false); // sendTelegram never called
    expect(result.alert_delivered).toBe(false);
  });
});

// ── E1-6: safe_to_schedule_resync ───────────────────────────────────────────

describe('safe_to_schedule_resync', () => {
  test('E1-6. true only when TAN_REQUIRED + alert_delivered=true', async () => {
    const { upsertInstitution, createSession, upsertAccount } =
      await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    // Scenario A: TAN_REQUIRED + alert delivered → safe_to_schedule_resync = true
    const instA = await upsertInstitution('60000061', 'E1 Resync A Bank', null, 'https://example.com/fints');
    const sessA = await createSession(instA.id, 'USER_E1_6A', 'PIN_E1_6A', 'product-e1-6a');
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), sessA.id],
    );
    await upsertAccount(instA.id, 'DE89370400440532060061', 'Resync A Konto');

    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true, // delivery succeeds
      telegramChatId: () => 'test-chat-e1-6',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => ({ needs_tan: true, tan_type: 'pushTAN', transactions: [] }),
    });

    const resultA = await startWeeklySync();
    expect(resultA.status).toBe('TAN_REQUIRED');
    expect(resultA.alert_delivered).toBe(true);
    expect(resultA.safe_to_schedule_resync).toBe(true);

    // Scenario B: TAN_REQUIRED + alert NOT delivered → safe_to_schedule_resync = false
    const instB = await upsertInstitution('60000062', 'E1 Resync B Bank', null, 'https://example.com/fints');
    const sessB = await createSession(instB.id, 'USER_E1_6B', 'PIN_E1_6B', 'product-e1-6b');
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), sessB.id],
    );
    await upsertAccount(instB.id, 'DE89370400440532060062', 'Resync B Konto');

    initSyncEngine({
      sendTelegram: async () => { throw new Error('Telegram down'); },
      telegramChatId: () => 'test-chat-e1-6b',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => ({ needs_tan: true, tan_type: 'pushTAN', transactions: [] }),
    });

    const resultB = await startWeeklySync();
    expect(resultB.status).toBe('TAN_REQUIRED');
    expect(resultB.alert_delivered).toBe(false);
    expect(resultB.safe_to_schedule_resync).toBe(false);
  });
});

// ── E1-7: Contract response shape ──────────────────────────────────────────

describe('contract response', () => {
  test('E1-7. response has all required §4 fields', async () => {
    const { upsertInstitution, createSession, upsertAccount } =
      await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const inst = await upsertInstitution('60000071', 'E1 Contract Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'USER_E1_7', 'PIN_E1_7', 'product-e1-7');
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), session.id],
    );
    await upsertAccount(inst.id, 'DE89370400440532060071', 'Contract Konto');

    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => undefined,
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => ({ transactions: [], balance: 100.00 }),
    });

    const result = await startWeeklySync();

    // Top-level contract fields
    expect(typeof result.run_id).toBe('string');
    expect(result.run_id).toMatch(/^\d{4}-\d{2}-\d{2}-(mo|di|mi|do|fr|sa|so)$/);
    expect(typeof result.status).toBe('string');
    expect(typeof result.sca_required).toBe('boolean');
    expect(typeof result.alert_delivered).toBe('boolean');
    expect(typeof result.safe_to_schedule_resync).toBe('boolean');
    expect(Array.isArray(result.accounts)).toBe(true);

    // Valid status enum
    const validStatuses = [
      'SUCCESS_FULL', 'TAN_REQUIRED', 'BANK_TIMEOUT_UNKNOWN',
      'IMPORT_FAILED', 'SKIPPED_ALREADY_SYNCED', 'SKIPPED_ALREADY_RUNNING',
      'AUTO_PAUSED_PENDING_TAN',
    ];
    expect(validStatuses).toContain(result.status);

    // Per-account fields
    for (const acct of result.accounts) {
      expect(typeof acct.account_id).toBe('number');
      expect(typeof acct.result).toBe('string');
      expect(['success', 'tan_required', 'timeout', 'import_failed', 'skipped_due_to_tan']).toContain(acct.result);
      expect(Array.isArray(acct.fints_codes)).toBe(true);
      expect(typeof acct.transactions_seen).toBe('number');
      expect(typeof acct.transactions_inserted).toBe('number');
    }
  });
});

// ── E1-8: Sync-Run record in DB ────────────────────────────────────────────

describe('sync-run DB record', () => {
  test('E1-8. banking_sync_runs row written after startWeeklySync()', async () => {
    const { upsertInstitution, createSession, upsertAccount } =
      await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const inst = await upsertInstitution('60000081', 'E1 SyncRun Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'USER_E1_8', 'PIN_E1_8', 'product-e1-8');
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), session.id],
    );
    await upsertAccount(inst.id, 'DE89370400440532060081', 'SyncRun Konto');

    // Clear prior sync_runs for this institution
    await query(`DELETE FROM banking_sync_runs WHERE institution_id = $1`, [inst.id]);

    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => undefined,
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => ({
        transactions: [
          { bank_transaction_id: 'TX-E1-8-001', booking_date: '2026-06-25', value_date: '2026-06-25',
            amount: -10.00, currency: 'EUR', reference: 'E1-8 test' },
        ],
        balance: 90.00,
      }),
    });

    const result = await startWeeklySync();
    expect(result.status).toBe('SUCCESS_FULL');

    // Verify sync_run record exists in DB
    const { rows } = await query<{
      id: string;
      institution_id: string;
      status: string;
      sca_required: boolean | null;
      alert_delivered: boolean | null;
      accounts_synced: number | null;
      transactions_new: number | null;
      finished_at: string | null;
    }>(
      `SELECT id, institution_id, status, sca_required, alert_delivered, accounts_synced, transactions_new, finished_at
       FROM banking_sync_runs WHERE institution_id = $1 ORDER BY id DESC LIMIT 1`,
      [inst.id],
    );

    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('SUCCESS_FULL');
    expect(rows[0].finished_at).not.toBeNull();
    expect(rows[0].accounts_synced).toBeGreaterThanOrEqual(1);
    expect(rows[0].transactions_new).toBeGreaterThanOrEqual(1);
  });
});

// ── E1-9: Timeout → BANK_TIMEOUT_UNKNOWN ───────────────────────────────────

describe('timeout handling', () => {
  test('E1-9. timeout error → BANK_TIMEOUT_UNKNOWN + global stop', async () => {
    const { upsertInstitution, createSession, upsertAccount } =
      await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const inst = await upsertInstitution('60000091', 'E1 Timeout Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'USER_E1_9', 'PIN_E1_9', 'product-e1-9');
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), session.id],
    );
    const acct1 = await upsertAccount(inst.id, 'DE89370400440532060091', 'Timeout Konto A');
    const acct2 = await upsertAccount(inst.id, 'DE89370400440532060092', 'Timeout Konto B');

    // Disable all prior sessions so startWeeklySync only sees this institution
    await query(
      `UPDATE banking_sessions SET pending_challenge_type = 'test_disabled' WHERE id != $1`,
      [session.id],
    );

    let syncCallCount = 0;

    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => 'test-chat-e1-9',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => {
        syncCallCount++;
        // Simulate timeout (AbortError pattern from fetchWithTimeout)
        throw new Error('The operation was aborted. AbortError');
      },
    });

    const result = await startWeeklySync();

    // Re-enable sessions for other tests
    await query(
      `UPDATE banking_sessions SET pending_challenge_type = NULL WHERE pending_challenge_type = 'test_disabled'`,
    );

    // Only 1 sidecar call — second account never contacted
    expect(syncCallCount).toBe(1);

    expect(result.status).toBe('BANK_TIMEOUT_UNKNOWN');
    expect(result.alert_delivered).toBe(true); // anomaly triggers alert, sendTelegram returns true

    // First account: timeout
    const timeoutAcct = result.accounts.find(a => a.account_id === acct1.id);
    expect(timeoutAcct).toBeDefined();
    expect(timeoutAcct!.result).toBe('timeout');

    // Second account: skipped (global stop)
    const skippedAcct = result.accounts.find(a => a.account_id === acct2.id);
    expect(skippedAcct).toBeDefined();
    expect(skippedAcct!.result).toBe('skipped_due_to_tan');

    // safe_to_schedule_resync false (timeout, not tan_required)
    expect(result.safe_to_schedule_resync).toBe(false);
  });
});

// ── E1-10: Partial failure → IMPORT_FAILED ──────────────────────────────────

describe('partial failure', () => {
  test('E1-10. 1 account OK + 1 account error → IMPORT_FAILED', async () => {
    const { upsertInstitution, createSession, upsertAccount } =
      await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    const inst = await upsertInstitution('60000101', 'E1 Partial Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'USER_E1_10', 'PIN_E1_10', 'product-e1-10');
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), session.id],
    );
    const acct1 = await upsertAccount(inst.id, 'DE89370400440532060101', 'Partial OK Konto');
    const acct2 = await upsertAccount(inst.id, 'DE89370400440532060102', 'Partial Fail Konto');

    // Disable all prior sessions so startWeeklySync only sees this institution
    await query(
      `UPDATE banking_sessions SET pending_challenge_type = 'test_disabled' WHERE id != $1`,
      [session.id],
    );

    // Track calls per IBAN to control which account succeeds/fails
    const { startWeeklySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => 'test-chat-e1-10',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async (params) => {
        if (params.account_iban === 'DE89370400440532060101') {
          // First account succeeds
          return { transactions: [], balance: 200.00 };
        }
        // Second account fails (definitive error, not timeout)
        throw new Error('FinTS protocol error: HKKAZ segment rejected');
      },
    });

    const result = await startWeeklySync();

    // Re-enable sessions for other tests
    await query(
      `UPDATE banking_sessions SET pending_challenge_type = NULL WHERE pending_challenge_type = 'test_disabled'`,
    );

    // No SUCCESS_PARTIAL — any mix → IMPORT_FAILED (§4)
    expect(result.status).toBe('IMPORT_FAILED');
    expect(result.sca_required).toBe(false);

    // First account: success
    const okAcct = result.accounts.find(a => a.account_id === acct1.id);
    expect(okAcct).toBeDefined();
    expect(okAcct!.result).toBe('success');

    // Second account: import_failed (definitive error, not timeout)
    const failAcct = result.accounts.find(a => a.account_id === acct2.id);
    expect(failAcct).toBeDefined();
    expect(failAcct!.result).toBe('import_failed');
  });
});
