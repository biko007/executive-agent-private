#!/usr/bin/env bun
/**
 * Etappe 0 Migration — Banking Sync Runs + Circuit Breaker V039
 *
 * Usage:
 *   bun run src/modules/banking/migrate-v039.ts --dry-run   # Show planned DDL without applying
 *   bun run src/modules/banking/migrate-v039.ts --apply     # Apply DDL + schema_version entry
 *
 * Environment:
 *   POSTGRES_URL — connection string (reads from ~/.config/openclaw/env if missing)
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Constants ────────────────────────────────────────────────────────────────

const MIGRATION_SQL = join(import.meta.dir, 'migrations/V039__banking_sync_runs.sql');

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
  console.log('\n Etappe 0 Migration — Banking Sync Runs + Circuit Breaker V039 [DRY-RUN]\n');

  const ddl = readFileSync(MIGRATION_SQL, 'utf-8');

  console.log('DDL file:', MIGRATION_SQL);
  console.log(`DDL length: ${ddl.length} bytes\n`);

  console.log('New table:');
  console.log('  banking_sync_runs');

  console.log('\nNew index:');
  console.log('  idx_sync_runs_inst_date ON banking_sync_runs(institution_id, sync_date DESC)');

  console.log('\nNew columns on banking_institutions:');
  console.log('  sync_paused_status VARCHAR(40)  — NULL | AUTO_PAUSED_PENDING_TAN');
  console.log('  sync_paused_since  TIMESTAMPTZ  — when pause started');

  console.log('\nschema_version entry: module=banking, version=39');

  console.log('\n--- DDL Preview ---\n');
  console.log(ddl);
  console.log('\n--- End DDL ---');
  console.log('\nDry-run complete. Use --apply to execute.');
}

// ── Apply ────────────────────────────────────────────────────────────────────

async function apply(): Promise<void> {
  console.log('\n Etappe 0 Migration — Banking Sync Runs + Circuit Breaker V039 [APPLY]\n');

  const connStr = loadEnv();
  const dbName = connStr.match(/\/([^/?]+)(\?|$)/)?.[1] ?? '???';
  console.log(`Connecting to ${dbName}...`);

  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();

  try {
    // Check if already applied
    const { rows: existing } = await client.query<{ version: number }>(
      "SELECT version FROM schema_version WHERE module = 'banking' AND version = 39"
    );

    if (existing.length > 0) {
      console.log('V039 already applied (banking, 39 in schema_version). Verifying...');
    } else {
      console.log('Applying V039__banking_sync_runs.sql...');
      const ddl = readFileSync(MIGRATION_SQL, 'utf-8');
      await client.query(ddl);
      console.log('DDL applied.');
    }

    // Verify banking_sync_runs table exists
    const { rows: tables } = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'banking_sync_runs'
    `);

    if (tables.length === 0) {
      console.error('ERROR: banking_sync_runs table not found');
      process.exit(1);
    }
    console.log('\nTable banking_sync_runs: exists');

    // Verify columns on banking_sync_runs
    const { rows: syncRunCols } = await client.query<{ column_name: string; data_type: string }>(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'banking_sync_runs' ORDER BY ordinal_position
    `);
    console.log(`  Columns: ${syncRunCols.length}`);
    for (const c of syncRunCols) {
      console.log(`    ${c.column_name} (${c.data_type})`);
    }

    // Verify new columns on banking_institutions
    const { rows: instCols } = await client.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'banking_institutions'
        AND column_name IN ('sync_paused_status', 'sync_paused_since')
      ORDER BY column_name
    `);
    console.log(`\nCircuit-breaker columns on banking_institutions: ${instCols.length}`);
    for (const c of instCols) {
      console.log(`  ${c.column_name}`);
    }

    if (instCols.length !== 2) {
      console.error('ERROR: Expected 2 circuit-breaker columns, found', instCols.length);
      process.exit(1);
    }

    // Verify index
    const { rows: indexes } = await client.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_sync_runs_inst_date'
    `);
    console.log(`\nIndex idx_sync_runs_inst_date: ${indexes.length > 0 ? 'exists' : 'MISSING'}`);

    // Verify schema_version
    const { rows: sv } = await client.query<{ version: number; applied_at: Date }>(
      "SELECT version, applied_at FROM schema_version WHERE module = 'banking' AND version = 39"
    );
    if (sv.length === 0) {
      console.error('ERROR: schema_version entry (banking, 39) not found');
      process.exit(1);
    }
    console.log(`\nschema_version: banking v39 (applied_at: ${sv[0].applied_at})`);

    // Audit log entry
    try {
      await client.query(
        `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source)
         VALUES ('system', 'banking', 'system.e0_migration_v039', 'migration', 'v039', $1::jsonb, 'system')`,
        [JSON.stringify({
          table: 'banking_sync_runs',
          circuit_breaker_columns: ['sync_paused_status', 'sync_paused_since'],
          version: 39,
        })]
      );
      console.log('  audit_log entry written');
    } catch {
      console.log('  (audit_log entry skipped — table may not exist in test DB)');
    }

    console.log('\nMigration V039 complete!');
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
