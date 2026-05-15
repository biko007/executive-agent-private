/**
 * fleet/routes — HTTP API endpoints for Fleet module (Sprint 6c).
 * Pattern: follows assets/routes.ts exactly.
 * Auth: Bearer CORE_SERVICE_TOKEN.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody } from '../../util/body-parser.js';
import { withContext, generateId } from '../../shared/correlation/index.js';
import * as audit from '../../shared/audit/index.js';
import { query as dbQuery } from '../../shared/db/index.js';
import { createApprovalPreview, validateApprovalToken } from '../../middleware/approval.js';
import { requiresApproval as checkRequiresApproval } from '../../middleware/approval-registry.js';
import { checkIdempotency, completeIdempotency, failIdempotency } from '../../middleware/idempotency.js';
import {
  listVehicles, getVehicleByCode, createVehicle, updateVehicle,
  archiveVehicle, unarchiveVehicle, resolveVehicleCodeToId,
  addServiceRecord, updateServiceRecord, deleteServiceRecord,
  addInsurancePolicy, updateInsurancePolicy, deleteInsurancePolicy,
  addTaxRecord, updateTaxRecord, deleteTaxRecord,
  addTuevRecord, updateTuevRecord, deleteTuevRecord,
  addDocument, deleteDocument,
} from './store.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function err(res: ServerResponse, status: number, message: string, code?: string) {
  json(res, status, { ok: false, error: message, ...(code ? { code } : {}) });
}

const IDENTITY_FIELDS = new Set(['vehicle_code', 'license_plate', 'vin']);

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

export function registerFleetHttpRoutes(api: any) {
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

    if (!pathname.startsWith('/api/fleet')) return false;

    if (!authCheck(req, res)) return true;
    const actor = (req.headers['x-actor'] as string) || 'system';
    const requestId = (req.headers['x-request-id'] as string) || generateId();
    const sessionId = (req.headers['x-dashboard-session-id'] as string) || '';

    const rest = pathname.replace(/^\/api\/fleet\/?/, '');
    const segments = rest.split('/').filter(Boolean);
    const resource = segments[0];
    if (!resource) return false;

    try {
      // ── Vehicles ──────────────────────────────────────────────────────
      if (resource === 'vehicles') {
        const vehicleCode = segments[1];
        if (!vehicleCode) {
          // Collection: GET list, POST create
          await withContext({ requestId, actor, source: 'dashboard' }, async () => {
            try {
              if (req.method === 'GET') {
                const status = url.searchParams.get('status') || 'active';
                const vehicles = await listVehicles({ status });
                json(res, 200, vehicles);
              } else if (req.method === 'POST') {
                const body = await parseJsonBody(req);
                if (!body.vehicle_code || !body.display_name || !body.make || !body.model) {
                  err(res, 400, 'vehicle_code, display_name, make, model required'); return;
                }

                // Idempotency check
                const idem = await checkIdempotency(req, actor, 'fleet-vehicles.create', body);
                if (idem?.isReplay && idem.replayResponse) {
                  json(res, idem.replayResponse.status, idem.replayResponse.body); return;
                }

                // Approval check
                if (!(await checkApproval(req, res, 'fleet-vehicles.create', sessionId, actor, 'POST', body))) return;

                const vehicle = await createVehicle({
                  vehicleCode: body.vehicle_code,
                  displayName: body.display_name,
                  make: body.make,
                  model: body.model,
                  licensePlate: body.license_plate,
                  vin: body.vin,
                  firstRegistration: body.first_registration,
                  holder: body.holder,
                  currentMileageKm: body.current_mileage_km,
                  notes: body.notes,
                  sourcePayload: body.source_payload,
                }, actor);

                json(res, 201, vehicle);
                if (idem) { await completeIdempotency(actor, 'fleet-vehicles.create', idem.key, 201, vehicle); }
              } else {
                err(res, 405, 'Method not allowed');
              }
            } catch (e: any) { err(res, 500, e.message); }
          });
          return true;
        }

        // Sub-routes on a specific vehicle
        const sub = segments[2];

        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            // POST /vehicles/:code/archive
            if (sub === 'archive' && req.method === 'POST') {
              const body = await parseJsonBody(req).catch(() => ({}));
              if (!(await checkApproval(req, res, 'fleet-vehicles.archive', sessionId, actor, 'POST', body))) return;
              const result = await archiveVehicle(vehicleCode, body.reason, actor);
              if (!result) { err(res, 404, 'Vehicle not found'); return; }
              json(res, 200, result);
              return;
            }

            // POST /vehicles/:code/unarchive
            if (sub === 'unarchive' && req.method === 'POST') {
              if (!(await checkApproval(req, res, 'fleet-vehicles.unarchive', sessionId, actor, 'POST', {}))) return;
              const result = await unarchiveVehicle(vehicleCode, actor);
              if (!result) { err(res, 404, 'Vehicle not found'); return; }
              json(res, 200, result);
              return;
            }

            // POST /vehicles/:code/service-records
            if (sub === 'service-records' && req.method === 'POST') {
              const body = await parseJsonBody(req);
              if (!body.service_date || !body.service_type) {
                err(res, 400, 'service_date, service_type required'); return;
              }
              const result = await addServiceRecord(vehicleCode, body, actor);
              json(res, 201, result);
              return;
            }

            // POST /vehicles/:code/insurance-policies
            if (sub === 'insurance-policies' && req.method === 'POST') {
              const body = await parseJsonBody(req);
              if (!body.company || !body.coverage_type) {
                err(res, 400, 'company, coverage_type required'); return;
              }
              const result = await addInsurancePolicy(vehicleCode, body, actor);
              json(res, 201, result);
              return;
            }

            // POST /vehicles/:code/tax-records
            if (sub === 'tax-records' && req.method === 'POST') {
              const body = await parseJsonBody(req);
              if (!body.tax_year || body.amount == null) {
                err(res, 400, 'tax_year, amount required'); return;
              }
              const result = await addTaxRecord(vehicleCode, body, actor);
              json(res, 201, result);
              return;
            }

            // POST /vehicles/:code/tuev-records
            if (sub === 'tuev-records' && req.method === 'POST') {
              const body = await parseJsonBody(req);
              const result = await addTuevRecord(vehicleCode, body, actor);
              json(res, 201, result);
              return;
            }

            // POST /vehicles/:code/documents
            if (sub === 'documents' && req.method === 'POST') {
              const body = await parseJsonBody(req);
              if (!body.doc_type || !body.url) {
                err(res, 400, 'doc_type, url required'); return;
              }
              const result = await addDocument(vehicleCode, body, actor);
              json(res, 201, result);
              return;
            }

            // Direct vehicle operations (no sub-route)
            if (!sub) {
              if (req.method === 'GET') {
                const vehicle = await getVehicleByCode(vehicleCode);
                if (!vehicle) { err(res, 404, 'Vehicle not found'); return; }
                json(res, 200, vehicle);
              } else if (req.method === 'PATCH') {
                const body = await parseJsonBody(req);
                const isIdentityMutation = Object.keys(body).some(k => IDENTITY_FIELDS.has(k));

                if (isIdentityMutation) {
                  if (!(await checkApproval(req, res, 'fleet-vehicles.update-identity', sessionId, actor, 'PATCH', body))) return;
                }

                const result = await updateVehicle(vehicleCode, body, actor);
                if (!result) { err(res, 404, 'Vehicle not found'); return; }
                json(res, 200, result);
              } else {
                err(res, 405, 'Method not allowed');
              }
              return;
            }

            err(res, 404, `Unknown vehicle sub-route: ${sub}`);
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── Service Records (top-level by ID) ─────────────────────────────
      if (resource === 'service-records') {
        const recordId = segments[1];
        if (!recordId) { err(res, 400, 'Missing record ID'); return true; }

        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            if (req.method === 'PATCH') {
              const body = await parseJsonBody(req);
              await updateServiceRecord(parseInt(recordId, 10), body, actor);
              json(res, 200, { ok: true, id: parseInt(recordId, 10) });
            } else if (req.method === 'DELETE') {
              if (!(await checkApproval(req, res, 'fleet-service-records.delete', sessionId, actor, 'DELETE', {}))) return;
              await deleteServiceRecord(parseInt(recordId, 10), actor);
              json(res, 200, { ok: true });
            } else {
              err(res, 405, 'Method not allowed');
            }
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── Insurance Policies (top-level by ID) ──────────────────────────
      if (resource === 'insurance-policies') {
        const recordId = segments[1];
        if (!recordId) { err(res, 400, 'Missing record ID'); return true; }

        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            if (req.method === 'PATCH') {
              const body = await parseJsonBody(req);
              await updateInsurancePolicy(parseInt(recordId, 10), body, actor);
              json(res, 200, { ok: true, id: parseInt(recordId, 10) });
            } else if (req.method === 'DELETE') {
              if (!(await checkApproval(req, res, 'fleet-insurance-policies.delete', sessionId, actor, 'DELETE', {}))) return;
              await deleteInsurancePolicy(parseInt(recordId, 10), actor);
              json(res, 200, { ok: true });
            } else {
              err(res, 405, 'Method not allowed');
            }
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── Tax Records (top-level by ID) ─────────────────────────────────
      if (resource === 'tax-records') {
        const recordId = segments[1];
        if (!recordId) { err(res, 400, 'Missing record ID'); return true; }

        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            if (req.method === 'PATCH') {
              const body = await parseJsonBody(req);
              await updateTaxRecord(parseInt(recordId, 10), body, actor);
              json(res, 200, { ok: true, id: parseInt(recordId, 10) });
            } else if (req.method === 'DELETE') {
              if (!(await checkApproval(req, res, 'fleet-tax-records.delete', sessionId, actor, 'DELETE', {}))) return;
              await deleteTaxRecord(parseInt(recordId, 10), actor);
              json(res, 200, { ok: true });
            } else {
              err(res, 405, 'Method not allowed');
            }
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── TÜV Records (top-level by ID) ─────────────────────────────────
      if (resource === 'tuev-records') {
        const recordId = segments[1];
        if (!recordId) { err(res, 400, 'Missing record ID'); return true; }

        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            if (req.method === 'PATCH') {
              const body = await parseJsonBody(req);
              await updateTuevRecord(parseInt(recordId, 10), body, actor);
              json(res, 200, { ok: true, id: parseInt(recordId, 10) });
            } else if (req.method === 'DELETE') {
              if (!(await checkApproval(req, res, 'fleet-tuev-records.delete', sessionId, actor, 'DELETE', {}))) return;
              await deleteTuevRecord(parseInt(recordId, 10), actor);
              json(res, 200, { ok: true });
            } else {
              err(res, 405, 'Method not allowed');
            }
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── Documents (top-level by ID) ───────────────────────────────────
      if (resource === 'documents') {
        const recordId = segments[1];
        if (!recordId) { err(res, 400, 'Missing record ID'); return true; }

        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            if (req.method === 'DELETE') {
              if (!(await checkApproval(req, res, 'fleet-documents.delete', sessionId, actor, 'DELETE', {}))) return;
              await deleteDocument(parseInt(recordId, 10), actor);
              json(res, 200, { ok: true });
            } else {
              err(res, 405, 'Method not allowed');
            }
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── Audit Log ────────────────────────────────────────────────────
      if (resource === 'audit-log') {
        if (req.method !== 'GET') { err(res, 405, 'Method not allowed'); return true; }
        try {
          let sql = `SELECT * FROM audit_log WHERE module = 'fleet'`;
          const params: unknown[] = [];
          const entityType = url.searchParams.get('entity_type');
          const entityId = url.searchParams.get('entity_id');
          const since = url.searchParams.get('since');
          if (entityType) { sql += ` AND entity_type = $${params.length + 1}`; params.push(entityType); }
          if (entityId) { sql += ` AND entity_id = $${params.length + 1}`; params.push(entityId); }
          if (since) { sql += ` AND ts >= $${params.length + 1}`; params.push(since); }
          sql += ' ORDER BY ts DESC';
          const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
          const offset = parseInt(url.searchParams.get('offset') || '0', 10);
          sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
          params.push(limit, offset);
          const { rows } = await dbQuery(sql, params);
          json(res, 200, rows);
        } catch (e: any) { err(res, 500, e.message); }
        return true;
      }

      // ── Approval Preview ─────────────────────────────────────────────
      if (resource === 'approval-preview') {
        if (req.method !== 'POST') { err(res, 405, 'Method not allowed'); return true; }
        try {
          const body = await parseJsonBody(req);
          if (!body.endpoint_key || !body.method || !body.body) {
            err(res, 400, 'endpoint_key, method, body required'); return true;
          }
          const result = await createApprovalPreview({
            sessionId, actor, method: body.method,
            endpointKey: body.endpoint_key, body: body.body,
            entityVersions: body.entity_versions, diffSummary: body.diff_summary,
          });
          json(res, 200, result);
        } catch (e: any) { err(res, 500, e.message); }
        return true;
      }

      return false;
    } catch (e: any) {
      err(res, 500, e.message);
      return true;
    }
  });

  api.logger.info('[fleet] HTTP routes registered');
}
