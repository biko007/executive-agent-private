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
import { listeVorschlaege, erzeugeVorschlaege, bestaetige, verwirf } from './proposals.js';
import { erzeugeEingabeblatt } from './casameta.js';
import { abrechnungAnsicht } from './abrechnung-ansicht.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
  // registerHttpRoute with prefix match handles dynamic segments
  // (e.g., /api/assets/properties/:id).
  const assetsHandler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    // Handler is registered for both /api/assets and /api/internal/nk-trigger
    const isInternalNkTrigger = pathname.startsWith('/api/internal/nk-trigger');

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
      // ── Buchungsvorschlaege aus Bankumsaetzen ───────────────────────────
      // Liste, Bestaetigen, Verwerfen. Das Dashboard leitet /api/assets/*
      // pauschal an den Core weiter — dort ist nichts zu aendern.
      if (resource === 'expense-proposals') {
        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            const id = segments[1] ? parseInt(segments[1], 10) : null;
            const aktion = segments[2];

            if (!id && req.method === 'GET') {
              const liste = await listeVorschlaege({
                status: url.searchParams.get('status') || undefined,
                property: url.searchParams.get('property') || undefined,
                limit: parseInt(url.searchParams.get('limit') || '200', 10),
              });
              json(res, 200, liste);
              return;
            }

            // POST /api/assets/expense-proposals/generate — erzeugt Vorschlaege
            // aus den vorhandenen Umsaetzen. Legt KEINE Buchung an.
            if (segments[1] === 'generate' && req.method === 'POST') {
              const body = await parseJsonBody(req).catch(() => ({} as any));
              const ergebnis = await erzeugeVorschlaege({
                seit: typeof body?.since === 'string' ? body.since : undefined,
                actor,
              });
              json(res, 200, ergebnis);
              return;
            }

            if (!id || !Number.isInteger(id) || id <= 0) {
              err(res, 400, 'Vorschlag-ID fehlt oder ist ungueltig'); return;
            }

            if (aktion === 'confirm' && req.method === 'POST') {
              const body = await parseJsonBody(req).catch(() => ({} as any));
              const ergebnis = await bestaetige(id, {
                cost_category_id: Number.isInteger(body?.cost_category_id)
                  ? body.cost_category_id : undefined,
                umlagefaehig: typeof body?.umlagefaehig === 'boolean'
                  ? body.umlagefaehig : undefined,
                notiz: typeof body?.notiz === 'string' ? body.notiz : undefined,
              }, actor);
              if (!ergebnis) { err(res, 404, 'Vorschlag nicht gefunden'); return; }
              json(res, 200, ergebnis);
              return;
            }

            if (aktion === 'reject' && req.method === 'POST') {
              const body = await parseJsonBody(req).catch(() => ({} as any));
              const ergebnis = await verwirf(
                id, typeof body?.grund === 'string' ? body.grund : undefined, actor);
              if (!ergebnis) { err(res, 404, 'Vorschlag nicht gefunden'); return; }
              json(res, 200, ergebnis);
              return;
            }

            err(res, 404, 'Unbekannte Aktion auf expense-proposals');
          } catch (e: any) { err(res, 500, e.message); }
        });
        return true;
      }

      // ── Properties list and /:id sub-routes ─────────────────────────────
      if (resource === 'properties') {
        const propertyId = segments[1];
        if (!propertyId) {
          // List / Create properties
          if (req.method !== 'GET' && req.method !== 'POST') { err(res, 405, 'Method not allowed'); return true; }
          await withContext({ requestId, actor, source: 'dashboard' }, async () => {
            try {
              if (req.method === 'GET') {
                const { rows } = await dbQuery(
                  `SELECT p.id, p.code, p.name, p.street, p.postal_code, p.city, p.property_type, p.owner,
                          p.ownership_start, p.ownership_end, p.billing_period_start_month,
                          p.heating_type, p.co2_cost_relevant, p.notes, p.active, p.created_at, p.updated_at,
                          p.construction_year, p.primary_energy_kwh_m2, p.current_market_value,
                          p.monthly_rent_override, p.purchase_price_total,
                          COUNT(u.id)::int AS unit_count,
                          COALESCE((SELECT SUM(l.kaltmiete) FROM leases l JOIN units u2 ON u2.id = l.unit_id
                                    WHERE u2.property_id = p.id AND l.status = 'active'), 0) AS monthly_rent_calculated
                   FROM properties p
                   LEFT JOIN units u ON u.property_id = p.id AND u.active = true
                   WHERE p.active = true
                   GROUP BY p.id
                   ORDER BY p.code`
                );
                json(res, 200, rows.map(mapPropertyRow));
              } else {
                const body = await parseJsonBody(req);
                if (!body.code || !body.street || !body.postal_code || !body.city) {
                  err(res, 400, 'code, street, postal_code, city required'); return;
                }
                const { rows } = await dbQuery(
                  `INSERT INTO properties (code, name, street, postal_code, city, property_type, owner,
                     ownership_start, billing_period_start_month, heating_type, co2_cost_relevant)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
                  [body.code, body.name || body.code.toUpperCase(), body.street, body.postal_code, body.city,
                   body.property_type || 'residential', body.owner || 'personal',
                   body.ownership_start || null, body.billing_period_start_month || 1,
                   body.heating_type || null, body.co2_cost_relevant || false]
                );
                await audit.log({ module: 'assets', action: 'property.create', entityType: 'property', entityId: rows[0].code, after: rows[0] });
                json(res, 201, mapPropertyRow(rows[0]));
              }
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
            if (sub === 'belege') { await handleBelege(req, res, propertyId); return; }
            if (sub === 'mieterstrom') { await handleMieterstrom(req, res, propertyId); return; }
            if (sub === 'abrechnungsbereitschaft') { await handleBereitschaft(req, res, propertyId, url); return; }
            if (sub === 'abrechnung-ansicht') { await handleAbrechnungAnsicht(req, res, propertyId, url); return; }
            if (sub === 'casameta-eingabeblatt') { await handleEingabeblatt(req, res, propertyId, url); return; }
            if (sub === 'expense-bookings') { await handleExpenseBookings(req, res, propertyId, segments[3]); return; }
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
                  `SELECT p.id, p.code, p.name, p.street, p.postal_code, p.city, p.property_type, p.owner,
                          p.ownership_start, p.ownership_end, p.billing_period_start_month,
                          p.heating_type, p.co2_cost_relevant, p.notes, p.active, p.created_at, p.updated_at,
                          p.construction_year, p.primary_energy_kwh_m2, p.current_market_value,
                          p.monthly_rent_override, p.purchase_price_total,
                          COALESCE((SELECT SUM(l.kaltmiete) FROM leases l JOIN units u2 ON u2.id = l.unit_id
                                    WHERE u2.property_id = p.id AND l.status = 'active'), 0) AS monthly_rent_calculated
                   FROM properties p WHERE p.code = $1 AND p.active = true`, [propertyId]
                );
                if (rows.length === 0) { err(res, 404, 'Property not found'); return; }
                json(res, 200, mapPropertyRow(rows[0]));
              } else if (req.method === 'PATCH') {
                const body = await parseJsonBody(req);
                const { rows: before } = await dbQuery('SELECT * FROM properties WHERE code = $1 AND active = true', [propertyId]);
                if (before.length === 0) { err(res, 404, 'Property not found'); return; }

                const notizFehler = notizenVorbereiten(body, before[0]);
                if (notizFehler) { err(res, 400, notizFehler); return; }

                const sets: string[] = [];
                const params: unknown[] = [];
                let pi = 1;
                if (body.name !== undefined) { sets.push(`name = $${pi++}`); params.push(body.name); }
                if (body.street !== undefined) { sets.push(`street = $${pi++}`); params.push(body.street); }
                if (body.postal_code !== undefined) { sets.push(`postal_code = $${pi++}`); params.push(body.postal_code); }
                if (body.city !== undefined) { sets.push(`city = $${pi++}`); params.push(body.city); }
                if (body.property_type !== undefined) { sets.push(`property_type = $${pi++}`); params.push(body.property_type); }
                if (body.owner !== undefined) { sets.push(`owner = $${pi++}`); params.push(body.owner); }
                /* ownership_start war bis 10.10.2026 nicht änderbar, obwohl das Feld
                   existiert und die Liste es ausliefert. Aufgefallen bei MG24: dort stand
                   01.04.2025 (Vermietungsbeginn) statt 31.03.2022 (Grundbucheintragung).
                   Ohne diese Zeile bliebe als Korrekturweg nur ein Eingriff an der
                   Datenbank vorbei an Route und Audit-Log. */
                if (body.ownership_start !== undefined) { sets.push(`ownership_start = $${pi++}`); params.push(body.ownership_start); }
                if (body.ownership_end !== undefined) { sets.push(`ownership_end = $${pi++}`); params.push(body.ownership_end); }
                if (body.billing_period_start_month !== undefined) { sets.push(`billing_period_start_month = $${pi++}`); params.push(body.billing_period_start_month); }
                if (body.heating_type !== undefined) { sets.push(`heating_type = $${pi++}`); params.push(body.heating_type); }
                if (body.co2_cost_relevant !== undefined) { sets.push(`co2_cost_relevant = $${pi++}`); params.push(body.co2_cost_relevant); }
                if (body.notes !== undefined) { sets.push(`notes = $${pi++}`); params.push(body.notes); }
                if (body.construction_year !== undefined) { sets.push(`construction_year = $${pi++}`); params.push(body.construction_year); }
                if (body.primary_energy_kwh_m2 !== undefined) { sets.push(`primary_energy_kwh_m2 = $${pi++}`); params.push(body.primary_energy_kwh_m2); }
                if (body.current_market_value !== undefined) { sets.push(`current_market_value = $${pi++}`); params.push(body.current_market_value); }
                if (body.monthly_rent_override !== undefined) { sets.push(`monthly_rent_override = $${pi++}`); params.push(body.monthly_rent_override); }
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
                const { rows } = await dbQuery(
                  `SELECT t.*,
                     (SELECT COUNT(*)::int FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
                      WHERE lt.tenant_id = t.id AND l.status = 'active') AS active_lease_count
                   FROM tenants t WHERE t.active = true ORDER BY t.last_name, t.company_name`
                );
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
              const notizFehler = notizenVorbereiten(body, before[0]);
              if (notizFehler) { err(res, 400, notizFehler); return; }
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
                let sql = `SELECT l.*, u.code AS unit_code, p.code AS property_code,
                                  COALESCE(p.name, p.code) AS property_name,
                                  p.code || '/' || u.code AS unit_label,
                                  STRING_AGG(DISTINCT COALESCE(t.first_name || ' ' || t.last_name, t.company_name, t.last_name), ', ') AS tenant_names
                           FROM leases l
                           JOIN units u ON l.unit_id = u.id
                           JOIN properties p ON u.property_id = p.id
                           LEFT JOIN lease_tenants lt ON lt.lease_id = l.id
                           LEFT JOIN tenants t ON t.id = lt.tenant_id`;
                const params: unknown[] = [];
                const conditions: string[] = [];
                if (query.property_code) { conditions.push(`p.code = $${params.length + 1}`); params.push(query.property_code); }
                if (query.unit_code) { conditions.push(`u.code = $${params.length + 1}`); params.push(query.unit_code); }
                if (query.status) { conditions.push(`l.status = $${params.length + 1}`); params.push(query.status); }
                if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
                sql += ` GROUP BY l.id, u.code, p.code, p.name ORDER BY l.start_date DESC`;
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
            if (segments[2] === 'charges') { await handleLeaseCharges(req, res, leaseId, segments[3]); return; }
            if (segments[2] === 'end') { await handleLeaseEnd(req, res, leaseId); return; }
            if (segments[2] === 'revoke-end') { await handleLeaseRevokeEnd(req, res, leaseId); return; }
            if (segments[2] === 'move-out') { await handleLeaseMoveOut(req, res, leaseId); return; }
            if (segments[2] === 'vertragsparteien') {
              await handleLeaseVertragsparteien(req, res, leaseId);
              return;
            }

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
              /* `contract_document_path` ist am 12.10.2026 dazugekommen. Das Feld
                 existiert seit jeher in der Tabelle, war aber über keine Route
                 zu setzen — bei N24 standen die Vertrags-PDFs in SharePoint und
                 ließen sich mit dem Mietverhältnis nicht verknüpfen. Der einzige
                 Weg wäre ein Schreiben an der Route vorbei gewesen. */
              const notizFehler = notizenVorbereiten(body, before[0]);
              if (notizFehler) { err(res, 400, notizFehler); return; }
              for (const field of ['lease_number','lease_type','status','start_date','end_date',
                'kaltmiete','nk_vorauszahlung','heizkosten_vorauszahlung','kaution',
                'billing_mode','payment_method','rent_due_day','vat_option','vat_rate','notes',
                'termination_date','termination_reason','actual_move_out',
                /* Übergabetermine. Seit dem 13.10.2026 schneiden sie den
                   Verbrauch zwischen zwei Nutzern (`nutzungsAbschnitt()`),
                   während die Kosten nach Fläche am Vertrag hängen. Ohne sie
                   in dieser Liste wäre eine Korrektur nur an der Route vorbei
                   möglich. */
                'handover_at',
                'contract_document_path']) {
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
        if (req.method === 'GET') {
          try {
            const { rows } = await dbQuery('SELECT * FROM cost_categories WHERE active = true ORDER BY sort_order');
            json(res, 200, rows);
          } catch (e: any) { err(res, 500, e.message); }
          return true;
        }

        // POST /api/assets/cost-categories — Kostenart anlegen oder ergaenzen.
        //
        // Die Kostenartenliste ist Stammdaten, keine Struktur: Eine fehlende
        // BetrKV-Position ist eine Datenzeile und braucht keine Migration. Sie
        // braucht aber einen protokollierten Weg, denn an ihr haengen
        // Umlageregeln und damit Geld — deshalb diese Route statt eines
        // direkten INSERT.
        if (req.method === 'POST') {
          await withContext({ requestId, actor, source: 'dashboard' }, async () => {
            try {
              const body = await parseJsonBody<any>(req);
              if (!body?.code || !body?.name || typeof body?.umlagefaehig_default !== 'boolean') {
                err(res, 400, 'code, name und umlagefaehig_default erforderlich'); return;
              }
              const { rows: vorher } = await dbQuery(
                'SELECT * FROM cost_categories WHERE code = $1', [body.code]);

              const { rows } = await dbQuery(
                `INSERT INTO cost_categories
                   (code, name, betrkv_reference, umlagefaehig_default, tax_category,
                    requires_consumption, heating_cost_relevant, co2_relevant,
                    active, sort_order, notes)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                 ON CONFLICT (code) DO UPDATE SET
                   name = EXCLUDED.name,
                   betrkv_reference = COALESCE(EXCLUDED.betrkv_reference, cost_categories.betrkv_reference),
                   umlagefaehig_default = EXCLUDED.umlagefaehig_default,
                   tax_category = COALESCE(EXCLUDED.tax_category, cost_categories.tax_category),
                   requires_consumption = EXCLUDED.requires_consumption,
                   heating_cost_relevant = EXCLUDED.heating_cost_relevant,
                   co2_relevant = EXCLUDED.co2_relevant,
                   active = EXCLUDED.active,
                   sort_order = COALESCE(EXCLUDED.sort_order, cost_categories.sort_order),
                   notes = COALESCE(EXCLUDED.notes, cost_categories.notes)
                 RETURNING *`,
                [body.code, body.name, body.betrkv_reference || null,
                  body.umlagefaehig_default, body.tax_category || null,
                  body.requires_consumption === true, body.heating_cost_relevant === true,
                  body.co2_relevant === true, body.active !== false,
                  Number.isInteger(body.sort_order) ? body.sort_order : null,
                  body.notes || null]);

              await audit.log({
                module: 'assets',
                action: vorher.length > 0 ? 'cost_category.update' : 'cost_category.create',
                entityType: 'cost_category', entityId: body.code,
                before: vorher[0] || null, after: rows[0],
              });
              json(res, vorher.length > 0 ? 200 : 201, rows[0]);
            } catch (e: any) { err(res, 500, e.message); }
          });
          return true;
        }

        err(res, 405, 'Method not allowed');
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
            if (segments[2] === 'readings') { await handleMeterReadings(req, res, meterId, actor, requestId); return; }
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
              /* `active` und `initial_reading` ergaenzt am 10.10.2026.
                 `active`: Ein Zaehler, dessen Werte geklaert werden muessen, soll aus der
                 Rechnung heraus, ohne ihn ueber /archive als AUSGEBAUT zu kennzeichnen —
                 das waere falsch und setzte zusaetzlich removed_at.
                 `initial_reading`: Anfangsstand bei Einbau. Die Vorpruefung nutzt ihn, wenn
                 im Zeitraum keine Ablesung vor Periodenbeginn liegt
                 (CONSUMPTION_START_ASSUMED_ZERO) — sonst waere die Abrechnung gesperrt,
                 obwohl der Nullstart belegt ist. */
              const notizFehler = notizenVorbereiten(body, before[0]);
              if (notizFehler) { err(res, 400, notizFehler); return; }
              for (const field of ['meter_number','provider','installed_at','removed_at',
                'calibration_valid_until','is_main_meter','parent_meter_id','submetering_purpose','notes',
                'active','initial_reading']) {
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

      // ── Security Deposits ───────────────────────────────────────────────
      // Die Tabelle gibt es seit V022, eine Route dafuer bis zum 13.10.2026
      // nicht. Wer eine Kaution festhalten wollte, haette an der Schnittstelle
      // vorbei in die Datenbank schreiben muessen — also gar nicht. Bewusst
      // ohne DELETE: Eine Kaution wird zurueckgezahlt, nicht geloescht; dafuer
      // gibt es returned_at und status.
      if (resource === 'security-deposits') {
        const depositId = segments[1];
        await withContext({ requestId, actor, source: 'dashboard' }, async () => {
          try {
            if (!depositId) {
              if (req.method === 'GET') {
                const { query } = parseUrl(req.url || '');
                let sql = `SELECT sd.*, l.lease_number, u.code AS unit_code, p.code AS property_code
                           FROM security_deposits sd
                           JOIN leases l ON l.id = sd.lease_id
                           JOIN units u ON u.id = l.unit_id
                           JOIN properties p ON p.id = u.property_id`;
                const params: unknown[] = [];
                const wo: string[] = [];
                if (query.lease_id) { wo.push(`sd.lease_id = $${params.length + 1}`); params.push(query.lease_id); }
                if (query.property_code) { wo.push(`p.code = $${params.length + 1}`); params.push(query.property_code); }
                if (query.status) { wo.push(`sd.status = $${params.length + 1}`); params.push(query.status); }
                if (wo.length) sql += ' WHERE ' + wo.join(' AND ');
                sql += ' ORDER BY p.code, u.code';
                const { rows } = await dbQuery(sql, params);
                json(res, 200, rows.map(mapDepositRow));
                return;
              }
              if (req.method === 'POST') {
                const body = await parseJsonBody<any>(req);
                if (!body.lease_id || body.agreed_amount === undefined) {
                  err(res, 400, 'lease_id und agreed_amount erforderlich'); return;
                }
                const { rows: lease } = await dbQuery('SELECT id FROM leases WHERE id = $1', [body.lease_id]);
                if (lease.length === 0) { err(res, 404, 'Mietverhaeltnis nicht gefunden'); return; }
                const { rows: vorhanden } = await dbQuery(
                  'SELECT id FROM security_deposits WHERE lease_id = $1', [body.lease_id]);
                if (vorhanden.length > 0) {
                  err(res, 409, `Fuer dieses Mietverhaeltnis gibt es bereits eine Kaution (id ${vorhanden[0].id})`);
                  return;
                }
                const { rows } = await dbQuery(
                  `INSERT INTO security_deposits
                     (lease_id, agreed_amount, due_amount, paid_amount, deposit_account,
                      interest_amount, returned_at, deductions_amount, status, payment_dates, notes)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'unknown'),$10,$11)
                   RETURNING *`,
                  [body.lease_id, body.agreed_amount, body.due_amount ?? null,
                   body.paid_amount ?? 0, body.deposit_account ?? null,
                   body.interest_amount ?? 0, body.returned_at ?? null,
                   body.deductions_amount ?? 0, body.status ?? null,
                   body.payment_dates ? JSON.stringify(body.payment_dates) : null,
                   body.notes ?? null]);
                await audit.log({ module: 'assets', action: 'security_deposit.create',
                  entityType: 'security_deposit', entityId: String(rows[0].id), after: rows[0] });
                /* Noch einmal mit den verbundenen Feldern lesen. Ein POST, der
                   weniger liefert als das spaetere GET, ist genau die Lese-/
                   Schreib-Asymmetrie, die am 13.10.2026 zum Datenverlust
                   gefuehrt hat. */
                json(res, 201, mapDepositRow(await kautionMitBezug(rows[0].id) ?? rows[0]));
                return;
              }
              err(res, 405, 'Method not allowed');
              return;
            }

            const { rows: before } = await dbQuery(
              'SELECT * FROM security_deposits WHERE id = $1', [depositId]);
            if (before.length === 0) { err(res, 404, 'Kaution nicht gefunden'); return; }

            if (req.method === 'GET') {
              json(res, 200, mapDepositRow(await kautionMitBezug(depositId) ?? before[0]));
              return;
            }

            if (req.method === 'PATCH') {
              const body = await parseJsonBody<any>(req);
              const notizFehler = notizenVorbereiten(body, before[0]);
              if (notizFehler) { err(res, 400, notizFehler); return; }

              const sets: string[] = [];
              const params: unknown[] = [];
              let pi = 1;
              for (const field of ['agreed_amount','due_amount','paid_amount','deposit_account',
                'interest_amount','returned_at','deductions_amount','status','notes']) {
                if (body[field] !== undefined) { sets.push(`${field} = $${pi++}`); params.push(body[field]); }
              }
              if (body.payment_dates !== undefined) {
                sets.push(`payment_dates = $${pi++}`); params.push(JSON.stringify(body.payment_dates));
              }
              if (sets.length === 0) { err(res, 400, 'Kein Feld zum Aendern'); return; }
              params.push(depositId);
              const { rows: after } = await dbQuery(
                `UPDATE security_deposits SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`, params);
              await audit.log({ module: 'assets', action: 'security_deposit.update',
                entityType: 'security_deposit', entityId: String(depositId),
                before: before[0], after: after[0] });
              json(res, 200, mapDepositRow(await kautionMitBezug(depositId) ?? after[0]));
              return;
            }

            err(res, 405, 'Method not allowed');
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
              // archived_at ist bewusst aenderbar: die Archiv-Route hat kein Gegenstueck, und der
              // Ausschluss-Index allocation_rules_no_overlap ignoriert archivierte Regeln. Eine
              // Regel mit falschem Schluessel laesst sich deshalb nicht durch Archivieren und
              // Neuanlegen fuer denselben Zeitraum ersetzen - sie muss an der Stelle korrigiert
              // und reaktiviert werden. Jede Aenderung landet im Audit-Log.
              for (const field of ['key_type','base_share_percent','consumption_share_percent','valid_from','valid_until','source','notes','archived_at']) {
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

      // ── NK Trigger (n8n cron → /api/internal/, localhost-only via nginx) ──
      if (isInternalNkTrigger) {
        const internalRest = pathname.replace(/^\/api\/internal\/nk-trigger\/?/, '');
        const internalSegments = internalRest.split('/').filter(Boolean);
        if (internalSegments[0] === 'obligations-alert' && req.method === 'POST') {
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
  };

  api.registerHttpRoute({ path: '/api/assets', auth: 'plugin', match: 'prefix', handler: assetsHandler });
  api.registerHttpRoute({ path: '/api/internal/nk-trigger', auth: 'plugin', match: 'prefix', handler: assetsHandler });

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

    // Diese Route ist ein Upsert. Bis zum 13.10.2026 hat sie jedes Feld, das im
    // Aufruf fehlte, auf NULL gesetzt — ein PUT, der nur das Heizsystem
    // nachtragen wollte, loeschte damit den Verbrauchsschluessel und den
    // Vermerk. Das ist dieselbe Falle, die am selben Tag vier Zaehlernotizen
    // gekostet hat. Jetzt gilt: Was nicht im Aufruf steht, bleibt stehen.
    const { rows: bestand } = await dbQuery(
      'SELECT * FROM property_heating_config WHERE property_id = $1 AND year = $2',
      [propId, body.year]
    );
    const vorher = bestand[0] ?? null;

    const notizFehler = notizenVorbereiten(body, vorher);
    if (notizFehler) { err(res, 400, notizFehler); return; }

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
      [propId, body.year, body.heating_system, feldUebernehmen(body, vorher, 'hot_water_via_heating', true),
       feldUebernehmen(body, vorher, 'base_share_percent'), feldUebernehmen(body, vorher, 'consumption_share_percent'),
       feldUebernehmen(body, vorher, 'co2_emissions_kg'), feldUebernehmen(body, vorher, 'co2_cost_total'),
       feldUebernehmen(body, vorher, 'co2_tenant_share_percent'), feldUebernehmen(body, vorher, 'notes')]
    );
    await audit.log({ module: 'assets', action: 'heating_config.upsert', entityType: 'property_heating_config', entityId: `${propertyCode}/${body.year}`, before: vorher ?? undefined, after: rows[0] });
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
      const notizFehler = notizenVorbereiten(body, before[0]);
      if (notizFehler) { err(res, 400, notizFehler); return; }
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

/**
 * Vertragsparteien eines bestehenden Mietverhältnisses.
 *
 * WARUM ES DAS BRAUCHT (12.10.2026): `lease_tenants` wurde bisher nur beim
 * ANLEGEN eines Mietverhältnisses gefüllt. Fehlte eine Partei — bei N24 W5
 * stand nur Klaus Bickel in der Datenbank, der Vertrag nennt aber auch
 * Waltraud Bickel —, war sie nicht mehr nachzutragen. Der einzige Weg wäre
 * ein Schreiben an der Route vorbei gewesen.
 *
 * GET listet die Parteien, POST fügt eine hinzu. Entfernt wird hier nichts:
 * Eine Vertragspartei verschwindet nicht, sie wechselt allenfalls — und das
 * ist ein neues Mietverhältnis.
 */
async function handleLeaseVertragsparteien(
  req: IncomingMessage, res: ServerResponse, leaseId: string,
) {
  const { rows: lease } = await dbQuery(
    'SELECT id, start_date FROM leases WHERE id = $1', [leaseId]);
  if (lease.length === 0) { err(res, 404, 'Lease not found'); return; }

  if (req.method === 'GET') {
    const { rows } = await dbQuery(
      `SELECT lt.tenant_id, lt.role, lt.is_primary_contact, lt.valid_from,
              t.first_name, t.last_name, t.company_name
         FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id
        WHERE lt.lease_id = $1 ORDER BY lt.is_primary_contact DESC, t.last_name`,
      [leaseId]);
    json(res, 200, rows);
    return;
  }

  if (req.method !== 'POST') { err(res, 405, 'Method not allowed'); return; }

  const body = await parseJsonBody(req);
  if (!body.tenant_id) { err(res, 400, 'tenant_id required'); return; }

  const { rows: mieter } = await dbQuery(
    'SELECT id FROM tenants WHERE id = $1 AND active = true', [body.tenant_id]);
  if (mieter.length === 0) { err(res, 404, 'Tenant not found'); return; }

  const { rows: schon } = await dbQuery(
    'SELECT 1 FROM lease_tenants WHERE lease_id = $1 AND tenant_id = $2',
    [leaseId, body.tenant_id]);
  if (schon.length > 0) { err(res, 409, 'Tenant is already a party to this lease'); return; }

  const { rows } = await dbQuery(
    `INSERT INTO lease_tenants (lease_id, tenant_id, role, is_primary_contact, valid_from)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [leaseId, body.tenant_id, body.role || 'contract_party',
     body.is_primary_contact ?? false, body.valid_from || lease[0].start_date]);

  await audit.log({
    module: 'assets', action: 'lease_tenant.create',
    entityType: 'lease', entityId: String(leaseId), after: rows[0],
  });
  json(res, 201, rows[0]);
}

async function handleLeaseCharges(
  req: IncomingMessage, res: ServerResponse, leaseId: string, chargeId?: string,
) {
  /* Eine einzelne Position aendern. Ohne diesen Weg liesse sich eine einmal
     angelegte Vorauszahlung nicht mehr berichtigen — und genau das war noetig,
     als am 15.10.2026 aus der Buchungsliste hervorging, dass die
     Vorauszahlung eines Mieters erst einen Monat spaeter zu laufen begann.
     Jede Aenderung geht ins Audit-Log. */
  if (chargeId && req.method === 'PATCH') {
    const body = await parseJsonBody(req);
    const { rows: before } = await dbQuery(
      'SELECT * FROM lease_charges WHERE id = $1 AND lease_id = $2', [chargeId, leaseId]);
    if (before.length === 0) { err(res, 404, 'Charge not found'); return; }
    const sets: string[] = [];
    const params: unknown[] = [];
    let pi = 1;
    for (const field of ['charge_type', 'amount', 'vat_rate', 'valid_from', 'valid_until', 'notes', 'archived_at']) {
      if (body[field] !== undefined) { sets.push(`${field} = $${pi++}`); params.push(body[field]); }
    }
    if (sets.length === 0) { err(res, 400, 'No fields to update'); return; }
    params.push(chargeId);
    const { rows: after } = await dbQuery(
      `UPDATE lease_charges SET ${sets.join(', ')} WHERE id = $${pi} RETURNING *`, params);
    await audit.log({
      module: 'assets', action: 'lease_charge.update', entityType: 'lease_charge',
      entityId: String(chargeId), before: before[0], after: after[0],
    });
    json(res, 200, after[0]);
    return;
  }
  if (chargeId) { err(res, 405, 'Method not allowed'); return; }
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

/**
 * Belegliste eines Objekts.
 *
 * Die fachlichen Felder stehen im Index des Belegarchivs (Sparte, Vertrag,
 * Leistungszeitraum, Verbrauch, Zählernummer, Hash); die Verknüpfung am Objekt
 * und damit der Zugriffscode steht in `entity_links`. Diese Route führt beides
 * über den Dateipfad zusammen — so braucht es keine neue Tabelle, und das
 * Dashboard bekommt trotzdem eine Liste mit Spalten statt Textetiketten.
 */
async function handleBelege(req: IncomingMessage, res: ServerResponse, propertyCode: string) {
  if (req.method !== 'GET') { err(res, 405, 'Method not allowed'); return; }

  const indexPfad = join(
    homedir(), '.openclaw', 'workspace', 'artifacts', 'personal', 'assets', 'belege', 'index-swt.json');
  let belege: any[] = [];
  if (existsSync(indexPfad)) {
    try {
      belege = JSON.parse(readFileSync(indexPfad, 'utf-8')).belege || [];
    } catch (e: any) {
      err(res, 500, `Belegindex nicht lesbar: ${e.message}`); return;
    }
  }

  const { rows: links } = await dbQuery<{ link_code: string; local_path: string }>(
    `SELECT link_code, local_path FROM entity_links
      WHERE entity_type = 'property' AND entity_id = $1 AND doc_type = 'local'`,
    [propertyCode]);
  const codeZuPfad = new Map(links.map(l => [l.local_path, l.link_code]));

  const eigene = belege
    .filter(b => b.objekt === propertyCode)
    .map(b => ({
      ...b,
      link_code: codeZuPfad.get(b.pfad) || null,
      // Rechnungen des Nachbargebäudes liegen beim Objekt, gehören aber nicht
      // in seine Abrechnung — das muss in der Liste sichtbar sein.
      nachbargebaeude: b.ablage !== propertyCode,
    }))
    .sort((a, b) => String(b.rechnungsdatum).localeCompare(String(a.rechnungsdatum)));

  json(res, 200, {
    objekt: propertyCode,
    anzahl: eigene.length,
    archiv_vorhanden: existsSync(indexPfad),
    belege: eigene,
  });
}

/**
 * Mieterstromdaten eines Objekts aus den Einstellungen.
 *
 * Der Mieterstrom wird von energiekonzept getrennt mit den Mietern
 * abgerechnet; in die Nebenkosten geht nur der Allgemeinstrom. Für die
 * Objektverwaltung müssen die Zahlen trotzdem greifbar sein. Sie stehen in
 * `system_settings.mieterstrom` — bewusst als Daten und nicht als Tabelle: Es
 * sind wenige Werte je Objekt und Jahr aus EINEM Beleg, und jede Tabelle
 * dafür wäre eine Migration ohne Gegenwert. Kommt eine Kontrollrechnung
 * hinzu, ist der Zeitpunkt für ein Fachschema da (Vorschlag im Report 3b).
 */
async function handleMieterstrom(req: IncomingMessage, res: ServerResponse, propertyCode: string) {
  if (req.method !== 'GET') { err(res, 405, 'Method not allowed'); return; }
  const { rows } = await dbQuery<{ value: any }>(
    `SELECT value FROM system_settings WHERE key = 'mieterstrom'`);
  const alle = rows[0]?.value || {};
  json(res, 200, { objekt: propertyCode, jahre: alle[propertyCode] || {} });
}

/**
 * Abrechnungsbereitschaft eines Objekts für einen Zeitraum.
 *
 * Führt drei Dinge zusammen, die der Owner sonst an drei Stellen suchen müsste:
 *
 *   1. die technische Abrechnungsreife aus der Vorprüfung (Blocker/Warnungen),
 *   2. den fachlichen Belegbedarf — ob überhaupt alle Rechnungen vorliegen,
 *   3. den Datenstand: Wie alt sind Zählerimport, Bankabgleich und Belege?
 *
 * Punkt 2 fehlt in der Vorprüfung grundsätzlich: Sie kann prüfen, ob die
 * erfassten Daten stimmig sind, aber nicht, ob eine Rechnung fehlt, die
 * niemand erfasst hat. Genau daran scheitert eine Abrechnung in der Praxis.
 */
async function handleBereitschaft(
  req: IncomingMessage, res: ServerResponse, propertyCode: string, url: URL,
) {
  if (req.method !== 'GET') { err(res, 405, 'Method not allowed'); return; }
  const jahr = parseInt(url.searchParams.get('jahr') || String(new Date().getFullYear() - 1), 10);
  if (!Number.isInteger(jahr) || jahr < 2000 || jahr > 2100) {
    err(res, 400, 'jahr fehlt oder ist ungueltig'); return;
  }

  const { rows: objekte } = await dbQuery(
    'SELECT id FROM properties WHERE code = $1 AND active = true', [propertyCode]);
  if (objekte.length === 0) { err(res, 404, 'Property not found'); return; }
  const propId = objekte[0].id;

  const vorpruefung = await nkPreCheck(propId, jahr);

  const { rows: bbRows } = await dbQuery<{ value: any }>(
    `SELECT value FROM system_settings WHERE key = 'belegbedarf'`);
  const bedarf: any[] = bbRows[0]?.value?.[propertyCode]?.[String(jahr)] || [];
  // Offene Punkte, die keine Belege sind — etwa eine geplante Umstellung, die
  // auf eine Antwort von aussen wartet.
  const hinweise: string[] = bbRows[0]?.value?.[propertyCode]?.[`hinweise_${jahr}`] || [];
  const offeneBelege = bedarf.filter(
    b => b.status !== 'vorhanden' && b.status !== 'nicht_zutreffend');

  // Datenstand: je jünger, desto verlässlicher ist die Abrechnung.
  const { rows: zaehlerStand } = await dbQuery<{ letzte: string | null }>(
    `SELECT max(r.read_at)::text AS letzte
       FROM meter_readings r JOIN meters m ON m.id = r.meter_id
       LEFT JOIN units u ON u.id = m.unit_id
      WHERE m.property_id = $1 OR u.property_id = $1`, [propId]);
  const { rows: bankStand } = await dbQuery<{ letzte: string | null }>(
    'SELECT max(booking_date)::text AS letzte FROM banking_transactions');
  const { rows: belegStand } = await dbQuery<{ letzte: string | null; n: number }>(
    `SELECT max(invoice_date)::text AS letzte, count(*)::int AS n
       FROM expense_bookings
      WHERE property_id = $1 AND archived_at IS NULL
        AND service_period_start <= $3 AND service_period_end >= $2`,
    [propId, `${jahr}-01-01`, `${jahr}-12-31`]);

  // Ampel: Rot bei Blockern, Gelb bei fehlenden Belegen oder Warnungen.
  const blocker = vorpruefung.findings.filter((f: any) => f.severity === 'blocker');
  const warnungen = vorpruefung.findings.filter((f: any) => f.severity === 'warning');
  const ampel = blocker.length > 0 ? 'rot'
    : (offeneBelege.length > 0 || warnungen.length > 0 || hinweise.length > 0) ? 'gelb' : 'gruen';

  json(res, 200, {
    objekt: propertyCode,
    jahr,
    ampel,
    bereit: vorpruefung.ready === true,
    blocker: blocker.map((f: any) => ({ code: f.code, message: f.message })),
    warnungen: warnungen.map((f: any) => ({ code: f.code, message: f.message })),
    belegbedarf: bedarf,
    offene_belege: offeneBelege.length,
    hinweise,
    datenstand: {
      letzter_zaehlerstand: zaehlerStand[0]?.letzte ?? null,
      letzter_bankumsatz: bankStand[0]?.letzte ?? null,
      letzte_rechnung: belegStand[0]?.letzte ?? null,
      kostenbuchungen_im_zeitraum: belegStand[0]?.n ?? 0,
    },
  });
}

/**
 * Darstellungsdaten einer Abrechnung — je Einheit Verbrauch, Kostenarten,
 * Vorauszahlung, Saldo und Belege.
 *
 * Es ist eine VORSCHAU: Es entsteht kein Dokument, es wird nichts versendet
 * und nichts gespeichert. Die Betraege kommen unveraendert aus der Engine.
 */
async function handleAbrechnungAnsicht(
  req: IncomingMessage, res: ServerResponse, propertyCode: string, url: URL,
) {
  if (req.method !== 'GET') { err(res, 405, 'Method not allowed'); return; }
  const jahr = parseInt(url.searchParams.get('jahr') || String(new Date().getFullYear() - 1), 10);
  if (!Number.isInteger(jahr) || jahr < 2000 || jahr > 2100) {
    err(res, 400, 'jahr fehlt oder ist ungueltig'); return;
  }
  /* Zwischenabrechnung: `bis` genügt, `von` ist dann der Jahresbeginn. Die
     fachliche Prüfung des Zeitraums macht die Engine (pruefeZeitraum) — eine
     zweite Prüfung hier würde mit der Zeit von jener abweichen. */
  const bisParam = url.searchParams.get('bis');
  const vonParam = url.searchParams.get('von');
  const zeitraum = (bisParam || vonParam)
    ? { von: vonParam || `${jahr}-01-01`, bis: bisParam || `${jahr}-12-31` }
    : undefined;
  try {
    json(res, 200, await abrechnungAnsicht(propertyCode, jahr, zeitraum));
  } catch (e: any) {
    err(res, e.status === 400 ? 400 : 500, e.message);
  }
}

/** Erzeugt das Casameta-Eingabeblatt und liefert die Kennzahlen zurueck. */
async function handleEingabeblatt(
  req: IncomingMessage, res: ServerResponse, propertyCode: string, url: URL,
) {
  if (req.method !== 'POST') { err(res, 405, 'Method not allowed'); return; }
  const jahr = parseInt(url.searchParams.get('jahr') || '', 10);
  if (!Number.isInteger(jahr) || jahr < 2000 || jahr > 2100) {
    err(res, 400, 'jahr fehlt oder ist ungueltig'); return;
  }
  const ergebnis = await erzeugeEingabeblatt(propertyCode, jahr);
  await audit.log({
    module: 'assets', action: 'casameta.eingabeblatt',
    entityType: 'property', entityId: propertyCode,
    after: {
      jahr, luecken: ergebnis.luecken.length,
      summe_umlagefaehig: ergebnis.summe_umlagefaehig, pfad: ergebnis.pfad_md,
    },
  });
  json(res, 200, ergebnis);
}

async function handleExpenseBookings(
  req: IncomingMessage, res: ServerResponse, propertyCode: string, bookingId?: string,
) {
  const { rows: propRows } = await dbQuery('SELECT id FROM properties WHERE code = $1 AND active = true', [propertyCode]);
  if (propRows.length === 0) { err(res, 404, 'Property not found'); return; }
  const propId = propRows[0].id;
  const { query } = parseUrl(req.url || '');

  // PATCH /api/assets/properties/:code/expense-bookings/:id
  //
  // Nur die Felder, die sich nach dem Anlegen fachlich noch aendern: die
  // Umlagefaehigkeit (Einstufung nach BetrKV kann sich durch einen Beleg
  // aendern), der Leistungszeitraum und die Notiz. Betrag, Objekt und
  // Kostenart bleiben aussen vor — das waere eine andere Buchung.
  if (bookingId && req.method === 'PATCH') {
    const id = parseInt(bookingId, 10);
    if (!Number.isInteger(id) || id <= 0) { err(res, 400, 'Buchungs-ID ist ungueltig'); return; }
    const body = await parseJsonBody<any>(req);

    const { rows: vorher } = await dbQuery(
      'SELECT * FROM expense_bookings WHERE id = $1 AND property_id = $2', [id, propId]);
    if (vorher.length === 0) { err(res, 404, 'Buchung nicht gefunden'); return; }

    const felder: string[] = [];
    const werte: unknown[] = [id];
    const setze = (spalte: string, wert: unknown) => {
      werte.push(wert); felder.push(`${spalte} = $${werte.length}`);
    };
    const notizFehler = notizenVorbereiten(body, vorher[0]);
    if (notizFehler) { err(res, 400, notizFehler); return; }

    if (typeof body?.umlagefaehig === 'boolean') setze('umlagefaehig', body.umlagefaehig);
    if (typeof body?.notes === 'string') setze('notes', body.notes);
    if (typeof body?.document_path === 'string') setze('document_path', body.document_path);
    // Stilllegen statt loeschen. Eine Buchung, die durch eine Jahresrechnung
    // ersetzt wird, ist keine Kostenposition mehr — sie war eine Vorauszahlung.
    // Die Engine liest ausschliesslich archived_at IS NULL, und die Spur bleibt.
    if (typeof body?.archived === 'boolean') {
      setze('archived_at', body.archived ? new Date().toISOString() : null);
    }
    if (typeof body?.service_period_start === 'string') setze('service_period_start', body.service_period_start);
    if (typeof body?.service_period_end === 'string') setze('service_period_end', body.service_period_end);

    /* Felder, die diese Route bewusst nicht aendert, werden ausdruecklich
       abgelehnt statt stillschweigend ignoriert. Am 14.10.2026 hat ein Skript
       amount_gross mitgeschickt, eine Erfolgsmeldung bekommen und eine Notiz
       geschrieben, die eine Betragsaenderung behauptete — die nie stattfand.
       Wer den Betrag aendern will, archiviert die Buchung und legt eine neue
       an; nur so bleibt die Spur im Abrechnungsjahr nachvollziehbar. */
    const GESPERRT = ['amount_gross','amount_net','vat_amount','vat_rate',
      'property_id','cost_category_id','cost_category_code','unit_id'];
    const verwendet = GESPERRT.filter(f => body?.[f] !== undefined);
    if (verwendet.length > 0) {
      err(res, 400, `${verwendet.join(', ')} ist über diese Route nicht änderbar. `
        + 'Betrag, Objekt und Kostenart machen eine andere Buchung aus: alte Buchung '
        + 'mit archived: true stilllegen und eine neue anlegen.');
      return;
    }

    if (felder.length === 0) {
      err(res, 400, 'umlagefaehig, notes, document_path, archived, service_period_start '
        + 'oder service_period_end erforderlich');
      return;
    }

    const { rows } = await dbQuery(
      `UPDATE expense_bookings SET ${felder.join(', ')}, updated_at = now()
        WHERE id = $1 RETURNING *`, werte);

    await audit.log({
      module: 'assets', action: 'expense_booking.update',
      entityType: 'expense_booking', entityId: String(id),
      before: {
        umlagefaehig: vorher[0].umlagefaehig, notes: vorher[0].notes,
        document_path: vorher[0].document_path,
        service_period_start: vorher[0].service_period_start,
        service_period_end: vorher[0].service_period_end,
        archived_at: vorher[0].archived_at,
      },
      after: {
        umlagefaehig: rows[0].umlagefaehig, notes: rows[0].notes,
        document_path: rows[0].document_path,
        service_period_start: rows[0].service_period_start,
        service_period_end: rows[0].service_period_end,
        archived_at: rows[0].archived_at,
      },
    });

    json(res, 200, rows[0]);
    return;
  }

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
         payment_date, amount_gross, amount_net, vat_amount, vat_rate, umlagefaehig, notes,
         document_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [body.source_key || null, propId, body.unit_id || null, body.cost_category_id,
       body.vendor_name || null, body.invoice_number || null, body.invoice_date || null,
       body.service_period_start || null, body.service_period_end || null,
       body.payment_date || null, body.amount_gross, body.amount_net || null,
       body.vat_amount || null, body.vat_rate || null,
       body.umlagefaehig ?? true, body.notes || null,
       /* Belegpfad. Eine Kostenbuchung ohne Beleg ist in einer
          Nebenkostenabrechnung nicht belegbar — der Mieter hat ein
          Einsichtsrecht. Das Feld gab es in der Tabelle von Anfang an, die
          Route führte es nur nicht (ergänzt 12.10.2026). */
       body.document_path || null]
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
       /* `?? null`, nicht `|| null`: Ein Grundkostenanteil von NULL PROZENT ist
          eine gültige Angabe — genau die, die MG24 und N24 verwenden (0/100,
          alles nach Verbrauch). Mit `||` wurde die 0 zu NULL, und die
          Prüfbedingung der Tabelle (Grund + Verbrauch = 100, beide gesetzt)
          ließ den Datensatz nicht zu: Eine 0/100-Regel war über die Route
          nicht anzulegen. (12.10.2026) */
       body.base_share_percent ?? null, body.consumption_share_percent ?? null,
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

async function handleMeterReadings(req: IncomingMessage, res: ServerResponse, meterId: string, actor: string, requestId: string) {
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

      // Idempotency-Key guard — required for bulk
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      if (!idempotencyKey) {
        err(res, 400, 'Idempotency-Key header required for bulk operations', 'IDEMPOTENCY_KEY_MISSING');
        return;
      }

      // Check idempotency (replay detection + body-hash conflict)
      let idempotencyCtx: Awaited<ReturnType<typeof checkIdempotency>>;
      try {
        idempotencyCtx = await checkIdempotency(req, actor, 'meter-readings.bulk', body);
      } catch (e: any) {
        if (e.code === 'IDEMPOTENCY_BODY_MISMATCH') {
          err(res, 409, e.message, 'IDEMPOTENCY_BODY_MISMATCH');
          return;
        }
        if (e.status) { err(res, e.status, e.message, e.code); return; }
        throw e;
      }

      // Replay cached response
      if (idempotencyCtx?.isReplay && idempotencyCtx.replayResponse) {
        json(res, idempotencyCtx.replayResponse.status, idempotencyCtx.replayResponse.body);
        return;
      }

      // Sort readings by read_at ASC (copy to avoid mutating input; prevents deadlocks)
      const sortedReadings = [...body.readings].sort((a: any, b: any) => {
        const ta = new Date(a.read_at || 0).getTime();
        const tb = new Date(b.read_at || 0).getTime();
        return ta - tb;
      });

      const client = await getClient();
      try {
        await client.query('BEGIN');

        const results: any[] = [];
        for (const r of sortedReadings) {
          const { rows } = await client.query(
            `INSERT INTO meter_readings (meter_id, value, unit, reading_type, period_start, period_end,
               read_at, source, reader_name, is_estimated, estimate_method, estimate_reason, notes,
               document_path)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
            [meterId, r.value, r.unit, r.reading_type || 'annual',
             r.period_start || null, r.period_end || null,
             r.read_at || new Date().toISOString(), r.source || 'manual',
             r.reader_name || null, r.is_estimated || false,
             r.estimate_method || null, r.estimate_reason || null, r.notes || null,
             /* Belegpfad. Ein Zählerstand ohne Beleg ist nicht nachprüfbar — bei
                einem Foto oder einer Versorgerrechnung ist der Pfad die einzige
                Spur zurück zur Quelle. Die Spalte gab es von Anfang an, die
                Route führte sie nur nicht (ergänzt 13.10.2026). */
             r.document_path || null]
          );
          results.push(rows[0]);
        }

        // Audit log INSIDE transaction (before COMMIT)
        const readingIds = results.map((r: any) => r.id);
        await client.query(
          `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source, request_id)
           VALUES ($1, 'assets', 'meter_reading.bulk_create', 'meter', $2, $3, 'dashboard', $4)`,
          [actor, meterId, JSON.stringify({ count: results.length, reading_ids: readingIds }), requestId]
        );

        await client.query('COMMIT');

        const responseBody = { ok: true, created: results.length, readings: results };

        // Persist response in idempotency_keys
        if (idempotencyCtx) {
          await completeIdempotency(actor, 'meter-readings.bulk', idempotencyCtx.key, 201, responseBody);
        }

        json(res, 201, responseBody);
      } catch (e: any) {
        await client.query('ROLLBACK');
        if (idempotencyCtx) {
          await failIdempotency(actor, 'meter-readings.bulk', idempotencyCtx.key).catch(() => {});
        }
        throw e;
      } finally {
        client.release();
      }
    } else {
      const body = await parseJsonBody(req);
      if (body.value == null || !body.unit) { err(res, 400, 'value and unit required'); return; }

      const { rows } = await dbQuery(
        `INSERT INTO meter_readings (meter_id, value, unit, reading_type, period_start, period_end,
           read_at, source, reader_name, is_estimated, estimate_method, estimate_reason, notes,
           document_path)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [meterId, body.value, body.unit, body.reading_type || 'annual',
         body.period_start || null, body.period_end || null,
         body.read_at || new Date().toISOString(), body.source || 'manual',
         body.reader_name || null, body.is_estimated || false,
         body.estimate_method || null, body.estimate_reason || null, body.notes || null,
         body.document_path || null]
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
    for (const field of ['value','unit','reading_type','period_start','period_end','read_at','source','reader_name','is_estimated','estimate_method','estimate_reason','notes','document_path']) {
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

/**
 * notizenVorbereiten — entscheidet, was in die Spalte `notes` geschrieben wird.
 *
 * WARUM ES DAS GIBT. Am 13.10.2026 hat ein Skript an vier Zaehlern mehrere
 * tausend Zeichen Vorarbeit geloescht: Es las den Bestand ueber die Liste,
 * die `notes` damals gar nicht auslieferte, rechnete deshalb mit leerem Text
 * und schrieb nur den neuen Absatz zurueck. Der Fehler war nicht das Skript —
 * es war eine Schnittstelle, bei der Lesen und Schreiben nicht zusammenpassen.
 *
 * Seither gilt:
 *   - `append_notes` haengt an. Der Aufrufer muss den Bestand nicht kennen.
 *   - `notes` ersetzt und ist nur zusammen mit `replace_notes: true` erlaubt.
 *   - `notes` allein wird abgelehnt.
 *
 * Rueckgabe: ein Fehlertext, wenn der Aufruf abzulehnen ist, sonst null. Im
 * Erfolgsfall steht in `body.notes` der zu schreibende Text; beruehrt der
 * Aufruf die Notiz gar nicht, bleibt das Feld unbesetzt.
 */
/**
 * feldUebernehmen — was nicht im Aufruf steht, bleibt stehen.
 *
 * Fuer Upsert-Routen, die mit einem vollstaendigen INSERT antworten. Ohne diese
 * Regel setzt ein PUT, der nur ein Feld nachtragen will, alle uebrigen Felder
 * auf NULL. Genau das haette am 13.10.2026 den Verbrauchsschluessel 0/100 fuer
 * N24 2025 geloescht, waehrend nur das Heizsystem ergaenzt werden sollte.
 */
export function feldUebernehmen(body: any, vorher: any, feld: string, standard: unknown = null): unknown {
  if (body?.[feld] !== undefined) return body[feld];
  if (vorher && vorher[feld] !== undefined) return vorher[feld];
  return standard;
}

export function notizenVorbereiten(body: any, bestandRow: any): string | null {
  const hatAnhang = body?.append_notes !== undefined;
  const hatErsatz = body?.notes !== undefined;

  if (!hatAnhang && !hatErsatz) return null;
  if (hatAnhang && hatErsatz) {
    return 'append_notes und notes schliessen einander aus';
  }

  if (hatAnhang) {
    if (typeof body.append_notes !== 'string' || !body.append_notes.trim()) {
      return 'append_notes muss ein nicht leerer Text sein';
    }
    const bestand = String(bestandRow?.notes ?? '').trim();
    const zusatz = body.append_notes.trim();
    body.notes = bestand ? `${bestand}\n\n${zusatz}` : zusatz;
    delete body.append_notes;
    return null;
  }

  if (body.replace_notes !== true) {
    return 'notes ersetzt den vorhandenen Text vollstaendig und ist deshalb nur '
      + 'mit replace_notes: true erlaubt. Zum Anhaengen append_notes verwenden.';
  }
  delete body.replace_notes;
  return null;
}

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
    notes: row.notes ?? null,
    created_at: ts(row.created_at),
    updated_at: ts(row.updated_at),
    unit_count: row.unit_count ?? 0,
    construction_year: row.construction_year ?? null,
    primary_energy_kwh_m2: row.primary_energy_kwh_m2 ? Number(row.primary_energy_kwh_m2) : null,
    current_market_value: row.current_market_value ? Number(row.current_market_value) : null,
    monthly_rent_override: row.monthly_rent_override ? Number(row.monthly_rent_override) : null,
    monthly_rent_calculated: row.monthly_rent_calculated ? Number(row.monthly_rent_calculated) : 0,
    purchase_price_total: row.purchase_price_total ? Number(row.purchase_price_total) : null,
  };
}

function mapTenantRow(row: any) {
  const firstName = (row.first_name || '').trim();
  const lastName = (row.last_name || '').trim();
  const name = firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName || row.company_name || '';
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
    iban: row.iban || null,
    active: row.active,
    notes: row.notes ?? null,
    active_lease_count: row.active_lease_count ?? 0,
    // Display aliases for frontend
    name,
    company: row.company_name || null,
    address_street: row.street || null,
    address_postal_code: row.postal_code || null,
    address_city: row.city || null,
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
    property_name: row.property_name || row.property_code || null,
    unit_label: row.unit_label || null,
    tenant_names: row.tenant_names || null,
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
    /* Seit 12.10.2026 mit ausgeliefert. Das Feld wurde geschrieben, tauchte
       aber in keiner Antwort auf — eine gesetzte Verknüpfung war damit von
       außen nicht zu sehen. */
    contract_document_path: row.contract_document_path ?? null,
    payment_method: row.payment_method,
    vat_option: row.vat_option,
    notes: row.notes,
    created_at: ts(row.created_at),
    updated_at: ts(row.updated_at),
  };
}

/** Eine Kaution mit Objekt, Einheit und Vertragsnummer. Alle drei Antwortwege
 *  — Liste, Einzelsatz, POST und PATCH — liefern dadurch dieselben Felder. */
async function kautionMitBezug(id: unknown): Promise<any | null> {
  const { rows } = await dbQuery(
    `SELECT sd.*, l.lease_number, u.code AS unit_code, p.code AS property_code
       FROM security_deposits sd
       JOIN leases l ON l.id = sd.lease_id
       JOIN units u ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE sd.id = $1`, [id]);
  return rows[0] ?? null;
}

function mapDepositRow(row: any) {
  return {
    id: row.id,
    lease_id: row.lease_id,
    lease_number: row.lease_number ?? null,
    property_code: row.property_code ?? null,
    unit_code: row.unit_code ?? null,
    agreed_amount: num(row.agreed_amount),
    due_amount: num(row.due_amount),
    paid_amount: num(row.paid_amount),
    deposit_account: row.deposit_account,
    interest_amount: num(row.interest_amount),
    returned_at: dateStr(row.returned_at),
    deductions_amount: num(row.deductions_amount),
    status: row.status,
    payment_dates: row.payment_dates ?? null,
    notes: row.notes ?? null,
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
    notes: row.notes ?? null,
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
