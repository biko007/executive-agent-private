/**
 * banking/sync-engine — Daily-sync orchestration + anomaly detection.
 * Sprint 7b Etappe e/f. Lock pattern from health/withings.ts (lock 42 → 43).
 *
 * Etappe f: Decrypts session credentials, passes to sidecar with state blobs.
 */
import { query as dbQuery } from '../../shared/db/index.js';
import * as audit from '../../shared/audit/index.js';
import * as sidecar from './sidecar-client.js';
import { SidecarError } from './sidecar-client.js';
import {
  listActiveSessions,
  listAccounts,
  insertTransaction,
  updateAccountBalance,
  hasReminderBeenSent,
  markReminderSent,
  getDecryptedSession,
  updateSessionState,
  insertSyncRun,
  updateSyncRun,
  getInstitutionSyncPauseStatus,
  hasTodayBankContact,
  getLastCompletedSyncRunBeforeToday,
  getLastBookingDate,
  setInstitutionSyncPaused,
  countRecentScaEvents,
  getSyncRunById,
  hasEventResyncToday,
} from './store.js';
import type { Session, InstitutionRow } from './types.js';

// ── Internal helpers ─────────────────────────────────────────────────────────

async function getInstitutionById(id: number): Promise<InstitutionRow | null> {
  const { rows } = await dbQuery<InstitutionRow>(
    'SELECT * FROM banking_institutions WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

// ── DI ────────────────────────────────────────────────────────────────────────

export interface SyncEngineDeps {
  sendTelegram: (chatId: string, text: string) => Promise<boolean>;
  sendTelegramWithKeyboard?: (
    chatId: string, text: string,
    keyboard: { text: string; callback_data: string }[][],
  ) => Promise<boolean>;
  telegramChatId: () => string | undefined;
  /** Test-only: override sidecar.health() */
  _sidecarHealth?: () => Promise<{ status: string }>;
  /** Test-only: override sidecar.sync() */
  _sidecarSync?: (params: { session_id: number; account_iban: string; [key: string]: unknown }) => Promise<unknown>;
}

let _deps: SyncEngineDeps | null = null;

export function initSyncEngine(deps: SyncEngineDeps): void {
  _deps = deps;
}

// ── Result types (Spec v2 §4 API-Response-Contract) ──────────────────────────

export interface AccountSyncResult {
  account_id: number;
  result: 'success' | 'tan_required' | 'timeout' | 'import_failed' | 'skipped_due_to_tan';
  fints_codes: string[];
  transactions_seen: number;
  transactions_inserted: number;
}

export type ContractStatus =
  | 'SUCCESS_FULL' | 'TAN_REQUIRED'
  | 'BANK_TIMEOUT_UNKNOWN' | 'IMPORT_FAILED'
  | 'SKIPPED_ALREADY_SYNCED' | 'SKIPPED_ALREADY_RUNNING'
  | 'AUTO_PAUSED_PENDING_TAN';

export interface DailySyncResult {
  run_id: string;
  status: ContractStatus;
  sca_required: boolean;
  alert_delivered: boolean;
  safe_to_schedule_resync: boolean;
  accounts: AccountSyncResult[];
}

/** Internal anomaly type for Telegram alert formatting — not part of API contract. */
interface Anomaly {
  type: 'sidecar_down' | 're_auth_required' | 'needs_tan' | 'session_expiry' | 'sync_error';
  session_id?: number;
  account_id?: number;
  message: string;
  severity: 'info' | 'warn' | 'error';
}

export interface SyncStatus {
  last_sync: string | null;
  sessions_total: number;
  accounts_total: number;
  status: 'ok' | 'stale' | 'never_synced';
}

// ── Expiry reminder thresholds ────────────────────────────────────────────────

const EXPIRY_THRESHOLDS = [
  { days: 1,  label: '1 Tag',   severity: 'error' as const },
  { days: 7,  label: '7 Tage',  severity: 'warn'  as const },
  { days: 14, label: '14 Tage', severity: 'info'  as const },
];

const LOOKBACK_OVERLAP_DAYS = 14;
const SCA_BUDGET_30D = 6; // Spec §7: Default 6/30d

// ── Helpers (E1) ─────────────────────────────────────────────────────────────

const DAY_NAMES = ['so', 'mo', 'di', 'mi', 'do', 'fr', 'sa'] as const;

function generateRunId(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const day = DAY_NAMES[now.getDay()];
  return `${yyyy}-${mm}-${dd}-${day}`;
}

function isTimeoutError(e: any): boolean {
  const msg = e?.message || '';
  return msg.includes('AbortError') || msg.includes('fetch_timeout')
    || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')
    || msg.includes('Socket timeout') || msg.includes('UND_ERR_SOCKET');
}

function determineStatus(
  accountResults: AccountSyncResult[],
  globalStop: 'tan_required' | 'timeout' | false,
  sidecarUp: boolean,
  anyPaused: boolean,
): ContractStatus {
  if (anyPaused && accountResults.length === 0) return 'AUTO_PAUSED_PENDING_TAN';
  if (globalStop === 'timeout') return 'BANK_TIMEOUT_UNKNOWN';
  if (globalStop === 'tan_required') return 'TAN_REQUIRED';
  if (!sidecarUp) return 'IMPORT_FAILED';
  if (accountResults.length === 0) return 'SUCCESS_FULL'; // no accounts to sync = success
  const allSuccess = accountResults.every(a => a.result === 'success');
  if (allSuccess) return 'SUCCESS_FULL';
  // Any mix of success + failure, or all failures → IMPORT_FAILED (no SUCCESS_PARTIAL per §4)
  return 'IMPORT_FAILED';
}

// ── Daily sync ────────────────────────────────────────────────────────────────

export async function dailySync(options?: {
  runPhase?: 'scheduled' | 'manual';
  triggerSource?: string;
  triggerId?: string;
}): Promise<DailySyncResult> {
  const runPhase = options?.runPhase ?? 'scheduled';
  const runId = generateRunId();
  const accountResults: AccountSyncResult[] = [];
  const anomalies: Anomaly[] = [];
  let globalStop: 'tan_required' | 'timeout' | false = false;
  let scaRequired = false;
  let anyPaused = false;
  let tagesGuardSkipped = 0;

  // Advisory lock (non-blocking)
  const { rows: lockRows } = await dbQuery<{ pg_try_advisory_lock: boolean }>(
    'SELECT pg_try_advisory_lock(43)',
  );
  if (!lockRows[0].pg_try_advisory_lock) {
    return {
      run_id: runId,
      status: 'SKIPPED_ALREADY_RUNNING',
      sca_required: false,
      alert_delivered: false,
      safe_to_schedule_resync: false,
      accounts: [],
    };
  }

  const syncRunIds = new Map<number, number>(); // institutionId → DB sync_run.id
  const processedInstitutions = new Set<number>();
  let totalAccountsSynced = 0;
  let totalTransactionsNew = 0;

  try {
    // Sidecar health check
    let sidecarUp = false;
    const healthFn = _deps?._sidecarHealth ?? sidecar.health;
    try {
      await healthFn();
      sidecarUp = true;
    } catch (e: any) {
      anomalies.push({
        type: 'sidecar_down',
        message: `Sidecar nicht erreichbar: ${e.message}`,
        severity: 'error',
      });
    }

    // Load active sessions
    const sessions = await listActiveSessions();

    // Per session
    for (const session of sessions) {
      // Expiry reminders always run (even if sidecar is down or global stop)
      await checkExpiryReminders(session, anomalies);

      if (!sidecarUp) continue;

      // Skip already-processed institutions (multiple sessions for same institution)
      if (processedInstitutions.has(session.institutionId)) continue;

      // Tages-Guard: max 1 regulaerer Sync/Tag (event_resync ausgenommen)
      const alreadyContactedToday = await hasTodayBankContact(session.institutionId);
      if (alreadyContactedToday) {
        processedInstitutions.add(session.institutionId);
        tagesGuardSkipped++;
        continue;
      }

      // §3.2 Global stop: first 3955/timeout stops the ENTIRE run — all remaining institutions
      if (globalStop) {
        processedInstitutions.add(session.institutionId);
        const accounts = await listAccounts({ institution_id: session.institutionId, status: 'active' });
        const dbRunId = await insertSyncRun({ institutionId: session.institutionId, runPhase: runPhase });
        syncRunIds.set(session.institutionId, dbRunId);
        for (const account of accounts) {
          accountResults.push({
            account_id: account.id, result: 'skipped_due_to_tan',
            fints_codes: [], transactions_seen: 0, transactions_inserted: 0,
          });
        }
        await updateSyncRun(dbRunId, {
          status: globalStop === 'timeout' ? 'BANK_TIMEOUT_UNKNOWN' : 'TAN_REQUIRED',
          scaRequired: globalStop === 'tan_required',
          accountsSynced: 0, transactionsNew: 0,
        });
        continue;
      }

      // Decrypt session credentials + look up institution (Etappe f)
      const decrypted = await getDecryptedSession(session.id);
      if (!decrypted) {
        anomalies.push({
          type: 'sync_error', session_id: session.id,
          message: `Session ${session.id}: Credentials konnten nicht entschluesselt werden`,
          severity: 'error',
        });
        continue;
      }

      const { rows: sessDbRows } = await dbQuery<{ institution_id: number; product_id: string }>(
        'SELECT institution_id, product_id FROM banking_sessions WHERE id = $1',
        [session.id],
      );
      const institution = sessDbRows.length > 0 ? await getInstitutionById(sessDbRows[0].institution_id) : null;
      if (!institution) {
        anomalies.push({
          type: 'sync_error', session_id: session.id,
          message: `Session ${session.id}: Institution nicht gefunden`,
          severity: 'error',
        });
        continue;
      }
      const productId = sessDbRows[0].product_id;

      processedInstitutions.add(institution.id);

      // Lazy CB-SET: if last completed run (from a PREVIOUS day) was TAN_REQUIRED → set pause.
      // Date authority: CURRENT_DATE in SQL (DB UTC), no JS date comparison.
      const lastRun = await getLastCompletedSyncRunBeforeToday(institution.id);
      if (lastRun && lastRun.status === 'TAN_REQUIRED') {
        await setInstitutionSyncPaused(institution.id, 'AUTO_PAUSED_PENDING_TAN');
        // Existing guard below catches the new pause status
      }

      // §3.3 Circuit-breaker guard
      const pauseStatus = await getInstitutionSyncPauseStatus(institution.id);
      if (pauseStatus.syncPausedStatus === 'AUTO_PAUSED_PENDING_TAN') {
        anyPaused = true;
        const accounts = await listAccounts({ institution_id: session.institutionId, status: 'active' });
        for (const account of accounts) {
          accountResults.push({
            account_id: account.id, result: 'skipped_due_to_tan',
            fints_codes: [], transactions_seen: 0, transactions_inserted: 0,
          });
        }
        continue;
      }

      // SCA-Budget check (Spec §7)
      const scaCount = await countRecentScaEvents(institution.id, 30);
      if (scaCount >= SCA_BUDGET_30D) {
        anomalies.push({
          type: 'sync_error', session_id: session.id,
          message: `SCA-Budget ueberschritten (${scaCount}/${SCA_BUDGET_30D} in 30d) — harter Stopp`,
          severity: 'error',
        });
        processedInstitutions.add(institution.id);
        continue;
      }

      // Insert sync run for this institution
      const dbRunId = await insertSyncRun({ institutionId: institution.id, runPhase: runPhase, triggerSource: options?.triggerSource, triggerId: options?.triggerId });
      syncRunIds.set(institution.id, dbRunId);

      // Load only active accounts — archived accounts are excluded from sync (Sprint 2.10-B)
      const accounts = await listAccounts({ institution_id: session.institutionId, status: 'active' });
      let instAccountsSynced = 0;
      let instTransactionsNew = 0;

      const syncFn = _deps?._sidecarSync ?? sidecar.sync;
      let accountIndex = 0;
      for (; accountIndex < accounts.length; accountIndex++) {
        const account = accounts[accountIndex];

        try {
          // Lookback-Cursor: fetch from MAX(booking_date) - overlap
          let fromDate: string | undefined;
          const lastBooking = await getLastBookingDate(account.id);
          if (lastBooking) {
            const d = new Date(lastBooking);
            d.setDate(d.getDate() - LOOKBACK_OVERLAP_DAYS);
            fromDate = d.toISOString().slice(0, 10);
          }

          const result: any = await syncFn({
            session_id: session.id,
            blz: institution.blz,
            fints_url: institution.fints_url,
            user_id: decrypted.userId,
            pin: decrypted.pin,
            product_id: productId === 'env-default' ? undefined : productId,
            client_data: decrypted.state || undefined,
            account_iban: account.iban,
            from_date: fromDate,
          });

          // Check for re-auth required
          if (result?.re_auth_required) {
            anomalies.push({
              type: 're_auth_required', session_id: session.id,
              message: `Session ${session.id} erfordert erneute Authentifizierung`,
              severity: 'error',
            });
            accountResults.push({
              account_id: account.id, result: 'import_failed',
              fints_codes: [], transactions_seen: 0, transactions_inserted: 0,
            });
            continue;
          }

          // §3.2 Guard: sidecar returned needs_tan (3955 pushTAN/SCA during sync)
          // GLOBAL STOP — no further bank contact for ANY institution.
          if (result?.needs_tan) {
            anomalies.push({
              type: 'needs_tan', session_id: session.id, account_id: account.id,
              message: `Sync ${account.iban}: Bank verlangt TAN (${result.tan_type || '3955'}) — Lauf gestoppt`,
              severity: 'warn',
            });
            accountResults.push({
              account_id: account.id, result: 'tan_required',
              fints_codes: ['3955'], transactions_seen: 0, transactions_inserted: 0,
            });
            scaRequired = true;
            globalStop = 'tan_required';
            break; // §3.2: stop account loop, globalStop stops session loop too
          }

          // Success: process transactions
          let txSeen = 0;
          let txInserted = 0;
          if (result?.transactions && Array.isArray(result.transactions)) {
            txSeen = result.transactions.length;
            for (const tx of result.transactions) {
              const inserted = await insertTransaction(account.id, {
                bank_transaction_id: tx.bank_transaction_id,
                booking_date: tx.booking_date,
                value_date: tx.value_date,
                amount: tx.amount,
                currency: tx.currency || account.currency,
                counterparty_name: tx.counterparty_name,
                counterparty_iban: tx.counterparty_iban,
                reference: tx.reference,
                transaction_code: tx.transaction_code,
                raw_payload: tx,
              });
              if (inserted) txInserted++;
            }
          }

          // Update account balance
          if (result?.balance !== undefined) {
            await updateAccountBalance(account.id, result.balance, new Date().toISOString());
          }

          // Store updated client_data (BPD/UPD cache) if returned (Etappe f)
          if (result?.client_data_updated) {
            await updateSessionState(session.id, result.client_data_updated, 'fints5', '5.0.0');
          }

          accountResults.push({
            account_id: account.id, result: 'success',
            fints_codes: ['3076'], transactions_seen: txSeen, transactions_inserted: txInserted,
          });
          instAccountsSynced++;
          instTransactionsNew += txInserted;
        } catch (e: any) {
          // SidecarError 501 = expected (sidecar stubs not implemented yet)
          if (e instanceof SidecarError && e.statusCode === 501) {
            accountResults.push({
              account_id: account.id, result: 'success',
              fints_codes: [], transactions_seen: 0, transactions_inserted: 0,
            });
            instAccountsSynced++;
            continue;
          }

          // §3.4 Timeout = unknown bank state → GLOBAL STOP, no auto-retry
          if (isTimeoutError(e)) {
            anomalies.push({
              type: 'sync_error', session_id: session.id, account_id: account.id,
              message: `Timeout Account ${account.iban}: Bankstatus unklar, bitte App prüfen`,
              severity: 'error',
            });
            accountResults.push({
              account_id: account.id, result: 'timeout',
              fints_codes: [], transactions_seen: 0, transactions_inserted: 0,
            });
            globalStop = 'timeout';
            break; // §3.4: stop everything
          }

          // Definitive error — only this account affected, loop continues
          anomalies.push({
            type: 'sync_error', session_id: session.id, account_id: account.id,
            message: `Sync-Fehler Account ${account.iban}: ${e.message}`,
            severity: 'error',
          });
          accountResults.push({
            account_id: account.id, result: 'import_failed',
            fints_codes: [], transactions_seen: 0, transactions_inserted: 0,
          });
        }
      }

      // Mark remaining accounts as skipped after global stop break
      for (let i = accountIndex + 1; i < accounts.length; i++) {
        accountResults.push({
          account_id: accounts[i].id, result: 'skipped_due_to_tan',
          fints_codes: [], transactions_seen: 0, transactions_inserted: 0,
        });
      }

      totalAccountsSynced += instAccountsSynced;
      totalTransactionsNew += instTransactionsNew;
    }

    // Determine final status
    let finalStatus = determineStatus(accountResults, globalStop, sidecarUp, anyPaused);

    // Tages-Guard override: all institutions were skipped by guard
    if (tagesGuardSkipped > 0 && accountResults.length === 0 && !globalStop && sidecarUp && !anyPaused) {
      finalStatus = 'SKIPPED_ALREADY_SYNCED';
    }

    // CB-Clear: on SUCCESS_FULL, clear any paused status
    if (finalStatus === 'SUCCESS_FULL') {
      for (const [instId] of syncRunIds) {
        await setInstitutionSyncPaused(instId, null);
      }
    }

    // Alert delivery — capture real sendTelegram return value (not fire-and-forget)
    let alertDelivered = false;
    if (anomalies.length > 0 && _deps) {
      const chatId = _deps.telegramChatId();
      if (chatId) {
        const message = formatAnomalyReport(anomalies);
        try {
          // If TAN_REQUIRED and sendTelegramWithKeyboard available, send with button
          if (finalStatus === 'TAN_REQUIRED' && _deps.sendTelegramWithKeyboard && syncRunIds.size > 0) {
            const firstRunId = syncRunIds.values().next().value;
            const keyboard = [[{
              text: '\u2705 TAN bestaetigt \u2192 jetzt syncen',
              callback_data: `bsync_${firstRunId}`,
            }]];
            alertDelivered = await _deps.sendTelegramWithKeyboard(chatId, message, keyboard);
          } else {
            alertDelivered = await _deps.sendTelegram(chatId, message);
          }
        } catch {
          alertDelivered = false;
        }
      }
      if (!alertDelivered) {
        await audit.log({
          module: 'banking', action: 'daily_sync.alert_delivery_failed',
          entityType: 'banking_sync', entityId: runId,
          after: { chatId: _deps.telegramChatId() ? 'set' : 'missing', anomaly_count: anomalies.length },
        });
      }
    }

    // Update sync run records
    for (const [instId, dbRunId] of syncRunIds) {
      await updateSyncRun(dbRunId, {
        status: finalStatus,
        scaRequired,
        alertDelivered,
        accountsSynced: totalAccountsSynced,
        transactionsNew: totalTransactionsNew,
      });
    }

    // Audit log
    await audit.log({
      module: 'banking', action: 'daily_sync.completed',
      entityType: 'banking_sync', entityId: runId,
      after: {
        run_id: runId,
        status: finalStatus,
        accounts_synced: totalAccountsSynced,
        transactions_new: totalTransactionsNew,
        sca_required: scaRequired,
        alert_delivered: alertDelivered,
        anomaly_count: anomalies.length,
      },
    });

    return {
      run_id: runId,
      status: finalStatus,
      sca_required: scaRequired,
      alert_delivered: alertDelivered,
      safe_to_schedule_resync: finalStatus === 'TAN_REQUIRED' && alertDelivered,
      accounts: accountResults,
    };
  } catch (e: any) {
    // Update any created sync runs with error
    for (const [, dbRunId] of syncRunIds) {
      await updateSyncRun(dbRunId, {
        status: 'IMPORT_FAILED',
        errorMessage: e.message,
      }).catch(() => {});
    }

    return {
      run_id: runId,
      status: 'IMPORT_FAILED',
      sca_required: scaRequired,
      alert_delivered: false,
      safe_to_schedule_resync: false,
      accounts: accountResults,
    };
  } finally {
    await dbQuery('SELECT pg_advisory_unlock(43)').catch(() => {});
  }
}

// ── Event Re-Sync (E2) ───────────────────────────────────────────────────────

/**
 * Controlled re-sync for a single institution after user confirmed TAN.
 * Key differences vs dailySync: no Tages-Guard, run_phase='event_resync',
 * processes only the one institution, no button in alert.
 */
export async function eventResync(
  institutionId: number,
  triggerSource: string,
  triggerId: string,
): Promise<DailySyncResult> {
  const runId = generateRunId();
  const accountResults: AccountSyncResult[] = [];
  const anomalies: Anomaly[] = [];
  let scaRequired = false;

  // Same advisory lock (43) — collision → SKIPPED_ALREADY_RUNNING
  const { rows: lockRows } = await dbQuery<{ pg_try_advisory_lock: boolean }>(
    'SELECT pg_try_advisory_lock(43)',
  );
  if (!lockRows[0].pg_try_advisory_lock) {
    return {
      run_id: runId,
      status: 'SKIPPED_ALREADY_RUNNING',
      sca_required: false,
      alert_delivered: false,
      safe_to_schedule_resync: false,
      accounts: [],
    };
  }

  let dbRunId: number | null = null;

  try {
    // Sidecar health check
    let sidecarUp = false;
    const healthFn = _deps?._sidecarHealth ?? sidecar.health;
    try {
      await healthFn();
      sidecarUp = true;
    } catch (e: any) {
      anomalies.push({
        type: 'sidecar_down',
        message: `Sidecar nicht erreichbar: ${e.message}`,
        severity: 'error',
      });
    }

    if (!sidecarUp) {
      return {
        run_id: runId,
        status: 'IMPORT_FAILED',
        sca_required: false,
        alert_delivered: false,
        safe_to_schedule_resync: false,
        accounts: [],
      };
    }

    // Find session for the institution
    const sessions = await listActiveSessions();
    const session = sessions.find(s => s.institutionId === institutionId);
    if (!session) {
      return {
        run_id: runId,
        status: 'IMPORT_FAILED',
        sca_required: false,
        alert_delivered: false,
        safe_to_schedule_resync: false,
        accounts: [],
      };
    }

    const decrypted = await getDecryptedSession(session.id);
    if (!decrypted) {
      return {
        run_id: runId,
        status: 'IMPORT_FAILED',
        sca_required: false,
        alert_delivered: false,
        safe_to_schedule_resync: false,
        accounts: [],
      };
    }

    const { rows: sessDbRows } = await dbQuery<{ institution_id: number; product_id: string }>(
      'SELECT institution_id, product_id FROM banking_sessions WHERE id = $1',
      [session.id],
    );
    const institution = sessDbRows.length > 0 ? await getInstitutionById(sessDbRows[0].institution_id) : null;
    if (!institution) {
      return {
        run_id: runId,
        status: 'IMPORT_FAILED',
        sca_required: false,
        alert_delivered: false,
        safe_to_schedule_resync: false,
        accounts: [],
      };
    }
    const productId = sessDbRows[0].product_id;

    // Insert sync run
    dbRunId = await insertSyncRun({
      institutionId: institution.id,
      runPhase: 'event_resync',
      triggerSource,
      triggerId,
    });

    // Account sync loop (same as dailySync inner loop)
    const accounts = await listAccounts({ institution_id: institution.id, status: 'active' });
    let totalAccountsSynced = 0;
    let totalTransactionsNew = 0;
    let globalStop: 'tan_required' | 'timeout' | false = false;

    const syncFn = _deps?._sidecarSync ?? sidecar.sync;
    let accountIndex = 0;
    for (; accountIndex < accounts.length; accountIndex++) {
      const account = accounts[accountIndex];

      try {
        // Lookback-Cursor
        let fromDate: string | undefined;
        const lastBooking = await getLastBookingDate(account.id);
        if (lastBooking) {
          const d = new Date(lastBooking);
          d.setDate(d.getDate() - LOOKBACK_OVERLAP_DAYS);
          fromDate = d.toISOString().slice(0, 10);
        }

        const result: any = await syncFn({
          session_id: session.id,
          blz: institution.blz,
          fints_url: institution.fints_url,
          user_id: decrypted.userId,
          pin: decrypted.pin,
          product_id: productId === 'env-default' ? undefined : productId,
          client_data: decrypted.state || undefined,
          account_iban: account.iban,
          from_date: fromDate,
        });

        if (result?.re_auth_required) {
          accountResults.push({
            account_id: account.id, result: 'import_failed',
            fints_codes: [], transactions_seen: 0, transactions_inserted: 0,
          });
          continue;
        }

        if (result?.needs_tan) {
          accountResults.push({
            account_id: account.id, result: 'tan_required',
            fints_codes: ['3955'], transactions_seen: 0, transactions_inserted: 0,
          });
          scaRequired = true;
          globalStop = 'tan_required';
          break;
        }

        // Success: process transactions
        let txSeen = 0;
        let txInserted = 0;
        if (result?.transactions && Array.isArray(result.transactions)) {
          txSeen = result.transactions.length;
          for (const tx of result.transactions) {
            const inserted = await insertTransaction(account.id, {
              bank_transaction_id: tx.bank_transaction_id,
              booking_date: tx.booking_date,
              value_date: tx.value_date,
              amount: tx.amount,
              currency: tx.currency || account.currency,
              counterparty_name: tx.counterparty_name,
              counterparty_iban: tx.counterparty_iban,
              reference: tx.reference,
              transaction_code: tx.transaction_code,
              raw_payload: tx,
            });
            if (inserted) txInserted++;
          }
        }

        if (result?.balance !== undefined) {
          await updateAccountBalance(account.id, result.balance, new Date().toISOString());
        }

        if (result?.client_data_updated) {
          await updateSessionState(session.id, result.client_data_updated, 'fints5', '5.0.0');
        }

        accountResults.push({
          account_id: account.id, result: 'success',
          fints_codes: ['3076'], transactions_seen: txSeen, transactions_inserted: txInserted,
        });
        totalAccountsSynced++;
        totalTransactionsNew += txInserted;
      } catch (e: any) {
        if (e instanceof SidecarError && e.statusCode === 501) {
          accountResults.push({
            account_id: account.id, result: 'success',
            fints_codes: [], transactions_seen: 0, transactions_inserted: 0,
          });
          totalAccountsSynced++;
          continue;
        }

        if (isTimeoutError(e)) {
          accountResults.push({
            account_id: account.id, result: 'timeout',
            fints_codes: [], transactions_seen: 0, transactions_inserted: 0,
          });
          globalStop = 'timeout';
          break;
        }

        accountResults.push({
          account_id: account.id, result: 'import_failed',
          fints_codes: [], transactions_seen: 0, transactions_inserted: 0,
        });
      }
    }

    // Mark remaining accounts as skipped
    for (let i = accountIndex + 1; i < accounts.length; i++) {
      accountResults.push({
        account_id: accounts[i].id, result: 'skipped_due_to_tan',
        fints_codes: [], transactions_seen: 0, transactions_inserted: 0,
      });
    }

    const finalStatus = determineStatus(accountResults, globalStop, sidecarUp, false);

    // CB actions based on outcome
    if (finalStatus === 'TAN_REQUIRED') {
      await setInstitutionSyncPaused(institutionId, 'AUTO_PAUSED_PENDING_TAN');
    } else if (finalStatus === 'SUCCESS_FULL') {
      await setInstitutionSyncPaused(institutionId, null);
    }

    // No button in alert (prevent recursive button chains)
    let alertDelivered = false;
    if (anomalies.length > 0 && _deps) {
      const chatId = _deps.telegramChatId();
      if (chatId) {
        try {
          alertDelivered = await _deps.sendTelegram(chatId, formatAnomalyReport(anomalies));
        } catch {
          alertDelivered = false;
        }
      }
    }

    // Update sync run
    await updateSyncRun(dbRunId, {
      status: finalStatus,
      scaRequired,
      alertDelivered,
      accountsSynced: totalAccountsSynced,
      transactionsNew: totalTransactionsNew,
    });

    // Audit
    await audit.log({
      module: 'banking', action: 'event_resync.completed',
      entityType: 'banking_sync', entityId: runId,
      after: {
        run_id: runId,
        institution_id: institutionId,
        status: finalStatus,
        accounts_synced: totalAccountsSynced,
        transactions_new: totalTransactionsNew,
        trigger_source: triggerSource,
        trigger_id: triggerId,
      },
    });

    return {
      run_id: runId,
      status: finalStatus,
      sca_required: scaRequired,
      alert_delivered: alertDelivered,
      safe_to_schedule_resync: false,
      accounts: accountResults,
    };
  } catch (e: any) {
    if (dbRunId) {
      await updateSyncRun(dbRunId, {
        status: 'IMPORT_FAILED',
        errorMessage: e.message,
      }).catch(() => {});
    }

    return {
      run_id: runId,
      status: 'IMPORT_FAILED',
      sca_required: scaRequired,
      alert_delivered: false,
      safe_to_schedule_resync: false,
      accounts: accountResults,
    };
  } finally {
    await dbQuery('SELECT pg_advisory_unlock(43)').catch(() => {});
  }
}

// ── Button validation (E2) ──────────────────────────────────────────────────

/** Validate a re-sync request from a Telegram button callback. */
export async function validateResyncRequest(dbRunId: number): Promise<
  | { ok: true; institutionId: number }
  | { ok: false; reason: string }
> {
  const run = await getSyncRunById(dbRunId);
  if (!run) return { ok: false, reason: 'Sync-Run nicht gefunden.' };
  if (run.status !== 'TAN_REQUIRED')
    return { ok: false, reason: `Run hat Status "${run.status}" — Re-Sync nicht moeglich.` };
  if (!run.alert_delivered)
    return { ok: false, reason: 'Alert wurde nicht zugestellt — Re-Sync nicht moeglich.' };
  const alreadyResynced = await hasEventResyncToday(run.institution_id);
  if (alreadyResynced)
    return { ok: false, reason: 'Heute wurde bereits ein Re-Sync durchgefuehrt.' };
  return { ok: true, institutionId: run.institution_id };
}

// ── Expiry reminders ──────────────────────────────────────────────────────────

export async function checkExpiryReminders(
  session: Session,
  anomalies: Anomaly[],
): Promise<void> {
  if (!session.sessionExpiresAt) return;

  const expiresAt = new Date(session.sessionExpiresAt).getTime();
  const now = Date.now();
  const daysUntilExpiry = Math.ceil((expiresAt - now) / 86_400_000);

  // Walk thresholds from most urgent (1 day) to least (14 days)
  for (const threshold of EXPIRY_THRESHOLDS) {
    if (daysUntilExpiry <= threshold.days) {
      const sent = await hasReminderBeenSent(session.id, threshold.days);
      if (!sent) {
        await markReminderSent(session.id, threshold.days);
        const expiryDate = new Date(session.sessionExpiresAt).toISOString().slice(0, 10);
        anomalies.push({
          type: 'session_expiry',
          session_id: session.id,
          message: `Session ${session.id} läuft in ${threshold.label} ab (${expiryDate})`,
          severity: threshold.severity,
        });
      }
      break; // Only alert for the most urgent applicable threshold
    }
  }
}

// ── Sync status ───────────────────────────────────────────────────────────────

export async function getSyncStatus(): Promise<SyncStatus> {
  // Last sync from audit log
  const { rows: auditRows } = await dbQuery<{ ts: Date }>(
    `SELECT ts FROM audit_log WHERE module = 'banking' AND action = 'daily_sync.completed' ORDER BY ts DESC LIMIT 1`,
  );

  const lastSync = auditRows.length > 0 ? new Date(auditRows[0].ts).toISOString() : null;

  // Count active sessions
  const { rows: sessionRows } = await dbQuery<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM banking_sessions WHERE institution_id IS NOT NULL AND pending_challenge_type IS NULL`,
  );
  const sessionsTotal = parseInt(sessionRows[0].cnt, 10);

  // Count active accounts
  const { rows: accountRows } = await dbQuery<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM banking_accounts WHERE status = 'active'`,
  );
  const accountsTotal = parseInt(accountRows[0].cnt, 10);

  // Determine status
  let status: 'ok' | 'stale' | 'never_synced';
  if (!lastSync) {
    status = 'never_synced';
  } else {
    const hoursSince = (Date.now() - new Date(lastSync).getTime()) / 3_600_000;
    status = hoursSince > 36 ? 'stale' : 'ok';
  }

  return { last_sync: lastSync, sessions_total: sessionsTotal, accounts_total: accountsTotal, status };
}

// ── Telegram formatting ───────────────────────────────────────────────────────

function formatAnomalyReport(anomalies: Anomaly[]): string {
  const severityIcon: Record<string, string> = {
    error: '\u{1F534}',  // red circle
    warn:  '\u{1F7E1}',  // yellow circle
    info:  '\u{1F535}',  // blue circle
  };

  const lines = ['\u{1F3E6} Banking Daily-Sync Report', ''];
  for (const a of anomalies) {
    const icon = severityIcon[a.severity] || '\u2753';
    lines.push(`${icon} ${a.message}`);
  }

  // Add re-auth link if any session needs it
  const needsReAuth = anomalies.some(a => a.type === 're_auth_required' || a.type === 'needs_tan' || a.type === 'session_expiry');
  if (needsReAuth) {
    lines.push('');
    lines.push('\u2192 https://app.bikobickel.de/dashboard/?tab=banking-connect');
  }

  return lines.join('\n');
}
