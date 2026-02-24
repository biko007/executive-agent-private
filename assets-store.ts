import fs from 'fs';
import path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

export type PropertyType = 'residential' | 'commercial';
export type OwnerEntity = 'personal' | 'laperlgmbh';
export type RentType = 'permanent' | 'temporary' | 'vacant';

export interface Unit {
  id: string;          // e.g. "l19-w1"
  label: string;       // e.g. "EG links"
  floor: string;       // e.g. "EG", "OG", "1.OG"
  sqm: number | null;
  rentType: RentType;
  tenant: string;      // Name + contact
  lease: string | null; // lease ID reference
  currentRent: number | null; // Kaltmiete
}

export interface DistributionKey {
  id: string;          // e.g. "l19-miteigentumsanteil"
  label: string;       // e.g. "Miteigentumsanteil"
  values: Record<string, number>; // unitId → percentage
}

export interface Property {
  id: string;
  label: string;
  address: string;
  type: PropertyType;
  owner: OwnerEntity;
  units: Unit[];
  distributionKeys: DistributionKey[];
  createdAt: string;
  updatedAt: string;
}

export interface Lease {
  id: string;
  unitId: string;
  propertyId: string;
  tenant: string;
  startDate: string;
  endDate: string | null;
  rentNet: number;          // Kaltmiete
  operatingCosts: number;   // Vorauszahlung Nebenkosten
  depositAmount: number;
  linkedDocs: string[];
  createdAt: string;
  updatedAt: string;
}

export type CostCategory =
  | 'heizung' | 'wasser' | 'abwasser' | 'muell' | 'hausmeister'
  | 'versicherung' | 'grundsteuer' | 'allgemeinstrom' | 'aufzug';

export const COST_CATEGORIES: { key: CostCategory; label: string }[] = [
  { key: 'heizung', label: 'Heizung' },
  { key: 'wasser', label: 'Wasser' },
  { key: 'abwasser', label: 'Abwasser' },
  { key: 'muell', label: 'Müll' },
  { key: 'hausmeister', label: 'Hausmeister' },
  { key: 'versicherung', label: 'Versicherung' },
  { key: 'grundsteuer', label: 'Grundsteuer' },
  { key: 'allgemeinstrom', label: 'Allgemeinstrom' },
  { key: 'aufzug', label: 'Aufzug' },
];

export interface OperatingCosts {
  propertyId: string;
  year: number;
  distributionKeyId: string; // which key to use for splitting
  costs: Partial<Record<CostCategory, number>>;
  updatedAt: string;
}

export interface NkResult {
  unitId: string;
  unitLabel: string;
  tenant: string;
  share: number;          // %
  totalCost: number;      // anteilige Gesamtkosten
  prepaid: number;        // geleistete Vorauszahlungen (12 Monate)
  balance: number;        // + = Guthaben, - = Nachzahlung
  details: { category: string; amount: number }[];
}

// ── Storage paths ──────────────────────────────────────────────────────────

const ASSETS_DIR = path.join(
  process.env.HOME || '/root',
  '.openclaw/workspace/artifacts/personal/assets'
);
const PROPERTIES_FILE = path.join(ASSETS_DIR, 'properties.json');
const LEASES_FILE = path.join(ASSETS_DIR, 'leases.json');
const COSTS_DIR = path.join(ASSETS_DIR, 'operating-costs');

function ensureDir(): void {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.mkdirSync(COSTS_DIR, { recursive: true });
}

// ── Internal persistence ───────────────────────────────────────────────────

function loadProperties(): Property[] {
  ensureDir();
  if (!fs.existsSync(PROPERTIES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PROPERTIES_FILE, 'utf-8')) as Property[];
  } catch { return []; }
}

function saveProperties(props: Property[]): void {
  ensureDir();
  fs.writeFileSync(PROPERTIES_FILE, JSON.stringify(props, null, 2), 'utf-8');
}

function loadLeases(): Lease[] {
  ensureDir();
  if (!fs.existsSync(LEASES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(LEASES_FILE, 'utf-8')) as Lease[];
  } catch { return []; }
}

function saveLeases(leases: Lease[]): void {
  ensureDir();
  fs.writeFileSync(LEASES_FILE, JSON.stringify(leases, null, 2), 'utf-8');
}

function costsPath(propertyId: string, year: number): string {
  return path.join(COSTS_DIR, `${propertyId}-${year}.json`);
}

// ── Properties CRUD ────────────────────────────────────────────────────────

export function listProperties(): Property[] {
  return loadProperties();
}

export function getProperty(id: string): Property | null {
  return loadProperties().find(p => p.id === id) || null;
}

export function createProperty(
  id: string,
  label: string,
  address: string,
  type: PropertyType,
  owner: OwnerEntity,
  units?: Unit[],
  distributionKeys?: DistributionKey[],
): Property {
  const all = loadProperties();
  if (all.some(p => p.id === id)) throw new Error(`Property ${id} existiert bereits`);
  const now = new Date().toISOString();
  const prop: Property = {
    id, label, address, type, owner,
    units: units || [],
    distributionKeys: distributionKeys || [],
    createdAt: now, updatedAt: now,
  };
  all.push(prop);
  saveProperties(all);
  return prop;
}

