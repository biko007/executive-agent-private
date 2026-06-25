/**
 * Test DB Setup Helper — creates a fresh Postgres test database with banking tables (V027).
 *
 * Usage:
 *   const { cleanup } = await setupTestDb();
 *   // ... run tests ...
 *   await cleanup();
 *
 * Requires POSTGRES_URL in env (or reads from ~/.config/openclaw/env).
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Load POSTGRES_URL from ~/.config/openclaw/env if not in environment. */
function ensurePostgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;

  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) {
    throw new Error('POSTGRES_URL not set and ~/.config/openclaw/env not found');
  }
  const content = readFileSync(envFile, 'utf-8');
  const match = content.match(/^POSTGRES_URL=(.+)$/m);
  if (!match) {
    throw new Error('POSTGRES_URL not found in ~/.config/openclaw/env');
  }
  process.env.POSTGRES_URL = match[1];
  return match[1];
}

export async function setupTestDb(): Promise<{ testDbName: string; cleanup: () => Promise<void> }> {
  const prodUrl = ensurePostgresUrl();
  const testDbName = `openclaw_test_banking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const testUrl = prodUrl.replace(/\/[^/?]+(\?|$)/, `/${testDbName}$1`);

  // 1. Create test database via admin connection
  const adminPool = new pg.Pool({ connectionString: prodUrl });
  await adminPool.query(`CREATE DATABASE "${testDbName}"`);

  // 2. Apply migrations to test database
  const testPool = new pg.Pool({ connectionString: testUrl });

  // schema_version table (normally created by runMigrations)
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      module TEXT NOT NULL, version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (module, version)
    )
  `);

  // audit_log table (needed by audit.log calls)
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor TEXT,
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      before_jsonb JSONB,
      after_jsonb JSONB,
      source TEXT,
      correlation_id TEXT,
      request_id TEXT
    )
  `);

  // Apply V027 banking tables migration
  const migrationPath = join(import.meta.dir, '../migrations/V027__banking_tables.sql');
  const migrationSql = readFileSync(migrationPath, 'utf-8');
  await testPool.query(migrationSql);

  // Apply V028 pending challenge columns
  const v028Path = join(import.meta.dir, '../migrations/V028__banking_pending_challenge.sql');
  const v028Sql = readFileSync(v028Path, 'utf-8');
  await testPool.query(v028Sql);

  // Apply V029 sync reminders table
  const v029Path = join(import.meta.dir, '../migrations/V029__banking_sync_reminders.sql');
  const v029Sql = readFileSync(v029Path, 'utf-8');
  await testPool.query(v029Sql);

  // Apply V038 transaction_code widening
  const v038Path = join(import.meta.dir, '../migrations/V038__banking_transaction_code_widen.sql');
  if (existsSync(v038Path)) {
    const v038Sql = readFileSync(v038Path, 'utf-8');
    await testPool.query(v038Sql);
  }

  // Apply V039 sync_runs + circuit-breaker columns (E0/E1)
  const v039Path = join(import.meta.dir, '../migrations/V039__banking_sync_runs.sql');
  if (existsSync(v039Path)) {
    const v039Sql = readFileSync(v039Path, 'utf-8');
    await testPool.query(v039Sql);
  }

  // approval_tokens table (needed by approval workflow tests)
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS approval_tokens (
      id SERIAL PRIMARY KEY,
      token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      session_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      method TEXT NOT NULL,
      endpoint_key TEXT NOT NULL,
      canonical_body_hash TEXT NOT NULL,
      entity_versions JSONB,
      diff_summary JSONB,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      superseded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await testPool.query(`
    CREATE INDEX IF NOT EXISTS idx_approval_tokens_active
      ON approval_tokens(session_id, endpoint_key)
      WHERE used_at IS NULL AND superseded_at IS NULL
  `);

  await testPool.end();

  // 3. Point POSTGRES_URL to test database
  process.env.POSTGRES_URL = testUrl;

  return {
    testDbName,
    cleanup: async () => {
      // Close shared pool used by modules
      try {
        const db = await import('../../../shared/db/index.js');
        await db.closePool();
      } catch { /* pool may not have been initialized */ }
      // Drop test database
      await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
      await adminPool.end();
      // Restore original URL
      process.env.POSTGRES_URL = prodUrl;
    },
  };
}
