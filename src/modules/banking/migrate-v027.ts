#!/usr/bin/env bun
/**
 * Sprint 7b Migration — Banking Schema V027
 *
 * Usage:
 *   bun run src/modules/banking/migrate-v027.ts --dry-run   # Show planned DDL without applying
 *   bun run src/modules/banking/migrate-v027.ts --apply     # Apply DDL + schema_version entry
 *
 * Environment:
 *   POSTGRES_URL — connection string (reads from ~/.config/openclaw/env if missing)
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Constants ────────────────────────────────────────────────────────────────

const MIGRATION_SQL = join(import.meta.dir, 'migrations/V027__banking_tables.sql');

const BANKING_TABLES = [
  'banking_institutions',
  'banking_accounts',
  'banking_transactions',
  'banking_sessions',
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
  console.log('\n Sprint 7b Migration — Banking Schema V027 [DRY-RUN]\n');

  const ddl = readFileSync(MIGRATION_SQL, 'utf-8');

  console.log('DDL file:', MIGRATION_SQL);
  console.log(`DDL length: ${ddl.length} bytes\n`);

  console.log('Tables to create:');
  for (const t of BANKING_TABLES) {
    console.log(`  ${t}`);
  }

  console.log('\nIndexes to create:');
  console.log('  idx_banking_accounts_institution_status ON banking_accounts(institution_id, status)');
  console.log('  idx_banking_transactions_account_date ON banking_transactions(account_id, booking_date DESC)');
  console.log('  idx_banking_sessions_institution ON banking_sessions(institution_id)');

  console.log('\nTriggers to create:');
  for (const t of BANKING_TABLES) {
    console.log(`  trg_${t}_updated_at ON ${t}`);
  }

  console.log('\nConstraints:');
  console.log('  banking_institutions.blz — UNIQUE NOT NULL');
  console.log('  banking_accounts.iban — UNIQUE NOT NULL');
  console.log('  banking_accounts.status — CHECK (active, archived)');
  console.log('  banking_accounts.institution_id — FK → banking_institutions(id) ON DELETE RESTRICT');
  console.log('  banking_transactions.(account_id, bank_transaction_id) — UNIQUE');
  console.log('  banking_transactions.account_id — FK → banking_accounts(id) ON DELETE CASCADE');
  console.log('  banking_sessions.institution_id — FK → banking_institutions(id) ON DELETE RESTRICT');

  console.log('\nschema_version entry: module=banking, version=27');

  console.log('\n--- DDL Preview ---\n');
  console.log(ddl);
  console.log('\n--- End DDL ---');
  console.log('\nDry-run complete. Use --apply to execute.');
}

// ── Apply ────────────────────────────────────────────────────────────────────

async function apply(): Promise<void> {
  console.log('\n Sprint 7b Migration — Banking Schema V027 [APPLY]\n');

  const connStr = loadEnv();
  const dbName = connStr.match(/\/([^/?]+)(\?|$)/)?.[1] ?? '???';
  console.log(`Connecting to ${dbName}...`);

  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();

  try {
    // Ensure schema_version table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        module TEXT NOT NULL, version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (module, version)
      )
    `);

    // Check if already applied
    const { rows: existing } = await client.query<{ version: number }>(
      "SELECT version FROM schema_version WHERE module = 'banking' AND version = 27"
    );

    if (existing.length > 0) {
      console.log('V027 already applied (banking, 27 in schema_version). Verifying tables...');
    } else {
      console.log('Applying V027__banking_tables.sql...');
      const ddl = readFileSync(MIGRATION_SQL, 'utf-8');
      await client.query(ddl);
      console.log('DDL applied.');
    }

    // Verify 4 tables
    const { rows: tables } = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'banking_%'
      ORDER BY table_name
    `);

    console.log(`\nTables found: ${tables.length}`);
    for (const t of tables) {
      const { rows: countRows } = await client.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM ${t.table_name}`
      );
      console.log(`  ${t.table_name}: ${countRows[0].c} rows`);
    }

    if (tables.length !== 4) {
      console.error(`ERROR: Expected 4 tables, found ${tables.length}`);
      process.exit(1);
    }

    // Verify triggers
    const { rows: triggers } = await client.query<{ trigger_name: string; event_object_table: string }>(`
      SELECT trigger_name, event_object_table
      FROM information_schema.triggers
      WHERE trigger_name LIKE 'trg_banking_%_updated_at'
      ORDER BY event_object_table
    `);

    console.log(`\nTriggers found: ${triggers.length}`);
    for (const t of triggers) {
      console.log(`  ${t.trigger_name} ON ${t.event_object_table}`);
    }

    if (triggers.length !== 4) {
      console.error(`ERROR: Expected 4 triggers, found ${triggers.length}`);
      process.exit(1);
    }

    // Verify indexes
    const { rows: indexes } = await client.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE 'idx_banking_%'
      ORDER BY indexname
    `);

    console.log(`\nIndexes found: ${indexes.length}`);
    for (const i of indexes) {
      console.log(`  ${i.indexname}`);
    }

    // Verify schema_version
    const { rows: sv } = await client.query<{ module: string; version: number; applied_at: Date }>(
      "SELECT module, version, applied_at FROM schema_version WHERE module = 'banking'"
    );
    console.log(`\nschema_version entry:`);
    for (const r of sv) {
      console.log(`  module=${r.module}, version=${r.version}, applied_at=${r.applied_at}`);
    }

    if (sv.length === 0) {
      console.error('ERROR: schema_version entry not found');
      process.exit(1);
    }

    // Audit log entry (best-effort, non-critical)
    try {
      await client.query(
        `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source)
         VALUES ('system', 'banking', 'system.sprint7b_migration_v027', 'migration', 'v027', $1::jsonb, 'system')`,
        [JSON.stringify({
          tables: BANKING_TABLES,
          version: 27,
        })]
      );
      console.log('  audit_log entry written');
    } catch {
      console.log('  (audit_log entry skipped — table may not exist in test DB)');
    }

    console.log('\nMigration V027 complete!');
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
