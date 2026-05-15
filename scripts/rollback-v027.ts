#!/usr/bin/env bun
/**
 * Rollback V027 — Banking Tables
 *
 * Usage:
 *   bun run scripts/rollback-v027.ts --drop      # Drop all 4 banking tables + schema_version entry
 *   bun run scripts/rollback-v027.ts --reapply    # Drop + re-apply V027 DDL (empty tables)
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const MIGRATION_SQL = join(
  import.meta.dir,
  '../src/modules/banking/migrations/V027__banking_tables.sql',
);

// Drop order: children first, parents last (respect FK constraints)
const BANKING_TABLES = [
  'banking_sessions',
  'banking_transactions',
  'banking_accounts',
  'banking_institutions',
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

async function confirmDrop(): Promise<boolean> {
  // Skip confirm if --yes flag or non-interactive (piped stdin)
  if (process.argv.includes('--yes') || !process.stdin.isTTY) return true;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      '\n  WARNING: This will DROP all 4 banking tables and delete data.\n  Type "DROP BANKING" to confirm: ',
      (answer) => {
        rl.close();
        resolve(answer.trim() === 'DROP BANKING');
      },
    );
  });
}

async function drop(): Promise<void> {
  console.log('\n Rollback V027 — Banking Tables [DROP]\n');

  const confirmed = await confirmDrop();
  if (!confirmed) {
    console.log('Aborted — confirmation not provided.');
    process.exit(0);
  }

  const connStr = loadEnv();
  const dbName = connStr.match(/\/([^/?]+)(\?|$)/)?.[1] ?? '???';
  console.log(`Connecting to ${dbName}...`);

  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();

  try {
    for (const table of BANKING_TABLES) {
      await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
      console.log(`  Dropped ${table}`);
    }

    await client.query(
      "DELETE FROM schema_version WHERE module = 'banking' AND version = 27"
    );
    console.log('  Removed schema_version entry (banking, 27)');

    // Verify tables gone
    const { rows } = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'banking_%'
    `);

    if (rows.length === 0) {
      console.log('\nDrop verified: 0 banking tables remain.');
    } else {
      console.error(`\nWARNING: ${rows.length} banking tables still exist:`);
      for (const r of rows) console.error(`  ${r.table_name}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function reapply(): Promise<void> {
  console.log('\n Rollback V027 — Banking Tables [REAPPLY]\n');

  // First drop
  await drop();

  console.log('\nRe-applying V027 DDL...');

  const connStr = loadEnv();
  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();

  try {
    const ddl = readFileSync(MIGRATION_SQL, 'utf-8');
    await client.query(ddl);
    console.log('DDL re-applied.');

    // Verify 4 tables exist and are empty
    const { rows: tables } = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'banking_%'
      ORDER BY table_name
    `);

    console.log(`\nTables verified: ${tables.length}`);
    for (const t of tables) {
      const { rows: countRows } = await client.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM ${t.table_name}`
      );
      console.log(`  ${t.table_name}: ${countRows[0].c} rows`);
    }

    if (tables.length === 4) {
      console.log('\nReapply verified: 4 tables exist, all empty.');
    } else {
      console.error(`\nERROR: Expected 4 tables, found ${tables.length}`);
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
