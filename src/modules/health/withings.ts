/**
 * health/withings — Withings API integration (OAuth2, measures, sleep, activity).
 *
 * Sprint 4: Token management via Postgres (health_withings_tokens).
 * Sync-Lock via pg_advisory_lock(42). Retry-on-401 with single refresh attempt.
 */
import type {
  WithingsTokens, WithingsMeasure, WithingsSleep,
  WithingsActivity, WithingsWorkout,
} from './types.js';
import { query as dbQuery, getClient } from '../../shared/db/index.js';
import * as audit from '../../shared/audit/index.js';

// ── Internal: fetchWithTimeout ─────────────────────────────────────────────

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

// ── Token management (DB-backed) ────────────────────────────────────────────

export async function loadTokens(): Promise<WithingsTokens | null> {
  const { rows } = await dbQuery<{
    access_token: string; refresh_token: string; expires_at: Date;
    userid: string; last_sync: Date | null;
  }>(
    'SELECT access_token, refresh_token, expires_at, userid, last_sync FROM health_withings_tokens WHERE active = true LIMIT 1',
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: r.expires_at.getTime(),
    userid: r.userid,
    last_sync: r.last_sync ? r.last_sync.getTime() : undefined,
  };
}

export async function saveTokens(t: WithingsTokens): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // Deactivate all existing active tokens
    await client.query('UPDATE health_withings_tokens SET active = false WHERE active = true');
    // Insert new active token
    await client.query(
      `INSERT INTO health_withings_tokens (access_token, refresh_token, expires_at, userid, active, last_sync)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [t.access_token, t.refresh_token, new Date(t.expires_at), t.userid, t.last_sync ? new Date(t.last_sync) : null],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  // Audit without token values
  audit.log({
    module: 'health', action: 'health.token_rotated',
    entityType: 'token', entityId: 'withings',
    after: { userid: t.userid, expires_at: new Date(t.expires_at).toISOString() },
  }).catch(() => {});
}

export async function isAuthorized(): Promise<boolean> {
  const tokens = await loadTokens();
  return tokens !== null;
}

/** Update last_sync and/or last_sync_error on the active token */
async function updateSyncStatus(opts: { last_sync?: Date; last_sync_error?: string | null }): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (opts.last_sync !== undefined) {
    params.push(opts.last_sync);
    sets.push(`last_sync = $${params.length}`);
  }
  if (opts.last_sync_error !== undefined) {
    params.push(opts.last_sync_error);
    sets.push(`last_sync_error = $${params.length}`);
  }
  if (sets.length === 0) return;
  await dbQuery(`UPDATE health_withings_tokens SET ${sets.join(', ')} WHERE active = true`, params);
}

// ── OAuth exchange ─────────────────────────────────────────────────────────

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
  await saveTokens(tokens);
  audit.log({ module: 'auth', action: 'auth.withings_reauthorized', entityType: 'token', entityId: 'withings', after: { userid: tokens.userid } }).catch(() => {});
  return tokens;
}

// ── Token refresh (internal) ───────────────────────────────────────────────

async function refreshToken(clientId: string, clientSecret: string, current: WithingsTokens): Promise<WithingsTokens> {
  const b = await postForm(TOKEN_URL, {
    action: 'requesttoken', grant_type: 'refresh_token',
    client_id: clientId, client_secret: clientSecret,
    refresh_token: current.refresh_token,
  });
  const refreshed: WithingsTokens = {
    access_token:  b.access_token,
    refresh_token: b.refresh_token,
    expires_at:    Date.now() + Number(b.expires_in) * 1000,
    userid:        String(b.userid),
    last_sync:     current.last_sync,
  };
  await saveTokens(refreshed);
  return refreshed;
}

// ── Ensure fresh token (with retry-on-401) ─────────────────────────────────

export async function ensureFreshToken(clientId: string, clientSecret: string): Promise<WithingsTokens> {
  const tokens = await loadTokens();
  if (!tokens) throw new Error('Withings nicht autorisiert — bitte /withingsauth ausführen.');

  // Pre-emptive refresh if expiring within 10 minutes
  if (tokens.expires_at - Date.now() <= 10 * 60 * 1000) {
    return refreshToken(clientId, clientSecret, tokens);
  }

  return tokens;
}

// ── Sync-Lock for withings sync (Spec §4) ───────────────────────────────────

export interface WithingsSyncResult {
  synced_count: number;
  new_count: number;
  last_sync: string | null;
  status: 'ok' | 'error';
  error?: string;
}

/**
 * Execute a Withings sync with advisory lock and retry-on-401.
 * This is the core sync function called by the POST /api/health/withings-sync endpoint.
 */
export async function executeWithingsSync(
  clientId: string,
  clientSecret: string,
  sinceMs: number,
  syncFn: (token: string, sinceMs: number) => Promise<{ total: number; newCount: number }>,
  sendTelegram?: (chatId: string, text: string) => Promise<any>,
  telegramChatId?: string,
): Promise<WithingsSyncResult> {
  // Step 1: Acquire advisory lock
  await dbQuery('SELECT pg_advisory_lock(42)');

  try {
    // Step 2: Load active token
    let tokens = await loadTokens();
    if (!tokens) {
      audit.log({
        module: 'health', action: 'health.withings_sync_precondition_failed',
        entityType: 'sync', after: { reason: 'no_active_token' },
      }).catch(() => {});
      throw new Error('No active Withings token');
    }

    // Step 3: Pre-emptive refresh if expiring within 10 minutes
    if (tokens.expires_at - Date.now() <= 10 * 60 * 1000) {
      tokens = await refreshToken(clientId, clientSecret, tokens);
    }

    let result: { total: number; newCount: number };
    try {
      // Step 4: Execute sync
      result = await syncFn(tokens.access_token, sinceMs);
    } catch (err: any) {
      // Step 5: If 401, single refresh attempt + retry
      if (err?.message?.includes('401') || err?.message?.includes('error 401')) {
        try {
          tokens = await refreshToken(clientId, clientSecret, tokens);
          result = await syncFn(tokens.access_token, sinceMs);
        } catch (refreshErr: any) {
          // Step 7: Refresh failed — fatal error
          await updateSyncStatus({ last_sync_error: refreshErr.message });
          audit.log({
            module: 'health', action: 'health.withings_sync_failed',
            entityType: 'sync', after: { reason: refreshErr.message },
          }).catch(() => {});
          // Telegram notify
          if (sendTelegram && telegramChatId) {
            sendTelegram(telegramChatId, '⚠️ Withings Auth verloren. /withingsauth aufrufen.').catch(() => {});
          }
          throw new Error(`Withings sync failed (refresh failed): ${refreshErr.message}`);
        }
      } else {
        await updateSyncStatus({ last_sync_error: err.message });
        throw err;
      }
    }

    // Step 6: Success — update last_sync
    await updateSyncStatus({ last_sync: new Date(), last_sync_error: null });

    return {
      synced_count: result.total,
      new_count: result.newCount,
      last_sync: new Date().toISOString(),
      status: 'ok',
    };
  } finally {
    // Step 8: Release lock
    await dbQuery('SELECT pg_advisory_unlock(42)').catch(() => {});
  }
}

// ── Sync status (for debug endpoint) ────────────────────────────────────────

export interface WithingsSyncStatus {
  last_sync: string | null;
  last_sync_error: string | null;
  days_since_sync: number | null;
  status: 'ok' | 'stale' | 'error' | 'no_token';
}

export async function getSyncStatus(): Promise<WithingsSyncStatus> {
  const { rows } = await dbQuery<{
    last_sync: Date | null; last_sync_error: string | null;
  }>(
    'SELECT last_sync, last_sync_error FROM health_withings_tokens WHERE active = true LIMIT 1',
  );

  if (!rows.length) {
    return { last_sync: null, last_sync_error: null, days_since_sync: null, status: 'no_token' };
  }

  const r = rows[0];
  const daysSince = r.last_sync ? (Date.now() - r.last_sync.getTime()) / 86_400_000 : null;
  let status: 'ok' | 'stale' | 'error' = 'ok';
  if (r.last_sync_error) status = 'error';
  else if (daysSince != null && daysSince > 2) status = 'stale';

  return {
    last_sync: r.last_sync?.toISOString() || null,
    last_sync_error: r.last_sync_error,
    days_since_sync: daysSince != null ? +daysSince.toFixed(1) : null,
    status,
  };
}

// ── Measures (weight, body fat, HR) ────────────────────────────────────────

const MEASTYPES = '1,5,6,8,11';

export async function fetchMeasures(token: string, sinceMs: number): Promise<WithingsMeasure[]> {
  const b = await postForm(`${API_BASE}/measure`, {
    action: 'getmeas', meastype: MEASTYPES,
    category: '1', lastupdate: String(Math.floor(sinceMs / 1000)),
  }, token);

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
  const b = await postForm(`${API_BASE}/v2/sleep`, {
    action: 'getsummary',
    data_fields: 'sleep_score,total_sleep_time,lightsleepduration,deepsleepduration,remsleepduration,wakeupduration',
    lastupdate: String(Math.floor(sinceMs / 1000)),
  }, token);

  const nightMap = new Map<string, { total: number; light: number; deep: number; rem: number; scores: number[] }>();

  for (const s of b?.series || []) {
    const d = s.data || {};
    const total = d.total_sleep_time ?? 0;
    const light = d.lightsleepduration ?? 0;
    const deep  = d.deepsleepduration ?? 0;
    const rem   = d.remsleepduration ?? 0;
    const seriesTotal = total > 0 ? total : (light + deep + rem);
    if (seriesTotal <= 0) continue;

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

// ── Activity (steps, HR, calories) ─────────────────────────────────────────

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
