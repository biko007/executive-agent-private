/**
 * memory/store — Conversation turn persistence + owner_memory queries
 *
 * Fire-and-forget writer for conversation_log table.
 * Query functions for owner_memory (extraction, recall, management).
 * Caller is responsible for try/catch — this module throws on DB errors.
 */
import crypto from 'node:crypto';
import { query, getClient } from '../../shared/db/index.js';

export interface ConversationTurn {
  senderId: string;
  userText: string;
  agentText: string | null;
  sessionKey: string | null;
  channel?: string;
  metadata?: Record<string, unknown> | null;
}

export async function insertConversationTurn(turn: ConversationTurn): Promise<void> {
  await query(
    `INSERT INTO conversation_log
       (sender_id, user_text, agent_text, session_key, channel, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      turn.senderId,
      turn.userText,
      turn.agentText,
      turn.sessionKey,
      turn.channel ?? 'telegram',
      turn.metadata ? JSON.stringify(turn.metadata) : null,
    ],
  );
}

/** Return the id of the last inserted conversation_log row for this sender. */
export async function getLastConversationLogId(senderId: string): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM conversation_log WHERE sender_id = $1 ORDER BY id DESC LIMIT 1`,
    [senderId],
  );
  return rows[0]?.id ?? null;
}

/** Update extraction status on a conversation_log row. */
export async function updateExtractStatus(
  logId: number,
  status: 'pending' | 'done' | 'failed' | 'skipped',
  error?: string,
): Promise<void> {
  if (status === 'done') {
    await query(
      `UPDATE conversation_log
         SET memory_extract_status = $1,
             memory_extracted_at = NOW()
       WHERE id = $2`,
      [status, logId],
    );
  } else if (status === 'failed') {
    await query(
      `UPDATE conversation_log
         SET memory_extract_status = $1,
             memory_extract_attempts = memory_extract_attempts + 1,
             memory_extract_last_error = $2
       WHERE id = $3`,
      [status, error ?? null, logId],
    );
  } else {
    await query(
      `UPDATE conversation_log SET memory_extract_status = $1 WHERE id = $2`,
      [status, logId],
    );
  }
}

// ── owner_memory queries ──────────────────────────────────────────────────

export interface OwnerFact {
  id: number;
  fact: string;
  category: string | null;
  sensitivity: string;
  confidence: number | null;
  created_at: Date;
}

