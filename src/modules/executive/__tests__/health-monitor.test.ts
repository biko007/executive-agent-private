import { describe, test, expect } from 'bun:test';
import { shouldAlert } from '../health-monitor.js';

describe('shouldAlert (throttling)', () => {
  test('allows first alert for a service+event', () => {
    const map = new Map<string, number>();
    expect(shouldAlert('Core', 'down', 1000, map)).toBe(true);
  });

  test('throttles same service+event within 30 min window', () => {
    const map = new Map<string, number>();
    const t0 = Date.now();
    shouldAlert('Core', 'down', t0, map); // first → allowed
    expect(shouldAlert('Core', 'down', t0 + 10 * 60_000, map)).toBe(false); // +10 min → throttled
    expect(shouldAlert('Core', 'down', t0 + 29 * 60_000, map)).toBe(false); // +29 min → throttled
  });

  test('allows alert after 30 min window expires', () => {
    const map = new Map<string, number>();
    const t0 = Date.now();
    shouldAlert('Core', 'down', t0, map);
    expect(shouldAlert('Core', 'down', t0 + 30 * 60_000, map)).toBe(true); // exactly 30 min → allowed
  });

  test('different services are independent', () => {
    const map = new Map<string, number>();
    const t0 = Date.now();
    shouldAlert('Core', 'down', t0, map);
    expect(shouldAlert('Trading', 'down', t0, map)).toBe(true); // different service → allowed
  });

  test('different events for same service are independent', () => {
    const map = new Map<string, number>();
    const t0 = Date.now();
    shouldAlert('Core', 'down', t0, map);
    expect(shouldAlert('Core', 'up', t0, map)).toBe(true); // different event → allowed
  });

  test('throttle resets after window and tracks new timestamp', () => {
    const map = new Map<string, number>();
    const t0 = 1_000_000;
    shouldAlert('n8n', 'down', t0, map);

    // After window expires, alert again
    const t1 = t0 + 31 * 60_000;
    expect(shouldAlert('n8n', 'down', t1, map)).toBe(true);

    // New throttle window starts from t1
    expect(shouldAlert('n8n', 'down', t1 + 10 * 60_000, map)).toBe(false);
    expect(shouldAlert('n8n', 'down', t1 + 31 * 60_000, map)).toBe(true);
  });
});
