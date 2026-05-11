/**
 * withings-store.ts — Re-export shim for backwards compatibility.
 * Real implementation: src/modules/health/withings.ts
 */
export {
  loadTokens, saveTokens, isAuthorized,
  buildAuthUrl, exchangeCode, ensureFreshToken,
  fetchMeasures, fetchSleep, fetchActivity, fetchWorkouts,
} from './src/modules/health/withings.js';

export type {
  WithingsTokens, WithingsMeasure, WithingsSleep,
  WithingsActivity, WithingsWorkout,
} from './src/modules/health/types.js';
