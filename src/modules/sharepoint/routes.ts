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
import { upsertSingleFileAfterUpload } from './store.js';

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function err(res: ServerResponse, status: number, message: string) {
  json(res, status, { ok: false, error: message });
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

        err(res, 404, 'Not found');
      });
    } catch (e: any) {
      err(res, 500, e.message);
    }

    return true;
  });

  api.logger.info('[sharepoint] HTTP routes registered (Sprint 10)');
}
