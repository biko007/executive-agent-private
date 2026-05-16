/**
 * Health Monitor — polls service endpoints, sends Telegram alerts on state changes.
 *
 * Services: Core (18789), Dashboard (18800), Trading (18793), n8n (5678)
 * Polling: every 5 minutes, 10s timeout per check
 * Alerts: throttled to max 1 per service+event per 30 minutes
 * Token checks: daily at 08:00 Europe/Berlin
 */
import { query } from '../../shared/db/index.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ServiceEntry {
  name: string;
  url: string;
}

export interface ServiceState {
  service: string;
  status: 'up' | 'down' | 'unknown';
  lastCheck: Date | null;
  lastChange: Date | null;
  downtimeStart: Date | null;
}

export interface TokenInfo {
  name: string;
  expiresAt: number; // epoch ms
}

type SendTelegramFn = (chatId: string, text: string) => Promise<boolean>;
type GetChatIdFn = () => string | undefined;
type LoggerFn = { info: (msg: string) => void; error: (msg: string) => void; warn: (msg: string) => void };

// ── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5 * 60 * 1000;       // 5 minutes
const FETCH_TIMEOUT_MS = 10_000;                // 10 seconds
const THROTTLE_WINDOW_MS = 30 * 60 * 1000;     // 30 minutes
const TOKEN_WARNING_DAYS = 7;
const TOKEN_CHECK_HOUR = 8; // 08:00 Europe/Berlin

const SERVICES: ServiceEntry[] = [
  { name: 'Core', url: 'http://127.0.0.1:18789/health' },
  { name: 'Dashboard', url: 'http://127.0.0.1:18800/health' },
  { name: 'Trading', url: 'http://127.0.0.1:18793/health' },
  { name: 'n8n', url: 'http://127.0.0.1:5678/healthz' },
];

// ── Alert Throttling ───────────────────────────────────────────────────────

/** Tracks last alert time per "service:event" key */
const alertThrottleMap = new Map<string, number>();

/**
 * Returns true if the alert should be sent (not throttled).
 * Pure function of the throttle map + current time — easy to test.
 */
export function shouldAlert(
  service: string,
  event: string,
  now: number = Date.now(),
  throttleMap: Map<string, number> = alertThrottleMap,
): boolean {
  const key = `${service}:${event}`;
  const lastSent = throttleMap.get(key);
  if (lastSent && now - lastSent < THROTTLE_WINDOW_MS) {
    return false;
  }
  throttleMap.set(key, now);
  return true;
}

// ── DB Persistence ─────────────────────────────────────────────────────────

async function loadStateFromDb(): Promise<Map<string, ServiceState>> {
  const map = new Map<string, ServiceState>();
  try {
    const { rows } = await query<{
      service: string;
      status: string;
      last_check: Date | null;
      last_change: Date | null;
      downtime_start: Date | null;
    }>('SELECT service, status, last_check, last_change, downtime_start FROM service_health');

    for (const row of rows) {
      map.set(row.service, {
        service: row.service,
        status: row.status as 'up' | 'down' | 'unknown',
        lastCheck: row.last_check,
        lastChange: row.last_change,
        downtimeStart: row.downtime_start,
      });
    }
  } catch (err: any) {
    // Table might not exist yet on first run before migration
  }
  return map;
}

async function persistState(state: ServiceState): Promise<void> {
  await query(
    `INSERT INTO service_health (service, status, last_check, last_change, downtime_start)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (service) DO UPDATE SET
       status = EXCLUDED.status,
       last_check = EXCLUDED.last_check,
       last_change = EXCLUDED.last_change,
       downtime_start = EXCLUDED.downtime_start`,
    [state.service, state.status, state.lastCheck, state.lastChange, state.downtimeStart],
  );
}

// ── HTTP Health Check ──────────────────────────────────────────────────────

