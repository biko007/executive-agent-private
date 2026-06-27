/**
 * health/oura — Oura Ring API integration (OAuth2, sleep, HRV, readiness, activity).
 *
 * Token management via Postgres (health_oura_tokens).
 * Sync-Lock via pg_advisory_lock(47). Retry-on-401 with single refresh attempt.
 * Mirrors withings.ts patterns — see that file for architectural rationale.
 */
import type {
  OuraTokens, OuraSleepDocument, OuraReadinessDocument, OuraActivityDocument,
  OuraSyncResult,
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

const AUTH_URL   = 'https://cloud.ouraring.com/oauth/authorize';
const TOKEN_URL  = 'https://api.ouraring.com/oauth/token';
const API_BASE   = 'https://api.ouraring.com';
const SCOPES     = 'personal daily heartrate spo2 workout session';

export function buildOuraAuthUrl(clientId: string, redirectUri: string, state: string): string {
  return `${AUTH_URL}?` + new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    scope:         SCOPES,
    state,
  });
}

/** POST to Oura token endpoint (standard OAuth2 JSON response) */
async function postToken(params: Record<string, string>): Promise<any> {
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  }, 15000);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Oura token error ${res.status}: ${text}`);
  }
  return res.json();
}

/** GET from Oura API with Bearer auth */
async function apiGet(path: string, token: string, params?: Record<string, string>): Promise<any> {
  let url = `${API_BASE}${path}`;
  if (params) url += '?' + new URLSearchParams(params);
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  }, 15000);
  if (res.status === 401) throw new Error('Oura API error 401: Unauthorized');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Oura API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Token management (DB-backed) ────────────────────────────────────────────

export async function loadOuraTokens(): Promise<OuraTokens | null> {
  const { rows } = await dbQuery<{
    access_token: string; refresh_token: string; expires_at: Date;
    last_sync: Date | null;
  }>(
    'SELECT access_token, refresh_token, expires_at, last_sync FROM health_oura_tokens WHERE active = true LIMIT 1',
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: r.expires_at.getTime(),
    last_sync: r.last_sync ? r.last_sync.getTime() : undefined,
  };
}

export async function saveOuraTokens(t: OuraTokens): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE health_oura_tokens SET active = false WHERE active = true');
    await client.query(
      `INSERT INTO health_oura_tokens (access_token, refresh_token, expires_at, active, last_sync)
       VALUES ($1, $2, $3, true, $4)`,
      [t.access_token, t.refresh_token, new Date(t.expires_at), t.last_sync ? new Date(t.last_sync) : null],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  audit.log({
    module: 'health', action: 'health.oura_token_rotated',
    entityType: 'token', entityId: 'oura',
    after: { expires_at: new Date(t.expires_at).toISOString() },
  }).catch(() => {});
}

export async function isOuraAuthorized(): Promise<boolean> {
  const tokens = await loadOuraTokens();
  return tokens !== null;
}

async function updateOuraSyncStatus(opts: { last_sync?: Date; last_sync_error?: string | null }): Promise<void> {
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
  await dbQuery(`UPDATE health_oura_tokens SET ${sets.join(', ')} WHERE active = true`, params);
}

// ── OAuth exchange ─────────────────────────────────────────────────────────

export async function exchangeOuraCode(
  clientId: string, clientSecret: string,
  code: string, redirectUri: string
): Promise<OuraTokens> {
  const data = await postToken({
    grant_type: 'authorization_code',
    client_id: clientId, client_secret: clientSecret,
    code, redirect_uri: redirectUri,
  });
  const tokens: OuraTokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + Number(data.expires_in) * 1000,
  };
  await saveOuraTokens(tokens);
  audit.log({ module: 'auth', action: 'auth.oura_authorized', entityType: 'token', entityId: 'oura' }).catch(() => {});
  return tokens;
}

// ── Token refresh (internal) ───────────────────────────────────────────────

async function refreshOuraToken(clientId: string, clientSecret: string, current: OuraTokens): Promise<OuraTokens> {
  const data = await postToken({
    grant_type: 'refresh_token',
    client_id: clientId, client_secret: clientSecret,
    refresh_token: current.refresh_token,
  });
  const refreshed: OuraTokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + Number(data.expires_in) * 1000,
    last_sync:     current.last_sync,
  };
  await saveOuraTokens(refreshed);
  return refreshed;
}

// ── Ensure fresh token ─────────────────────────────────────────────────────

export async function ensureFreshOuraToken(clientId: string, clientSecret: string): Promise<OuraTokens> {
  const tokens = await loadOuraTokens();
  if (!tokens) throw new Error('Oura nicht autorisiert — bitte /ouraauth ausführen.');

  if (tokens.expires_at - Date.now() <= 10 * 60 * 1000) {
    return refreshOuraToken(clientId, clientSecret, tokens);
  }

  return tokens;
}

// ── Sync-Lock (Spec §4) ───────────────────────────────────────────────────

export async function executeOuraSync(
  clientId: string,
  clientSecret: string,
  sinceMs: number,
  syncFn: (token: string, sinceMs: number) => Promise<{ total: number; newCount: number }>,
  sendTelegram?: (chatId: string, text: string) => Promise<any>,
  telegramChatId?: string,
): Promise<OuraSyncResult> {
  await dbQuery('SELECT pg_advisory_lock(47)');

  try {
    let tokens = await loadOuraTokens();
    if (!tokens) {
      audit.log({
        module: 'health', action: 'health.oura_sync_precondition_failed',
        entityType: 'sync', after: { reason: 'no_active_token' },
      }).catch(() => {});
      throw new Error('No active Oura token');
    }

    if (tokens.expires_at - Date.now() <= 10 * 60 * 1000) {
      tokens = await refreshOuraToken(clientId, clientSecret, tokens);
    }

    let result: { total: number; newCount: number };
    try {
      result = await syncFn(tokens.access_token, sinceMs);
    } catch (err: any) {
      if (err?.message?.includes('401') || err?.message?.includes('Unauthorized')) {
        try {
          tokens = await refreshOuraToken(clientId, clientSecret, tokens);
          result = await syncFn(tokens.access_token, sinceMs);
        } catch (refreshErr: any) {
          await updateOuraSyncStatus({ last_sync_error: refreshErr.message });
          audit.log({
            module: 'health', action: 'health.oura_sync_failed',
            entityType: 'sync', after: { reason: refreshErr.message },
          }).catch(() => {});
          if (sendTelegram && telegramChatId) {
            sendTelegram(telegramChatId, '⚠️ Oura Auth verloren. /ouraauth aufrufen.').catch(() => {});
          }
          throw new Error(`Oura sync failed (refresh failed): ${refreshErr.message}`);
        }
      } else {
        await updateOuraSyncStatus({ last_sync_error: err.message });
        throw err;
      }
    }

    await updateOuraSyncStatus({ last_sync: new Date(), last_sync_error: null });

    return {
      synced_count: result.total,
      new_count: result.newCount,
      last_sync: new Date().toISOString(),
      status: 'ok',
    };
  } finally {
    await dbQuery('SELECT pg_advisory_unlock(47)').catch(() => {});
  }
}

// ── Sync status ────────────────────────────────────────────────────────────

export interface OuraSyncStatus {
  last_sync: string | null;
  last_sync_error: string | null;
  days_since_sync: number | null;
  status: 'ok' | 'stale' | 'error' | 'no_token';
}

export async function getOuraSyncStatus(): Promise<OuraSyncStatus> {
  const { rows } = await dbQuery<{
    last_sync: Date | null; last_sync_error: string | null;
  }>(
    'SELECT last_sync, last_sync_error FROM health_oura_tokens WHERE active = true LIMIT 1',
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

// ── Oura API v2: Sleep (includes HRV, HR, temperature) ────────────────────

export async function fetchOuraSleep(token: string, sinceMs: number): Promise<OuraSleepDocument[]> {
  const startDate = new Date(sinceMs).toISOString().slice(0, 10);
  const endDate   = new Date().toISOString().slice(0, 10);

  const data = await apiGet('/v2/usercollection/sleep', token, {
    start_date: startDate,
    end_date:   endDate,
  });

  const byDay = new Map<string, OuraSleepDocument>();

  for (const s of data?.data || []) {
    const day: string = s.day || (s.bedtime_end ? s.bedtime_end.slice(0, 10) : startDate);

    // Aggregate multiple sleep periods per day (pick longest or sum)
    const existing = byDay.get(day);
    const totalDuration = s.total_sleep_duration ?? 0;

    if (existing && existing.total_sleep_duration >= totalDuration) {
      continue; // keep the longer sleep period
    }

    byDay.set(day, {
      id:                    s.id || `oura-sleep-${day}`,
      day,
      total_sleep_duration:  totalDuration,
      deep_sleep_duration:   s.deep_sleep_duration ?? 0,
      rem_sleep_duration:    s.rem_sleep_duration ?? 0,
      light_sleep_duration:  s.light_sleep_duration ?? 0,
      score:                 s.readiness_score_delta != null ? undefined : (s.score ?? undefined),
      average_hrv:           s.average_hrv ?? undefined,
      lowest_heart_rate:     s.lowest_heart_rate ?? undefined,
      average_heart_rate:    s.average_heart_rate ?? undefined,
      temperature_deviation: s.temperature_deviation ?? undefined,
    });
  }

  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
}

// ── Oura API v2: Daily Readiness ──────────────────────────────────────────

export async function fetchOuraReadiness(token: string, sinceMs: number): Promise<OuraReadinessDocument[]> {
  const startDate = new Date(sinceMs).toISOString().slice(0, 10);
  const endDate   = new Date().toISOString().slice(0, 10);

  const data = await apiGet('/v2/usercollection/daily_readiness', token, {
    start_date: startDate,
    end_date:   endDate,
  });

  const out: OuraReadinessDocument[] = [];
  for (const r of data?.data || []) {
    out.push({
      id:           r.id || `oura-readiness-${r.day}`,
      day:          r.day,
      score:        r.score ?? undefined,
      contributors: r.contributors ?? undefined,
    });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

// ── Oura API v2: Daily Activity ───────────────────────────────────────────

export async function fetchOuraActivity(token: string, sinceMs: number): Promise<OuraActivityDocument[]> {
  const startDate = new Date(sinceMs).toISOString().slice(0, 10);
  const endDate   = new Date().toISOString().slice(0, 10);

  const data = await apiGet('/v2/usercollection/daily_activity', token, {
    start_date: startDate,
    end_date:   endDate,
  });

  const out: OuraActivityDocument[] = [];
  for (const a of data?.data || []) {
    out.push({
      id:                         a.id || `oura-activity-${a.day}`,
      day:                        a.day,
      steps:                      a.steps ?? 0,
      equivalent_walking_distance: a.equivalent_walking_distance ?? 0,
      total_calories:             a.total_calories ?? 0,
      active_calories:            a.active_calories ?? 0,
    });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}
