/**
 * assets/store — Postgres-backed persistence for Properties, Units, Leases, NK.
 * Sprint 5: All file I/O replaced with DB pool queries.
 */
import { query as dbQuery } from '../../shared/db/index.js';
import type {
  Property, PropertyType, OwnerEntity, RentType, Unit, DistributionKey,
  Lease, CostCategory, OperatingCosts, NkResult,
} from './types.js';
import { COST_CATEGORIES } from './types.js';

// ── DB Row types (internal) ──────────────────────────────────────────────

interface PropertyRow {
  id: number; code: string; name: string;
  street: string | null; postal_code: string | null; city: string | null;
  property_type: string; notes: string | null;
  active: boolean; created_at: Date; updated_at: Date;
}

interface UnitRow {
  id: number; property_id: number; code: string; unit_type: string;
  floor: string | null; living_area_qm: string | null;
  notes: string | null; active: boolean;
  created_at: Date; updated_at: Date;
}

interface LeaseRow {
  id: number; lease_number: string | null; unit_id: number;
  lease_type: string; status: string;
  start_date: string; end_date: string | null;
  kaltmiete: string | null; nk_vorauszahlung: string | null;
  kaution: string | null;
  created_at: Date; updated_at: Date;
}

interface TenantJoinRow {
  lease_id: number; first_name: string | null; last_name: string | null;
  company_name: string | null; tenant_type: string;
}

// ── Legacy code mapping (old 9 → new 23 DB codes) ───────────────────────

const LEGACY_TO_DB: Record<string, string> = {
  abwasser: 'entwaesserung',
  muell: 'strassenreinigung_muell',
  hausmeister: 'hauswart',
  allgemeinstrom: 'beleuchtung',
};

const DB_TO_LEGACY: Record<string, string> = {
  entwaesserung: 'abwasser',
  strassenreinigung_muell: 'muell',
  hauswart: 'hausmeister',
  beleuchtung: 'allgemeinstrom',
};

// ── Internal helpers ────────────────────────────────────────────────────

function parseAddress(address: string): { street: string; postal_code: string; city: string } {
  const parts = address.split(',').map(s => s.trim());
  if (parts.length < 2) return { street: address, postal_code: '', city: '' };
  const street = parts[0];
  const rest = parts.slice(1).join(', ').trim();
  const m = rest.match(/^(\d{5})\s+(.+)$/);
  if (m) return { street, postal_code: m[1], city: m[2] };
  return { street, postal_code: '', city: rest };
}

function buildAddress(street: string | null, postalCode: string | null, city: string | null): string {
  const parts: string[] = [];
  if (street) parts.push(street);
  const loc = [postalCode, city].filter(Boolean).join(' ');
  if (loc) parts.push(loc);
  return parts.join(', ');
}

async function resolvePropertyId(code: string): Promise<number | null> {
  const { rows } = await dbQuery<{ id: number }>(
    'SELECT id FROM properties WHERE code = $1 AND active = true', [code],
  );
  return rows.length > 0 ? rows[0].id : null;
}

