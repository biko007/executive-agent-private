/**
 * pdf-worker — Standalone PDF rendering worker for NK statements.
 * Sprint 5.5b — Etappe g
 *
 * Polls nk_statements with pdf_render_status='pending', renders HTML→PDF
 * via Playwright Chromium, writes PDF files atomically.
 *
 * Run as: node dist/src/pdf-worker.js
 * Or via systemd: openclaw-pdf-worker.service
 */
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { createHash } from 'node:crypto';
import { writeFile, mkdir, rename, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { config } from 'dotenv';
import pg from 'pg';

import { renderStatementHtml, validatePreRenderCompleteness } from './modules/nk/pdf-template.js';
import { readSnapshot } from './modules/nk/snapshot.js';

// Load env
config({ path: join(homedir(), '.config/openclaw/env') });

const POLL_INTERVAL_MS = 30_000;
const BATCH_SIZE = 50;
const ARTIFACTS_DIR = join(homedir(), '.openclaw/workspace/artifacts/personal/nk-statements');
const PROP_CODE_RE = /^[A-Z0-9_-]{1,16}$/;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
  }
  return pool;
}

async function query<T extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(sql, params);
}

// ── Main Poll Loop ──────────────────────────────────────────────────────────

async function pollAndRender(): Promise<void> {
  // Find pending statements (with 5s delay to avoid race with finalize)
  const { rows: pending } = await query(
    `SELECT s.id, s.run_id, s.lease_id, s.is_owner_block, s.tenant_recipients,
            s.active_days, s.costs_total, s.advance_total, s.balance, s.rounding_adjustment,
            s.pdf_render_attempts
     FROM nk_statements s
     WHERE s.pdf_render_status = 'pending'
       AND s.created_at < now() - interval '5 seconds'
     ORDER BY s.created_at
     LIMIT $1`,
    [BATCH_SIZE],
  );

  if (pending.length === 0) return;

  // Group by run_id
  const byRun = new Map<number, typeof pending>();
  for (const row of pending) {
    const list = byRun.get(row.run_id) || [];
    list.push(row);
    byRun.set(row.run_id, list);
  }

  // One browser per batch (reuse across runs)
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });

    for (const [runId, statements] of byRun) {
      await renderRun(browser, runId, statements);
    }
  } catch (e: any) {
    console.error('[pdf-worker] Browser error:', e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function renderRun(browser: Browser, runId: number, statements: any[]): Promise<void> {
  // Load run info
  const { rows: runRows } = await query(
    `SELECT r.*, p.code AS property_code, p.name AS property_name,
            p.street AS property_street, p.postal_code AS property_postal_code,
            p.city AS property_city, p.owner AS property_owner
     FROM nk_statement_runs r JOIN properties p ON r.property_id = p.id
     WHERE r.id = $1`,
    [runId],
  );
  if (runRows.length === 0) {
    console.error(`[pdf-worker] Run ${runId} not found, skipping`);
    return;
  }
  const run = runRows[0];

  // Validate property code for path safety
  if (!PROP_CODE_RE.test(run.property_code)) {
    console.error(`[pdf-worker] Invalid property_code: ${run.property_code}, skipping run ${runId}`);
    for (const stmt of statements) {
      await markFailed(stmt.id, `Invalid property_code: ${run.property_code}`);
    }
    return;
  }

  // Load snapshot
  let snapshot: Record<string, unknown>;
  try {
    if (!run.snapshot_path) throw new Error('No snapshot_path on run');
    snapshot = await readSnapshot(run.snapshot_path);
  } catch (e: any) {
    console.error(`[pdf-worker] Failed to read snapshot for run ${runId}:`, e.message);
    for (const stmt of statements) {
      await markFailed(stmt.id, `Snapshot read error: ${e.message}`);
    }
    return;
  }

  // Load cost category names
  const { rows: categories } = await query('SELECT id, name FROM cost_categories');
  const categoryNames = new Map<number, string>();
  for (const cat of categories) categoryNames.set(cat.id, cat.name);

  // Load items per statement from snapshot
  const snapshotStatements = (snapshot.statements || []) as Array<Record<string, unknown>>;

  let allOk = true;

  for (const stmt of statements) {
    try {
      // Mark as rendering
      await query(
        `UPDATE nk_statements SET pdf_render_status = 'rendering' WHERE id = $1 AND pdf_render_status = 'pending'`,
        [stmt.id],
      );

      // Find matching statement in snapshot
      const snapshotStmt = snapshotStatements.find(
        (s: any) => s.lease_id === stmt.lease_id && s.is_owner_block === stmt.is_owner_block,
      );
      if (!snapshotStmt) {
        await markFailed(stmt.id, 'Statement not found in snapshot');
        allOk = false;
        continue;
      }

      // Parse recipients
      const recipients = stmt.tenant_recipients
        ? (typeof stmt.tenant_recipients === 'string' ? JSON.parse(stmt.tenant_recipients) : stmt.tenant_recipients)
        : null;

      // Validate recipients
      const validationError = validatePreRenderCompleteness(recipients, stmt.is_owner_block);
      if (validationError) {
        await markFailed(stmt.id, validationError);
        allOk = false;
        continue;
      }

      // Render HTML
      const html = renderStatementHtml(snapshot, snapshotStmt, recipients, categoryNames);

      // Render PDF via Playwright
      const page = await browser.newPage();
      try {
        // Block external requests
        await page.route('**/*', (route) => {
          const url = route.request().url();
          if (url.startsWith('data:') || url.startsWith('about:')) {
            route.continue();
          } else {
            route.abort();
          }
        });

        await page.setContent(html, { waitUntil: 'networkidle' });
        const pdfBuffer = await page.pdf({
          format: 'A4',
          margin: { top: '20mm', bottom: '25mm', left: '15mm', right: '15mm' },
          printBackground: true,
        });

        // Write PDF atomically
        const stmtLabel = stmt.is_owner_block ? 'owner' : `lease-${stmt.lease_id}`;
        const pdfDir = join(ARTIFACTS_DIR, run.property_code, String(run.period_year), `run-${runId}`);
        await mkdir(pdfDir, { recursive: true });

        const pdfPath = join(pdfDir, `${stmtLabel}.pdf`);
        const tmpPath = pdfPath + '.tmp';
        await writeFile(tmpPath, pdfBuffer);
        await rename(tmpPath, pdfPath);

        const sha256 = createHash('sha256').update(pdfBuffer).digest('hex');

        // Update DB
        await query(
          `UPDATE nk_statements SET pdf_render_status = 'ready', pdf_path = $1,
           pdf_sha256 = $2, pdf_size_bytes = $3
           WHERE id = $4`,
          [pdfPath, sha256, pdfBuffer.length, stmt.id],
        );

        console.log(`[pdf-worker] Rendered ${pdfPath} (${pdfBuffer.length} bytes)`);
      } finally {
        await page.close();
      }
    } catch (e: any) {
      console.error(`[pdf-worker] Failed to render statement ${stmt.id}:`, e.message);
      await markFailed(stmt.id, e.message);
      allOk = false;
    }
  }

  // Update run status
  await updateRunStatus(runId, allOk);
}

async function markFailed(statementId: number, error: string): Promise<void> {
  const truncated = error.slice(0, 500);
  await query(
    `UPDATE nk_statements SET pdf_render_status = 'failed', pdf_render_error = $1 WHERE id = $2`,
    [truncated, statementId],
  ).catch(e => console.error(`[pdf-worker] Failed to mark ${statementId} as failed:`, e.message));
}

async function updateRunStatus(runId: number, allRenderedOk: boolean): Promise<void> {
  // Check actual state of all statements in this run
  const { rows } = await query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE pdf_render_status = 'ready') AS ready,
       COUNT(*) FILTER (WHERE pdf_render_status = 'failed') AS failed,
       COUNT(*) FILTER (WHERE pdf_render_status IN ('pending', 'rendering')) AS remaining
     FROM nk_statements WHERE run_id = $1`,
    [runId],
  );

  const { total, ready, failed, remaining } = rows[0];

  if (parseInt(remaining) > 0) {
    // Still work to do, leave as pdf_pending
    return;
  }

  if (parseInt(ready) === parseInt(total)) {
    // All ready → pdf_ready, supersede older runs
    await query(`UPDATE nk_statement_runs SET status = 'pdf_ready' WHERE id = $1`, [runId]);
    await supersedeOlderRuns(runId);
    console.log(`[pdf-worker] Run ${runId}: all ${total} PDFs ready`);
  } else if (parseInt(failed) > 0) {
    await query(`UPDATE nk_statement_runs SET status = 'pdf_failed' WHERE id = $1`, [runId]);
    console.log(`[pdf-worker] Run ${runId}: ${failed}/${total} failed`);
  }
}

async function supersedeOlderRuns(runId: number): Promise<void> {
  // Get property+year for this run
  const { rows } = await query(
    'SELECT property_id, period_year FROM nk_statement_runs WHERE id = $1', [runId],
  );
  if (rows.length === 0) return;
  const { property_id, period_year } = rows[0];

  // Supersede older runs (same property+year, different run, not already superseded)
  await query(
    `UPDATE nk_statement_runs SET superseded_at = now(), status = 'superseded'
     WHERE property_id = $1 AND period_year = $2 AND id != $3 AND superseded_at IS NULL`,
    [property_id, period_year, runId],
  );
}

// ── Entry Point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[pdf-worker] Starting PDF worker...');
  console.log(`[pdf-worker] Poll interval: ${POLL_INTERVAL_MS}ms, batch size: ${BATCH_SIZE}`);
  console.log(`[pdf-worker] Output dir: ${ARTIFACTS_DIR}`);

  // Verify DB connection
  try {
    await query('SELECT 1');
    console.log('[pdf-worker] Database connected');
  } catch (e: any) {
    console.error('[pdf-worker] Database connection failed:', e.message);
    process.exit(1);
  }

  // Verify Chromium
  try {
    const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    await b.close();
    console.log('[pdf-worker] Chromium available');
  } catch (e: any) {
    console.error('[pdf-worker] Chromium launch failed:', e.message);
    process.exit(1);
  }

  // Poll loop
  const tick = async () => {
    try {
      await pollAndRender();
    } catch (e: any) {
      console.error('[pdf-worker] Poll error:', e.message);
    }
  };

  // Initial poll
  await tick();

  // Schedule recurring
  setInterval(tick, POLL_INTERVAL_MS);
}

main().catch(e => {
  console.error('[pdf-worker] Fatal:', e);
  process.exit(1);
});
