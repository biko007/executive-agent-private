/**
 * banking/etappe-e.test.ts — Sprint 7b Etappe e tests.
 * 8 tests: sync engine, reminders, advisory lock, sync status.
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

// ── Store: listActiveSessions ────────────────────────────────────────────────

describe('listActiveSessions', () => {
  test('1. excludes sessions with pending challenges', async () => {
    const { upsertInstitution, createSession, setPendingChallenge, listActiveSessions } =
      await import('../store.js');

    const inst = await upsertInstitution('50000001', 'Active Sessions Bank', null, 'https://example.com/fints');
    const s1 = await createSession(inst.id, 'USER1', 'PIN1', 'product-e1');
    const s2 = await createSession(inst.id, 'USER2', 'PIN2', 'product-e2');

    // Set pending challenge on s2
    await setPendingChallenge(s2.id, 'photoTAN', 'TAN bitte', '{"state":"pending"}');

    const active = await listActiveSessions();
    const activeIds = active.map(s => s.id);

    expect(activeIds).toContain(s1.id);
    expect(activeIds).not.toContain(s2.id);
  });
});

// ── Store: reminder dedup ────────────────────────────────────────────────────

describe('reminder dedup', () => {
  test('2. hasReminderBeenSent/markReminderSent/clearReminders roundtrip', async () => {
    const { upsertInstitution, createSession, hasReminderBeenSent, markReminderSent, clearReminders } =
      await import('../store.js');

    const inst = await upsertInstitution('50000002', 'Reminder Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'USER_R', 'PIN_R', 'product-e-r');

    // Initially not sent
    expect(await hasReminderBeenSent(session.id, 7)).toBe(false);
    expect(await hasReminderBeenSent(session.id, 14)).toBe(false);

    // Mark 7-day threshold as sent
    await markReminderSent(session.id, 7);
    expect(await hasReminderBeenSent(session.id, 7)).toBe(true);

    // Different threshold still false
    expect(await hasReminderBeenSent(session.id, 14)).toBe(false);

    // Idempotent: marking again does not throw
    await markReminderSent(session.id, 7);
    expect(await hasReminderBeenSent(session.id, 7)).toBe(true);

    // Clear all reminders
    await clearReminders(session.id);
    expect(await hasReminderBeenSent(session.id, 7)).toBe(false);
    expect(await hasReminderBeenSent(session.id, 14)).toBe(false);
  });
});

// ── Store: updateAccountBalance ──────────────────────────────────────────────

describe('updateAccountBalance', () => {
  test('3. targeted balance update', async () => {
    const { upsertInstitution, upsertAccount, listAccounts, updateAccountBalance } =
      await import('../store.js');

    const inst = await upsertInstitution('50000003', 'Balance Bank', null, 'https://example.com/fints');
    const account = await upsertAccount(inst.id, 'DE89370400440532013003', 'Balance Test');

    // Initially null balance
    expect(account.currentBalance).toBeNull();
    expect(account.lastSyncAt).toBeNull();

    // Update balance
    const syncAt = new Date().toISOString();
    await updateAccountBalance(account.id, 1234.56, syncAt);

    // Verify
    const accounts = await listAccounts({ institution_id: inst.id });
    const updated = accounts.find(a => a.id === account.id);
    expect(updated).toBeDefined();
    expect(updated!.currentBalance).toBe(1234.56);
    expect(updated!.lastSyncAt).not.toBeNull();
  });
});

// ── Sync engine: checkExpiryReminders dedup ──────────────────────────────────

describe('checkExpiryReminders', () => {
  test('4. dedup — second call produces no anomaly', async () => {
    const { upsertInstitution, createSession } = await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');
    const { checkExpiryReminders } = await import('../sync-engine.js');

    const inst = await upsertInstitution('50000004', 'Expiry Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'USER_E', 'PIN_E', 'product-e-exp');

    // Set session_expires_at to 5 days from now (matches 7-day threshold)
    const expiresAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1 WHERE id = $2`,
      [expiresAt, session.id],
    );

    // Re-fetch session with updated expiry
    const { listActiveSessions } = await import('../store.js');
    const sessions = await listActiveSessions();
    const updatedSession = sessions.find(s => s.id === session.id);
    expect(updatedSession).toBeDefined();

    // First call — should produce anomaly (7-day threshold)
    const anomalies1: any[] = [];
    await checkExpiryReminders(updatedSession!, anomalies1);
    expect(anomalies1.length).toBe(1);
    expect(anomalies1[0].type).toBe('session_expiry');
    expect(anomalies1[0].severity).toBe('warn'); // 7-day threshold

    // Second call — dedup, no new anomaly
    const anomalies2: any[] = [];
    await checkExpiryReminders(updatedSession!, anomalies2);
    expect(anomalies2.length).toBe(0);
  });
});

// ── Sync engine: dailySync ───────────────────────────────────────────────────

describe('dailySync', () => {
  test('5. handles sidecar down', async () => {
    const { dailySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => undefined,
      _sidecarHealth: async () => { throw new Error('Connection refused'); },
    });

    const result = await dailySync();
    expect(result.status).toBe('ok');

    const sidecarDown = result.anomalies.find(a => a.type === 'sidecar_down');
    expect(sidecarDown).toBeDefined();
    expect(sidecarDown!.severity).toBe('error');
  });

  test('6. treats sidecar sync 501 as non-error', async () => {
    const { upsertInstitution, createSession, upsertAccount, clearPendingChallenge } =
      await import('../store.js');
    const { SidecarError } = await import('../sidecar-client.js');

    // Setup: institution + session + account
    const inst = await upsertInstitution('50000006', 'Stub Bank 501', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'USER_501', 'PIN_501', 'product-e-501');
    await upsertAccount(inst.id, 'DE02120300000000202051', 'Account 501');

    // Ensure session is active
    await clearPendingChallenge(session.id);

    const { dailySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => undefined,
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => { throw new SidecarError('Not implemented', 501, 'stub'); },
    });

    const result = await dailySync();
    expect(result.status).toBe('ok');

    // No sync_error anomaly for 501
    const syncErrors = result.anomalies.filter(a => a.type === 'sync_error');
    expect(syncErrors.length).toBe(0);
  });

  test('7. advisory lock prevents concurrent sync', async () => {
    const { getClient } = await import('../../../shared/db/index.js');
    const { dailySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => undefined,
      _sidecarHealth: async () => ({ status: 'ok' }),
    });

    // Acquire advisory lock on a dedicated connection (not from pool)
    const lockClient = await getClient();
    await lockClient.query('SELECT pg_advisory_lock(43)');

    try {
      const result = await dailySync();
      expect(result.status).toBe('locked');
      expect(result.sessions_checked).toBe(0);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(43)');
      lockClient.release();
    }
  });
});

// ── getSyncStatus ────────────────────────────────────────────────────────────

describe('getSyncStatus', () => {
  test('8. returns correct structure', async () => {
    const { getSyncStatus } = await import('../sync-engine.js');

    const status = await getSyncStatus();
    expect(status).toHaveProperty('sessions_total');
    expect(status).toHaveProperty('accounts_total');
    expect(status).toHaveProperty('status');
    expect(['ok', 'stale', 'never_synced']).toContain(status.status);

    if (status.last_sync === null) {
      expect(status.status).toBe('never_synced');
    } else {
      expect(status.status).toBe('ok'); // Recent sync from tests above
    }
  });
});

// ── Sync-Filter: status='active' (Sprint 2.10-B Etappe a) ──────────────────

describe('sync-engine status filter', () => {
  test('9. listAccounts({status:"active"}) excludes archived accounts', async () => {
    const { upsertInstitution, upsertAccount, archiveAccount, listAccounts } =
      await import('../store.js');

    const inst = await upsertInstitution('50000009', 'Filter Bank', null, 'https://example.com/fints');
    const active1 = await upsertAccount(inst.id, 'DE89370400440532019001', 'Active Konto');
    const active2 = await upsertAccount(inst.id, 'DE89370400440532019002', 'Archived Konto');

    // Archive one account
    await archiveAccount(active2.id);

    // listAccounts with status filter → only active
    const accounts = await listAccounts({ institution_id: inst.id, status: 'active' });
    const ibans = accounts.map(a => a.iban);

    expect(ibans).toContain('DE89370400440532019001');
    expect(ibans).not.toContain('DE89370400440532019002');
  });

  test('10. dailySync calls sidecar only for active accounts', async () => {
    const { upsertInstitution, createSession, upsertAccount, archiveAccount } =
      await import('../store.js');
    const { query } = await import('../../../shared/db/index.js');

    // Setup: institution + session with valid state
    const inst = await upsertInstitution('50000010', 'Sync Filter Bank', null, 'https://example.com/fints');
    const session = await createSession(inst.id, 'USER_SF', 'PIN_SF', 'product-sf');

    // Set session_expires_at far in the future so it's active
    await query(
      `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
      [new Date(Date.now() + 90 * 86_400_000).toISOString(), session.id],
    );

    // Create 1 active + 1 archived account
    const activeAcct = await upsertAccount(inst.id, 'DE89370400440532010001', 'Active Sync');
    const archivedAcct = await upsertAccount(inst.id, 'DE89370400440532010002', 'Archived Sync');
    await archiveAccount(archivedAcct.id);

    // Track sidecar sync calls
    const syncedIbans: string[] = [];

    const { dailySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => undefined,
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async (params) => {
        syncedIbans.push(params.account_iban);
        return { transactions: [], balance: 100.00 };
      },
    });

    await dailySync();

    // Only the active account should have been synced
    expect(syncedIbans).toContain('DE89370400440532010001');
    expect(syncedIbans).not.toContain('DE89370400440532010002');
  });
});
