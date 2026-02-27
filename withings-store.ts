import fs from 'fs';
import path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface WithingsTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;    // epoch ms
  userid: string;
  last_sync?: number;    // epoch ms
}

export interface WithingsMeasure {
  date: Date;
  weight_kg?: number;
  fat_ratio_pct?: number;
  fat_mass_kg?: number;
  fat_free_kg?: number;
  hr_bpm?: number;
}

export interface WithingsSleep {
  date: string;           // YYYY-MM-DD
  total_h: number;
  deep_h: number;
  rem_h: number;
  light_h: number;
  score?: number;         // 0–100
}

export interface WithingsActivity {
  date: string;           // YYYY-MM-DD
  steps: number;
  distance_m: number;
  calories: number;
  active_min: number;
  hr_avg?: number;
  hr_min?: number;
  hr_max?: number;
}

export interface WithingsWorkout {
  date: string;
  activity_type: string;
  duration_min: number;
  steps?: number;
  distance_m?: number;
  calories?: number;
  hr_avg?: number;
}

// ── Paths ──────────────────────────────────────────────────────────────────

const HEALTH_DIR = path.join(
  process.env.HOME || '/root',
  '.openclaw/workspace/artifacts/personal/health'
);
const TOKENS_FILE = path.join(HEALTH_DIR, 'withings-tokens.json');

function ensureDir() { fs.mkdirSync(HEALTH_DIR, { recursive: true }); }

// ── Token management ───────────────────────────────────────────────────────

export function loadTokens(): WithingsTokens | null {
  if (!fs.existsSync(TOKENS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')); }
  catch { return null; }
}

export function saveTokens(t: WithingsTokens): void {
  ensureDir();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2), 'utf-8');
}

export function isAuthorized(): boolean { return loadTokens() !== null; }

// ── Internal: fetchWithTimeout ────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: any, timeoutMs: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(`fetch_timeout_after_${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ── OAuth ──────────────────────────────────────────────────────────────────

const AUTH_URL  = 'https://account.withings.com/oauth2_user/authorize2';
const TOKEN_URL = 'https://wbsapi.withings.net/v2/oauth2';
const API_BASE  = 'https://wbsapi.withings.net';

export function buildAuthUrl(clientId: string, redirectUri: string, state: string): string {
  return `${AUTH_URL}?` + new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    scope:         'user.metrics,user.sleepevents,user.activity',
    state,
  });
}

async function postForm(url: string, params: Record<string, string>, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchWithTimeout(url, { method: 'POST', headers, body: new URLSearchParams(params) }, 15000);
  const data: any = await res.json();
  if (data.status !== 0) throw new Error(`Withings API error ${data.status}: ${data.error || JSON.stringify(data)}`);
  return data.body;
}

export async function exchangeCode(
  clientId: string, clientSecret: string,
  code: string, redirectUri: string
): Promise<WithingsTokens> {
  const b = await postForm(TOKEN_URL, {
    action: 'requesttoken', grant_type: 'authorization_code',
    client_id: clientId, client_secret: clientSecret,
    code, redirect_uri: redirectUri,
  });
  const tokens: WithingsTokens = {
    access_token:  b.access_token,
    refresh_token: b.refresh_token,
    expires_at:    Date.now() + Number(b.expires_in) * 1000,
    userid:        String(b.userid),
  };
  saveTokens(tokens);
  return tokens;
}

export async function ensureFreshToken(clientId: string, clientSecret: string): Promise<WithingsTokens> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Withings nicht autorisiert — bitte /withingsauth ausführen.');

  if (tokens.expires_at - Date.now() > 5 * 60 * 1000) return tokens;

  const b = await postForm(TOKEN_URL, {
    action: 'requesttoken', grant_type: 'refresh_token',
    client_id: clientId, client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
  });
  const refreshed: WithingsTokens = {
    access_token:  b.access_token,
    refresh_token: b.refresh_token,
    expires_at:    Date.now() + Number(b.expires_in) * 1000,
    userid:        String(b.userid),
    last_sync:     tokens.last_sync,
  };
  saveTokens(refreshed);
  return refreshed;
}

// ── Measures (weight, body fat, HR) ───────────────────────────────────────

// meastype bitmask: 1=weight, 5=fat_free_mass, 6=fat_ratio, 8=fat_mass, 11=heart_pulse
const MEASTYPES = '1,5,6,8,11';

