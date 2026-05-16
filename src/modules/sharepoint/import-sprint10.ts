#!/usr/bin/env npx tsx
/**
 * Sprint 10 — One-Shot Import: sharepoint-index.json → sharepoint_files
 *
 * Run: npx tsx src/modules/sharepoint/import-sprint10.ts
 *
 * - Advisory-Lock 44 (released in finally)
 * - sync_runs entry OUTSIDE transaction (survives rollback)
 * - Batch INSERT (500 per statement)
 * - Count verification: DB === JSON
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { buildSpItemKey } from './key.js';

const HOME = process.env.HOME || '/home/biko';
const SP_INDEX_PATH = path.join(HOME, '.openclaw/workspace/artifacts/personal/sharepoint/sharepoint-index.json');

// Read POSTGRES_URL from env file
function readEnvVar(key: string): string {
  if (process.env[key]) return process.env[key]!;
  try {
    const content = fs.readFileSync(path.join(HOME, '.config/openclaw/env'), 'utf-8');
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

interface IndexFile {
  siteId: string;
  driveId: string;
  path: string;
  name: string;
  webUrl: string;
  size: number;
  mimeType?: string;
  lastModifiedDateTime: string;
  createdDateTime: string;
  siteName: string;
  driveName: string;
  id?: string; // graph_item_id, may not exist in old data
}

interface DbRecord {
  sp_item_key: string;
  graph_item_id: string | null;
  name: string;
  path: string;
  web_url: string;
  size: number;
  mime_type: string | null;
  last_modified_at: string;
  created_at_remote: string;
  site_name: string;
  site_id: string;
  drive_name: string;
  drive_id: string;
}

function buildRecord(f: IndexFile): DbRecord {
  return {
    sp_item_key: buildSpItemKey(f.siteId, f.driveId, f.path),
    graph_item_id: f.id || null,
    name: f.name,
    path: f.path,
    web_url: f.webUrl,
    size: f.size || 0,
    mime_type: f.mimeType || null,
    last_modified_at: f.lastModifiedDateTime || new Date(0).toISOString(),
    created_at_remote: f.createdDateTime || new Date(0).toISOString(),
    site_name: f.siteName,
    site_id: f.siteId,
    drive_name: f.driveName,
    drive_id: f.driveId,
  };
}

function findDuplicateKeys(records: DbRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    counts.set(r.sp_item_key, (counts.get(r.sp_item_key) || 0) + 1);
  }
  return [...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function buildBulkInsertSql(batch: DbRecord[]): { text: string; values: unknown[] } {
  const cols = [
    'sp_item_key', 'graph_item_id', 'name', 'path', 'web_url', 'size',
    'mime_type', 'last_modified_at', 'created_at_remote',
    'site_name', 'site_id', 'drive_name', 'drive_id',
  ];
  const values: unknown[] = [];
  const rows: string[] = [];

  for (const rec of batch) {
    const placeholders: string[] = [];
    for (const col of cols) {
      values.push((rec as any)[col]);
      placeholders.push(`$${values.length}`);
    }
    rows.push(`(${placeholders.join(', ')})`);
  }

  const text = `INSERT INTO sharepoint_files (${cols.join(', ')}) VALUES ${rows.join(', ')}`;
  return { text, values };
}

async function importSprint10() {
  const connStr = readEnvVar('POSTGRES_URL');
  if (!connStr) throw new Error('POSTGRES_URL not set');

  const pool = new pg.Pool({ connectionString: connStr, max: 2 });
  const client = await pool.connect();
  const startedAt = new Date();
  let runId: number | null = null;
  let lockAcquired = false;

  try {
    // Lock OUTSIDE transaction, MUST release in finally
    const lockRes = await client.query('SELECT pg_try_advisory_lock(44)');
    if (!lockRes.rows[0].pg_try_advisory_lock) {
      throw new Error('Advisory-Lock 44 belegt — anderer Sync läuft');
    }
    lockAcquired = true;
    console.log('[import] Advisory-Lock 44 acquired');

    // Sync-Run OUTSIDE transaction (survives rollback)
    const runRes = await client.query(
      `INSERT INTO sharepoint_sync_runs (started_at, status, triggered_by)
       VALUES ($1, 'running', 'import-sprint10') RETURNING id`,
      [startedAt],
    );
    runId = runRes.rows[0].id;
    console.log(`[import] sync_run #${runId} created`);

    // Load JSON index
    console.log(`[import] Loading ${SP_INDEX_PATH}...`);
    const indexJson = JSON.parse(fs.readFileSync(SP_INDEX_PATH, 'utf-8'));
    const files: IndexFile[] = indexJson.files || [];
    console.log(`[import] JSON contains ${files.length} files (synced: ${indexJson.syncedAt})`);

    // Build records
    const records = files.map(buildRecord);

    // Duplicate-key check
    const duplicates = findDuplicateKeys(records);
    if (duplicates.length > 0) {
      throw new Error(`Duplicate sp_item_keys found (${duplicates.length}): ${duplicates.slice(0, 5).join(', ')}`);
    }
    console.log('[import] No duplicate keys');

    // Collect size=0 diagnostics
    const zeroSizeKeys = records.filter(r => r.size === 0).map(r => r.sp_item_key);
    if (zeroSizeKeys.length > 0) {
      console.log(`[import] ${zeroSizeKeys.length} files with size=0 (will be imported)`);
    }

    // Bulk insert in transaction
    const batches = chunk(records, 500);
    console.log(`[import] Inserting ${records.length} records in ${batches.length} batches...`);

    await client.query('BEGIN');
    for (let i = 0; i < batches.length; i++) {
      const { text, values } = buildBulkInsertSql(batches[i]);
      await client.query(text, values);
      if ((i + 1) % 5 === 0 || i === batches.length - 1) {
        console.log(`[import] Batch ${i + 1}/${batches.length} inserted`);
      }
    }
    await client.query('COMMIT');
    console.log('[import] All batches committed');

    // Count verification
    const countRes = await client.query('SELECT COUNT(*) FROM sharepoint_files');
    const dbCount = parseInt(countRes.rows[0].count, 10);
    if (dbCount !== records.length) {
      throw new Error(`Count mismatch: DB=${dbCount}, JSON=${records.length}`);
    }
    console.log(`[import] Count verified: ${dbCount} rows in DB === ${records.length} in JSON`);

    // Update sync_run to success
    const durationMs = Date.now() - startedAt.getTime();
    await client.query(
      `UPDATE sharepoint_sync_runs
       SET finished_at=NOW(), status='success', total_files=$1,
           total_sites=$2, total_drives=$3,
           duration_ms=$4, errors=$5
       WHERE id=$6`,
      [
        records.length,
        indexJson.totalSites || null,
        indexJson.totalDrives || null,
        durationMs,
        JSON.stringify(
          zeroSizeKeys.length > 0
            ? [{ type: 'size_zero', count: zeroSizeKeys.length, sample: zeroSizeKeys.slice(0, 5) }]
            : [],
        ),
        runId,
      ],
    );

    console.log(`[import] SUCCESS — ${dbCount} files imported in ${(durationMs / 1000).toFixed(1)}s`);

  } catch (err) {
    // Try to rollback if in transaction
    try { await client.query('ROLLBACK'); } catch {}

    // Update sync_run to error (outside transaction)
    if (runId !== null) {
      try {
        await client.query(
          `UPDATE sharepoint_sync_runs
           SET finished_at=NOW(), status='error', errors=$1 WHERE id=$2`,
          [JSON.stringify([{ message: String(err) }]), runId],
        );
      } catch {}
    }
    throw err;

  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(44)');
        console.log('[import] Advisory-Lock 44 released');
      } catch {}
    }
    client.release();
    await pool.end();
  }
}

// Run
importSprint10().then(() => {
  console.log('[import] Done.');
  process.exit(0);
}).catch((err) => {
  console.error(`[import] FATAL: ${err.message || err}`);
  process.exit(1);
});
