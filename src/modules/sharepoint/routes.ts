/**
 * sharepoint/routes — HTTP API endpoints for SharePoint module (Sprint 10).
 * Registered via api.registerHttpHandler(). Auth: Bearer CORE_SERVICE_TOKEN.
 * Dashboard proxies to these routes via proxyToCore().
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody } from '../../util/body-parser.js';
import { withContext, generateId } from '../../shared/correlation/index.js';
import {
  searchFiles, listSitesFromDb, listDrivesFromDb, listFilesFromDb,
} from './queries.js';
import { query } from '../../shared/db/index.js';
import { upsertSingleFileAfterUpload } from './store.js';
import * as audit from '../../shared/audit/index.js';

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function err(res: ServerResponse, status: number, message: string) {
  json(res, status, { ok: false, error: message });
}

/* ── Default-site resolution (Sprint 11.4) ────────────────────────────────── */

async function getDefaultSite(): Promise<{
  site_id: string; site_name: string;
  drive_id: string; drive_name: string;
  source: 'settings' | 'first-site';
} | null> {
  // 1. Read sp_default_site_id from system_settings
  const { rows: settingsRows } = await query(
    'SELECT value FROM system_settings WHERE key = $1',
    ['sp_default_site_id']
  );
  const settingSiteId = settingsRows.length > 0
    ? (typeof settingsRows[0].value === 'string' ? settingsRows[0].value : null)
    : null;

  // 2. If setting exists, validate against sharepoint_files
  if (settingSiteId) {
    const { rows: validRows } = await query(
      `SELECT site_id, site_name, drive_id, drive_name
       FROM sharepoint_files
       WHERE site_id = $1 AND missing_since IS NULL
       LIMIT 1`,
      [settingSiteId]
    );
    if (validRows.length > 0) {
      const { rows: driveRows } = await query(
        `SELECT drive_id, drive_name, COUNT(*)::int AS file_count
         FROM sharepoint_files
         WHERE site_id = $1 AND missing_since IS NULL
         GROUP BY drive_id, drive_name
         ORDER BY drive_name
         LIMIT 1`,
        [settingSiteId]
      );
      if (driveRows.length > 0) {
        return {
          site_id: settingSiteId,
          site_name: validRows[0].site_name,
          drive_id: driveRows[0].drive_id,
          drive_name: driveRows[0].drive_name,
          source: 'settings',
        };
      }
    }
  }

  // 3. Fallback: first site from sharepoint_files
  const { rows: fallbackRows } = await query(
    `SELECT DISTINCT site_id, site_name
     FROM sharepoint_files
     WHERE missing_since IS NULL
     ORDER BY site_name
     LIMIT 1`
  );
  if (fallbackRows.length === 0) return null;

  const fallbackSiteId = fallbackRows[0].site_id;
  const { rows: fallbackDrives } = await query(
    `SELECT drive_id, drive_name
     FROM sharepoint_files
     WHERE site_id = $1 AND missing_since IS NULL
     GROUP BY drive_id, drive_name
     ORDER BY drive_name
     LIMIT 1`,
    [fallbackSiteId]
  );
  if (fallbackDrives.length === 0) return null;

  return {
    site_id: fallbackSiteId,
    site_name: fallbackRows[0].site_name,
    drive_id: fallbackDrives[0].drive_id,
    drive_name: fallbackDrives[0].drive_name,
    source: 'first-site',
  };
}

/* ── Route registration ───────────────────────────────────────────────────── */

