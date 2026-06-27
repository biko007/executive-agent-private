/**
 * Withings Tails Tests (T1–T2)
 *
 * Proves:
 * - T1: /api/system-status no longer includes Withings in tokens[] array.
 *       loadTokens() itself still works (not broken — intentionally removed).
 * - T2: Pre-condition (loadTokens→null) creates a durable audit_log entry
 *       with action 'health.withings_sync_precondition_failed' before throwing.
 *
 * Uses real Postgres test DB. No mocking of the proven condition.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { homedir } from 'node:os';

let cleanup: () => Promise<void>;

// Dynamic imports after DB setup
let loadTokens: typeof import('../withings.js')['loadTokens'];
let saveTokens: typeof import('../withings.js')['saveTokens'];
let executeWithingsSync: typeof import('../withings.js')['executeWithingsSync'];

// ── Setup (extended: audit_log + health tables) ──────────────────────────

function ensurePostgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  const content = readFileSync(envFile, 'utf-8');
  const match = content.match(/^POSTGRES_URL=(.+)$/m);
  if (!match) throw new Error('POSTGRES_URL not found');
  process.env.POSTGRES_URL = match[1];
  return match[1];
}

beforeAll(async () => {
  const prodUrl = ensurePostgresUrl();
  const testDbName = `openclaw_test_tails_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const testUrl = prodUrl.replace(/\/[^/?]+(\?|$)/, `/${testDbName}$1`);

  const adminPool = new pg.Pool({ connectionString: prodUrl });
  await adminPool.query(`CREATE DATABASE "${testDbName}"`);

  const testPool = new pg.Pool({ connectionString: testUrl });

  // schema_version table
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      module TEXT NOT NULL, version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (module, version)
    )
  `);

  // Apply 001_core_tables (audit_log, workflows)
  const coreMigrationPath = join(import.meta.dir, '../../../shared/migrations/001_core_tables.sql');
  const coreSql = readFileSync(coreMigrationPath, 'utf-8');
  await testPool.query(coreSql);

  // Apply V021 health tables
  const healthMigrationPath = join(import.meta.dir, '../migrations/V021__health_tables.sql');
  const healthSql = readFileSync(healthMigrationPath, 'utf-8');
  await testPool.query(healthSql);

  await testPool.end();

  process.env.POSTGRES_URL = testUrl;

  // Dynamic imports after POSTGRES_URL set
  const withings = await import('../withings.js');
  loadTokens = withings.loadTokens;
  saveTokens = withings.saveTokens;
  executeWithingsSync = withings.executeWithingsSync;

  cleanup = async () => {
    const db = await import('../../../shared/db/index.js');
    await db.closePool();
    await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    await adminPool.end();
    process.env.POSTGRES_URL = prodUrl;
  };
});

afterAll(async () => {
  await cleanup();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('Withings Tails', () => {

  test('T1 — system-status handler does not include Withings in tokens array', async () => {
    // Part A: loadTokens works when token exists (not broken)
    await saveTokens({
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      expires_at: Date.now() + 3_600_000,
      userid: 'test-user',
    });
    const t = await loadTokens();
    expect(t).not.toBeNull();
    expect(t!.access_token).toBe('test-access');

    // Part B: index.ts system-status handler no longer references loadWithingsTokens
    const indexPath = join(import.meta.dir, '../../../../index.ts');
    const indexSource = readFileSync(indexPath, 'utf-8');

    // Find the system-status handler block (between 'path: \'/api/system-status\'' and next route)
    const handlerStart = indexSource.indexOf("path: '/api/system-status'");
    expect(handlerStart).toBeGreaterThan(-1);

    // Find the closing of this handler (next registerHttpRoute or end of block)
    const nextRoute = indexSource.indexOf("registerHttpRoute", handlerStart + 30);
    const handlerBlock = indexSource.slice(handlerStart, nextRoute > -1 ? nextRoute : undefined);

    // Withings must NOT appear in the handler body
    expect(handlerBlock).not.toContain('loadWithingsTokens');
    expect(handlerBlock).not.toContain("name: 'Withings'");

    // Instagram/Meta MUST still be present
    expect(handlerBlock).toContain("name: 'Meta'");
  });

  test('T2 — pre-condition (no token) creates audit_log entry and throws', async () => {
    // Ensure no active tokens (deactivate any from T1)
    const { query: dbQuery } = await import('../../../shared/db/index.js');
    await dbQuery('UPDATE health_withings_tokens SET active = false WHERE active = true');

    // Clear audit_log for clean assertion
    await dbQuery('DELETE FROM audit_log WHERE action = $1', ['health.withings_sync_precondition_failed']);

    // Verify no active token
    const tokens = await loadTokens();
    expect(tokens).toBeNull();

    // Call executeWithingsSync — must throw
    let thrown: Error | undefined;
    try {
      await executeWithingsSync(
        'fake-id', 'fake-secret', Date.now() - 48 * 3600_000,
        async () => ({ total: 0, newCount: 0 }),
      );
    } catch (e: any) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain('No active Withings token');

    // Verify audit_log entry was created
    const { rows } = await dbQuery<{
      module: string; action: string; entity_type: string; after_jsonb: { reason: string };
    }>(
      `SELECT module, action, entity_type, after_jsonb
       FROM audit_log WHERE action = $1 ORDER BY ts DESC LIMIT 1`,
      ['health.withings_sync_precondition_failed'],
    );

    expect(rows.length).toBe(1);
    expect(rows[0].module).toBe('health');
    expect(rows[0].action).toBe('health.withings_sync_precondition_failed');
    expect(rows[0].entity_type).toBe('sync');
    expect(rows[0].after_jsonb.reason).toBe('no_active_token');
  });
});
