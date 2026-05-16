/**
 * health/store — Data access layer for health entries (Postgres-backed).
 *
 * Sprint 4: Migrated from JSONL append-only log to openclaw_core.health_logs.
 */
import { query as dbQuery } from '../../shared/db/index.js';
import type {
  HealthEntryType, HealthEntry, HealthSummary,
  WeightTrend, SleepTrend, HeartrateTrend, TrendDirection, HealthAlert,
} from './types.js';

// ── Valid types (must match CHECK constraint in V021) ────────────────────────

const VALID_TYPES = new Set<string>([
  'weight', 'sleep', 'heartrate', 'steps', 'body_fat', 'activity', 'symptom', 'log',
]);

// ── Entry → DB row mapping ──────────────────────────────────────────────────

function entryToRow(entry: Omit<HealthEntry, 'id' | 'timestamp'>, recorded_at: string, withings_id: string | null) {
  let value_numeric: number | null = null;
  let unit: string | null = null;
  const metadata: Record<string, unknown> = {};

  switch (entry.type) {
    case 'weight':
      value_numeric = entry.value ?? null;
      unit = entry.unit || 'kg';
      break;
    case 'body_fat':
      value_numeric = entry.value ?? null;
      unit = entry.unit || '%';
      break;
    case 'sleep':
      value_numeric = entry.value ?? null;
      unit = entry.unit || 'h';
      if (entry.deep_sleep_h != null) metadata.deep_sleep_h = entry.deep_sleep_h;
      if (entry.rem_sleep_h != null) metadata.rem_sleep_h = entry.rem_sleep_h;
      if (entry.light_sleep_h != null) metadata.light_sleep_h = entry.light_sleep_h;
      if (entry.quality != null) metadata.quality = entry.quality;
      break;
    case 'heartrate':
      value_numeric = entry.hr_avg ?? null;
      unit = 'bpm';
      if (entry.hr_min != null) metadata.hr_min = entry.hr_min;
      if (entry.hr_max != null) metadata.hr_max = entry.hr_max;
      break;
    case 'steps':
      value_numeric = entry.steps ?? null;
      unit = 'steps';
      if (entry.distance_m != null) metadata.distance_m = entry.distance_m;
      if (entry.calories != null) metadata.calories = entry.calories;
      break;
    case 'activity':
      value_numeric = entry.duration_min ?? null;
      unit = 'min';
      if (entry.activity_type != null) metadata.activity_type = entry.activity_type;
      if (entry.steps != null) metadata.steps = entry.steps;
      if (entry.distance_m != null) metadata.distance_m = entry.distance_m;
      if (entry.calories != null) metadata.calories = entry.calories;
      break;
    case 'symptom':
    case 'log':
      if (entry.text) metadata.text = entry.text;
      break;
  }

  return {
    type: entry.type,
    value_numeric,
    unit,
    source: entry.source || 'manual',
    metadata: JSON.stringify(metadata),
    recorded_at,
    withings_id,
  };
}

// ── DB row → HealthEntry mapping ─────────────────────────────────────────────

function rowToEntry(row: any): HealthEntry {
  const m = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
  const entry: HealthEntry = {
    id: row.withings_id || String(row.id),
    type: row.type,
    timestamp: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at),
    source: row.source,
  };

  switch (row.type) {
    case 'weight':
      entry.value = row.value_numeric != null ? Number(row.value_numeric) : undefined;
      entry.unit = row.unit;
      break;
    case 'body_fat':
      entry.value = row.value_numeric != null ? Number(row.value_numeric) : undefined;
      entry.unit = row.unit;
      break;
    case 'sleep':
      entry.value = row.value_numeric != null ? Number(row.value_numeric) : undefined;
      entry.unit = row.unit;
      if (m.deep_sleep_h != null) entry.deep_sleep_h = m.deep_sleep_h;
      if (m.rem_sleep_h != null) entry.rem_sleep_h = m.rem_sleep_h;
      if (m.light_sleep_h != null) entry.light_sleep_h = m.light_sleep_h;
      if (m.quality != null) entry.quality = m.quality;
      break;
    case 'heartrate':
      entry.hr_avg = row.value_numeric != null ? Number(row.value_numeric) : undefined;
      if (m.hr_min != null) entry.hr_min = m.hr_min;
      if (m.hr_max != null) entry.hr_max = m.hr_max;
      break;
    case 'steps':
      entry.steps = row.value_numeric != null ? Number(row.value_numeric) : undefined;
      if (m.distance_m != null) entry.distance_m = m.distance_m;
      if (m.calories != null) entry.calories = m.calories;
      break;
    case 'activity':
      entry.duration_min = row.value_numeric != null ? Number(row.value_numeric) : undefined;
      if (m.activity_type != null) entry.activity_type = m.activity_type;
      if (m.steps != null) entry.steps = m.steps;
      if (m.distance_m != null) entry.distance_m = m.distance_m;
      if (m.calories != null) entry.calories = m.calories;
      break;
    case 'symptom':
    case 'log':
      if (m.text) entry.text = m.text;
      break;
  }

  return entry;
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateEntry(entry: Omit<HealthEntry, 'id' | 'timestamp'>): void {
  if (!entry.type || !VALID_TYPES.has(entry.type)) {
    throw new Error(`Invalid type "${entry.type}". Must be one of: ${Array.from(VALID_TYPES).join(', ')}`);
  }
}

