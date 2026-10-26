/**
 * briefing/routes — GET /api/briefing?tage=7 für das Dashboard-Panel.
 *
 * Nur lesend. Auth: Bearer CORE_SERVICE_TOKEN wie alle Core-Modulrouten; das
 * Dashboard ruft über proxyToCore hinter seiner Sitzungsprüfung.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { listeBriefings } from './store.js';

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export function registerBriefingHttpRoutes(api: any) {
  const coreServiceToken = process.env.CORE_SERVICE_TOKEN || '';

  api.registerHttpRoute({
    path: '/api/briefing',
    auth: 'plugin',
    match: 'prefix',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      const authHeader = req.headers?.authorization || '';
      if (!coreServiceToken || authHeader !== `Bearer ${coreServiceToken}`) {
        json(res, 401, { error: 'Unauthorized' });
        return true;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if ((req.method || 'GET').toUpperCase() !== 'GET' || !/^\/api\/briefing\/?$/.test(url.pathname)) {
        json(res, 404, { error: 'Unbekannte Briefing-Route' });
        return true;
      }
      try {
        const tage = Number(url.searchParams.get('tage') || '7');
        json(res, 200, { briefings: await listeBriefings(tage) });
      } catch (e: any) {
        json(res, 500, { error: e?.message || String(e) });
      }
      return true;
    },
  });
}
