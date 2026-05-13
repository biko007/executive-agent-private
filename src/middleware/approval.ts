/**
 * middleware/approval — Approval preview + token validation + TX-lock.
 * Implements the two-phase approval workflow for destructive mutations.
 */
import { randomUUID } from 'node:crypto';
import { query as dbQuery, getClient } from '../shared/db/index.js';
import { canonicalHash } from '../util/canonical.js';
import { getApprovalSpec } from './approval-registry.js';

export interface PreviewParams {
  sessionId: string;
  actor: string;
  method: string;
  endpointKey: string;
  body: unknown;
  entityVersions?: Record<string, string>; // { "table:id": "updated_at ISO" }
  diffSummary?: unknown;
}

export interface PreviewResult {
  token: string;
  expires_at: string;
  endpoint_key: string;
  canonical_body_hash: string;
  diff_summary: unknown;
}

/**
 * Create an approval preview token.
 * Rate-limited to 30 previews/min per session, max 10 active tokens per session.
 */
export async function createApprovalPreview(params: PreviewParams): Promise<PreviewResult> {
  const { sessionId, actor, method, endpointKey, body, entityVersions, diffSummary } = params;

  // Rate limit: max 10 active tokens per session — supersede oldest
  const { rows: active } = await dbQuery(
    `SELECT id FROM approval_tokens
     WHERE session_id = $1 AND used_at IS NULL AND superseded_at IS NULL
     ORDER BY created_at ASC`,
    [sessionId]
  );

  if (active.length >= 10) {
    // Supersede oldest
    const toSupersede = active.slice(0, active.length - 9);
    for (const row of toSupersede) {
      await dbQuery('UPDATE approval_tokens SET superseded_at = now() WHERE id = $1', [row.id]);
    }
  }

  const token = randomUUID();
  const bodyHash = canonicalHash(body);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  await dbQuery(
    `INSERT INTO approval_tokens (token, session_id, actor, method, endpoint_key,
       canonical_body_hash, entity_versions, diff_summary, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [token, sessionId, actor, method, endpointKey,
     bodyHash, entityVersions ? JSON.stringify(entityVersions) : null,
     diffSummary ? JSON.stringify(diffSummary) : null, expiresAt.toISOString()]
  );

  return {
    token,
    expires_at: expiresAt.toISOString(),
    endpoint_key: endpointKey,
    canonical_body_hash: bodyHash,
    diff_summary: diffSummary || null,
  };
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  code?: string;
}

/**
 * Validate an approval token with TX-lock.
 * Uses SELECT ... FOR UPDATE NOWAIT for pessimistic locking.
 * Checks: session match, actor match, method match, endpoint_key match,
 * canonical_body_hash match, entity_versions stale check.
 */
export async function validateApprovalToken(
  token: string,
  sessionId: string,
  actor: string,
  method: string,
  endpointKey: string,
  body: unknown,
  client?: import('pg').PoolClient,
): Promise<ValidationResult> {
  const doQuery = client
    ? (text: string, params?: unknown[]) => client.query(text, params)
    : (text: string, params?: unknown[]) => dbQuery(text, params);

  try {
    // Lock the token row
    const { rows } = await doQuery(
      `SELECT * FROM approval_tokens
       WHERE token = $1
       FOR UPDATE NOWAIT`,
      [token]
    );

    if (rows.length === 0) {
      return { valid: false, error: 'Approval token not found', code: 'TOKEN_NOT_FOUND' };
    }

    const row = rows[0];

    // Check if already used
    if (row.used_at) {
      return { valid: false, error: 'Approval token already used', code: 'TOKEN_USED' };
    }

    // Check if superseded
    if (row.superseded_at) {
      return { valid: false, error: 'Approval token superseded', code: 'TOKEN_SUPERSEDED' };
    }

    // Check expiry
    if (new Date(row.expires_at) < new Date()) {
      return { valid: false, error: 'Approval token expired', code: 'TOKEN_EXPIRED' };
    }

    // Check session
    if (row.session_id !== sessionId) {
      return { valid: false, error: 'Session mismatch', code: 'SESSION_MISMATCH' };
    }

    // Check actor
    if (row.actor !== actor) {
      return { valid: false, error: 'Actor mismatch', code: 'ACTOR_MISMATCH' };
    }

    // Check method
    if (row.method !== method) {
      return { valid: false, error: 'Method mismatch', code: 'METHOD_MISMATCH' };
    }

    // Check endpoint key
    if (row.endpoint_key !== endpointKey) {
      return { valid: false, error: 'Endpoint key mismatch', code: 'ENDPOINT_MISMATCH' };
    }

    // Check body hash
    const currentHash = canonicalHash(body);
    if (row.canonical_body_hash !== currentHash) {
      return { valid: false, error: 'Request body changed since preview', code: 'BODY_CHANGED' };
    }

    // Stale check: verify entity versions haven't changed
    if (row.entity_versions) {
      const versions = typeof row.entity_versions === 'string'
        ? JSON.parse(row.entity_versions)
        : row.entity_versions;

      for (const [key, expectedUpdatedAt] of Object.entries(versions)) {
        const [table, id] = key.split(':');
        if (!table || !id) continue;

        const { rows: entityRows } = await doQuery(
          `SELECT updated_at FROM ${table} WHERE id = $1 FOR UPDATE`,
          [id]
        );

        if (entityRows.length === 0) {
          return { valid: false, error: `Entity ${key} no longer exists`, code: 'ENTITY_DELETED' };
        }

        const actualUpdatedAt = new Date(entityRows[0].updated_at).toISOString();
        if (actualUpdatedAt !== expectedUpdatedAt) {
          return { valid: false, error: `Entity ${key} has been modified since preview`, code: 'STALE_ENTITY' };
        }
      }
    }

    // Mark as used
    await doQuery('UPDATE approval_tokens SET used_at = now() WHERE id = $1', [row.id]);

    return { valid: true };
  } catch (e: any) {
    if (e.code === '55P03') {
      // NOWAIT lock conflict
      return { valid: false, error: 'Token is being validated by another request', code: 'LOCK_CONFLICT' };
    }
    throw e;
  }
}
