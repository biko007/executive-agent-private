#!/usr/bin/env bun
/**
 * Rollback V025 — Fleet Tables
 *
 * Usage:
 *   bun run scripts/rollback-v025.ts --drop      # Drop all 6 fleet tables + schema_version entry
 *   bun run scripts/rollback-v025.ts --reapply    # Drop + re-apply V025 DDL (empty tables)
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MIGRATION_SQL = join(
  import.meta.dir,
  '../src/modules/fleet/migrations/V025__fleet_tables.sql',
);

const FLEET_TABLES = [
  'fleet_documents',
  'vehicle_tuev_records',
  'vehicle_tax_records',
  'vehicle_insurance_policies',
  'vehicle_service_records',
  'vehicles',
];

function loadEnv(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL not set and ~/.config/openclaw/env not found');
  const content = readFileSync(envFile, 'utf-8');
  const match = content.match(/^POSTGRES_URL=(.+)$/m);
  if (!match) throw new Error('POSTGRES_URL not found in env file');
  return match[1];
}

async function drop(): Promise<void> {
  console.log('\n Rollback V025 — Fleet Tables [DROP]\n');

  const connStr = loadEnv();
  const dbName = connStr.match(/\/([^/?]+)(\?|$)/)?.[1] ?? '???';
  console.log(`Connecting to ${dbName}...`);

  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();

  try {
    for (const table of FLEET_TABLES) {
      await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
      console.log(`  Dropped ${table}`);
    }

    await client.query(
      "DELETE FROM schema_version WHERE module = 'fleet' AND version = 25"
    );
    console.log('  Removed schema_version entry (fleet, 25)');

    // Verify tables gone
    const { rows } = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (table_name LIKE 'vehicle%' OR table_name IN ('vehicles', 'fleet_documents'))
    `);

    if (rows.length === 0) {
      console.log('\nDrop verified: 0 fleet tables remain.');
    } else {
      console.error(`\nWARNING: ${rows.length} fleet tables still exist:`);
      for (const r of rows) console.error(`  ${r.table_name}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function reapply(): Promise<void> {
  console.log('\n Rollback V025 — Fleet Tables [REAPPLY]\n');

  // First drop
  await drop();

  console.log('\nRe-applying V025 DDL...');

  const connStr = loadEnv();
  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();

  try {
    const ddl = readFileSync(MIGRATION_SQL, 'utf-8');
    await client.query(ddl);
    console.log('DDL re-applied.');

    // Verify 6 tables exist and are empty
    const { rows: tables } = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (table_name LIKE 'vehicle%' OR table_name IN ('vehicles', 'fleet_documents'))
      ORDER BY table_name
    `);

    console.log(`\nTables verified: ${tables.length}`);
    for (const t of tables) {
      const { rows: countRows } = await client.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM ${t.table_name}`
      );
      console.log(`  ${t.table_name}: ${countRows[0].c} rows`);
    }

    if (tables.length === 6) {
      console.log('\nReapply verified: 6 tables exist, all empty.');
    } else {
      console.error(`\nERROR: Expected 6 tables, found ${tables.length}`);
      process.exit(1);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const mode = process.argv.includes('--reapply') ? 'reapply' : '--drop';

if (mode === 'reapply') {
  reapply().catch(err => { console.error(err); process.exit(1); });
} else {
  drop().catch(err => { console.error(err); process.exit(1); });
}
