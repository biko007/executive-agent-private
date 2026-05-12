/**
 * Test DB Setup Helper — creates a fresh Postgres test database with health tables.
 *
 * Usage:
 *   const { cleanup } = await setupTestDb();
 *   // ... import store module AFTER setupTestDb() ...
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
  const testDbName = `openclaw_test_health_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const testUrl = prodUrl.replace(/\/[^/?]+(\?|$)/, `/${testDbName}$1`);

  // 1. Create test database via admin connection
  const adminPool = new pg.Pool({ connectionString: prodUrl });
  await adminPool.query(`CREATE DATABASE "${testDbName}"`);

  // 2. Apply migration to test database
  const testPool = new pg.Pool({ connectionString: testUrl });
  // schema_version table (normally created by runMigrations)
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      module TEXT NOT NULL, version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (module, version)
    )
  `);
  const migrationPath = join(import.meta.dir, '../migrations/V021__health_tables.sql');
  const migrationSql = readFileSync(migrationPath, 'utf-8');
  await testPool.query(migrationSql);
  await testPool.end();

  // 3. Point POSTGRES_URL to test database
  process.env.POSTGRES_URL = testUrl;

  return {
    testDbName,
    cleanup: async () => {
      // Close shared pool used by store module
      const db = await import('../../../shared/db/index.js');
      await db.closePool();
      // Drop test database
      await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
      await adminPool.end();
      // Restore original URL
      process.env.POSTGRES_URL = prodUrl;
    },
  };
}
