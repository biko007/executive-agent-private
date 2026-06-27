/**
 * Oura Sync Tests (T1–T3)
 *
 * Proves:
 * - T1: runOuraSync persists all 6 types (sleep, hrv, heartrate, readiness, temperature, steps).
 * - T2: Idempotency — second run with same fixtures → 0 new entries.
 * - T3: HRV/Readiness/Temperature roundtrip (entryToRow → DB → rowToEntry).
 *
 * Uses real Postgres test DB (setupTestDb). No mocking of the proven condition.
 * Oura API calls are simulated by mocking the fetch functions in commands.ts.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';
import type { OuraSleepDocument, OuraReadinessDocument, OuraActivityDocument } from '../types.js';

let cleanup: () => Promise<void>;

// Dynamic imports after DB setup
let runOuraSync: typeof import('../commands.js')['runOuraSync'];
let hasEntryForDate: typeof import('../store.js')['hasEntryForDate'];
let lastEntry: typeof import('../store.js')['lastEntry'];
let readEntries: typeof import('../store.js')['readEntries'];

// ── Fixture data ──────────────────────────────────────────────────────────

const FIXTURE_SLEEP: OuraSleepDocument[] = [
  {
    id: 'oura-sleep-2026-06-10',
    day: '2026-06-10',
    total_sleep_duration: 27000,  // 7.5h in seconds
    deep_sleep_duration: 6480,    // 1.8h
    rem_sleep_duration: 7560,     // 2.1h
    light_sleep_duration: 12960,  // 3.6h
    score: 82,
    average_hrv: 45,
    lowest_heart_rate: 52,
    average_heart_rate: 58,
    temperature_deviation: -0.2,
  },
  {
    id: 'oura-sleep-2026-06-11',
    day: '2026-06-11',
    total_sleep_duration: 24480,  // 6.8h
    deep_sleep_duration: 5400,
    rem_sleep_duration: 6840,
    light_sleep_duration: 12240,
    score: 75,
    average_hrv: 38,
    lowest_heart_rate: 55,
    temperature_deviation: 0.1,
  },
];

const FIXTURE_READINESS: OuraReadinessDocument[] = [
  {
    id: 'oura-readiness-2026-06-10',
    day: '2026-06-10',
    score: 87,
    contributors: { sleep: 90, activity: 85, body_temperature: 80 },
  },
  {
    id: 'oura-readiness-2026-06-11',
    day: '2026-06-11',
    score: 72,
    contributors: { sleep: 70, activity: 75, body_temperature: 72 },
  },
];

const FIXTURE_ACTIVITY: OuraActivityDocument[] = [
  {
    id: 'oura-activity-2026-06-10',
    day: '2026-06-10',
    steps: 11200,
    equivalent_walking_distance: 8500,
    total_calories: 2200,
    active_calories: 450,
  },
  {
    id: 'oura-activity-2026-06-11',
    day: '2026-06-11',
    steps: 8900,
    equivalent_walking_distance: 6700,
    total_calories: 1900,
    active_calories: 320,
  },
];

// Mock the fetch functions before importing commands
// We need to mock the oura module's fetch functions
const mockFetchOuraSleep = mock(async (_token: string, _sinceMs: number) => FIXTURE_SLEEP);
const mockFetchOuraReadiness = mock(async (_token: string, _sinceMs: number) => FIXTURE_READINESS);
const mockFetchOuraActivity = mock(async (_token: string, _sinceMs: number) => FIXTURE_ACTIVITY);

beforeAll(async () => {
  const ctx = await setupTestDb();
  cleanup = ctx.cleanup;

  // Mock oura.ts fetch functions before importing commands
  mock.module('../oura.js', () => ({
    fetchOuraSleep: mockFetchOuraSleep,
    fetchOuraReadiness: mockFetchOuraReadiness,
    fetchOuraActivity: mockFetchOuraActivity,
    // Other oura exports (not used by runOuraSync directly)
    buildOuraAuthUrl: () => '',
    isOuraAuthorized: async () => false,
    exchangeOuraCode: async () => ({}),
    executeOuraSync: async () => ({}),
    getOuraSyncStatus: async () => ({}),
  }));

  const commands = await import('../commands.js');
  runOuraSync = commands.runOuraSync;

  const store = await import('../store.js');
  hasEntryForDate = store.hasEntryForDate;
  lastEntry = store.lastEntry;
  readEntries = store.readEntries;
});

afterAll(async () => {
  await cleanup();
});

describe('Oura Sync Tests', () => {
  test('T1: runOuraSync persists all 6 types (sleep, hrv, heartrate, readiness, temperature, steps)', async () => {
    const sinceMs = new Date('2026-06-09T00:00:00Z').getTime();
    const result = await runOuraSync('test-token', sinceMs);

    // Sleep
    expect(result.sleep).toBe(2);
    expect(result.sleepNew).toBe(2);

    // HRV (from sleep documents that have average_hrv)
    expect(result.hrv).toBe(2);
    expect(result.hrvNew).toBe(2);

    // Heartrate (from sleep documents that have lowest_heart_rate)
    expect(result.heartrate).toBe(2);
    expect(result.heartrateNew).toBe(2);

    // Temperature (from sleep documents that have temperature_deviation)
    expect(result.temperature).toBe(2);
    expect(result.temperatureNew).toBe(2);

    // Readiness
    expect(result.readiness).toBe(2);
    expect(result.readinessNew).toBe(2);

    // Steps
    expect(result.steps).toBe(2);
    expect(result.stepsNew).toBe(2);

    // Totals
    expect(result.total).toBe(12); // 2+2+2+2+2+2
    expect(result.newCount).toBe(12);

    // Verify data in DB
    const hasSleep = await hasEntryForDate('sleep', '2026-06-10');
    expect(hasSleep).toBe(true);
    const hasHrv = await hasEntryForDate('hrv', '2026-06-10');
    expect(hasHrv).toBe(true);
    const hasHr = await hasEntryForDate('heartrate', '2026-06-10');
    expect(hasHr).toBe(true);
    const hasReadiness = await hasEntryForDate('readiness', '2026-06-10');
    expect(hasReadiness).toBe(true);
    const hasTemp = await hasEntryForDate('temperature', '2026-06-10');
    expect(hasTemp).toBe(true);
    const hasSteps = await hasEntryForDate('steps', '2026-06-10');
    expect(hasSteps).toBe(true);
  });

  test('T2: Idempotency — second run with same data → 0 new entries', async () => {
    const sinceMs = new Date('2026-06-09T00:00:00Z').getTime();
    const result = await runOuraSync('test-token', sinceMs);

    // All data already exists from T1, so no new entries
    expect(result.hrvNew).toBe(0);
    expect(result.heartrateNew).toBe(0);
    expect(result.readinessNew).toBe(0);
    expect(result.temperatureNew).toBe(0);
    expect(result.stepsNew).toBe(0);
    // Sleep uses upsert, so sleepNew might be 0 but sleepUpdated might be > 0
    expect(result.sleepNew).toBe(0);
    expect(result.newCount).toBe(0);
  });

  test('T3: HRV/Readiness/Temperature roundtrip (entryToRow → DB → rowToEntry)', async () => {
    // HRV roundtrip
    const hrv = await lastEntry('hrv');
    expect(hrv).not.toBeNull();
    expect(hrv!.type).toBe('hrv');
    expect(hrv!.hrv_ms).toBe(38); // Last fixture (2026-06-11, average_hrv: 38)
    expect(hrv!.source).toBe('oura');

    // Readiness roundtrip
    const readiness = await lastEntry('readiness');
    expect(readiness).not.toBeNull();
    expect(readiness!.type).toBe('readiness');
    expect(readiness!.readiness_score).toBe(72); // Last fixture (2026-06-11, score: 72)
    expect(readiness!.readiness_contributors).toBeTruthy();
    expect(readiness!.readiness_contributors!.sleep).toBe(70);
    expect(readiness!.source).toBe('oura');

    // Temperature roundtrip
    const temp = await lastEntry('temperature');
    expect(temp).not.toBeNull();
    expect(temp!.type).toBe('temperature');
    expect(temp!.temp_deviation).toBe(0.1); // Last fixture (2026-06-11, deviation: 0.1)
    expect(temp!.source).toBe('oura');

    // Sleep roundtrip (verify converted seconds → hours)
    const sleep = await lastEntry('sleep');
    expect(sleep).not.toBeNull();
    expect(sleep!.type).toBe('sleep');
    expect(sleep!.value).toBe(6.8); // 24480s / 3600 = 6.8h
    expect(sleep!.source).toBe('oura');
  });
});
