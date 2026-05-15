#!/usr/bin/env bun
/**
 * Rollback V030 — Assets Extension (legal_owner, garage_amount, kitchen_amount)
 *
 * Usage:
 *   bun run scripts/rollback-v030.ts --drop      # Drop columns + index + schema_version entry
 *   bun run scripts/rollback-v030.ts --reapply    # Drop + re-apply V030 DDL
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const MIGRATION_SQL = join(
  import.meta.dir,
  '../src/modules/assets/migrations/V030__assets_extension.sql',
);

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
  if (process.argv.includes('--yes') || !process.stdin.isTTY) return true;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      '\n  WARNING: This will DROP legal_owner, garage_amount, kitchen_amount columns.\n  Type "DROP V030" to confirm: ',
      (answer) => {
        rl.close();
        resolve(answer.trim() === 'DROP V030');
      },
    );
  });
}

async function drop(): Promise<void> {
  console.log('\n Rollback V030 — Assets Extension [DROP]\n');

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
    // Drop index first
    await client.query('DROP INDEX IF EXISTS properties_legal_owner_idx');
    console.log('  Dropped index properties_legal_owner_idx');

    // Drop columns
    await client.query('ALTER TABLE properties DROP COLUMN IF EXISTS legal_owner');
    console.log('  Dropped properties.legal_owner');

    await client.query('ALTER TABLE leases DROP COLUMN IF EXISTS garage_amount');
    console.log('  Dropped leases.garage_amount');

    await client.query('ALTER TABLE leases DROP COLUMN IF EXISTS kitchen_amount');
    console.log('  Dropped leases.kitchen_amount');

    // Remove schema_version entry
    await client.query(
      "DELETE FROM schema_version WHERE module = 'assets' AND version = 30"
    );
    console.log('  Removed schema_version entry (assets, 30)');

    // Verify columns gone
    const { rows } = await client.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'properties' AND column_name = 'legal_owner')
          OR (table_name = 'leases' AND column_name IN ('garage_amount', 'kitchen_amount')))
    `);

    if (rows.length === 0) {
      console.log('\nDrop verified: 0 V030 columns remain.');
    } else {
      console.error(`\nWARNING: ${rows.length} columns still exist:`);
      for (const r of rows) console.error(`  ${r.column_name}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function reapply(): Promise<void> {
  console.log('\n Rollback V030 — Assets Extension [REAPPLY]\n');

  // First drop
  await drop();

  console.log('\nRe-applying V030 DDL...');

  const connStr = loadEnv();
  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();

  try {
    const ddl = readFileSync(MIGRATION_SQL, 'utf-8');
    await client.query(ddl);
    console.log('DDL re-applied.');

    // Verify columns exist
    const { rows } = await client.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'properties' AND column_name = 'legal_owner')
          OR (table_name = 'leases' AND column_name IN ('garage_amount', 'kitchen_amount')))
      ORDER BY table_name, column_name
    `);

    console.log(`\nColumns verified: ${rows.length}`);
    for (const r of rows) {
      console.log(`  ${r.table_name}.${r.column_name}`);
    }

    if (rows.length === 3) {
      console.log('\nReapply verified: 3 columns exist.');
    } else {
      console.error(`\nERROR: Expected 3 columns, found ${rows.length}`);
      process.exit(1);
    }

    // Verify schema_version
    const { rows: sv } = await client.query(
      "SELECT * FROM schema_version WHERE module = 'assets' AND version = 30"
    );
    if (sv.length === 1) {
      console.log('schema_version (assets, 30) restored.');
    } else {
      console.error('ERROR: schema_version entry missing after reapply');
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
