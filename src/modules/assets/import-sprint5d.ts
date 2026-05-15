#!/usr/bin/env bun
/**
 * Sprint 5d.2/5d.3 — Asset Data Import Pipeline
 *
 * Standalone CLI:
 *   bun run src/modules/assets/import-sprint5d.ts [--dry-run]           # Standard dry-run (default)
 *   bun run src/modules/assets/import-sprint5d.ts --dry-run-verbose     # Field-by-field diff for UPDATEs
 *   bun run src/modules/assets/import-sprint5d.ts --apply               # Live-apply with transaction safety
 *
 * Pipeline: JSON lesen → Rows parsen → Typ-Coercion → Validierung → Idempotenz-Check → Apply/DRY-RUN Output
 *
 * No store.ts imports — standalone script with own pg pool.
 */

import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Constants ─────────────────────────────────────────────────────────────────

const DATA_FILE = join(homedir(), 'sprint-5d-data.json');
const EXPECTED_SHEETS = ['Properties', 'Units', 'Tenants', 'Leases', 'Lease_Tenants'];

const VALID_PROPERTY_TYPES = new Set(['residential', 'commercial', 'mixed', 'industrial']);
const VALID_HEATING_TYPES = new Set(['gas', 'oil', 'heat_pump', 'district', 'electric', 'none', 'pellets']);
const VALID_UNIT_TYPES = new Set(['apartment', 'garage', 'storage', 'office', 'retail', 'industrial_hall']);
const VALID_LEASE_TYPES = new Set(['residential', 'temporary', 'commercial', 'garage', 'storage']);

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParsedProperty {
  _excel_row: number;
  code: string | null;
  name: string | null;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  property_type: string | null;
  ownership_start: string | null;
  acquisition_date: string | null;
  purchase_price_total: number | null;
  building_value: number | null;
  land_value: number | null;
  afa_rate: number | null;
  total_living_area_qm: number | null;
  total_commercial_area_qm: number | null;
  billing_period_start_month: number | null;
  heating_type: string | null;
  co2_cost_relevant: boolean;
  notes: string | null;
  legal_owner: string | null;
}

interface ParsedUnit {
  _excel_row: number;
  property_code: string | null;
  code: string | null;
  unit_type: string | null;
  floor: string | null;
  living_area_qm: number | null;
  usable_area_qm: number | null;
  allocation_area_qm: number | null;
  rooms: number | null;
  has_balcony: boolean;
  has_heating: boolean;
  vacant_from: string | null;
  vacant_until: string | null;
  notes: string | null;
}

interface ParsedTenant {
  _excel_row: number;
  tenant_code: string | null;
  tenant_type: string | null;
  first_name: string | null;
  last_name: string | null;
  birth_date: string | null;
  company_name: string | null;
  contact_person: string | null;
  ust_id: string | null;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  iban: string | null;
  bic: string | null;
  bank: string | null;
  debitor_no: string | null;
  sepa_mandate_reference: string | null;
  sepa_mandate_signed_at: string | null;
  correspondence_address: string | null;
  notes: string | null;
}

interface ParsedLease {
  _excel_row: number;
  lease_number: string | null;
  property_code: string | null;
  unit_code: string | null;
  lease_type: string | null;
  status: string | null;
  signed_at: string | null;
  start_date: string | null;
  handover_at: string | null;
  end_date: string | null;
  termination_date: string | null;
  termination_reason: string | null;
  actual_move_out: string | null;
  billing_mode: string | null;
  kaltmiete: number | null;
  nk_vorauszahlung: number | null;
  garage_amount: number | null;
  kitchen_amount: number | null;
  heizkosten_vorauszahlung: number | null;
  kaution: number | null;
  payment_method: string | null;
  rent_due_day: number | null;
  vat_option: boolean;
  vat_rate: number | null;
  contract_document_path: string | null;
  notes: string | null;
}

interface ParsedLeaseTenant {
  _excel_row: number;
  lease_number: string | null;
  tenant_code: string | null;
  role: string | null;
  is_primary_contact: boolean;
  valid_from: string | null;
  valid_until: string | null;
  notes: string | null;
}

interface ValidationError {
  table: string;
  row: number;
  field: string;
  message: string;
}

// ── Env Helper ────────────────────────────────────────────────────────────────

function loadEnv(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error('POSTGRES_URL not set and ~/.config/openclaw/env not found');
  const content = readFileSync(envFile, 'utf-8');
  const match = content.match(/^POSTGRES_URL=(.+)$/m);
  if (!match) throw new Error('POSTGRES_URL not found in env file');
  return match[1];
}

// ── Coercion Functions ────────────────────────────────────────────────────────

function coerceBool(v: unknown): boolean {
  if (typeof v === 'string') return v.toUpperCase() === 'TRUE';
  if (typeof v === 'boolean') return v;
  return false;
}

function coerceString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function coerceDate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function coerceNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return isNaN(n) ? null : n;
}

