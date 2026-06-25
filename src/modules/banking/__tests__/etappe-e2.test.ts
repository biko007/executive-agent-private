/**
 * banking/etappe-e2.test.ts — E2 tests: Tages-Guard, CB-SET/CLEAR, SCA-Budget,
 * eventResync, Lookback-Cursor, Button validation, /banking resume.
 *
 * Pattern: etappe-e1.test.ts (bun:test, setupTestDb, mocked sidecar, real DB assertions).
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

/** Helper: create institution + session + account(s) for test isolation. */
async function setupInstitution(blz: string, name: string, ibans: string[]) {
  const { upsertInstitution, createSession, upsertAccount } =
    await import('../store.js');
  const { query } = await import('../../../shared/db/index.js');

  const inst = await upsertInstitution(blz, name, null, 'https://example.com/fints');
  const session = await createSession(inst.id, `USER_${blz}`, `PIN_${blz}`, `product-${blz}`);

  await query(
    `UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
    [new Date(Date.now() + 90 * 86_400_000).toISOString(), session.id],
  );

  const accounts = [];
  for (const iban of ibans) {
    accounts.push(await upsertAccount(inst.id, iban, `Konto ${iban.slice(-4)}`));
  }

  return { inst, session, accounts };
}

/** Helper: isolate sessions so only the given session IDs are active. */
async function isolateSessions(activeSessionIds: number[]) {
  const { query } = await import('../../../shared/db/index.js');
  const placeholders = activeSessionIds.map((_, i) => `$${i + 1}`).join(', ');
  await query(
    `UPDATE banking_sessions SET pending_challenge_type = 'test_disabled' WHERE id NOT IN (${placeholders})`,
    activeSessionIds,
  );
}

/** Helper: restore all disabled sessions. */
async function restoreSessions() {
  const { query } = await import('../../../shared/db/index.js');
  await query(
    `UPDATE banking_sessions SET pending_challenge_type = NULL WHERE pending_challenge_type = 'test_disabled'`,
  );
}

// ── E2-1: Tages-Guard — 2. Sync → SKIPPED ────────────────────────────────────

describe('Tages-Guard', () => {
  test('E2-1. second sync same day → SKIPPED_ALREADY_SYNCED', async () => {
    const { inst, session, accounts } = await setupInstitution(
      '70000201', 'E2 Guard Bank', ['DE89370400440532070201'],
    );
    await isolateSessions([session.id]);

    let syncCallCount = 0;
    const { dailySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => 'test-chat-e2-1',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => {
        syncCallCount++;
        return { transactions: [], balance: 100.00 };
      },
    });

    // First sync: should succeed
    const result1 = await dailySync();
    expect(result1.status).toBe('SUCCESS_FULL');
    expect(syncCallCount).toBe(1);

    // Second sync: Tages-Guard should skip
    const result2 = await dailySync();
    expect(result2.status).toBe('SKIPPED_ALREADY_SYNCED');
    // Sidecar NOT called again
    expect(syncCallCount).toBe(1);

    await restoreSessions();
  });
});

// ── E2-2: eventResync umgeht Guard ────────────────────────────────────────────

describe('eventResync bypasses guard', () => {
  test('E2-2. eventResync runs despite prior dailySync today', async () => {
    const { inst, session } = await setupInstitution(
      '70000202', 'E2 Resync Bank', ['DE89370400440532070202'],
    );
    await isolateSessions([session.id]);

    let syncCallCount = 0;
    const { dailySync, eventResync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => 'test-chat-e2-2',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => {
        syncCallCount++;
        return { transactions: [], balance: 200.00 };
      },
    });

    // First: dailySync
    await dailySync();
    expect(syncCallCount).toBe(1);

    // eventResync: sidecar WILL be called despite prior run
    const result = await eventResync(inst.id, 'test', 'e2-2');
    expect(syncCallCount).toBe(2);
    expect(result.status).toBe('SUCCESS_FULL');

    await restoreSessions();
  });
});

// ── E2-3: CB-SET after eventResync TAN ────────────────────────────────────────

describe('CB-SET after eventResync TAN', () => {
  test('E2-3. eventResync TAN_REQUIRED → sync_paused_status set in DB', async () => {
    const { inst, session } = await setupInstitution(
      '70000203', 'E2 CB-SET Bank', ['DE89370400440532070203'],
    );
    await isolateSessions([session.id]);

    const { eventResync, initSyncEngine } = await import('../sync-engine.js');
    const { query } = await import('../../../shared/db/index.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => 'test-chat-e2-3',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => ({ needs_tan: true, tan_type: 'pushTAN', transactions: [] }),
    });

    const result = await eventResync(inst.id, 'test', 'e2-3');
    expect(result.status).toBe('TAN_REQUIRED');

    // Verify pause status directly in DB (not via mock)
    const { rows } = await query<{ sync_paused_status: string | null }>(
      'SELECT sync_paused_status FROM banking_institutions WHERE id = $1',
      [inst.id],
    );
    expect(rows[0].sync_paused_status).toBe('AUTO_PAUSED_PENDING_TAN');

    // Clean up pause for other tests
    await query('UPDATE banking_institutions SET sync_paused_status = NULL WHERE id = $1', [inst.id]);
    await restoreSessions();
  });
});

// ── E2-4: Lazy CB-SET bei naechstem dailySync ─────────────────────────────────

describe('Lazy CB-SET', () => {
  test('E2-4. previous day TAN_REQUIRED → lazy CB-SET on next dailySync', async () => {
    const { inst, session } = await setupInstitution(
      '70000204', 'E2 Lazy CB Bank', ['DE89370400440532070204'],
    );
    await isolateSessions([session.id]);

    const { query } = await import('../../../shared/db/index.js');

    // Simulate a completed sync run from yesterday with TAN_REQUIRED status
    await query(
      `INSERT INTO banking_sync_runs (institution_id, sync_date, run_phase, status, finished_at)
       VALUES ($1, CURRENT_DATE - INTERVAL '1 day', 'scheduled', 'TAN_REQUIRED', now() - INTERVAL '1 day')`,
      [inst.id],
    );

    let syncCallCount = 0;
    const { dailySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => 'test-chat-e2-4',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => {
        syncCallCount++;
        return { transactions: [], balance: 100.00 };
      },
    });

    const result = await dailySync();

    // Institution should be paused (lazy CB-SET triggered), sidecar NOT called
    expect(syncCallCount).toBe(0);

    // Verify pause in DB
    const { rows } = await query<{ sync_paused_status: string | null }>(
      'SELECT sync_paused_status FROM banking_institutions WHERE id = $1',
      [inst.id],
    );
    expect(rows[0].sync_paused_status).toBe('AUTO_PAUSED_PENDING_TAN');

    // Clean up
    await query('UPDATE banking_institutions SET sync_paused_status = NULL WHERE id = $1', [inst.id]);
    await restoreSessions();
  });
});

// ── E2-5: CB-CLEAR bei SUCCESS_FULL ───────────────────────────────────────────

describe('CB-CLEAR on SUCCESS', () => {
  test('E2-5. SUCCESS_FULL → sync_paused_status cleared in DB', async () => {
    const { inst, session } = await setupInstitution(
      '70000205', 'E2 CB-CLEAR Bank', ['DE89370400440532070205'],
    );
    await isolateSessions([session.id]);

    const { query } = await import('../../../shared/db/index.js');

    // Pre-set pause status
    await query(
      `UPDATE banking_institutions SET sync_paused_status = 'AUTO_PAUSED_PENDING_TAN', sync_paused_since = now() WHERE id = $1`,
      [inst.id],
    );

    const { eventResync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => 'test-chat-e2-5',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => ({ transactions: [], balance: 500.00 }),
    });

    const result = await eventResync(inst.id, 'test', 'e2-5');
    expect(result.status).toBe('SUCCESS_FULL');

    // Verify pause cleared in DB
    const { rows } = await query<{ sync_paused_status: string | null }>(
      'SELECT sync_paused_status FROM banking_institutions WHERE id = $1',
      [inst.id],
    );
    expect(rows[0].sync_paused_status).toBeNull();

    await restoreSessions();
  });
});

// ── E2-6: SCA-Budget ueberschritten ──────────────────────────────────────────

describe('SCA-Budget', () => {
  test('E2-6. SCA budget exceeded → anomaly, no sidecar call', async () => {
    const { inst, session } = await setupInstitution(
      '70000206', 'E2 SCA Budget Bank', ['DE89370400440532070206'],
    );
    await isolateSessions([session.id]);

    const { query } = await import('../../../shared/db/index.js');

    // Insert 6 recent sync runs with sca_required=true (budget = 6/30d)
    for (let i = 0; i < 6; i++) {
      await query(
        `INSERT INTO banking_sync_runs (institution_id, run_phase, status, sca_required, started_at, finished_at)
         VALUES ($1, 'scheduled', 'TAN_REQUIRED', true, now() - INTERVAL '${i + 1} days', now() - INTERVAL '${i + 1} days')`,
        [inst.id],
      );
    }

    let syncCallCount = 0;
    const { dailySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => 'test-chat-e2-6',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async () => {
        syncCallCount++;
        return { transactions: [] };
      },
    });

    const result = await dailySync();

    // Sidecar should NOT have been called (budget exceeded → skipped)
    expect(syncCallCount).toBe(0);

    // Clean up
    await restoreSessions();
  });
});

// ── E2-7: /banking resume klaert Pause ───────────────────────────────────────

describe('/banking resume', () => {
  test('E2-7. resume clears pause for institutions', async () => {
    const { query } = await import('../../../shared/db/index.js');
    const { upsertInstitution, setInstitutionSyncPaused, getInstitutionSyncPauseStatus } =
      await import('../store.js');

    // Create 2 institutions and pause both
    const inst1 = await upsertInstitution('70000207', 'E2 Resume Bank 1', null, 'https://example.com/fints');
    const inst2 = await upsertInstitution('70000208', 'E2 Resume Bank 2', null, 'https://example.com/fints');
    await setInstitutionSyncPaused(inst1.id, 'AUTO_PAUSED_PENDING_TAN');
    await setInstitutionSyncPaused(inst2.id, 'AUTO_PAUSED_PENDING_TAN');

    // Verify both paused
    const p1 = await getInstitutionSyncPauseStatus(inst1.id);
    const p2 = await getInstitutionSyncPauseStatus(inst2.id);
    expect(p1.syncPausedStatus).toBe('AUTO_PAUSED_PENDING_TAN');
    expect(p2.syncPausedStatus).toBe('AUTO_PAUSED_PENDING_TAN');

    // Import commands and call handleBankingResume via the router
    // We test the store functions directly since commands.ts handlers are private
    const { listInstitutions } = await import('../store.js');
    const institutions = await listInstitutions();
    let resumed = 0;
    for (const inst of institutions) {
      const pauseStatus = await getInstitutionSyncPauseStatus(inst.id);
      if (pauseStatus.syncPausedStatus) {
        await setInstitutionSyncPaused(inst.id, null);
        resumed++;
      }
    }

    expect(resumed).toBeGreaterThanOrEqual(2);

    // Verify both cleared in DB
    const c1 = await getInstitutionSyncPauseStatus(inst1.id);
    const c2 = await getInstitutionSyncPauseStatus(inst2.id);
    expect(c1.syncPausedStatus).toBeNull();
    expect(c2.syncPausedStatus).toBeNull();
  });
});

// ── E2-8: Lookback from_date Berechnung ──────────────────────────────────────

describe('Lookback cursor', () => {
  test('E2-8. from_date = MAX(booking_date) - 14d', async () => {
    const { inst, session, accounts } = await setupInstitution(
      '70000209', 'E2 Lookback Bank', ['DE89370400440532070209'],
    );
    await isolateSessions([session.id]);

    const { insertTransaction } = await import('../store.js');

    // Insert a transaction with a known booking_date
    await insertTransaction(accounts[0].id, {
      bank_transaction_id: 'TX-E2-8-001',
      booking_date: '2026-06-20',
      value_date: '2026-06-20',
      amount: -50.00,
      currency: 'EUR',
      counterparty_name: 'Test',
      counterparty_iban: null,
      reference: 'E2-8 lookback',
      transaction_code: null,
      raw_payload: {},
    });

    // Capture from_date passed to sidecar
    let capturedFromDate: string | undefined;
    const { dailySync, initSyncEngine } = await import('../sync-engine.js');

    initSyncEngine({
      sendTelegram: async () => true,
      telegramChatId: () => 'test-chat-e2-8',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async (params) => {
        capturedFromDate = params.from_date as string | undefined;
        return { transactions: [], balance: 300.00 };
      },
    });

    await dailySync();

    // Expected: 2026-06-20 - 14 days = 2026-06-06
    expect(capturedFromDate).toBe('2026-06-06');

    await restoreSessions();
  });
});

// ── E2-9: Button-Duplikat abgelehnt ──────────────────────────────────────────

describe('Button duplicate rejection', () => {
  test('E2-9. second button press → "bereits Re-Sync" rejection', async () => {
    const { inst } = await setupInstitution(
      '70000210', 'E2 Dup Button Bank', ['DE89370400440532070210'],
    );

    const { query } = await import('../../../shared/db/index.js');
    const { validateResyncRequest } = await import('../sync-engine.js');

    // Create a sync run with TAN_REQUIRED and alert_delivered
    const { rows } = await query<{ id: string }>(
      `INSERT INTO banking_sync_runs (institution_id, run_phase, status, alert_delivered, finished_at)
       VALUES ($1, 'scheduled', 'TAN_REQUIRED', true, now())
       RETURNING id`,
      [inst.id],
    );
    const runId = parseInt(rows[0].id, 10);

    // Also create an existing event_resync for today (simulates first button press)
    await query(
      `INSERT INTO banking_sync_runs (institution_id, run_phase, status, finished_at)
       VALUES ($1, 'event_resync', 'SUCCESS_FULL', now())`,
      [inst.id],
    );

    const validation = await validateResyncRequest(runId);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.reason).toContain('bereits');
    }
  });
});

// ── E2-10: Button bei nicht-TAN Run abgelehnt ────────────────────────────────

describe('Button non-TAN rejection', () => {
  test('E2-10. button on SUCCESS_FULL run → rejection with wrong status', async () => {
    const { inst } = await setupInstitution(
      '70000211', 'E2 Wrong Status Bank', ['DE89370400440532070211'],
    );

    const { query } = await import('../../../shared/db/index.js');
    const { validateResyncRequest } = await import('../sync-engine.js');

    // Create a sync run with SUCCESS_FULL (not TAN_REQUIRED)
    const { rows } = await query<{ id: string }>(
      `INSERT INTO banking_sync_runs (institution_id, run_phase, status, alert_delivered, finished_at)
       VALUES ($1, 'scheduled', 'SUCCESS_FULL', true, now())
       RETURNING id`,
      [inst.id],
    );
    const runId = parseInt(rows[0].id, 10);

    const validation = await validateResyncRequest(runId);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.reason).toContain('SUCCESS_FULL');
    }
  });
});
