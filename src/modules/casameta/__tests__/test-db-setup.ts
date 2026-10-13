/**
 * Test-DB für das Casameta-Protokoll. Legt eine frische Datenbank an, spielt
 * die Modulmigration ein und zeigt POSTGRES_URL darauf.
 *
 * Aufbau wie bei `fleet` und `assets` — bewusst kopiert statt abstrahiert: Ein
 * gemeinsames Setup müsste alle Modultabellen kennen und würde jeden Testlauf
 * verlangsamen, nur damit vier Zeilen nicht doppelt stehen.
 *
 * `store.ts` wird erst NACH `setupTestDb()` importiert, sonst hält der geteilte
 * Pool noch die Produktivverbindung.
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertSafeDbUrl } from '../../../core/db-guard.js';

function ensurePostgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) {
    throw new Error('POSTGRES_URL nicht gesetzt und ~/.config/openclaw/env fehlt');
  }
  const treffer = readFileSync(envFile, 'utf-8').match(/^POSTGRES_URL=(.+)$/m);
  if (!treffer) throw new Error('POSTGRES_URL fehlt in ~/.config/openclaw/env');
  process.env.POSTGRES_URL = treffer[1];
  return treffer[1];
}

export async function setupTestDb(): Promise<{ testDbName: string; cleanup: () => Promise<void> }> {
  const prodUrl = ensurePostgresUrl();
  const testDbName = `openclaw_test_casameta_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  /* Der Store schreibt Audit-Einträge; ohne diese Tabelle scheitert jeder Test
     an einer Nebensache statt an der Sache. */
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor TEXT, module TEXT NOT NULL, action TEXT NOT NULL,
      entity_type TEXT, entity_id TEXT,
      before_jsonb JSONB, after_jsonb JSONB,
      source TEXT, correlation_id TEXT, request_id TEXT
    )
  `);

  const migration = join(import.meta.dir, '../migrations/044_casameta_tables.sql');
  await testPool.query(readFileSync(migration, 'utf-8'));
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
