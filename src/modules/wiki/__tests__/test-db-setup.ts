/**
 * Test-DB-Setup für das Wiki-Modul.
 *
 * Legt eine frische Datenbank openclaw_test_wiki_* an, wendet die
 * Modulmigration an und zeigt POSTGRES_URL darauf. Der db-guard (C1) prüft
 * fail-closed, dass keine Produktiv-DB getroffen wird.
 *
 * Reihenfolge ist wichtig: setupTestDb() MUSS vor dem Import von store.ts
 * laufen, weil der gemeinsame Pool die URL beim ersten Zugriff festhält.
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertSafeDbUrl } from '../../../core/db-guard.js';

/** POSTGRES_URL aus ~/.config/openclaw/env nachladen, falls nicht gesetzt. */
function ensurePostgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;

  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) {
    throw new Error('POSTGRES_URL nicht gesetzt und ~/.config/openclaw/env fehlt');
  }
  const content = readFileSync(envFile, 'utf-8');
  const match = content.match(/^POSTGRES_URL=(.+)$/m);
  if (!match) throw new Error('POSTGRES_URL nicht in ~/.config/openclaw/env gefunden');
  process.env.POSTGRES_URL = match[1];
  return match[1];
}

export async function setupTestDb(): Promise<{ testDbName: string; cleanup: () => Promise<void> }> {
  const prodUrl = ensurePostgresUrl();
  const testDbName = `openclaw_test_wiki_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const testUrl = prodUrl.replace(/\/[^/?]+(\?|$)/, `/${testDbName}$1`);

  const adminPool = new pg.Pool({ connectionString: prodUrl });
  await adminPool.query(`CREATE DATABASE "${testDbName}"`);

  const testPool = new pg.Pool({ connectionString: testUrl });
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      module TEXT NOT NULL, version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (module, version)
    )
  `);
  const migrationPath = join(import.meta.dir, '../migrations/001_wiki_tables.sql');
  await testPool.query(readFileSync(migrationPath, 'utf-8'));
  await testPool.end();

  process.env.POSTGRES_URL = testUrl;
  assertSafeDbUrl(testUrl);

  return {
    testDbName,
    cleanup: async () => {
      const db = await import('../../../shared/db/index.js');
      await db.closePool();
      await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
      await adminPool.end();
      process.env.POSTGRES_URL = prodUrl;
    },
  };
}