/** Normalize a fact string for dedup: lowercase, collapse whitespace, trim. */
export function normalizeFact(fact: string): string {
  return fact.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** SHA-256 hash of normalized fact text. */
export function hashFact(factNorm: string): string {
  return crypto.createHash('sha256').update(factNorm).digest('hex');
}

/** Get all active owner_memory facts (for extraction context and recall). */
export async function getActiveOwnerFacts(ownerSenderId: string): Promise<OwnerFact[]> {
  const { rows } = await query<OwnerFact>(
    `SELECT id, fact, category, sensitivity, confidence, created_at
       FROM owner_memory
      WHERE status = 'active' AND owner_sender_id = $1
      ORDER BY created_at DESC`,
    [ownerSenderId],
  );
  return rows;
}

/** Insert a new fact. Returns the new id, or null if dedup index blocked it. */
export async function insertOwnerFact(params: {
  ownerSenderId: string;
  fact: string;
  factNorm: string;
  factHash: string;
  category: string;
  sensitivity: string;
  evidenceQuote: string | null;
  sourceLogId: number | null;
  confidence: number;
  supersedesId: number | null;
  modelUsed: string;
  promptVersion: string;
}): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO owner_memory
       (owner_sender_id, fact, fact_norm, fact_hash, category, sensitivity,
        evidence_quote, source_log_id, confidence, supersedes_id,
        model_used, prompt_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (fact_hash) WHERE status = 'active' DO NOTHING
     RETURNING id`,
    [
      params.ownerSenderId, params.fact, params.factNorm, params.factHash,
      params.category, params.sensitivity,
      params.evidenceQuote, params.sourceLogId, params.confidence,
      params.supersedesId, params.modelUsed, params.promptVersion,
    ],
  );
  return rows[0]?.id ?? null;
}

/** Supersede an existing fact: mark old as superseded, insert new. */
export async function supersedeFact(
  targetId: number,
  newParams: Parameters<typeof insertOwnerFact>[0],
): Promise<number | null> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE owner_memory SET status = 'superseded', updated_at = NOW() WHERE id = $1`,
      [targetId],
    );
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO owner_memory
         (owner_sender_id, fact, fact_norm, fact_hash, category, sensitivity,
          evidence_quote, source_log_id, confidence, supersedes_id,
          model_used, prompt_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (fact_hash) WHERE status = 'active' DO NOTHING
       RETURNING id`,
      [
        newParams.ownerSenderId, newParams.fact, newParams.factNorm, newParams.factHash,
        newParams.category, newParams.sensitivity,
        newParams.evidenceQuote, newParams.sourceLogId, newParams.confidence,
        targetId, newParams.modelUsed, newParams.promptVersion,
      ],
    );
    await client.query('COMMIT');
    return rows[0]?.id ?? null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Reject a fact (set status='rejected'). Used by /memory drop. */
export async function rejectFact(factId: number): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE owner_memory SET status = 'rejected', updated_at = NOW()
      WHERE id = $1 AND status = 'active'`,
    [factId],
  );
  return (rowCount ?? 0) > 0;
}

/** List active facts for /memory list. Returns paginated results. */
export async function listActiveFacts(
  ownerSenderId: string,
  limit = 20,
  offset = 0,
): Promise<{ facts: OwnerFact[]; total: number }> {
  const countResult = await query<{ count: string }>(
    `SELECT count(*)::text FROM owner_memory WHERE status = 'active' AND owner_sender_id = $1`,
    [ownerSenderId],
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const { rows } = await query<OwnerFact>(
    `SELECT id, fact, category, sensitivity, confidence, created_at
       FROM owner_memory
      WHERE status = 'active' AND owner_sender_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [ownerSenderId, limit, offset],
  );
  return { facts: rows, total };
}

/** Get a single fact by id (for /memory drop preview). */
export async function getFactById(factId: number): Promise<OwnerFact | null> {
  const { rows } = await query<OwnerFact>(
    `SELECT id, fact, category, sensitivity, confidence, created_at
       FROM owner_memory WHERE id = $1`,
    [factId],
  );
  return rows[0] ?? null;
}

// ── Sweep queries ──────────────────────────────────────────────────────────

export interface PendingExtractionJob {
  id: number;
  sender_id: string;
  user_text: string;
  agent_text: string | null;
  memory_extract_attempts: number;
}

/** Fetch pending/failed extraction jobs for sweep processing. */
export async function getPendingExtractionJobs(ownerSenderIds: string[], limit = 5): Promise<PendingExtractionJob[]> {
  if (ownerSenderIds.length === 0) return [];
  const { rows } = await query<PendingExtractionJob>(
    `SELECT id, sender_id, user_text, agent_text, memory_extract_attempts
       FROM conversation_log
      WHERE memory_extract_status IN ('pending', 'failed')
        AND memory_extract_attempts < 3
        AND sender_id = ANY($1)
      ORDER BY id ASC
      LIMIT $2`,
    [ownerSenderIds, limit],
  );
  return rows;
}

/** Acquire advisory lock 48 (non-blocking). Returns true if acquired. */
export async function tryAdvisoryLock48(): Promise<boolean> {
  const { rows } = await query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock(48) AS acquired`,
  );
  return rows[0]?.acquired === true;
}

/** Release advisory lock 48. */
export async function releaseAdvisoryLock48(): Promise<void> {
  await query(`SELECT pg_advisory_unlock(48)`);
}
