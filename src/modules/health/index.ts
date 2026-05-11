/**
 * health module — public interface.
 * Other modules MUST import from here — never from internal files.
 */

// Types
export type {
  HealthEntryType, HealthEntry, HealthSummary,
  TrendDirection, WeightTrend, SleepTrend,
  AlertSeverity, HealthAlert,
  WithingsTokens, WithingsMeasure, WithingsSleep,
  WithingsActivity, WithingsWorkout,
} from './types.js';

// Store (data access — health entries)
export {
  hasEntryForDate, upsertEntryForDate,
  appendEntry, appendEntryWithTimestamp,
  readEntries, lastEntry,
  summarize, formatSummary,
  getWeightTrend, getSleepTrend,
  checkHealthAlerts,
} from './store.js';

// Withings (OAuth + API)
export {
  loadTokens, saveTokens, isAuthorized,
  buildAuthUrl, exchangeCode, ensureFreshToken,
  fetchMeasures, fetchSleep, fetchActivity, fetchWorkouts,
} from './withings.js';

// Commands (Telegram registration)
export { registerHealthCommands, initHealthCommands, syncWithingsForBriefing } from './commands.js';
export type { HealthDeps } from './commands.js';