/** Assemble full Property from a DB property row (loads units + leases + tenants). */
async function assembleProperty(row: PropertyRow): Promise<Property> {
  const address = buildAddress(row.street, row.postal_code, row.city);

  let owner: OwnerEntity = 'personal';
  if (row.notes?.startsWith('Owner: ')) {
    owner = row.notes.replace('Owner: ', '') as OwnerEntity;
  }

  // Units
  const { rows: unitRows } = await dbQuery<UnitRow>(
    'SELECT * FROM units WHERE property_id = $1 AND active = true ORDER BY code', [row.id],
  );

  // Active leases for these units
  const unitDbIds = unitRows.map(u => u.id);
  const leaseMap = new Map<number, LeaseRow>();
  if (unitDbIds.length > 0) {
    const { rows: leaseRows } = await dbQuery<LeaseRow>(
      `SELECT * FROM leases WHERE unit_id = ANY($1) AND status IN ('active','unverified_legacy')`,
      [unitDbIds],
    );
    for (const lr of leaseRows) leaseMap.set(lr.unit_id, lr);
  }

  // Primary tenant names
  const leaseIds = Array.from(leaseMap.values()).map(l => l.id);
  const tenantMap = new Map<number, string>();
  if (leaseIds.length > 0) {
    const { rows: tRows } = await dbQuery<TenantJoinRow>(
      `SELECT lt.lease_id, t.first_name, t.last_name, t.company_name, t.tenant_type
       FROM lease_tenants lt JOIN tenants t ON lt.tenant_id = t.id
       WHERE lt.lease_id = ANY($1) AND lt.is_primary_contact = true AND lt.valid_until IS NULL`,
      [leaseIds],
    );
    for (const tr of tRows) {
      tenantMap.set(tr.lease_id,
        tr.tenant_type === 'company'
          ? (tr.company_name || '')
          : [tr.first_name, tr.last_name].filter(Boolean).join(' '));
    }
  }

  const units: Unit[] = unitRows.map(ur => {
    const lease = leaseMap.get(ur.id);
    let rentType: RentType = 'vacant';
    if (lease) rentType = lease.lease_type === 'temporary' ? 'temporary' : 'permanent';

    let label = ur.code;
    if (ur.notes?.startsWith('Label: ')) label = ur.notes.replace('Label: ', '');

    return {
      id: ur.code,
      label,
      floor: ur.floor || '',
      sqm: ur.living_area_qm ? parseFloat(ur.living_area_qm) : null,
      rentType,
      tenant: lease ? (tenantMap.get(lease.id) || '') : '',
      lease: lease ? (lease.lease_number || String(lease.id)) : null,
      currentRent: lease?.kaltmiete ? parseFloat(lease.kaltmiete) : null,
    };
  });

  return {
    id: row.code,
    label: row.name,
    address,
    type: row.property_type as PropertyType,
    owner,
    units,
    distributionKeys: [], // Sprint 6/7 — allocation_rules
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Build Lease domain object from a joined DB row. */
async function assembleLeaseFromRow(
  row: LeaseRow & { unit_code: string; prop_code: string },
): Promise<Lease> {
  let tenantName = '';
  const { rows: tRows } = await dbQuery<TenantJoinRow>(
    `SELECT lt.lease_id, t.first_name, t.last_name, t.company_name, t.tenant_type
     FROM lease_tenants lt JOIN tenants t ON lt.tenant_id = t.id
     WHERE lt.lease_id = $1 AND lt.is_primary_contact = true AND lt.valid_until IS NULL`,
    [row.id],
  );
  if (tRows.length > 0) {
    const tr = tRows[0];
    tenantName = tr.tenant_type === 'company'
      ? (tr.company_name || '')
      : [tr.first_name, tr.last_name].filter(Boolean).join(' ');
  }

  return {
    id: row.lease_number || String(row.id),
    unitId: row.unit_code,
    propertyId: row.prop_code,
    tenant: tenantName,
    startDate: String(row.start_date).slice(0, 10),
    endDate: row.end_date ? String(row.end_date).slice(0, 10) : null,
    rentNet: row.kaltmiete ? parseFloat(row.kaltmiete) : 0,
    operatingCosts: row.nk_vorauszahlung ? parseFloat(row.nk_vorauszahlung) : 0,
    depositAmount: row.kaution ? parseFloat(row.kaution) : 0,
    linkedDocs: [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Find-or-create tenant, link as primary contact on lease. */
async function upsertTenantForLease(leaseId: number, tenantName: string, startDate: string): Promise<void> {
  const nameParts = tenantName.trim().split(/\s+/);
  const lastName = nameParts.pop() || tenantName;
  const firstName = nameParts.join(' ') || null;

  let { rows } = await dbQuery<{ id: number }>(
    `SELECT id FROM tenants
     WHERE last_name = $1 AND (first_name = $2 OR ($2 IS NULL AND first_name IS NULL))
     AND active = true LIMIT 1`,
    [lastName, firstName],
  );

  let tenantId: number;
  if (rows.length > 0) {
    tenantId = rows[0].id;
  } else {
    const res = await dbQuery<{ id: number }>(
      `INSERT INTO tenants (tenant_type, first_name, last_name) VALUES ('person', $1, $2) RETURNING id`,
      [firstName, lastName],
    );
    tenantId = res.rows[0].id;
  }

  await dbQuery(
    `INSERT INTO lease_tenants (lease_id, tenant_id, role, is_primary_contact, valid_from)
     VALUES ($1, $2, 'contract_party', true, $3)
     ON CONFLICT (lease_id) WHERE is_primary_contact = true AND valid_until IS NULL
     DO UPDATE SET tenant_id = EXCLUDED.tenant_id`,
    [leaseId, tenantId, startDate],
  );
}

// ── Properties CRUD ────────────────────────────────────────────────────────

export async function listProperties(): Promise<Property[]> {
  const { rows } = await dbQuery<PropertyRow>(
    'SELECT * FROM properties WHERE active = true ORDER BY code',
  );
  return Promise.all(rows.map(assembleProperty));
}

export async function getProperty(code: string): Promise<Property | null> {
  const { rows } = await dbQuery<PropertyRow>(
    'SELECT * FROM properties WHERE code = $1 AND active = true', [code],
  );
  if (rows.length === 0) return null;
  return assembleProperty(rows[0]);
}

export async function createProperty(
  code: string, label: string, address: string,
  type: PropertyType, owner: OwnerEntity,
  units?: Unit[], _distributionKeys?: DistributionKey[],
): Promise<Property> {
  const addr = parseAddress(address);
  const notes = owner !== 'personal' ? `Owner: ${owner}` : null;

  const { rows } = await dbQuery<PropertyRow>(
    `INSERT INTO properties (code, name, street, postal_code, city, property_type, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [code, label, addr.street, addr.postal_code, addr.city, type, notes],
  );
  if (rows.length === 0) throw new Error(`Property ${code} konnte nicht erstellt werden`);

  if (units && units.length > 0) {
    for (const u of units) {
      await dbQuery(
        `INSERT INTO units (property_id, code, unit_type, floor, living_area_qm, notes)
         VALUES ($1, $2, 'apartment', $3, $4, $5)`,
        [rows[0].id, u.id, u.floor, u.sqm, u.label !== u.id ? `Label: ${u.label}` : null],
      );
    }
  }

  return assembleProperty(rows[0]);
}

export async function updateProperty(
  code: string, patch: Partial<Omit<Property, 'id' | 'createdAt'>>,
): Promise<Property | null> {
  const propId = await resolvePropertyId(code);
  if (propId === null) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  if (patch.label !== undefined) { sets.push(`name = $${pi++}`); params.push(patch.label); }
  if (patch.address !== undefined) {
    const a = parseAddress(patch.address);
    sets.push(`street = $${pi++}`); params.push(a.street);
    sets.push(`postal_code = $${pi++}`); params.push(a.postal_code);
    sets.push(`city = $${pi++}`); params.push(a.city);
  }
  if (patch.type !== undefined) { sets.push(`property_type = $${pi++}`); params.push(patch.type); }
  if (patch.owner !== undefined) {
    sets.push(`notes = $${pi++}`);
    params.push(patch.owner !== 'personal' ? `Owner: ${patch.owner}` : null);
  }

  if (sets.length > 0) {
    params.push(propId);
    await dbQuery(`UPDATE properties SET ${sets.join(', ')} WHERE id = $${pi}`, params);
  }

  return getProperty(code);
}

export async function deleteProperty(code: string): Promise<boolean> {
  const { rowCount } = await dbQuery(
    'UPDATE properties SET active = false WHERE code = $1 AND active = true', [code],
  );
  return (rowCount ?? 0) > 0;
}

// ── Units CRUD ─────────────────────────────────────────────────────────────

export async function addUnit(propertyCode: string, unit: Unit): Promise<Property | null> {
  const propId = await resolvePropertyId(propertyCode);
  if (propId === null) return null;

  await dbQuery(
    `INSERT INTO units (property_id, code, unit_type, floor, living_area_qm, notes)
     VALUES ($1, $2, 'apartment', $3, $4, $5)`,
    [propId, unit.id, unit.floor, unit.sqm,
     unit.label !== unit.id ? `Label: ${unit.label}` : null],
  );

  return getProperty(propertyCode);
}

export async function updateUnit(
  propertyCode: string, unitCode: string, patch: Partial<Omit<Unit, 'id'>>,
): Promise<Property | null> {
  const propId = await resolvePropertyId(propertyCode);
  if (propId === null) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  if (patch.floor !== undefined) { sets.push(`floor = $${pi++}`); params.push(patch.floor); }
  if (patch.sqm !== undefined) { sets.push(`living_area_qm = $${pi++}`); params.push(patch.sqm); }
  if (patch.label !== undefined) {
    sets.push(`notes = $${pi++}`);
    params.push(patch.label !== unitCode ? `Label: ${patch.label}` : null);
  }

  if (sets.length > 0) {
    params.push(propId, unitCode);
    await dbQuery(
      `UPDATE units SET ${sets.join(', ')} WHERE property_id = $${pi++} AND code = $${pi}`,
      params,
    );
  }

  return getProperty(propertyCode);
}

export async function removeUnit(propertyCode: string, unitCode: string): Promise<Property | null> {
  const propId = await resolvePropertyId(propertyCode);
  if (propId === null) return null;

  await dbQuery(
    'UPDATE units SET active = false WHERE property_id = $1 AND code = $2',
    [propId, unitCode],
  );

  return getProperty(propertyCode);
}

// ── Distribution Keys (Sprint 6/7 — not in DB yet) ─────────────────────

export async function setDistributionKey(
  _propertyCode: string, _key: DistributionKey,
): Promise<Property | null> {
  throw new Error('Verteilungsschlüssel sind ab Sprint 6 in der Datenbank verfügbar.');
}

export async function removeDistributionKey(
  _propertyCode: string, _keyId: string,
): Promise<Property | null> {
  throw new Error('Verteilungsschlüssel sind ab Sprint 6 in der Datenbank verfügbar.');
}

// ── Leases CRUD ────────────────────────────────────────────────────────────

const LEASE_JOIN_SQL = `SELECT l.*, u.code AS unit_code, p.code AS prop_code
  FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id`;

export async function listLeases(propertyCode?: string): Promise<Lease[]> {
  if (propertyCode) {
    const propId = await resolvePropertyId(propertyCode);
    if (propId === null) return [];
    const { rows } = await dbQuery<LeaseRow & { unit_code: string; prop_code: string }>(
      `${LEASE_JOIN_SQL} WHERE u.property_id = $1 ORDER BY l.start_date`, [propId],
    );
    return Promise.all(rows.map(assembleLeaseFromRow));
  }

  const { rows } = await dbQuery<LeaseRow & { unit_code: string; prop_code: string }>(
    `${LEASE_JOIN_SQL} ORDER BY l.start_date`,
  );
  return Promise.all(rows.map(assembleLeaseFromRow));
}

export async function getLease(id: string): Promise<Lease | null> {
  const { rows } = await dbQuery<LeaseRow & { unit_code: string; prop_code: string }>(
    `${LEASE_JOIN_SQL} WHERE l.lease_number = $1 OR l.id::text = $1`, [id],
  );
  if (rows.length === 0) return null;
  return assembleLeaseFromRow(rows[0]);
}

export async function getLeaseByUnit(unitCode: string): Promise<Lease | null> {
  const { rows } = await dbQuery<LeaseRow & { unit_code: string; prop_code: string }>(
    `${LEASE_JOIN_SQL} WHERE u.code = $1 AND l.status IN ('active','unverified_legacy')
     ORDER BY l.start_date DESC LIMIT 1`,
    [unitCode],
  );
  if (rows.length === 0) return null;
  return assembleLeaseFromRow(rows[0]);
}

export async function setLease(
  propertyCode: string, unitCode: string,
  data: Omit<Lease, 'id' | 'unitId' | 'propertyId' | 'createdAt' | 'updatedAt'>,
): Promise<Lease> {
  // Resolve unit
  const { rows: unitRows } = await dbQuery<{ id: number; property_id: number }>(
    `SELECT u.id, u.property_id FROM units u
     JOIN properties p ON u.property_id = p.id
     WHERE u.code = $1 AND u.active = true AND p.active = true`,
    [unitCode],
  );
  if (unitRows.length === 0) throw new Error(`Einheit "${unitCode}" nicht gefunden`);
  const unitDbId = unitRows[0].id;

  // Check for existing active lease
  const { rows: existing } = await dbQuery<{ id: number }>(
    `SELECT id FROM leases WHERE unit_id = $1 AND status IN ('active','unverified_legacy')`,
    [unitDbId],
  );

  let leaseDbId: number;

  if (existing.length > 0) {
    leaseDbId = existing[0].id;
    await dbQuery(
      `UPDATE leases SET kaltmiete = $1, nk_vorauszahlung = $2, kaution = $3,
       start_date = $4, end_date = $5, status = 'active' WHERE id = $6`,
      [data.rentNet, data.operatingCosts, data.depositAmount,
       data.startDate, data.endDate || null, leaseDbId],
    );
  } else {
    const leaseNumber = `lease-${propertyCode}-${unitCode}`;
    const { rows: newRows } = await dbQuery<{ id: number }>(
      `INSERT INTO leases (lease_number, unit_id, lease_type, status, start_date, end_date,
       kaltmiete, nk_vorauszahlung, kaution, billing_mode)
       VALUES ($1, $2, 'residential', 'active', $3, $4, $5, $6, $7, 'vorauszahlung')
       RETURNING id`,
      [leaseNumber, unitDbId, data.startDate, data.endDate || null,
       data.rentNet, data.operatingCosts, data.depositAmount],
    );
    leaseDbId = newRows[0].id;
  }

  if (data.tenant) {
    await upsertTenantForLease(leaseDbId, data.tenant, data.startDate);
  }

  return (await getLease(String(leaseDbId)))!;
}

export async function deleteLease(id: string): Promise<boolean> {
  const { rowCount } = await dbQuery(
    `UPDATE leases SET status = 'ended' WHERE lease_number = $1 OR id::text = $1`, [id],
  );
  return (rowCount ?? 0) > 0;
}

// ── Operating Costs ────────────────────────────────────────────────────────

export async function getOperatingCosts(
  propertyCode: string, year: number,
): Promise<OperatingCosts | null> {
  const propId = await resolvePropertyId(propertyCode);
  if (propId === null) return null;

  const { rows } = await dbQuery<{ code: string; total: string; max_updated: Date }>(
    `SELECT cc.code, SUM(eb.amount_gross)::text AS total, MAX(eb.updated_at) AS max_updated
     FROM expense_bookings eb
     JOIN cost_categories cc ON eb.cost_category_id = cc.id
     WHERE eb.property_id = $1
       AND eb.service_period_start >= $2 AND eb.service_period_end <= $3
     GROUP BY cc.code`,
    [propId, `${year}-01-01`, `${year}-12-31`],
  );

  if (rows.length === 0) return null;

  const costs: Partial<Record<CostCategory, number>> = {};
  let maxUpdated = new Date(0);
  for (const r of rows) {
    const legacyCode = DB_TO_LEGACY[r.code] || r.code;
    costs[legacyCode as CostCategory] = parseFloat(r.total);
    const d = new Date(r.max_updated);
    if (d > maxUpdated) maxUpdated = d;
  }

  return {
    propertyId: propertyCode,
    year,
    distributionKeyId: '',
    costs,
    updatedAt: maxUpdated.toISOString(),
  };
}

export async function setOperatingCosts(
  propertyCode: string, year: number,
  costs: Partial<Record<CostCategory, number>>,
  _distributionKeyId: string,
): Promise<OperatingCosts> {
  const propId = await resolvePropertyId(propertyCode);
  if (propId === null) throw new Error(`Gebäude "${propertyCode}" nicht gefunden`);

  const periodStart = `${year}-01-01`;
  const periodEnd = `${year}-12-31`;

  for (const [category, amount] of Object.entries(costs)) {
    if (amount == null || amount <= 0) continue;
    const dbCode = LEGACY_TO_DB[category] || category;
    const sourceKey = `${propertyCode}-${year}-${dbCode}`;

    await dbQuery(
      `INSERT INTO expense_bookings (source_key, property_id, cost_category_id,
       amount_gross, umlagefaehig, service_period_start, service_period_end, notes)
       SELECT $1, $2, cc.id, $3, cc.umlagefaehig_default, $4, $5, $6
       FROM cost_categories cc WHERE cc.code = $7
       ON CONFLICT (source_key) WHERE source_key IS NOT NULL
       DO UPDATE SET amount_gross = EXCLUDED.amount_gross`,
      [sourceKey, propId, amount, periodStart, periodEnd,
       `Telegram /costs ${propertyCode} ${year}`, dbCode],
    );
  }

  return (await getOperatingCosts(propertyCode, year))!;
}

// ── Nebenkostenabrechnung ──────────────────────────────────────────────────

export async function calculateNk(propertyCode: string, year: number): Promise<NkResult[]> {
  const prop = await getProperty(propertyCode);
  if (!prop) throw new Error(`Gebäude ${propertyCode} nicht gefunden`);

  const oc = await getOperatingCosts(propertyCode, year);
  if (!oc) throw new Error(`Keine Nebenkosten für ${propertyCode} / ${year}`);

  const activeUnits = prop.units.filter(u => u.rentType !== 'vacant');
  if (activeUnits.length === 0) return [];

  // Equal split fallback (distribution keys are Sprint 6/7)
  const share = 100 / activeUnits.length;
  const totalCosts = Object.values(oc.costs).reduce((s, v) => s + (v || 0), 0);

  const results: NkResult[] = [];

  for (const unit of activeUnits) {
    const unitCost = totalCosts * (share / 100);
    const lease = await getLeaseByUnit(unit.id);
    const prepaid = (lease?.operatingCosts || 0) * 12;
    const balance = prepaid - unitCost;

    const details = Object.entries(oc.costs)
      .filter(([, v]) => v && v > 0)
      .map(([cat, amount]) => ({
        category: COST_CATEGORIES.find(c => c.key === cat)?.label || cat,
        amount: Math.round((amount! * share / 100) * 100) / 100,
      }));

    results.push({
      unitId: unit.id,
      unitLabel: unit.label,
      tenant: unit.tenant || '–',
      share: Math.round(share * 100) / 100,
      totalCost: Math.round(unitCost * 100) / 100,
      prepaid: Math.round(prepaid * 100) / 100,
      balance: Math.round(balance * 100) / 100,
      details,
    });
  }

  return results;
}

// ── Formatting (Telegram) — sync, operates on in-memory data ────────────

function fmtEur(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

export function formatPropertyList(props: Property[]): string {
  if (!props.length) return '🏠 Keine Gebäude vorhanden.';

  const lines = props.map(p => {
    const icon = p.type === 'residential' ? '🏠' : '🏭';
    const owner = p.owner === 'personal' ? 'Privat' : 'Laperl GmbH';
    const occupied = p.units.filter(u => u.rentType !== 'vacant').length;
    return `${icon} **${p.label}** (${p.id})\n   ${p.address}\n   ${p.units.length} Einheiten (${occupied} vermietet) · ${owner}`;
  });

  return `🏠 Immobilien (${props.length}):\n\n${lines.join('\n\n')}`;
}

export function formatPropertyDetail(p: Property): string {
  const icon = p.type === 'residential' ? '🏠' : '🏭';
  const owner = p.owner === 'personal' ? 'Privat' : 'Laperl GmbH';
  const lines: string[] = [
    `${icon} **${p.label}**`,
    `Adresse: ${p.address}`,
    `Typ: ${p.type === 'residential' ? 'Wohngebäude' : 'Gewerbe'}`,
    `Eigentümer: ${owner}`,
    '',
  ];

  if (p.units.length) {
    lines.push(`📋 Einheiten (${p.units.length}):`);
    for (const u of p.units) {
      const rent = u.currentRent != null ? fmtEur(u.currentRent) : '–';
      const sqm = u.sqm != null ? `${u.sqm} m²` : '–';
      const status = u.rentType === 'permanent' ? '✅ dauerhaft' : u.rentType === 'temporary' ? '🔄 temporär' : '⬜ leer';
      lines.push(`   • ${u.label} (${u.id}) | ${u.floor} | ${sqm} | ${status} | ${rent}`);
      if (u.tenant) lines.push(`     Mieter: ${u.tenant}`);
    }
  }

  if (p.distributionKeys.length) {
    lines.push('');
    lines.push('📊 Verteilungsschlüssel:');
    for (const dk of p.distributionKeys) {
      const parts = Object.entries(dk.values).map(([uid, pct]) => `${uid}: ${pct}%`).join(', ');
      lines.push(`   • ${dk.label}: ${parts}`);
    }
  }

  lines.push('');
  lines.push(`ID: \`${p.id}\``);
  return lines.join('\n');
}

export function formatRentOverview(p: Property): string {
  const lines: string[] = [`💰 Mieteinnahmen **${p.label}** (${p.id}):\n`];
  let totalRent = 0;

  for (const u of p.units) {
    const rent = u.currentRent || 0;
    totalRent += rent;
    const status = u.rentType === 'vacant' ? '⬜ leer' : u.tenant || '–';
    lines.push(`   ${u.label}: ${rent > 0 ? fmtEur(rent) : '–'} | ${status}`);
  }

  lines.push('');
  lines.push(`   **Gesamt: ${fmtEur(totalRent)} / Monat** (${fmtEur(totalRent * 12)} / Jahr)`);
  return lines.join('\n');
}

export function formatNkResult(propertyId: string, year: number, results: NkResult[]): string {
  const lines: string[] = [`📊 Nebenkostenabrechnung ${propertyId} / ${year}:\n`];

  for (const r of results) {
    const balSign = r.balance >= 0 ? '✅ Guthaben' : '❌ Nachzahlung';
    lines.push(`🏠 ${r.unitLabel} (${r.tenant})`);
    lines.push(`   Anteil: ${r.share}% | Kosten: ${fmtEur(r.totalCost)}`);
    lines.push(`   Vorauszahlung: ${fmtEur(r.prepaid)}`);
    lines.push(`   **${balSign}: ${fmtEur(Math.abs(r.balance))}**`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Seed (no-op — data comes from migration script) ─────────────────────

export async function seedInitialData(): Promise<{ created: number }> {
  return { created: 0 };
}
