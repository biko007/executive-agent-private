/**
 * shared/audit — Audit log writer
 *
 * Mandatory for all state-changing operations:
 * - Banking: transactions, matches, CSV uploads
 * - Instagram: approvals, posts, rejections
 * - Assets: tenants, leases, cost billings
 * - Health: manual symptom entries
 * - Auth: token rotation, login attempts
 *
 * NOT logged: Withings auto-sync, weather, briefings, read-only queries.
 */
import { query } from '../db/index.js';
import { getRequestId, getCorrelationId, getActor, getSource } from '../correlation/index.js';

export interface AuditEntry {
  actor?: string;
  module: string;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  source?: string;
  correlationId?: string;
  requestId?: string;
}

/**
 * Write an audit log entry.
 * Auto-injects requestId, correlationId, actor, source from AsyncLocalStorage
 * if not explicitly provided.
 */
export async function log(entry: AuditEntry): Promise<void> {
  const requestId = entry.requestId ?? getRequestId();
  const correlationId = entry.correlationId ?? getCorrelationId();
  const actor = entry.actor ?? getActor();
  const source = entry.source ?? getSource();

  await query(
    `INSERT INTO audit_log
       (actor, module, action, entity_type, entity_id,
        before_jsonb, after_jsonb, source, correlation_id, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      actor,
      entry.module,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.before ? JSON.stringify(entry.before) : null,
      entry.after ? JSON.stringify(entry.after) : null,
      source,
      correlationId,
      requestId,
    ],
  );
}

/**
 * Query recent audit entries for an entity.
 */
export async function getHistory(
  entityType: string,
  entityId: string,
  limit = 50,
): Promise<AuditEntry[]> {
  const { rows } = await query(
    `SELECT actor, module, action, entity_type, entity_id,
            before_jsonb AS before, after_jsonb AS after,
            source, correlation_id, request_id, ts
     FROM audit_log
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY ts DESC
     LIMIT $3`,
    [entityType, entityId, limit],
  );
  return rows;
}
