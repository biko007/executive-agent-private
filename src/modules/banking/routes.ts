/**
 * banking/routes — HTTP API endpoints for Banking module.
 * Sprint 7b Etappe c: Follows fleet/routes.ts pattern exactly.
 * Auth: Bearer CORE_SERVICE_TOKEN. Actor from X-Actor header.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody } from '../../util/body-parser.js';
import { withContext, generateId } from '../../shared/correlation/index.js';
import * as audit from '../../shared/audit/index.js';
import { createApprovalPreview, validateApprovalToken } from '../../middleware/approval.js';
import { requiresApproval as checkRequiresApproval } from '../../middleware/approval-registry.js';
import { isSensitiveRoute, markSensitiveResponse, checkSensitiveRateLimit } from '../../middleware/sensitive-body.js';
import {
  listInstitutions, listAccounts, listTransactions,
  archiveAccount, deleteAccount,
  upsertInstitution, createSession,
} from './store.js';
import { initiateConnect, completeTan } from './tan-bridge.js';
import { dailySync, getSyncStatus } from './sync-engine.js';
import * as sidecar from './sidecar-client.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function err(res: ServerResponse, status: number, message: string, code?: string) {
  json(res, status, { ok: false, error: message, ...(code ? { code } : {}) });
}

/** Validate approval token with full signature. Returns true if valid. */
async function checkApproval(
  req: IncomingMessage, res: ServerResponse,
  endpointKey: string, sessionId: string, actor: string,
  method: string, body: unknown,
): Promise<boolean> {
  if (!checkRequiresApproval(endpointKey)) return true;
  const approvalToken = req.headers['x-approval-token'] as string;
  if (!approvalToken) {
    err(res, 403, 'Approval required', 'APPROVAL_REQUIRED');
    return false;
  }
  const result = await validateApprovalToken(approvalToken, sessionId, actor, method, endpointKey, body);
  if (!result.valid) {
    err(res, 403, result.error || 'Invalid approval token', result.code || 'INVALID_APPROVAL');
    return false;
  }
  return true;
}

// ── Route registration ───────────────────────────────────────────────────────

