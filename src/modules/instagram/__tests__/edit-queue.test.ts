/**
 * Edit Queue Tests (E4a + E4b) — p-queue concurrency, DB status, stale recovery,
 * video_4x5 + cover_frame handlers with real synthetic video.
 *
 * Uses setupTestDb() + audit_log table (same pattern as inbox.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setupTestDb } from './test-db-setup.js';

let cleanup: () => Promise<void>;

// Module references (imported dynamically after DB setup)
let submitJob: typeof import('../edit-queue.js')['submitJob'];
let waitForIdle: typeof import('../edit-queue.js')['waitForIdle'];
let registerJobHandler: typeof import('../edit-queue.js')['registerJobHandler'];
let recoverStaleJobs: typeof import('../edit-queue.js')['recoverStaleJobs'];

// E4b: synthetic video fixture
const TMP_DIR = path.join(import.meta.dir, '.tmp-edit-queue-test');
const FAKE_SESSION = 'test-eq-e4b';
const RAW_BASE = path.join(TMP_DIR, '.openclaw/workspace/artifacts/personal/instagram/raw');
let syntheticMp4RelPath: string;
const origHome = process.env.HOME;

beforeAll(async () => {
  // Create tmp dir + synthetic video BEFORE overriding HOME
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const origDir = path.join(RAW_BASE, FAKE_SESSION, 'original');
  fs.mkdirSync(origDir, { recursive: true });

  const videoPath = path.join(origDir, '260518-jb-01.mp4');
  syntheticMp4RelPath = `${FAKE_SESSION}/original/260518-jb-01.mp4`;
  const { execSync } = await import('node:child_process');
  execSync(
    `ffmpeg -y -f lavfi -i color=c=blue:s=640x480:d=2 -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -an "${videoPath}"`,
    { stdio: 'pipe' },
  );

  process.env.HOME = TMP_DIR;

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
}, 60_000);

afterAll(async () => {
  process.env.HOME = origHome;
  await cleanup();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
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

  // ── E4b: Real video handler tests ───────────────────────────────────────

  test('d. video_4x5 job with real DB row + synthetic video => status=edited, output_path set', async () => {
    const db = await import('../../../shared/db/index.js');

    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO insta_media_edits
         (session_id, media_index, variant, source_path, sha256_original, status, source)
       VALUES ($1, $2, 'video_4x5', $3, 'sha-video-4x5-test', 'uploaded', 'telegram')
       RETURNING id`,
      [FAKE_SESSION, 20, syntheticMp4RelPath],
    );
    const editId = rows[0].id;

    await submitJob({
      editId,
      jobType: 'video_4x5',
      sessionId: FAKE_SESSION,
      mediaIndex: 20,
      sourcePath: syntheticMp4RelPath,
    });

    await waitForIdle();

    const { rows: after } = await db.query<{ status: string; output_path: string }>(
      `SELECT status, output_path FROM insta_media_edits WHERE id = $1`,
      [editId],
    );
    expect(after[0].status).toBe('edited');
    expect(after[0].output_path).toMatch(/video_4x5\.mp4$/);
  }, 30_000);

  test('e. cover_frame job with real DB row => status=edited, output_path set', async () => {
    const db = await import('../../../shared/db/index.js');

    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO insta_media_edits
         (session_id, media_index, variant, source_path, sha256_original, status, source)
       VALUES ($1, $2, 'cover_frame', $3, 'sha-cover-frame-test', 'uploaded', 'telegram')
       RETURNING id`,
      [FAKE_SESSION, 21, syntheticMp4RelPath],
    );
    const editId = rows[0].id;

    await submitJob({
      editId,
      jobType: 'cover_frame',
      sessionId: FAKE_SESSION,
      mediaIndex: 21,
      sourcePath: syntheticMp4RelPath,
      params: { positionSec: 0.5 },
    });

    await waitForIdle();

    const { rows: after } = await db.query<{ status: string; output_path: string }>(
      `SELECT status, output_path FROM insta_media_edits WHERE id = $1`,
      [editId],
    );
    expect(after[0].status).toBe('edited');
    expect(after[0].output_path).toMatch(/cover_frame\.jpg$/);
  }, 30_000);

  // ── E4b: softDeleteVariant + insertEditVariant + submitJob for cover_frame override ──

  test('f. cover_frame override: soft-delete + re-insert + re-enqueue => old deleted, new edited', async () => {
    const db = await import('../../../shared/db/index.js');
    const { softDeleteVariant, insertEditVariant } = await import('../session-helper.js');
    const { computeVideoParamsHash } = await import('../video-edit.js');

    // Insert initial cover_frame row
    const { rows: initRows } = await db.query<{ id: number }>(
      `INSERT INTO insta_media_edits
         (session_id, media_index, variant, source_path, sha256_original, params_hash, status, source)
       VALUES ($1, $2, 'cover_frame', $3, 'sha-override-test', $4, 'edited', 'telegram')
       RETURNING id`,
      [FAKE_SESSION, 30, syntheticMp4RelPath, computeVideoParamsHash('cover_frame', 1.0)],
    );
    const oldEditId = initRows[0].id;

    // Soft-delete
    const deleted = await softDeleteVariant({
      sessionId: FAKE_SESSION, mediaIndex: 30, variant: 'cover_frame',
    });
    expect(deleted).toBe(1);

    // Insert new with different position
    const newEditId = await insertEditVariant({
      sessionId: FAKE_SESSION, mediaIndex: 30, variant: 'cover_frame',
      sourcePath: syntheticMp4RelPath, sha256Original: 'sha-override-test',
      paramsHash: computeVideoParamsHash('cover_frame', 2.0),
      source: 'telegram',
    });
    expect(newEditId).toBeGreaterThan(0);

    // Submit job
    await submitJob({
      editId: newEditId, jobType: 'cover_frame',
      sessionId: FAKE_SESSION, mediaIndex: 30,
      sourcePath: syntheticMp4RelPath,
      params: { positionSec: 0.5 }, // use 0.5 since video is 2s
    });

    await waitForIdle();

    // Old row should be deleted
    const { rows: oldRow } = await db.query<{ status: string }>(
      `SELECT status FROM insta_media_edits WHERE id = $1`,
      [oldEditId],
    );
    expect(oldRow[0].status).toBe('deleted');

    // New row should be edited
    const { rows: newRow } = await db.query<{ status: string; output_path: string }>(
      `SELECT status, output_path FROM insta_media_edits WHERE id = $1`,
      [newEditId],
    );
    expect(newRow[0].status).toBe('edited');
    expect(newRow[0].output_path).toMatch(/cover_frame\.jpg$/);
  }, 30_000);
});
