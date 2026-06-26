import { describe, test, expect } from 'bun:test';
import {
  evaluateLocationStaleness,
  LOCATION_STALE_THRESHOLD_MS,
  LOCATION_STALE_RENAG_MS,
} from '../health-monitor.js';

describe('evaluateLocationStaleness', () => {
  const THRESHOLD = LOCATION_STALE_THRESHOLD_MS; // 12h
  const now = Date.now();

  test('T1: stale detected — recorded_at 24h ago', () => {
    const staleTime = new Date(now - 24 * 3600_000).toISOString();
    const result = evaluateLocationStaleness(
      { label: 'Tuttlingen', updatedAt: staleTime },
      THRESHOLD,
      now,
    );
    expect(result.stale).toBe(true);
    expect(result.ageHours).toBe(24);
    expect(result.label).toBe('Tuttlingen');
    expect(result.noData).toBe(false);
    expect(result.updatedAt).toBe(staleTime);
  });

  test('T2: fresh — recorded_at 1h ago', () => {
    const freshTime = new Date(now - 1 * 3600_000).toISOString();
    const result = evaluateLocationStaleness(
      { label: 'München', updatedAt: freshTime },
      THRESHOLD,
      now,
    );
    expect(result.stale).toBe(false);
    expect(result.ageHours).toBe(1);
    expect(result.label).toBe('München');
    expect(result.noData).toBe(false);
    expect(result.updatedAt).toBe(freshTime);
  });

  test('T3: empty table (null) — noData, no stale', () => {
    const result = evaluateLocationStaleness(null, THRESHOLD, now);
    expect(result.stale).toBe(false);
    expect(result.noData).toBe(true);
    expect(result.label).toBeNull();
    expect(result.updatedAt).toBeNull();
  });

  test('T4: invalid updatedAt — noData, no stale', () => {
    const result = evaluateLocationStaleness(
      { label: 'Somewhere', updatedAt: 'invalid-date' },
      THRESHOLD,
      now,
    );
    expect(result.stale).toBe(false);
    expect(result.noData).toBe(true);
    expect(result.label).toBe('Somewhere');
    expect(result.updatedAt).toBeNull();
  });

  test('T5: exactly at threshold — not stale (> not >=)', () => {
    const exactTime = new Date(now - THRESHOLD).toISOString();
    const result = evaluateLocationStaleness(
      { label: 'Berlin', updatedAt: exactTime },
      THRESHOLD,
      now,
    );
    // At exactly the threshold, ageMs === thresholdMs, condition is >, so not stale
    expect(result.stale).toBe(false);
    expect(result.ageHours).toBe(12);
    expect(result.noData).toBe(false);
  });

  test('T6: just over threshold — stale', () => {
    const justOver = new Date(now - THRESHOLD - 1).toISOString();
    const result = evaluateLocationStaleness(
      { label: 'Stuttgart', updatedAt: justOver },
      THRESHOLD,
      now,
    );
    expect(result.stale).toBe(true);
    expect(result.ageHours).toBe(12);
    expect(result.noData).toBe(false);
  });

  test('T7: 24h reminder — stale persists, reminder fires only after RENAG window', () => {
    // Simulate a location event recorded 50h ago (real old timestamp, not mocked)
    const recordedAt = new Date(now - 50 * 3600_000).toISOString();

    // t0: first detection — age is 14h (>12h threshold) → stale
    const t0 = now - 36 * 3600_000;
    const r0 = evaluateLocationStaleness({ label: 'Tuttlingen', updatedAt: recordedAt }, THRESHOLD, t0);
    expect(r0.stale).toBe(true);
    expect(r0.ageHours).toBe(14); // 50h - 36h = 14h age at t0
    // State machine would set lastStaleAlertAt = t0 and send initial WARN

    // t0 + 12h: still stale, but <24h since first alert → no reminder
    const t1 = t0 + 12 * 3600_000;
    const r1 = evaluateLocationStaleness({ label: 'Tuttlingen', updatedAt: recordedAt }, THRESHOLD, t1);
    expect(r1.stale).toBe(true);
    expect(r1.ageHours).toBe(26); // 50h - 24h = 26h age at t1
    expect(t1 - t0).toBeLessThan(LOCATION_STALE_RENAG_MS); // 12h < 24h RENAG

    // t0 + 25h: still stale, >24h since first alert → reminder fires
    const t2 = t0 + 25 * 3600_000;
    const r2 = evaluateLocationStaleness({ label: 'Tuttlingen', updatedAt: recordedAt }, THRESHOLD, t2);
    expect(r2.stale).toBe(true);
    expect(r2.ageHours).toBe(39); // 50h - 11h = 39h age at t2
    expect(t2 - t0).toBeGreaterThan(LOCATION_STALE_RENAG_MS); // 25h > 24h RENAG
  });
});
