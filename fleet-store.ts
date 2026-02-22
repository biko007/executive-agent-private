import fs from 'fs';
import path from 'path';
import { updateEntityId } from './link-store.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type VehicleType = 'car' | 'bike';

export interface ServiceEntry {
  date: string;
  type: string;
  mileage?: number;
  cost?: number;
  notes?: string;
}

export interface VehicleDocument {
  filename: string;
  label: string;
  uploadedAt: string;
}

export interface Insurance {
  provider: string;
  policyNumber?: string;
  type: string;
  validUntil?: string;
  annualCost?: number;
}

export interface Vehicle {
  id: string;
  type: VehicleType;
  name: string;
  plate?: string;
  vin?: string;
  make: string;
  model: string;
  year: number;
  color?: string;
  mileage?: number;
  tuevDate?: string;
  insurance?: Insurance;
  serviceLog: ServiceEntry[];
  documents: VehicleDocument[];
  createdAt: string;
  updatedAt: string;
}

export type DeadlineSeverity = 'info' | 'warning' | 'overdue';

export interface DeadlineWarning {
  vehicleId: string;
  vehicleName: string;
  vehicleType: VehicleType;
  field: 'tuev' | 'insurance';
  date: string;
  daysLeft: number;
  severity: DeadlineSeverity;
}

// ── Storage paths ──────────────────────────────────────────────────────────

const FLEET_DIR = path.join(
  process.env.HOME || '/root',
  '.openclaw/workspace/artifacts/personal/fleet'
);
const VEHICLES_FILE = path.join(FLEET_DIR, 'vehicles.json');
const DOCS_DIR = path.join(FLEET_DIR, 'docs');

function ensureDir(): void {
  fs.mkdirSync(FLEET_DIR, { recursive: true });
}

function docsDir(vehicleId: string): string {
  return path.join(DOCS_DIR, vehicleId);
}

// ── Internal persistence ───────────────────────────────────────────────────

function loadAll(): Vehicle[] {
  ensureDir();
  if (!fs.existsSync(VEHICLES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(VEHICLES_FILE, 'utf-8')) as Vehicle[];
  } catch {
    return [];
  }
}

