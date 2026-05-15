#!/usr/bin/env bun
/**
 * Rollback V031 — Heating Pellets (restore original CHECK constraints)
 *
 * Usage:
 *   bun run scripts/rollback-v031.ts --drop      # Restore original constraints without pellets
 *   bun run scripts/rollback-v031.ts --reapply    # Drop + re-apply V031
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const MIGRATION_SQL = join(
  import.meta.dir,
  '../src/modules/assets/migrations/V031__heating_pellets.sql',
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
      '\n  WARNING: This will restore original heating constraints (without pellets).\n  Any rows with pellets/central_pellets values will violate the constraint.\n  Type "DROP V031" to confirm: ',
      (answer) => {
        rl.close();
        resolve(answer.trim() === 'DROP V031');
      },
    );
  });
}

async function drop(): Promise<void> {
  console.log('\n Rollback V031 — Heating Pellets [DROP]\n');

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
    // Restore original constraints (V022 versions without pellets)
    await client.query(`
      ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_heating_type_check;
      ALTER TABLE properties ADD CONSTRAINT properties_heating_type_check
        CHECK (heating_type = ANY (ARRAY['gas','oil','heat_pump','district','electric','none']));
    `);
    console.log('  Restored properties_heating_type_check (without pellets)');

    await client.query(`
      ALTER TABLE property_heating_config DROP CONSTRAINT IF EXISTS property_heating_config_heating_system_check;
      ALTER TABLE property_heating_config ADD CONSTRAINT property_heating_config_heating_system_check
        CHECK (heating_system = ANY (ARRAY['central_gas','central_oil','district','heat_pump','electric','none']));
    `);
    console.log('  Restored property_heating_config_heating_system_check (without central_pellets)');

    await client.query(
      "DELETE FROM schema_version WHERE module = 'assets' AND version = 31"
    );
    console.log('  Removed schema_version entry (assets, 31)');

    // Verify
    const { rows } = await client.query<{ conname: string; def: string }>(`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname IN ('properties_heating_type_check', 'property_heating_config_heating_system_check')
    `);

    for (const c of rows) {
      const hasPellets = c.def.includes('pellets');
      console.log(`  ${c.conname}: pellets=${hasPellets ? 'STILL PRESENT (ERROR)' : 'removed'}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function reapply(): Promise<void> {
  console.log('\n Rollback V031 — Heating Pellets [REAPPLY]\n');

  await drop();

  console.log('\nRe-applying V031 DDL...');

  const connStr = loadEnv();
  const pool = new pg.Pool({ connectionString: connStr });
  const client = await pool.connect();

  try {
    const ddl = readFileSync(MIGRATION_SQL, 'utf-8');
    await client.query(ddl);
    console.log('DDL re-applied.');

    const { rows } = await client.query<{ conname: string; def: string }>(`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname IN ('properties_heating_type_check', 'property_heating_config_heating_system_check')
    `);

    for (const c of rows) {
      console.log(`  ${c.conname}: ${c.def.includes('pellets') ? 'pellets present' : 'ERROR: pellets missing'}`);
    }

    const { rows: sv } = await client.query(
      "SELECT * FROM schema_version WHERE module = 'assets' AND version = 31"
    );
    console.log(`  schema_version (assets, 31): ${sv.length === 1 ? 'restored' : 'ERROR: missing'}`);
  } finally {
    client.release();
    await pool.end();
  }
}

const mode = process.argv.includes('--reapply') ? 'reapply' : '--drop';

if (mode === 'reapply') {
  reapply().catch(err => { console.error(err); process.exit(1); });
} else {
  drop().catch(err => { console.error(err); process.exit(1); });
}
