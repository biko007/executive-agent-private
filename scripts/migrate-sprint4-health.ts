#!/usr/bin/env bun
/**
 * Sprint 4 Migration — Health JSONL + Withings Tokens → Postgres
 *
 * Usage:
 *   npm run migrate:sprint4 -- --dry-run   (validate + inventory, no DB writes)
 *   npm run migrate:sprint4 -- --apply      (migrate within single transaction)
 *
 * Override DB: DB_NAME=health_sprint4_test npm run migrate:sprint4 -- --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { assertSafeDbUrl } from '../src/core/db-guard.js';

const { Pool } = pg;

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const APPLY = args.includes('--apply');

if (!DRY_RUN && !APPLY) {
  console.error('Usage: migrate-sprint4-health.ts --dry-run | --apply');
  process.exit(1);
}

// ── Config ──────────────────────────────────────────────────────────────────
const HOME = process.env.HOME || '/home/biko';
const ENV_FILE = path.join(HOME, '.config/openclaw/env');
const ARTIFACTS = path.join(HOME, '.openclaw/workspace/artifacts/personal');
const HEALTH_LOG = path.join(ARTIFACTS, 'health/health-log.jsonl');
const WITHINGS_TOKENS = path.join(ARTIFACTS, 'health/withings-tokens.json');
const MIGRATION_SQL = path.join(
  HOME, '.openclaw/workspace/.openclaw/extensions/executive-agent',
  'src/modules/health/migrations/V021__health_tables.sql',
);

// ── Valid types (from CHECK constraint) ─────────────────────────────────────
const VALID_TYPES = new Set(['weight', 'sleep', 'heartrate', 'steps', 'body_fat', 'activity']);

// ── Load env ────────────────────────────────────────────────────────────────
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const eq = line.indexOf('=');
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {}
  return env;
}

// ── Interfaces ──────────────────────────────────────────────────────────────

interface HealthLogRow {
  type: string;
  value_numeric: number | null;
  unit: string | null;
  source: string;
  metadata: Record<string, unknown>;
  recorded_at: string;    // ISO 8601
  external_id: string;
}

interface WithingsTokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: Date;
  userid: string;
  last_sync: Date | null;
}

interface ValidationError {
  line: number;
  field: string;
  message: string;
}

// ── Map a single JSONL line → DB row ────────────────────────────────────────

function mapLine(lineNum: number, raw: Record<string, unknown>): { row: HealthLogRow; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const type = raw.type as string;

  if (!type || !VALID_TYPES.has(type)) {
    errors.push({ line: lineNum, field: 'type', message: `Unknown type: "${type}"` });
  }
  if (!raw.id) {
    errors.push({ line: lineNum, field: 'id', message: 'Missing id' });
  }
  if (!raw.timestamp) {
    errors.push({ line: lineNum, field: 'timestamp', message: 'Missing timestamp' });
  }
  if (!raw.source) {
    errors.push({ line: lineNum, field: 'source', message: 'Missing source' });
  }

  // Extract value_numeric based on type
  let value_numeric: number | null = null;
  let unit: string | null = null;
  const metadata: Record<string, unknown> = {};

  switch (type) {
    case 'weight':
      value_numeric = raw.value as number ?? null;
      unit = (raw.unit as string) || 'kg';
      break;

    case 'body_fat':
      value_numeric = raw.value as number ?? null;
      unit = (raw.unit as string) || '%';
      break;

    case 'sleep':
      value_numeric = raw.value as number ?? null;
      unit = (raw.unit as string) || 'h';
      if (raw.deep_sleep_h != null) metadata.deep_sleep_h = raw.deep_sleep_h;
      if (raw.rem_sleep_h != null) metadata.rem_sleep_h = raw.rem_sleep_h;
      if (raw.light_sleep_h != null) metadata.light_sleep_h = raw.light_sleep_h;
      if (raw.quality != null) metadata.quality = raw.quality;
      break;

    case 'heartrate':
      value_numeric = raw.hr_avg as number ?? null;
      unit = 'bpm';
      if (raw.hr_min != null) metadata.hr_min = raw.hr_min;
      if (raw.hr_max != null) metadata.hr_max = raw.hr_max;
      break;

    case 'steps':
      value_numeric = raw.steps as number ?? null;
      unit = 'steps';
      if (raw.distance_m != null) metadata.distance_m = raw.distance_m;
      if (raw.calories != null) metadata.calories = raw.calories;
      break;

    case 'activity':
      value_numeric = raw.duration_min as number ?? null;
      unit = 'min';
      if (raw.activity_type != null) metadata.activity_type = raw.activity_type;
      if (raw.steps != null) metadata.steps = raw.steps;
      if (raw.distance_m != null) metadata.distance_m = raw.distance_m;
      if (raw.calories != null) metadata.calories = raw.calories;
      break;
  }

  if (value_numeric == null && type !== 'activity') {
    // activity may have 0 duration, but for others this is suspicious
    errors.push({ line: lineNum, field: 'value', message: `No numeric value extractable for type "${type}"` });
  }

  return {
    row: {
      type,
      value_numeric,
      unit,
      source: (raw.source as string) || 'withings',
      metadata,
      recorded_at: raw.timestamp as string,
      external_id: raw.id as string,
    },
    errors,
  };
}

// ── Map withings-tokens.json → DB row ───────────────────────────────────────

function mapToken(raw: Record<string, unknown>): { token: WithingsTokenRow; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!raw.access_token) errors.push({ line: 0, field: 'access_token', message: 'Missing' });
  if (!raw.refresh_token) errors.push({ line: 0, field: 'refresh_token', message: 'Missing' });
  if (!raw.expires_at) errors.push({ line: 0, field: 'expires_at', message: 'Missing' });
  if (!raw.userid) errors.push({ line: 0, field: 'userid', message: 'Missing' });

  return {
    token: {
      access_token: raw.access_token as string,
      refresh_token: raw.refresh_token as string,
      expires_at: new Date(raw.expires_at as number),
      userid: String(raw.userid),
      last_sync: raw.last_sync ? new Date(raw.last_sync as number) : null,
    },
    errors,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const mode = DRY_RUN ? 'DRY-RUN' : 'APPLY';
  console.log(`\n Sprint 4 Migration — Health JSONL + Withings Tokens → Postgres [${mode}]\n`);

  // ── Parse JSONL ─────────────────────────────────────────────────────────

  if (!fs.existsSync(HEALTH_LOG)) {
    console.error(`health-log.jsonl not found at ${HEALTH_LOG}`);
    process.exit(1);
  }

  const rawLines = fs.readFileSync(HEALTH_LOG, 'utf-8').trim().split('\n');
  console.log(`JSONL: ${rawLines.length} lines in ${HEALTH_LOG}`);

  const allErrors: ValidationError[] = [];
  const rows: HealthLogRow[] = [];
  const typeCounts: Record<string, number> = {};
  const malformedLines: { line: number; error: string; raw: string }[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const lineNum = i + 1;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawLines[i]);
    } catch (e) {
      malformedLines.push({
        line: lineNum,
        error: e instanceof Error ? e.message : String(e),
        raw: rawLines[i].substring(0, 80),
      });
      continue;
    }

    const { row, errors } = mapLine(lineNum, parsed);
    rows.push(row);
    allErrors.push(...errors);
    typeCounts[row.type] = (typeCounts[row.type] || 0) + 1;
  }

  // ── Parse Withings Tokens ───────────────────────────────────────────────

  let tokenRow: WithingsTokenRow | null = null;
  if (fs.existsSync(WITHINGS_TOKENS)) {
    const raw = JSON.parse(fs.readFileSync(WITHINGS_TOKENS, 'utf-8'));
    const { token, errors } = mapToken(raw);
    tokenRow = token;
    allErrors.push(...errors);
    console.log(`Withings Token: 1 file, expires ${token.expires_at.toISOString()}`);
  } else {
    console.log('Withings Token: file not found (skipping)');
  }

  // ── Inventory Report ──────────────────────────────────────────────────

  console.log('\n--- INVENTORY ---');
  console.log(`Total lines:     ${rawLines.length}`);
  console.log(`Parsed OK:       ${rows.length}`);
  console.log(`Malformed:       ${malformedLines.length}`);
  console.log('');
  console.log('Type breakdown:');
  for (const [t, c] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(12)} ${c}`);
  }

  if (malformedLines.length > 0) {
    console.log(`\nMalformed lines (${malformedLines.length}):`);
    for (const m of malformedLines.slice(0, 10)) {
      console.log(`  L${m.line}: ${m.error} → "${m.raw}"`);
    }
  }

  // ── Stopp-Kriterien ───────────────────────────────────────────────────

  const malformedPct = (malformedLines.length / rawLines.length) * 100;
  if (malformedPct > 20) {
    console.error(`\n STOP: ${malformedPct.toFixed(1)}% malformed (> 20% threshold). Aborting.`);
    process.exit(1);
  }

  if (allErrors.length > 0) {
    console.log(`\nValidation Errors (${allErrors.length}):`);
    for (const e of allErrors.slice(0, 20)) {
      console.log(`  L${e.line} ${e.field}: ${e.message}`);
    }
    if (APPLY) {
      console.error('\n Cannot apply — fix validation errors first.');
      process.exit(1);
    }
  } else {
    console.log('\n All data validated successfully.');
  }

  console.log(`\nSummary: ${rows.length} health_logs, ${tokenRow ? 1 : 0} withings token`);

  if (DRY_RUN) {
    console.log('\n Dry run complete. Use --apply to write to database.');
    process.exit(0);
  }

  // ── APPLY mode ────────────────────────────────────────────────────────

  const envVars = loadEnv();
  const dbName = process.env.DB_NAME || 'openclaw_core';

  let connStr = process.env.POSTGRES_URL || envVars.POSTGRES_URL || '';
  if (process.env.DB_NAME) {
    connStr = connStr.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  }

  if (!connStr) {
    console.error('POSTGRES_URL not set');
    process.exit(1);
  }

  if (process.env.OPENCLAW_TEST === '1') assertSafeDbUrl(connStr);

  console.log(`\nConnecting to ${dbName}...`);
  const pool = new Pool({ connectionString: connStr, max: 2 });
  const client = await pool.connect();

  try {
    // ── Run schema migration ──────────────────────────────────────────
    console.log('Running schema migration (V021__health_tables.sql)...');
    const migrationSql = fs.readFileSync(MIGRATION_SQL, 'utf-8');
    await client.query('BEGIN');

    // Ensure core tables exist (normally from 001_core_tables.sql)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        module TEXT NOT NULL, version INTEGER NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (module, version)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor TEXT, module TEXT NOT NULL, action TEXT NOT NULL,
        entity_type TEXT, entity_id TEXT,
        before_jsonb JSONB, after_jsonb JSONB,
        source TEXT NOT NULL DEFAULT 'system',
        correlation_id TEXT, request_id TEXT
      );
    `);

    await client.query(migrationSql);

    // ── Insert health_logs ────────────────────────────────────────────
    console.log(`Inserting ${rows.length} health_logs...`);
    let insertedCount = 0;
    for (const r of rows) {
      const result = await client.query(
        `INSERT INTO health_logs (type, value_numeric, unit, source, metadata, recorded_at, external_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source, type, external_id) WHERE external_id IS NOT NULL
         DO NOTHING`,
        [r.type, r.value_numeric, r.unit, r.source, JSON.stringify(r.metadata), r.recorded_at, r.external_id],
      );
      if (result.rowCount && result.rowCount > 0) insertedCount++;
    }

    // ── Insert withings token ─────────────────────────────────────────
    if (tokenRow) {
      console.log('Inserting withings token...');
      // Idempotent: skip if active token already exists
      await client.query(
        `INSERT INTO health_withings_tokens (access_token, refresh_token, expires_at, userid, active, last_sync)
         SELECT $1, $2, $3, $4, true, $5
         WHERE NOT EXISTS (SELECT 1 FROM health_withings_tokens WHERE active = true)`,
        [tokenRow.access_token, tokenRow.refresh_token, tokenRow.expires_at, tokenRow.userid, tokenRow.last_sync],
      );
    }

    // ── Post-insert validation ────────────────────────────────────────
    console.log('Post-insert validation...');
    const logCount = await client.query<{ count: string }>('SELECT count(*)::text as count FROM health_logs');
    const tkCount = await client.query<{ count: string }>('SELECT count(*)::text as count FROM health_withings_tokens');

    const lc = parseInt(logCount.rows[0].count, 10);
    const tc = parseInt(tkCount.rows[0].count, 10);

    const expectedLogs = rows.length;
    const expectedTokens = tokenRow ? 1 : 0;

    if (lc < expectedLogs || tc < expectedTokens) {
      throw new Error(
        `Count mismatch! health_logs: ${lc}/${expectedLogs}, tokens: ${tc}/${expectedTokens}. ROLLING BACK.`,
      );
    }

    // ── Audit log entry ───────────────────────────────────────────────
    await client.query(
      `INSERT INTO audit_log (actor, module, action, entity_type, after_jsonb, source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'system',
        'health',
        'system.sprint4_migration',
        'migration',
        JSON.stringify({
          health_logs_count: lc,
          inserted_count: insertedCount,
          skipped_duplicates: rows.length - insertedCount,
          tokens_count: tc,
          type_breakdown: typeCounts,
        }),
        'system',
      ],
    );

    await client.query('COMMIT');

    console.log('\n Migration complete!');
    console.log(`  health_logs:      ${lc} (${insertedCount} inserted, ${rows.length - insertedCount} skipped/dupes)`);
    console.log(`  withings_tokens:  ${tc}`);

    // Type breakdown from DB
    const typeResult = await pool.query<{ type: string; count: string }>(
      'SELECT type, count(*)::text FROM health_logs GROUP BY type ORDER BY count DESC',
    );
    console.log('\n Type breakdown in DB:');
    for (const row of typeResult.rows) {
      console.log(`  ${row.type.padEnd(12)} ${row.count}`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n Migration FAILED — rolled back: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
