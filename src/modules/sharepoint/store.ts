/**
 * sharepoint/store — DB-backed write operations for SharePoint sync (Sprint 10).
 *
 * Replaces sharepoint-store.ts fullSync() + polling with Postgres UPSERT + soft-delete.
 * Graph API helpers (listSites, listDrives, crawlFolder) remain in sharepoint-store.ts.
 */
import { getClient, query } from '../../shared/db/index.js';
import * as audit from '../../shared/audit/index.js';
import { buildSpItemKey } from './key.js';
import type { SPSyncResult, SPIndexEntry } from '../../../sharepoint-store.js';

// Re-export types
export type { SPSyncResult, SPIndexEntry };
export { buildSpItemKey } from './key.js';

// Re-export Graph functions that commands.ts and other modules need
export {
  listSites, listDrives, getRecentFiles, searchDocuments,
  downloadFile, uploadFile, listFiles,
} from '../../../sharepoint-store.js';

/* ── Types ─────────────────────────────────────────────────────────────────── */

export interface FileRecord {
  sp_item_key: string;
  graph_item_id?: string | null;
  name: string;
  path: string;
  web_url: string;
  size: number;
  mime_type?: string | null;
  last_modified_at: string;
  created_at_remote: string;
  site_name: string;
  site_id: string;
  drive_name: string;
  drive_id: string;
}

/* ── UPSERT SQL (shared between functions) ────────────────────────────────── */

const UPSERT_SQL = `
  INSERT INTO sharepoint_files
    (sp_item_key, graph_item_id, name, path, web_url, size, mime_type,
     last_modified_at, created_at_remote, site_name, site_id, drive_name, drive_id,
     synced_at, missing_since)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW(), NULL)
  ON CONFLICT (sp_item_key) DO UPDATE SET
    graph_item_id = COALESCE(EXCLUDED.graph_item_id, sharepoint_files.graph_item_id),
    name = EXCLUDED.name,
    path = EXCLUDED.path,
    web_url = EXCLUDED.web_url,
    size = EXCLUDED.size,
    mime_type = EXCLUDED.mime_type,
    last_modified_at = EXCLUDED.last_modified_at,
    created_at_remote = EXCLUDED.created_at_remote,
    site_name = EXCLUDED.site_name,
    site_id = EXCLUDED.site_id,
    drive_name = EXCLUDED.drive_name,
    drive_id = EXCLUDED.drive_id,
    synced_at = NOW(),
    missing_since = NULL`;

function upsertParams(rec: FileRecord): unknown[] {
  return [
    rec.sp_item_key, rec.graph_item_id || null,
    rec.name, rec.path, rec.web_url, rec.size, rec.mime_type || null,
    rec.last_modified_at, rec.created_at_remote,
    rec.site_name, rec.site_id, rec.drive_name, rec.drive_id,
  ];
}

/* ── Single file UPSERT ───────────────────────────────────────────────────── */

export async function upsertFile(rec: FileRecord): Promise<void> {
  await query(UPSERT_SQL, upsertParams(rec));
}

/* ── Soft-delete: mark files not seen in this sync ────────────────────────── */