// ── Dedup check ─────────────────────────────────────────────────────────────

/** Returns true if an entry with the same type and date already exists */
export async function hasEntryForDate(type: HealthEntryType, dateStr: string): Promise<boolean> {
  const { rows } = await dbQuery<{ found: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM health_logs WHERE type = $1 AND recorded_at::date = $2::date
     ) AS found`,
    [type, dateStr],
  );
  return rows[0]?.found === true;
}

/**
 * Upsert: if an entry for this type+date exists with a lower value, replace it.
 * Returns 'inserted' | 'updated' | 'skipped'.
 */
export async function upsertEntryForDate(
  dateStr: string,
  ts: Date,
  entry: Omit<HealthEntry, 'id' | 'timestamp'>
): Promise<'inserted' | 'updated' | 'skipped'> {
  validateEntry(entry);
  const row = entryToRow(entry, ts.toISOString(), `${ts.getTime()}-${Math.random().toString(36).slice(2, 6)}`);

  // Check for existing entry on this date
  const existing = await dbQuery<{ id: number; value_numeric: string | null }>(
    `SELECT id, value_numeric FROM health_logs
     WHERE type = $1 AND recorded_at::date = $2::date AND source = $3
     ORDER BY value_numeric DESC NULLS LAST LIMIT 1`,
    [entry.type, dateStr, row.source],
  );

  if (existing.rows.length === 0) {
    await dbQuery(
      `INSERT INTO health_logs (type, value_numeric, unit, source, metadata, recorded_at, withings_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.type, row.value_numeric, row.unit, row.source, row.metadata, row.recorded_at, row.withings_id],
    );
    return 'inserted';
  }

  const oldValue = existing.rows[0].value_numeric != null ? Number(existing.rows[0].value_numeric) : 0;
  const newValue = row.value_numeric != null ? Number(row.value_numeric) : 0;

  if (newValue <= oldValue) {
    return 'skipped';
  }

  // Update the existing row with higher value
  await dbQuery(
    `UPDATE health_logs SET value_numeric = $1, unit = $2, metadata = $3, withings_id = $4
     WHERE id = $5`,
    [row.value_numeric, row.unit, row.metadata, row.withings_id, existing.rows[0].id],
  );
  return 'updated';
}

// ── Append-only write ───────────────────────────────────────────────────────

export async function appendEntry(entry: Omit<HealthEntry, 'id' | 'timestamp'>): Promise<HealthEntry> {
  validateEntry(entry);
  const now = new Date();
  const withings_id = `${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`;
  const row = entryToRow(entry, now.toISOString(), withings_id);

  await dbQuery(
    `INSERT INTO health_logs (type, value_numeric, unit, source, metadata, recorded_at, withings_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source, type, withings_id) WHERE withings_id IS NOT NULL DO NOTHING`,
    [row.type, row.value_numeric, row.unit, row.source, row.metadata, row.recorded_at, row.withings_id],
  );

  return { id: withings_id, timestamp: now.toISOString(), ...entry };
}

export async function appendEntryWithTimestamp(
  ts: Date,
  entry: Omit<HealthEntry, 'id' | 'timestamp'>
): Promise<HealthEntry> {
  validateEntry(entry);
  const withings_id = `${ts.getTime()}-${Math.random().toString(36).slice(2, 6)}`;
  const row = entryToRow(entry, ts.toISOString(), withings_id);

  await dbQuery(
    `INSERT INTO health_logs (type, value_numeric, unit, source, metadata, recorded_at, withings_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source, type, withings_id) WHERE withings_id IS NOT NULL DO NOTHING`,
    [row.type, row.value_numeric, row.unit, row.source, row.metadata, row.recorded_at, row.withings_id],
  );

  return { id: withings_id, timestamp: ts.toISOString(), ...entry };
}

// ── Read ────────────────────────────────────────────────────────────────────