export function updateProperty(id: string, patch: Partial<Omit<Property, 'id' | 'createdAt'>>): Property | null {
  const all = loadProperties();
  const idx = all.findIndex(p => p.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
  saveProperties(all);
  return all[idx];
}

export function deleteProperty(id: string): boolean {
  const all = loadProperties();
  const idx = all.findIndex(p => p.id === id);
  if (idx === -1) return false;
  all.splice(idx, 1);
  saveProperties(all);
  // Remove related leases
  const leases = loadLeases().filter(l => l.propertyId !== id);
  saveLeases(leases);
  return true;
}

// ── Units CRUD ─────────────────────────────────────────────────────────────

export function addUnit(propertyId: string, unit: Unit): Property | null {
  const all = loadProperties();
  const idx = all.findIndex(p => p.id === propertyId);
  if (idx === -1) return null;
  if (all[idx].units.some(u => u.id === unit.id)) {
    throw new Error(`Unit ${unit.id} existiert bereits in ${propertyId}`);
  }
  all[idx].units.push(unit);
  all[idx].updatedAt = new Date().toISOString();
  saveProperties(all);
  return all[idx];
}

export function updateUnit(propertyId: string, unitId: string, patch: Partial<Omit<Unit, 'id'>>): Property | null {
  const all = loadProperties();
  const pIdx = all.findIndex(p => p.id === propertyId);
  if (pIdx === -1) return null;
  const uIdx = all[pIdx].units.findIndex(u => u.id === unitId);
  if (uIdx === -1) return null;
  all[pIdx].units[uIdx] = { ...all[pIdx].units[uIdx], ...patch };
  all[pIdx].updatedAt = new Date().toISOString();
  saveProperties(all);
  return all[pIdx];
}

export function removeUnit(propertyId: string, unitId: string): Property | null {
  const all = loadProperties();
  const pIdx = all.findIndex(p => p.id === propertyId);
  if (pIdx === -1) return null;
  all[pIdx].units = all[pIdx].units.filter(u => u.id !== unitId);
  all[pIdx].updatedAt = new Date().toISOString();
  saveProperties(all);
  // Remove related leases
  const leases = loadLeases().filter(l => !(l.propertyId === propertyId && l.unitId === unitId));
  saveLeases(leases);
  return all[pIdx];
}

// ── Distribution Keys ──────────────────────────────────────────────────────

export function setDistributionKey(propertyId: string, key: DistributionKey): Property | null {
  const all = loadProperties();
  const pIdx = all.findIndex(p => p.id === propertyId);
  if (pIdx === -1) return null;
  const kIdx = all[pIdx].distributionKeys.findIndex(k => k.id === key.id);
  if (kIdx === -1) {
    all[pIdx].distributionKeys.push(key);
  } else {
    all[pIdx].distributionKeys[kIdx] = key;
  }
  all[pIdx].updatedAt = new Date().toISOString();
  saveProperties(all);
  return all[pIdx];
}

export function removeDistributionKey(propertyId: string, keyId: string): Property | null {
  const all = loadProperties();
  const pIdx = all.findIndex(p => p.id === propertyId);
  if (pIdx === -1) return null;
  all[pIdx].distributionKeys = all[pIdx].distributionKeys.filter(k => k.id !== keyId);
  all[pIdx].updatedAt = new Date().toISOString();
  saveProperties(all);
  return all[pIdx];
}

// ── Leases CRUD ────────────────────────────────────────────────────────────

export function listLeases(propertyId?: string): Lease[] {
  const all = loadLeases();
  if (propertyId) return all.filter(l => l.propertyId === propertyId);
  return all;
}

export function getLease(id: string): Lease | null {
  return loadLeases().find(l => l.id === id) || null;
}

export function getLeaseByUnit(unitId: string): Lease | null {
  return loadLeases().find(l => l.unitId === unitId) || null;
}

export function setLease(
  propertyId: string,
  unitId: string,
  data: Omit<Lease, 'id' | 'unitId' | 'propertyId' | 'createdAt' | 'updatedAt'>,
): Lease {
  const all = loadLeases();
  const now = new Date().toISOString();
  const existing = all.findIndex(l => l.unitId === unitId && l.propertyId === propertyId);

  if (existing !== -1) {
    all[existing] = { ...all[existing], ...data, updatedAt: now };
    saveLeases(all);

    // Update unit's lease reference and currentRent
    updateUnit(propertyId, unitId, {
      lease: all[existing].id,
      currentRent: data.rentNet,
      tenant: data.tenant,
    });

    return all[existing];
  }

  const lease: Lease = {
    id: `lease-${propertyId}-${unitId}`,
    unitId,
    propertyId,
    ...data,
    createdAt: now,
    updatedAt: now,
  };
  all.push(lease);
  saveLeases(all);

  // Update unit's lease reference and currentRent
  updateUnit(propertyId, unitId, {
    lease: lease.id,
    currentRent: data.rentNet,
    tenant: data.tenant,
  });

  return lease;
}

export function deleteLease(id: string): boolean {
  const all = loadLeases();
  const idx = all.findIndex(l => l.id === id);
  if (idx === -1) return false;
  const lease = all[idx];
  all.splice(idx, 1);
  saveLeases(all);

  // Clear unit's lease reference
  updateUnit(lease.propertyId, lease.unitId, {
    lease: null,
    currentRent: null,
    tenant: '',
  });

  return true;
}

// ── Operating Costs ────────────────────────────────────────────────────────

export function getOperatingCosts(propertyId: string, year: number): OperatingCosts | null {
  const fp = costsPath(propertyId, year);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8')) as OperatingCosts;
  } catch { return null; }
}

