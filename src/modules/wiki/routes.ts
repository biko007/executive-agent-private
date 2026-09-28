/**
 * wiki/routes — HTTP-API des Wiki-Moduls unter /api/wiki.
 *
 * Auth: Bearer CORE_SERVICE_TOKEN (wie alle Core-Modulrouten). Der Core bindet
 * nur auf 127.0.0.1; der externe Zugang läuft über das Dashboard, das zusätzlich
 * Dashboard-Token, Session und CSRF prüft.
 *
 * Binärdateien werden hier bewusst NICHT ausgeliefert: der Dashboard-Proxy
 * überträgt nur JSON/Text. Anhänge liefert das Dashboard direkt vom
 * Dateisystem aus; diese Routen geben dafür nur die Metadaten samt relativem
 * Pfad zurück.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody } from '../../util/body-parser.js';
import { withContext, generateId } from '../../shared/correlation/index.js';
import {
  listPages, getPageBySlug, searchWiki, createPage, savePage,
  listRevisions, getRevision, setCategory, getAttachment, getPageIdBySlug,
  upsertAttachment, getStats,
} from './store.js';
import { WIKI_CATEGORIES, detectSensitive } from './convert.js';

// ── Helfer ──────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function err(res: ServerResponse, status: number, message: string) {
  json(res, status, { ok: false, error: message });
}

/** Slug-Prüfung: nur Kleinbuchstaben, Ziffern und Bindestriche. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/**
 * Dateinamen-Prüfung gegen Pfadausbrüche. Kein Schrägstrich, kein "..",
 * keine Steuerzeichen — der Name landet später in einem Dateipfad.
 */
function isSafeFilename(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name === '.' || name === '..' || name.startsWith('.')) return false;
  // Steuerzeichen U+0000 bis U+001F sind in Dateinamen nicht zulaessig.
  if (/[\u0000-\u001f]/.test(name)) return false;
  return true;
}

// ── Routen-Registrierung ────────────────────────────────────────────────────

