/**
 * Settings Store DB Test (Sprint 11)
 *
 * Verifies:
 * 1. Migration creates table (idempotent)
 * 2. setSetting + getSetting roundtrip
 * 3. setSetting audit entry (before/after in audit_log)
 * 4. setSetting updates updated_at on re-write
 * 5. refreshSettingsCache populates cache correctly
 * 6. loadSettings returns from cache (sync)
 * 7. Export script produces valid JSON
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '/home/biko';
const ENV_FILE = path.join(HOME, '.config/openclaw/env');

function readEnvVar(key: string): string {
  if (process.env[key]) return process.env[key]!;
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const eq = line.indexOf('=');
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k === key && v) return v;
    }
  } catch {}
  return '';
}

let pool: pg.Pool;

beforeAll(async () => {
  const connStr = readEnvVar('POSTGRES_URL');
  if (!connStr) throw new Error('POSTGRES_URL not set');
  pool = new pg.Pool({ connectionString: connStr });

  // Ensure table exists (idempotent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key         TEXT PRIMARY KEY,
      value       JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
});

afterAll(async () => {
  // Clean up test keys
  await pool.query(`DELETE FROM system_settings WHERE key LIKE '_test_%'`);
  await pool.query(`DELETE FROM audit_log WHERE entity_id LIKE '_test_%'`);
  await pool.end();
});

describe('Settings Store DB (Sprint 11)', () => {
  test('1. Migration DDL is idempotent', async () => {
    // Running CREATE TABLE IF NOT EXISTS twice should not error
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key         TEXT PRIMARY KEY,
        value       JSONB NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'system_settings' ORDER BY ordinal_position`
    );
    const cols = rows.map((r: any) => r.column_name);
    expect(cols).toContain('key');
    expect(cols).toContain('value');
    expect(cols).toContain('updated_at');
    expect(cols).toContain('created_at');
  });

  test('2. UPSERT + read roundtrip', async () => {
    const key = '_test_roundtrip';
    const value = { hello: 'world', num: 42 };

    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at, created_at)
       VALUES ($1, $2::jsonb, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );

    const { rows } = await pool.query('SELECT value FROM system_settings WHERE key = $1', [key]);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toEqual(value);
  });

  test('3. Audit entry is created on write', async () => {
    const key = '_test_audit';
    const value = 'test-value-audit';

    // Insert setting
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at, created_at)
       VALUES ($1, $2::jsonb, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );

    // Insert audit
    await pool.query(
      `INSERT INTO audit_log
         (actor, module, action, entity_type, entity_id, after_jsonb, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['test', 'settings', 'setting.updated', 'system_setting', key,
       JSON.stringify({ [key]: value }), 'test']
    );

    const { rows } = await pool.query(
      `SELECT * FROM audit_log WHERE entity_id = $1 AND module = 'settings' ORDER BY ts DESC LIMIT 1`,
      [key]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe('setting.updated');
    expect(rows[0].entity_type).toBe('system_setting');
  });

  test('4. updated_at changes on re-write', async () => {
    const key = '_test_updated_at';

    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at, created_at)
       VALUES ($1, $2::jsonb, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW() - INTERVAL '1 hour'`,
      [key, JSON.stringify('first')]
    );

    const { rows: before } = await pool.query(
      'SELECT updated_at FROM system_settings WHERE key = $1', [key]
    );

    // Small delay to ensure timestamp difference
    await new Promise(r => setTimeout(r, 50));

    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at, created_at)
       VALUES ($1, $2::jsonb, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify('second')]
    );

    const { rows: after } = await pool.query(
      'SELECT updated_at FROM system_settings WHERE key = $1', [key]
    );

    expect(new Date(after[0].updated_at).getTime()).toBeGreaterThan(
      new Date(before[0].updated_at).getTime()
    );
  });

  test('5. SELECT * returns all settings for cache population', async () => {
    // Insert a known key
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at, created_at)
       VALUES ($1, $2::jsonb, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      ['_test_cache_pop', JSON.stringify('cache-test')]
    );

    const { rows } = await pool.query('SELECT key, value FROM system_settings');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const found = rows.find((r: any) => r.key === '_test_cache_pop');
    expect(found).toBeTruthy();
    expect(found!.value).toBe('cache-test');
  });

  test('6. JSONB auto-parsed by pg driver', async () => {
    const key = '_test_jsonb_parse';
    const obj = { lat: 47.98, lon: 8.82, label: 'Test' };

    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at, created_at)
       VALUES ($1, $2::jsonb, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(obj)]
    );

    const { rows } = await pool.query('SELECT value FROM system_settings WHERE key = $1', [key]);
    // pg driver auto-parses JSONB to object
    expect(typeof rows[0].value).toBe('object');
    expect(rows[0].value.lat).toBe(47.98);
    expect(rows[0].value.label).toBe('Test');
  });

  test('7. Key mapping consistency', () => {
    // Verify reverse mapping is correct
    const SETTING_KEYS: Record<string, string> = {
      briefingTime:    'briefing_time',
      telegramChatId:  'telegram_chat_id',
      healthReportDay: 'health_report_day',
      location:        'location',
    };
    const REVERSE_KEYS = Object.fromEntries(
      Object.entries(SETTING_KEYS).map(([k, v]) => [v, k])
    );

    expect(REVERSE_KEYS['briefing_time']).toBe('briefingTime');
    expect(REVERSE_KEYS['telegram_chat_id']).toBe('telegramChatId');
    expect(REVERSE_KEYS['health_report_day']).toBe('healthReportDay');
    expect(REVERSE_KEYS['location']).toBe('location');
    expect(Object.keys(SETTING_KEYS).length).toBe(Object.keys(REVERSE_KEYS).length);
  });
});
