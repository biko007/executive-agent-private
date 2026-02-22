import fs from 'fs';
import path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

export type HealthEntryType =
  | 'weight'
  | 'body_fat'
  | 'sleep'
  | 'steps'
  | 'heartrate'
  | 'activity'
  | 'symptom'
  | 'log';

export interface HealthEntry {
  id: string;
  type: HealthEntryType;
  timestamp: string;        // ISO 8601
  // weight / body_fat
  value?: number;           // kg (weight), % (body_fat)
  unit?: string;
  // sleep
  quality?: number;         // 1–5 (manual) | Withings sleep score 0–100
  deep_sleep_h?: number;
  rem_sleep_h?: number;
  light_sleep_h?: number;
  // steps / activity
  steps?: number;
  distance_m?: number;
  calories?: number;
  activity_type?: string;   // 'running', 'walking', etc.
  duration_min?: number;
  // heart rate
  hr_avg?: number;
  hr_min?: number;
  hr_max?: number;
  // free text
  text?: string;
  // source
  source?: 'manual' | 'withings';
}

// ── Storage ────────────────────────────────────────────────────────────────

const HEALTH_DIR = path.join(
  process.env.HOME || '/root',
  '.openclaw/workspace/artifacts/personal/health'
);
const LOG_FILE = path.join(HEALTH_DIR, 'health-log.jsonl');

function ensureDir(): void {
  fs.mkdirSync(HEALTH_DIR, { recursive: true });
}

// ── Dedup check ───────────────────────────────────────────────────────────

/** Returns true if an entry with the same type and date already exists */
export function hasEntryForDate(type: HealthEntryType, dateStr: string): boolean {
  const all = readEntries();
  return all.some(e => e.type === type && e.timestamp.slice(0, 10) === dateStr);
}

// ── Append-only write ──────────────────────────────────────────────────────

export function appendEntry(entry: Omit<HealthEntry, 'id' | 'timestamp'>): HealthEntry {
  ensureDir();
  const e: HealthEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(e) + '\n', 'utf-8');
  return e;
}

