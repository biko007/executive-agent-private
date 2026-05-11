/**
 * pe/store — Data access layer for Private Equity investments.
 */
import fs from 'fs';
import path from 'path';
import type { PEInvestment, ValuationEntry } from './types.js';

// ── Storage paths ──────────────────────────────────────────────────────────

const PE_DIR = path.join(
  process.env.HOME || '/root',
  '.openclaw/workspace/artifacts/personal/private-equity'
);
const INVESTMENTS_FILE = path.join(PE_DIR, 'investments.json');
const VALUATIONS_FILE = path.join(PE_DIR, 'valuations.jsonl');

function ensureDir(): void {
  fs.mkdirSync(PE_DIR, { recursive: true });
}

// ── Internal persistence ───────────────────────────────────────────────────

function loadAll(): PEInvestment[] {
  ensureDir();
  if (!fs.existsSync(INVESTMENTS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(INVESTMENTS_FILE, 'utf-8')) as PEInvestment[];
  } catch {
    return [];
  }
}

function saveAll(investments: PEInvestment[]): void {
  ensureDir();
  fs.writeFileSync(INVESTMENTS_FILE, JSON.stringify(investments, null, 2), 'utf-8');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function makeId(company: string, existingIds: string[]): string {
  const base = slugify(company);
  if (!base) return 'pe-' + Date.now();
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export function getAllInvestments(): PEInvestment[] {
  return loadAll();
}

export function getInvestment(id: string): PEInvestment | null {
  return loadAll().find(inv => inv.id === id) || null;
}

export function createInvestment(
  company: string,
  sector: string,
  investedAmount: number,
  shares: number,
  totalShares: number,
  opts?: Partial<Pick<PEInvestment, 'investmentDate' | 'valuationMethod' | 'contactPerson' | 'notes' | 'status'>>
): PEInvestment {
  const all = loadAll();
  const now = new Date().toISOString();
  const ownershipPct = totalShares > 0 ? Math.round((shares / totalShares) * 10000) / 100 : 0;
  const inv: PEInvestment = {
    id: makeId(company, all.map(i => i.id)),
    company,
    sector,
    investmentDate: opts?.investmentDate || now.slice(0, 10),
    shares,
    totalShares,
    ownershipPct,
    investedAmount,
    currentValuation: investedAmount,
    valuationDate: now.slice(0, 10),
    valuationMethod: opts?.valuationMethod || 'cost',
    status: opts?.status || 'active',
    contactPerson: opts?.contactPerson,
    notes: opts?.notes,
    createdAt: now,
    updatedAt: now,
  };
  all.push(inv);
  saveAll(all);
  return inv;
}

export function updateInvestment(id: string, updates: Partial<Omit<PEInvestment, 'id' | 'createdAt'>>): PEInvestment | null {
  const all = loadAll();
  const idx = all.findIndex(inv => inv.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...updates, updatedAt: new Date().toISOString() };
  // Recalc ownership if shares changed
  if (updates.shares !== undefined || updates.totalShares !== undefined) {
    const s = all[idx].shares;
    const t = all[idx].totalShares;
    all[idx].ownershipPct = t > 0 ? Math.round((s / t) * 10000) / 100 : 0;
  }
  saveAll(all);
  return all[idx];
}

export function deleteInvestment(id: string): boolean {
  const all = loadAll();
  const idx = all.findIndex(inv => inv.id === id);
  if (idx === -1) return false;
  all.splice(idx, 1);
  saveAll(all);
  return true;
}

// ── Valuations ─────────────────────────────────────────────────────────────

export function addValuation(investmentId: string, amount: number, method?: string, notes?: string): ValuationEntry | null {
  const all = loadAll();
  const idx = all.findIndex(inv => inv.id === investmentId);
  if (idx === -1) return null;
  const now = new Date().toISOString();
  const entry: ValuationEntry = {
    investmentId,
    date: now.slice(0, 10),
    amount,
    method: method || all[idx].valuationMethod,
    notes,
  };
  ensureDir();
  fs.appendFileSync(VALUATIONS_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  all[idx].currentValuation = amount;
  all[idx].valuationDate = entry.date;
  if (method) all[idx].valuationMethod = method;
  all[idx].updatedAt = now;
  saveAll(all);
  return entry;
}

export function getValuationHistory(investmentId: string): ValuationEntry[] {
  ensureDir();
  if (!fs.existsSync(VALUATIONS_FILE)) return [];
  try {
    return fs.readFileSync(VALUATIONS_FILE, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as ValuationEntry)
      .filter(e => e.investmentId === investmentId);
  } catch {
    return [];
  }
}

// ── IRR calculation ────────────────────────────────────────────────────────

export function calculateIRR(investedAmount: number, currentValuation: number, investmentDate: string, valuationDate: string): number {
  const start = new Date(investmentDate);
  const end = new Date(valuationDate);
  const years = (end.getTime() - start.getTime()) / (365.25 * 86_400_000);
  if (years <= 0 || investedAmount <= 0) return 0;
  const ratio = currentValuation / investedAmount;
  if (ratio <= 0) return -100;
  return (Math.pow(ratio, 1 / years) - 1) * 100;
}

// ── Formatting ─────────────────────────────────────────────────────────────

function formatDE(isoDate: string): string {
  const d = new Date(isoDate);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function fmtEur(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function statusIcon(status: string): string {
  return status === 'active' ? '🟢' : status === 'exited' ? '🔵' : '🔴';
}

export function formatInvestmentList(investments: PEInvestment[]): string {
  if (!investments.length) return '💼 Keine Private-Equity-Beteiligungen vorhanden.';

  const totalInvested = investments.reduce((s, i) => s + i.investedAmount, 0);
  const totalValuation = investments.reduce((s, i) => s + i.currentValuation, 0);
  const active = investments.filter(i => i.status === 'active').length;

  const lines = investments.map(inv => {
    const irr = calculateIRR(inv.investedAmount, inv.currentValuation, inv.investmentDate, inv.valuationDate);
    return `${statusIcon(inv.status)} **${inv.company}**\n` +
      `   ${inv.sector} | ${inv.ownershipPct}% | ${fmtEur(inv.investedAmount)} → ${fmtEur(inv.currentValuation)} | IRR: ${irr.toFixed(1)}%\n` +
      `   ID: \`${inv.id}\``;
  });

  return `💼 Private Equity (${investments.length} Beteiligungen, ${active} aktiv)\n\n` +
    `Investiert: ${fmtEur(totalInvested)} | Bewertung: ${fmtEur(totalValuation)}\n\n` +
    lines.join('\n\n');
}

export function formatInvestmentDetail(inv: PEInvestment): string {
  const irr = calculateIRR(inv.investedAmount, inv.currentValuation, inv.investmentDate, inv.valuationDate);
  const lines: string[] = [
    `${statusIcon(inv.status)} **${inv.company}**`,
    '',
    `Sektor: ${inv.sector}`,
    `Status: ${inv.status}`,
    `Investiert: ${fmtEur(inv.investedAmount)} am ${formatDE(inv.investmentDate)}`,
    `Anteile: ${inv.shares.toLocaleString('de')} / ${inv.totalShares.toLocaleString('de')} (${inv.ownershipPct}%)`,
    `Aktuelle Bewertung: ${fmtEur(inv.currentValuation)} (${formatDE(inv.valuationDate)})`,
    `Methode: ${inv.valuationMethod}`,
    `IRR: ${irr.toFixed(1)}%`,
  ];

  if (inv.contactPerson) lines.push(`Kontakt: ${inv.contactPerson}`);
  if (inv.notes) lines.push(`Notizen: ${inv.notes}`);

  lines.push('');
  lines.push(`ID: \`${inv.id}\` | Erstellt: ${formatDE(inv.createdAt)}`);

  return lines.join('\n');
}
