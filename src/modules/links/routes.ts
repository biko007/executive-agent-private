/**
 * links/routes — HTTP API endpoints for Links module (Sprint 9 Etappe 9.3).
 * All endpoints registered via api.registerHttpRoute().
 * Auth: Bearer CORE_SERVICE_TOKEN.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody } from '../../util/body-parser.js';
import { withContext, generateId } from '../../shared/correlation/index.js';
import {
  getAllLinks, getLinksForEntity, getLinkById,
  addSharePointLink, addLocalLink, removeLink, updateEntityId,
  searchSharePointForLinking,
} from '../../shared/links/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function err(res: ServerResponse, status: number, message: string) {
  json(res, status, { ok: false, error: message });
}

// ── Route registration ───────────────────────────────────────────────────────

export function registerLinksHttpRoutes(api: any) {
  const coreServiceToken = process.env.CORE_SERVICE_TOKEN || '';

  function authCheck(req: IncomingMessage, res: ServerResponse): boolean {
    const authHeader = req.headers?.authorization || '';
    if (!coreServiceToken || authHeader !== `Bearer ${coreServiceToken}`) {
      err(res, 401, 'Unauthorized');
      return false;
    }
    return true;
  }

  api.registerHttpRoute({
    path: '/api/links',
    auth: 'plugin',
    match: 'prefix',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (!authCheck(req, res)) return true;
    const actor = (req.headers['x-actor'] as string) || 'system';
    const requestId = (req.headers['x-request-id'] as string) || generateId();

    // Strip /api/links prefix and split into segments
    const rest = pathname.replace(/^\/api\/links\/?/, '');
    const segments = rest.split('/').filter(Boolean);

    try {
      await withContext({ requestId, actor, source: 'dashboard' }, async () => {
        // GET /api/links — all links
        if (!segments.length && req.method === 'GET') {
          const links = await getAllLinks();
          json(res, 200, links);
          return;
        }

        // GET /api/links/search/sp?q=...
        if (segments[0] === 'search' && segments[1] === 'sp' && req.method === 'GET') {
          const q = url.searchParams.get('q') || '';
          if (!q.trim()) { json(res, 200, []); return; }
          const results = await searchSharePointForLinking(q);
          json(res, 200, results);
          return;
        }

        // POST /api/links/rename-entity
        if (segments[0] === 'rename-entity' && req.method === 'POST') {
          const body = await parseJsonBody(req);
          if (!body.entity_type || !body.old_entity_id || !body.new_entity_id) {
            err(res, 400, 'entity_type, old_entity_id, new_entity_id required');
            return;
          }
          const count = await updateEntityId(body.entity_type, body.old_entity_id, body.new_entity_id);
          json(res, 200, { ok: true, updated: count });
          return;
        }

        // POST /api/links — add link
        if (!segments.length && req.method === 'POST') {
          const body = await parseJsonBody(req);
          if (!body.entityType || !body.entityId || !body.docType || !body.label) {
            err(res, 400, 'entityType, entityId, docType, label required');
            return;
          }

          if (body.docType === 'sharepoint') {
            const spMatch = {
              name: body.spName || body.label,
              webUrl: body.spWebUrl || '',
              driveId: body.spDriveId || '',
              itemId: body.spItemId || '',
              siteName: '',
              path: '',
              size: 0,
            };
            const link = await addSharePointLink(body.entityType, body.entityId, spMatch, body.label);
            json(res, 201, link);
          } else if (body.docType === 'local') {
            const link = await addLocalLink(body.entityType, body.entityId, body.localPath || '', body.label);
            json(res, 201, link);
          } else {
            err(res, 400, 'docType must be "sharepoint" or "local"');
          }
          return;
        }

        // DELETE /api/links/:link_code
        if (segments.length === 1 && req.method === 'DELETE') {
          const linkCode = segments[0];
          const removed = await removeLink(linkCode);
          if (!removed) { err(res, 404, 'Link not found'); return; }
          json(res, 200, { ok: true, deleted: linkCode });
          return;
        }

        // GET /api/links/:entityType/:entityId
        if (segments.length === 2 && req.method === 'GET') {
          const [entityType, entityId] = segments;
          const links = await getLinksForEntity(entityType, entityId);
          json(res, 200, links);
          return;
        }

        err(res, 404, 'Not found');
      });
    } catch (e: any) {
      err(res, 500, e.message);
    }

    return true;
  }});

  api.logger.info('[links] HTTP routes registered');
}
