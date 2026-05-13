/**
 * nk/routes — HTTP endpoint handlers for NK statements and runs.
 * Sprint 5.5b — Etappes f/h/i
 *
 * All handlers are called from assets/routes.ts dispatch.
 * Auth is already checked by the caller.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { parseJsonBody } from '../../util/body-parser.js';
import * as audit from '../../shared/audit/index.js';
import { query as dbQuery, getClient } from '../../shared/db/index.js';
import { createApprovalPreview, validateApprovalToken } from '../../middleware/approval.js';
import { checkIdempotency, completeIdempotency, failIdempotency } from '../../middleware/idempotency.js';
import { canonicalHash } from '../../util/canonical.js';
import { computeNk, ENGINE_VERSION } from './engine.js';
import { buildSnapshot, writeSnapshot } from './snapshot.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function err(res: ServerResponse, status: number, message: string, code?: string) {
  json(res, status, { ok: false, error: message, ...(code ? { code } : {}) });
}

async function resolvePropertyCode(code: string): Promise<number | null> {
  const { rows } = await dbQuery(
    'SELECT id FROM properties WHERE code = $1 AND active = true', [code],
  );
  return rows.length > 0 ? rows[0].id : null;
}

// ── Preview ──────────────────────────────────────────────────────────────────

export async function handleNkPreview(
  req: IncomingMessage,
  res: ServerResponse,
  actor: string,
  _requestId: string,
): Promise<void> {
  if (req.method !== 'POST') { err(res, 405, 'Method not allowed'); return; }

  const body = await parseJsonBody(req);
  if (!body?.property_code || !body?.year) {
    err(res, 400, 'property_code and year required'); return;
  }

  const propertyId = await resolvePropertyCode(body.property_code);
  if (!propertyId) {
    err(res, 404, `Property "${body.property_code}" not found`, 'PROPERTY_NOT_FOUND'); return;
  }

  try {
    const output = await computeNk(propertyId, body.year, false);
    json(res, 200, {
      ok: true,
      ...output,
    });
  } catch (e: any) {
    if (e.code === 'NK_BLOCKED') {
      json(res, 422, {
        ok: false,
        error: e.message,
        code: 'NK_BLOCKED',
        blockers: e.blockers,
      });
    } else {
      err(res, 500, e.message);
    }
  }
}

// ── Finalize ─────────────────────────────────────────────────────────────────

export async function handleNkFinalize(
  req: IncomingMessage,
  res: ServerResponse,
  actor: string,
  requestId: string,
  sessionId: string,
): Promise<void> {
  if (req.method !== 'POST') { err(res, 405, 'Method not allowed'); return; }

  const body = await parseJsonBody(req);
  if (!body?.property_code || !body?.year) {
    err(res, 400, 'property_code and year required'); return;
  }

  const propertyId = await resolvePropertyCode(body.property_code);
  if (!propertyId) {
    err(res, 404, `Property "${body.property_code}" not found`, 'PROPERTY_NOT_FOUND'); return;
  }

  // Approval token validation
  const token = req.headers['x-approval-token'] as string;
  if (!token) {
    err(res, 401, 'X-Approval-Token required'); return;
  }

  const tokenResult = await validateApprovalToken(
    token, sessionId, actor, 'POST', 'nk-statements.finalize', body,
  );
  if (!tokenResult.valid) {
    err(res, 401, tokenResult.error || 'Invalid approval token', tokenResult.code); return;
  }

  // Idempotency check
  const idem = await checkIdempotency(req, actor, 'nk-statements.finalize', body);
  if (idem?.isReplay && idem.replayResponse) {
    json(res, idem.replayResponse.status as number, idem.replayResponse.body);
    return;
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Advisory lock on property+year
    const lockKey = propertyId * 10000 + body.year;
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

    // Recompute engine in finalize mode
    const output = await computeNk(propertyId, body.year, true);

    // Verify input_hash matches preview if provided
    if (body.input_hash && output.run.input_hash !== body.input_hash) {
      await client.query('ROLLBACK');
      if (idem) await failIdempotency(actor, 'nk-statements.finalize', idem.key).catch(() => {});
      err(res, 409, 'Input data changed since preview — please re-preview', 'INPUT_HASH_MISMATCH');
      return;
    }

    // Get next version
    const { rows: versionRows } = await client.query(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM nk_statement_runs WHERE property_id = $1 AND period_year = $2',
      [propertyId, body.year],
    );
    const version = versionRows[0].next_version;

    // INSERT run
    const { rows: runRows } = await client.query(
      `INSERT INTO nk_statement_runs (property_id, period_year, version, status, engine_version, input_hash, finalized_at)
       VALUES ($1, $2, $3, 'calculated', $4, $5, now()) RETURNING id`,
      [propertyId, body.year, version, ENGINE_VERSION, output.run.input_hash],
    );
    const runId = runRows[0].id;

    // INSERT statements
    for (const stmt of output.statements) {
      const { rows: stmtRows } = await client.query(
        `INSERT INTO nk_statements (run_id, lease_id, is_owner_block, active_days,
         costs_total, advance_total, balance, rounding_adjustment, tenant_recipients, pdf_render_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending') RETURNING id`,
        [runId, stmt.lease_id, stmt.is_owner_block, stmt.active_days,
         stmt.costs_total, stmt.advance_total, stmt.balance, stmt.rounding_adjustment,
         stmt.tenant_recipients ? JSON.stringify(stmt.tenant_recipients) : null],
      );
      const stmtId = stmtRows[0].id;

      // INSERT items
      for (const item of stmt.items) {
        await client.query(
          `INSERT INTO nk_statement_items (statement_id, item_type, cost_category_id, allocation_rule_id,
           related_lease_id, total_property, allocation_basis, share_numerator, share_denominator,
           share_fraction, amount, rounding_remainder, source_booking_ids, notes, metadata_jsonb)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [stmtId, item.item_type, item.cost_category_id, item.allocation_rule_id,
           item.related_lease_id, item.total_property, item.allocation_basis,
           item.share_numerator, item.share_denominator, item.share_fraction,
           item.amount, item.rounding_remainder,
           item.source_booking_ids.length > 0 ? item.source_booking_ids : null,
           item.notes, item.metadata_jsonb ? JSON.stringify(item.metadata_jsonb) : null],
        );
      }
    }

    // Write snapshot
    const heatingResult = await dbQuery(
      'SELECT * FROM property_heating_config WHERE property_id = $1 AND year = $2',
      [propertyId, body.year],
    );
    const snapshotData = buildSnapshot(output, heatingResult.rows[0] || null);
    const snapshotResult = await writeSnapshot(runId, snapshotData);

    // Update run with snapshot info + status
    await client.query(
      `UPDATE nk_statement_runs SET status = 'pdf_pending', snapshot_path = $1,
       snapshot_sha256 = $2, snapshot_size_bytes = $3 WHERE id = $4`,
      [snapshotResult.path, snapshotResult.sha256, snapshotResult.size_bytes, runId],
    );

    // Update obligations: set active_run_id, status, service_deadline_at
    const serviceDeadline = `${body.year + 1}-12-31`; // period_end + 12 months
    await client.query(
      `UPDATE nk_period_obligations SET active_run_id = $1, status = 'active_run',
       service_deadline_at = $2 WHERE property_id = $3 AND year = $4`,
      [runId, serviceDeadline, propertyId, body.year],
    );

    await client.query('COMMIT');

    // Complete idempotency
    const result = {
      ok: true,
      run_id: runId,
      version,
      statements_count: output.statements.length,
      input_hash: output.run.input_hash,
      snapshot_sha256: snapshotResult.sha256,
    };

    if (idem) {
      await completeIdempotency(actor, 'nk-statements.finalize', idem.key, 201, result).catch(() => {});
    }

    await audit.log({
      module: 'assets',
      action: 'nk.finalize',
      entityType: 'nk_statement_run',
      entityId: String(runId),
      after: { run_id: runId, version, property_id: propertyId, year: body.year },
    });

    json(res, 201, result);
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (idem) await failIdempotency(actor, 'nk-statements.finalize', idem.key).catch(() => {});

    if (e.code === 'NK_BLOCKED') {
      json(res, 422, { ok: false, error: e.message, code: 'NK_BLOCKED', blockers: e.blockers });
    } else {
      err(res, 500, e.message);
    }
  } finally {
    client.release();
  }
}

// ── Statement Read ───────────────────────────────────────────────────────────

export async function handleNkStatementRead(
  req: IncomingMessage,
  res: ServerResponse,
  statementId: string,
): Promise<void> {
  if (req.method !== 'GET') { err(res, 405, 'Method not allowed'); return; }

  const { rows } = await dbQuery(
    `SELECT s.*, r.property_id, r.period_year, r.version, r.status AS run_status,
     r.snapshot_sha256, r.engine_version
     FROM nk_statements s JOIN nk_statement_runs r ON s.run_id = r.id
     WHERE s.id = $1`, [statementId],
  );
  if (rows.length === 0) { err(res, 404, 'Statement not found'); return; }

  // Load items
  const { rows: items } = await dbQuery(
    'SELECT * FROM nk_statement_items WHERE statement_id = $1 ORDER BY id', [statementId],
  );

  json(res, 200, { ok: true, statement: rows[0], items });
}

// ── Statement PDF Download ───────────────────────────────────────────────────

export async function handleNkStatementPdf(
  req: IncomingMessage,
  res: ServerResponse,
  statementId: string,
): Promise<void> {
  if (req.method !== 'GET') { err(res, 405, 'Method not allowed'); return; }

  const { rows } = await dbQuery(
    `SELECT s.pdf_path, s.pdf_sha256, s.pdf_render_status, s.pdf_size_bytes,
     r.status AS run_status, r.superseded_at
     FROM nk_statements s JOIN nk_statement_runs r ON s.run_id = r.id
     WHERE s.id = $1`, [statementId],
  );
  if (rows.length === 0) { err(res, 404, 'Statement not found'); return; }

  const stmt = rows[0];
  if (stmt.pdf_render_status !== 'ready' || !stmt.pdf_path) {
    err(res, 404, 'PDF not ready', 'PDF_NOT_READY'); return;
  }

  if (!existsSync(stmt.pdf_path)) {
    err(res, 404, 'PDF file not found on disk'); return;
  }

  const fileStat = await stat(stmt.pdf_path);
  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'Content-Length': String(fileStat.size),
    'Content-Disposition': `inline; filename="statement-${statementId}.pdf"`,
  };

  if (stmt.superseded_at) {
    headers['X-Superseded'] = 'true';
  }

  res.writeHead(200, headers);
  createReadStream(stmt.pdf_path).pipe(res);
}

// ── Re-Render ────────────────────────────────────────────────────────────────

export async function handleNkRerender(
  req: IncomingMessage,
  res: ServerResponse,
  statementId: string,
  actor: string,
): Promise<void> {
  if (req.method !== 'POST') { err(res, 405, 'Method not allowed'); return; }

  const { rows } = await dbQuery(
    `SELECT s.id, s.pdf_render_status, s.pdf_render_attempts, s.served_at,
     r.status AS run_status, r.superseded_at
     FROM nk_statements s JOIN nk_statement_runs r ON s.run_id = r.id
     WHERE s.id = $1`, [statementId],
  );
  if (rows.length === 0) { err(res, 404, 'Statement not found'); return; }

  const stmt = rows[0];

  if (stmt.superseded_at) {
    err(res, 422, 'Cannot re-render superseded statement', 'SUPERSEDED'); return;
  }
  if (stmt.served_at) {
    err(res, 422, 'Cannot re-render served statement', 'ALREADY_SERVED'); return;
  }
  if (stmt.pdf_render_attempts >= 5) {
    err(res, 422, 'Maximum retry attempts (5) exceeded', 'MAX_RETRY_EXCEEDED'); return;
  }

  // Allow re-render if failed or stale rendering (>10 min)
  if (stmt.pdf_render_status === 'ready') {
    err(res, 422, 'PDF already rendered', 'ALREADY_READY'); return;
  }
  if (stmt.pdf_render_status === 'rendering') {
    // Check if stale (>10 minutes)
    const { rows: staleRows } = await dbQuery(
      `SELECT id FROM nk_statements WHERE id = $1 AND pdf_render_status = 'rendering'
       AND updated_at < now() - interval '10 minutes'`, [statementId],
    );
    if (staleRows.length === 0) {
      err(res, 422, 'Rendering in progress', 'RENDERING_IN_PROGRESS'); return;
    }
  }

  // Reset to pending
  await dbQuery(
    `UPDATE nk_statements SET pdf_render_status = 'pending', pdf_render_error = NULL,
     pdf_render_attempts = pdf_render_attempts + 1 WHERE id = $1`, [statementId],
  );

  // If run was failed, set back to pdf_pending
  if (stmt.run_status === 'pdf_failed') {
    await dbQuery(
      `UPDATE nk_statement_runs SET status = 'pdf_pending' WHERE id = (
        SELECT run_id FROM nk_statements WHERE id = $1
      )`, [statementId],
    );
  }

  await audit.log({
    module: 'assets',
    action: 'nk.rerender',
    entityType: 'nk_statement',
    entityId: statementId,
    after: { attempts: stmt.pdf_render_attempts + 1 },
  });

  json(res, 200, { ok: true, pdf_render_status: 'pending', attempts: stmt.pdf_render_attempts + 1 });
}

// ── Serve ────────────────────────────────────────────────────────────────────

export async function handleNkServe(
  req: IncomingMessage,
  res: ServerResponse,
  statementId: string,
  actor: string,
  sessionId: string,
): Promise<void> {
  if (req.method !== 'POST') { err(res, 405, 'Method not allowed'); return; }

  const body = await parseJsonBody(req);

  // Approval token
  const token = req.headers['x-approval-token'] as string;
  if (!token) {
    err(res, 401, 'X-Approval-Token required'); return;
  }

  const tokenResult = await validateApprovalToken(
    token, sessionId, actor, 'POST', 'nk-statements.serve', body,
  );
  if (!tokenResult.valid) {
    err(res, 401, tokenResult.error || 'Invalid approval token', tokenResult.code); return;
  }

  const { rows } = await dbQuery(
    `SELECT s.*, r.status AS run_status, r.superseded_at, r.id AS run_id
     FROM nk_statements s JOIN nk_statement_runs r ON s.run_id = r.id
     WHERE s.id = $1`, [statementId],
  );
  if (rows.length === 0) { err(res, 404, 'Statement not found'); return; }

  const stmt = rows[0];

  // Pre-checks per §4.5
  if (stmt.is_owner_block) {
    err(res, 422, 'Owner block cannot be served', 'OWNER_BLOCK_NOT_SERVABLE'); return;
  }
  if (stmt.superseded_at) {
    err(res, 422, 'Cannot serve superseded statement', 'SUPERSEDED'); return;
  }
  if (stmt.run_status === 'pdf_failed') {
    err(res, 422, 'Cannot serve statement with failed PDF', 'PDF_FAILED'); return;
  }
  if (stmt.pdf_render_status !== 'ready' || !stmt.pdf_sha256) {
    err(res, 422, 'PDF not ready', 'PDF_NOT_READY'); return;
  }
  if (stmt.served_at) {
    err(res, 409, 'Statement already served', 'ALREADY_SERVED'); return;
  }

  const servedAt = body?.served_at || new Date().toISOString();
  const servedDate = new Date(servedAt);
  if (servedDate > new Date()) {
    err(res, 422, 'served_at cannot be in the future', 'FUTURE_DATE'); return;
  }

  // Update served fields (lock trigger will protect after this)
  await dbQuery(
    `UPDATE nk_statements SET served_at = $1, served_method = $2, served_note = $3
     WHERE id = $4`,
    [servedAt, body?.served_method || null, body?.served_note || null, statementId],
  );

  // Check if all tenant statements in run are served → update run status
  const { rows: runStats } = await dbQuery(
    `SELECT
       COUNT(*) FILTER (WHERE NOT is_owner_block) AS total_tenant,
       COUNT(*) FILTER (WHERE NOT is_owner_block AND served_at IS NOT NULL) AS served_tenant
     FROM nk_statements WHERE run_id = $1`, [stmt.run_id],
  );

  const { total_tenant, served_tenant } = runStats[0];
  let newRunStatus: string;
  if (parseInt(served_tenant) >= parseInt(total_tenant)) {
    newRunStatus = 'served';
  } else if (parseInt(served_tenant) > 0) {
    newRunStatus = 'served_partial';
  } else {
    newRunStatus = stmt.run_status;
  }

  if (newRunStatus !== stmt.run_status) {
    await dbQuery('UPDATE nk_statement_runs SET status = $1 WHERE id = $2', [newRunStatus, stmt.run_id]);
  }

  // If all served, update obligation
  if (newRunStatus === 'served') {
    await dbQuery(
      `UPDATE nk_period_obligations SET status = 'served'
       WHERE active_run_id = $1`, [stmt.run_id],
    );
  }

  await audit.log({
    module: 'assets',
    action: 'nk.serve',
    entityType: 'nk_statement',
    entityId: statementId,
    after: { served_at: servedAt, served_method: body?.served_method, run_status: newRunStatus },
  });

  json(res, 200, { ok: true, served_at: servedAt, run_status: newRunStatus });
}

// ── Run List ─────────────────────────────────────────────────────────────────

export async function handleNkRunList(
  req: IncomingMessage,
  res: ServerResponse,
  query: Record<string, string>,
): Promise<void> {
  if (req.method !== 'GET') { err(res, 405, 'Method not allowed'); return; }

  let sql = 'SELECT r.*, p.code AS property_code FROM nk_statement_runs r JOIN properties p ON r.property_id = p.id';
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (query.property_code) {
    const propId = await resolvePropertyCode(query.property_code);
    if (!propId) { json(res, 200, { ok: true, runs: [] }); return; }
    conditions.push(`r.property_id = $${params.length + 1}`);
    params.push(propId);
  }
  if (query.year) {
    conditions.push(`r.period_year = $${params.length + 1}`);
    params.push(parseInt(query.year));
  }

  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY r.period_year DESC, r.version DESC';

  const { rows } = await dbQuery(sql, params);
  json(res, 200, { ok: true, runs: rows });
}

// ── Run Detail ───────────────────────────────────────────────────────────────

export async function handleNkRunDetail(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  if (req.method !== 'GET') { err(res, 405, 'Method not allowed'); return; }

  const { rows: runRows } = await dbQuery(
    `SELECT r.*, p.code AS property_code FROM nk_statement_runs r
     JOIN properties p ON r.property_id = p.id WHERE r.id = $1`, [runId],
  );
  if (runRows.length === 0) { err(res, 404, 'Run not found'); return; }

  const { rows: statements } = await dbQuery(
    'SELECT * FROM nk_statements WHERE run_id = $1 ORDER BY id', [runId],
  );

  // Load items per statement
  const statementsWithItems = [];
  for (const stmt of statements) {
    const { rows: items } = await dbQuery(
      'SELECT * FROM nk_statement_items WHERE statement_id = $1 ORDER BY id', [stmt.id],
    );
    statementsWithItems.push({ ...stmt, items });
  }

  json(res, 200, { ok: true, run: runRows[0], statements: statementsWithItems });
}
