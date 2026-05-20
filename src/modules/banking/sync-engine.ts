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

// ── Result types ──────────────────────────────────────────────────────────────

export interface DailySyncResult {
  status: 'ok' | 'error' | 'locked';
  sessions_checked: number;
  accounts_synced: number;
  transactions_new: number;
  anomalies: Anomaly[];
  error?: string;
  started_at: string;
  finished_at: string;
}

export interface Anomaly {
  type: 'sidecar_down' | 're_auth_required' | 'session_expiry' | 'partial_sync' | 'sync_error';
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

// ── Daily sync ────────────────────────────────────────────────────────────────

export async function dailySync(): Promise<DailySyncResult> {
  const startedAt = new Date().toISOString();
  const anomalies: Anomaly[] = [];

  // Advisory lock (non-blocking)
  const { rows: lockRows } = await dbQuery<{ pg_try_advisory_lock: boolean }>(
    'SELECT pg_try_advisory_lock(43)',
  );
  if (!lockRows[0].pg_try_advisory_lock) {
    return {
      status: 'locked',
      sessions_checked: 0,
      accounts_synced: 0,
      transactions_new: 0,
      anomalies: [],
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  }

  let sessionsChecked = 0;
  let accountsSynced = 0;
  let transactionsNew = 0;

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
    sessionsChecked = sessions.length;

    // Per session
    for (const session of sessions) {
      // Expiry reminders always run (even if sidecar is down)
      await checkExpiryReminders(session, anomalies);

      if (!sidecarUp) continue;

      // Decrypt session credentials + look up institution (Etappe f)
      const decrypted = await getDecryptedSession(session.id);
      if (!decrypted) {
        anomalies.push({
          type: 'sync_error',
          session_id: session.id,
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
          type: 'sync_error',
          session_id: session.id,
          message: `Session ${session.id}: Institution nicht gefunden`,
          severity: 'error',
        });
        continue;
      }
      const productId = sessDbRows[0].product_id;

      // Load only active accounts — archived accounts are excluded from sync (Sprint 2.10-B)
      const accounts = await listAccounts({ institution_id: session.institutionId, status: 'active' });
      let okCount = 0;
      let errCount = 0;

      const syncFn = _deps?._sidecarSync ?? sidecar.sync;
      for (const account of accounts) {
        try {
          const result: any = await syncFn({
            session_id: session.id,
            blz: institution.blz,
            fints_url: institution.fints_url,
            user_id: decrypted.userId,
            pin: decrypted.pin,
            // 'env-default' is a DB sentinel → map to undefined so sidecar's env fallback triggers
            product_id: productId === 'env-default' ? undefined : productId,
            client_data: decrypted.state || undefined,
            account_iban: account.iban,
          });

          // Check for re-auth required
          if (result?.re_auth_required) {
            anomalies.push({
              type: 're_auth_required',
              session_id: session.id,
              message: `Session ${session.id} erfordert erneute Authentifizierung`,
              severity: 'error',
            });
            errCount++;
            continue;
          }

          // Process transactions from sync result
          if (result?.transactions && Array.isArray(result.transactions)) {
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
              if (inserted) transactionsNew++;
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

          accountsSynced++;
          okCount++;
        } catch (e: any) {
          // SidecarError 501 = expected (sidecar stubs not implemented yet)
          if (e instanceof SidecarError && e.statusCode === 501) {
            okCount++; // Count as attempted, not an error
            continue;
          }
          // Real sync error
          anomalies.push({
            type: 'sync_error',
            session_id: session.id,
            account_id: account.id,
            message: `Sync-Fehler Account ${account.iban}: ${e.message}`,
            severity: 'error',
          });
          errCount++;
        }
      }

      // Partial sync detection
      if (okCount > 0 && errCount > 0) {
        anomalies.push({
          type: 'partial_sync',
          session_id: session.id,
          message: `Teilweiser Sync: ${okCount} OK, ${errCount} Fehler`,
          severity: 'warn',
        });
      }
    }

    // Audit log
    await audit.log({
      module: 'banking',
      action: 'daily_sync.completed',
      entityType: 'banking_sync',
      entityId: 'daily',
      after: {
        sessions_checked: sessionsChecked,
        accounts_synced: accountsSynced,
        transactions_new: transactionsNew,
        anomaly_count: anomalies.length,
      },
    });

    // Send Telegram alerts if there are anomalies
    if (anomalies.length > 0 && _deps) {
      const chatId = _deps.telegramChatId();
      if (chatId) {
        const message = formatAnomalyReport(anomalies);
        await _deps.sendTelegram(chatId, message).catch(() => {});
      }
    }

    return {
      status: 'ok',
      sessions_checked: sessionsChecked,
      accounts_synced: accountsSynced,
      transactions_new: transactionsNew,
      anomalies,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  } catch (e: any) {
    return {
      status: 'error',
      sessions_checked: sessionsChecked,
      accounts_synced: accountsSynced,
      transactions_new: transactionsNew,
      anomalies,
      error: e.message,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  } finally {
    await dbQuery('SELECT pg_advisory_unlock(43)').catch(() => {});
  }
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
  const needsReAuth = anomalies.some(a => a.type === 're_auth_required' || a.type === 'session_expiry');
  if (needsReAuth) {
    lines.push('');
    lines.push('\u2192 https://app.bikobickel.de/dashboard/?tab=banking-connect');
  }

  return lines.join('\n');
}
