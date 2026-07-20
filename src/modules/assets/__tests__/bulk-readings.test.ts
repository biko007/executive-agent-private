/**
 * assets/__tests__/bulk-readings.test.ts — Atomic bulk meter readings tests.
 * Sprint 11 — Etappe 1
 *
 * Tests: transaction atomicity, idempotency, audit logging, pool release.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { assertSafeDbUrl } from '../../../core/db-guard.js';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Test DB Setup ───────────────────────────────────────────────────────────

let testPool: pg.Pool;
let adminPool: pg.Pool;
let testDbName: string;
let prodUrl: string;

function ensurePostgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL not set');
  const content = readFileSync(envFile, 'utf-8');
  const match = content.match(/^POSTGRES_URL=(.+)$/m);
  if (!match) throw new Error('POSTGRES_URL not found');
  process.env.POSTGRES_URL = match[1];
  return match[1];
}

async function setupTestDb() {
  prodUrl = ensurePostgresUrl();
  testDbName = `openclaw_test_bulk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const testUrl = prodUrl.replace(/\/[^/?]+(\?|$)/, `/${testDbName}$1`);

  adminPool = new pg.Pool({ connectionString: prodUrl });
  await adminPool.query(`CREATE DATABASE "${testDbName}"`);

  testPool = new pg.Pool({ connectionString: testUrl });

  // schema_version
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      module TEXT NOT NULL, version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (module, version)
    )
  `);
  await testPool.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

  // Apply V022 (assets tables) + V023 (assets foundation — idempotency_keys) + V030 (extension)
  const v022Sql = readFileSync(join(__dirname, '../migrations/V022__assets_tables.sql'), 'utf-8');
  await testPool.query(v022Sql);

  const v023Sql = readFileSync(join(__dirname, '../migrations/V023__assets_foundation.sql'), 'utf-8');
  await testPool.query(v023Sql);

  const v030Sql = readFileSync(join(__dirname, '../migrations/V030__assets_extension.sql'), 'utf-8');
  await testPool.query(v030Sql);

  // audit_log table (from 001_core_tables.sql schema)
  await testPool.query(`
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

  process.env.POSTGRES_URL = testUrl;
  assertSafeDbUrl(testUrl);
}

async function cleanupTestDb() {
  try {
    const db = await import('../../../shared/db/index.js');
    await db.closePool();
  } catch {}
  if (testPool) { try { await testPool.end(); } catch {} }
  if (adminPool) {
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [testDbName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    } catch {}
    try { await adminPool.end(); } catch {}
  }
  process.env.POSTGRES_URL = prodUrl;
  try {
    const db2 = await import('../../../shared/db/index.js');
    await db2.closePool();
  } catch {}
}

// ── Fixtures ────────────────────────────────────────────────────────────────

let meterId: number;

async function seedFixtures() {
  const { rows: propRows } = await testPool.query(
    `INSERT INTO properties (code, name, street, postal_code, city, property_type, owner, heating_type, co2_cost_relevant)
     VALUES ('BULK-TEST', 'Bulk Test Property', 'Teststr. 1', '12345', 'Berlin', 'residential', 'Test Owner', 'none', false) RETURNING id`,
  );
  const propertyId = propRows[0].id;

  const { rows: unitRows } = await testPool.query(
    `INSERT INTO units (property_id, code, unit_type, living_area_qm) VALUES ($1, 'W1', 'apartment', 60) RETURNING id`,
    [propertyId],
  );
  const unitId = unitRows[0].id;

  const { rows: meterRows } = await testPool.query(
    `INSERT INTO meters (scope_type, unit_id, medium, meter_number, active)
     VALUES ('unit', $1, 'cold_water', 'M-BULK-001', true) RETURNING id`,
    [unitId],
  );
  meterId = meterRows[0].id;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeReadings(count: number, opts?: { valueFn?: (i: number) => number }) {
  return Array.from({ length: count }, (_, i) => ({
    value: opts?.valueFn ? opts.valueFn(i) : 100 + i,
    unit: 'm3',
    reading_type: 'annual',
    read_at: `2025-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    source: 'manual',
  }));
}

// ── Module imports (after DB setup) ─────────────────────────────────────────

let getClient: typeof import('../../../shared/db/index.js')['getClient'];
let dbQuery: typeof import('../../../shared/db/index.js')['query'];
let checkIdempotency: typeof import('../../../middleware/idempotency.js')['checkIdempotency'];
let completeIdempotency: typeof import('../../../middleware/idempotency.js')['completeIdempotency'];
let failIdempotency: typeof import('../../../middleware/idempotency.js')['failIdempotency'];
let canonicalHash: typeof import('../../../util/canonical.js')['canonicalHash'];

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestDb();
  await seedFixtures();

  const db = await import('../../../shared/db/index.js');
  getClient = db.getClient;
  dbQuery = db.query;

  const idem = await import('../../../middleware/idempotency.js');
  checkIdempotency = idem.checkIdempotency;
  completeIdempotency = idem.completeIdempotency;
  failIdempotency = idem.failIdempotency;

  const canon = await import('../../../util/canonical.js');
  canonicalHash = canon.canonicalHash;
});

afterAll(async () => {
  await cleanupTestDb();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Bulk Meter Readings — Atomic + Idempotency (Sprint 11.1)', () => {

  // T1: Happy-Path — 10 readings → all persisted, 1 audit entry
  it('T1: inserts all readings atomically with audit entry', async () => {
    const readings = makeReadings(10);
    const body = { readings };
    const idempotencyKey = `bulk-t1-${Date.now()}`;
    const actor = 'test-actor';
    const requestId = `req-t1-${Date.now()}`;

    // Simulate the handler logic directly against the DB
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const results: any[] = [];
      const sorted = [...readings].sort((a, b) =>
        new Date(a.read_at).getTime() - new Date(b.read_at).getTime()
      );

      for (const r of sorted) {
        const { rows } = await client.query(
          `INSERT INTO meter_readings (meter_id, value, unit, reading_type, read_at, source, is_estimated)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [meterId, r.value, r.unit, r.reading_type, r.read_at, r.source, false]
        );
        results.push(rows[0]);
      }

      const readingIds = results.map((r: any) => r.id);
      await client.query(
        `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source, request_id)
         VALUES ($1, 'assets', 'meter_reading.bulk_create', 'meter', $2, $3, 'dashboard', $4)`,
        [actor, String(meterId), JSON.stringify({ count: results.length, reading_ids: readingIds }), requestId]
      );

      await client.query('COMMIT');

      // Verify: all 10 readings persisted
      const { rows: allReadings } = await testPool.query(
        'SELECT * FROM meter_readings WHERE meter_id = $1 ORDER BY read_at', [meterId]
      );
      expect(allReadings.length).toBe(10);

      // Verify: 1 audit entry with correct count + reading_ids
      const { rows: auditRows } = await testPool.query(
        `SELECT * FROM audit_log WHERE action = 'meter_reading.bulk_create' AND request_id = $1`, [requestId]
      );
      expect(auditRows.length).toBe(1);
      const auditData = auditRows[0].after_jsonb;
      expect(auditData.count).toBe(10);
      expect(auditData.reading_ids.length).toBe(10);
    } finally {
      client.release();
    }
  });

  // T2: Partial-Failure — constraint violation → full ROLLBACK, 0 new rows, no audit
  it('T2: rolls back all readings on constraint violation (value < 0)', async () => {
    const requestId = `req-t2-${Date.now()}`;
    const actor = 'test-actor';

    // Count existing readings before the attempt
    const { rows: beforeCount } = await testPool.query(
      'SELECT count(*)::int AS cnt FROM meter_readings WHERE meter_id = $1', [meterId]
    );
    const countBefore = beforeCount[0].cnt;

    const readings = [
      { value: 200, unit: 'm3', read_at: '2025-06-01T10:00:00Z', source: 'manual' },
      { value: -1, unit: 'm3', read_at: '2025-06-02T10:00:00Z', source: 'manual' }, // violates CHECK (value >= 0)
      { value: 202, unit: 'm3', read_at: '2025-06-03T10:00:00Z', source: 'manual' },
    ];

    const client = await getClient();
    let threw = false;
    try {
      await client.query('BEGIN');

      for (const r of readings) {
        await client.query(
          `INSERT INTO meter_readings (meter_id, value, unit, reading_type, read_at, source, is_estimated)
           VALUES ($1,$2,$3,'annual',$4,$5,false)`,
          [meterId, r.value, r.unit, r.read_at, r.source]
        );
      }

      await client.query(
        `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source, request_id)
         VALUES ($1, 'assets', 'meter_reading.bulk_create', 'meter', $2, $3, 'dashboard', $4)`,
        [actor, String(meterId), JSON.stringify({ count: 3, reading_ids: [] }), requestId]
      );

      await client.query('COMMIT');
    } catch (e: any) {
      threw = true;
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(threw).toBe(true);

    // Verify: 0 new rows
    const { rows: afterCount } = await testPool.query(
      'SELECT count(*)::int AS cnt FROM meter_readings WHERE meter_id = $1', [meterId]
    );
    expect(afterCount[0].cnt).toBe(countBefore);

    // Verify: no audit entry
    const { rows: auditRows } = await testPool.query(
      `SELECT * FROM audit_log WHERE action = 'meter_reading.bulk_create' AND request_id = $1`, [requestId]
    );
    expect(auditRows.length).toBe(0);
  });

  // T3: Idempotency-Identical — pre-insert succeeded entry → replay cached response
  it('T3: replays cached response for identical idempotency key', async () => {
    const key = `bulk-t3-${Date.now()}`;
    const actor = 'test-actor';
    const endpointKey = 'meter-readings.bulk';
    const body = { readings: makeReadings(3) };
    const bodyHash = canonicalHash(body);

    // Pre-insert a succeeded idempotency entry
    const cachedResponse = { ok: true, created: 3, readings: [] };
    await testPool.query(
      `INSERT INTO idempotency_keys (actor, endpoint_key, key, body_hash, status, response_status, response_body)
       VALUES ($1, $2, $3, $4, 'succeeded', 201, $5)`,
      [actor, endpointKey, key, bodyHash, JSON.stringify(cachedResponse)]
    );

    // Build a minimal mock req with the idempotency-key header
    const mockReq = { headers: { 'idempotency-key': key } } as any;

    const ctx = await checkIdempotency(mockReq, actor, endpointKey, body);

    expect(ctx).not.toBeNull();
    expect(ctx!.isReplay).toBe(true);
    expect(ctx!.replayResponse).toBeDefined();
    expect(ctx!.replayResponse!.status).toBe(201);
    expect(ctx!.replayResponse!.body).toEqual(cachedResponse);
  });

  // T4: Idempotency-Conflict — same key, different body hash → 422 (IDEMPOTENCY_BODY_MISMATCH)
  it('T4: throws 422 IDEMPOTENCY_BODY_MISMATCH for same key, different body', async () => {
    const key = `bulk-t4-${Date.now()}`;
    const actor = 'test-actor';
    const endpointKey = 'meter-readings.bulk';
    const originalBody = { readings: makeReadings(3) };
    const originalHash = canonicalHash(originalBody);

    // Pre-insert with original body hash
    await testPool.query(
      `INSERT INTO idempotency_keys (actor, endpoint_key, key, body_hash, status, response_status, response_body)
       VALUES ($1, $2, $3, $4, 'succeeded', 201, '{}')`,
      [actor, endpointKey, key, originalHash]
    );

    // Attempt with different body
    const differentBody = { readings: makeReadings(5) };
    const mockReq = { headers: { 'idempotency-key': key } } as any;

    try {
      await checkIdempotency(mockReq, actor, endpointKey, differentBody);
      expect(true).toBe(false); // should not reach here
    } catch (e: any) {
      expect(e.status).toBe(422);
      expect(e.code).toBe('IDEMPOTENCY_BODY_MISMATCH');
    }
  });

  // T5: Idempotency-Missing — no header → checkIdempotency returns null
  it('T5: checkIdempotency returns null when no Idempotency-Key header', async () => {
    const mockReq = { headers: {} } as any;
    const ctx = await checkIdempotency(mockReq, 'test-actor', 'meter-readings.bulk', { readings: [] });
    expect(ctx).toBeNull();
  });

  // T6: Pool-Release — force error mid-transaction → ROLLBACK + release → next getClient() succeeds
  it('T6: releases pool client after error mid-transaction', async () => {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      // Force an error
      await client.query('SELECT * FROM nonexistent_table_xyz');
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Next getClient() should succeed (pool not exhausted)
    const client2 = await getClient();
    try {
      const { rows } = await client2.query('SELECT 1 AS ok');
      expect(rows[0].ok).toBe(1);
    } finally {
      client2.release();
    }
  });

  // T7: Concurrent-Same-Key — first call inserts processing row; second call → 409 IDEMPOTENCY_PROCESSING
  it('T7: returns 409 IDEMPOTENCY_PROCESSING for concurrent same-key request', async () => {
    const key = `bulk-t7-${Date.now()}`;
    const actor = 'test-actor';
    const endpointKey = 'meter-readings.bulk';
    const body = { readings: makeReadings(2) };

    // First call — inserts processing row
    const mockReq1 = { headers: { 'idempotency-key': key } } as any;
    const ctx = await checkIdempotency(mockReq1, actor, endpointKey, body);
    expect(ctx).not.toBeNull();
    expect(ctx!.isReplay).toBe(false);

    // Second call with same key while first is still 'processing'
    const mockReq2 = { headers: { 'idempotency-key': key } } as any;
    try {
      await checkIdempotency(mockReq2, actor, endpointKey, body);
      expect(true).toBe(false); // should not reach here
    } catch (e: any) {
      expect(e.status).toBe(409);
      expect(e.code).toBe('IDEMPOTENCY_PROCESSING');
    }

    // Clean up: mark as failed so it doesn't interfere with other tests
    await failIdempotency(actor, endpointKey, key);
  });

  // T8: Audit-Integrity — successful bulk → audit entry; failed bulk → no audit entry
  it('T8: audit entry exists only for committed transactions', async () => {
    const requestIdSuccess = `req-t8-ok-${Date.now()}`;
    const requestIdFail = `req-t8-fail-${Date.now()}`;
    const actor = 'test-actor';

    // Successful transaction
    const clientOk = await getClient();
    try {
      await clientOk.query('BEGIN');
      await clientOk.query(
        `INSERT INTO meter_readings (meter_id, value, unit, reading_type, read_at, source, is_estimated)
         VALUES ($1, 999, 'm3', 'annual', '2025-12-01T10:00:00Z', 'manual', false)`,
        [meterId]
      );
      await clientOk.query(
        `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source, request_id)
         VALUES ($1, 'assets', 'meter_reading.bulk_create', 'meter', $2, $3, 'dashboard', $4)`,
        [actor, String(meterId), JSON.stringify({ count: 1, reading_ids: [] }), requestIdSuccess]
      );
      await clientOk.query('COMMIT');
    } finally {
      clientOk.release();
    }

    // Failed transaction (constraint violation)
    const clientFail = await getClient();
    try {
      await clientFail.query('BEGIN');
      await clientFail.query(
        `INSERT INTO meter_readings (meter_id, value, unit, reading_type, read_at, source, is_estimated)
         VALUES ($1, -5, 'm3', 'annual', '2025-12-02T10:00:00Z', 'manual', false)`,
        [meterId]
      );
      await clientFail.query(
        `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source, request_id)
         VALUES ($1, 'assets', 'meter_reading.bulk_create', 'meter', $2, $3, 'dashboard', $4)`,
        [actor, String(meterId), JSON.stringify({ count: 1, reading_ids: [] }), requestIdFail]
      );
      await clientFail.query('COMMIT');
    } catch {
      await clientFail.query('ROLLBACK');
    } finally {
      clientFail.release();
    }

    // Verify: successful audit exists
    const { rows: okAudit } = await testPool.query(
      `SELECT * FROM audit_log WHERE request_id = $1`, [requestIdSuccess]
    );
    expect(okAudit.length).toBe(1);

    // Verify: failed audit does NOT exist (rolled back)
    const { rows: failAudit } = await testPool.query(
      `SELECT * FROM audit_log WHERE request_id = $1`, [requestIdFail]
    );
    expect(failAudit.length).toBe(0);
  });
});
