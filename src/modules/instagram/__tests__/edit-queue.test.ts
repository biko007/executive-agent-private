/**
 * Edit Queue Tests (E4a) — p-queue concurrency, DB status, stale recovery.
 *
 * Uses setupTestDb() + audit_log table (same pattern as inbox.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

let cleanup: () => Promise<void>;

// Module references (imported dynamically after DB setup)
let submitJob: typeof import('../edit-queue.js')['submitJob'];
let waitForIdle: typeof import('../edit-queue.js')['waitForIdle'];
let registerJobHandler: typeof import('../edit-queue.js')['registerJobHandler'];
let recoverStaleJobs: typeof import('../edit-queue.js')['recoverStaleJobs'];

beforeAll(async () => {
  const ctx = await setupTestDb();
  cleanup = ctx.cleanup;

  // Create audit_log table (recoverStaleJobs uses audit.log)
  const db = await import('../../../shared/db/index.js');
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id              BIGSERIAL PRIMARY KEY,
      ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor           TEXT,
      module          TEXT NOT NULL,
      action          TEXT NOT NULL,
      entity_type     TEXT,
      entity_id       TEXT,
      before_jsonb    JSONB,
      after_jsonb     JSONB,
      source          TEXT NOT NULL DEFAULT 'system',
      correlation_id  TEXT,
      request_id      TEXT
    )
  `);

  // Dynamic import AFTER DB setup
  const mod = await import('../edit-queue.js');
  submitJob = mod.submitJob;
  waitForIdle = mod.waitForIdle;
  registerJobHandler = mod.registerJobHandler;
  recoverStaleJobs = mod.recoverStaleJobs;
});

afterAll(async () => {
  await cleanup();
});

describe('edit-queue (E4a)', () => {
  test('a. 5 concurrent jobs => max 2 run in parallel', async () => {
    let currentRunning = 0;
    let maxRunning = 0;

    registerJobHandler('_test_concurrency', async () => {
      currentRunning++;
      if (currentRunning > maxRunning) maxRunning = currentRunning;
      await new Promise(resolve => setTimeout(resolve, 200));
      currentRunning--;
    });

    for (let i = 0; i < 5; i++) {
      await submitJob({
        editId: 0,
        jobType: '_test_concurrency',
        sessionId: 'test-concurrency',
        mediaIndex: i + 1,
        sourcePath: '/tmp/test.mp4',
      });
    }

    await waitForIdle();

    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(maxRunning).toBe(2);
  });

  test('b. Mock job with real DB row => status transitions to edited', async () => {
    const db = await import('../../../shared/db/index.js');

    // Insert a row with status='uploaded'
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO insta_media_edits
         (session_id, media_index, variant, source_path, sha256_original, status, source)
       VALUES ($1, $2, 'video_4x5', '/tmp/test.mp4', 'abc123def', 'uploaded', 'telegram')
       RETURNING id`,
      ['test-db-status', 1],
    );
    const editId = rows[0].id;

    await submitJob({
      editId,
      jobType: '_test_mock',
      sessionId: 'test-db-status',
      mediaIndex: 1,
      sourcePath: '/tmp/test.mp4',
    });

    await waitForIdle();

    const { rows: after } = await db.query<{ status: string }>(
      `SELECT status FROM insta_media_edits WHERE id = $1`,
      [editId],
    );
    expect(after[0].status).toBe('edited');
  });

  test('c. recoverStaleJobs: 3 processing rows (1 recent, 2 stale >5min) => 2 reset', async () => {
    const db = await import('../../../shared/db/index.js');

    // Recent: updated_at = NOW()
    await db.query(
      `INSERT INTO insta_media_edits
         (session_id, media_index, variant, source_path, sha256_original, status, source, updated_at)
       VALUES ($1, 10, 'video_4x5', '/tmp/a.mp4', 'sha-recent', 'processing', 'telegram', NOW())`,
      ['test-recovery'],
    );

    // Stale 1: updated_at = 10 minutes ago
    await db.query(
      `INSERT INTO insta_media_edits
         (session_id, media_index, variant, source_path, sha256_original, status, source, updated_at)
       VALUES ($1, 11, 'video_4x5', '/tmp/b.mp4', 'sha-stale1', 'processing', 'telegram', NOW() - INTERVAL '10 minutes')`,
      ['test-recovery'],
    );

    // Stale 2: updated_at = 30 minutes ago
    await db.query(
      `INSERT INTO insta_media_edits
         (session_id, media_index, variant, source_path, sha256_original, status, source, updated_at)
       VALUES ($1, 12, 'video_4x5', '/tmp/c.mp4', 'sha-stale2', 'processing', 'telegram', NOW() - INTERVAL '30 minutes')`,
      ['test-recovery'],
    );

    const recovered = await recoverStaleJobs();
    expect(recovered).toBe(2);

    // Check DB states
    const { rows } = await db.query<{ media_index: number; status: string }>(
      `SELECT media_index, status FROM insta_media_edits
       WHERE session_id = 'test-recovery' ORDER BY media_index`,
    );

    expect(rows[0].status).toBe('processing'); // recent — not recovered
    expect(rows[1].status).toBe('uploaded');    // stale1 — recovered
    expect(rows[2].status).toBe('uploaded');    // stale2 — recovered

    // Check audit_log
    const { rows: auditRows } = await db.query(
      `SELECT * FROM audit_log
       WHERE module = 'instagram' AND action = 'edit_queue.stale_job_recovered'`,
    );
    expect(auditRows).toHaveLength(2);
  });
});
