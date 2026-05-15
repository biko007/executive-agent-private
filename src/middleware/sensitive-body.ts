/**
 * middleware/sensitive-body — General-purpose middleware for sensitive routes.
 * Sprint 7b Etappe c: Sensitive route detection, no-store header, rate limiting.
 *
 * Not banking-specific — placed in src/middleware/ alongside approval.ts.
 */
import type { ServerResponse } from 'node:http';

// ── Sensitive Route Registry ──────────────────────────────────────────────────

type SensitiveSpec = true | { conditional: string };

/**
 * Pre-registered sensitive routes.
 * Key format: `METHOD /path` — exact path without query params.
 * Value: `true` for always-sensitive, `{ conditional: string }` for conditional.
 */
const sensitiveRoutes = new Map<string, SensitiveSpec>([
  // Banking sensitive routes
  ['POST /api/banking/connect', true],
  ['POST /api/banking/complete-tan', { conditional: 'tan_response' }],
]);

/**
 * Check if a route is sensitive.
 * @returns false if not sensitive, true if always sensitive, or { conditional } spec.
 */
export function isSensitiveRoute(
  method: string,
  path: string,
): boolean | { conditional: string } {
  const key = `${method.toUpperCase()} ${path}`;
  const spec = sensitiveRoutes.get(key);
  if (spec === undefined) return false;
  if (spec === true) return true;
  return spec;
}

/**
 * Set Cache-Control: no-store on the response to prevent caching of sensitive data.
 */
export function markSensitiveResponse(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
}

// ── Rate Limiting ─────────────────────────────────────────────────────────────

interface RateBucket {
  count: number;
  windowStart: number;
}

const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_MAX = 5; // 5 calls per hour per actor per route

/** In-memory rate limit store: `${actor}::${method} ${path}` → bucket */
const rateBuckets = new Map<string, RateBucket>();

/**
 * Check rate limit for sensitive routes.
 * @returns true if allowed, false if rate limited.
 */
export function checkSensitiveRateLimit(
  actor: string,
  method: string,
  path: string,
): boolean {
  const key = `${actor}::${method.toUpperCase()} ${path}`;
  const now = Date.now();

  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { count: 1, windowStart: now });
    return true;
  }

  bucket.count++;
  if (bucket.count > RATE_MAX) {
    return false;
  }
  return true;
}

/**
 * Reset rate limit state (for testing only).
 */
export function _resetRateLimits(): void {
  rateBuckets.clear();
}