export async function markMissingSince(seenKeys: Set<string>): Promise<number> {
  if (seenKeys.size === 0) return 0;

  const keysArray = [...seenKeys];
  const BATCH_SIZE = 1000;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE _seen_keys (key TEXT) ON COMMIT DROP');

    for (let i = 0; i < keysArray.length; i += BATCH_SIZE) {
      const batch = keysArray.slice(i, i + BATCH_SIZE);
      await client.query(
        `INSERT INTO _seen_keys (key) VALUES ${batch.map((_, idx) => `($${idx + 1})`).join(',')}`,
        batch,
      );
    }

    const result = await client.query(
      `UPDATE sharepoint_files
       SET missing_since = NOW()
       WHERE missing_since IS NULL
         AND sp_item_key NOT IN (SELECT key FROM _seen_keys)`,
    );
    const totalMarked = result.rowCount ?? 0;
    await client.query('COMMIT');
    return totalMarked;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ── Upsert after dashboard upload ────────────────────────────────────────── */

export async function upsertSingleFileAfterUpload(graphItem: {
  name: string;
  webUrl: string;
  size: number;
  lastModifiedDateTime: string;
  createdDateTime: string;
  id?: string;
  file?: { mimeType?: string };
  siteId: string;
  driveId: string;
  siteName: string;
  driveName: string;
  path: string;
}): Promise<void> {
  const rec: FileRecord = {
    sp_item_key: buildSpItemKey(graphItem.siteId, graphItem.driveId, graphItem.path),
    graph_item_id: graphItem.id || null,
    name: graphItem.name,
    path: graphItem.path,
    web_url: graphItem.webUrl,
    size: graphItem.size || 0,
    mime_type: graphItem.file?.mimeType || null,
    last_modified_at: graphItem.lastModifiedDateTime,
    created_at_remote: graphItem.createdDateTime,
    site_name: graphItem.siteName,
    site_id: graphItem.siteId,
    drive_name: graphItem.driveName,
    drive_id: graphItem.driveId,
  };
  await upsertFile(rec);
  await audit.log({
    module: 'sharepoint',
    action: 'upsert-after-upload',
    entityType: 'sharepoint_file',
    entityId: rec.sp_item_key,
    after: { name: rec.name, path: rec.path, size: rec.size },
  });
}

/* ── Full Sync (DB-backed, replaces sharepoint-store.ts fullSync) ─────────── */

type ProgressFn = (count: number, label?: string) => void;

export async function fullSync(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  onProgress?: ProgressFn,
  m365User?: string,
): Promise<SPSyncResult> {
  // Lock client is held throughout and used for lock + sync_run + unlock
  const lockClient = await getClient();
  const startedAt = new Date();
  let runId: number | null = null;
  let lockAcquired = false;

  try {
    // Advisory-Lock 44 on lockClient — session-level, stays until unlock or disconnect
    const lockRes = await lockClient.query('SELECT pg_try_advisory_lock(44)');
    if (!lockRes.rows[0].pg_try_advisory_lock) {
      throw new Error('Advisory-Lock 44 belegt — anderer Sync läuft');
    }
    lockAcquired = true;

    // Create sync_run on lockClient (OUTSIDE any transaction — survives rollback)
    const runRes = await lockClient.query(
      `INSERT INTO sharepoint_sync_runs (started_at, status, triggered_by)
       VALUES ($1, 'running', 'manual') RETURNING id`,
      [startedAt],
    );
    runId = runRes.rows[0].id;

    // Delegate to existing Graph crawl (sharepoint-store.ts fullSync)
    // skipJsonWrite=true: no JSON file written, files returned in result
    const { fullSync: legacyFullSync } = await import('../../../sharepoint-store.js');
    const result: SPSyncResult = await legacyFullSync(
      tenantId, clientId, clientSecret, onProgress, m365User, true,
    );
    const files: SPIndexEntry[] = result.files || [];

    // UPSERT all files using a separate client (lockClient stays for lock)
    const seenKeys = new Set<string>();
    let upsertCount = 0;

    for (const f of files) {
      const key = buildSpItemKey(f.siteId, f.driveId, f.path);
      seenKeys.add(key);
      await query(UPSERT_SQL, [
        key, null, // graph_item_id not in legacy index
        f.name, f.path, f.webUrl, f.size || 0, f.mimeType || null,
        f.lastModifiedDateTime || new Date(0).toISOString(),
        f.createdDateTime || new Date(0).toISOString(),
        f.siteName, f.siteId, f.driveName, f.driveId,
      ]);
      upsertCount++;
      if (onProgress && upsertCount % 500 === 0) {
        onProgress(upsertCount, `DB UPSERT ${upsertCount}/${files.length}`);
      }
    }

    // Soft-delete: mark active files not seen in this sync
    const newlyMissing = await markMissingSince(seenKeys);

    // Update sync_run on lockClient
    const durationMs = Date.now() - startedAt.getTime();
    await lockClient.query(
      `UPDATE sharepoint_sync_runs
       SET finished_at=NOW(), status='success', total_files=$1,
           total_sites=$2, total_drives=$3, newly_missing=$4,
           duration_ms=$5, errors=$6, skipped_sites=$7
       WHERE id=$8`,
      [
        files.length,
        result.totalSites,
        result.totalDrives,
        newlyMissing,
        durationMs,
        JSON.stringify(
          result.errors.length > 0
            ? result.errors.map((e: string) => ({ message: e }))
            : [],
        ),
        JSON.stringify(result.skippedSites || []),
        runId,
      ],
    );

    await audit.log({
      module: 'sharepoint',
      action: 'full-sync',
      entityType: 'sync_run',
      entityId: String(runId),
      after: {
        total_files: files.length,
        total_sites: result.totalSites,
        total_drives: result.totalDrives,
        newly_missing: newlyMissing,
        duration_ms: durationMs,
      },
    });

    return { ...result, durationMs };

  } catch (err) {
    // Update sync_run to error on lockClient (still connected)
    if (runId !== null) {
      try {
        await lockClient.query(
          `UPDATE sharepoint_sync_runs
           SET finished_at=NOW(), status='error', errors=$1 WHERE id=$2`,
          [JSON.stringify([{ message: String(err) }]), runId],
        );
      } catch {}
    }
    throw err;

  } finally {
    // Release lock on the SAME client that acquired it (session-level lock)
    if (lockAcquired) {
      try { await lockClient.query('SELECT pg_advisory_unlock(44)'); } catch {}
    }
    lockClient.release();
  }
}