export function registerSharePointHttpRoutes(api: any) {
  const coreServiceToken = process.env.CORE_SERVICE_TOKEN || '';

  function authCheck(req: IncomingMessage, res: ServerResponse): boolean {
    const authHeader = req.headers?.authorization || '';
    if (!coreServiceToken || authHeader !== `Bearer ${coreServiceToken}`) {
      err(res, 401, 'Unauthorized');
      return false;
    }
    return true;
  }

  api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    // Only handle /api/sharepoint paths
    if (!pathname.startsWith('/api/sharepoint')) return false;

    if (!authCheck(req, res)) return true;
    const actor = (req.headers['x-actor'] as string) || 'system';
    const requestId = (req.headers['x-request-id'] as string) || generateId();

    // Strip /api/sharepoint prefix
    const rest = pathname.replace(/^\/api\/sharepoint\/?/, '');
    const segments = rest.split('/').filter(Boolean);

    try {
      await withContext({ requestId, actor, source: 'dashboard' }, async () => {
        // GET /api/sharepoint/sites
        if (segments[0] === 'sites' && segments.length === 1 && req.method === 'GET') {
          const sites = await listSitesFromDb();
          json(res, 200, sites);
          return;
        }

        // GET /api/sharepoint/drives/:siteId
        if (segments[0] === 'drives' && segments.length === 2 && req.method === 'GET') {
          const siteId = decodeURIComponent(segments[1]);
          const drives = await listDrivesFromDb(siteId);
          json(res, 200, drives);
          return;
        }

        // GET /api/sharepoint/files/:siteId/:driveId?folderId=&limit=&offset=
        if (segments[0] === 'files' && segments.length === 3 && req.method === 'GET') {
          const siteId = decodeURIComponent(segments[1]);
          const driveId = decodeURIComponent(segments[2]);
          const folderId = url.searchParams.get('folderId') || undefined;
          const limit = parseInt(url.searchParams.get('limit') || '100', 10);
          const offset = parseInt(url.searchParams.get('offset') || '0', 10);

          const files = await listFilesFromDb({
            siteId, driveId, folderId,
            limit: Math.min(limit, 500),
            offset: Math.max(offset, 0),
          });
          json(res, 200, files);
          return;
        }

        // GET /api/sharepoint/search?q=
        if (segments[0] === 'search' && segments.length === 1 && req.method === 'GET') {
          const q = url.searchParams.get('q') || '';
          if (!q.trim()) { json(res, 200, []); return; }
          const limit = parseInt(url.searchParams.get('limit') || '25', 10);
          const results = await searchFiles(q, Math.min(limit, 100));
          json(res, 200, results);
          return;
        }

        // GET /api/sharepoint/default-site (Sprint 11.4)
        if (segments[0] === 'default-site' && segments.length === 1 && req.method === 'GET') {
          const result = await getDefaultSite();
          if (!result) {
            err(res, 503, 'no sharepoint sites available');
            return;
          }
          json(res, 200, result);
          return;
        }

        // POST /api/sharepoint/upsert-uploaded
        if (segments[0] === 'upsert-uploaded' && segments.length === 1 && req.method === 'POST') {
          const body = await parseJsonBody(req);
          if (!body.name || !body.siteId || !body.driveId || !body.path) {
            err(res, 400, 'name, siteId, driveId, path required');
            return;
          }
          await upsertSingleFileAfterUpload({
            name: body.name,
            webUrl: body.webUrl || '',
            size: body.size || 0,
            lastModifiedDateTime: body.lastModifiedDateTime || new Date().toISOString(),
            createdDateTime: body.createdDateTime || new Date().toISOString(),
            id: body.graphItemId || undefined,
            file: body.mimeType ? { mimeType: body.mimeType } : undefined,
            siteId: body.siteId,
            driveId: body.driveId,
            siteName: body.siteName || '',
            driveName: body.driveName || '',
            path: body.path,
          });
          json(res, 200, { ok: true });
          return;
        }

        // POST /api/sharepoint/cleanup-missing (Sprint 11.6)
        if (segments[0] === 'cleanup-missing' && segments.length === 1 && req.method === 'POST') {
          const dryRun = url.searchParams.get('dry_run') !== 'false'; // default true

          // 2x-Sync-Schutz: verify ≥2 successful sync runs after oldest candidate's missing_since
          const { rows: oldestRows } = await query(
            `SELECT MIN(missing_since) AS oldest
             FROM sharepoint_files
             WHERE missing_since IS NOT NULL
               AND missing_since < NOW() - INTERVAL '30 days'`
          );
          const oldestMissing = oldestRows[0]?.oldest;

          if (oldestMissing) {
            const { rows: syncRows } = await query(
              `SELECT COUNT(*)::int AS cnt
               FROM sharepoint_sync_runs
               WHERE started_at > $1
                 AND status = 'success'`,
              [oldestMissing]
            );
            if ((syncRows[0]?.cnt ?? 0) < 2) {
              // Not enough syncs — skip with warning
              const warnMsg = `⚠️ SP cleanup-missing SKIPPED: only ${syncRows[0]?.cnt ?? 0} successful syncs after oldest candidate (${oldestMissing}). Need ≥2.`;
              try {
                await fetch('http://127.0.0.1:18789/api/internal/notify', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ message: warnMsg, severity: 'warn' }),
                });
              } catch { /* notify best-effort */ }
              await audit.log({
                actor: 'system', module: 'sharepoint', action: 'cleanup_missing_skipped',
                entityType: 'sharepoint_files', source: 'maintenance',
                after: { reason: '2x_sync_guard', syncs_after_oldest: syncRows[0]?.cnt ?? 0 },
              });
              json(res, 200, { skipped: true, reason: '2x_sync_guard', syncs_after_oldest: syncRows[0]?.cnt ?? 0 });
              return;
            }
          }

          // Candidate query (shared by dry/live)
          const candidateSql = `
            SELECT sp_item_key, name, path, site_name, last_modified_at, missing_since
            FROM sharepoint_files
            WHERE missing_since IS NOT NULL
              AND missing_since < NOW() - INTERVAL '30 days'
              AND NOT EXISTS (
                SELECT 1 FROM entity_links
                WHERE doc_type LIKE 'sharepoint%'
                  AND sp_item_id = sharepoint_files.sp_item_key
              )
            ORDER BY missing_since ASC
            LIMIT 50
          `;
          const { rows: candidates } = await query(candidateSql);

          // Stats: total eligible count (no LIMIT)
          const { rows: totalRows } = await query(`
            SELECT COUNT(*)::int AS cnt
            FROM sharepoint_files
            WHERE missing_since IS NOT NULL
              AND missing_since < NOW() - INTERVAL '30 days'
              AND NOT EXISTS (
                SELECT 1 FROM entity_links
                WHERE doc_type LIKE 'sharepoint%'
                  AND sp_item_id = sharepoint_files.sp_item_key
              )
          `);
          const totalCount = totalRows[0]?.cnt ?? 0;

          // Stats: excluded by entity_links
          const { rows: excludedRows } = await query(`
            SELECT COUNT(*)::int AS cnt
            FROM sharepoint_files
            WHERE missing_since IS NOT NULL
              AND missing_since < NOW() - INTERVAL '30 days'
              AND EXISTS (
                SELECT 1 FROM entity_links
                WHERE doc_type LIKE 'sharepoint%'
                  AND sp_item_id = sharepoint_files.sp_item_key
              )
          `);
          const excludedByLinks = excludedRows[0]?.cnt ?? 0;

          const oldestCandidate = candidates.length > 0 ? candidates[0].missing_since : null;
          const newestCandidate = candidates.length > 0 ? candidates[candidates.length - 1].missing_since : null;

          if (dryRun) {
            await audit.log({
              actor: 'system', module: 'sharepoint', action: 'cleanup_missing_dry_run',
              entityType: 'sharepoint_files', source: 'maintenance',
              after: { total_count: totalCount, excluded_by_links: excludedByLinks, batch_size: candidates.length },
            });
            json(res, 200, {
              dry_run: true,
              candidates,
              total_count: totalCount,
              excluded_by_links: excludedByLinks,
              oldest_missing: oldestCandidate,
              newest_missing: newestCandidate,
            });
            return;
          }

          // Live: DELETE with subquery (Postgres has no DELETE ... LIMIT)
          const { rows: deleted } = await query(`
            DELETE FROM sharepoint_files
            WHERE sp_item_key IN (
              SELECT sp_item_key FROM sharepoint_files
              WHERE missing_since IS NOT NULL
                AND missing_since < NOW() - INTERVAL '30 days'
                AND NOT EXISTS (
                  SELECT 1 FROM entity_links
                  WHERE doc_type LIKE 'sharepoint%'
                    AND sp_item_id = sharepoint_files.sp_item_key
                )
              ORDER BY missing_since ASC
              LIMIT 50
            )
            RETURNING sp_item_key, name, path, site_name, last_modified_at
          `);

          await audit.log({
            actor: 'system', module: 'sharepoint', action: 'cleanup_missing_deleted',
            entityType: 'sharepoint_files', source: 'maintenance',
            after: { deleted_count: deleted.length, total_eligible: totalCount, excluded_by_links: excludedByLinks, items: deleted },
          });

          // Telegram notify
          const notifyMsg = `🗑️ SP cleanup-missing: ${deleted.length} files hard-deleted (${totalCount} eligible, ${excludedByLinks} excluded by links)`;
          try {
            await fetch('http://127.0.0.1:18789/api/internal/notify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: notifyMsg, severity: 'info' }),
            });
          } catch { /* notify best-effort */ }

          json(res, 200, {
            dry_run: false,
            deleted,
            deleted_count: deleted.length,
            total_count: totalCount,
            excluded_by_links: excludedByLinks,
            oldest_missing: oldestCandidate,
            newest_missing: newestCandidate,
          });
          return;
        }

        err(res, 404, 'Not found');
      });
    } catch (e: any) {
      err(res, 500, e.message);
    }

    return true;
  });

  api.logger.info('[sharepoint] HTTP routes registered (Sprint 10)');
}
