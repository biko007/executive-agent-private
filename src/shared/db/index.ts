/**
 * shared/db — Postgres connection pool and migration runner
 *
 * Reads POSTGRES_URL from env. Provides query helper and migration runner.
 * All modules share one pool to openclaw_core.
 */
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const { Pool } = pg;

let pool: pg.Pool | null = null;

/** Get or create the shared connection pool. */
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error('POSTGRES_URL not set — cannot connect to openclaw_core');
    }
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

/** Run a parameterized query. */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** Get a client from the pool (for transactions). Caller must release. */
export async function getClient(): Promise<pg.PoolClient> {
  return getPool().connect();
}

/**
 * Run SQL migration files from a directory.
 * Files must be named NNN_*.sql and are executed in sorted order.
 * Each migration is idempotent (uses IF NOT EXISTS in SQL).
 * Records applied versions in schema_version table.
 */
export async function runMigrations(
  migrationsDir: string,
  moduleName: string,
): Promise<number> {
  const p = getPool();
  let applied = 0;

  // Ensure schema_version table exists
  await p.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      module      TEXT NOT NULL,
      version     INTEGER NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (module, version)
    )
  `);

  // Get already-applied versions
  const { rows: existing } = await p.query<{ version: number }>(
    'SELECT version FROM schema_version WHERE module = $1',
    [moduleName],
  );
  const appliedVersions = new Set(existing.map((r) => r.version));

  // Read migration files
  let files: string[];
  try {
    files = await readdir(migrationsDir);
  } catch {
    return 0; // No migrations dir — nothing to do
  }

  const sqlFiles = files
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of sqlFiles) {
    const match = file.match(/^(\d+)_/);
    if (!match) continue;
    const version = parseInt(match[1], 10);
    if (appliedVersions.has(version)) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf-8');
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_version (module, version) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [moduleName, version],
      );
      await client.query('COMMIT');
      applied++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(
        `Migration ${file} for module ${moduleName} failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      client.release();
    }
  }

  return applied;
}

/** Gracefully close the pool (call on shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
