/**
 * sharepoint/queries — Read-side DB queries for SharePoint files (Sprint 10).
 *
 * All queries filter on missing_since IS NULL (active files only).
 * Search uses pg_trgm GIN index on search_haystack column.
 */
import { query } from '../../shared/db/index.js';

/* ── Types ─────────────────────────────────────────────────────────────────── */

export interface SharePointFile {
  id: number;
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
  missing_since: string | null;
  synced_at: string;
  created_at: string;
}

export interface SiteSummary {
  site_id: string;
  site_name: string;
  file_count: number;
}

export interface DriveSummary {
  drive_id: string;
  drive_name: string;
  file_count: number;
}

/* ── Row mapper ────────────────────────────────────────────────────────────── */

function rowToFile(row: any): SharePointFile {
  return {
    id: row.id,
    sp_item_key: row.sp_item_key,
    graph_item_id: row.graph_item_id || null,
    name: row.name,
    path: row.path,
    web_url: row.web_url,
    size: Number(row.size),
    mime_type: row.mime_type || null,
    last_modified_at: row.last_modified_at instanceof Date ? row.last_modified_at.toISOString() : row.last_modified_at,
    created_at_remote: row.created_at_remote instanceof Date ? row.created_at_remote.toISOString() : row.created_at_remote,
    site_name: row.site_name,
    site_id: row.site_id,
    drive_name: row.drive_name,
    drive_id: row.drive_id,
    missing_since: row.missing_since instanceof Date ? row.missing_since.toISOString() : row.missing_since || null,
    synced_at: row.synced_at instanceof Date ? row.synced_at.toISOString() : row.synced_at,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

/* ── Search ────────────────────────────────────────────────────────────────── */

/**
 * Search files using pg_trgm. Multi-word queries are AND-combined.
 * Empty or whitespace-only query returns empty array.
 */
export async function searchFiles(queryStr: string, limit = 25): Promise<SharePointFile[]> {
  const terms = queryStr.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  // Build WHERE clause: one ILIKE condition per term (AND)
  const conditions = ['missing_since IS NULL'];
  const params: unknown[] = [];
  for (const term of terms) {
    params.push(`%${term}%`);
    conditions.push(`search_haystack ILIKE $${params.length}`);
  }
  params.push(limit);

  const sql = `
    SELECT * FROM sharepoint_files
    WHERE ${conditions.join(' AND ')}
    ORDER BY last_modified_at DESC
    LIMIT $${params.length}`;

  const { rows } = await query(sql, params);
  return rows.map(rowToFile);
}

/* ── List sites ────────────────────────────────────────────────────────────── */

export async function listSitesFromDb(): Promise<SiteSummary[]> {
  const { rows } = await query(`
    SELECT site_id, site_name, COUNT(*)::int AS file_count
    FROM sharepoint_files
    WHERE missing_since IS NULL
    GROUP BY site_id, site_name
    ORDER BY site_name`);
  return rows;
}

/* ── List drives ───────────────────────────────────────────────────────────── */

export async function listDrivesFromDb(siteId: string): Promise<DriveSummary[]> {
  const { rows } = await query(`
    SELECT drive_id, drive_name, COUNT(*)::int AS file_count
    FROM sharepoint_files
    WHERE missing_since IS NULL AND site_id = $1
    GROUP BY drive_id, drive_name
    ORDER BY drive_name`, [siteId]);
  return rows;
}

/* ── List files ────────────────────────────────────────────────────────────── */

export async function listFilesFromDb(opts: {
  siteId?: string;
  driveId?: string;
  folderId?: string;
  orderBy?: string;
  limit?: number;
  offset?: number;
}): Promise<SharePointFile[]> {
  const conditions = ['missing_since IS NULL'];
  const params: unknown[] = [];

  if (opts.siteId) {
    params.push(opts.siteId);
    conditions.push(`site_id = $${params.length}`);
  }
  if (opts.driveId) {
    params.push(opts.driveId);
    conditions.push(`drive_id = $${params.length}`);
  }
  if (opts.folderId) {
    // folderId is treated as a path prefix (folder path)
    params.push(opts.folderId + '/%');
    conditions.push(`path LIKE $${params.length}`);
  }

  const orderBy = opts.orderBy === 'last_modified_at' ? 'last_modified_at DESC' : 'name ASC';
  const limit = Math.min(opts.limit || 100, 500);
  const offset = opts.offset || 0;

  params.push(limit);
  params.push(offset);

  const sql = `
    SELECT * FROM sharepoint_files
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const { rows } = await query(sql, params);
  return rows.map(rowToFile);
}

/* ── Get single file ──────────────────────────────────────────────────────── */

export async function getFileByKey(spItemKey: string): Promise<SharePointFile | null> {
  const { rows } = await query(
    'SELECT * FROM sharepoint_files WHERE sp_item_key = $1',
    [spItemKey],
  );
  return rows.length ? rowToFile(rows[0]) : null;
}

/* ── Count helper (for smoke tests) ───────────────────────────────────────── */

export async function countActiveFiles(): Promise<number> {
  const { rows } = await query('SELECT COUNT(*)::int AS cnt FROM sharepoint_files WHERE missing_since IS NULL');
  return rows[0].cnt;
}
