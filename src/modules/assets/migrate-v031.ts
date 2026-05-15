#!/usr/bin/env bun
/**
 * Sprint 5d.1 Patch — Heating Pellets V031
 *
 * Extends CHECK constraints:
 *   - properties.heating_type += 'pellets'
 *   - property_heating_config.heating_system += 'central_pellets'
 *
 * Usage:
 *   bun run src/modules/assets/migrate-v031.ts --dry-run
 *   bun run src/modules/assets/migrate-v031.ts --apply
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MIGRATION_SQL = join(import.meta.dir, 'migrations/V031__heating_pellets.sql');

function loadEnv(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL not set and ~/.config/openclaw/env not found');
  const content = readFileSync(envFile, 'utf-8');
  const match = content.match(/^POSTGRES_URL=(.+)$/m);
  if (!match) throw new Error('POSTGRES_URL not found in env file');
  return match[1];
}

function dryRun(): void {
  console.log('\n Sprint 5d.1 Patch — Heating Pellets V031 [DRY-RUN]\n');

  const ddl = readFileSync(MIGRATION_SQL, 'utf-8');

  console.log('DDL file:', MIGRATION_SQL);
  console.log(`DDL length: ${ddl.length} bytes\n`);

  console.log('Constraint changes:');
  console.log('  properties_heating_type_check: +pellets');
  console.log('  property_heating_config_heating_system_check: +central_pellets');

  console.log('\nschema_version entry: module=assets, version=31');

  console.log('\n--- DDL Preview ---\n');
  console.log(ddl);
  console.log('\n--- End DDL ---');
  console.log('\nDry-run complete. Use --apply to execute.');
}

async function apply(): Promise<void> {
  console.log('\n Sprint 5d.1 Patch — Heating Pellets V031 [APPLY]\n');

  const connStr = loadEnv();
  const dbName = connStr.match(/\/([^/?]+)(\?|$)/)?.[1] ?? '???';
  console.log(`Connecting to ${dbName}...`);

  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();

  try {
    // Check if already applied
    const { rows: existing } = await client.query<{ version: number }>(
      "SELECT version FROM schema_version WHERE module = 'assets' AND version = 31"
    );

    if (existing.length > 0) {
      console.log('V031 already applied (assets, 31 in schema_version). Verifying constraints...');
    } else {
      console.log('Applying V031__heating_pellets.sql...');
      const ddl = readFileSync(MIGRATION_SQL, 'utf-8');
      await client.query(ddl);
      console.log('DDL applied.');
    }

    // Verify constraints contain new values
    const { rows: constraints } = await client.query<{ conname: string; def: string }>(`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname IN ('properties_heating_type_check', 'property_heating_config_heating_system_check')
      ORDER BY conname
    `);

    console.log('\nConstraints verified:');
    for (const c of constraints) {
      console.log(`  ${c.conname}:`);
      console.log(`    ${c.def}`);
    }

    const htCheck = constraints.find(c => c.conname === 'properties_heating_type_check');
    const hsCheck = constraints.find(c => c.conname === 'property_heating_config_heating_system_check');

    if (!htCheck?.def.includes('pellets')) {
      console.error("ERROR: properties_heating_type_check does not contain 'pellets'");
      process.exit(1);
    }
    if (!hsCheck?.def.includes('central_pellets')) {
      console.error("ERROR: property_heating_config_heating_system_check does not contain 'central_pellets'");
      process.exit(1);
    }

    // Verify schema_version
    const { rows: sv } = await client.query<{ version: number }>(
      "SELECT version FROM schema_version WHERE module = 'assets' AND version = 31"
    );
    if (sv.length === 0) {
      console.error('ERROR: schema_version entry (assets, 31) not found');
      process.exit(1);
    }
    console.log('\nschema_version: assets=31 confirmed');

    console.log('\nMigration V031 complete!');
  } finally {
    client.release();
    await pool.end();
  }
}

const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';

if (mode === 'dry-run') {
  dryRun();
} else {
  apply().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
