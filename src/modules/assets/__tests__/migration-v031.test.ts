/**
 * V031 Migration Tests — Sprint 5d.1 Patch: Pellets in heating Enums
 * Tests: Apply, old values still valid, new pellets values valid, invalid values rejected,
 *        rollback, re-apply.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

let pool: pg.Pool;
let adminPool: pg.Pool;
let testDbName: string;
let prodUrl: string;

function ensurePostgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL not set');
  const content = readFileSync(envFile, 'utf-8');
  const match = content.match(/^POSTGRES_URL=(.+)$/m);
  if (!match) throw new Error('POSTGRES_URL not found');
  return match[1];
}

beforeAll(async () => {
  prodUrl = ensurePostgresUrl();
  testDbName = `openclaw_test_v031_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const testUrl = prodUrl.replace(/\/[^/?]+(\?|$)/, `/${testDbName}$1`);

  adminPool = new pg.Pool({ connectionString: prodUrl });
  await adminPool.query(`CREATE DATABASE "${testDbName}"`);

  pool = new pg.Pool({ connectionString: testUrl });

  // Bootstrap
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      module TEXT NOT NULL, version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (module, version)
    )
  `);

  // btree_gist extension needed by V023 EXCLUDE constraint
  await pool.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

  // Apply V022 foundation (creates properties, units, leases)
  const v022Path = join(import.meta.dir, '../migrations/V022__assets_tables.sql');
  await pool.query(readFileSync(v022Path, 'utf-8'));

  // Apply V023 (creates property_heating_config + other foundation tables)
  const v023Path = join(import.meta.dir, '../migrations/V023__assets_foundation.sql');
  await pool.query(readFileSync(v023Path, 'utf-8'));

  // Apply V031 pellets
  const v031Path = join(import.meta.dir, '../migrations/V031__heating_pellets.sql');
  await pool.query(readFileSync(v031Path, 'utf-8'));

  process.env.POSTGRES_URL = testUrl;
});

afterAll(async () => {
  await pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
  await adminPool.end();
  process.env.POSTGRES_URL = prodUrl;
});

describe('V031 Heating Pellets — Apply', () => {
  it('should set schema_version assets=31', async () => {
    const { rows } = await pool.query(
      "SELECT version FROM schema_version WHERE module = 'assets' AND version = 31"
    );
    expect(rows.length).toBe(1);
  });

  it('should have pellets in properties_heating_type_check', async () => {
    const { rows } = await pool.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'properties_heating_type_check'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].def).toContain('pellets');
  });

  it('should have central_pellets in property_heating_config_heating_system_check', async () => {
    const { rows } = await pool.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'property_heating_config_heating_system_check'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].def).toContain('central_pellets');
  });
});

describe('V031 Heating Pellets — Old values still valid', () => {
  it('should accept gas as heating_type', async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO properties (code, name, property_type, heating_type) VALUES ('ht-gas', 'Gas Test', 'residential', 'gas') RETURNING id`
    );
    expect(rows.length).toBe(1);
  });

  it('should accept oil as heating_type', async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO properties (code, name, property_type, heating_type) VALUES ('ht-oil', 'Oil Test', 'residential', 'oil') RETURNING id`
    );
    expect(rows.length).toBe(1);
  });

  it('should accept NULL as heating_type', async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO properties (code, name, property_type, heating_type) VALUES ('ht-null', 'Null Test', 'residential', NULL) RETURNING id`
    );
    expect(rows.length).toBe(1);
  });

  it('should accept central_gas as heating_system', async () => {
    const { rows: propRows } = await pool.query<{ id: number }>(
      "SELECT id FROM properties WHERE code = 'ht-gas'"
    );
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property_heating_config (property_id, year, heating_system) VALUES ($1, 2024, 'central_gas') RETURNING id`,
      [propRows[0].id]
    );
    expect(rows.length).toBe(1);
  });
});

describe('V031 Heating Pellets — New values valid', () => {
  it('should accept pellets as heating_type', async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO properties (code, name, property_type, heating_type) VALUES ('ht-pellets', 'Pellets Test', 'residential', 'pellets') RETURNING id`
    );
    expect(rows.length).toBe(1);
  });

  it('should accept central_pellets as heating_system', async () => {
    const { rows: propRows } = await pool.query<{ id: number }>(
      "SELECT id FROM properties WHERE code = 'ht-pellets'"
    );
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO property_heating_config (property_id, year, heating_system) VALUES ($1, 2024, 'central_pellets') RETURNING id`,
      [propRows[0].id]
    );
    expect(rows.length).toBe(1);
  });
});

describe('V031 Heating Pellets — Invalid values rejected', () => {
  it('should reject invalid heating_type', async () => {
    await expect(
      pool.query(`INSERT INTO properties (code, name, property_type, heating_type) VALUES ('ht-bad', 'Bad', 'residential', 'wood')`)
    ).rejects.toThrow(/check|violates/i);
  });

  it('should reject invalid heating_system', async () => {
    const { rows: propRows } = await pool.query<{ id: number }>(
      "SELECT id FROM properties WHERE code = 'ht-gas'"
    );
    await expect(
      pool.query(
        `INSERT INTO property_heating_config (property_id, year, heating_system) VALUES ($1, 2025, 'pellets')`,
        [propRows[0].id]
      )
    ).rejects.toThrow(/check|violates/i);
  });
});

describe('V031 Heating Pellets — Rollback + Re-Apply', () => {
  it('should rollback to original constraints', async () => {
    // Clean up rows with pellets values first
    await pool.query("DELETE FROM property_heating_config WHERE heating_system = 'central_pellets'");
    await pool.query("DELETE FROM properties WHERE heating_type = 'pellets'");

    // Restore original constraints
    await pool.query(`ALTER TABLE properties DROP CONSTRAINT properties_heating_type_check`);
    await pool.query(`ALTER TABLE properties ADD CONSTRAINT properties_heating_type_check
      CHECK (heating_type = ANY (ARRAY['gas','oil','heat_pump','district','electric','none']))`);

    await pool.query(`ALTER TABLE property_heating_config DROP CONSTRAINT property_heating_config_heating_system_check`);
    await pool.query(`ALTER TABLE property_heating_config ADD CONSTRAINT property_heating_config_heating_system_check
      CHECK (heating_system = ANY (ARRAY['central_gas','central_oil','district','heat_pump','electric','none']))`);

    await pool.query("DELETE FROM schema_version WHERE module = 'assets' AND version = 31");

    // Verify pellets rejected after rollback
    await expect(
      pool.query(`INSERT INTO properties (code, name, property_type, heating_type) VALUES ('ht-pellets2', 'P2', 'residential', 'pellets')`)
    ).rejects.toThrow(/check|violates/i);

    const { rows: sv } = await pool.query(
      "SELECT * FROM schema_version WHERE module = 'assets' AND version = 31"
    );
    expect(sv.length).toBe(0);
  });

  it('should re-apply V031 after rollback', async () => {
    const ddl = readFileSync(
      join(import.meta.dir, '../migrations/V031__heating_pellets.sql'),
      'utf-8',
    );
    await pool.query(ddl);

    // Pellets should be accepted again
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO properties (code, name, property_type, heating_type) VALUES ('ht-pellets3', 'P3', 'residential', 'pellets') RETURNING id`
    );
    expect(rows.length).toBe(1);

    const { rows: sv } = await pool.query(
      "SELECT * FROM schema_version WHERE module = 'assets' AND version = 31"
    );
    expect(sv.length).toBe(1);
  });
});