function coercePLZ(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

function coercePhone(v: unknown): string | null {
  if (v == null) return null;
  return '+' + String(v);
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseProperties(rows: Record<string, unknown>[]): ParsedProperty[] {
  return rows.map(r => ({
    _excel_row: r._excel_row as number,
    code: coerceString(r['Property-Code (l19/mg24/d4/n24)'])?.toLowerCase() ?? null,
    name: coerceString(r['Name']),
    street: coerceString(r['Straße + Nr.']),
    postal_code: coercePLZ(r['PLZ']),
    city: coerceString(r['Stadt']),
    property_type: coerceString(r['Art (residential/commercial/mixed/industrial)'])?.toLowerCase() ?? null,
    ownership_start: coerceDate(r['Eigentum ab (Datum)']),
    acquisition_date: coerceDate(r['Kaufdatum']),
    purchase_price_total: coerceNumber(r['Kaufpreis gesamt (€)']),
    building_value: coerceNumber(r['Gebäudewert (€)']),
    land_value: coerceNumber(r['Grundstückswert (€)']),
    afa_rate: coerceNumber(r['AfA-Satz (z.B. 0.02 = 2%)']),
    total_living_area_qm: coerceNumber(r['Wohnfläche gesamt (m²)']),
    total_commercial_area_qm: coerceNumber(r['Gewerbefläche gesamt (m²)']),
    billing_period_start_month: coerceNumber(r['NK-Abrechnungsbeginn (Monat 1-12)']),
    heating_type: coerceString(r['Heizung (gas/oil/heat_pump/district/electric/none)'])?.toLowerCase() ?? null,
    co2_cost_relevant: coerceBool(r['CO2-Kosten relevant (TRUE/FALSE)']),
    notes: coerceString(r['Notizen']),
    legal_owner: coerceString(r['legal owner']),
  }));
}

function parseUnits(rows: Record<string, unknown>[]): ParsedUnit[] {
  return rows.map(r => ({
    _excel_row: r._excel_row as number,
    property_code: coerceString(r['Property-Code (l19/mg24/d4/n24)'])?.toLowerCase() ?? null,
    code: coerceString(r['Unit-Code (z.B. W1, W2, EG, Halle1)']),
    unit_type: coerceString(r['Art'])?.toLowerCase() ?? null,
    floor: coerceString(r['Stockwerk (EG/1.OG/2.OG/...)']),
    living_area_qm: coerceNumber(r['Wohnfläche (m²)']),
    usable_area_qm: coerceNumber(r['Nutzfläche (m²)']),
    allocation_area_qm: coerceNumber(r['Umlagefläche (m²) - meist = Wohnfläche']),
    rooms: coerceNumber(r['Zimmer (z.B. 2.5)']),
    has_balcony: coerceBool(r['Balkon (TRUE/FALSE)']),
    has_heating: coerceBool(r['Beheizt (TRUE/FALSE)']),
    vacant_from: coerceDate(r['Leerstand ab']),
    vacant_until: coerceDate(r['Leerstand bis']),
    notes: coerceString(r['Notizen']),
  }));
}

function parseTenants(rows: Record<string, unknown>[]): { parsed: ParsedTenant[]; skipped: { row: number; reason: string }[] } {
  const parsed: ParsedTenant[] = [];
  const skipped: { row: number; reason: string }[] = [];

  for (const r of rows) {
    const tenantCode = coerceString(r['Tenant-Code (sprechend, eindeutig)']);
    if (tenantCode === null) {
      skipped.push({ row: r._excel_row as number, reason: 'empty row' });
      continue;
    }
    parsed.push({
      _excel_row: r._excel_row as number,
      tenant_code: tenantCode,
      tenant_type: coerceString(r['Typ (person/company)'])?.toLowerCase() ?? null,
      first_name: coerceString(r['Vorname (person)']),
      last_name: coerceString(r['Nachname (person)']),
      birth_date: coerceDate(r['Geburtsdatum']),
      company_name: coerceString(r['Firmenname (company)']),
      contact_person: coerceString(r['Ansprechpartner Firma']),
      ust_id: coerceString(r['USt-IdNr. (Firma)']),
      street: coerceString(r['Straße + Nr.']),
      postal_code: coercePLZ(r['PLZ']),
      city: coerceString(r['Stadt']),
      phone: coercePhone(r['Telefon']),
      email: coerceString(r['E-Mail'])?.toLowerCase() ?? null,
      iban: coerceString(r['IBAN']),
      bic: coerceString(r['BIC']),
      bank: coerceString(r['Bank']),
      debitor_no: coerceString(r['Debitor-Nr.']),
      sepa_mandate_reference: coerceString(r['SEPA-Mandatsreferenz']),
      sepa_mandate_signed_at: coerceDate(r['SEPA-Mandat unterschrieben am']),
      correspondence_address: coerceString(r['Postanschrift (falls abweichend)']),
      notes: coerceString(r['Notizen']),
    });
  }

  return { parsed, skipped };
}

function parseLeases(rows: Record<string, unknown>[]): ParsedLease[] {
  return rows.map(r => ({
    _excel_row: r._excel_row as number,
    lease_number: coerceString(r['Vertragsnummer (sprechend)']),
    property_code: coerceString(r['Property-Code'])?.toLowerCase() ?? null,
    unit_code: coerceString(r['Unit-Code']),
    lease_type: coerceString(r['Vertragsart'])?.toLowerCase() ?? null,
    status: coerceString(r['Status'])?.toLowerCase() ?? null,
    signed_at: coerceDate(r['Unterschrieben am']),
    start_date: coerceDate(r['Mietbeginn']),
    handover_at: coerceDate(r['Übergabe am']),
    end_date: coerceDate(r['Mietende (befristet)']),
    termination_date: coerceDate(r['Kündigung am']),
    termination_reason: coerceString(r['Kündigungsgrund']),
    actual_move_out: coerceDate(r['Auszug tatsächlich']),
    billing_mode: coerceString(r['NK-Modus (vorauszahlung/pauschale/inklusive)'])?.toLowerCase() ?? null,
    kaltmiete: coerceNumber(r['Kaltmiete (€)']),
    nk_vorauszahlung: coerceNumber(r['NK-Vorauszahlung (€)']),
    garage_amount: coerceNumber(r['Garage']),
    kitchen_amount: coerceNumber(r['Küche']),
    heizkosten_vorauszahlung: coerceNumber(r['Heizkosten-Vorauszahlung (€)']),
    kaution: coerceNumber(r['Kaution (€)']),
    payment_method: coerceString(r['Zahlungsweise'])?.toLowerCase() ?? null,
    rent_due_day: coerceNumber(r['Fälligkeitstag (1-31)']),
    vat_option: coerceBool(r['USt-Option (TRUE/FALSE)']),
    vat_rate: coerceNumber(r['USt-Satz (z.B. 19.00)']),
    contract_document_path: coerceString(r['Pfad zum Vertrags-PDF']),
    notes: coerceString(r['Notizen']),
  }));
}

function parseLeaseTenants(rows: Record<string, unknown>[]): ParsedLeaseTenant[] {
  return rows.map(r => ({
    _excel_row: r._excel_row as number,
    lease_number: coerceString(r['Vertragsnummer (aus Leases-Sheet)']),
    tenant_code: coerceString(r['Tenant-Code (aus Tenants-Sheet)']),
    role: coerceString(r['Rolle (contract_party/occupant/guarantor)'])?.toLowerCase() ?? null,
    is_primary_contact: coerceBool(r['Hauptansprechpartner (TRUE/FALSE)']),
    valid_from: coerceDate(r['Gültig ab']),
    valid_until: coerceDate(r['Gültig bis (leer wenn aktiv)']),
    notes: coerceString(r['Notizen']),
  }));
}

// ── Validators ────────────────────────────────────────────────────────────────

function validateProperties(props: ParsedProperty[]): Map<number, ValidationError[]> {
  const errors = new Map<number, ValidationError[]>();
  for (const p of props) {
    const errs: ValidationError[] = [];
    // Rule 1: code NOT NULL + not empty
    if (!p.code) {
      errs.push({ table: 'properties', row: p._excel_row, field: 'code', message: 'code is required' });
    }
    // Rule 2: property_type IN valid set
    if (p.property_type && !VALID_PROPERTY_TYPES.has(p.property_type)) {
      errs.push({ table: 'properties', row: p._excel_row, field: 'property_type', message: `invalid property_type: ${p.property_type}` });
    }
    // Rule 3: heating_type IS NULL OR IN valid set
    if (p.heating_type && !VALID_HEATING_TYPES.has(p.heating_type)) {
      errs.push({ table: 'properties', row: p._excel_row, field: 'heating_type', message: `invalid heating_type: ${p.heating_type}` });
    }
    if (errs.length > 0) errors.set(p._excel_row, errs);
  }
  return errors;
}

function validateUnits(units: ParsedUnit[], propertyCodes: Set<string>): Map<number, ValidationError[]> {
  const errors = new Map<number, ValidationError[]>();
  for (const u of units) {
    const errs: ValidationError[] = [];
    // Rule 4: property_code exists in Properties array
    if (!u.property_code || !propertyCodes.has(u.property_code)) {
      errs.push({ table: 'units', row: u._excel_row, field: 'property_code', message: `unknown property: ${u.property_code}` });
    }
    // Rule 5: unit_type IN valid set
    if (u.unit_type && !VALID_UNIT_TYPES.has(u.unit_type)) {
      errs.push({ table: 'units', row: u._excel_row, field: 'unit_type', message: `invalid unit_type: ${u.unit_type}` });
    }
    if (errs.length > 0) errors.set(u._excel_row, errs);
  }
  return errors;
}

function validateTenants(tenants: ParsedTenant[]): Map<number, ValidationError[]> {
  const errors = new Map<number, ValidationError[]>();
  for (const t of tenants) {
    const errs: ValidationError[] = [];
    // Rule 6: tenant_code NOT NULL (already filtered by parser, but double-check)
    if (!t.tenant_code) {
      errs.push({ table: 'tenants', row: t._excel_row, field: 'tenant_code', message: 'tenant_code is required' });
    }
    // Rule 7: person → last_name NOT NULL; company → company_name NOT NULL
    if (t.tenant_type === 'person' && !t.last_name) {
      errs.push({ table: 'tenants', row: t._excel_row, field: 'last_name', message: 'last_name required for person' });
    }
    if (t.tenant_type === 'company' && !t.company_name) {
      errs.push({ table: 'tenants', row: t._excel_row, field: 'company_name', message: 'company_name required for company' });
    }
    if (errs.length > 0) errors.set(t._excel_row, errs);
  }
  return errors;
}

function validateLeases(leases: ParsedLease[]): Map<number, ValidationError[]> {
  const errors = new Map<number, ValidationError[]>();
  for (const l of leases) {
    const errs: ValidationError[] = [];
    // Rule 8: lease_number NOT NULL + not empty
    if (!l.lease_number) {
      errs.push({ table: 'leases', row: l._excel_row, field: 'lease_number', message: 'lease_number is required' });
    }
    // Rule 9: start_date NOT NULL
    if (!l.start_date) {
      errs.push({ table: 'leases', row: l._excel_row, field: 'start_date', message: 'start_date is required' });
    }
    // Rule 10: vat_option=true → vat_rate NOT NULL; vat_option=false → vat_rate IS NULL
    if (l.vat_option && l.vat_rate == null) {
      errs.push({ table: 'leases', row: l._excel_row, field: 'vat_rate', message: 'vat_rate required when vat_option=true' });
    }
    if (!l.vat_option && l.vat_rate != null) {
      errs.push({ table: 'leases', row: l._excel_row, field: 'vat_rate', message: 'vat_rate must be null when vat_option=false' });
    }
    // Rule 11: lease_type IN valid set
    if (l.lease_type && !VALID_LEASE_TYPES.has(l.lease_type)) {
      errs.push({ table: 'leases', row: l._excel_row, field: 'lease_type', message: `invalid lease_type: ${l.lease_type}` });
    }
    if (errs.length > 0) errors.set(l._excel_row, errs);
  }
  return errors;
}

function validateLeaseTenants(lts: ParsedLeaseTenant[]): Map<number, ValidationError[]> {
  const errors = new Map<number, ValidationError[]>();
  for (const lt of lts) {
    const errs: ValidationError[] = [];
    // Rule 12: valid_from NOT NULL
    if (!lt.valid_from) {
      errs.push({ table: 'lease_tenants', row: lt._excel_row, field: 'valid_from', message: 'valid_from is required' });
    }
    if (errs.length > 0) errors.set(lt._excel_row, errs);
  }
  return errors;
}

// ── Idempotency Checks (SELECT-only) ─────────────────────────────────────────

async function checkPropertyExists(pool: pg.Pool, code: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: number }>(
    'SELECT id FROM properties WHERE code = $1', [code]
  );
  return rows.length > 0;
}

async function checkUnitExists(pool: pg.Pool, propertyCode: string, unitCode: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT u.id FROM units u JOIN properties p ON u.property_id = p.id
     WHERE p.code = $1 AND LOWER(u.code) = LOWER($2)`,
    [propertyCode, unitCode]
  );
  return rows.length > 0;
}

async function checkTenantExists(pool: pg.Pool, tenantCode: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: number }>(
    'SELECT id FROM tenants WHERE tenant_code = $1', [tenantCode]
  );
  return rows.length > 0;
}

async function checkLeaseExists(pool: pg.Pool, leaseNumber: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: number }>(
    'SELECT id FROM leases WHERE lease_number = $1', [leaseNumber]
  );
  return rows.length > 0;
}

async function checkLeaseTenantExists(pool: pg.Pool, leaseNumber: string, tenantCode: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT lt.id FROM lease_tenants lt
     JOIN leases l ON lt.lease_id = l.id
     JOIN tenants t ON lt.tenant_id = t.id
     WHERE l.lease_number = $1 AND t.tenant_code = $2`,
    [leaseNumber, tenantCode]
  );
  return rows.length > 0;
}

