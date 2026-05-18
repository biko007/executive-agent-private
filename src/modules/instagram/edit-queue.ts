/**
 * edit-queue.ts — Async edit job queue (E4a).
 *
 * In-memory p-queue (concurrency 2), persisted via DB status column.
 * Job types registered via registerJobHandler(). E4a ships '_test_mock' only.
 * Real handlers (video_4x5, cover_frame) added in E4b.
 */
import PQueue from 'p-queue';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getClient } from '../../shared/db/index.js';
import * as audit from '../../shared/audit/index.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface EditJob {
  editId: number;            // insta_media_edits.id (0 for mock jobs without real DB row)
  jobType: string;           // '_test_mock' | 'video_4x5' | 'cover_frame' | 'vision_4x5'
  sessionId: string;
  mediaIndex: number;
  sourcePath: string;
  params?: Record<string, unknown>;
}

export type JobHandler = (job: EditJob) => Promise<void>;

// ── Internal State ───────────────────────────────────────────────────────────

const queue = new PQueue({ concurrency: 2 });
const handlers = new Map<string, JobHandler>();

// ── Handler Registration ─────────────────────────────────────────────────────

export function registerJobHandler(jobType: string, handler: JobHandler): void {
  handlers.set(jobType, handler);
}

// ── Built-in _test_mock Handler ──────────────────────────────────────────────

registerJobHandler('_test_mock', async () => {
  await new Promise(resolve => setTimeout(resolve, 1000));
});

// ── Submit Job ───────────────────────────────────────────────────────────────

export async function submitJob(job: EditJob): Promise<void> {
  const handler = handlers.get(job.jobType);
  if (!handler) throw new Error(`No handler registered for job type: ${job.jobType}`);

  queue.add(async () => {
    // Set 'processing' when actually starting (not when queued)
    if (job.editId > 0) await setJobStatus(job.editId, 'processing');

    try {
      await handler(job);
      if (job.editId > 0) await setJobStatus(job.editId, 'edited');
    } catch (err) {
      if (job.editId > 0) {
        const msg = err instanceof Error ? err.message : String(err);
        await setJobFailed(job.editId, job.jobType, msg);
      }
    }
  });
}

// ── DB Helpers (private) ─────────────────────────────────────────────────────

async function setJobStatus(editId: number, status: string): Promise<void> {
  const client = await getClient();
  try {
    await client.query(
      `UPDATE insta_media_edits SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, editId],
    );
  } finally {
    client.release();
  }
}

async function setJobFailed(editId: number, jobType: string, errorMessage: string): Promise<void> {
  const client = await getClient();
  try {
    await client.query(
      `UPDATE insta_media_edits
       SET status = 'edit_failed', error_code = $1, error_message = $2, updated_at = NOW()
       WHERE id = $3`,
      [`${jobType.toUpperCase()}_FAILED`, errorMessage.slice(0, 1000), editId],
    );
  } finally {
    client.release();
  }
}

// ── Recovery ─────────────────────────────────────────────────────────────────

/**
 * Recover stale jobs: rows stuck in 'processing' for >5 minutes.
 * Resets them to 'uploaded' so they can be re-queued.
 * Called at boot (non-blocking).
 */
export async function recoverStaleJobs(): Promise<number> {
  const client = await getClient();
  try {
    const { rows } = await client.query<{ id: number; session_id: string }>(
      `UPDATE insta_media_edits
       SET status = 'uploaded', error_code = NULL, error_message = NULL, updated_at = NOW()
       WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '5 minutes'
       RETURNING id, session_id`,
    );

    for (const row of rows) {
      await audit.log({
        module: 'instagram',
        action: 'edit_queue.stale_job_recovered',
        entityType: 'media_edit',
        entityId: String(row.id),
        after: { session_id: row.session_id, recovered_from: 'processing' },
      });
    }

    return rows.length;
  } finally {
    client.release();
  }
}

// ── Queue Health ─────────────────────────────────────────────────────────────

export async function getQueueHealth(): Promise<{
  active: number;
  pending: number;
  processing_in_db: number;
}> {
  const client = await getClient();
  try {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM insta_media_edits WHERE status = 'processing'`,
    );
    return {
      active: queue.pending,   // p-queue: currently executing
      pending: queue.size,     // p-queue: waiting in queue
      processing_in_db: Number(rows[0].count),
    };
  } finally {
    client.release();
  }
}

// ── Wait for Idle ────────────────────────────────────────────────────────────

/** Resolves when the queue has no running or pending jobs. */
export function waitForIdle(): Promise<void> {
  return queue.onIdle();
}

// ── JSON Response Helper ─────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ── Health Endpoint + Route Registration ─────────────────────────────────────

export function registerEditQueueRoutes(api: any): void {
  const coreServiceToken = process.env.CORE_SERVICE_TOKEN || '';

  api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/instagram/queue/health') return false;

    // Auth check
    const authHeader = req.headers.authorization ?? '';
    if (!coreServiceToken || authHeader !== `Bearer ${coreServiceToken}`) {
      json(res, 401, { ok: false, error: 'Unauthorized' });
      return true;
    }

    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'Method not allowed' });
      return true;
    }

    try {
      const health = await getQueueHealth();
      json(res, 200, { ok: true, ...health });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 500, { ok: false, error: msg });
    }
    return true;
  });
}
