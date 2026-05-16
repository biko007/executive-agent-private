#!/usr/bin/env bun
/**
 * Sprint 8 Migration — Location history.jsonl → Postgres
 *
 * Usage:
 *   bun run scripts/migrate-sprint8-location.ts              # dry-run (default)
 *   bun run scripts/migrate-sprint8-location.ts --apply      # import into DB
 *
 * Environment:
 *   POSTGRES_URL  — connection string (reads from ~/.config/openclaw/env if missing)
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Config ──────────────────────────────────────────────────────────────────

const HISTORY_FILE = join(homedir(), '.openclaw/workspace/artifacts/personal/location/history.jsonl');

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadEnv(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL not set and ~/.config/openclaw/env not found');
  const content = readFileSync(envFile, 'utf-8');
  const match = content.match(/^POSTGRES_URL=(.+)$/m);
  if (!match) throw new Error('POSTGRES_URL not found in env');
  return match[1];
}

interface LocationEntry {
  lat: number;
  lon: number;
  label?: string;
  altitude?: number | string | null;
  timestamp?: string;
}

// ── Parse ───────────────────────────────────────────────────────────────────

function parseHistoryFile(): { valid: LocationEntry[]; skipped: LocationEntry[]; parseErrors: string[] } {
  if (!existsSync(HISTORY_FILE)) {
    throw new Error(`history.jsonl not found: ${HISTORY_FILE}`);
  }

  const raw = readFileSync(HISTORY_FILE, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  const valid: LocationEntry[] = [];
  const skipped: LocationEntry[] = [];
  const parseErrors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry: LocationEntry = JSON.parse(lines[i]);
      const lat = Number(entry.lat);
      const lon = Number(entry.lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        parseErrors.push(`Line ${i + 1}: invalid lat/lon (${entry.lat}, ${entry.lon})`);
        continue;
      }

      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        skipped.push(entry);
        continue;
      }

      valid.push(entry);
    } catch (e: any) {
      parseErrors.push(`Line ${i + 1}: JSON parse error: ${e.message}`);
    }
  }

  return { valid, skipped, parseErrors };
}

// ── Dry Run ─────────────────────────────────────────────────────────────────

function dryRun(): void {
  console.log('=== Sprint 8 Location Migration — DRY RUN ===\n');

  const { valid, skipped, parseErrors } = parseHistoryFile();

  console.log(`Source:        ${HISTORY_FILE}`);
  console.log(`Total lines:   ${valid.length + skipped.length + parseErrors.length}`);
  console.log(`Valid entries:  ${valid.length}`);
  console.log(`Skipped (range): ${skipped.length}`);
  console.log(`Parse errors:  ${parseErrors.length}`);

  if (skipped.length > 0) {
    console.log('\n--- Skipped entries (|lat|>90 or |lon|>180) ---');
    for (const s of skipped) {
      console.log(`  lat=${s.lat}, lon=${s.lon}, timestamp=${s.timestamp}`);
    }
  }

  if (parseErrors.length > 0) {
    console.log('\n--- Parse errors ---');
    for (const e of parseErrors) {
      console.log(`  ${e}`);
    }
  }

  if (valid.length > 0) {
    console.log('\n--- Sample entries (first 3) ---');
    for (const v of valid.slice(0, 3)) {
      console.log(`  ${v.timestamp}  ${v.label ?? '(no label)'}  (${v.lat}, ${v.lon})  alt=${v.altitude ?? 'null'}`);
    }
    console.log('\n--- Sample entries (last 3) ---');
    for (const v of valid.slice(-3)) {
      console.log(`  ${v.timestamp}  ${v.label ?? '(no label)'}  (${v.lat}, ${v.lon})  alt=${v.altitude ?? 'null'}`);
    }
  }

  console.log('\nDry run complete. Use --apply to import.');
}

// ── Apply ───────────────────────────────────────────────────────────────────

async function apply(): Promise<void> {
  console.log('=== Sprint 8 Location Migration — APPLY ===\n');

  const { valid, skipped, parseErrors } = parseHistoryFile();

  console.log(`Valid: ${valid.length} | Skipped: ${skipped.length} | ParseErrors: ${parseErrors.length}`);

  const pool = new pg.Pool({ connectionString: loadEnv(), max: 5 });

  try {
    // Verify table exists
    const { rows: tableCheck } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'location_events') AS ok`,
    );
    if (!tableCheck[0]?.ok) {
      throw new Error('Table location_events does not exist. Run the gateway first to apply migrations.');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert valid entries
      let inserted = 0;
      for (const entry of valid) {
        const altitude = entry.altitude != null ? parseFloat(String(entry.altitude)) : null;
        const altitudeVal = altitude != null && Number.isFinite(altitude) ? altitude : null;
        const recordedAt = entry.timestamp ?? new Date().toISOString();

        const { rowCount } = await client.query(
          `INSERT INTO location_events (recorded_at, lat, lon, altitude_m, source, label, geocoded_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
          [
            recordedAt,
            entry.lat,
            entry.lon,
            altitudeVal,
            'ios_shortcut',
            entry.label ?? null,
            entry.label ? recordedAt : null,
            recordedAt,
          ],
        );
        inserted += rowCount ?? 0;
      }

      // Audit-log skipped entries
      for (const entry of skipped) {
        await client.query(
          `INSERT INTO audit_log (actor, module, action, entity_type, after_jsonb, source)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            'migration-sprint8',
            'location',
            'import_skip',
            'location_event',
            JSON.stringify({ lat: entry.lat, lon: entry.lon, timestamp: entry.timestamp, reason: 'lat/lon out of range' }),
            'migrate-sprint8-location',
          ],
        );
      }

      await client.query('COMMIT');

      console.log(`\nInserted: ${inserted} location events`);
      console.log(`Audit-logged: ${skipped.length} skipped entries`);

      // ── Post-import verification ────────────────────────────────────────
      console.log('\n--- Verification ---');

      const { rows: countRows } = await pool.query('SELECT COUNT(*) AS cnt FROM location_events');
      console.log(`DB count: ${countRows[0].cnt}`);

      const { rows: latest } = await pool.query(
        'SELECT id, recorded_at, lat, lon, label FROM location_events ORDER BY recorded_at DESC LIMIT 1',
      );
      if (latest[0]) {
        console.log(`Latest:  id=${latest[0].id} ${latest[0].recorded_at} ${latest[0].label} (${latest[0].lat}, ${latest[0].lon})`);
      }

      // 3 random spot-checks
      const { rows: samples } = await pool.query(
        `SELECT id, recorded_at, lat, lon, label, altitude_m
         FROM location_events ORDER BY RANDOM() LIMIT 3`,
      );
      console.log('\nSpot-checks:');
      for (const s of samples) {
        console.log(`  id=${s.id} ${s.recorded_at} ${s.label} (${s.lat}, ${s.lon}) alt=${s.altitude_m}`);
      }

      // Audit log verification
      const { rows: auditRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM audit_log WHERE module='location' AND action='import_skip'`,
      );
      console.log(`\nAudit skip entries: ${auditRows[0].cnt}`);

    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  console.log('\nMigration complete.');
}

// ── Main ────────────────────────────────────────────────────────────────────

const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';

if (mode === 'apply') {
  apply().catch(e => {
    console.error(`\nFATAL: ${e.message}`);
    process.exit(1);
  });
} else {
  dryRun();
}