// ── Output Helpers ────────────────────────────────────────────────────────────

function sectionHeader(title: string): string {
  const prefix = `── ${title} `;
  return prefix + '─'.repeat(Math.max(1, 53 - prefix.length));
}

// ── Audit Masking (for --apply) ───────────────────────────────────────────────

function maskIban(v: string | null): string | null {
  if (!v) return null;
  if (v.length <= 4) return '****';
  return '*'.repeat(v.length - 4) + v.slice(-4);
}

function maskPhone(v: string | null): string | null {
  if (!v) return null;
  if (v.length <= 4) return '****';
  return v.slice(0, 1) + '*'.repeat(v.length - 5) + v.slice(-4);
}

function maskSepa(v: string | null): string | null {
  if (!v) return null;
  if (v.length <= 4) return '****';
  return '*'.repeat(v.length - 4) + v.slice(-4);
}

const SENSITIVE_FIELDS = new Set(['iban', 'phone', 'sepa_mandate_reference']);

function maskSensitiveFields(obj: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...obj };
  if (masked.iban != null) masked.iban = maskIban(String(masked.iban));
  if (masked.phone != null) masked.phone = maskPhone(String(masked.phone));
  if (masked.sepa_mandate_reference != null) masked.sepa_mandate_reference = maskSepa(String(masked.sepa_mandate_reference));
  return masked;
}

// ── Table Counts (for --apply) ───────────────────────────────────────────────

interface TableCounts {
  properties: number;
  units: number;
  tenants: number;
  leases: number;
  lease_tenants: number;
}

async function getTableCounts(client: pg.PoolClient): Promise<TableCounts> {
  const tables = ['properties', 'units', 'tenants', 'leases', 'lease_tenants'] as const;
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await client.query<{ c: string }>(`SELECT count(*)::text AS c FROM ${t}`);
    counts[t] = parseInt(rows[0].c, 10);
  }
  return counts as unknown as TableCounts;
}

// ── Audit Writer (for --apply) ───────────────────────────────────────────────

