/**
 * shared/idempotency — Idempotency key management
 *
 * Prevents duplicate external side-effects (API calls, posts, payments).
 *
 * Key format: <workflow_type>:<workflow_id>:<step_name>
 * Examples:
 *   instagram_post:42:vision
 *   instagram_post:42:meta_post
 *   banking_sync:18:match_tx_5
 *
 * Mandatory for:
 * - Anything moving money or posting to internet
 * - Anything consuming tokens (LLM, Vision API)
 * - Bank CSV imports (SHA256 of file as key)
 */
import { query } from '../db/index.js';

/**
 * Get cached result for an idempotency key.
 * Returns null if the key hasn't been used yet.
 */
export async function get<T = unknown>(key: string): Promise<T | null> {
  const { rows } = await query<{ result_jsonb: T }>(
    'SELECT result_jsonb FROM workflow_idempotency_keys WHERE key = $1',
    [key],
  );
  return rows.length > 0 ? rows[0].result_jsonb : null;
}

/**
 * Store a result for an idempotency key.
 * If the key already exists, this is a no-op (idempotent insert).
 */
export async function set(
  key: string,
  result: unknown,
  workflowId?: number,
): Promise<void> {
  await query(
    `INSERT INTO workflow_idempotency_keys (key, workflow_id, result_jsonb)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO NOTHING`,
    [key, workflowId ?? null, JSON.stringify(result)],
  );
}

/**
 * Execute fn only if the key hasn't been used yet.
 * If cached, returns the cached result without calling fn.
 * If not cached, calls fn, caches the result, and returns it.
 */
export async function withIdempotency<T>(
  key: string,
  fn: () => Promise<T>,
  workflowId?: number,
): Promise<T> {
  const cached = await get<T>(key);
  if (cached !== null) return cached;

  const result = await fn();
  await set(key, result, workflowId);
  return result;
}

/**
 * Build a standard idempotency key.
 */
export function buildKey(
  workflowType: string,
  workflowId: number | string,
  stepName: string,
): string {
  return `${workflowType}:${workflowId}:${stepName}`;
}