export function registerBankingHttpRoutes(api: any) {
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

    // Handle both /api/banking and /api/internal/banking
    const isBankingRoute = pathname.startsWith('/api/banking');
    const isInternalRoute = pathname.startsWith('/api/internal/banking');
    if (!isBankingRoute && !isInternalRoute) return false;

    if (!authCheck(req, res)) return true;
    const actor = (req.headers['x-actor'] as string) || 'system';
    const requestId = (req.headers['x-request-id'] as string) || generateId();
    const sessionId = (req.headers['x-dashboard-session-id'] as string) || '';

    try {
      // ── Public banking routes (/api/banking/*) ──────────────────────────
      if (isBankingRoute) {
        const rest = pathname.replace(/^\/api\/banking\/?/, '');
        const segments = rest.split('/').filter(Boolean);
        const resource = segments[0] || '';

        // GET /api/banking/institutions
        if (resource === 'institutions' && req.method === 'GET') {
          await withContext({ requestId, actor, source: 'dashboard' }, async () => {
            try {
              const institutions = await listInstitutions();
              json(res, 200, institutions);
            } catch (e: any) { err(res, 500, e.message); }
          });
          return true;
        }

        // GET /api/banking/accounts
        if (resource === 'accounts' && !segments[1] && req.method === 'GET') {
          await withContext({ requestId, actor, source: 'dashboard' }, async () => {
            try {
              const status = url.searchParams.get('status') || undefined;
              const institutionId = url.searchParams.get('institution_id');
              const accounts = await listAccounts({
                status: status || undefined,
                institution_id: institutionId ? parseInt(institutionId, 10) : undefined,
              });
              json(res, 200, accounts);
            } catch (e: any) { err(res, 500, e.message); }
          });
          return true;
        }

        // Routes on /api/banking/accounts/:id/*
        if (resource === 'accounts' && segments[1]) {
          const accountId = parseInt(segments[1], 10);
          const sub = segments[2];

          // GET /api/banking/accounts/:id/transactions
          if (sub === 'transactions' && req.method === 'GET') {
            await withContext({ requestId, actor, source: 'dashboard' }, async () => {
              try {
                const from = url.searchParams.get('from') || undefined;
                const to = url.searchParams.get('to') || undefined;
                const limit = url.searchParams.get('limit')
                  ? parseInt(url.searchParams.get('limit')!, 10)
                  : undefined;
                const txns = await listTransactions(accountId, from, to, limit);
                json(res, 200, txns);
              } catch (e: any) { err(res, 500, e.message); }
            });
            return true;
          }

          // POST /api/banking/accounts/:id/sync — Skeleton
          if (sub === 'sync' && req.method === 'POST') {
            await withContext({ requestId, actor, source: 'dashboard' }, async () => {
              json(res, 501, { ok: false, error: 'Not implemented — waiting for Etappe d' });
            });
            return true;
          }

          // POST /api/banking/accounts/:id/archive
          if (sub === 'archive' && req.method === 'POST') {
            await withContext({ requestId, actor, source: 'dashboard' }, async () => {
              try {
                const body = await parseJsonBody(req).catch(() => ({}));
                if (!(await checkApproval(req, res, 'banking-accounts.archive', sessionId, actor, 'POST', body))) return;
                const result = await archiveAccount(accountId, actor);
                if (!result) { err(res, 404, 'Account not found'); return; }
                json(res, 200, result);
              } catch (e: any) { err(res, 500, e.message); }
            });
            return true;
          }

          // DELETE /api/banking/accounts/:id
          if (!sub && req.method === 'DELETE') {
            await withContext({ requestId, actor, source: 'dashboard' }, async () => {
              try {
                const body = {};
                if (!(await checkApproval(req, res, 'banking-accounts.delete', sessionId, actor, 'DELETE', body))) return;
                const deleted = await deleteAccount(accountId, actor);
                if (!deleted) { err(res, 404, 'Account not found'); return; }
                json(res, 200, { ok: true });
              } catch (e: any) { err(res, 500, e.message); }
            });
            return true;
          }

          return false;
        }

        /**
         * POST /api/banking/connect — Sensitive + approval + rate-limit
         *
         * Two call modes (Etappe d.1):
         *   1. Telegram flow:   { session_id }
         *      → session already exists in DB, go straight to sidecar connect
         *   2. Dashboard flow:  { blz, user_id, pin, bank_name?, fints_url?, product_id?, tan_medium? }
         *      → upsert institution + create session inline, then sidecar connect
         *
         * Both modes funnel into initiateConnect(sessionId) from tan-bridge.ts.
         * PIN is never persisted beyond the encrypted session_state in Postgres.
         */
        if (resource === 'connect' && req.method === 'POST') {
          await withContext({ requestId, actor, source: 'dashboard' }, async () => {
            try {
              // Sensitive route handling
              markSensitiveResponse(res);
              if (!checkSensitiveRateLimit(actor, 'POST', '/api/banking/connect')) {
                err(res, 429, 'Rate limit exceeded for sensitive operation', 'RATE_LIMITED');
                return;
              }

              const body = await parseJsonBody(req);
              if (!(await checkApproval(req, res, 'banking-connect.initiate', sessionId, actor, 'POST', body))) return;

              // Accept either { session_id } or { blz, user_id, pin } (Dashboard form flow)
              let connectSessionId: number;
              if (body.session_id) {
                connectSessionId = Number(body.session_id);
              } else if (body.blz && body.user_id && body.pin) {
                // Dashboard credential flow: upsert institution + create session
                const inst = await upsertInstitution(
                  body.blz,
                  body.bank_name || `Bank ${body.blz}`,
                  null,
                  body.fints_url || '',
                  actor,
                );
                const session = await createSession(
                  inst.id,
                  body.user_id,
                  body.pin,
                  body.product_id || 'env-default',
                  body.tan_medium || undefined,
                  actor,
                );
                connectSessionId = session.id;
              } else {
                err(res, 400, 'session_id or (blz, user_id, pin) required');
                return;
              }

              const result = await initiateConnect(connectSessionId);
              json(res, 200, { ...result, session_id: connectSessionId });
            } catch (e: any) { err(res, 500, e.message); }
          });
          return true;
        }

        // POST /api/banking/complete-tan — Sensitive (conditional)
        if (resource === 'complete-tan' && req.method === 'POST') {
          await withContext({ requestId, actor, source: 'dashboard' }, async () => {
            try {
              markSensitiveResponse(res);

              const body = await parseJsonBody(req);
              if (!body.session_id || !body.tan) {
                err(res, 400, 'session_id and tan required');
                return;
              }

              const result = await completeTan(Number(body.session_id), String(body.tan));
              json(res, 200, result);
            } catch (e: any) { err(res, 500, e.message); }
          });
          return true;
        }

        // POST /api/banking/approval-preview
        if (resource === 'approval-preview' && req.method === 'POST') {
          await withContext({ requestId, actor, source: 'dashboard' }, async () => {
            try {
              const body = await parseJsonBody(req);
              if (!body.endpoint_key || !body.method || !body.body) {
                err(res, 400, 'endpoint_key, method, body required'); return;
              }
              const result = await createApprovalPreview({
                sessionId, actor, method: body.method,
                endpointKey: body.endpoint_key, body: body.body,
                entityVersions: body.entity_versions, diffSummary: body.diff_summary,
              });
              json(res, 200, result);
            } catch (e: any) { err(res, 500, e.message); }
          });
          return true;
        }

        return false;
      }

      // ── Internal banking routes (/api/internal/banking/*) ───────────────
      if (isInternalRoute) {
        const rest = pathname.replace(/^\/api\/internal\/banking\/?/, '');
        const segments = rest.split('/').filter(Boolean);
        const resource = segments[0] || '';

        // POST /api/internal/banking/daily-sync
        if (resource === 'daily-sync' && req.method === 'POST') {
          await withContext({ requestId, actor: 'system', source: 'n8n' }, async () => {
            try {
              const result = await dailySync();
              json(res, 200, result);
            } catch (e: any) { err(res, 500, e.message); }
          });
          return true;
        }

        // GET /api/internal/banking/sync-status
        if (resource === 'sync-status' && req.method === 'GET') {
          await withContext({ requestId, actor: 'system', source: 'internal' }, async () => {
            try {
              const status = await getSyncStatus();
              json(res, 200, status);
            } catch (e: any) { err(res, 500, e.message); }
          });
          return true;
        }

        return false;
      }

      return false;
    } catch (e: any) {
      err(res, 500, e.message);
      return true;
    }
  });

  api.logger.info('[banking] HTTP routes registered');
}