export async function readEntries(since?: Date, until?: Date): Promise<HealthEntry[]> {
  let sql = 'SELECT * FROM health_logs WHERE 1=1';
  const params: unknown[] = [];

  if (since) {
    params.push(since.toISOString());
    sql += ` AND recorded_at >= $${params.length}`;
  }
  if (until) {
    params.push(until.toISOString());
    sql += ` AND recorded_at <= $${params.length}`;
  }
  sql += ' ORDER BY recorded_at ASC';

  const { rows } = await dbQuery(sql, params);
  return rows.map(rowToEntry);
}

export async function lastEntry(type: HealthEntryType): Promise<HealthEntry | null> {
  const { rows } = await dbQuery(
    'SELECT * FROM health_logs WHERE type = $1 ORDER BY recorded_at DESC LIMIT 1',
    [type],
  );
  return rows.length ? rowToEntry(rows[0]) : null;
}

// ── Summary ─────────────────────────────────────────────────────────────────

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

function numAvg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

export async function getWeightTrend(days: 7 | 30 | 90): Promise<WeightTrend | null> {
  const { rows } = await dbQuery<{ value_numeric: string }>(
    `SELECT value_numeric FROM health_logs
     WHERE type = 'weight' AND value_numeric IS NOT NULL
       AND recorded_at > now() - $1::interval
     ORDER BY recorded_at ASC`,
    [`${days} days`],
  );
  if (!rows.length) return null;

  const values = rows.map(r => Number(r.value_numeric));
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

export async function getSleepTrend(days: 7 | 30 | 90): Promise<SleepTrend | null> {
  const { rows } = await dbQuery<{ recorded_at: Date; value_numeric: string; metadata: any }>(
    `SELECT recorded_at, value_numeric, metadata FROM health_logs
     WHERE type = 'sleep' AND value_numeric IS NOT NULL
       AND recorded_at > now() - $1::interval
     ORDER BY recorded_at ASC`,
    [`${days} days`],
  );
  if (!rows.length) return null;

  // Aggregate sessions per night
  const byNight = new Map<string, { total: number; qualities: number[] }>();
  for (const r of rows) {
    const day = r.recorded_at.toISOString().slice(0, 10);
    const val = Number(r.value_numeric);
    const m = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
    const prev = byNight.get(day) || { total: 0, qualities: [] };
    prev.total += val;
    if (m.quality != null && m.quality > 0) prev.qualities.push(m.quality);
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

export async function getHeartrateTrend(days: 7 | 30 | 90): Promise<HeartrateTrend | null> {
  const { rows } = await dbQuery<{ value_numeric: string; metadata: any }>(
    `SELECT value_numeric, metadata FROM health_logs
     WHERE type = 'heartrate' AND value_numeric IS NOT NULL
       AND recorded_at > now() - $1::interval
     ORDER BY recorded_at ASC`,
    [`${days} days`],
  );
  if (!rows.length) return null;

  // Use hr_min as resting HR when plausible (40-100 bpm), otherwise hr_avg
  const restingValues = rows.map(r => {
    const m = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
    const hrMin = m.hr_min;
    const hrAvg = Number(r.value_numeric);
    return (hrMin != null && hrMin >= 40 && hrMin <= 100) ? hrMin : hrAvg;
  });

  const current = restingValues[restingValues.length - 1];
  return {
    current,
    avg: +numAvg(restingValues).toFixed(0),
    dataPoints: restingValues.length,
  };
}

export async function checkHealthAlerts(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];

  // Sleep < 6h on 3+ of last 7 nights → warning
  const { rows: sleepRows } = await dbQuery<{ recorded_at: Date; value_numeric: string }>(
    `SELECT recorded_at, value_numeric FROM health_logs
     WHERE type = 'sleep' AND value_numeric IS NOT NULL
       AND recorded_at > now() - interval '7 days'
     ORDER BY recorded_at ASC`,
  );
  const sleepByDay = new Map<string, number>();
  for (const r of sleepRows) {
    const day = r.recorded_at.toISOString().slice(0, 10);
    sleepByDay.set(day, (sleepByDay.get(day) ?? 0) + Number(r.value_numeric));
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
  const wt = await getWeightTrend(7);
  if (wt && Math.abs(wt.change) > 2) {
    const dir = wt.change > 0 ? '+' : '';
    alerts.push({ type: 'weight_change', severity: 'warning', message: `Gewichtsveränderung ${dir}${wt.change} kg in 7 Tagen` });
  }

  // No Withings data for 3+ days → info
  const { rows: recentRows } = await dbQuery<{ found: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM health_logs WHERE source = 'withings' AND recorded_at > now() - interval '3 days'
     ) AS found`,
  );
  if (!recentRows[0]?.found) {
    alerts.push({ type: 'no_withings_data', severity: 'info', message: 'Keine Withings-Daten seit 3+ Tagen' });
  }

  return alerts;
}
