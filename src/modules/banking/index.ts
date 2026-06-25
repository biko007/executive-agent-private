/**
 * banking module — public interface.
 * Other modules MUST import from here — never from internal files.
 * Sprint 7b Etappe c + d + e.
 */

// Types
export type {
  Institution, Account, Transaction, Session,
  DecryptedSession, EncryptedPayload, PendingChallenge,
  InstitutionRow, AccountRow, TransactionRow, SessionRow,
} from './types.js';

// Encryption
export { encrypt, decrypt, EncryptionError } from './encryption.js';

// Store (data access)
export {
  upsertInstitution, listInstitutions,
  createSession, updateSessionState, getDecryptedSession,
  listAccounts, upsertAccount, archiveAccount, deleteAccount,
  insertTransaction, listTransactions,
  setPendingChallenge, getPendingChallenge, clearPendingChallenge, expireOldPendingChallenges,
  listActiveSessions, updateAccountBalance,
  hasReminderBeenSent, markReminderSent, clearReminders,
  hasTodayBankContact, getSyncRunById, getLastCompletedSyncRunBeforeToday,
  getLastBookingDate, hasEventResyncToday,
} from './store.js';
export type { SyncRunRow } from './store.js';

// Sidecar client
export {
  health as sidecarHealth,
  connect as sidecarConnect,
  completeTan as sidecarCompleteTan,
  sync as sidecarSync,
  refreshSession as sidecarRefreshSession,
  SidecarError,
} from './sidecar-client.js';

// TAN Bridge
export { initTanBridge, initiateConnect, completeTan, cleanupExpiredChallenges } from './tan-bridge.js';

// Commands
export { initBankingCommands, registerBankingCommands } from './commands.js';

// Sync Engine (Etappe e + E1 + E2)
export { initSyncEngine, dailySync, getSyncStatus, eventResync, validateResyncRequest } from './sync-engine.js';
export type { DailySyncResult, AccountSyncResult, ContractStatus, SyncStatus, SyncEngineDeps } from './sync-engine.js';

// HTTP routes
export { registerBankingHttpRoutes } from './routes.js';