async function checkService(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Time Formatting ────────────────────────────────────────────────────────

function berlinTime(date: Date = new Date()): string {
  return date.toLocaleTimeString('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function berlinHour(): number {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false }).format(new Date()),
    10,
  );
}

function formatDowntime(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
}

// ── Token Expiry Check ─────────────────────────────────────────────────────

async function getTokenExpirations(): Promise<TokenInfo[]> {
  const results: TokenInfo[] = [];

  // Instagram (Meta) token — Postgres-backed (Sprint 5.7a)
  try {
    const { rows } = await query<{ expires_at: Date }>(
      `SELECT expires_at FROM insta_tokens WHERE active = true LIMIT 1`
    );
    if (rows.length && rows[0].expires_at) {
      results.push({ name: 'Meta (Instagram)', expiresAt: new Date(rows[0].expires_at).getTime() });
    }
  } catch { /* ignore */ }

  // Withings token — Postgres-backed (Sprint 4)
  try {
    const { rows } = await query<{ expires_at: Date }>(
      `SELECT expires_at FROM health_withings_tokens WHERE active = true LIMIT 1`
    );
    if (rows.length && rows[0].expires_at) {
      results.push({ name: 'Withings', expiresAt: new Date(rows[0].expires_at).getTime() });
    }
  } catch { /* ignore */ }

  return results;
}

// ── Main Monitor Class ─────────────────────────────────────────────────────

export class HealthMonitor {
  private states = new Map<string, ServiceState>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tokenCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastTokenCheckDay = '';
  private sendTelegram: SendTelegramFn;
  private getChatId: GetChatIdFn;
  private logger: LoggerFn;

  constructor(opts: {
    sendTelegram: SendTelegramFn;
    getChatId: GetChatIdFn;
    logger: LoggerFn;
  }) {
    this.sendTelegram = opts.sendTelegram;
    this.getChatId = opts.getChatId;
    this.logger = opts.logger;
  }

  async start(): Promise<void> {
    // Load persisted state from DB
    this.states = await loadStateFromDb();
    this.logger.info(`[health-monitor] Loaded ${this.states.size} service states from DB`);

    // Run first poll immediately
    await this.pollAll();

    // Schedule periodic polling
    this.pollTimer = setInterval(() => {
      this.pollAll().catch((err) => {
        this.logger.error(`[health-monitor] Poll error: ${err.message}`);
      });
    }, POLL_INTERVAL_MS);

    // Token check every hour (fires at 08:00 Berlin)
    this.tokenCheckTimer = setInterval(() => {
      this.maybeCheckTokens().catch((err) => {
        this.logger.error(`[health-monitor] Token check error: ${err.message}`);
      });
    }, 60 * 60 * 1000); // check hourly whether it's 08:00

    // Also check tokens on start
    await this.maybeCheckTokens();

    this.logger.info('[health-monitor] Started — polling every 5 min, token check daily 08:00');
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.tokenCheckTimer) {
      clearInterval(this.tokenCheckTimer);
      this.tokenCheckTimer = null;
    }
    this.logger.info('[health-monitor] Stopped');
  }

  async pollAll(): Promise<void> {
    const now = new Date();

    for (const svc of SERVICES) {
      const isUp = await checkService(svc.url);
      const newStatus: 'up' | 'down' = isUp ? 'up' : 'down';
      const prev = this.states.get(svc.name);
      const prevStatus = prev?.status ?? 'unknown';

      const state: ServiceState = {
        service: svc.name,
        status: newStatus,
        lastCheck: now,
        lastChange: prevStatus !== newStatus ? now : (prev?.lastChange ?? now),
        downtimeStart: newStatus === 'down'
          ? (prevStatus === 'down' ? (prev?.downtimeStart ?? now) : now)
          : null,
      };

      this.states.set(svc.name, state);

      // Persist to DB
      try {
        await persistState(state);
      } catch (err: any) {
        this.logger.error(`[health-monitor] DB persist failed for ${svc.name}: ${err.message}`);
      }

      // State transition → alert
      if (prevStatus !== 'unknown' && prevStatus !== newStatus) {
        await this.sendAlert(svc.name, newStatus, prev?.downtimeStart ?? null);
      }
    }
  }

  private async sendAlert(
    service: string,
    newStatus: 'up' | 'down',
    prevDowntimeStart: Date | null,
  ): Promise<void> {
    const chatId = this.getChatId();
    if (!chatId) return;

    const event = newStatus === 'down' ? 'down' : 'up';
    if (!shouldAlert(service, event)) {
      this.logger.info(`[health-monitor] Alert throttled: ${service} ${event}`);
      return;
    }

    let text: string;
    if (newStatus === 'down') {
      text = `🔴 ${service} DOWN since ${berlinTime()}`;
    } else {
      const downtimeMs = prevDowntimeStart
        ? Date.now() - prevDowntimeStart.getTime()
        : 0;
      text = `✅ ${service} UP at ${berlinTime()}${downtimeMs > 0 ? ` (downtime: ${formatDowntime(downtimeMs)})` : ''}`;
    }

    try {
      await this.sendTelegram(chatId, text);
      this.logger.info(`[health-monitor] Alert sent: ${text}`);
    } catch (err: any) {
      this.logger.error(`[health-monitor] Alert send failed: ${err.message}`);
    }
  }

  private async maybeCheckTokens(): Promise<void> {
    const hour = berlinHour();
    const today = new Date().toISOString().slice(0, 10);

    // Only fire at 08:00 Berlin, once per day
    if (hour !== TOKEN_CHECK_HOUR || this.lastTokenCheckDay === today) return;
    this.lastTokenCheckDay = today;

    const chatId = this.getChatId();
    if (!chatId) return;

    const tokens = await getTokenExpirations();
    const now = Date.now();

    for (const token of tokens) {
      const daysLeft = Math.floor((token.expiresAt - now) / (24 * 60 * 60 * 1000));
      if (daysLeft < TOKEN_WARNING_DAYS) {
        if (shouldAlert(token.name, 'token_expiry')) {
          const text = `⚠️ ${token.name} expires in ${daysLeft} days`;
          try {
            await this.sendTelegram(chatId, text);
            this.logger.info(`[health-monitor] Token alert: ${text}`);
          } catch (err: any) {
            this.logger.error(`[health-monitor] Token alert failed: ${err.message}`);
          }
        }
      }
    }
  }

  /** Get current state (for dashboard API) */
  getStates(): ServiceState[] {
    return Array.from(this.states.values());
  }
}
