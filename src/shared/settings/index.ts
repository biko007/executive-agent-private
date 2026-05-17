/**
 * shared/settings — user settings persistence (DB-backed, Sprint 11).
 *
 * - loadSettings() is sync (reads from in-memory cache)
 * - setSetting() writes atomically to DB with audit in one transaction
 * - Cache is refreshed every 60s in background
 *
 * CAVEAT: Single-process cache. Bei mehreren Gateway-Instanzen (aktuell
 * nicht der Fall) wuerde Cache-Drift entstehen. Hintergrund-Refresh
 * alle 60s fuer Konsistenz. Siehe CLAUDE.md.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface LocationSetting {
  lat: number;
  lon: number;
  label: string;
  updatedAt?: string;
}

export interface Settings {
  briefingTime: string;
  telegramChatId?: string;
  healthReportDay?: number;
  location?: LocationSetting;
}

// ── Key Mapping (camelCase TS <-> snake_case DB) ────────────────────────────

const SETTING_KEYS: Record<string, string> = {
  briefingTime:    'briefing_time',
  telegramChatId:  'telegram_chat_id',
  healthReportDay: 'health_report_day',
  location:        'location',
};
const REVERSE_KEYS: Record<string, string> = Object.fromEntries(
  Object.entries(SETTING_KEYS).map(([k, v]) => [v, k])
);

// ── File paths (legacy fallback) ────────────────────────────────────────────

const SETTINGS_FILE = path.join(
  process.env.HOME || '/root',
  '.openclaw/workspace/artifacts/personal/health/settings.json',
);

export const DEFAULT_LOCATION: LocationSetting = {
  lat: 47.9838,
  lon: 8.8234,
  label: 'Tuttlingen',
};

// ── Cache ───────────────────────────────────────────────────────────────────

let _cache: Settings | null = null;
let _refreshTimer: ReturnType<typeof setInterval> | null = null;
const CACHE_TTL_MS = 60_000;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Sync read from in-memory cache. Falls back to JSON file on cold start.
 * All 14+ callsites remain unchanged (sync usage).
 */
export function loadSettings(): Settings {
  if (_cache) return { ..._cache };
  // Cold-start fallback: read from file
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { briefingTime: '07:00', ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) };
    }
  } catch {}
  return { briefingTime: '07:00' };
}

/**
 * DEPRECATED — kept for backwards compat. Writes file + fire-and-forget DB sync.
 */
export function saveSettings(s: Settings): void {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8');
  // Fire-and-forget: sync individual fields to DB
  _syncToDb(s).catch(() => {});
}

/**
 * Get a single setting from DB.
 */
export async function getSetting<T = unknown>(key: string): Promise<T | undefined> {
  const { query } = await import('../db/index.js');
  const dbKey = SETTING_KEYS[key] || key;
  const { rows } = await query('SELECT value FROM system_settings WHERE key = $1', [dbKey]);
  if (rows.length === 0) return undefined;
  return rows[0].value as T;
}

/**
 * Atomically set a setting in DB with audit log in the same transaction.
 * Updates the in-memory cache immediately after commit.
 */
export async function setSetting(key: string, value: unknown): Promise<void> {
  const { getClient } = await import('../db/index.js');
  const { getRequestId, getCorrelationId, getActor, getSource } = await import('../correlation/index.js');

  // Resolve the DB key (accept both camelCase and snake_case)
  const dbKey = SETTING_KEYS[key] || key;

  const resolvedActor = getActor();
  const source = getSource();
  const correlationId = getCorrelationId();
  const requestId = getRequestId();

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // 1. Read old value for audit before_jsonb
    const { rows: old } = await client.query(
      'SELECT value FROM system_settings WHERE key = $1', [dbKey]
    );
    const beforeJson = old.length > 0 ? JSON.stringify({ [dbKey]: old[0].value }) : null;
    const afterJson = JSON.stringify({ [dbKey]: value });

    // 2. UPSERT with explicit updated_at = NOW()
    await client.query(
      `INSERT INTO system_settings (key, value, updated_at, created_at)
       VALUES ($1, $2::jsonb, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
      [dbKey, JSON.stringify(value)]
    );

    // 3. Audit INSERT in same transaction
    await client.query(
      `INSERT INTO audit_log
         (actor, module, action, entity_type, entity_id,
          before_jsonb, after_jsonb, source, correlation_id, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [resolvedActor, 'settings', 'setting.updated',
       'system_setting', dbKey, beforeJson, afterJson,
       source, correlationId, requestId]
    );

    await client.query('COMMIT');

    // 4. Update cache
    _updateCacheField(dbKey, value);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Refresh the in-memory cache from DB (SELECT * FROM system_settings).
 */
export async function refreshSettingsCache(): Promise<void> {
  const { query } = await import('../db/index.js');
  const { rows } = await query('SELECT key, value FROM system_settings');
  const merged: Settings = { briefingTime: '07:00' };
  for (const row of rows) {
    const field = REVERSE_KEYS[row.key];
    if (field) (merged as any)[field] = row.value;
  }
  _cache = merged;
}

/**
 * Start the background cache refresh interval (60s).
 */
export function startSettingsCacheRefresh(): void {
  if (_refreshTimer) return;
  _refreshTimer = setInterval(() => {
    refreshSettingsCache().catch(() => {});
  }, CACHE_TTL_MS);
  // Don't prevent process exit
  if (_refreshTimer.unref) _refreshTimer.unref();
}

/**
 * Get latest location from Postgres, with fallback to DEFAULT_LOCATION.
 * Async since Sprint 8 (was sync before).
 */
export async function getLocationSettings(): Promise<LocationSetting> {
  try {
    const { getLatestLocation } = await import('../../modules/location/store.js');
    const latest = await getLatestLocation();
    if (latest) return latest;
  } catch {}
  return DEFAULT_LOCATION;
}

// ── Internals ───────────────────────────────────────────────────────────────

function _updateCacheField(dbKey: string, value: unknown): void {
  if (!_cache) _cache = { briefingTime: '07:00' };
  const field = REVERSE_KEYS[dbKey];
  if (field) {
    (_cache as any)[field] = value;
  }
}

/** Fire-and-forget sync of all settings fields to DB (for deprecated saveSettings). */
async function _syncToDb(s: Settings): Promise<void> {
  const { query } = await import('../db/index.js');
  for (const [tsKey, dbKey] of Object.entries(SETTING_KEYS)) {
    const val = (s as any)[tsKey];
    if (val !== undefined) {
      await query(
        `INSERT INTO system_settings (key, value, updated_at, created_at)
         VALUES ($1, $2::jsonb, NOW(), NOW())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = NOW()`,
        [dbKey, JSON.stringify(val)]
      );
    }
  }
  // Also update cache
  _cache = { ...{ briefingTime: '07:00' } as Settings, ...s };
}