export function registerWikiHttpRoutes(api: any) {
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
    path: '/api/wiki',
    auth: 'plugin',
    match: 'prefix',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (!authCheck(req, res)) return true;
      const actor = (req.headers['x-actor'] as string) || 'system';
      const requestId = (req.headers['x-request-id'] as string) || generateId();

      const rest = url.pathname.replace(/^\/api\/wiki\/?/, '');
      const segments = rest.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
      const method = (req.method || 'GET').toUpperCase();

      try {
        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          // GET /api/wiki/stats
          if (segments[0] === 'stats' && segments.length === 1 && method === 'GET') {
            json(res, 200, await getStats());
            return;
          }

          // GET /api/wiki/categories
          if (segments[0] === 'categories' && segments.length === 1 && method === 'GET') {
            json(res, 200, { categories: WIKI_CATEGORIES });
            return;
          }

          // GET /api/wiki/search?q=...&limit=
          if (segments[0] === 'search' && segments.length === 1 && method === 'GET') {
            const q = url.searchParams.get('q') || '';
            const limitRaw = Number(url.searchParams.get('limit') || '50');
            const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
            json(res, 200, { hits: await searchWiki(q, limit) });
            return;
          }

          // GET /api/wiki/pages
          if (segments[0] === 'pages' && segments.length === 1 && method === 'GET') {
            json(res, 200, { pages: await listPages() });
            return;
          }

          // POST /api/wiki/pages — neue Seite
          if (segments[0] === 'pages' && segments.length === 1 && method === 'POST') {
            const body = await parseJsonBody<{ title?: string; bodyMd?: string; category?: string }>(req);
            const title = String(body.title ?? '').trim();
            if (!title) { err(res, 400, 'title fehlt'); return; }
            const bodyMd = String(body.bodyMd ?? '');
            const category = String(body.category ?? 'Sonstiges');
            const page = await createPage({
              title,
              bodyMd,
              category,
              // Eine neu angelegte Seite wird sofort geprüft, damit der Agent
              // keine frisch eingetippten Zugangsdaten zu sehen bekommt.
              sensitive: detectSensitive(title, bodyMd),
              author: actor,
            });
            json(res, 201, page);
            return;
          }

          // Alles Weitere unter /api/wiki/pages/<slug>...
          if (segments[0] === 'pages' && segments.length >= 2) {
            const slug = segments[1];
            if (!SLUG_RE.test(slug)) { err(res, 400, 'Ungültiger Slug'); return; }

            // GET /api/wiki/pages/:slug
            if (segments.length === 2 && method === 'GET') {
              const page = await getPageBySlug(slug);
              if (!page) { err(res, 404, 'Seite nicht gefunden'); return; }
              json(res, 200, page);
              return;
            }

            // PUT /api/wiki/pages/:slug — speichern, erzeugt neue Revision
            if (segments.length === 2 && method === 'PUT') {
              const body = await parseJsonBody<{
                title?: string; bodyMd?: string; category?: string; sensitive?: boolean;
              }>(req);
              const existing = await getPageBySlug(slug);
              if (!existing) { err(res, 404, 'Seite nicht gefunden'); return; }
              const title = String(body.title ?? existing.title).trim();
              if (!title) { err(res, 400, 'title darf nicht leer sein'); return; }
              const bodyMd = body.bodyMd === undefined ? existing.bodyMd : String(body.bodyMd);

              // Sensibel bleibt gesetzt, sobald es einmal gesetzt war oder der
              // neue Text Geheimnismuster enthält. Nur eine ausdrückliche
              // Angabe im Request kann die Markierung aufheben.
              const autoSensitive = detectSensitive(title, bodyMd);
              const sensitive = body.sensitive === undefined
                ? (existing.sensitive || autoSensitive)
                : Boolean(body.sensitive);

              const page = await savePage(slug, {
                title, bodyMd, category: body.category, sensitive, author: actor,
              });
              json(res, 200, page);
              return;
            }

            // PATCH /api/wiki/pages/:slug/category
            if (segments.length === 3 && segments[2] === 'category' && method === 'PATCH') {
              const body = await parseJsonBody<{ category?: string }>(req);
              const category = String(body.category ?? '').trim();
              if (!category) { err(res, 400, 'category fehlt'); return; }
              const ok = await setCategory(slug, category);
              if (!ok) { err(res, 404, 'Seite nicht gefunden'); return; }
              json(res, 200, { ok: true, slug, category });
              return;
            }

            // GET /api/wiki/pages/:slug/revisions
            if (segments.length === 3 && segments[2] === 'revisions' && method === 'GET') {
              json(res, 200, { revisions: await listRevisions(slug) });
              return;
            }

            // GET /api/wiki/pages/:slug/revisions/:rev
            if (segments.length === 4 && segments[2] === 'revisions' && method === 'GET') {
              const rev = Number(segments[3]);
              if (!Number.isInteger(rev) || rev < 1) { err(res, 400, 'Ungültige Revision'); return; }
              const revision = await getRevision(slug, rev);
              if (!revision) { err(res, 404, 'Revision nicht gefunden'); return; }
              json(res, 200, revision);
              return;
            }

            // POST /api/wiki/pages/:slug/attachments — Metadaten eines vom
            // Dashboard bereits abgelegten Uploads eintragen.
            if (segments.length === 3 && segments[2] === 'attachments' && method === 'POST') {
              const body = await parseJsonBody<{
                filename?: string; mime?: string; size?: number; sha256?: string;
                path?: string; previewPath?: string; thumbPath?: string; textContent?: string;
              }>(req);
              const filename = String(body.filename ?? '');
              if (!isSafeFilename(filename)) { err(res, 400, 'Ungültiger Dateiname'); return; }
              const relPath = String(body.path ?? '');
              if (!relPath || relPath.includes('..')) { err(res, 400, 'Ungültiger Pfad'); return; }
              const pageId = await getPageIdBySlug(slug);
              if (!pageId) { err(res, 404, 'Seite nicht gefunden'); return; }

              const id = await upsertAttachment({
                pageId,
                filename,
                mime: String(body.mime ?? 'application/octet-stream'),
                size: Number(body.size ?? 0),
                sha256: body.sha256 ? String(body.sha256) : null,
                path: relPath,
                previewPath: body.previewPath ? String(body.previewPath) : null,
                thumbPath: body.thumbPath ? String(body.thumbPath) : null,
                textContent: body.textContent ? String(body.textContent) : null,
                sourceAuthor: actor,
                sourceModifiedAt: new Date(),
              });
              json(res, 201, { ok: true, id, filename });
              return;
            }

            // GET /api/wiki/pages/:slug/attachments/:filename — Metadaten
            if (segments.length === 4 && segments[2] === 'attachments' && method === 'GET') {
              const filename = segments[3];
              if (!isSafeFilename(filename)) { err(res, 400, 'Ungültiger Dateiname'); return; }
              const attachment = await getAttachment(slug, filename);
              if (!attachment) { err(res, 404, 'Anhang nicht gefunden'); return; }
              json(res, 200, attachment);
              return;
            }
          }

          err(res, 404, 'Not found');
        });
      } catch (e: any) {
        err(res, 500, e?.message ?? 'Interner Fehler');
      }

      return true;
    },
  });

  api.logger.info('[wiki] HTTP routes registered');
}