function saveAll(vehicles: Vehicle[]): void {
  ensureDir();
  fs.writeFileSync(VEHICLES_FILE, JSON.stringify(vehicles, null, 2), 'utf-8');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function makeReadableId(make: string, model: string, existingIds: string[]): string {
  const base = 'v-' + slugify(make) + '-' + slugify(model);
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export function getAllVehicles(): Vehicle[] {
  return loadAll();
}

export function getVehicle(id: string): Vehicle | null {
  return loadAll().find(v => v.id === id) || null;
}

export function createVehicle(
  type: VehicleType,
  make: string,
  model: string,
  year: number,
  opts?: Partial<Pick<Vehicle, 'name' | 'plate' | 'vin' | 'color' | 'mileage'>>
): Vehicle {
  const all = loadAll();
  const now = new Date().toISOString();
  const vehicle: Vehicle = {
    id: makeReadableId(make, model, all.map(v => v.id)),
    type,
    name: opts?.name || `${make} ${model}`,
    plate: opts?.plate,
    vin: opts?.vin,
    make,
    model,
    year,
    color: opts?.color,
    mileage: opts?.mileage,
    serviceLog: [],
    documents: [],
    createdAt: now,
    updatedAt: now,
  };
  all.push(vehicle);
  saveAll(all);
  return vehicle;
}

export function updateVehicle(id: string, updates: Partial<Omit<Vehicle, 'id' | 'createdAt'>>): Vehicle | null {
  const all = loadAll();
  const idx = all.findIndex(v => v.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...updates, updatedAt: new Date().toISOString() };
  saveAll(all);
  return all[idx];
}

export function deleteVehicle(id: string): boolean {
  const all = loadAll();
  const idx = all.findIndex(v => v.id === id);
  if (idx === -1) return false;
  all.splice(idx, 1);
  saveAll(all);
  // Clean up docs directory
  const dd = docsDir(id);
  if (fs.existsSync(dd)) fs.rmSync(dd, { recursive: true, force: true });
  return true;
}

// ── ID change & migration ─────────────────────────────────────────────────

export function changeVehicleId(oldId: string, newId: string): Vehicle | null {
  if (!/^v-[a-z0-9]+(-[a-z0-9]+)*$/.test(newId) || newId.length < 4) return null;
  const all = loadAll();
  if (all.some(v => v.id === newId)) return null;
  const idx = all.findIndex(v => v.id === oldId);
  if (idx === -1) return null;
  all[idx].id = newId;
  all[idx].updatedAt = new Date().toISOString();
  saveAll(all);
  // Rename docs directory
  const oldDir = docsDir(oldId);
  const newDir = docsDir(newId);
  if (fs.existsSync(oldDir)) fs.renameSync(oldDir, newDir);
  // Update link-store references
  updateEntityId('fleet', oldId, newId);
  return all[idx];
}

export function migrateHexIds(): { oldId: string; newId: string }[] {
  const all = loadAll();
  const results: { oldId: string; newId: string }[] = [];
  const hexPattern = /^v-[0-9a-f]{6}$/;
  const toMigrate = all.filter(v => hexPattern.test(v.id));
  for (const v of toMigrate) {
    const currentIds = loadAll().map(x => x.id);
    const newId = makeReadableId(v.make, v.model, currentIds);
    const result = changeVehicleId(v.id, newId);
    if (result) results.push({ oldId: v.id, newId });
  }
  return results;
}

// ── Service log ────────────────────────────────────────────────────────────

export function addServiceEntry(id: string, entry: ServiceEntry): Vehicle | null {
  const all = loadAll();
  const idx = all.findIndex(v => v.id === id);
  if (idx === -1) return null;
  all[idx].serviceLog.push(entry);
  // Update mileage if the entry's mileage is higher
  if (entry.mileage != null && (all[idx].mileage == null || entry.mileage > all[idx].mileage)) {
    all[idx].mileage = entry.mileage;
  }
  all[idx].updatedAt = new Date().toISOString();
  saveAll(all);
  return all[idx];
}

// ── Insurance & TÜV ───────────────────────────────────────────────────────

export function setInsurance(id: string, insurance: Insurance): Vehicle | null {
  return updateVehicle(id, { insurance });
}

export function setTuevDate(id: string, date: string): Vehicle | null {
  return updateVehicle(id, { tuevDate: date });
}

// ── Documents ──────────────────────────────────────────────────────────────

export function addDocument(id: string, filename: string, label: string): Vehicle | null {
  const all = loadAll();
  const idx = all.findIndex(v => v.id === id);
  if (idx === -1) return null;
  // Ensure docs directory exists
  fs.mkdirSync(docsDir(id), { recursive: true });
  const doc: VehicleDocument = {
    filename,
    label,
    uploadedAt: new Date().toISOString(),
  };
  all[idx].documents.push(doc);
  all[idx].updatedAt = new Date().toISOString();
  saveAll(all);
  return all[idx];
}

export function removeDocument(id: string, filename: string): Vehicle | null {
  const all = loadAll();
  const idx = all.findIndex(v => v.id === id);
  if (idx === -1) return null;
  all[idx].documents = all[idx].documents.filter(d => d.filename !== filename);
  all[idx].updatedAt = new Date().toISOString();
  saveAll(all);
  // Remove file from disk
  const fp = path.join(docsDir(id), filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  return all[idx];
}

// ── Deadline check ─────────────────────────────────────────────────────────

export function checkDeadlines(): DeadlineWarning[] {
  const warnings: DeadlineWarning[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const v of loadAll()) {
    // TÜV deadline
    if (v.tuevDate) {
      const d = new Date(v.tuevDate);
      d.setHours(0, 0, 0, 0);
      const daysLeft = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      if (daysLeft <= 90) {
        warnings.push({
          vehicleId: v.id,
          vehicleName: v.name,
          vehicleType: v.type,
          field: 'tuev',
          date: v.tuevDate,
          daysLeft,
          severity: daysLeft < 0 ? 'overdue' : daysLeft <= 30 ? 'warning' : 'info',
        });
      }
    }
    // Insurance deadline
    if (v.insurance?.validUntil) {
      const d = new Date(v.insurance.validUntil);
      d.setHours(0, 0, 0, 0);
      const daysLeft = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      if (daysLeft <= 90) {
        warnings.push({
          vehicleId: v.id,
          vehicleName: v.name,
          vehicleType: v.type,
          field: 'insurance',
          date: v.insurance.validUntil,
          daysLeft,
          severity: daysLeft < 0 ? 'overdue' : daysLeft <= 30 ? 'warning' : 'info',
        });
      }
    }
  }

  // Sort: overdue first, then by daysLeft ascending
  warnings.sort((a, b) => a.daysLeft - b.daysLeft);
  return warnings;
}

// ── Formatting ─────────────────────────────────────────────────────────────

function vehicleIcon(type: VehicleType): string {
  return type === 'car' ? '🚗' : '🚲';
}

function tuevStatus(tuevDate?: string): string {
  if (!tuevDate) return '❓ kein TÜV-Datum';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(tuevDate);
  d.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  const dateStr = formatDE(tuevDate);
  if (days < 0) return `🔴 überfällig seit ${Math.abs(days)} Tagen`;
  if (days <= 30) return `⚠️ in ${days} Tagen (${dateStr})`;
  if (days <= 90) return `ℹ️ in ${days} Tagen (${dateStr})`;
  return `✅ ${dateStr}`;
}

function formatDE(isoDate: string): string {
  const d = new Date(isoDate);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

export function formatVehicleList(vehicles: Vehicle[]): string {
  if (!vehicles.length) return '🚗 Keine Fahrzeuge im Fuhrpark.';

  const lines = vehicles.map(v => {
    const icon = vehicleIcon(v.type);
    const plate = v.plate ? ` [${v.plate}]` : '';
    const km = v.mileage != null ? ` | ${v.mileage.toLocaleString('de')} km` : '';
    const tuev = v.tuevDate ? ` | TÜV: ${tuevStatus(v.tuevDate)}` : '';
    return `${icon} **${v.name}**${plate} (${v.year})${km}${tuev}\n   ID: \`${v.id}\``;
  });

  return `🚗 Fuhrpark (${vehicles.length}):\n\n${lines.join('\n\n')}`;
}

export function formatVehicleDetail(v: Vehicle): string {
  const icon = vehicleIcon(v.type);
  const lines: string[] = [
    `${icon} **${v.name}**`,
    '',
    `Typ: ${v.type === 'car' ? 'Auto' : 'Fahrrad'}`,
    `Hersteller: ${v.make}`,
    `Modell: ${v.model}`,
    `Baujahr: ${v.year}`,
  ];

  if (v.plate) lines.push(`Kennzeichen: ${v.plate}`);
  if (v.vin) lines.push(`FIN: ${v.vin}`);
  if (v.color) lines.push(`Farbe: ${v.color}`);
  if (v.mileage != null) lines.push(`km-Stand: ${v.mileage.toLocaleString('de')} km`);
  if (v.tuevDate) lines.push(`TÜV: ${tuevStatus(v.tuevDate)}`);

  if (v.insurance) {
    lines.push('');
    lines.push('🛡 Versicherung:');
    lines.push(`   Anbieter: ${v.insurance.provider}`);
    lines.push(`   Typ: ${v.insurance.type}`);
    if (v.insurance.policyNumber) lines.push(`   Policen-Nr: ${v.insurance.policyNumber}`);
    if (v.insurance.validUntil) lines.push(`   Gültig bis: ${formatDE(v.insurance.validUntil)}`);
    if (v.insurance.annualCost != null) lines.push(`   Kosten/Jahr: ${v.insurance.annualCost} €`);
  }

  if (v.serviceLog.length) {
    lines.push('');
    lines.push(`🔧 Service-Historie (${v.serviceLog.length}):`);
    for (const s of v.serviceLog.slice(-5)) {
      const km = s.mileage != null ? ` | ${s.mileage.toLocaleString('de')} km` : '';
      const cost = s.cost != null ? ` | ${s.cost} €` : '';
      const notes = s.notes ? ` — ${s.notes}` : '';
      lines.push(`   • ${formatDE(s.date)} ${s.type}${km}${cost}${notes}`);
    }
    if (v.serviceLog.length > 5) lines.push(`   ... und ${v.serviceLog.length - 5} weitere`);
  }

  if (v.documents.length) {
    lines.push('');
    lines.push(`📎 Dokumente (${v.documents.length}):`);
    for (const d of v.documents) {
      lines.push(`   • ${d.label} (${d.filename})`);
    }
  }

  lines.push('');
  lines.push(`ID: \`${v.id}\` | Erstellt: ${formatDE(v.createdAt)}`);

  return lines.join('\n');
}
