/**
 * V030 Migration Tests — Sprint 5d.1 Assets Extension
 * Tests: Apply, column types, nullability, index, rollback, re-apply.
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
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL not set and ~/.config/openclaw/env not found');
  const content = readFileSync(envFile, 'utf-8');
  const match = content.match(/^POSTGRES_URL=(.+)$/m);
  if (!match) throw new Error('POSTGRES_URL not found in env file');
  return match[1];
}

beforeAll(async () => {
  prodUrl = ensurePostgresUrl();
  testDbName = `openclaw_test_v030_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const testUrl = prodUrl.replace(/\/[^/?]+(\?|$)/, `/${testDbName}$1`);

  adminPool = new pg.Pool({ connectionString: prodUrl });
  await adminPool.query(`CREATE DATABASE "${testDbName}"`);

  pool = new pg.Pool({ connectionString: testUrl });

  // Bootstrap schema_version
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      module TEXT NOT NULL, version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (module, version)
    )
  `);

  // Apply V022 foundation (creates properties + leases tables)
  const v022Path = join(import.meta.dir, '../migrations/V022__assets_tables.sql');
  await pool.query(readFileSync(v022Path, 'utf-8'));

  // Apply V030
  const v030Path = join(import.meta.dir, '../migrations/V030__assets_extension.sql');
  await pool.query(readFileSync(v030Path, 'utf-8'));

  process.env.POSTGRES_URL = testUrl;
});

afterAll(async () => {
  await pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
  await adminPool.end();
  process.env.POSTGRES_URL = prodUrl;
});

describe('V030 Assets Extension — Apply', () => {
  it('should add properties.legal_owner column', async () => {
    const { rows } = await pool.query<{ data_type: string; is_nullable: string; character_maximum_length: number | null }>(`
      SELECT data_type, is_nullable, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'legal_owner'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].data_type).toBe('character varying');
    expect(rows[0].character_maximum_length).toBe(200);
    expect(rows[0].is_nullable).toBe('YES');
  });

  it('should add leases.garage_amount column with NUMERIC(10,2)', async () => {
    const { rows } = await pool.query<{ data_type: string; is_nullable: string; numeric_precision: number | null; numeric_scale: number | null }>(`
      SELECT data_type, is_nullable, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'leases' AND column_name = 'garage_amount'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].data_type).toBe('numeric');
    expect(rows[0].numeric_precision).toBe(10);
    expect(rows[0].numeric_scale).toBe(2);
    expect(rows[0].is_nullable).toBe('YES');
  });

  it('should add leases.kitchen_amount column with NUMERIC(10,2)', async () => {
    const { rows } = await pool.query<{ data_type: string; is_nullable: string; numeric_precision: number | null; numeric_scale: number | null }>(`
      SELECT data_type, is_nullable, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'leases' AND column_name = 'kitchen_amount'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].data_type).toBe('numeric');
    expect(rows[0].numeric_precision).toBe(10);
    expect(rows[0].numeric_scale).toBe(2);
    expect(rows[0].is_nullable).toBe('YES');
  });

  it('should have garage_amount/kitchen_amount same type as kaltmiete', async () => {
    const { rows } = await pool.query<{ column_name: string; numeric_precision: number; numeric_scale: number }>(`
      SELECT column_name, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'leases'
        AND column_name IN ('kaltmiete', 'garage_amount', 'kitchen_amount')
      ORDER BY column_name
    `);
    expect(rows.length).toBe(3);
    // All three should have the same precision/scale
    const kaltmiete = rows.find(r => r.column_name === 'kaltmiete')!;
    const garage = rows.find(r => r.column_name === 'garage_amount')!;
    const kitchen = rows.find(r => r.column_name === 'kitchen_amount')!;
    expect(garage.numeric_precision).toBe(kaltmiete.numeric_precision);
    expect(garage.numeric_scale).toBe(kaltmiete.numeric_scale);
    expect(kitchen.numeric_precision).toBe(kaltmiete.numeric_precision);
    expect(kitchen.numeric_scale).toBe(kaltmiete.numeric_scale);
  });

  it('should create partial index properties_legal_owner_idx', async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'properties_legal_owner_idx'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].indexdef).toContain('WHERE');
    expect(rows[0].indexdef).toContain('legal_owner');
  });

  it('should set schema_version assets=30', async () => {
    const { rows } = await pool.query<{ version: number }>(
      "SELECT version FROM schema_version WHERE module = 'assets' AND version = 30"
    );
    expect(rows.length).toBe(1);
  });
});

describe('V030 Assets Extension — Constraints', () => {
  it('should allow NULL legal_owner', async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO properties (code, name, property_type) VALUES ('test-null', 'Test', 'residential') RETURNING id`
    );
    expect(rows.length).toBe(1);
    const { rows: check } = await pool.query(
      'SELECT legal_owner FROM properties WHERE id = $1', [rows[0].id]
    );
    expect(check[0].legal_owner).toBeNull();
  });

  it('should accept valid legal_owner value', async () => {
    await pool.query(
      `INSERT INTO properties (code, name, property_type, legal_owner) VALUES ('test-owner', 'Test', 'residential', 'Juergen Bickel')`
    );
    const { rows } = await pool.query<{ legal_owner: string }>(
      "SELECT legal_owner FROM properties WHERE code = 'test-owner'"
    );
    expect(rows[0].legal_owner).toBe('Juergen Bickel');
  });

  it('should allow NULL garage_amount and kitchen_amount', async () => {
    // Need a unit for the lease FK
    const { rows: propRows } = await pool.query<{ id: number }>(
      "SELECT id FROM properties WHERE code = 'test-null'"
    );
    const { rows: unitRows } = await pool.query<{ id: number }>(
      `INSERT INTO units (property_id, code, unit_type, living_area_qm) VALUES ($1, 'U1', 'apartment', 50) RETURNING id`,
      [propRows[0].id]
    );
    const { rows: leaseRows } = await pool.query<{ id: number }>(
      `INSERT INTO leases (unit_id, lease_type, start_date) VALUES ($1, 'residential', '2025-01-01') RETURNING id`,
      [unitRows[0].id]
    );
    const { rows: check } = await pool.query(
      'SELECT garage_amount, kitchen_amount FROM leases WHERE id = $1', [leaseRows[0].id]
    );
    expect(check[0].garage_amount).toBeNull();
    expect(check[0].kitchen_amount).toBeNull();
  });

  it('should accept valid garage_amount and kitchen_amount', async () => {
    // Ensure a property + unit exists
    const { rows: propRows } = await pool.query<{ id: number }>(
      `INSERT INTO properties (code, name, property_type) VALUES ('test-garage', 'Test Garage', 'residential')
       ON CONFLICT (code) DO UPDATE SET name = 'Test Garage' RETURNING id`
    );
    const { rows: unitRows } = await pool.query<{ id: number }>(
      `INSERT INTO units (property_id, code, unit_type, living_area_qm) VALUES ($1, 'U2', 'apartment', 60) RETURNING id`,
      [propRows[0].id]
    );
    const { rows } = await pool.query<{ garage_amount: string; kitchen_amount: string }>(
      `INSERT INTO leases (unit_id, lease_type, start_date, garage_amount, kitchen_amount)
       VALUES ($1, 'residential', '2025-06-01', 75.00, 25.50)
       RETURNING garage_amount, kitchen_amount`,
      [unitRows[0].id]
    );
    expect(parseFloat(rows[0].garage_amount)).toBe(75.00);
    expect(parseFloat(rows[0].kitchen_amount)).toBe(25.50);
  });
});

describe('V030 Assets Extension — Rollback + Re-Apply', () => {
  it('should drop V030 columns and index cleanly', async () => {
    await pool.query('DROP INDEX IF EXISTS properties_legal_owner_idx');
    await pool.query('ALTER TABLE properties DROP COLUMN IF EXISTS legal_owner');
    await pool.query('ALTER TABLE leases DROP COLUMN IF EXISTS garage_amount');
    await pool.query('ALTER TABLE leases DROP COLUMN IF EXISTS kitchen_amount');
    await pool.query("DELETE FROM schema_version WHERE module = 'assets' AND version = 30");

    // Verify columns gone
    const { rows } = await pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'properties' AND column_name = 'legal_owner')
          OR (table_name = 'leases' AND column_name IN ('garage_amount', 'kitchen_amount')))
    `);
    expect(rows.length).toBe(0);

    // Verify index gone
    const { rows: idx } = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'properties_legal_owner_idx'"
    );
    expect(idx.length).toBe(0);

    // Verify schema_version gone
    const { rows: sv } = await pool.query(
      "SELECT * FROM schema_version WHERE module = 'assets' AND version = 30"
    );
    expect(sv.length).toBe(0);
  });

  it('should re-apply V030 DDL after rollback', async () => {
    const ddl = readFileSync(
      join(import.meta.dir, '../migrations/V030__assets_extension.sql'),
      'utf-8',
    );
    await pool.query(ddl);

    // Verify 3 columns exist
    const { rows } = await pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'properties' AND column_name = 'legal_owner')
          OR (table_name = 'leases' AND column_name IN ('garage_amount', 'kitchen_amount')))
      ORDER BY column_name
    `);
    expect(rows.length).toBe(3);

    // Verify index restored
    const { rows: idx } = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'properties_legal_owner_idx'"
    );
    expect(idx.length).toBe(1);

    // Verify schema_version restored
    const { rows: sv } = await pool.query(
      "SELECT * FROM schema_version WHERE module = 'assets' AND version = 30"
    );
    expect(sv.length).toBe(1);
  });
});
