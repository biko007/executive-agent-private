/**
 * shared/workflows — Durable workflow state machine
 *
 * Rules:
 * 1. Persist state at every step — no in-RAM state between steps
 * 2. Each step is idempotent (use shared/idempotency)
 * 3. Recovery on boot — find pending/running workflows, resume or fail
 *
 * Defined workflow types:
 * - instagram_post: Draft → Variants → Approval → Post
 * - banking_sync: CSV-Upload → Parse → Match → Notify
 * - instagram_token_refresh: Validate → Refresh → Store
 */
import { query, getClient } from '../db/index.js';
import { getCorrelationId } from '../correlation/index.js';
import * as audit from '../audit/index.js';

export interface Workflow {
  id: number;
  type: string;
  status: string;
  state: Record<string, unknown>;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
  error: string | null;
}

/**
 * Create a new workflow.
 * Returns the workflow ID.
 */
export async function create(
  type: string,
  initialState: Record<string, unknown> = {},
  correlationId?: string,
): Promise<number> {
  const corrId = correlationId ?? getCorrelationId();
  const { rows } = await query<{ id: number }>(
    `INSERT INTO workflows (type, status, state_jsonb, correlation_id)
     VALUES ($1, 'pending', $2, $3)
     RETURNING id`,
    [type, JSON.stringify(initialState), corrId],
  );
  const id = rows[0].id;

  await audit.log({
    module: type.split('_')[0], // e.g. 'instagram' from 'instagram_post'
    action: 'workflow.created',
    entityType: 'workflow',
    entityId: String(id),
    after: { type, status: 'pending', state: initialState },
  });

  return id;
}

/**
 * Get a workflow by ID.
 */
export async function getWorkflow(id: number): Promise<Workflow | null> {
  const { rows } = await query(
    `SELECT id, type, status, state_jsonb, correlation_id,
            created_at, updated_at, error
     FROM workflows WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    state: r.state_jsonb,
    correlationId: r.correlation_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    error: r.error,
  };
}

/**
 * Update workflow status and optionally merge new state.
 * Uses row-level locking to prevent concurrent updates.
 */
export async function updateStatus(
  id: number,
  newStatus: string,
  newState?: Record<string, unknown>,
): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Lock the row
    const { rows } = await client.query(
      'SELECT status, state_jsonb FROM workflows WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (rows.length === 0) {
      throw new Error(`Workflow ${id} not found`);
    }

    const before = { status: rows[0].status, state: rows[0].state_jsonb };
    const mergedState = newState
      ? { ...rows[0].state_jsonb, ...newState }
      : rows[0].state_jsonb;

    await client.query(
      `UPDATE workflows
       SET status = $1, state_jsonb = $2, updated_at = NOW()
       WHERE id = $3`,
      [newStatus, JSON.stringify(mergedState), id],
    );
    await client.query('COMMIT');

    await audit.log({
      module: 'workflow',
      action: 'workflow.status_changed',
      entityType: 'workflow',
      entityId: String(id),
      before,
      after: { status: newStatus, state: mergedState },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark a workflow as failed with an error message.
 */
export async function markFailed(id: number, error: string): Promise<void> {
  await query(
    `UPDATE workflows SET status = 'failed', error = $1, updated_at = NOW()
     WHERE id = $2`,
    [error, id],
  );

  await audit.log({
    module: 'workflow',
    action: 'workflow.failed',
    entityType: 'workflow',
    entityId: String(id),
    after: { status: 'failed', error },
  });
}

/**
 * Find workflows that need recovery (status is pending or running).
 * Called on boot to resume or fail stale workflows.
 */
export async function findRecoverable(): Promise<Workflow[]> {
  const { rows } = await query(
    `SELECT id, type, status, state_jsonb, correlation_id,
            created_at, updated_at, error
     FROM workflows
     WHERE status NOT IN ('completed', 'cancelled', 'failed')
     ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    state: r.state_jsonb,
    correlationId: r.correlation_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    error: r.error,
  }));
}
