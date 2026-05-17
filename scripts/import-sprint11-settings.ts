#!/usr/bin/env bun
/**
 * import-sprint11-settings.ts — One-shot data import from settings.json to system_settings table.
 *
 * Usage:
 *   bun run scripts/import-sprint11-settings.ts --dry-run   (default)
 *   bun run scripts/import-sprint11-settings.ts --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const HOME = process.env.HOME || '/home/biko';
const ENV_FILE = path.join(HOME, '.config/openclaw/env');
const SETTINGS_FILE = path.join(HOME, '.openclaw/workspace/artifacts/personal/health/settings.json');

const APPLY = process.argv.includes('--apply');

// Dashboard Site-ID (index.html:1417)
const SP_DEFAULT_SITE_ID = 'bikolino.sharepoint.com,a932d186-4e5a-4970-802e-72cc898bc400,c304330a-e682-4f42-b5a1-2e34c1057084';

// Key mapping: JSON camelCase -> DB snake_case
const KEY_MAP: Record<string, string> = {
  briefingTime:    'briefing_time',
  telegramChatId:  'telegram_chat_id',
  healthReportDay: 'health_report_day',
  location:        'location',
};

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

async function main() {
  console.log(`\n📦 Sprint 11 Settings Import — ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  // Read settings.json
  if (!fs.existsSync(SETTINGS_FILE)) {
    console.error(`❌ ${SETTINGS_FILE} not found`);
    process.exit(1);
  }
  const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  console.log(`📄 settings.json: ${JSON.stringify(settings, null, 2)}\n`);

  // Build entries to import
  const entries: Array<{ dbKey: string; value: unknown }> = [];

  for (const [jsonKey, dbKey] of Object.entries(KEY_MAP)) {
    if (settings[jsonKey] !== undefined) {
      entries.push({ dbKey, value: settings[jsonKey] });
    }
  }

  // Seed: sp_default_site_id
  entries.push({ dbKey: 'sp_default_site_id', value: SP_DEFAULT_SITE_ID });

  console.log(`🔑 Entries to import (${entries.length}):`);
  for (const e of entries) {
    const display = typeof e.value === 'object' ? JSON.stringify(e.value) : String(e.value);
    console.log(`   ${e.dbKey} = ${display.slice(0, 80)}`);
  }
  console.log('');

  if (!APPLY) {
    console.log('ℹ️  Dry-run mode. Use --apply to write to DB.');
    process.exit(0);
  }

  // Connect to DB
  const connStr = readEnvVar('POSTGRES_URL');
  if (!connStr) {
    console.error('❌ POSTGRES_URL not set');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: connStr });

  try {
    for (const { dbKey, value } of entries) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // UPSERT
        await client.query(
          `INSERT INTO system_settings (key, value, updated_at, created_at)
           VALUES ($1, $2::jsonb, NOW(), NOW())
           ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value, updated_at = NOW()`,
          [dbKey, JSON.stringify(value)]
        );

        // Audit
        await client.query(
          `INSERT INTO audit_log
             (actor, module, action, entity_type, entity_id,
              before_jsonb, after_jsonb, source, correlation_id, request_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            'migration-sprint11', 'settings', 'setting.imported',
            'system_setting', dbKey,
            null, JSON.stringify({ [dbKey]: value }),
            'script', 'sprint11-import', `import-${dbKey}`,
          ]
        );

        await client.query('COMMIT');
        console.log(`   ✅ ${dbKey}`);
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`   ❌ ${dbKey}: ${err.message}`);
      } finally {
        client.release();
      }
    }

    console.log(`\n✅ Import complete (${entries.length} keys)`);
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