async function writeAudit(
  client: pg.PoolClient,
  correlationId: string,
  action: 'insert' | 'update',
  entityType: string,
  entityId: number,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Promise<void> {
  const maskedBefore = before ? maskSensitiveFields(before) : null;
  const maskedAfter = maskSensitiveFields(after);
  await client.query(
    `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, before_jsonb, after_jsonb, source, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      'import-sprint5d',
      'assets',
      action,
      entityType,
      entityId,
      maskedBefore ? JSON.stringify(maskedBefore) : null,
      JSON.stringify(maskedAfter),
      'cli:import-sprint5d --apply',
      correlationId,
    ]
  );
}

// ── Verbose Diff (--dry-run-verbose) ──────────────────────────────────────────

const PROPERTY_DIFF_FIELDS: (keyof Omit<ParsedProperty, '_excel_row'>)[] = [
  'name', 'street', 'postal_code', 'city', 'property_type',
  'ownership_start', 'acquisition_date',
  'purchase_price_total', 'building_value', 'land_value', 'afa_rate',
  'total_living_area_qm', 'total_commercial_area_qm',
  'billing_period_start_month',
  'heating_type', 'co2_cost_relevant',
  'notes', 'legal_owner',
];

const NUMERIC_DB_FIELDS = new Set([
  'purchase_price_total', 'building_value', 'land_value', 'afa_rate',
  'total_living_area_qm', 'total_commercial_area_qm',
]);

const DATE_DB_FIELDS = new Set(['ownership_start', 'acquisition_date']);

interface FieldDiff {
  field: string;
  oldDisplay: string;
  newDisplay: string;
  marker: '' | 'unchanged' | 'changed';
}

interface PropertyDiff {
  code: string;
  action: 'INSERT' | 'UPDATE' | 'UP_TO_DATE';
  fields: FieldDiff[];
  changeCount: number;
  changedFieldNames: string[];
  reviewDiffs: FieldDiff[];
}

function formatDiffValue(v: unknown): string {
  if (v == null) return 'NULL';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return String(v);
  return `"${v}"`;
}

function normalizeDbValue(val: unknown, field: string): string | number | boolean | null {
  if (val == null) return null;
  if (DATE_DB_FIELDS.has(field) && val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  if (NUMERIC_DB_FIELDS.has(field) && typeof val === 'string') {
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  }
  return val as string | number | boolean;
}

async function fetchPropertyRow(pool: pg.Pool, code: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query('SELECT * FROM properties WHERE code = $1', [code]);
  return rows.length > 0 ? rows[0] as Record<string, unknown> : null;
}

function computePropertyDiff(parsed: ParsedProperty, dbRow: Record<string, unknown>): PropertyDiff {
  const fields: FieldDiff[] = [];
  const changedFieldNames: string[] = [];
  const reviewDiffs: FieldDiff[] = [];

  for (const field of PROPERTY_DIFF_FIELDS) {
    const newVal = parsed[field];
    const oldVal = normalizeDbValue(dbRow[field], field);
    const oldDisplay = formatDiffValue(oldVal);
    const newDisplay = formatDiffValue(newVal);

    // Type safety: if both are non-null and types differ, that's a bug
    if (oldVal != null && newVal != null && typeof oldVal !== typeof newVal) {
      console.error(`\nTYPE MISMATCH in diff: ${field} — DB type=${typeof oldVal} (${oldDisplay}), new type=${typeof newVal} (${newDisplay})`);
      process.exit(1);
    }

    let marker: '' | 'unchanged' | 'changed' = '';
    if (oldDisplay === newDisplay) {
      marker = 'unchanged';
    } else if (oldVal != null) {
      marker = 'changed'; // old was non-NULL and new differs → critical
    }
    // else: old was NULL, new is different → normal (no marker)

    const diff: FieldDiff = { field, oldDisplay, newDisplay, marker };
    fields.push(diff);

    if (marker !== 'unchanged') {
      changedFieldNames.push(field);
    }
    if (marker === 'changed') {
      reviewDiffs.push(diff);
    }
  }

  const changeCount = changedFieldNames.length;
  return {
    code: parsed.code!,
    action: changeCount === 0 ? 'UP_TO_DATE' : 'UPDATE',
    fields,
    changeCount,
    changedFieldNames,
    reviewDiffs,
  };
}

// ── Apply Import ─────────────────────────────────────────────────────────────

async function applyImport(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const correlationId = `sprint5d-import-${today}-${Date.now()}`;

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  Sprint 5d.3 — Import APPLY (Live)');
  console.log('  Source: ~/sprint-5d-data.json');
  console.log(`  Date: ${today}`);
  console.log(`  Correlation: ${correlationId}`);
  console.log('═══════════════════════════════════════════════════');

  // ── Load JSON ──
  if (!existsSync(DATA_FILE)) {
    console.error(`\nERROR: Data file not found: ${DATA_FILE}`);
    process.exit(1);
  }
  const json = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));

  // ── Validate _meta ──
  const sheetNames: string[] = (json._meta?.sheets ?? []).map((s: { name: string }) => s.name);
  for (const expected of EXPECTED_SHEETS) {
    if (!sheetNames.includes(expected)) {
      console.error(`\nERROR: Missing sheet in JSON: ${expected}`);
      process.exit(1);
    }
  }

  // ── Parse all tables ──
  const properties = parseProperties(json.properties);
  const propErrors = validateProperties(properties);
  const propertyCodes = new Set(
    properties.filter(p => p.code && !propErrors.has(p._excel_row)).map(p => p.code!)
  );

  const units = parseUnits(json.units);
  const unitErrors = validateUnits(units, propertyCodes);

  const { parsed: tenants, skipped: tenantSkips } = parseTenants(json.tenants);
  const tenantErrors = validateTenants(tenants);

  const leases = parseLeases(json.leases);
  const leaseErrors = validateLeases(leases);

  const leaseTenants = parseLeaseTenants(json.lease_tenants);
  const ltErrors = validateLeaseTenants(leaseTenants);

  // ── Check for validation errors ──
  let totalErrors = 0;
  for (const errs of propErrors.values()) totalErrors += errs.length;
  for (const errs of unitErrors.values()) totalErrors += errs.length;
  for (const errs of tenantErrors.values()) totalErrors += errs.length;
  for (const errs of leaseErrors.values()) totalErrors += errs.length;
  for (const errs of ltErrors.values()) totalErrors += errs.length;

  if (totalErrors > 0) {
    console.error(`\nERROR: ${totalErrors} validation errors found. Fix before --apply.`);
    console.error('Run --dry-run to see details.');
    process.exit(1);
  }

  // ── DB connection ──
  const connStr = loadEnv();
  const pool = new pg.Pool({ connectionString: connStr, max: 5, idleTimeoutMillis: 10000 });
  const client = await pool.connect();

  const summary = {
    properties:    { insert: 0, update: 0, skip: 0 },
    units:         { insert: 0, update: 0, skip: 0 },
    tenants:       { insert: 0, update: 0, skip: 0 },
    leases:        { insert: 0, update: 0, skip: 0 },
    lease_tenants: { insert: 0, update: 0, skip: 0 },
  };

  try {
    // ── Pre-snapshot ──
    const preCounts = await getTableCounts(client);
    console.log('\n── Pre-Snapshot ────────────────────────────────────');
    console.log(`  properties:    ${preCounts.properties}`);
    console.log(`  units:         ${preCounts.units}`);
    console.log(`  tenants:       ${preCounts.tenants}`);
    console.log(`  leases:        ${preCounts.leases}`);
    console.log(`  lease_tenants: ${preCounts.lease_tenants}`);

    // ══════════════════════════════════════════════════
    // BEGIN TRANSACTION
    // ══════════════════════════════════════════════════
    await client.query('BEGIN');
    console.log('\n── Transaction BEGIN ───────────────────────────────');

    try {
      // ══════════════════════════════════════════════════
      // 1. Properties
      // ══════════════════════════════════════════════════
      console.log(`\n${sectionHeader('Properties (' + properties.length + ' records)')}`);

      for (const p of properties) {
        if (propErrors.has(p._excel_row)) continue; // already counted above

        // Fetch before-state for audit
        const { rows: beforeRows } = await client.query('SELECT * FROM properties WHERE code = $1', [p.code]);
        const beforeRow = beforeRows.length > 0 ? beforeRows[0] as Record<string, unknown> : null;

        const { rows } = await client.query<{ id: number; is_insert: boolean }>(
          `INSERT INTO properties (
            code, name, street, postal_code, city, property_type,
            ownership_start, acquisition_date,
            purchase_price_total, building_value, land_value, afa_rate,
            total_living_area_qm, total_commercial_area_qm,
            billing_period_start_month,
            heating_type, co2_cost_relevant,
            notes, legal_owner,
            active, owner
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, true, 'personal')
          ON CONFLICT (code) DO UPDATE SET
            name = EXCLUDED.name,
            street = EXCLUDED.street,
            postal_code = EXCLUDED.postal_code,
            city = EXCLUDED.city,
            property_type = EXCLUDED.property_type,
            ownership_start = EXCLUDED.ownership_start,
            acquisition_date = EXCLUDED.acquisition_date,
            purchase_price_total = EXCLUDED.purchase_price_total,
            building_value = EXCLUDED.building_value,
            land_value = EXCLUDED.land_value,
            afa_rate = EXCLUDED.afa_rate,
            total_living_area_qm = EXCLUDED.total_living_area_qm,
            total_commercial_area_qm = EXCLUDED.total_commercial_area_qm,
            billing_period_start_month = EXCLUDED.billing_period_start_month,
            heating_type = EXCLUDED.heating_type,
            co2_cost_relevant = EXCLUDED.co2_cost_relevant,
            notes = EXCLUDED.notes,
            legal_owner = EXCLUDED.legal_owner,
            updated_at = NOW()
          RETURNING id, (xmax = 0) AS is_insert`,
          [
            p.code, p.name, p.street, p.postal_code, p.city, p.property_type,
            p.ownership_start, p.acquisition_date,
            p.purchase_price_total, p.building_value, p.land_value, p.afa_rate,
            p.total_living_area_qm, p.total_commercial_area_qm,
            p.billing_period_start_month,
            p.heating_type, p.co2_cost_relevant,
            p.notes, p.legal_owner,
          ]
        );

        const { id, is_insert } = rows[0];
        const action = is_insert ? 'INSERT' : 'UPDATE';
        summary.properties[action.toLowerCase() as 'insert' | 'update']++;
        console.log(`  [${action}] ${p.code!.padEnd(5)} — ${p.name}, ${p.street}, ${p.postal_code} ${p.city} (id=${id})`);

        // Audit
        const afterData = { code: p.code, name: p.name, street: p.street, postal_code: p.postal_code, city: p.city, property_type: p.property_type };
        await writeAudit(client, correlationId, is_insert ? 'insert' : 'update', 'property', id, beforeRow, afterData);
      }

      // ══════════════════════════════════════════════════
      // 2. Units
      // ══════════════════════════════════════════════════
      console.log(`\n${sectionHeader('Units (' + units.length + ' records)')}`);

      for (const u of units) {
        if (unitErrors.has(u._excel_row)) continue;

        // Lookup property_id
        const { rows: propRows } = await client.query<{ id: number }>(
          'SELECT id FROM properties WHERE code = $1', [u.property_code]
        );
        if (propRows.length === 0) {
          console.error(`  [ERROR] Property not found: ${u.property_code}`);
          throw new Error(`Property not found: ${u.property_code}`);
        }
        const propertyId = propRows[0].id;

        // Fetch before-state for audit
        const { rows: beforeRows } = await client.query(
          'SELECT * FROM units WHERE property_id = $1 AND LOWER(code) = LOWER($2)',
          [propertyId, u.code]
        );
        const beforeRow = beforeRows.length > 0 ? beforeRows[0] as Record<string, unknown> : null;

        const { rows } = await client.query<{ id: number; is_insert: boolean }>(
          `INSERT INTO units (
            property_id, code, unit_type, floor,
            living_area_qm, usable_area_qm, allocation_area_qm,
            rooms, has_balcony, has_heating,
            vacant_from, vacant_until, notes,
            active
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, true)
          ON CONFLICT (property_id, code) DO UPDATE SET
            unit_type = EXCLUDED.unit_type,
            floor = EXCLUDED.floor,
            living_area_qm = EXCLUDED.living_area_qm,
            usable_area_qm = EXCLUDED.usable_area_qm,
            allocation_area_qm = EXCLUDED.allocation_area_qm,
            rooms = EXCLUDED.rooms,
            has_balcony = EXCLUDED.has_balcony,
            has_heating = EXCLUDED.has_heating,
            vacant_from = EXCLUDED.vacant_from,
            vacant_until = EXCLUDED.vacant_until,
            notes = EXCLUDED.notes,
            updated_at = NOW()
          RETURNING id, (xmax = 0) AS is_insert`,
          [
            propertyId, u.code, u.unit_type, u.floor,
            u.living_area_qm, u.usable_area_qm, u.allocation_area_qm,
            u.rooms, u.has_balcony, u.has_heating,
            u.vacant_from, u.vacant_until, u.notes,
          ]
        );

        const { id, is_insert } = rows[0];
        const action = is_insert ? 'INSERT' : 'UPDATE';
        summary.units[action.toLowerCase() as 'insert' | 'update']++;
        const area = u.living_area_qm ?? u.usable_area_qm ?? 0;
        console.log(`  [${action}] ${u.property_code}/${u.code}  — ${u.unit_type}, ${u.floor ?? 'n/a'}, ${area}m² (id=${id})`);

        await writeAudit(client, correlationId, is_insert ? 'insert' : 'update', 'unit', id, beforeRow, { property_code: u.property_code, code: u.code, unit_type: u.unit_type });
      }

      // ══════════════════════════════════════════════════
      // 3. Tenants
      // ══════════════════════════════════════════════════
      console.log(`\n${sectionHeader('Tenants (' + tenants.length + ' records, ' + tenantSkips.length + ' skipped)')}`);

      for (const t of tenants) {
        if (tenantErrors.has(t._excel_row)) continue;

        // Fetch before-state for audit
        const { rows: beforeRows } = await client.query(
          'SELECT * FROM tenants WHERE tenant_code = $1', [t.tenant_code]
        );
        const beforeRow = beforeRows.length > 0 ? beforeRows[0] as Record<string, unknown> : null;

        const { rows } = await client.query<{ id: number; is_insert: boolean }>(
          `INSERT INTO tenants (
            tenant_code, tenant_type, first_name, last_name, birth_date,
            company_name, contact_person, ust_id,
            street, postal_code, city,
            phone, email,
            iban, bic, bank,
            debitor_no, sepa_mandate_reference, sepa_mandate_signed_at,
            correspondence_address, notes,
            active
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, true)
          ON CONFLICT (tenant_code) DO UPDATE SET
            tenant_type = EXCLUDED.tenant_type,
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            birth_date = EXCLUDED.birth_date,
            company_name = EXCLUDED.company_name,
            contact_person = EXCLUDED.contact_person,
            ust_id = EXCLUDED.ust_id,
            street = EXCLUDED.street,
            postal_code = EXCLUDED.postal_code,
            city = EXCLUDED.city,
            phone = EXCLUDED.phone,
            email = EXCLUDED.email,
            iban = EXCLUDED.iban,
            bic = EXCLUDED.bic,
            bank = EXCLUDED.bank,
            debitor_no = EXCLUDED.debitor_no,
            sepa_mandate_reference = EXCLUDED.sepa_mandate_reference,
            sepa_mandate_signed_at = EXCLUDED.sepa_mandate_signed_at,
            correspondence_address = EXCLUDED.correspondence_address,
            notes = EXCLUDED.notes,
            updated_at = NOW()
          RETURNING id, (xmax = 0) AS is_insert`,
          [
            t.tenant_code, t.tenant_type, t.first_name, t.last_name, t.birth_date,
            t.company_name, t.contact_person, t.ust_id,
            t.street, t.postal_code, t.city,
            t.phone, t.email,
            t.iban, t.bic, t.bank,
            t.debitor_no, t.sepa_mandate_reference, t.sepa_mandate_signed_at,
            t.correspondence_address, t.notes,
          ]
        );

        const { id, is_insert } = rows[0];
        const action = is_insert ? 'INSERT' : 'UPDATE';
        summary.tenants[action.toLowerCase() as 'insert' | 'update']++;
        const displayName = t.tenant_type === 'company'
          ? `${t.company_name} (company)`
          : `${t.first_name ?? ''} ${t.last_name ?? ''} (person)`.trim();
        console.log(`  [${action}] ${t.tenant_code!.padEnd(20)} — ${displayName} (id=${id})`);

        const auditData = { tenant_code: t.tenant_code, tenant_type: t.tenant_type, first_name: t.first_name, last_name: t.last_name, email: t.email, iban: t.iban, phone: t.phone, sepa_mandate_reference: t.sepa_mandate_reference };
        await writeAudit(client, correlationId, is_insert ? 'insert' : 'update', 'tenant', id, beforeRow ? { ...beforeRow } : null, auditData);
      }
      for (const skip of tenantSkips) {
        console.log(`  [SKIP]   row ${String(skip.row).padEnd(16)} — ${skip.reason}`);
        summary.tenants.skip++;
      }

      // ══════════════════════════════════════════════════
      // 4. Leases
      // ══════════════════════════════════════════════════
      console.log(`\n${sectionHeader('Leases (' + leases.length + ' records)')}`);

      // Build display map for unit codes
      const unitDisplayMap = new Map<string, string>();
      for (const u of units) {
        if (u.property_code && u.code) {
          unitDisplayMap.set(`${u.property_code}/${u.code.toLowerCase()}`, u.code);
        }
      }

      for (const l of leases) {
        if (leaseErrors.has(l._excel_row)) continue;

        // Lookup unit_id via property_code + unit_code (LOWER comparison)
        const { rows: unitRows } = await client.query<{ id: number }>(
          `SELECT u.id FROM units u
           JOIN properties p ON u.property_id = p.id
           WHERE p.code = $1 AND LOWER(u.code) = LOWER($2)`,
          [l.property_code, l.unit_code]
        );
        if (unitRows.length === 0) {
          console.error(`  [ERROR] Unit not found: ${l.property_code}/${l.unit_code}`);
          throw new Error(`Unit not found: ${l.property_code}/${l.unit_code}`);
        }
        const unitId = unitRows[0].id;

        // Fetch before-state for audit
        const { rows: beforeRows } = await client.query(
          'SELECT * FROM leases WHERE lease_number = $1', [l.lease_number]
        );
        const beforeRow = beforeRows.length > 0 ? beforeRows[0] as Record<string, unknown> : null;

        const { rows } = await client.query<{ id: number; is_insert: boolean }>(
          `INSERT INTO leases (
            unit_id, lease_number, lease_type, status,
            signed_at, start_date, handover_at, end_date,
            termination_date, termination_reason, actual_move_out,
            billing_mode, kaltmiete, nk_vorauszahlung,
            garage_amount, kitchen_amount,
            heizkosten_vorauszahlung, kaution,
            payment_method, rent_due_day,
            vat_option, vat_rate,
            contract_document_path, notes
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
          ON CONFLICT (lease_number) DO UPDATE SET
            unit_id = EXCLUDED.unit_id,
            lease_type = EXCLUDED.lease_type,
            status = EXCLUDED.status,
            signed_at = EXCLUDED.signed_at,
            start_date = EXCLUDED.start_date,
            handover_at = EXCLUDED.handover_at,
            end_date = EXCLUDED.end_date,
            termination_date = EXCLUDED.termination_date,
            termination_reason = EXCLUDED.termination_reason,
            actual_move_out = EXCLUDED.actual_move_out,
            billing_mode = EXCLUDED.billing_mode,
            kaltmiete = EXCLUDED.kaltmiete,
            nk_vorauszahlung = EXCLUDED.nk_vorauszahlung,
            garage_amount = EXCLUDED.garage_amount,
            kitchen_amount = EXCLUDED.kitchen_amount,
            heizkosten_vorauszahlung = EXCLUDED.heizkosten_vorauszahlung,
            kaution = EXCLUDED.kaution,
            payment_method = EXCLUDED.payment_method,
            rent_due_day = EXCLUDED.rent_due_day,
            vat_option = EXCLUDED.vat_option,
            vat_rate = EXCLUDED.vat_rate,
            contract_document_path = EXCLUDED.contract_document_path,
            notes = EXCLUDED.notes,
            updated_at = NOW()
          RETURNING id, (xmax = 0) AS is_insert`,
          [
            unitId, l.lease_number, l.lease_type, l.status,
            l.signed_at, l.start_date, l.handover_at, l.end_date,
            l.termination_date, l.termination_reason, l.actual_move_out,
            l.billing_mode, l.kaltmiete, l.nk_vorauszahlung,
            l.garage_amount, l.kitchen_amount,
            l.heizkosten_vorauszahlung, l.kaution,
            l.payment_method, l.rent_due_day,
            l.vat_option, l.vat_rate,
            l.contract_document_path, l.notes,
          ]
        );

        const { id, is_insert } = rows[0];
        const action = is_insert ? 'INSERT' : 'UPDATE';
        summary.leases[action.toLowerCase() as 'insert' | 'update']++;
        const displayUnitCode = l.property_code && l.unit_code
          ? unitDisplayMap.get(`${l.property_code}/${l.unit_code.toLowerCase()}`) ?? l.unit_code
          : l.unit_code;
        const rent = l.kaltmiete != null ? `\u20AC${l.kaltmiete}` : 'n/a';
        console.log(`  [${action}] ${l.lease_number!.padEnd(16)} — ${l.property_code}/${displayUnitCode}, ${l.lease_type}, ${l.status}, ${l.start_date}, ${rent} (id=${id})`);

        await writeAudit(client, correlationId, is_insert ? 'insert' : 'update', 'lease', id, beforeRow, { lease_number: l.lease_number, unit_id: unitId, lease_type: l.lease_type, status: l.status, kaltmiete: l.kaltmiete });
      }

      // ══════════════════════════════════════════════════
      // 5. Lease_Tenants
      // ══════════════════════════════════════════════════
      console.log(`\n${sectionHeader('Lease_Tenants (' + leaseTenants.length + ' records)')}`);

      // Track which leases already have an active primary (valid_until IS NULL)
      // to respect uq_lease_primary constraint
      const activePrimarySet = new Set<number>();

      for (const lt of leaseTenants) {
        if (ltErrors.has(lt._excel_row)) continue;

        // Lookup lease_id
        const { rows: leaseRows } = await client.query<{ id: number }>(
          'SELECT id FROM leases WHERE lease_number = $1', [lt.lease_number]
        );
        if (leaseRows.length === 0) {
          console.error(`  [ERROR] Lease not found: ${lt.lease_number}`);
          throw new Error(`Lease not found: ${lt.lease_number}`);
        }
        const leaseId = leaseRows[0].id;

        // Lookup tenant_id
        const { rows: tenantRows } = await client.query<{ id: number }>(
          'SELECT id FROM tenants WHERE tenant_code = $1', [lt.tenant_code]
        );
        if (tenantRows.length === 0) {
          console.error(`  [ERROR] Tenant not found: ${lt.tenant_code}`);
          throw new Error(`Tenant not found: ${lt.tenant_code}`);
        }
        const tenantId = tenantRows[0].id;

        // Enforce uq_lease_primary: only one active primary per lease
        let effectivePrimary = lt.is_primary_contact;
        if (effectivePrimary && lt.valid_until == null) {
          if (activePrimarySet.has(leaseId)) {
            effectivePrimary = false;
            console.log(`  [WARN]   ${lt.lease_number} \u2194 ${lt.tenant_code}: demoted to non-primary (uq_lease_primary)`);
          } else {
            activePrimarySet.add(leaseId);
          }
        }

        // Check if exists (no composite unique constraint, manual check)
        const { rows: existRows } = await client.query<{ id: number }>(
          'SELECT id FROM lease_tenants WHERE lease_id = $1 AND tenant_id = $2',
          [leaseId, tenantId]
        );
        const beforeRow = existRows.length > 0
          ? (await client.query('SELECT * FROM lease_tenants WHERE id = $1', [existRows[0].id])).rows[0] as Record<string, unknown>
          : null;

        let id: number;
        let is_insert: boolean;

        if (existRows.length > 0) {
          // UPDATE existing
          await client.query(
            `UPDATE lease_tenants SET
              role = $1, is_primary_contact = $2, valid_from = $3, valid_until = $4, notes = $5
             WHERE id = $6`,
            [lt.role, effectivePrimary, lt.valid_from, lt.valid_until, lt.notes, existRows[0].id]
          );
          id = existRows[0].id;
          is_insert = false;
        } else {
          // INSERT new
          const { rows: insertRows } = await client.query<{ id: number }>(
            `INSERT INTO lease_tenants (lease_id, tenant_id, role, is_primary_contact, valid_from, valid_until, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [leaseId, tenantId, lt.role, effectivePrimary, lt.valid_from, lt.valid_until, lt.notes]
          );
          id = insertRows[0].id;
          is_insert = true;
        }

        const action = is_insert ? 'INSERT' : 'UPDATE';
        summary.lease_tenants[action.toLowerCase() as 'insert' | 'update']++;
        const primary = effectivePrimary ? ', primary' : '';
        console.log(`  [${action}] ${lt.lease_number} \u2194 ${lt.tenant_code} (${lt.role}${primary}) (id=${id})`);

        await writeAudit(client, correlationId, is_insert ? 'insert' : 'update', 'lease_tenant', id, beforeRow, { lease_number: lt.lease_number, tenant_code: lt.tenant_code, role: lt.role, is_primary_contact: effectivePrimary });
      }

      // ══════════════════════════════════════════════════
      // COMMIT
      // ══════════════════════════════════════════════════
      await client.query('COMMIT');
      console.log('\n── Transaction COMMIT ──────────────────────────────');
      console.log('  All operations committed successfully.');

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('\n── Transaction ROLLBACK ────────────────────────────');
      console.error('  All operations rolled back due to error.');
      throw err;
    }

    // ══════════════════════════════════════════════════
    // Post-Snapshot
    // ══════════════════════════════════════════════════
    const postCounts = await getTableCounts(client);
    console.log('\n── Post-Snapshot ───────────────────────────────────');
    console.log(`  ${'Table'.padEnd(16)} ${'Pre'.padStart(5)} ${'Post'.padStart(5)} ${'Diff'.padStart(5)}`);
    console.log(`  ${'─'.repeat(16)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(5)}`);
    for (const t of ['properties', 'units', 'tenants', 'leases', 'lease_tenants'] as const) {
      const pre = preCounts[t];
      const post = postCounts[t];
      const diff = post - pre;
      const diffStr = diff > 0 ? `+${diff}` : diff === 0 ? '0' : String(diff);
      console.log(`  ${t.padEnd(16)} ${String(pre).padStart(5)} ${String(post).padStart(5)} ${diffStr.padStart(5)}`);
    }

    // ══════════════════════════════════════════════════
    // Spot-Checks
    // ══════════════════════════════════════════════════
    console.log('\n── Spot-Checks ────────────────────────────────────');
    let spotCheckPass = 0;
    let spotCheckFail = 0;

    // Check 1: All 6 property codes exist
    const { rows: propCodes } = await client.query<{ code: string }>(
      "SELECT code FROM properties WHERE code IN ('l19','mg24','d4','n24','s28','i83') ORDER BY code"
    );
    const foundCodes = propCodes.map(r => r.code).join(', ');
    if (propCodes.length === 6) {
      console.log(`  [PASS] 1. All 6 property codes exist: ${foundCodes}`);
      spotCheckPass++;
    } else {
      console.log(`  [FAIL] 1. Expected 6 property codes, found ${propCodes.length}: ${foundCodes}`);
      spotCheckFail++;
    }

    // Check 2: l19 has 4 units (W1..W4) — the original l19-w1..w4 are separate
    const { rows: l19Units } = await client.query<{ code: string }>(
      "SELECT u.code FROM units u JOIN properties p ON u.property_id = p.id WHERE p.code = 'l19' ORDER BY u.code"
    );
    const l19UnitCodes = l19Units.map(r => r.code).join(', ');
    console.log(`  [INFO] 2. l19 units: ${l19UnitCodes} (${l19Units.length} total)`);
    spotCheckPass++;

    // Check 3: Tenants count = 26
    const { rows: tenantCount } = await client.query<{ c: string }>('SELECT count(*)::text AS c FROM tenants');
    const tc = parseInt(tenantCount[0].c, 10);
    if (tc >= 26) {
      console.log(`  [PASS] 3. Tenants count: ${tc} (expected >= 26)`);
      spotCheckPass++;
    } else {
      console.log(`  [FAIL] 3. Tenants count: ${tc} (expected >= 26)`);
      spotCheckFail++;
    }

    // Check 4: Leases count = 17
    const { rows: leaseCount } = await client.query<{ c: string }>('SELECT count(*)::text AS c FROM leases');
    const lc = parseInt(leaseCount[0].c, 10);
    if (lc >= 17) {
      console.log(`  [PASS] 4. Leases count: ${lc} (expected >= 17)`);
      spotCheckPass++;
    } else {
      console.log(`  [FAIL] 4. Leases count: ${lc} (expected >= 17)`);
      spotCheckFail++;
    }

    // Check 5: Lease_tenants count = 26
    const { rows: ltCount } = await client.query<{ c: string }>('SELECT count(*)::text AS c FROM lease_tenants');
    const ltc = parseInt(ltCount[0].c, 10);
    if (ltc >= 26) {
      console.log(`  [PASS] 5. Lease_tenants count: ${ltc} (expected >= 26)`);
      spotCheckPass++;
    } else {
      console.log(`  [FAIL] 5. Lease_tenants count: ${ltc} (expected >= 26)`);
      spotCheckFail++;
    }

    // Check 6: n24-w6 has 2 leases (n24-w6-2024 + n24-w6-2025)
    const { rows: n24w6Leases } = await client.query<{ lease_number: string }>(
      `SELECT l.lease_number FROM leases l
       JOIN units u ON l.unit_id = u.id
       JOIN properties p ON u.property_id = p.id
       WHERE p.code = 'n24' AND LOWER(u.code) = 'w6'
       ORDER BY l.lease_number`
    );
    const n24w6Nums = n24w6Leases.map(r => r.lease_number).join(', ');
    if (n24w6Leases.length === 2) {
      console.log(`  [PASS] 6. n24/W6 has 2 leases: ${n24w6Nums}`);
      spotCheckPass++;
    } else {
      console.log(`  [FAIL] 6. n24/W6 expected 2 leases, found ${n24w6Leases.length}: ${n24w6Nums}`);
      spotCheckFail++;
    }

    // Check 7: Audit log entries for this correlation
    const { rows: auditCount } = await client.query<{ c: string }>(
      'SELECT count(*)::text AS c FROM audit_log WHERE correlation_id = $1', [correlationId]
    );
    const ac = parseInt(auditCount[0].c, 10);
    console.log(`  [PASS] 7. Audit log entries: ${ac} for correlation ${correlationId}`);
    spotCheckPass++;

    console.log(`\n  Spot-checks: ${spotCheckPass} PASS, ${spotCheckFail} FAIL`);

    // ══════════════════════════════════════════════════
    // Summary
    // ══════════════════════════════════════════════════
    console.log(`\n${sectionHeader('Summary')}`);
    console.log(`  Properties:    ${summary.properties.insert} INSERT, ${summary.properties.update} UPDATE`);
    console.log(`  Units:         ${summary.units.insert} INSERT, ${summary.units.update} UPDATE`);
    console.log(`  Tenants:       ${summary.tenants.insert} INSERT, ${summary.tenants.update} UPDATE, ${summary.tenants.skip} SKIP`);
    console.log(`  Leases:        ${summary.leases.insert} INSERT, ${summary.leases.update} UPDATE`);
    console.log(`  Lease_Tenants: ${summary.lease_tenants.insert} INSERT, ${summary.lease_tenants.update} UPDATE`);
    console.log('');
    console.log('  \u2705 APPLY complete — all changes committed.');
    console.log(`  Correlation: ${correlationId}`);
    console.log('');

    if (spotCheckFail > 0) {
      console.error(`  WARNING: ${spotCheckFail} spot-check(s) failed. Review output above.`);
      process.exit(1);
    }

  } finally {
    client.release();
    await pool.end();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const verbose = process.argv.includes('--dry-run-verbose');
  const today = new Date().toISOString().slice(0, 10);

  // ── Header ──
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log(verbose
    ? '  Sprint 5d.3 — Pre-Apply-Check (Verbose DRY-RUN)'
    : '  Sprint 5d.2 — Import DRY-RUN');
  console.log('  Source: ~/sprint-5d-data.json');
  console.log(`  Date: ${today}`);
  console.log('═══════════════════════════════════════════════════');

  // ── Load JSON ──
  if (!existsSync(DATA_FILE)) {
    console.error(`\nERROR: Data file not found: ${DATA_FILE}`);
    process.exit(1);
  }
  const json = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));

  // ── Validate _meta (5 expected sheets) ──
  const sheetNames: string[] = (json._meta?.sheets ?? []).map((s: { name: string }) => s.name);
  for (const expected of EXPECTED_SHEETS) {
    if (!sheetNames.includes(expected)) {
      console.error(`\nERROR: Missing sheet in JSON: ${expected}`);
      process.exit(1);
    }
  }

  // ── DB connection for idempotency reads ──
  const connStr = loadEnv();
  const pool = new pg.Pool({ connectionString: connStr, max: 5, idleTimeoutMillis: 10000 });

  let totalErrors = 0;
  const summary = {
    properties:    { insert: 0, update: 0, skip: 0 },
    units:         { insert: 0, update: 0, skip: 0 },
    tenants:       { insert: 0, update: 0, skip: 0 },
    leases:        { insert: 0, update: 0, skip: 0 },
    lease_tenants: { insert: 0, update: 0, skip: 0 },
  };

  try {
    // ══════════════════════════════════════════════════
    // 1. Properties (no FK)
    // ══════════════════════════════════════════════════
    const properties = parseProperties(json.properties);
    const propErrors = validateProperties(properties);
    const propertyCodes = new Set(
      properties.filter(p => p.code && !propErrors.has(p._excel_row)).map(p => p.code!)
    );

    const propDiffs: PropertyDiff[] = [];
    const allReviewDiffs: { code: string; diff: FieldDiff }[] = [];

    if (!verbose) {
      console.log(`\n${sectionHeader(`Properties (${properties.length} records)`)}`);
    }

    for (const p of properties) {
      const errs = propErrors.get(p._excel_row);
      if (errs) {
        if (!verbose) {
          console.log(`  [SKIP]   ${(p.code ?? '???').padEnd(5)} — validation error: ${errs.map(e => e.message).join(', ')}`);
        }
        summary.properties.skip++;
        totalErrors += errs.length;
        continue;
      }
      const exists = await checkPropertyExists(pool, p.code!);
      const action = exists ? 'UPDATE' : 'INSERT';
      summary.properties[action.toLowerCase() as 'insert' | 'update']++;

      if (!verbose) {
        console.log(`  [${action}] ${p.code!.padEnd(5)} — ${p.name}, ${p.street}, ${p.postal_code} ${p.city} (${p.property_type})`);
      }

      if (verbose) {
        if (exists) {
          const dbRow = await fetchPropertyRow(pool, p.code!);
          if (dbRow) {
            const diff = computePropertyDiff(p, dbRow);
            propDiffs.push(diff);
            for (const rd of diff.reviewDiffs) {
              allReviewDiffs.push({ code: p.code!, diff: rd });
            }
          }
        } else {
          propDiffs.push({
            code: p.code!,
            action: 'INSERT',
            fields: [],
            changeCount: PROPERTY_DIFF_FIELDS.length,
            changedFieldNames: [...PROPERTY_DIFF_FIELDS] as string[],
            reviewDiffs: [],
          });
        }
      }
    }

    // ══════════════════════════════════════════════════
    // 2. Units (FK → properties)
    // ══════════════════════════════════════════════════
    const units = parseUnits(json.units);
    const unitErrors = validateUnits(units, propertyCodes);

    // Build display map: (property_code + lowercase_unit_code) → original unit code
    const unitDisplayMap = new Map<string, string>();
    for (const u of units) {
      if (u.property_code && u.code) {
        unitDisplayMap.set(`${u.property_code}/${u.code.toLowerCase()}`, u.code);
      }
    }

    if (!verbose) {
      console.log(`\n${sectionHeader(`Units (${units.length} records)`)}`);
    }

    for (const u of units) {
      const errs = unitErrors.get(u._excel_row);
      if (errs) {
        if (!verbose) {
          console.log(`  [SKIP]   ${u.property_code ?? '?'}/${u.code ?? '?'} — validation error: ${errs.map(e => e.message).join(', ')}`);
        }
        summary.units.skip++;
        totalErrors += errs.length;
        continue;
      }
      const exists = await checkUnitExists(pool, u.property_code!, u.code!);
      const action = exists ? 'UPDATE' : 'INSERT';
      summary.units[action.toLowerCase() as 'insert' | 'update']++;
      if (!verbose) {
        const area = u.living_area_qm ?? u.usable_area_qm ?? 0;
        console.log(`  [${action}] ${u.property_code}/${u.code}  — ${u.unit_type}, ${u.floor ?? 'n/a'}, ${area}m²`);
      }
    }

    // ══════════════════════════════════════════════════
    // 3. Tenants (no FK, filter empty rows)
    // ══════════════════════════════════════════════════
    const { parsed: tenants, skipped: tenantSkips } = parseTenants(json.tenants);
    const tenantErrors = validateTenants(tenants);

    if (!verbose) {
      console.log(`\n${sectionHeader(`Tenants (${tenants.length} records, ${tenantSkips.length} skipped)`)}`);
    }

    for (const t of tenants) {
      const errs = tenantErrors.get(t._excel_row);
      if (errs) {
        if (!verbose) {
          console.log(`  [SKIP]   ${(t.tenant_code ?? '???').padEnd(20)} — validation error: ${errs.map(e => e.message).join(', ')}`);
        }
        summary.tenants.skip++;
        totalErrors += errs.length;
        continue;
      }
      const exists = await checkTenantExists(pool, t.tenant_code!);
      const action = exists ? 'UPDATE' : 'INSERT';
      summary.tenants[action.toLowerCase() as 'insert' | 'update']++;
      if (!verbose) {
        const displayName = t.tenant_type === 'company'
          ? `${t.company_name} (company)`
          : `${t.first_name ?? ''} ${t.last_name ?? ''} (person)`.trim();
        console.log(`  [${action}] ${t.tenant_code!.padEnd(20)} — ${displayName}`);
      }
    }
    for (const skip of tenantSkips) {
      if (!verbose) {
        console.log(`  [SKIP]   row ${String(skip.row).padEnd(16)} — ${skip.reason}`);
      }
      summary.tenants.skip++;
    }

    // ══════════════════════════════════════════════════
    // 4. Leases (FK → units via property_code + unit_code)
    // ══════════════════════════════════════════════════
    const leases = parseLeases(json.leases);
    const leaseErrors = validateLeases(leases);

    if (!verbose) {
      console.log(`\n${sectionHeader(`Leases (${leases.length} records)`)}`);
    }

    for (const l of leases) {
      const errs = leaseErrors.get(l._excel_row);
      if (errs) {
        if (!verbose) {
          console.log(`  [SKIP]   ${(l.lease_number ?? '???').padEnd(16)} — validation error: ${errs.map(e => e.message).join(', ')}`);
        }
        summary.leases.skip++;
        totalErrors += errs.length;
        continue;
      }
      const exists = await checkLeaseExists(pool, l.lease_number!);
      const action = exists ? 'UPDATE' : 'INSERT';
      summary.leases[action.toLowerCase() as 'insert' | 'update']++;
      if (!verbose) {
        const displayUnitCode = l.property_code && l.unit_code
          ? unitDisplayMap.get(`${l.property_code}/${l.unit_code.toLowerCase()}`) ?? l.unit_code
          : l.unit_code;
        const rent = l.kaltmiete != null ? `\u20AC${l.kaltmiete}` : 'n/a';
        console.log(`  [${action}] ${l.lease_number!.padEnd(16)} — ${l.property_code}/${displayUnitCode}, ${l.lease_type}, ${l.status}, ${l.start_date}, ${rent}`);
      }
    }

    // ══════════════════════════════════════════════════
    // 5. Lease_Tenants (FK → leases + tenants)
    // ══════════════════════════════════════════════════
    const leaseTenants = parseLeaseTenants(json.lease_tenants);
    const ltErrors = validateLeaseTenants(leaseTenants);

    if (!verbose) {
      console.log(`\n${sectionHeader(`Lease_Tenants (${leaseTenants.length} records)`)}`);
    }

    for (const lt of leaseTenants) {
      const errs = ltErrors.get(lt._excel_row);
      if (errs) {
        if (!verbose) {
          console.log(`  [SKIP]   ${lt.lease_number ?? '?'} \u2194 ${lt.tenant_code ?? '?'} — validation error: ${errs.map(e => e.message).join(', ')}`);
        }
        summary.lease_tenants.skip++;
        totalErrors += errs.length;
        continue;
      }
      let exists = false;
      if (lt.lease_number && lt.tenant_code) {
        try {
          exists = await checkLeaseTenantExists(pool, lt.lease_number, lt.tenant_code);
        } catch {
          // FK not found in DB → can't exist → INSERT
        }
      }
      const action = exists ? 'UPDATE' : 'INSERT';
      summary.lease_tenants[action.toLowerCase() as 'insert' | 'update']++;
      if (!verbose) {
        const primary = lt.is_primary_contact ? ', primary' : '';
        console.log(`  [${action}] ${lt.lease_number} \u2194 ${lt.tenant_code} (${lt.role}${primary})`);
      }
    }

    // ══════════════════════════════════════════════════
    // Output
    // ══════════════════════════════════════════════════
    if (verbose) {
      // ── Verbose: per-property diff blocks ──
      for (const d of propDiffs) {
        if (d.action === 'INSERT') continue; // INSERTs shown in summary only
        if (d.action === 'UP_TO_DATE') {
          console.log(`\n== Property UPDATE: ${d.code} ==`);
          console.log('  ALREADY UP-TO-DATE \u2014 no operation');
          continue;
        }
        console.log(`\n== Property UPDATE: ${d.code} ==`);
        for (const f of d.fields) {
          const markerStr = f.marker === 'unchanged' ? '  [unchanged, no write]'
            : f.marker === 'changed' ? '  [CHANGED \u2014 review]'
            : '';
          console.log(`  ${(f.field + ':').padEnd(30)} ${f.oldDisplay} \u2192 ${f.newDisplay}${markerStr}`);
        }
      }

      // ── Verbose: summary ──
      console.log('\n== Summary ==');
      console.log('Properties:');
      for (const d of propDiffs) {
        if (d.action === 'INSERT') {
          console.log(`  ${d.code.padEnd(5)} \u2014 INSERT (${PROPERTY_DIFF_FIELDS.length} fields)`);
        } else if (d.action === 'UP_TO_DATE') {
          console.log(`  ${d.code.padEnd(5)} \u2014 ALREADY UP-TO-DATE \u2014 no operation`);
        } else {
          console.log(`  ${d.code.padEnd(5)} \u2014 ${d.changeCount} fields change (${d.changedFieldNames.join(', ')})`);
        }
      }

      if (allReviewDiffs.length > 0) {
        console.log('\nFields with [CHANGED \u2014 review] markers across all properties:');
        for (const { code, diff: rd } of allReviewDiffs) {
          console.log(`  - ${code}.${rd.field}: ${rd.oldDisplay} \u2192 ${rd.newDisplay}`);
        }
      } else {
        console.log('\nNo [CHANGED \u2014 review] markers \u2014 all changes are NULL\u2192value populations.');
      }

      console.log(`\nUnits: ${summary.units.insert} INSERTs, ${summary.units.update} UPDATEs`);
      console.log(`Tenants: ${summary.tenants.insert} INSERTs, ${summary.tenants.update} UPDATEs, ${summary.tenants.skip} SKIPs`);
      console.log(`Leases: ${summary.leases.insert} INSERTs, ${summary.leases.update} UPDATEs`);
      console.log(`Lease_Tenants: ${summary.lease_tenants.insert} INSERTs, ${summary.lease_tenants.update} UPDATEs`);
      console.log(`Validation: ${totalErrors} errors`);
      console.log('');
      console.log('\u26A0 DRY-RUN \u2014 no database changes were made.');
      console.log('Use --apply in Sprint 5d.3 to execute.');
      console.log('');
    } else {
      // ── Normal DRY-RUN summary ──
      console.log(`\n${sectionHeader('Summary')}`);
      console.log(`  Properties:    ${summary.properties.insert} INSERT, ${summary.properties.update} UPDATE, ${summary.properties.skip} SKIP`);
      console.log(`  Units:        ${summary.units.insert} INSERT, ${summary.units.update} UPDATE, ${summary.units.skip} SKIP`);
      console.log(`  Tenants:      ${summary.tenants.insert} INSERT, ${summary.tenants.update} UPDATE, ${summary.tenants.skip} SKIP`);
      console.log(`  Leases:       ${summary.leases.insert} INSERT, ${summary.leases.update} UPDATE, ${summary.leases.skip} SKIP`);
      console.log(`  Lease_Tenants: ${summary.lease_tenants.insert} INSERT, ${summary.lease_tenants.update} UPDATE, ${summary.lease_tenants.skip} SKIP`);
      console.log(`  Validation:    ${totalErrors} errors`);
      console.log('');
      console.log('  \u26A0 DRY-RUN \u2014 no database changes were made.');
      console.log('  Use --apply in Sprint 5d.3 to execute.');
      console.log('');
    }

    if (totalErrors > 0) {
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv.includes('--apply') ? applyImport : main;
entrypoint().catch(err => {
  console.error('\nFATAL:', err.message ?? err);
  process.exit(1);
});
