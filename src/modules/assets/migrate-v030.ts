#!/usr/bin/env bun
/**
 * Sprint 5d.1 Migration — Assets Extension V030
 *
 * Adds:
 *   - properties.legal_owner VARCHAR(200) NULL
 *   - leases.garage_amount NUMERIC(10,2) NULL
 *   - leases.kitchen_amount NUMERIC(10,2) NULL
 *   - Partial index properties_legal_owner_idx
 *
 * Usage:
 *   bun run src/modules/assets/migrate-v030.ts --dry-run   # Show planned DDL without applying
 *   bun run src/modules/assets/migrate-v030.ts --apply     # Apply DDL + schema_version entry
 *
 * Environment:
 *   POSTGRES_URL — connection string (reads from ~/.config/openclaw/env if missing)
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Constants ────────────────────────────────────────────────────────────────

const MIGRATION_SQL = join(import.meta.dir, 'migrations/V030__assets_extension.sql');

const NEW_COLUMNS = [
  { table: 'properties', column: 'legal_owner', type: 'character varying(200)' },
  { table: 'leases', column: 'garage_amount', type: 'numeric(10,2)' },
  { table: 'leases', column: 'kitchen_amount', type: 'numeric(10,2)' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadEnv(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL not set and ~/.config/openclaw/env not found');
  const content = readFileSync(envFile, 'utf-8');
  const match = content.match(/^POSTGRES_URL=(.+)$/m);
  if (!match) throw new Error('POSTGRES_URL not found in env file');
  return match[1];
}

// ── Dry-Run ──────────────────────────────────────────────────────────────────

function dryRun(): void {
  console.log('\n Sprint 5d.1 Migration — Assets Extension V030 [DRY-RUN]\n');

  const ddl = readFileSync(MIGRATION_SQL, 'utf-8');

  console.log('DDL file:', MIGRATION_SQL);
  console.log(`DDL length: ${ddl.length} bytes\n`);

  console.log('Columns to add:');
  for (const c of NEW_COLUMNS) {
    console.log(`  ${c.table}.${c.column} ${c.type} NULL`);
  }

  console.log('\nIndexes to create:');
  console.log('  properties_legal_owner_idx ON properties(legal_owner) WHERE legal_owner IS NOT NULL');

  console.log('\nschema_version entry: module=assets, version=30');

  console.log('\n--- DDL Preview ---\n');
  console.log(ddl);
  console.log('\n--- End DDL ---');
  console.log('\nDry-run complete. Use --apply to execute.');
}

// ── Apply ────────────────────────────────────────────────────────────────────

async function apply(): Promise<void> {
  console.log('\n Sprint 5d.1 Migration — Assets Extension V030 [APPLY]\n');

  const connStr = loadEnv();
  const dbName = connStr.match(/\/([^/?]+)(\?|$)/)?.[1] ?? '???';
  console.log(`Connecting to ${dbName}...`);

  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();

  try {
    // Check if already applied
    const { rows: existing } = await client.query<{ version: number }>(
      "SELECT version FROM schema_version WHERE module = 'assets' AND version = 30"
    );

    if (existing.length > 0) {
      console.log('V030 already applied (assets, 30 in schema_version). Verifying columns...');
    } else {
      console.log('Applying V030__assets_extension.sql...');
      const ddl = readFileSync(MIGRATION_SQL, 'utf-8');
      await client.query(ddl);
      console.log('DDL applied.');
    }

    // Verify columns exist
    console.log('\nVerifying new columns:');
    for (const c of NEW_COLUMNS) {
      const { rows } = await client.query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [c.table, c.column]
      );
      if (rows.length === 0) {
        console.error(`  ERROR: ${c.table}.${c.column} does not exist!`);
        process.exit(1);
      }
      console.log(`  ${c.table}.${c.column}: ${rows[0].data_type}, nullable=${rows[0].is_nullable}`);
      if (rows[0].is_nullable !== 'YES') {
        console.error(`  ERROR: ${c.table}.${c.column} is NOT NULL — expected nullable`);
        process.exit(1);
      }
    }

    // Verify all existing rows have NULL for new columns
    for (const c of NEW_COLUMNS) {
      const { rows } = await client.query<{ total: number; non_null: number }>(
        `SELECT count(*)::int AS total, count(${c.column})::int AS non_null FROM ${c.table}`
      );
      console.log(`  ${c.table}: ${rows[0].total} rows, ${rows[0].non_null} non-null ${c.column}`);
    }

    // Verify index
    const { rows: indexes } = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'properties_legal_owner_idx'`
    );
    if (indexes.length === 0) {
      console.error('\nERROR: properties_legal_owner_idx not found');
      process.exit(1);
    }
    console.log(`\nIndex verified: properties_legal_owner_idx`);

    // Verify schema_version
    const { rows: sv } = await client.query<{ module: string; version: number; applied_at: Date }>(
      "SELECT module, version, applied_at FROM schema_version WHERE module = 'assets' ORDER BY version"
    );
    console.log(`\nschema_version entries for assets:`);
    for (const r of sv) {
      console.log(`  module=${r.module}, version=${r.version}, applied_at=${r.applied_at}`);
    }

    const has30 = sv.some(r => r.version === 30);
    if (!has30) {
      console.error('ERROR: schema_version entry (assets, 30) not found');
      process.exit(1);
    }

    console.log('\nMigration V030 complete!');
  } finally {
    client.release();
    await pool.end();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';

if (mode === 'dry-run') {
  dryRun();
} else {
  apply().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
