/**
 * report-ledger — Meldungsdisziplin (2026-09-18)
 *
 * Der tägliche Health-Check (08:00 Berlin) läuft unverändert weiter, sein
 * Ergebnis landet hier im Ledger. Telegram gibt es nur noch bei Abweichung.
 * Montags 08:00 Berlin baut `buildWeeklySummary()` daraus — zusammen mit den
 * Trading-Kennzahlen aus GET /weekly-stats — genau EINE Wochen-Nachricht.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HealthReport } from './system-health.js';

const HOME = process.env.HOME || '/root';
const LEDGER_FILE = path.join(
  HOME,
  '.openclaw/workspace/artifacts/personal/health/report-ledger.json',
);
const TRADING_URL = 'http://127.0.0.1:18793';
const RETENTION_DAYS = 60;

export interface LedgerDay {
  date: string;              // YYYY-MM-DD (Berlin)
  status: HealthReport['status'];
  deviations: string[];      // Namen+Detail der nicht-grünen Checks
}

export interface TradingWeekly {
  healthGreen: number;
  healthTotal: number;
  trades: number;
  exits: number;
  pnl: number;
  netLiquidation: number | null;
  deviations: string[];
}

function loadLedger(): LedgerDay[] {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveLedger(days: LedgerDay[]): void {
  const trimmed = days
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-RETENTION_DAYS);
  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  const tmp = `${LEDGER_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf-8');
  fs.renameSync(tmp, LEDGER_FILE);
}

/** Abweichungen eines Health-Reports (alles was nicht 'ok' ist). */
export function healthDeviations(report: HealthReport): string[] {
  return report.checks
    .filter(c => c.status !== 'ok')
    .map(c => `${c.name}: ${c.detail}`);
}

export type DailyHealthAction = 'silent' | 'daily' | 'weekly';

/**
 * Was am 08:00-Tick passieren soll. Montag schluckt die Tagesmeldung —
 * die Wochen-Nachricht listet die Abweichungen des Tages mit, damit
 * montags genau EINE Nachricht rausgeht.
 */
export function dailyHealthAction(opts: {
  status: HealthReport['status'];
  mode: string;
  isMonday: boolean;
  weeklyEnabled: boolean;
}): DailyHealthAction {
  if (opts.isMonday && opts.weeklyEnabled) return 'weekly';
  if (opts.status === 'green' && opts.mode !== 'always') return 'silent';
  return 'daily';
}

export function recordHealthDay(date: string, report: HealthReport): LedgerDay {
  const entry: LedgerDay = {
    date,
    status: report.status,
    deviations: healthDeviations(report),
  };
  const days = loadLedger().filter(d => d.date !== date);
  days.push(entry);
  saveLedger(days);
  return entry;
}

/** Erster Tag des 7-Tage-Fensters, das auf `todayISO` endet. */
export function weekStart(todayISO: string): string {
  return new Date(new Date(`${todayISO}T00:00:00Z`).getTime() - 6 * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Letzte 7 Tage inkl. `todayISO`. */
export function healthWeek(todayISO: string): LedgerDay[] {
  const from = weekStart(todayISO);
  return loadLedger()
    .filter(d => d.date >= from && d.date <= todayISO)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchTradingWeekly(): Promise<TradingWeekly | null> {
  try {
    const res = await fetch(`${TRADING_URL}/weekly-stats`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    if (!j?.ok) return null;
    return {
      healthGreen: Number(j.healthGreen) || 0,
      healthTotal: Number(j.healthTotal) || 0,
      trades: Number(j.trades) || 0,
      exits: Number(j.exits) || 0,
      pnl: Number(j.pnl) || 0,
      netLiquidation: j.netLiquidation === null ? null : Number(j.netLiquidation),
      deviations: Array.isArray(j.deviations) ? j.deviations.map(String) : [],
    };
  } catch {
    return null;
  }
}

/**
 * Baut die Wochen-Zusammenfassung. `todayISO` ist der Montag (Berlin),
 * an dem gesendet wird; das Fenster umfasst die 7 Tage bis einschließlich heute.
 */
export async function buildWeeklySummary(todayISO: string): Promise<string> {
  const week = healthWeek(todayISO);
  const trading = await fetchTradingWeekly();

  const greenDays = week.filter(d => d.status === 'green').length;
  const sysDeviations = week
    .filter(d => d.status !== 'green')
    .flatMap(d => d.deviations.map(dev => `${d.date}: ${dev}`));

  const tradingDeviations = trading?.deviations ?? [];
  const allOk = sysDeviations.length === 0 && tradingDeviations.length === 0;

  const from = weekStart(todayISO);
  const lines: string[] = [];

  lines.push(allOk ? '🟢 *Woche OK*' : '🟡 *Wochenbericht — mit Abweichungen*');
  lines.push('');
  lines.push(`*${from} → ${todayISO}*`);
  lines.push('');
  lines.push(
    week.length > 0
      ? `Health-Checks: ${greenDays}/${week.length} grün`
      : 'Health-Checks: keine Daten im Fenster',
  );

  if (trading) {
    const pnlSign = trading.pnl >= 0 ? '+' : '';
    lines.push(
      `Trading: ${trading.trades} Trades / ${trading.exits} geschlossen, ` +
      `P&L ${pnlSign}$${trading.pnl.toFixed(2)}` +
      (trading.netLiquidation !== null ? `, NLV $${trading.netLiquidation.toFixed(0)}` : ''),
    );
    lines.push(`Trading-Health: ${trading.healthGreen}/${trading.healthTotal} grün`);
  } else {
    lines.push('Trading: keine Daten (Trading-Agent nicht erreichbar)');
  }

  lines.push(`Anomalien: ${sysDeviations.length + tradingDeviations.length}`);

  if (!allOk) {
    lines.push('');
    lines.push('*Abweichungen:*');
    for (const d of [...sysDeviations, ...tradingDeviations]) lines.push(`• ${d}`);
  }

  return lines.join('\n');
}
