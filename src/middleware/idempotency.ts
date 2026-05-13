/**
 * middleware/idempotency — Idempotency-Key handling for composite endpoints.
 * Prevents duplicate execution of operations like lease-changeovers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { query as dbQuery } from '../shared/db/index.js';
import { canonicalHash } from '../util/canonical.js';

export interface IdempotencyContext {
  key: string;
  actor: string;
  endpointKey: string;
  bodyHash: string;
  isReplay: boolean;
  replayResponse?: { status: number; body: unknown };
}

/**
 * Check idempotency key and return context.
 * Returns null if no Idempotency-Key header present.
 * Throws/returns error responses for conflict cases.
 */
export async function checkIdempotency(
  req: IncomingMessage,
  actor: string,
  endpointKey: string,
  body: unknown,
): Promise<IdempotencyContext | null> {
  const key = req.headers['idempotency-key'] as string;
  if (!key) return null;

  const bodyHash = canonicalHash(body);

  // Try to insert with status 'processing'
  try {
    await dbQuery(
      `INSERT INTO idempotency_keys (actor, endpoint_key, key, body_hash, status)
       VALUES ($1, $2, $3, $4, 'processing')`,
      [actor, endpointKey, key, bodyHash]
    );

    // Successfully inserted — this is a new request
    return { key, actor, endpointKey, bodyHash, isReplay: false };
  } catch (e: any) {
    // Conflict — key already exists
    if (e.code === '23505') {
      // Check the existing entry
      const { rows } = await dbQuery(
        'SELECT * FROM idempotency_keys WHERE actor = $1 AND endpoint_key = $2 AND key = $3',
        [actor, endpointKey, key]
      );

      if (rows.length === 0) {
        // Race condition — retry
        return { key, actor, endpointKey, bodyHash, isReplay: false };
      }

      const existing = rows[0];

      // Body hash mismatch — different request with same key
      if (existing.body_hash !== bodyHash) {
        throw { status: 422, message: 'Idempotency key reused with different body', code: 'IDEMPOTENCY_BODY_MISMATCH' };
      }

      // Still processing — concurrent request
      if (existing.status === 'processing') {
        throw { status: 409, message: 'Request with this idempotency key is still processing', code: 'IDEMPOTENCY_PROCESSING' };
      }

      // Succeeded — replay the response
      if (existing.status === 'succeeded') {
        return {
          key, actor, endpointKey, bodyHash,
          isReplay: true,
          replayResponse: {
            status: existing.response_status || 200,
            body: existing.response_body,
          },
        };
      }

      // Failed — allow retry
      await dbQuery(
        `UPDATE idempotency_keys SET status = 'processing', body_hash = $1 WHERE actor = $2 AND endpoint_key = $3 AND key = $4`,
        [bodyHash, actor, endpointKey, key]
      );
      return { key, actor, endpointKey, bodyHash, isReplay: false };
    }
    throw e;
  }
}

/**
 * Mark an idempotency key as succeeded with the response.
 */
export async function completeIdempotency(
  actor: string,
  endpointKey: string,
  key: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  await dbQuery(
    `UPDATE idempotency_keys SET status = 'succeeded', response_status = $1, response_body = $2
     WHERE actor = $3 AND endpoint_key = $4 AND key = $5`,
    [responseStatus, JSON.stringify(responseBody), actor, endpointKey, key]
  );
}

/**
 * Mark an idempotency key as failed.
 */
export async function failIdempotency(
  actor: string,
  endpointKey: string,
  key: string,
): Promise<void> {
  await dbQuery(
    `UPDATE idempotency_keys SET status = 'failed'
     WHERE actor = $1 AND endpoint_key = $2 AND key = $3`,
    [actor, endpointKey, key]
  );
}
