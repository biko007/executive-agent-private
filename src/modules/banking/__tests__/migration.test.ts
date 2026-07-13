/**
 * Banking Migration Tests — Sprint 7b
 * Tests V027 schema apply, constraints, indexes, rollback, and re-apply.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTestDb } from './test-db-setup.js';

let cleanup: () => Promise<void>;
let pool: pg.Pool;

beforeAll(async () => {
  const setup = await setupTestDb();
  cleanup = setup.cleanup;
  pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
});

afterAll(async () => {
  await pool.end();
  await cleanup();
});

describe('V027 Banking Schema — Apply', () => {
  it('should create all banking tables (V027-V039)', async () => {
    const { rows } = await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'banking_%'
      ORDER BY table_name
    `);
    expect(rows.map(r => r.table_name)).toEqual([
      'banking_accounts',
      'banking_institutions',
      'banking_sessions',
      'banking_sync_reminders',
      'banking_sync_runs',
      'banking_transactions',
    ]);
  });

  it('should set schema_version banking=27', async () => {
    const { rows } = await pool.query<{ module: string; version: number }>(
      "SELECT module, version FROM schema_version WHERE module = 'banking' AND version = 27"
    );
    expect(rows.length).toBe(1);
    expect(rows[0].module).toBe('banking');
    expect(rows[0].version).toBe(27);
  });

  it('should have 4 updated_at triggers', async () => {
    const { rows } = await pool.query<{ trigger_name: string }>(`
      SELECT trigger_name FROM information_schema.triggers
      WHERE trigger_name LIKE 'trg_banking_%_updated_at'
      ORDER BY trigger_name
    `);
    expect(rows.length).toBe(4);
    expect(rows.map(r => r.trigger_name)).toEqual([
      'trg_banking_accounts_updated_at',
      'trg_banking_institutions_updated_at',
      'trg_banking_sessions_updated_at',
      'trg_banking_transactions_updated_at',
    ]);
  });

  it('should have expected indexes', async () => {
    const { rows } = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE 'idx_banking_%'
      ORDER BY indexname
    `);
    expect(rows.map(r => r.indexname)).toEqual([
      'idx_banking_accounts_institution_status',
      'idx_banking_sessions_institution',
      'idx_banking_sync_reminders_session',
      'idx_banking_transactions_account_date',
    ]);
  });
});

describe('V027 Banking Schema — Constraints', () => {
  it('should enforce UNIQUE on banking_institutions.blz', async () => {
    await pool.query(
      "INSERT INTO banking_institutions (blz, name, fints_url) VALUES ('64350070', 'KSK Tuttlingen', 'https://example.com/fints')"
    );
    await expect(
      pool.query("INSERT INTO banking_institutions (blz, name, fints_url) VALUES ('64350070', 'Duplicate', 'https://example.com/fints2')")
    ).rejects.toThrow(/unique/i);
  });

  it('should enforce UNIQUE on banking_accounts.iban', async () => {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM banking_institutions WHERE blz = '64350070'"
    );
    const instId = rows[0].id;

    await pool.query(
      `INSERT INTO banking_accounts (institution_id, iban, display_name) VALUES ($1, 'DE89370400440532013000', 'Test Konto')`,
      [instId]
    );
    await expect(
      pool.query(
        `INSERT INTO banking_accounts (institution_id, iban, display_name) VALUES ($1, 'DE89370400440532013000', 'Duplicate')`,
        [instId]
      )
    ).rejects.toThrow(/unique/i);
  });

  it('should enforce CHECK on banking_accounts.status', async () => {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM banking_institutions WHERE blz = '64350070'"
    );
    const instId = rows[0].id;

    await expect(
      pool.query(
        `INSERT INTO banking_accounts (institution_id, iban, display_name, status) VALUES ($1, 'DE00000000000000000001', 'Bad Status', 'invalid')`,
        [instId]
      )
    ).rejects.toThrow(/check|violates/i);
  });

  it('should enforce FK banking_accounts.institution_id', async () => {
    await expect(
      pool.query(
        "INSERT INTO banking_accounts (institution_id, iban, display_name) VALUES (99999, 'DE00000000000000000002', 'No Institution')"
      )
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('should enforce UNIQUE (account_id, bank_transaction_id) on banking_transactions', async () => {
    const { rows: accRows } = await pool.query<{ id: number }>(
      "SELECT id FROM banking_accounts LIMIT 1"
    );
    const accId = accRows[0].id;

    await pool.query(
      `INSERT INTO banking_transactions (account_id, bank_transaction_id, booking_date, amount, currency, raw_payload)
       VALUES ($1, 'TX001', '2026-05-01', 100.00, 'EUR', '{}')`,
      [accId]
    );
    await expect(
      pool.query(
        `INSERT INTO banking_transactions (account_id, bank_transaction_id, booking_date, amount, currency, raw_payload)
         VALUES ($1, 'TX001', '2026-05-02', 200.00, 'EUR', '{}')`,
        [accId]
      )
    ).rejects.toThrow(/unique/i);
  });

  it('should CASCADE delete transactions when account is deleted', async () => {
    // Create a separate account for this test
    const { rows: instRows } = await pool.query<{ id: number }>(
      "SELECT id FROM banking_institutions WHERE blz = '64350070'"
    );
    const instId = instRows[0].id;

    const { rows: accRows } = await pool.query<{ id: number }>(
      `INSERT INTO banking_accounts (institution_id, iban, display_name) VALUES ($1, 'DE11111111111111111111', 'Cascade Test') RETURNING id`,
      [instId]
    );
    const accId = accRows[0].id;

    await pool.query(
      `INSERT INTO banking_transactions (account_id, bank_transaction_id, booking_date, amount, currency, raw_payload)
       VALUES ($1, 'TX-CASCADE', '2026-05-01', 50.00, 'EUR', '{}')`,
      [accId]
    );

    // Delete account — transactions should cascade
    await pool.query('DELETE FROM banking_accounts WHERE id = $1', [accId]);

    const { rows: txRows } = await pool.query(
      "SELECT id FROM banking_transactions WHERE bank_transaction_id = 'TX-CASCADE'"
    );
    expect(txRows.length).toBe(0);
  });

  it('should RESTRICT delete on institution when accounts exist', async () => {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM banking_institutions WHERE blz = '64350070'"
    );
    const instId = rows[0].id;

    await expect(
      pool.query('DELETE FROM banking_institutions WHERE id = $1', [instId])
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

describe('V027 Banking Schema — Rollback + Re-Apply', () => {
  it('should drop all banking tables cleanly', async () => {
    // Drop in FK-safe order (includes V039 banking_sync_runs)
    const tables = ['banking_sync_runs', 'banking_sync_reminders', 'banking_sessions', 'banking_transactions', 'banking_accounts', 'banking_institutions'];
    for (const t of tables) {
      await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
    await pool.query("DELETE FROM schema_version WHERE module = 'banking'");

    const { rows } = await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'banking_%'
    `);
    expect(rows.length).toBe(0);

    const { rows: sv } = await pool.query(
      "SELECT * FROM schema_version WHERE module = 'banking'"
    );
    expect(sv.length).toBe(0);
  });

  it('should re-apply V027 DDL after rollback', async () => {
    const ddl = readFileSync(
      join(import.meta.dir, '../migrations/V027__banking_tables.sql'),
      'utf-8',
    );
    await pool.query(ddl);

    const { rows } = await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'banking_%'
      ORDER BY table_name
    `);
    expect(rows.length).toBe(4);

    // Tables should be empty after re-apply
    for (const r of rows) {
      const { rows: countRows } = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM ${r.table_name}`
      );
      expect(countRows[0].c).toBe(0);
    }

    // schema_version should be set again
    const { rows: sv } = await pool.query(
      "SELECT * FROM schema_version WHERE module = 'banking' AND version = 27"
    );
    expect(sv.length).toBe(1);
  });
});

describe('V027 Banking Schema — Audit Whitelist', () => {
  it('should tail-mask iban field', async () => {
    const { maskSensitiveFields } = await import('../../../shared/audit/index.js');
    const result = maskSensitiveFields({ iban: 'DE89370400440532013000', display_name: 'Test' });
    expect(result.iban).toBe('***3000');
    expect(result.display_name).toBe('Test');
  });

  it('should tail-mask account_number field', async () => {
    const { maskSensitiveFields } = await import('../../../shared/audit/index.js');
    const result = maskSensitiveFields({ account_number: '0532013000' });
    expect(result.account_number).toBe('***3000');
  });

  it('should tail-mask counterparty_iban field', async () => {
    const { maskSensitiveFields } = await import('../../../shared/audit/index.js');
    const result = maskSensitiveFields({ counterparty_iban: 'DE27100777770209299700' });
    expect(result.counterparty_iban).toBe('***9700');
  });

  it('should strip encrypted fields entirely', async () => {
    const { maskSensitiveFields } = await import('../../../shared/audit/index.js');
    const result = maskSensitiveFields({
      id: 1,
      user_id_encrypted: 'DUMMY_ENCRYPTED_VALUE',
      pin_encrypted: 'DUMMY_ENCRYPTED_VALUE',
      session_state_encrypted: 'DUMMY_ENCRYPTED_VALUE',
      product_id: 'test-product',
    });
    expect(result).not.toHaveProperty('user_id_encrypted');
    expect(result).not.toHaveProperty('pin_encrypted');
    expect(result).not.toHaveProperty('session_state_encrypted');
    expect(result.product_id).toBe('test-product');
  });
});
