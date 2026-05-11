/**
 * health-store.ts — Re-export shim for backwards compatibility.
 * Real implementation: src/modules/health/store.ts
 */
export {
  hasEntryForDate, upsertEntryForDate,
  appendEntry, appendEntryWithTimestamp,
  readEntries, lastEntry,
  summarize, formatSummary,
  getWeightTrend, getSleepTrend,
  checkHealthAlerts,
} from './src/modules/health/store.js';

export type {
  HealthEntryType, HealthEntry, HealthSummary,
  TrendDirection, WeightTrend, SleepTrend,
  AlertSeverity, HealthAlert,
} from './src/modules/health/types.js';