export function appendEntryWithTimestamp(
  ts: Date,
  entry: Omit<HealthEntry, 'id' | 'timestamp'>
): HealthEntry {
  ensureDir();
  const e: HealthEntry = {
    id: `${ts.getTime()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: ts.toISOString(),
    ...entry,
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(e) + '\n', 'utf-8');
  return e;
}

// ── Read ───────────────────────────────────────────────────────────────────

export function readEntries(since?: Date, until?: Date): HealthEntry[] {
  ensureDir();
  if (!fs.existsSync(LOG_FILE)) return [];

  const lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean);
  const out: HealthEntry[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as HealthEntry;
      const ts = new Date(e.timestamp);
      if (since && ts < since) continue;
      if (until && ts > until) continue;
      out.push(e);
    } catch { /* corrupt line → skip */ }
  }
  return out;
}

export function lastEntry(type: HealthEntryType): HealthEntry | null {
  const all = readEntries().filter(e => e.type === type);
  return all.length ? all[all.length - 1] : null;
}

// ── Summary ────────────────────────────────────────────────────────────────

export interface HealthSummary {
  from: string;
  to: string;
  weights: number[];
  bodyFats: number[];
  sleepHours: number[];
  deepSleepHours: number[];
  remSleepHours: number[];
  sleepScores: number[];
  stepsArr: number[];
  hrAvgs: number[];
  activities: string[];
  symptoms: string[];
  logs: string[];
}

export function summarize(entries: HealthEntry[]): HealthSummary {
  const weights: number[]      = [];
  const bodyFats: number[]     = [];
  const sleepHours: number[]   = [];
  const deepSleepHours: number[] = [];
  const remSleepHours: number[]  = [];
  const sleepScores: number[]  = [];
  const stepsArr: number[]     = [];
  const hrAvgs: number[]       = [];
  const activities: string[]   = [];
  const symptoms: string[]     = [];
  const logs: string[]         = [];

  for (const e of entries) {
    const day = e.timestamp.slice(0, 10);
    switch (e.type) {
      case 'weight':
        if (e.value != null) weights.push(e.value);
        break;
      case 'body_fat':
        if (e.value != null) bodyFats.push(e.value);
        break;
      case 'sleep':
        if (e.value != null) sleepHours.push(e.value);
        if (e.deep_sleep_h != null) deepSleepHours.push(e.deep_sleep_h);
        if (e.rem_sleep_h != null) remSleepHours.push(e.rem_sleep_h);
        if (e.quality != null) sleepScores.push(e.quality);
        break;
      case 'steps':
        if (e.steps != null) stepsArr.push(e.steps);
        break;
      case 'heartrate':
        if (e.hr_avg != null) hrAvgs.push(e.hr_avg);
        break;
      case 'activity':
        if (e.activity_type) {
          const dur = e.duration_min ? ` ${e.duration_min} min` : '';
          const kcal = e.calories ? ` ${Math.round(e.calories)} kcal` : '';
          activities.push(`${day}: ${e.activity_type}${dur}${kcal}`);
        }
        break;
      case 'symptom':
        if (e.text) symptoms.push(`${day}: ${e.text}`);
        break;
      case 'log':
        if (e.text) logs.push(`${day}: ${e.text}`);
        break;
    }
  }

  const ts = entries.map(e => e.timestamp).sort();
  return {
    from: ts[0]?.slice(0, 10) || '–',
    to:   ts[ts.length - 1]?.slice(0, 10) || '–',
    weights, bodyFats, sleepHours, deepSleepHours, remSleepHours,
    sleepScores, stepsArr, hrAvgs, activities, symptoms, logs,
  };
}

function avg(arr: number[], dec = 1): string {
  if (!arr.length) return '–';
  return (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(dec);
}
function minMax(arr: number[], dec = 1): string {
  if (!arr.length) return '–';
  return `${Math.min(...arr).toFixed(dec)} – ${Math.max(...arr).toFixed(dec)}`;
}
function last(arr: number[], dec = 1): string {
  return arr.length ? arr[arr.length - 1].toFixed(dec) : '–';
}

export function formatSummary(s: HealthSummary, label: string): string {
  const lines: string[] = [`🏥 Health ${label} (${s.from} → ${s.to})\n`];

  lines.push(`⚖️ Gewicht (${s.weights.length} Einträge)`);
  if (s.weights.length) {
    lines.push(`   Letzte: ${last(s.weights)} kg  |  Ø ${avg(s.weights)} kg  |  ${minMax(s.weights)} kg`);
  }

  if (s.bodyFats.length) {
    lines.push(`\n🫀 Körperfett (${s.bodyFats.length} Einträge)`);
    lines.push(`   Letzte: ${last(s.bodyFats)} %  |  Ø ${avg(s.bodyFats)} %`);
  }

  lines.push(`\n😴 Schlaf (${s.sleepHours.length} Einträge)`);
  if (s.sleepHours.length) {
    lines.push(`   Ø ${avg(s.sleepHours)} h  |  ${minMax(s.sleepHours)} h`);
  }
  if (s.deepSleepHours.length) lines.push(`   Tiefschlaf Ø ${avg(s.deepSleepHours)} h`);
  if (s.remSleepHours.length)  lines.push(`   REM Ø ${avg(s.remSleepHours)} h`);
  if (s.sleepScores.length)    lines.push(`   Score Ø ${avg(s.sleepScores, 0)} / 100`);

  lines.push(`\n👟 Schritte (${s.stepsArr.length} Tage)`);
  if (s.stepsArr.length) {
    lines.push(`   Ø ${avg(s.stepsArr, 0)}  |  Max ${Math.max(...s.stepsArr).toLocaleString('de')}`);
  }

  if (s.hrAvgs.length) {
    lines.push(`\n❤️ Herzfrequenz Ø ${avg(s.hrAvgs, 0)} bpm  (${s.hrAvgs.length} Messungen)`);
  }

  if (s.activities.length) {
    lines.push(`\n🏃 Aktivitäten:`);
    s.activities.slice(-5).forEach(a => lines.push(`   • ${a}`));
  }

  if (s.symptoms.length) {
    lines.push(`\n🤒 Symptome:`);
    s.symptoms.forEach(sym => lines.push(`   • ${sym}`));
  }

  if (s.logs.length) {
    lines.push(`\n📝 Logs:`);
    s.logs.slice(-5).forEach(l => lines.push(`   • ${l}`));
  }

  return lines.join('\n');
}

// ── Trend Analysis ──────────────────────────────────────────────────────────

export type TrendDirection = 'up' | 'down' | 'stable';

export interface WeightTrend {
  current: number;
  min: number;
  max: number;
  avg: number;
  change: number;
  direction: TrendDirection;
  dataPoints: number;
}

export interface SleepTrend {
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  avgQuality: number;
  dataPoints: number;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface HealthAlert {
  type: string;
  severity: AlertSeverity;
  message: string;
}

function numAvg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

export function getWeightTrend(days: 7 | 30 | 90): WeightTrend | null {
  const since = new Date(Date.now() - days * 86_400_000);
  const entries = readEntries(since).filter(e => e.type === 'weight' && e.value != null);
  if (!entries.length) return null;

  const values = entries.map(e => e.value!);
  const current = values[values.length - 1];
  const first = values[0];
  const change = +(current - first).toFixed(2);
  const direction: TrendDirection = Math.abs(change) < 0.3 ? 'stable' : change > 0 ? 'up' : 'down';

  return {
    current: +current.toFixed(1),
    min: +Math.min(...values).toFixed(1),
    max: +Math.max(...values).toFixed(1),
    avg: +numAvg(values).toFixed(1),
    change: +change.toFixed(1),
    direction,
    dataPoints: values.length,
  };
}

export function getSleepTrend(days: 7 | 30 | 90): SleepTrend | null {
  const since = new Date(Date.now() - days * 86_400_000);
  const entries = readEntries(since).filter(e => e.type === 'sleep' && e.value != null);
  if (!entries.length) return null;

  // Aggregate sessions per night (sum durations, collect qualities)
  const byNight = new Map<string, { total: number; qualities: number[] }>();
  for (const e of entries) {
    const day = e.timestamp.slice(0, 10);
    const prev = byNight.get(day) || { total: 0, qualities: [] };
    prev.total += e.value!;
    if (e.quality != null && e.quality > 0) prev.qualities.push(e.quality);
    byNight.set(day, prev);
  }

  const durations = Array.from(byNight.values()).map(n => n.total);
  const qualities = Array.from(byNight.values()).flatMap(n => n.qualities);

  return {
    avgDuration: +numAvg(durations).toFixed(1),
    minDuration: +Math.min(...durations).toFixed(1),
    maxDuration: +Math.max(...durations).toFixed(1),
    avgQuality: qualities.length ? +numAvg(qualities).toFixed(0) : 0,
    dataPoints: durations.length,
  };
}

export function checkHealthAlerts(): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  const now = Date.now();

  // Sleep < 6h on 3+ of last 7 nights → warning
  const sevenDaysAgo = new Date(now - 7 * 86_400_000);
  const recentSleep = readEntries(sevenDaysAgo).filter(e => e.type === 'sleep' && e.value != null);
  // Aggregate sessions per night (sum durations)
  const sleepByDay = new Map<string, number>();
  for (const s of recentSleep) {
    const day = s.timestamp.slice(0, 10);
    sleepByDay.set(day, (sleepByDay.get(day) ?? 0) + (s.value ?? 0));
  }
  const shortNights = Array.from(sleepByDay.values()).filter(h => h < 6).length;
  if (shortNights >= 3) {
    alerts.push({ type: 'sleep_low_week', severity: 'warning', message: `Schlaf unter 6h an ${shortNights} von 7 Tagen` });
  }

  // Sleep < 5h last night → critical
  const lastSleepValues = Array.from(sleepByDay.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  if (lastSleepValues.length && lastSleepValues[0][1] < 5) {
    alerts.push({ type: 'sleep_critical', severity: 'critical', message: `Schlaf letzte Nacht nur ${lastSleepValues[0][1].toFixed(1)}h` });
  }

  // Weight change > 2kg in 7 days → warning
  const wt = getWeightTrend(7);
  if (wt && Math.abs(wt.change) > 2) {
    const dir = wt.change > 0 ? '+' : '';
    alerts.push({ type: 'weight_change', severity: 'warning', message: `Gewichtsveränderung ${dir}${wt.change} kg in 7 Tagen` });
  }

  // No Withings data for 3+ days → info
  const threeDaysAgo = new Date(now - 3 * 86_400_000);
  const recentWithings = readEntries(threeDaysAgo).filter(e => e.source === 'withings');
  if (!recentWithings.length) {
    alerts.push({ type: 'no_withings_data', severity: 'info', message: 'Keine Withings-Daten seit 3+ Tagen' });
  }

  return alerts;
}