export async function fetchMeasures(token: string, sinceMs: number): Promise<WithingsMeasure[]> {
  const b = await postForm(`${API_BASE}/measure`, {
    action: 'getmeas', meastype: MEASTYPES,
    category: '1', lastupdate: String(Math.floor(sinceMs / 1000)),
  }, token);

  // Group by date (grp.date) → one measure object per measurement session
  const byDate = new Map<number, WithingsMeasure>();
  for (const grp of b?.measuregrps || []) {
    const date = grp.date * 1000;
    if (!byDate.has(date)) byDate.set(date, { date: new Date(date) });
    const m = byDate.get(date)!;
    for (const meas of grp.measures || []) {
      const val = meas.value * Math.pow(10, meas.unit);
      switch (meas.type) {
        case 1:  m.weight_kg    = Math.round(val * 100) / 100; break;
        case 5:  m.fat_free_kg  = Math.round(val * 100) / 100; break;
        case 6:  m.fat_ratio_pct = Math.round(val * 10) / 10; break;
        case 8:  m.fat_mass_kg  = Math.round(val * 100) / 100; break;
        case 11: m.hr_bpm       = Math.round(val); break;
      }
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.getTime() - b.date.getTime());
}

// ── Sleep ──────────────────────────────────────────────────────────────────

export async function fetchSleep(token: string, sinceMs: number): Promise<WithingsSleep[]> {
  // Withings field names: mixed conventions (e.g. deepsleepduration vs total_sleep_time)
  const b = await postForm(`${API_BASE}/v2/sleep`, {
    action: 'getsummary',
    data_fields: 'sleep_score,total_sleep_time,lightsleepduration,deepsleepduration,remsleepduration,wakeupduration',
    lastupdate: String(Math.floor(sinceMs / 1000)),
  }, token);

  // Withings returns multiple series per night (wake-ups split a night).
  // Group by the Withings-provided `date` field (= night date) and aggregate.
  // Use total_sleep_time from API instead of summing phases (phases may not cover all sleep).
  const nightMap = new Map<string, { total: number; light: number; deep: number; rem: number; scores: number[] }>();

  for (const s of b?.series || []) {
    const d = s.data || {};
    const total = d.total_sleep_time ?? 0;
    const light = d.lightsleepduration ?? 0;
    const deep  = d.deepsleepduration ?? 0;
    const rem   = d.remsleepduration ?? 0;
    // Use total_sleep_time if available, otherwise fall back to phase sum
    const seriesTotal = total > 0 ? total : (light + deep + rem);
    if (seriesTotal <= 0) continue;

    // Prefer Withings `date` field; fall back to enddate-derived date
    const nightDate: string = s.date
      || new Date((s.enddate || s.startdate) * 1000).toISOString().slice(0, 10);

    const agg = nightMap.get(nightDate) || { total: 0, light: 0, deep: 0, rem: 0, scores: [] };
    agg.total += seriesTotal;
    agg.light += light;
    agg.deep  += deep;
    agg.rem   += rem;
    if (d.sleep_score != null && d.sleep_score > 0) agg.scores.push(d.sleep_score);
    nightMap.set(nightDate, agg);
  }

  const out: WithingsSleep[] = [];
  for (const [date, agg] of nightMap) {
    const avgScore = agg.scores.length
      ? Math.round(agg.scores.reduce((a, b) => a + b, 0) / agg.scores.length)
      : undefined;
    out.push({
      date,
      total_h: Math.round(agg.total / 360) / 10,
      deep_h:  Math.round(agg.deep / 360) / 10,
      rem_h:   Math.round(agg.rem / 360) / 10,
      light_h: Math.round(agg.light / 360) / 10,
      score:   avgScore,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Activity (steps, HR, calories) ────────────────────────────────────────

export async function fetchActivity(token: string, sinceMs: number): Promise<WithingsActivity[]> {
  const since = new Date(sinceMs);
  const until = new Date();
  const b = await postForm(`${API_BASE}/v2/measure`, {
    action: 'getactivity',
    data_fields: 'steps,distance,active,calories,totalcalories,hr_average,hr_min,hr_max',
    startdateymd: since.toISOString().slice(0, 10),
    enddateymd:   until.toISOString().slice(0, 10),
    offset: '0',
  }, token);

  const out: WithingsActivity[] = [];
  for (const a of b?.activities || []) {
    if (!a.date) continue;
    out.push({
      date:       a.date,
      steps:      a.steps ?? 0,
      distance_m: Math.round(a.distance ?? 0),
      calories:   Math.round(a.totalcalories ?? a.calories ?? 0),
      active_min: Math.round((a.active ?? 0) / 60),
      hr_avg:     a.hr_average ?? undefined,
      hr_min:     a.hr_min ?? undefined,
      hr_max:     a.hr_max ?? undefined,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Workouts ───────────────────────────────────────────────────────────────

// Withings activity type IDs → label
const WORKOUT_TYPES: Record<number, string> = {
  1: 'Laufen', 2: 'Radfahren', 3: 'Schwimmen', 4: 'Wandern',
  11: 'Tennis', 22: 'Fußball', 32: 'Klettern', 35: 'Krafttraining',
  306: 'Yoga', 187: 'Pilates', 288: 'Crossfit',
};

export async function fetchWorkouts(token: string, sinceMs: number): Promise<WithingsWorkout[]> {
  const b = await postForm(`${API_BASE}/v2/measure`, {
    action: 'getworkouts',
    data_fields: 'steps,calories,distance,heart_rate,duration',
    startdateymd: new Date(sinceMs).toISOString().slice(0, 10),
    enddateymd:   new Date().toISOString().slice(0, 10),
    offset: '0',
  }, token);

  const out: WithingsWorkout[] = [];
  for (const w of b?.series || []) {
    const label = WORKOUT_TYPES[w.category] || `Aktivität (${w.category})`;
    out.push({
      date:          new Date(w.startdate * 1000).toISOString().slice(0, 10),
      activity_type: label,
      duration_min:  Math.round((w.data?.duration ?? (w.enddate - w.startdate)) / 60),
      steps:         w.data?.steps ?? undefined,
      distance_m:    w.data?.distance ? Math.round(w.data.distance) : undefined,
      calories:      w.data?.calories ? Math.round(w.data.calories) : undefined,
      hr_avg:        w.data?.heart_rate ?? undefined,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
