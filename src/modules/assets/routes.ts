/**
 * assets/routes — HTTP API endpoints for Assets module (Sprint 5.5a-1).
 * All endpoints registered via api.registerHttpRoute().
 * Auth: Bearer CORE_SERVICE_TOKEN.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody } from '../../util/body-parser.js';
import { withContext, generateId } from '../../shared/correlation/index.js';
import * as audit from '../../shared/audit/index.js';
import { query as dbQuery, getClient } from '../../shared/db/index.js';
import { createApprovalPreview, validateApprovalToken } from '../../middleware/approval.js';
import { requiresApproval as checkRequiresApproval } from '../../middleware/approval-registry.js';
import { checkIdempotency, completeIdempotency, failIdempotency } from '../../middleware/idempotency.js';
import { nkPreCheck } from '../nk/precheck.js';
import {
  handleNkPreview, handleNkFinalize, handleNkStatementRead, handleNkStatementPdf,
  handleNkRerender, handleNkServe, handleNkRunList, handleNkRunDetail,
} from '../nk/routes.js';
import { handleObligationsAlert } from '../nk/alerts.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function err(res: ServerResponse, status: number, message: string, code?: string) {
  json(res, status, { ok: false, error: message, ...(code ? { code } : {}) });
}

function parseUrl(url: string): { path: string; query: Record<string, string> } {
  const qIdx = url.indexOf('?');
  const path = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const query: Record<string, string> = {};
  if (qIdx >= 0) {
    const qs = url.slice(qIdx + 1);
    for (const pair of qs.split('&')) {
      const [k, v] = pair.split('=');
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  return { path, query };
}

function dateStr(d: Date | string | null): string | null {
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}

function ts(d: Date | string | null): string | null {
  if (!d) return null;
  return new Date(d).toISOString();
}

function num(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// ── Route registration ───────────────────────────────────────────────────────

export function registerAssetsHttpRoutes(api: any) {
  const coreServiceToken = process.env.CORE_SERVICE_TOKEN || '';

  function authCheck(req: IncomingMessage, res: ServerResponse): boolean {
    const authHeader = req.headers?.authorization || '';
    if (!coreServiceToken || authHeader !== `Bearer ${coreServiceToken}`) {
      err(res, 401, 'Unauthorized');
      return false;
    }
    return true;
  }

  // ── Catch-all handler for /api/assets/ paths ──────────────────────────────
  // The gateway uses exact path matching for registerHttpRoute. For dynamic
  // segments (e.g., /api/assets/properties/:id) we use registerHttpHandler
  // which allows custom prefix-based dispatch.
  api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    // Only handle /api/assets paths
    if (!pathname.startsWith('/api/assets')) return false;

    if (!authCheck(req, res)) return true;
    const actor = (req.headers['x-actor'] as string) || 'system';
    const requestId = (req.headers['x-request-id'] as string) || generateId();
    const sessionId = (req.headers['x-dashboard-session-id'] as string) || '';

    // Strip /api/assets prefix and split into segments
    const rest = pathname.replace(/^\/api\/assets\/?/, '');
    const segments = rest.split('/').filter(Boolean);
    const resource = segments[0]; // e.g. 'properties', 'tenants', 'leases', etc.
    if (!resource) return false; // bare /api/assets — not handled

    try {
      // ── Properties list and /:id sub-routes ─────────────────────────────
      if (resource === 'properties') {
        const propertyId = segments[1];
        if (!propertyId) {
          // List all properties
          if (req.method !== 'GET') { err(res, 405, 'Method not allowed'); return true; }
          await withContext({ requestId, actor, source: 'dashboard' }, async () => {
            try {
              const { rows } = await dbQuery(
                `SELECT p.id, p.code, p.name, p.street, p.postal_code, p.city, p.property_type, p.owner,
                        p.ownership_start, p.ownership_end, p.billing_period_start_month,
                        p.heating_type, p.co2_cost_relevant, p.active, p.created_at, p.updated_at,
                        COUNT(u.id)::int AS unit_count
                 FROM properties p
                 LEFT JOIN units u ON u.property_id = p.id AND u.active = true
                 WHERE p.active = true
                 GROUP BY p.id
                 ORDER BY p.code`
              );
              json(res, 200, rows.map(mapPropertyRow));
            } catch (e: any) { err(res, 500, e.message); }
          });
          return true;
        }

        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            const sub = segments[2];
            if (sub === 'heating-config') { await handleHeatingConfig(req, res, propertyId); return; }
            if (sub === 'units') { await handlePropertyUnits(req, res, propertyId, segments[3]); return; }
            if (sub === 'leases') { await handlePropertyLeases(req, res, propertyId); return; }
            if (sub === 'expense-bookings') { await handleExpenseBookings(req, res, propertyId); return; }
            if (sub === 'allocation-rules') { await handleAllocationRules(req, res, propertyId, segments[3]); return; }
            if (sub === 'meters') { await handlePropertyMeters(req, res, propertyId); return; }
            if (sub === 'nk-readiness') {
              if (req.method !== 'GET') { err(res, 405, 'Method not allowed'); return; }
              const yearParam = url.searchParams.get('year');
              if (!yearParam) { err(res, 400, 'Missing required query parameter: year'); return; }
              const year = parseInt(yearParam, 10);
              if (isNaN(year) || year < 2000 || year > 2100) { err(res, 400, 'Invalid year parameter'); return; }
              const { rows: propLookup } = await dbQuery(
                'SELECT id FROM properties WHERE code = $1 AND active = true', [propertyId]
              );
              if (propLookup.length === 0) { err(res, 404, 'Property not found'); return; }
              const result = await nkPreCheck(propLookup[0].id, year);
              json(res, 200, result);
              return;
            }
            if (sub === 'nk-period-obligations') { await handleNkPeriodObligations(req, res, propertyId); return; }

            // Direct property operations (no sub-route)
            if (!sub) {
              if (req.method === 'GET') {
                const { rows } = await dbQuery(
                  `SELECT id, code, name, street, postal_code, city, property_type, owner,
                          ownership_start, ownership_end, billing_period_start_month,
                          heating_type, co2_cost_relevant, active, created_at, updated_at
                   FROM properties WHERE code = $1 AND active = true`, [propertyId]
                );
                if (rows.length === 0) { err(res, 404, 'Property not found'); return; }
                json(res, 200, mapPropertyRow(rows[0]));
              } else if (req.method === 'PATCH') {
                const body = await parseJsonBody(req);
                const { rows: before } = await dbQuery('SELECT * FROM properties WHERE code = $1 AND active = true', [propertyId]);
                if (before.length === 0) { err(res, 404, 'Property not found'); return; }

                const sets: string[] = [];
                const params: unknown[] = [];
                let pi = 1;
                if (body.name !== undefined) { sets.push(`name = $${pi++}`); params.push(body.name); }
                if (body.street !== undefined) { sets.push(`street = $${pi++}`); params.push(body.street); }
                if (body.postal_code !== undefined) { sets.push(`postal_code = $${pi++}`); params.push(body.postal_code); }
                if (body.city !== undefined) { sets.push(`city = $${pi++}`); params.push(body.city); }
                if (body.property_type !== undefined) { sets.push(`property_type = $${pi++}`); params.push(body.property_type); }
                if (body.owner !== undefined) { sets.push(`owner = $${pi++}`); params.push(body.owner); }
                if (body.ownership_end !== undefined) { sets.push(`ownership_end = $${pi++}`); params.push(body.ownership_end); }
                if (body.billing_period_start_month !== undefined) { sets.push(`billing_period_start_month = $${pi++}`); params.push(body.billing_period_start_month); }
                if (body.heating_type !== undefined) { sets.push(`heating_type = $${pi++}`); params.push(body.heating_type); }
                if (body.co2_cost_relevant !== undefined) { sets.push(`co2_cost_relevant = $${pi++}`); params.push(body.co2_cost_relevant); }
                if (body.notes !== undefined) { sets.push(`notes = $${pi++}`); params.push(body.notes); }
                if (sets.length === 0) { err(res, 400, 'No fields to update'); return; }

                params.push(before[0].id);
                const { rows: after } = await dbQuery(
                  `UPDATE properties SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`, params
                );
                await audit.log({
                  module: 'assets', action: 'property.update',
                  entityType: 'property', entityId: propertyId,
                  before: before[0], after: after[0],
                });
                json(res, 200, mapPropertyRow(after[0]));
              } else {
                err(res, 405, 'Method not allowed');
              }
              return;
            }

            err(res, 404, `Unknown property sub-route: ${sub}`);
          } catch (e: any) {
            err(res, 500, e.message);
          }
        });
        return true;
      }

      // ── Tenants /:id ────────────────────────────────────────────────────
      if (resource === 'tenants') {
        const tenantId = segments[1];
        if (!tenantId) {
          // List / Create (no ID)
          await withContext({ requestId, actor, source: 'dashboard' }, async () => {
            try {
              if (req.method === 'GET') {
                const { rows } = await dbQuery('SELECT * FROM tenants WHERE active = true ORDER BY last_name, company_name');
                json(res, 200, rows.map(mapTenantRow));
              } else if (req.method === 'POST') {
                const body = await parseJsonBody(req);
                if (!body.tenant_type) { err(res, 400, 'tenant_type required'); return; }
                const { rows } = await dbQuery(
                  `INSERT INTO tenants (tenant_type, first_name, last_name, company_name, contact_person,
                     email, phone, street, postal_code, city, iban, notes)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
                  [body.tenant_type, body.first_name, body.last_name, body.company_name,
                   body.contact_person, body.email, body.phone, body.street, body.postal_code,
                   body.city, body.iban, body.notes]
                );
                await audit.log({ module: 'assets', action: 'tenant.create', entityType: 'tenant', entityId: String(rows[0].id), after: rows[0] });
                json(res, 201, mapTenantRow(rows[0]));
              } else {
                err(res, 405, 'Method not allowed');
              }
            } catch (e: any) { err(res, 500, e.message); }
          });
          return true;
        }

        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            if (req.method === 'GET') {
              const { rows } = await dbQuery('SELECT * FROM tenants WHERE id = $1 AND active = true', [tenantId]);
              if (rows.length === 0) { err(res, 404, 'Tenant not found'); return; }
              json(res, 200, mapTenantRow(rows[0]));
            } else if (req.method === 'PATCH') {
              const body = await parseJsonBody(req);
              const { rows: before } = await dbQuery('SELECT * FROM tenants WHERE id = $1 AND active = true', [tenantId]);
              if (before.length === 0) { err(res, 404, 'Tenant not found'); return; }
              const sets: string[] = [];
              const params: unknown[] = [];
              let pi = 1;
              for (const field of ['first_name','last_name','company_name','contact_person','email','phone','street','postal_code','city','iban','notes']) {
                if (body[field] !== undefined) { sets.push(`${field} = $${pi++}`); params.push(body[field]); }
              }
              if (sets.length === 0) { err(res, 400, 'No fields to update'); return; }
              params.push(tenantId);
              const { rows: after } = await dbQuery(
                `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`, params
              );
              await audit.log({ module: 'assets', action: 'tenant.update', entityType: 'tenant', entityId: tenantId, before: before[0], after: after[0] });
              json(res, 200, mapTenantRow(after[0]));
            } else if (req.method === 'POST' && segments[2] === 'archive') {
              const { rows: before } = await dbQuery('SELECT * FROM tenants WHERE id = $1 AND active = true', [tenantId]);
              if (before.length === 0) { err(res, 404, 'Tenant not found'); return; }
              await dbQuery('UPDATE tenants SET active = false WHERE id = $1', [tenantId]);
              await audit.log({ module: 'assets', action: 'tenant.archive', entityType: 'tenant', entityId: tenantId, before: before[0] });
              json(res, 200, { ok: true });
            } else {
              err(res, 405, 'Method not allowed');
            }
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── Leases /:id and sub-routes ──────────────────────────────────────
      if (resource === 'leases') {
        const leaseId = segments[1];
        if (!leaseId) {
          // List / Create
          await withContext({ requestId, actor, source: 'dashboard' }, async () => {
            try {
              const { query } = parseUrl(req.url || '');
              if (req.method === 'GET') {
                let sql = `SELECT l.*, u.code AS unit_code, p.code AS property_code
                           FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id`;
                const params: unknown[] = [];
                const conditions: string[] = [];
                if (query.property_code) { conditions.push(`p.code = $${params.length + 1}`); params.push(query.property_code); }
                if (query.unit_code) { conditions.push(`u.code = $${params.length + 1}`); params.push(query.unit_code); }
                if (query.status) { conditions.push(`l.status = $${params.length + 1}`); params.push(query.status); }
                if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
                sql += ' ORDER BY l.start_date DESC';
                const { rows } = await dbQuery(sql, params);
                json(res, 200, rows.map(mapLeaseRow));
              } else if (req.method === 'POST') {
                const body = await parseJsonBody(req);
                if (!body.unit_id || !body.start_date) { err(res, 400, 'unit_id and start_date required'); return; }
                const { rows } = await dbQuery(
                  `INSERT INTO leases (unit_id, lease_number, lease_type, status, start_date, end_date,
                     kaltmiete, nk_vorauszahlung, heizkosten_vorauszahlung, kaution,
                     billing_mode, payment_method, rent_due_day, vat_option, vat_rate, notes)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
                  [body.unit_id, body.lease_number || null, body.lease_type || 'residential',
                   body.status || 'active', body.start_date, body.end_date || null,
                   body.kaltmiete, body.nk_vorauszahlung, body.heizkosten_vorauszahlung,
                   body.kaution, body.billing_mode || 'vorauszahlung',
                   body.payment_method || null, body.rent_due_day || null,
                   body.vat_option || false, body.vat_rate || null, body.notes || null]
                );
                if (body.tenant_ids && Array.isArray(body.tenant_ids)) {
                  for (let i = 0; i < body.tenant_ids.length; i++) {
                    await dbQuery(
                      `INSERT INTO lease_tenants (lease_id, tenant_id, role, is_primary_contact, valid_from)
                       VALUES ($1, $2, 'contract_party', $3, $4)`,
                      [rows[0].id, body.tenant_ids[i], i === 0, body.start_date]
                    );
                  }
                }
                await audit.log({ module: 'assets', action: 'lease.create', entityType: 'lease', entityId: String(rows[0].id), after: rows[0] });
                json(res, 201, mapLeaseRow(rows[0]));
              } else {
                err(res, 405, 'Method not allowed');
              }
            } catch (e: any) { err(res, 500, e.message); }
          });
          return true;
        }

        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            if (segments[2] === 'charges') { await handleLeaseCharges(req, res, leaseId); return; }
            if (segments[2] === 'end') { await handleLeaseEnd(req, res, leaseId); return; }
            if (segments[2] === 'revoke-end') { await handleLeaseRevokeEnd(req, res, leaseId); return; }
            if (segments[2] === 'move-out') { await handleLeaseMoveOut(req, res, leaseId); return; }

            if (req.method === 'GET') {
              const { rows } = await dbQuery(
                `SELECT l.*, u.code AS unit_code, p.code AS property_code
                 FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id
                 WHERE l.id = $1`, [leaseId]
              );
              if (rows.length === 0) { err(res, 404, 'Lease not found'); return; }
              json(res, 200, mapLeaseRow(rows[0]));
            } else if (req.method === 'PATCH') {
              const body = await parseJsonBody(req);
              const { rows: before } = await dbQuery('SELECT * FROM leases WHERE id = $1', [leaseId]);
              if (before.length === 0) { err(res, 404, 'Lease not found'); return; }
              const sets: string[] = [];
              const params: unknown[] = [];
              let pi = 1;
              for (const field of ['lease_number','lease_type','status','start_date','end_date',
                'kaltmiete','nk_vorauszahlung','heizkosten_vorauszahlung','kaution',
                'billing_mode','payment_method','rent_due_day','vat_option','vat_rate','notes',
                'termination_date','termination_reason','actual_move_out']) {
                if (body[field] !== undefined) { sets.push(`${field} = $${pi++}`); params.push(body[field]); }
              }
              if (sets.length === 0) { err(res, 400, 'No fields to update'); return; }
              params.push(leaseId);
              const { rows: after } = await dbQuery(
                `UPDATE leases SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`, params
              );
              await audit.log({ module: 'assets', action: 'lease.update', entityType: 'lease', entityId: leaseId, before: before[0], after: after[0] });
              json(res, 200, mapLeaseRow(after[0]));
            } else {
              err(res, 405, 'Method not allowed');
            }
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── Cost Categories ──────────────────────────────────────────────────
      if (resource === 'cost-categories') {
        if (req.method !== 'GET') { err(res, 405, 'Method not allowed'); return true; }
        try {
          const { rows } = await dbQuery('SELECT * FROM cost_categories WHERE active = true ORDER BY sort_order');
          json(res, 200, rows);
        } catch (e: any) { err(res, 500, e.message); }
        return true;
      }

      // ── Meters /:id and sub-routes ──────────────────────────────────────
      if (resource === 'meters') {
        const meterId = segments[1];
        if (!meterId) {
          // List / Create
          await withContext({ requestId, actor, source: 'dashboard' }, async () => {
            try {
              const { query } = parseUrl(req.url || '');
              if (req.method === 'GET') {
                let sql = 'SELECT * FROM meters WHERE active = true';
                const params: unknown[] = [];
                if (query.property_id) { sql += ` AND property_id = $${params.length + 1}`; params.push(query.property_id); }
                if (query.unit_id) { sql += ` AND unit_id = $${params.length + 1}`; params.push(query.unit_id); }
                sql += ' ORDER BY meter_number';
                const { rows } = await dbQuery(sql, params);
                json(res, 200, rows.map(mapMeterRow));
              } else if (req.method === 'POST') {
                const body = await parseJsonBody(req);
                if (!body.scope_type || !body.medium || !body.meter_number) {
                  err(res, 400, 'scope_type, medium, meter_number required'); return;
                }
                const { rows } = await dbQuery(
                  `INSERT INTO meters (scope_type, property_id, unit_id, medium, meter_number,
                     provider, installed_at, calibration_valid_until, is_main_meter,
                     parent_meter_id, submetering_purpose, notes)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
                  [body.scope_type, body.property_id || null, body.unit_id || null,
                   body.medium, body.meter_number, body.provider || null,
                   body.installed_at || null, body.calibration_valid_until || null,
                   body.is_main_meter || false, body.parent_meter_id || null,
                   body.submetering_purpose || null, body.notes || null]
                );
                await audit.log({ module: 'assets', action: 'meter.create', entityType: 'meter', entityId: String(rows[0].id), after: rows[0] });
                json(res, 201, mapMeterRow(rows[0]));
              } else {
                err(res, 405, 'Method not allowed');
              }
            } catch (e: any) { err(res, 500, e.message); }
          });
          return true;
        }

        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            if (segments[2] === 'readings') { await handleMeterReadings(req, res, meterId); return; }
            if (segments[2] === 'archive' && req.method === 'POST') {
              const { rows: before } = await dbQuery('SELECT * FROM meters WHERE id = $1 AND active = true', [meterId]);
              if (before.length === 0) { err(res, 404, 'Meter not found'); return; }
              await dbQuery('UPDATE meters SET active = false, removed_at = now() WHERE id = $1', [meterId]);
              await audit.log({ module: 'assets', action: 'meter.archive', entityType: 'meter', entityId: meterId, before: before[0] });
              json(res, 200, { ok: true });
              return;
            }
            if (req.method === 'GET') {
              const { rows } = await dbQuery('SELECT * FROM meters WHERE id = $1', [meterId]);
              if (rows.length === 0) { err(res, 404, 'Meter not found'); return; }
              json(res, 200, mapMeterRow(rows[0]));
            } else if (req.method === 'PATCH') {
              const body = await parseJsonBody(req);
              const { rows: before } = await dbQuery('SELECT * FROM meters WHERE id = $1 AND active = true', [meterId]);
              if (before.length === 0) { err(res, 404, 'Meter not found'); return; }
              const sets: string[] = [];
              const params: unknown[] = [];
              let pi = 1;
              for (const field of ['meter_number','provider','installed_at','removed_at',
                'calibration_valid_until','is_main_meter','parent_meter_id','submetering_purpose','notes']) {
                if (body[field] !== undefined) { sets.push(`${field} = $${pi++}`); params.push(body[field]); }
              }
              if (sets.length === 0) { err(res, 400, 'No fields to update'); return; }
              params.push(meterId);
              const { rows: after } = await dbQuery(
                `UPDATE meters SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`, params
              );
              await audit.log({ module: 'assets', action: 'meter.update', entityType: 'meter', entityId: meterId, before: before[0], after: after[0] });
              json(res, 200, mapMeterRow(after[0]));
            } else {
              err(res, 405, 'Method not allowed');
            }
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── Lease Changeovers (composite) ───────────────────────────────────
      if (resource === 'lease-changeovers') {
        if (req.method !== 'POST') { err(res, 405, 'Method not allowed'); return true; }
        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          let body: any;
          try { body = await parseJsonBody(req); } catch (e: any) { err(res, 400, e.message); return; }
          try {
            const idem = await checkIdempotency(req, actor, 'lease-changeovers.create', body);
            if (idem?.isReplay && idem.replayResponse) {
              json(res, idem.replayResponse.status, idem.replayResponse.body);
              return;
            }
            const result = await executeLeaseChangeover(body, actor, sessionId, requestId);
            json(res, 201, result);
            if (idem) { await completeIdempotency(actor, 'lease-changeovers.create', idem.key, 201, result); }
          } catch (e: any) {
            if (e.status) {
              json(res, e.status, { ok: false, error: e.message, code: e.code, details: e.details, path: e.path });
            } else { err(res, 500, e.message); }
            const idemKey = req.headers['idempotency-key'] as string;
            if (idemKey) { await failIdempotency(actor, 'lease-changeovers.create', idemKey).catch(() => {}); }
          }
        });
        return true;
      }

      // ── Approval Preview ────────────────────────────────────────────────
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

      // ── Audit Log ───────────────────────────────────────────────────────
      if (resource === 'audit-log') {
        if (req.method !== 'GET') { err(res, 405, 'Method not allowed'); return true; }
        const { query } = parseUrl(req.url || '');
        try {
          let sql = `SELECT * FROM audit_log WHERE module = 'assets'`;
          const params: unknown[] = [];
          if (query.entity_type) { sql += ` AND entity_type = $${params.length + 1}`; params.push(query.entity_type); }
          if (query.entity_id) { sql += ` AND entity_id = $${params.length + 1}`; params.push(query.entity_id); }
          if (query.since) { sql += ` AND ts >= $${params.length + 1}`; params.push(query.since); }
          sql += ' ORDER BY ts DESC';
          const limit = Math.min(parseInt(query.limit || '50', 10), 200);
          const offset = parseInt(query.offset || '0', 10);
          sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
          params.push(limit, offset);
          const { rows } = await dbQuery(sql, params);
          json(res, 200, rows);
        } catch (e: any) { err(res, 500, e.message); }
        return true;
      }

      // ── Allocation Rules /:id and sub-routes ────────────────────────────
      if (resource === 'allocation-rules') {
        const ruleId = segments[1];
        if (!ruleId) { err(res, 400, 'Missing rule ID'); return true; }
        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            if (segments[2] === 'shares') { await handleAllocationShares(req, res, ruleId, segments[3]); return; }
            if (req.method === 'PATCH') {
              const body = await parseJsonBody(req);
              const { rows: before } = await dbQuery('SELECT * FROM allocation_rules WHERE id = $1', [ruleId]);
              if (before.length === 0) { err(res, 404, 'Rule not found'); return; }
              const sets: string[] = [];
              const params: unknown[] = [];
              let pi = 1;
              for (const field of ['key_type','base_share_percent','consumption_share_percent','valid_from','valid_until','source','notes']) {
                if (body[field] !== undefined) { sets.push(`${field} = $${pi++}`); params.push(body[field]); }
              }
              if (sets.length === 0) { err(res, 400, 'No fields to update'); return; }
              params.push(ruleId);
              const { rows: after } = await dbQuery(
                `UPDATE allocation_rules SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`, params
              );
              await audit.log({ module: 'assets', action: 'allocation_rule.update', entityType: 'allocation_rule', entityId: ruleId, before: before[0], after: after[0] });
              json(res, 200, after[0]);
            } else if (req.method === 'POST' && segments[2] === 'archive') {
              const { rows: before } = await dbQuery('SELECT * FROM allocation_rules WHERE id = $1', [ruleId]);
              if (before.length === 0) { err(res, 404, 'Rule not found'); return; }
              await dbQuery('UPDATE allocation_rules SET archived_at = now() WHERE id = $1', [ruleId]);
              await audit.log({ module: 'assets', action: 'allocation_rule.archive', entityType: 'allocation_rule', entityId: ruleId, before: before[0] });
              json(res, 200, { ok: true });
            } else {
              err(res, 405, 'Method not allowed');
            }
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── NK Period Obligations /:id (top-level PATCH) ────────────────────
      if (resource === 'nk-period-obligations') {
        const oblId = segments[1];
        if (!oblId) { err(res, 400, 'Missing obligation ID'); return true; }
        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            if (req.method === 'PATCH') {
              const body = await parseJsonBody(req);
              const { rows: before } = await dbQuery('SELECT * FROM nk_period_obligations WHERE id = $1', [oblId]);
              if (before.length === 0) { err(res, 404, 'Obligation not found'); return; }
              const currentStatus = before[0].status;
              if (currentStatus === 'served') { err(res, 409, 'Cannot modify served obligation', 'STATUS_LOCKED'); return; }
              const validTransitions: Record<string, string[]> = {
                pending: ['data_collection'],
                data_collection: ['calculation_ready', 'pending'],
                calculation_ready: ['review', 'data_collection'],
                review: ['approved', 'data_collection'],
                approved: ['sent', 'review'],
                sent: ['objection', 'served'],
                objection: ['review', 'sent'],
              };
              if (body.status && !validTransitions[currentStatus]?.includes(body.status)) {
                err(res, 409, `Invalid transition: ${currentStatus} → ${body.status}`, 'INVALID_TRANSITION'); return;
              }
              const sets: string[] = [];
              const params: unknown[] = [];
              let pi = 1;
              if (body.status !== undefined) {
                sets.push(`status = $${pi++}`); params.push(body.status);
                if (body.status === 'served') { sets.push(`served_at = now()`); }
              }
              if (body.result_amount !== undefined) { sets.push(`result_amount = $${pi++}`); params.push(body.result_amount); }
              if (body.due_date !== undefined) { sets.push(`due_date = $${pi++}`); params.push(body.due_date); }
              if (body.notes !== undefined) { sets.push(`notes = $${pi++}`); params.push(body.notes); }
              if (sets.length === 0) { err(res, 400, 'No fields to update'); return; }
              params.push(oblId);
              const { rows: after } = await dbQuery(
                `UPDATE nk_period_obligations SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`, params
              );
              await audit.log({ module: 'assets', action: 'nk_obligation.update', entityType: 'nk_period_obligation', entityId: oblId, before: before[0], after: after[0] });
              json(res, 200, after[0]);
            } else {
              err(res, 405, 'Method not allowed');
            }
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── NK Statements ──────────────────────────────────────────────
      if (resource === 'nk-statements') {
        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            if (!segments[1]) {
              // POST /api/assets/nk-statements/preview or /finalize
              err(res, 404, 'Missing sub-route: use /preview or /finalize');
              return;
            }
            if (segments[1] === 'preview') {
              await handleNkPreview(req, res, actor, requestId);
              return;
            }
            if (segments[1] === 'finalize') {
              await handleNkFinalize(req, res, actor, requestId, sessionId);
              return;
            }
            // /api/assets/nk-statements/:id[/pdf|/rerender|/serve]
            const statementId = segments[1];
            const sub = segments[2];
            if (sub === 'pdf') { await handleNkStatementPdf(req, res, statementId); return; }
            if (sub === 'rerender') { await handleNkRerender(req, res, statementId, actor); return; }
            if (sub === 'serve') { await handleNkServe(req, res, statementId, actor, sessionId); return; }
            if (!sub) { await handleNkStatementRead(req, res, statementId); return; }
            err(res, 404, `Unknown nk-statements sub-route: ${sub}`);
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── NK Statement Runs ─────────────────────────────────────────────
      if (resource === 'nk-statement-runs') {
        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            const runId = segments[1];
            if (!runId) {
              const { query } = parseUrl(req.url || '');
              await handleNkRunList(req, res, query);
            } else {
              await handleNkRunDetail(req, res, runId);
            }
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── NK Trigger (n8n cron → localhost-only) ─────────────────────
      if (resource === 'nk-trigger') {
        if (segments[1] === 'obligations-alert' && req.method === 'POST') {
          try {
            const result = await handleObligationsAlert();
            json(res, 200, { ok: true, ...result });
          } catch (e: any) { err(res, 500, e.message); }
          return true;
        }
        err(res, 404, 'Unknown nk-trigger sub-route');
        return true;
      }

      // Not a recognized /api/assets/ sub-path
      return false;
    } catch (e: any) {
      err(res, 500, e.message);
      return true;
    }
  });

  api.logger.info('[assets] HTTP routes registered');
}

// ── Sub-route handlers ──────────────────────────────────────────────────────

async function handleHeatingConfig(req: IncomingMessage, res: ServerResponse, propertyCode: string) {
  const { rows: propRows } = await dbQuery('SELECT id FROM properties WHERE code = $1 AND active = true', [propertyCode]);
  if (propRows.length === 0) { err(res, 404, 'Property not found'); return; }
  const propId = propRows[0].id;

  if (req.method === 'GET') {
    const { query } = parseUrl(req.url || '');
    const year = query.year ? parseInt(query.year, 10) : new Date().getFullYear();
    const { rows } = await dbQuery('SELECT * FROM property_heating_config WHERE property_id = $1 AND year = $2', [propId, year]);
    json(res, 200, rows.length > 0 ? rows[0] : null);
  } else if (req.method === 'PUT') {
    const body = await parseJsonBody(req);
    if (!body.year || !body.heating_system) { err(res, 400, 'year and heating_system required'); return; }

    const { rows } = await dbQuery(
      `INSERT INTO property_heating_config (property_id, year, heating_system, hot_water_via_heating,
         base_share_percent, consumption_share_percent, co2_emissions_kg, co2_cost_total,
         co2_tenant_share_percent, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (property_id, year) DO UPDATE SET
         heating_system = EXCLUDED.heating_system,
         hot_water_via_heating = EXCLUDED.hot_water_via_heating,
         base_share_percent = EXCLUDED.base_share_percent,
         consumption_share_percent = EXCLUDED.consumption_share_percent,
         co2_emissions_kg = EXCLUDED.co2_emissions_kg,
         co2_cost_total = EXCLUDED.co2_cost_total,
         co2_tenant_share_percent = EXCLUDED.co2_tenant_share_percent,
         notes = EXCLUDED.notes
       RETURNING *`,
      [propId, body.year, body.heating_system, body.hot_water_via_heating ?? true,
       body.base_share_percent ?? null, body.consumption_share_percent ?? null,
       body.co2_emissions_kg ?? null, body.co2_cost_total ?? null,
       body.co2_tenant_share_percent ?? null, body.notes ?? null]
    );
    await audit.log({ module: 'assets', action: 'heating_config.upsert', entityType: 'property_heating_config', entityId: `${propertyCode}/${body.year}`, after: rows[0] });
    json(res, 200, rows[0]);
  } else {
    err(res, 405, 'Method not allowed');
  }
}

async function handlePropertyUnits(req: IncomingMessage, res: ServerResponse, propertyCode: string, unitSegment?: string) {
  const { rows: propRows } = await dbQuery('SELECT id FROM properties WHERE code = $1 AND active = true', [propertyCode]);
  if (propRows.length === 0) { err(res, 404, 'Property not found'); return; }
  const propId = propRows[0].id;

  if (unitSegment) {
    const unitId = unitSegment;
    const { path: urlPath } = parseUrl(req.url || '');
    const segments = urlPath.replace(`/api/assets/properties/${propertyCode}/units/${unitId}`, '').split('/').filter(Boolean);

    if (segments[0] === 'residents') {
      await handleUnitResidents(req, res, propId, unitId);
      return;
    }

    // Single unit operations
    if (req.method === 'PATCH') {
      const body = await parseJsonBody(req);
      const { rows: before } = await dbQuery('SELECT * FROM units WHERE property_id = $1 AND code = $2 AND active = true', [propId, unitId]);
      if (before.length === 0) { err(res, 404, 'Unit not found'); return; }

      const sets: string[] = [];
      const params: unknown[] = [];
      let pi = 1;
      for (const field of ['code','unit_type','floor','living_area_qm','usable_area_qm','allocation_area_qm','rooms','has_balcony','has_heating','notes']) {
        if (body[field] !== undefined) { sets.push(`${field} = $${pi++}`); params.push(body[field]); }
      }
      if (sets.length === 0) { err(res, 400, 'No fields to update'); return; }

      params.push(before[0].id);
      const { rows: after } = await dbQuery(
        `UPDATE units SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`, params
      );
      await audit.log({ module: 'assets', action: 'unit.update', entityType: 'unit', entityId: unitId, before: before[0], after: after[0] });
      json(res, 200, after[0]);
    } else if (req.method === 'POST' && segments[0] === 'archive') {
      const { rows: before } = await dbQuery('SELECT * FROM units WHERE property_id = $1 AND code = $2 AND active = true', [propId, unitId]);
      if (before.length === 0) { err(res, 404, 'Unit not found'); return; }
      await dbQuery('UPDATE units SET active = false, archived_at = now() WHERE id = $1', [before[0].id]);
      await audit.log({ module: 'assets', action: 'unit.archive', entityType: 'unit', entityId: unitId, before: before[0] });
      json(res, 200, { ok: true });
    } else if (req.method === 'GET') {
      const { rows } = await dbQuery('SELECT * FROM units WHERE property_id = $1 AND code = $2', [propId, unitId]);
      if (rows.length === 0) { err(res, 404, 'Unit not found'); return; }
      json(res, 200, rows[0]);
    } else {
      err(res, 405, 'Method not allowed');
    }
    return;
  }

  // Collection
  if (req.method === 'GET') {
    const { rows } = await dbQuery('SELECT * FROM units WHERE property_id = $1 AND active = true ORDER BY code', [propId]);
    json(res, 200, rows);
  } else if (req.method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body.code) { err(res, 400, 'code required'); return; }
    const { rows } = await dbQuery(
      `INSERT INTO units (property_id, code, unit_type, floor, living_area_qm, usable_area_qm,
         allocation_area_qm, rooms, has_balcony, has_heating, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [propId, body.code, body.unit_type || 'apartment', body.floor || null,
       body.living_area_qm || null, body.usable_area_qm || null,
       body.allocation_area_qm || null, body.rooms || null,
       body.has_balcony || false, body.has_heating ?? true, body.notes || null]
    );
    await audit.log({ module: 'assets', action: 'unit.create', entityType: 'unit', entityId: body.code, after: rows[0] });
    json(res, 201, rows[0]);
  } else {
    err(res, 405, 'Method not allowed');
  }
}

async function handleUnitResidents(req: IncomingMessage, res: ServerResponse, propId: number, unitCode: string) {
  const { rows: unitRows } = await dbQuery('SELECT id FROM units WHERE property_id = $1 AND code = $2', [propId, unitCode]);
  if (unitRows.length === 0) { err(res, 404, 'Unit not found'); return; }
  const unitDbId = unitRows[0].id;

  if (req.method === 'GET') {
    const { rows } = await dbQuery(
      'SELECT * FROM unit_residents WHERE unit_id = $1 ORDER BY move_in DESC', [unitDbId]
    );
    json(res, 200, rows);
  } else if (req.method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body.tenant_id || !body.move_in) { err(res, 400, 'tenant_id and move_in required'); return; }
    const { rows } = await dbQuery(
      `INSERT INTO unit_residents (unit_id, tenant_id, move_in, move_out, persons_count, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [unitDbId, body.tenant_id, body.move_in, body.move_out || null, body.persons_count || 1, body.notes || null]
    );
    await audit.log({ module: 'assets', action: 'unit_resident.create', entityType: 'unit_resident', entityId: String(rows[0].id), after: rows[0] });
    json(res, 201, rows[0]);
  } else if (req.method === 'PATCH') {
    const body = await parseJsonBody(req);
    if (!body.id) { err(res, 400, 'id required'); return; }
    const { rows: before } = await dbQuery('SELECT * FROM unit_residents WHERE id = $1', [body.id]);
    if (before.length === 0) { err(res, 404, 'Resident entry not found'); return; }

    const sets: string[] = [];
    const params: unknown[] = [];
    let pi = 1;
    for (const field of ['move_out','persons_count','notes']) {
      if (body[field] !== undefined) { sets.push(`${field} = $${pi++}`); params.push(body[field]); }
    }
    if (sets.length === 0) { err(res, 400, 'No fields to update'); return; }

    params.push(body.id);
    const { rows: after } = await dbQuery(
      `UPDATE unit_residents SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`, params
    );
    await audit.log({ module: 'assets', action: 'unit_resident.update', entityType: 'unit_resident', entityId: String(body.id), before: before[0], after: after[0] });
    json(res, 200, after[0]);
  } else {
    err(res, 405, 'Method not allowed');
  }
}

async function handlePropertyLeases(req: IncomingMessage, res: ServerResponse, propertyCode: string) {
  const { rows: propRows } = await dbQuery('SELECT id FROM properties WHERE code = $1 AND active = true', [propertyCode]);
  if (propRows.length === 0) { err(res, 404, 'Property not found'); return; }
  const propId = propRows[0].id;

  if (req.method === 'GET') {
    const { rows } = await dbQuery(
      `SELECT l.*, u.code AS unit_code, p.code AS property_code
       FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id
       WHERE u.property_id = $1 ORDER BY l.start_date DESC`, [propId]
    );
    json(res, 200, rows.map(mapLeaseRow));
  } else {
    err(res, 405, 'Method not allowed');
  }
}

async function handleLeaseEnd(req: IncomingMessage, res: ServerResponse, leaseId: string) {
  if (req.method !== 'POST') { err(res, 405, 'Method not allowed'); return; }
  const body = await parseJsonBody(req);
  const { rows: before } = await dbQuery('SELECT * FROM leases WHERE id = $1', [leaseId]);
  if (before.length === 0) { err(res, 404, 'Lease not found'); return; }
  if (!['active','terminated'].includes(before[0].status)) {
    err(res, 409, `Cannot end lease in status ${before[0].status}`); return;
  }

  const { rows: after } = await dbQuery(
    `UPDATE leases SET status = 'ended', end_date = COALESCE($1, end_date, CURRENT_DATE),
       termination_date = COALESCE(termination_date, $2),
       termination_reason = COALESCE($3, termination_reason)
     WHERE id = $4 RETURNING *`,
    [body.end_date || null, body.termination_date || null, body.termination_reason || null, leaseId]
  );
  await audit.log({ module: 'assets', action: 'lease.end', entityType: 'lease', entityId: leaseId, before: before[0], after: after[0] });
  json(res, 200, mapLeaseRow(after[0]));
}

async function handleLeaseRevokeEnd(req: IncomingMessage, res: ServerResponse, leaseId: string) {
  if (req.method !== 'POST') { err(res, 405, 'Method not allowed'); return; }
  const { rows: before } = await dbQuery('SELECT * FROM leases WHERE id = $1', [leaseId]);
  if (before.length === 0) { err(res, 404, 'Lease not found'); return; }
  if (before[0].status !== 'terminated') {
    err(res, 409, `Can only revoke-end on terminated leases (current: ${before[0].status})`); return;
  }
  const { rows: after } = await dbQuery(
    `UPDATE leases SET status = 'active', termination_date = NULL, termination_reason = NULL WHERE id = $1 RETURNING *`,
    [leaseId]
  );
  await audit.log({ module: 'assets', action: 'lease.revoke_end', entityType: 'lease', entityId: leaseId, before: before[0], after: after[0] });
  json(res, 200, mapLeaseRow(after[0]));
}

async function handleLeaseMoveOut(req: IncomingMessage, res: ServerResponse, leaseId: string) {
  if (req.method !== 'POST') { err(res, 405, 'Method not allowed'); return; }
  const body = await parseJsonBody(req);
  if (!body.actual_move_out) { err(res, 400, 'actual_move_out required'); return; }

  const { rows: before } = await dbQuery('SELECT * FROM leases WHERE id = $1', [leaseId]);
  if (before.length === 0) { err(res, 404, 'Lease not found'); return; }

  const { rows: after } = await dbQuery(
    `UPDATE leases SET actual_move_out = $1, status = CASE WHEN status = 'active' THEN 'ended' ELSE status END
     WHERE id = $2 RETURNING *`,
    [body.actual_move_out, leaseId]
  );
  await audit.log({ module: 'assets', action: 'lease.move_out', entityType: 'lease', entityId: leaseId, before: before[0], after: after[0] });
  json(res, 200, mapLeaseRow(after[0]));
}

async function handleLeaseCharges(req: IncomingMessage, res: ServerResponse, leaseId: string) {
  if (req.method === 'GET') {
    const { rows } = await dbQuery(
      'SELECT * FROM lease_charges WHERE lease_id = $1 AND archived_at IS NULL ORDER BY valid_from DESC', [leaseId]
    );
    json(res, 200, rows);
  } else if (req.method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body.charge_type || body.amount == null || !body.valid_from) {
      err(res, 400, 'charge_type, amount, valid_from required'); return;
    }
    const { rows } = await dbQuery(
      `INSERT INTO lease_charges (lease_id, charge_type, amount, vat_rate, valid_from, valid_until, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [leaseId, body.charge_type, body.amount, body.vat_rate || null,
       body.valid_from, body.valid_until || null, body.notes || null]
    );
    await audit.log({ module: 'assets', action: 'lease_charge.create', entityType: 'lease_charge', entityId: String(rows[0].id), after: rows[0] });
    json(res, 201, rows[0]);
  } else {
    err(res, 405, 'Method not allowed');
  }
}

async function handleExpenseBookings(req: IncomingMessage, res: ServerResponse, propertyCode: string) {
  const { rows: propRows } = await dbQuery('SELECT id FROM properties WHERE code = $1 AND active = true', [propertyCode]);
  if (propRows.length === 0) { err(res, 404, 'Property not found'); return; }
  const propId = propRows[0].id;
  const { query } = parseUrl(req.url || '');

  if (req.method === 'GET') {
    let sql = `SELECT eb.*, cc.code AS cost_category_code, cc.name AS cost_category_name
               FROM expense_bookings eb JOIN cost_categories cc ON eb.cost_category_id = cc.id
               WHERE eb.property_id = $1 AND eb.archived_at IS NULL`;
    const params: unknown[] = [propId];

    if (query.year) {
      // Overlapping service_year filter: any booking whose service period overlaps with the given year
      sql += ` AND eb.service_period_start <= $${params.length + 1} AND eb.service_period_end >= $${params.length + 2}`;
      params.push(`${query.year}-12-31`, `${query.year}-01-01`);
    }
    sql += ' ORDER BY eb.service_period_start, cc.sort_order';
    const { rows } = await dbQuery(sql, params);
    json(res, 200, rows);
  } else if (req.method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body.cost_category_id || body.amount_gross == null) {
      err(res, 400, 'cost_category_id and amount_gross required'); return;
    }
    const { rows } = await dbQuery(
      `INSERT INTO expense_bookings (source_key, property_id, unit_id, cost_category_id,
         vendor_name, invoice_number, invoice_date, service_period_start, service_period_end,
         payment_date, amount_gross, amount_net, vat_amount, vat_rate, umlagefaehig, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [body.source_key || null, propId, body.unit_id || null, body.cost_category_id,
       body.vendor_name || null, body.invoice_number || null, body.invoice_date || null,
       body.service_period_start || null, body.service_period_end || null,
       body.payment_date || null, body.amount_gross, body.amount_net || null,
       body.vat_amount || null, body.vat_rate || null,
       body.umlagefaehig ?? true, body.notes || null]
    );
    await audit.log({ module: 'assets', action: 'expense_booking.create', entityType: 'expense_booking', entityId: String(rows[0].id), after: rows[0] });
    json(res, 201, rows[0]);
  } else {
    err(res, 405, 'Method not allowed');
  }
}

async function handleAllocationRules(req: IncomingMessage, res: ServerResponse, propertyCode: string, ruleId?: string) {
  const { rows: propRows } = await dbQuery('SELECT id FROM properties WHERE code = $1 AND active = true', [propertyCode]);
  if (propRows.length === 0) { err(res, 404, 'Property not found'); return; }
  const propId = propRows[0].id;

  if (req.method === 'GET') {
    const { rows } = await dbQuery(
      `SELECT ar.*, cc.code AS cost_category_code, cc.name AS cost_category_name
       FROM allocation_rules ar JOIN cost_categories cc ON ar.cost_category_id = cc.id
       WHERE ar.property_id = $1 AND ar.archived_at IS NULL ORDER BY cc.sort_order, ar.valid_from`,
      [propId]
    );
    json(res, 200, rows);
  } else if (req.method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body.cost_category_id || !body.key_type || !body.valid_from) {
      err(res, 400, 'cost_category_id, key_type, valid_from required'); return;
    }
    const { rows } = await dbQuery(
      `INSERT INTO allocation_rules (property_id, cost_category_id, key_type,
         base_share_percent, consumption_share_percent, valid_from, valid_until, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [propId, body.cost_category_id, body.key_type,
       body.base_share_percent || null, body.consumption_share_percent || null,
       body.valid_from, body.valid_until || null, body.source || null, body.notes || null]
    );
    await audit.log({ module: 'assets', action: 'allocation_rule.create', entityType: 'allocation_rule', entityId: String(rows[0].id), after: rows[0] });
    json(res, 201, rows[0]);
  } else {
    err(res, 405, 'Method not allowed');
  }
}

async function handleAllocationShares(req: IncomingMessage, res: ServerResponse, ruleId: string, shareId?: string) {
  if (req.method === 'GET') {
    const { rows } = await dbQuery(
      'SELECT * FROM allocation_rule_shares WHERE allocation_rule_id = $1 AND archived_at IS NULL ORDER BY unit_id',
      [ruleId]
    );
    json(res, 200, rows);
  } else if (req.method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body.unit_id || body.share_value == null || !body.valid_from) {
      err(res, 400, 'unit_id, share_value, valid_from required'); return;
    }
    const { rows } = await dbQuery(
      `INSERT INTO allocation_rule_shares (allocation_rule_id, unit_id, share_value, valid_from, valid_until, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ruleId, body.unit_id, body.share_value, body.valid_from, body.valid_until || null, body.notes || null]
    );
    await audit.log({ module: 'assets', action: 'allocation_share.create', entityType: 'allocation_rule_share', entityId: String(rows[0].id), after: rows[0] });
    json(res, 201, rows[0]);
  } else if (req.method === 'PATCH' && shareId) {
    const body = await parseJsonBody(req);
    const { rows: before } = await dbQuery('SELECT * FROM allocation_rule_shares WHERE id = $1', [shareId]);
    if (before.length === 0) { err(res, 404, 'Share not found'); return; }

    const sets: string[] = [];
    const params: unknown[] = [];
    let pi = 1;
    for (const field of ['share_value','valid_from','valid_until','notes']) {
      if (body[field] !== undefined) { sets.push(`${field} = $${pi++}`); params.push(body[field]); }
    }
    if (sets.length === 0) { err(res, 400, 'No fields to update'); return; }

    params.push(shareId);
    const { rows: after } = await dbQuery(
      `UPDATE allocation_rule_shares SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`, params
    );
    await audit.log({ module: 'assets', action: 'allocation_share.update', entityType: 'allocation_rule_share', entityId: shareId, before: before[0], after: after[0] });
    json(res, 200, after[0]);
  } else {
    err(res, 405, 'Method not allowed');
  }
}

async function handlePropertyMeters(req: IncomingMessage, res: ServerResponse, propertyCode: string) {
  const { rows: propRows } = await dbQuery('SELECT id FROM properties WHERE code = $1 AND active = true', [propertyCode]);
  if (propRows.length === 0) { err(res, 404, 'Property not found'); return; }
  const propId = propRows[0].id;

  if (req.method === 'GET') {
    const { rows } = await dbQuery(
      `SELECT * FROM meters WHERE active = true AND (property_id = $1 OR unit_id IN (SELECT id FROM units WHERE property_id = $1))
       ORDER BY meter_number`, [propId]
    );
    json(res, 200, rows.map(mapMeterRow));
  } else {
    err(res, 405, 'Method not allowed');
  }
}

async function handleMeterReadings(req: IncomingMessage, res: ServerResponse, meterId: string) {
  if (req.method === 'GET') {
    const { rows } = await dbQuery(
      'SELECT * FROM meter_readings WHERE meter_id = $1 ORDER BY read_at DESC', [meterId]
    );
    json(res, 200, rows);
  } else if (req.method === 'POST') {
    const { path: urlPath } = parseUrl(req.url || '');
    const isBulk = urlPath.endsWith('/bulk');

    if (isBulk) {
      const body = await parseJsonBody(req);
      if (!Array.isArray(body.readings)) { err(res, 400, 'readings array required'); return; }

      const results: any[] = [];
      const errors: any[] = [];

      for (let i = 0; i < body.readings.length; i++) {
        const r = body.readings[i];
        try {
          const { rows } = await dbQuery(
            `INSERT INTO meter_readings (meter_id, value, unit, reading_type, period_start, period_end,
               read_at, source, reader_name, is_estimated, estimate_method, estimate_reason, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
            [meterId, r.value, r.unit, r.reading_type || 'annual',
             r.period_start || null, r.period_end || null,
             r.read_at || new Date().toISOString(), r.source || 'manual',
             r.reader_name || null, r.is_estimated || false,
             r.estimate_method || null, r.estimate_reason || null, r.notes || null]
          );
          results.push(rows[0]);
        } catch (e: any) {
          errors.push({ index: i, error: e.message });
        }
      }

      if (errors.length > 0) {
        json(res, 207, { ok: false, created: results.length, errors });
      } else {
        json(res, 201, { ok: true, created: results.length, readings: results });
      }
    } else {
      const body = await parseJsonBody(req);
      if (body.value == null || !body.unit) { err(res, 400, 'value and unit required'); return; }

      const { rows } = await dbQuery(
        `INSERT INTO meter_readings (meter_id, value, unit, reading_type, period_start, period_end,
           read_at, source, reader_name, is_estimated, estimate_method, estimate_reason, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [meterId, body.value, body.unit, body.reading_type || 'annual',
         body.period_start || null, body.period_end || null,
         body.read_at || new Date().toISOString(), body.source || 'manual',
         body.reader_name || null, body.is_estimated || false,
         body.estimate_method || null, body.estimate_reason || null, body.notes || null]
      );
      await audit.log({ module: 'assets', action: 'meter_reading.create', entityType: 'meter_reading', entityId: String(rows[0].id), after: rows[0] });
      json(res, 201, rows[0]);
    }
  } else if (req.method === 'PATCH') {
    const body = await parseJsonBody(req);
    if (!body.id) { err(res, 400, 'id required in body'); return; }
    const { rows: before } = await dbQuery('SELECT * FROM meter_readings WHERE id = $1', [body.id]);
    if (before.length === 0) { err(res, 404, 'Reading not found'); return; }

    const sets: string[] = [];
    const params: unknown[] = [];
    let pi = 1;
    for (const field of ['value','unit','reading_type','period_start','period_end','read_at','source','reader_name','is_estimated','estimate_method','estimate_reason','notes']) {
      if (body[field] !== undefined) { sets.push(`${field} = $${pi++}`); params.push(body[field]); }
    }
    if (sets.length === 0) { err(res, 400, 'No fields to update'); return; }

    params.push(body.id);
    const { rows: after } = await dbQuery(
      `UPDATE meter_readings SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`, params
    );
    await audit.log({ module: 'assets', action: 'meter_reading.update', entityType: 'meter_reading', entityId: String(body.id), before: before[0], after: after[0] });
    json(res, 200, after[0]);
  } else {
    err(res, 405, 'Method not allowed');
  }
}

async function handleNkPeriodObligations(req: IncomingMessage, res: ServerResponse, propertyCode: string) {
  const { rows: propRows } = await dbQuery('SELECT id FROM properties WHERE code = $1 AND active = true', [propertyCode]);
  if (propRows.length === 0) { err(res, 404, 'Property not found'); return; }
  const propId = propRows[0].id;
  const { query } = parseUrl(req.url || '');

  if (req.method === 'GET') {
    let sql = 'SELECT * FROM nk_period_obligations WHERE property_id = $1';
    const params: unknown[] = [propId];
    if (query.year) { sql += ` AND year = $${params.length + 1}`; params.push(query.year); }
    sql += ' ORDER BY year DESC, unit_id';
    const { rows } = await dbQuery(sql, params);
    json(res, 200, rows);
  } else {
    err(res, 405, 'Method not allowed');
  }
}

// ── Row mappers ─────────────────────────────────────────────────────────────

function mapPropertyRow(row: any) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    street: row.street,
    postal_code: row.postal_code,
    city: row.city,
    property_type: row.property_type,
    owner: row.owner,
    ownership_start: dateStr(row.ownership_start),
    ownership_end: dateStr(row.ownership_end),
    billing_period_start_month: row.billing_period_start_month,
    heating_type: row.heating_type,
    co2_cost_relevant: row.co2_cost_relevant,
    active: row.active,
    created_at: ts(row.created_at),
    updated_at: ts(row.updated_at),
    unit_count: row.unit_count ?? 0,
  };
}

function mapTenantRow(row: any) {
  return {
    id: row.id,
    tenant_code: row.tenant_code,
    tenant_type: row.tenant_type,
    first_name: row.first_name,
    last_name: row.last_name,
    company_name: row.company_name,
    contact_person: row.contact_person,
    email: row.email,
    phone: row.phone,
    street: row.street,
    postal_code: row.postal_code,
    city: row.city,
    active: row.active,
    created_at: ts(row.created_at),
    updated_at: ts(row.updated_at),
  };
}

function mapLeaseRow(row: any) {
  return {
    id: row.id,
    lease_number: row.lease_number,
    unit_id: row.unit_id,
    unit_code: row.unit_code || null,
    property_code: row.property_code || null,
    lease_type: row.lease_type,
    status: row.status,
    start_date: dateStr(row.start_date),
    end_date: dateStr(row.end_date),
    termination_date: dateStr(row.termination_date),
    termination_reason: row.termination_reason,
    actual_move_out: dateStr(row.actual_move_out),
    kaltmiete: num(row.kaltmiete),
    nk_vorauszahlung: num(row.nk_vorauszahlung),
    heizkosten_vorauszahlung: num(row.heizkosten_vorauszahlung),
    kaution: num(row.kaution),
    billing_mode: row.billing_mode,
    payment_method: row.payment_method,
    vat_option: row.vat_option,
    notes: row.notes,
    created_at: ts(row.created_at),
    updated_at: ts(row.updated_at),
  };
}

function mapMeterRow(row: any) {
  return {
    id: row.id,
    scope_type: row.scope_type,
    property_id: row.property_id,
    unit_id: row.unit_id,
    medium: row.medium,
    meter_number: row.meter_number,
    provider: row.provider,
    installed_at: dateStr(row.installed_at),
    removed_at: dateStr(row.removed_at),
    calibration_valid_until: dateStr(row.calibration_valid_until),
    is_main_meter: row.is_main_meter,
    parent_meter_id: row.parent_meter_id,
    submetering_purpose: row.submetering_purpose,
    active: row.active,
    created_at: ts(row.created_at),
    updated_at: ts(row.updated_at),
  };
}

// ── Lease Changeover (composite transaction) ────────────────────────────────

async function executeLeaseChangeover(body: any, actor: string, sessionId: string, requestId: string) {
  const {
    old_lease_id,
    actual_move_out,
    new_lease,
    new_tenants,
    final_meter_readings,
    initial_meter_readings,
  } = body;

  if (!old_lease_id || !actual_move_out || !new_lease) {
    throw { status: 400, message: 'old_lease_id, actual_move_out, new_lease required', code: 'VALIDATION_ERROR' };
  }

  const client = await getClient();
  const warnings: string[] = [];

  try {
    await client.query('BEGIN');

    // a. Validate old lease
    const { rows: oldLeaseRows } = await client.query(
      `SELECT l.*, u.id AS unit_db_id, u.code AS unit_code, u.property_id
       FROM leases l JOIN units u ON l.unit_id = u.id
       WHERE l.id = $1 FOR UPDATE`,
      [old_lease_id]
    );
    if (oldLeaseRows.length === 0) {
      throw { status: 404, message: 'Old lease not found', code: 'LEASE_NOT_FOUND', path: 'old_lease_id' };
    }
    const oldLease = oldLeaseRows[0];

    if (!['active', 'terminated'].includes(oldLease.status)) {
      throw { status: 409, message: `Old lease has status "${oldLease.status}" — must be active or terminated`, code: 'LEASE_STATUS_INVALID', path: 'old_lease_id' };
    }

    // b. Validate actual_move_out >= start_date
    if (new Date(actual_move_out) < new Date(oldLease.start_date)) {
      throw { status: 400, message: 'actual_move_out cannot be before lease start_date', code: 'MOVE_OUT_BEFORE_START', path: 'actual_move_out' };
    }

    // c. Lease overlap check
    if (new_lease.start_date) {
      const oldEndDate = oldLease.end_date ? new Date(oldLease.end_date) : new Date(actual_move_out);
      const greatestEnd = new Date(Math.max(oldEndDate.getTime(), new Date(actual_move_out).getTime()));

      if (new Date(new_lease.start_date) <= greatestEnd) {
        throw { status: 409, message: 'New lease start_date overlaps with old lease period', code: 'LEASE_OVERLAP', path: 'new_lease.start_date' };
      }
    }

    // d. Auto-adjust end_date if needed
    if (oldLease.end_date && new Date(oldLease.end_date) > new Date(actual_move_out)) {
      await client.query(
        'UPDATE leases SET end_date = $1 WHERE id = $2',
        [actual_move_out, old_lease_id]
      );
      warnings.push(`Old lease end_date auto-adjusted from ${oldLease.end_date} to ${actual_move_out}`);
    }

    // e. Close old lease
    await client.query(
      `UPDATE leases SET status = 'ended', actual_move_out = $1,
       end_date = COALESCE(end_date, $1)
       WHERE id = $2`,
      [actual_move_out, old_lease_id]
    );

    // f. Record final meter readings
    if (final_meter_readings && Array.isArray(final_meter_readings)) {
      for (const reading of final_meter_readings) {
        await client.query(
          `INSERT INTO meter_readings (meter_id, value, unit, reading_type, read_at, source, reader_name, notes)
           VALUES ($1, $2, $3, 'move_out', $4, 'manual', $5, $6)`,
          [reading.meter_id, reading.value, reading.unit,
           reading.read_at || actual_move_out, reading.reader_name || null, reading.notes || null]
        );
      }
    }

    // g. Close open unit_residents
    await client.query(
      'UPDATE unit_residents SET move_out = $1 WHERE unit_id = $2 AND move_out IS NULL',
      [actual_move_out, oldLease.unit_db_id]
    );

    // h. Create/lookup tenants from new_tenants
    const tenantIds: number[] = [];
    if (new_tenants && Array.isArray(new_tenants)) {
      for (const t of new_tenants) {
        if (t.id) {
          tenantIds.push(t.id);
        } else {
          // Create new tenant
          const { rows: newTenantRows } = await client.query(
            `INSERT INTO tenants (tenant_type, first_name, last_name, company_name, email, phone, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [t.tenant_type || 'person', t.first_name || null, t.last_name || null,
             t.company_name || null, t.email || null, t.phone || null, t.notes || null]
          );
          tenantIds.push(newTenantRows[0].id);
        }
      }
    }

    // i. Create new lease
    const newLeaseNumber = new_lease.lease_number || `lease-${oldLease.unit_code}-${new Date().getTime()}`;
    const { rows: newLeaseRows } = await client.query(
      `INSERT INTO leases (unit_id, lease_number, lease_type, status, start_date, end_date,
         kaltmiete, nk_vorauszahlung, heizkosten_vorauszahlung, kaution,
         billing_mode, payment_method, notes)
       VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [oldLease.unit_db_id, newLeaseNumber, new_lease.lease_type || 'residential',
       new_lease.start_date, new_lease.end_date || null,
       new_lease.kaltmiete || null, new_lease.nk_vorauszahlung || null,
       new_lease.heizkosten_vorauszahlung || null, new_lease.kaution || null,
       new_lease.billing_mode || 'vorauszahlung', new_lease.payment_method || null,
       new_lease.notes || null]
    );
    const newLeaseId = newLeaseRows[0].id;

    // Create lease_tenants
    let primarySet = false;
    for (let i = 0; i < tenantIds.length; i++) {
      const isPrimary = new_tenants?.[i]?.is_primary_contact ?? (i === 0);
      if (isPrimary) primarySet = true;
      await client.query(
        `INSERT INTO lease_tenants (lease_id, tenant_id, role, is_primary_contact, valid_from)
         VALUES ($1, $2, $3, $4, $5)`,
        [newLeaseId, tenantIds[i], new_tenants?.[i]?.role || 'contract_party',
         isPrimary, new_lease.start_date]
      );
    }

    // j. Validate is_primary_contact exactly once
    if (tenantIds.length > 0 && !primarySet) {
      throw { status: 400, message: 'Exactly one tenant must have is_primary_contact', code: 'NO_PRIMARY_CONTACT', path: 'new_tenants' };
    }

    // Create initial charges
    if (new_lease.initial_charges && Array.isArray(new_lease.initial_charges)) {
      for (const charge of new_lease.initial_charges) {
        await client.query(
          `INSERT INTO lease_charges (lease_id, charge_type, amount, valid_from, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [newLeaseId, charge.charge_type, charge.amount, new_lease.start_date, charge.notes || null]
        );
      }
    }

    // Create new unit_residents entry
    if (tenantIds.length > 0) {
      const primaryTenantId = tenantIds[0];
      await client.query(
        `INSERT INTO unit_residents (unit_id, tenant_id, move_in, persons_count)
         VALUES ($1, $2, $3, $4)`,
        [oldLease.unit_db_id, primaryTenantId, new_lease.start_date,
         new_lease.persons_count || 1]
      );
    }

    // Record initial meter readings
    if (initial_meter_readings && Array.isArray(initial_meter_readings)) {
      for (const reading of initial_meter_readings) {
        await client.query(
          `INSERT INTO meter_readings (meter_id, value, unit, reading_type, read_at, source, reader_name, notes)
           VALUES ($1, $2, $3, 'move_in', $4, 'manual', $5, $6)`,
          [reading.meter_id, reading.value, reading.unit,
           reading.read_at || new_lease.start_date, reading.reader_name || null, reading.notes || null]
        );
      }
    }

    await client.query('COMMIT');

    // Audit log
    await audit.log({
      module: 'assets',
      action: 'lease_changeover',
      entityType: 'lease',
      entityId: String(newLeaseId),
      before: { old_lease_id, old_lease_status: oldLease.status },
      after: { new_lease_id: newLeaseId, new_tenants: tenantIds, warnings },
    });

    return {
      ok: true,
      old_lease_id,
      new_lease_id: newLeaseId,
      new_lease_number: newLeaseNumber,
      tenant_ids: tenantIds,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (e: any) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