export function setOperatingCosts(propertyId: string, year: number, costs: Partial<Record<CostCategory, number>>, distributionKeyId: string): OperatingCosts {
  ensureDir();
  const now = new Date().toISOString();
  const oc: OperatingCosts = {
    propertyId,
    year,
    distributionKeyId,
    costs,
    updatedAt: now,
  };
  fs.writeFileSync(costsPath(propertyId, year), JSON.stringify(oc, null, 2), 'utf-8');
  return oc;
}

// ── Nebenkostenabrechnung ──────────────────────────────────────────────────

export function calculateNk(propertyId: string, year: number): NkResult[] {
  const prop = getProperty(propertyId);
  if (!prop) throw new Error(`Gebäude ${propertyId} nicht gefunden`);

  const oc = getOperatingCosts(propertyId, year);
  if (!oc) throw new Error(`Keine Nebenkosten für ${propertyId} / ${year}`);

  const dk = prop.distributionKeys.find(k => k.id === oc.distributionKeyId);
  if (!dk) throw new Error(`Verteilungsschlüssel ${oc.distributionKeyId} nicht gefunden`);

  const totalCosts = Object.values(oc.costs).reduce((s, v) => s + (v || 0), 0);
  const leases = loadLeases().filter(l => l.propertyId === propertyId);

  const results: NkResult[] = [];

  for (const unit of prop.units) {
    if (unit.rentType === 'vacant') continue;

    const share = dk.values[unit.id] || 0;
    const unitCost = totalCosts * (share / 100);

    // Find lease for prepaid calculation
    const lease = leases.find(l => l.unitId === unit.id);
    const monthlyPrepaid = lease?.operatingCosts || 0;
    const prepaid = monthlyPrepaid * 12;

    const balance = prepaid - unitCost; // positive = Guthaben

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
      share,
      totalCost: Math.round(unitCost * 100) / 100,
      prepaid: Math.round(prepaid * 100) / 100,
      balance: Math.round(balance * 100) / 100,
      details,
    });
  }

  return results;
}

// ── Formatting (Telegram) ──────────────────────────────────────────────────

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

// ── Initial Data Seeding ───────────────────────────────────────────────────

export function seedInitialData(): { created: number } {
  const existing = loadProperties();
  if (existing.length > 0) return { created: 0 };

  const now = new Date().toISOString();

  const properties: Property[] = [
    {
      id: 'l19',
      label: 'Leutenbergstr. 19',
      address: 'Leutenbergstr. 19, 78532 Tuttlingen',
      type: 'residential',
      owner: 'personal',
      units: [
        { id: 'l19-w1', label: 'W1 — EG links', floor: 'EG', sqm: null, rentType: 'permanent', tenant: '', lease: null, currentRent: null },
        { id: 'l19-w2', label: 'W2 — EG rechts', floor: 'EG', sqm: null, rentType: 'permanent', tenant: '', lease: null, currentRent: null },
        { id: 'l19-w3', label: 'W3 — OG links', floor: 'OG', sqm: null, rentType: 'temporary', tenant: '', lease: null, currentRent: null },
        { id: 'l19-w4', label: 'W4+ — OG rechts', floor: 'OG', sqm: null, rentType: 'temporary', tenant: '', lease: null, currentRent: null },
      ],
      distributionKeys: [
        { id: 'l19-miteigentumsanteil', label: 'Miteigentumsanteil', values: { 'l19-w1': 25, 'l19-w2': 25, 'l19-w3': 25, 'l19-w4': 25 } },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'mg24',
      label: 'Marktgasse 24',
      address: 'Marktgasse 24, 78532 Tuttlingen',
      type: 'residential',
      owner: 'personal',
      units: [],
      distributionKeys: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'd4',
      label: 'Daimlerstr. 4',
      address: 'Daimlerstr. 4, 78573 Wurmlingen',
      type: 'commercial',
      owner: 'personal',
      units: [
        { id: 'd4-h1', label: 'Halle', floor: 'EG', sqm: null, rentType: 'permanent', tenant: '', lease: null, currentRent: null },
      ],
      distributionKeys: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'n24',
      label: 'Nonnenburgstr. 24',
      address: 'Nonnenburgstr. 24, 78532 Tuttlingen',
      type: 'residential',
      owner: 'laperlgmbh',
      units: [],
      distributionKeys: [],
      createdAt: now,
      updatedAt: now,
    },
  ];

  saveProperties(properties);
  return { created: properties.length };
}
