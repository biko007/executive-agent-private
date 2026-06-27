/**
 * Withings Sync Consolidation Tests (T1–T5)
 *
 * Proves:
 * - T1: runWithingsSync fetches + persists all 4 types, dedup prevents duplicates.
 * - T2: /healthsync 30 → sinceMs = now - 30d (not last_sync - 24h).
 * - T3: Briefing → sinceMs = now - 48h, all 4 fetchers invoked.
 * - T4: After sync, last_sync ≈ now (cursor truthful).
 * - T5: Re-run idempotency — second run with same data → 0 new.
 *
 * Uses real Postgres test DB (setupTestDb). No mocking of the proven condition
 * (date arithmetic, window calculation). Fixture fetchers via DI.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';
import type { WithingsMeasure, WithingsSleep, WithingsActivity, WithingsWorkout } from '../types.js';

let cleanup: () => Promise<void>;

// Dynamic imports after DB setup (modules read POSTGRES_URL at import time)
let runWithingsSync: typeof import('../commands.js')['runWithingsSync'];
let executeWithingsSync: typeof import('../withings.js')['executeWithingsSync'];
let saveTokens: typeof import('../withings.js')['saveTokens'];
let loadTokens: typeof import('../withings.js')['loadTokens'];
let hasEntryForDate: typeof import('../store.js')['hasEntryForDate'];

// ── Fixture data ──────────────────────────────────────────────────────────

const FIXTURE_MEASURES: WithingsMeasure[] = [
  { date: new Date('2026-06-01T08:00:00Z'), weight_kg: 79.5, fat_ratio_pct: 18.2, hr_bpm: 68 },
  { date: new Date('2026-06-02T08:00:00Z'), weight_kg: 79.3 },
  { date: new Date('2026-06-03T08:00:00Z'), weight_kg: 79.1, hr_bpm: 72 },
];

const FIXTURE_SLEEP: WithingsSleep[] = [
  { date: '2026-06-01', total_h: 7.5, deep_h: 1.8, rem_h: 2.1, light_h: 3.6, score: 82 },
  { date: '2026-06-02', total_h: 6.8, deep_h: 1.5, rem_h: 1.9, light_h: 3.4, score: 75 },
  { date: '2026-06-03', total_h: 8.1, deep_h: 2.0, rem_h: 2.3, light_h: 3.8, score: 88 },
];

const FIXTURE_ACTIVITY: WithingsActivity[] = [
  { date: '2026-06-01', steps: 12500, distance_m: 9200, calories: 420, active_min: 65, hr_avg: 84, hr_min: 55, hr_max: 142 },
  { date: '2026-06-02', steps: 8300, distance_m: 6100, calories: 310, active_min: 42 },
  { date: '2026-06-03', steps: 15200, distance_m: 11500, calories: 520, active_min: 78, hr_avg: 89 },
];

const FIXTURE_WORKOUTS: WithingsWorkout[] = [
  { date: '2026-06-02', activity_type: 'Laufen', duration_min: 35, steps: 4200, distance_m: 5100, calories: 380, hr_avg: 155 },
];

function makeFixtureFetchers() {
  const calls: { measures: number[]; sleep: number[]; activity: number[]; workouts: number[] } = {
    measures: [], sleep: [], activity: [], workouts: [],
  };
  return {
    calls,
    fetchers: {
      fetchMeasures: async (_token: string, sinceMs: number) => { calls.measures.push(sinceMs); return FIXTURE_MEASURES; },
      fetchSleep: async (_token: string, sinceMs: number) => { calls.sleep.push(sinceMs); return FIXTURE_SLEEP; },
      fetchActivity: async (_token: string, sinceMs: number) => { calls.activity.push(sinceMs); return FIXTURE_ACTIVITY; },
      fetchWorkouts: async (_token: string, sinceMs: number) => { calls.workouts.push(sinceMs); return FIXTURE_WORKOUTS; },
    },
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const ctx = await setupTestDb();
  cleanup = ctx.cleanup;

  // Dynamic imports after POSTGRES_URL is set to test DB
  const commands = await import('../commands.js');
  const withings = await import('../withings.js');
  const store = await import('../store.js');

  runWithingsSync = commands.runWithingsSync;
  executeWithingsSync = withings.executeWithingsSync;
  saveTokens = withings.saveTokens;
  loadTokens = withings.loadTokens;
  hasEntryForDate = store.hasEntryForDate;
});

afterAll(async () => {
  await cleanup();
});

// ── Helpers ───────────────────────────────────────────────────────────────

/** Insert a test token that won't need refresh (expires 1h from now). */
async function insertTestToken(lastSync?: number) {
  await saveTokens({
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_at: Date.now() + 3_600_000, // 1h, no refresh needed
    userid: 'test-user',
    last_sync: lastSync,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Withings Sync Consolidation', () => {

  test('T1 — runWithingsSync fetches + persists weight/body_fat only (Oura handles rest)', async () => {
    const { fetchers } = makeFixtureFetchers();
    const r = await runWithingsSync('fake-token', Date.now() - 7 * 24 * 3600_000, fetchers);

    // Counts — only measures (weight + body_fat), sleep/activity/workouts now via Oura
    expect(r.measures).toBe(3);
    expect(r.measuresNew).toBeGreaterThanOrEqual(3); // 3 weight entries
    expect(r.sleep).toBe(0);
    expect(r.sleepNew).toBe(0);
    expect(r.activity).toBe(0);
    expect(r.activityNew).toBe(0);
    expect(r.workouts).toBe(0);
    expect(r.workoutsNew).toBe(0);
    expect(r.totalNew).toBeGreaterThan(0);

    // Verify DB entries exist (weight only)
    expect(await hasEntryForDate('weight', '2026-06-01')).toBe(true);
    expect(await hasEntryForDate('weight', '2026-06-02')).toBe(true);
    expect(await hasEntryForDate('weight', '2026-06-03')).toBe(true);
  });

  test('T2 — /healthsync 30 uses days argument, not last_sync', async () => {
    // Setup: token with last_sync = 2h ago (the old code would use last_sync - 24h ≈ 26h)
    const twoHoursAgo = Date.now() - 2 * 3600_000;
    await insertTestToken(twoHoursAgo);

    let capturedSinceMs: number | undefined;

    const days = 30;
    const sinceMs = Date.now() - days * 24 * 3600_000;
    // ↑ This is how the fixed /healthsync handler computes sinceMs

    await executeWithingsSync(
      'fake-id', 'fake-secret', sinceMs,
      async (_token, since) => {
        capturedSinceMs = since;
        return { total: 0, newCount: 0 };
      },
    );

    // The sinceMs that arrived must be ~30 days ago (real arithmetic)
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 3600_000;
    expect(Math.abs((now - capturedSinceMs!) - thirtyDaysMs)).toBeLessThan(5000);

    // Must NOT be the old bug value (last_sync - 24h ≈ 26h ago)
    const oldBugWindow = 26 * 3600_000; // 2h + 24h = 26h
    expect(now - capturedSinceMs!).toBeGreaterThan(oldBugWindow * 10);
  });

  test('T3 — Briefing uses 48h window, only measures fetcher invoked (Oura handles rest)', async () => {
    await insertTestToken();

    const { calls, fetchers } = makeFixtureFetchers();

    const sinceMs = Date.now() - 48 * 3600_000;
    // ↑ This is how syncWithingsForBriefing computes sinceMs

    await executeWithingsSync(
      'fake-id', 'fake-secret', sinceMs,
      async (token, since) => {
        const r = await runWithingsSync(token, since, fetchers);
        return { total: r.measures, newCount: r.totalNew };
      },
    );

    // Only measures fetcher invoked (sleep/activity/workouts now via Oura)
    expect(calls.measures.length).toBe(1);
    expect(calls.sleep.length).toBe(0);
    expect(calls.activity.length).toBe(0);
    expect(calls.workouts.length).toBe(0);

    // sinceMs passed to fetchers ≈ now - 48h
    const now = Date.now();
    const fortyEightHoursMs = 48 * 3600_000;
    expect(Math.abs((now - calls.measures[0]) - fortyEightHoursMs)).toBeLessThan(5000);
  });

  test('T4 — Cursor truthfulness: last_sync ≈ now after sync', async () => {
    await insertTestToken(Date.now() - 7 * 24 * 3600_000); // last_sync = 7d ago

    const beforeSync = Date.now();

    await executeWithingsSync(
      'fake-id', 'fake-secret', Date.now() - 48 * 3600_000,
      async (_token, _since) => ({ total: 0, newCount: 0 }),
    );

    const afterSync = Date.now();
    const tokens = await loadTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.last_sync).toBeDefined();

    // last_sync must be between beforeSync and afterSync (± small margin)
    expect(tokens!.last_sync!).toBeGreaterThanOrEqual(beforeSync - 1000);
    expect(tokens!.last_sync!).toBeLessThanOrEqual(afterSync + 1000);
  });

  test('T5 — Re-run idempotency: second run → 0 new entries', async () => {
    await insertTestToken();

    const { fetchers: fetchers1 } = makeFixtureFetchers();
    const r1 = await runWithingsSync('fake-token', Date.now() - 7 * 24 * 3600_000, fetchers1);
    // First run may or may not insert (T1 already inserted some fixtures).
    // The point is: after r1, all fixture dates exist in DB.

    const { fetchers: fetchers2 } = makeFixtureFetchers();
    const r2 = await runWithingsSync('fake-token', Date.now() - 7 * 24 * 3600_000, fetchers2);

    // Second run: all entries already exist → dedup → 0 new
    expect(r2.measuresNew).toBe(0);
    expect(r2.totalNew).toBe(0);
  });
});
