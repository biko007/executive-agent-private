/**
 * health module — public interface.
 * Other modules MUST import from here — never from internal files.
 */

// Types
export type {
  HealthEntryType, HealthEntry, HealthSummary,
  TrendDirection, WeightTrend, SleepTrend, HeartrateTrend, HrvTrend,
  AlertSeverity, HealthAlert,
  WithingsTokens, WithingsMeasure, WithingsSleep,
  WithingsActivity, WithingsWorkout,
  OuraTokens, OuraSleepDocument, OuraReadinessDocument,
  OuraActivityDocument, OuraSyncResult,
} from './types.js';

// Store (data access — health entries, all async/DB-backed)
export {
  hasEntryForDate, upsertEntryForDate,
  appendEntry, appendEntryWithTimestamp,
  readEntries, lastEntry,
  summarize, formatSummary,
  getWeightTrend, getSleepTrend, getHeartrateTrend,
  getHrvTrend,
  checkHealthAlerts,
} from './store.js';

// Withings (OAuth + API, DB-backed tokens)
export {
  loadTokens, saveTokens, isAuthorized,
  buildAuthUrl, exchangeCode, ensureFreshToken,
  fetchMeasures, fetchSleep, fetchActivity, fetchWorkouts,
  executeWithingsSync, getSyncStatus as getWithingsSyncStatus,
} from './withings.js';
export type { WithingsSyncResult, WithingsSyncStatus } from './withings.js';

// Oura (OAuth + API, DB-backed tokens)
export {
  loadOuraTokens, saveOuraTokens, isOuraAuthorized,
  buildOuraAuthUrl, exchangeOuraCode, ensureFreshOuraToken,
  executeOuraSync, getOuraSyncStatus,
  fetchOuraSleep, fetchOuraReadiness, fetchOuraActivity,
} from './oura.js';
export type { OuraSyncStatus } from './oura.js';

// Commands (Telegram registration)
export {
  registerHealthCommands, initHealthCommands,
  syncWithingsForBriefing, syncOuraForBriefing,
  triggerWithingsSync, triggerOuraSync,
  getSyncStatus,
} from './commands.js';
export type { HealthDeps, OuraSyncDetail } from './commands.js';
