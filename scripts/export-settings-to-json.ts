#!/usr/bin/env bun
/**
 * export-settings-to-json.ts — Export system_settings from DB back to settings.json (rollback).
 *
 * Usage:
 *   bun run scripts/export-settings-to-json.ts          (stdout only)
 *   bun run scripts/export-settings-to-json.ts --write  (writes settings.json)
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const HOME = process.env.HOME || '/home/biko';
const ENV_FILE = path.join(HOME, '.config/openclaw/env');
const SETTINGS_FILE = path.join(HOME, '.openclaw/workspace/artifacts/personal/health/settings.json');

const WRITE = process.argv.includes('--write');

// Reverse mapping: DB snake_case -> JSON camelCase
const REVERSE_KEYS: Record<string, string> = {
  briefing_time:    'briefingTime',
  telegram_chat_id: 'telegramChatId',
  health_report_day: 'healthReportDay',
  location:         'location',
};

// Keys to exclude from JSON export (not part of settings.json)
const EXCLUDE_KEYS = new Set(['sp_default_site_id']);

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
  const connStr = readEnvVar('POSTGRES_URL');
  if (!connStr) {
    console.error('POSTGRES_URL not set');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: connStr });

  try {
    const { rows } = await pool.query('SELECT key, value FROM system_settings');

    const settings: Record<string, unknown> = {};
    for (const row of rows) {
      if (EXCLUDE_KEYS.has(row.key)) continue;
      const jsonKey = REVERSE_KEYS[row.key];
      if (jsonKey) {
        settings[jsonKey] = row.value;
      }
    }

    const json = JSON.stringify(settings, null, 2);

    if (WRITE) {
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, json + '\n', 'utf-8');
      console.log(`✅ Written to ${SETTINGS_FILE}`);
    } else {
      console.log(json);
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
