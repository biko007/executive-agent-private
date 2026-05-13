/**
 * util/canonical — JCS-compatible deterministic JSON serialization.
 * Used by the approval workflow to produce stable body hashes.
 */
import { createHash } from 'node:crypto';

/**
 * Canonicalize a JSON value per JCS (RFC 8785).
 * - Object keys sorted lexicographically
 * - No whitespace
 * - Numbers serialized per ES2015 spec
 * - null, boolean, string as standard JSON
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!isFinite(value)) return 'null';
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys
      .filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]));
    return '{' + parts.join(',') + '}';
  }
  return 'null';
}

/**
 * Compute SHA-256 hash of the canonicalized JSON body.
 */
export function canonicalHash(body: unknown): string {
  const canonical = canonicalize(body);
  return createHash('sha256').update(canonical).digest('hex');
}
