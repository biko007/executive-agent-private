import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  loadTokens as loadInstaTokens, tokenDaysRemaining, ensureFreshToken,
} from "./instagram-store.js";

// ── Paths ──────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || '/root';
const ARTIFACTS_DIR = path.join(HOME, '.openclaw/workspace/artifacts/personal');
const TOKEN_HEALTH_FILE = path.join(ARTIFACTS_DIR, 'instagram/token-health.json');
const TRADING_URL = 'http://127.0.0.1:18793';

// ── Types ──────────────────────────────────────────────────────────────────

export interface HealthCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

export interface HealthReport {
  timestamp: string;
  status: 'green' | 'yellow' | 'red';
  checks: HealthCheck[];
}

export interface TokenHealth {
  last_checked: string;
  expires_at: number;
  days_remaining: number;
  last_refresh: string | null;
  refresh_error?: string;
  status: 'ok' | 'expiring' | 'expired' | 'missing' | 'refresh_failed';
}

// ── 1. ESCALATION MANAGER ──────────────────────────────────────────────

export type EscalationLevel = 'AUTO_RESOLVE' | 'NOTIFY' | 'ACTION_REQUIRED' | 'CRITICAL';

export interface Escalation {
  level: EscalationLevel;
  source: string;
  message: string;
  action?: string;
}

export function escalate(
  source: string,
  level: EscalationLevel,
  message: string,
  action?: string,
): Escalation {
  return { level, source, message, action };
}

export function formatEscalation(e: Escalation): string | null {
  switch (e.level) {
    case 'AUTO_RESOLVE':
      return null; // No Telegram, just log
    case 'NOTIFY':
      return `ℹ️ *${e.source}*\n${e.message}`;
    case 'ACTION_REQUIRED':
      return `⚠️ *${e.source}*\n${e.message}${e.action ? `\n\n*Aktion:* ${e.action}` : ''}`;
    case 'CRITICAL':
      return `🔴 *CRITICAL — ${e.source}*\n${e.message}${e.action ? `\n\n*Sofort:* ${e.action}` : ''}`;
  }
}

// ── Anthropic Key Reader ───────────────────────────────────────────────

function readAnthropicKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const envPath = path.join(HOME, '.config/openclaw/env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const eq = line.indexOf('=');
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key === 'ANTHROPIC_API_KEY' && val) return val;
    }
  } catch {}
  return '';
}

// ── Live Token Validation ─────────────────────────────────────────────

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

/** Lightweight live check: GET /me?fields=id — confirms token is accepted by Meta */
async function validateTokenLive(accessToken: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await fetch(`${GRAPH_BASE}/me?fields=id&access_token=${encodeURIComponent(accessToken)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { valid: true };
    const body = await res.text().catch(() => '');
    if (body.includes('"code":190') || body.includes('"code": 190') ||
        body.includes('expired') || body.includes('Session has expired')) {
      return { valid: false, error: 'Token auf Meta-Seite abgelaufen (Code 190)' };
    }
    return { valid: false, error: `Meta API ${res.status}: ${body.slice(0, 120)}` };
  } catch (e: any) {
    // Network error — don't declare token dead, just warn
    return { valid: true, error: `Meta API nicht erreichbar: ${e.message}` };
  }
}

// ── Token Health Persistence ───────────────────────────────────────────

function saveTokenHealth(h: TokenHealth): void {
  const dir = path.dirname(TOKEN_HEALTH_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_HEALTH_FILE, JSON.stringify(h, null, 2), 'utf-8');
}

export function loadTokenHealth(): TokenHealth | null {
  try {
    if (!fs.existsSync(TOKEN_HEALTH_FILE)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_HEALTH_FILE, 'utf-8'));
  } catch { return null; }
}

// ── 2. PRE-FLIGHT CHECKS ──────────────────────────────────────────────

export interface PreFlightResult {
  ok: boolean;
  failures: string[];
}

/** Check Instagram pre-flight: token valid, Anthropic reachable, optional submission exists */
export async function preFlightInstagram(submissionId?: string): Promise<PreFlightResult> {
  const failures: string[] = [];

  // Token valid? (from cached token-health.json, max 1h old)
  const th = loadTokenHealth();
  const oneHourAgo = Date.now() - 3600_000;
  if (th && new Date(th.last_checked).getTime() > oneHourAgo) {
    if (th.status === 'expired' || th.status === 'missing') {
      failures.push(`Instagram-Token: ${th.status === 'expired' ? 'abgelaufen' : 'nicht vorhanden'}`);
    } else if (th.status === 'refresh_failed') {
      failures.push('Instagram-Token: Refresh fehlgeschlagen');
    }
  } else {
    // Fallback: direct check
    const tokens = loadInstaTokens();
    if (!tokens) {
      failures.push('Instagram-Token: nicht vorhanden');
    } else if (tokenDaysRemaining() <= 0) {
      failures.push('Instagram-Token: abgelaufen');
    }
  }

  // Anthropic API reachable?
  try {
    const key = readAnthropicKey();
    if (!key) {
      failures.push('Anthropic API: Key nicht konfiguriert');
    } else {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401) {
        failures.push('Anthropic API: Key ungültig (401)');
      } else if (!res.ok && res.status >= 500) {
        failures.push(`Anthropic API: Server-Fehler (${res.status})`);
      }
    }
  } catch (e: any) {
    failures.push(`Anthropic API: nicht erreichbar (${e.message.slice(0, 60)})`);
  }

  // Submission exists and is valid JSON?
  if (submissionId) {
    const subPath = path.join(ARTIFACTS_DIR, 'instagram/inbox', `${submissionId}.json`);
    if (!fs.existsSync(subPath)) {
      failures.push(`Submission ${submissionId}: Datei nicht gefunden`);
    } else {
      try {
        JSON.parse(fs.readFileSync(subPath, 'utf-8'));
      } catch {
        failures.push(`Submission ${submissionId}: ungültiges JSON`);
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

/** Check Trading pre-flight: IBKR connected, market open */
export async function preFlightTrading(): Promise<PreFlightResult> {
  const failures: string[] = [];

  try {
    const res = await fetch(`${TRADING_URL}/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      failures.push('Trading-Service: nicht erreichbar');
    } else {
      const status = await res.json();
      if (!status.connected) {
        failures.push('IBKR: nicht verbunden');
      }
      if (status.marketStatus === 'closed') {
        failures.push('Markt: geschlossen');
      }
    }
  } catch {
    failures.push('Trading-Service: nicht erreichbar (Port 18793)');
  }

  return { ok: failures.length === 0, failures };
}

export function formatPreFlightFailure(failures: string[]): string {
  return '❌ Pre-Flight Check fehlgeschlagen:\n\n' +
    failures.map(f => `• ${f}`).join('\n') +
    '\n\nCommand nicht ausgeführt.';
}

// ── 3. STARTUP SELF-TEST ───────────────────────────────────────────────

export async function runStartupChecks(): Promise<HealthReport> {
  const checks: HealthCheck[] = [];

  // a) Instagram Token (live validation against Meta API)
  try {
    const tokens = loadInstaTokens();
    if (!tokens) {
      checks.push({ name: 'Instagram Token', status: 'warn', detail: 'Kein Token vorhanden' });
    } else {
      const days = tokenDaysRemaining();
      // Live check: stored expiry can lie (Meta may revoke/expire early)
      const live = await validateTokenLive(tokens.access_token);
      if (!live.valid) {
        checks.push({ name: 'Instagram Token', status: 'error', detail: `Auf Meta-Seite abgelaufen (gespeichert: ${days}d)` });
      } else if (days <= 0) {
        checks.push({ name: 'Instagram Token', status: 'error', detail: 'Token abgelaufen' });
      } else if (days < 7) {
        checks.push({ name: 'Instagram Token', status: 'warn', detail: `Läuft in ${days} Tagen ab` });
      } else {
        checks.push({ name: 'Instagram Token', status: 'ok', detail: `${days} Tage verbleibend` });
      }
    }
  } catch (e: any) {
    checks.push({ name: 'Instagram Token', status: 'error', detail: e.message });
  }

  // b) Anthropic API Ping
  try {
    const key = readAnthropicKey();
    if (!key) {
      checks.push({ name: 'Anthropic API', status: 'error', detail: 'API-Key nicht gefunden' });
    } else {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        checks.push({ name: 'Anthropic API', status: 'ok', detail: 'Erreichbar' });
      } else {
        const body = await res.text().catch(() => '');
        if (res.status === 401) {
          checks.push({ name: 'Anthropic API', status: 'error', detail: 'API-Key ungültig (401)' });
        } else {
          checks.push({ name: 'Anthropic API', status: 'warn', detail: `HTTP ${res.status}: ${body.slice(0, 100)}` });
        }
      }
    }
  } catch (e: any) {
    checks.push({ name: 'Anthropic API', status: 'error', detail: `Nicht erreichbar: ${e.message}` });
  }

  // c) Key JSON Files
  const jsonFiles: [string, string][] = [
    ['style-profile.json', path.join(ARTIFACTS_DIR, 'instagram/style-profile.json')],
    ['insights-cache.json', path.join(ARTIFACTS_DIR, 'instagram/insights-cache.json')],
    ['vehicles.json', path.join(ARTIFACTS_DIR, 'fleet/vehicles.json')],
    ['properties.json', path.join(ARTIFACTS_DIR, 'assets/properties.json')],
  ];

  for (const [label, filePath] of jsonFiles) {
    try {
      if (!fs.existsSync(filePath)) {
        checks.push({ name: label, status: 'warn', detail: 'Datei nicht vorhanden' });
      } else {
        JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        checks.push({ name: label, status: 'ok', detail: 'Valides JSON' });
      }
    } catch (e: any) {
      checks.push({ name: label, status: 'error', detail: `JSON-Parse fehlgeschlagen: ${e.message}` });
    }
  }

  // d) Write Permissions
  const testFile = path.join(ARTIFACTS_DIR, '.health-check-write-test');
  try {
    fs.writeFileSync(testFile, 'test', 'utf-8');
    fs.unlinkSync(testFile);
    checks.push({ name: 'Schreibrechte', status: 'ok', detail: 'artifacts/ beschreibbar' });
  } catch (e: any) {
    checks.push({ name: 'Schreibrechte', status: 'error', detail: `Schreibfehler: ${e.message}` });
  }

  // Determine overall status
  const hasError = checks.some(c => c.status === 'error');
  const hasWarn = checks.some(c => c.status === 'warn');
  const status: HealthReport['status'] = hasError ? 'red' : hasWarn ? 'yellow' : 'green';

  return { timestamp: new Date().toISOString(), status, checks };
}

export function formatHealthReport(report: HealthReport, title?: string): string {
  const icon = report.status === 'green' ? '🟢' : report.status === 'yellow' ? '🟡' : '🔴';
  const label = title || 'Startup Self-Test';
  const lines = [`${icon} *${label}: ${report.status.toUpperCase()}*\n`];
  for (const c of report.checks) {
    const ci = c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️' : '❌';
    lines.push(`${ci} ${c.name}: ${c.detail}`);
  }
  return lines.join('\n');
}

// ── 4. TOKEN GUARDIAN ──────────────────────────────────────────────────

export async function checkAndRefreshInstagramToken(
  appId: string,
  appSecret: string,
): Promise<TokenHealth> {
  const now = new Date();

  const tokens = loadInstaTokens();
  if (!tokens) {
    const health: TokenHealth = {
      last_checked: now.toISOString(),
      expires_at: 0,
      days_remaining: 0,
      last_refresh: null,
      status: 'missing',
    };
    saveTokenHealth(health);
    return health;
  }

  const daysRemaining = tokenDaysRemaining();
  let isExpired = daysRemaining <= 0;

  // Live validation: stored expiry can be wrong (Meta can revoke/expire early)
  if (!isExpired && tokens.access_token) {
    const live = await validateTokenLive(tokens.access_token);
    if (!live.valid) {
      console.log(`[token-guardian] Live-Check: Token auf Meta-Seite abgelaufen trotz ${daysRemaining}d gespeichert`);
      isExpired = true;
    }
  }

  const isCritical = daysRemaining < 3 || isExpired;
  const isProactive = daysRemaining < 14;
  let refreshed = false;
  let refreshError = '';

  if (isExpired || isProactive) {
    try {
      const force = isExpired || isCritical;
      await ensureFreshToken(appId, appSecret, force);
      refreshed = true;
    } catch (e: any) {
      refreshError = e?.message || 'Unbekannter Fehler';
      console.error(`[token-guardian] Refresh fehlgeschlagen: ${refreshError}`);
    }
  }

  const currentTokens = loadInstaTokens();
  const currentDays = tokenDaysRemaining();

  let status: TokenHealth['status'];
  if (!currentTokens) {
    status = 'missing';
  } else if (isExpired && !refreshed) {
    status = 'expired';
  } else if (currentDays <= 0) {
    status = isExpired && !refreshed ? 'refresh_failed' : 'expired';
  } else if (isProactive && !refreshed) {
    status = 'refresh_failed';
  } else if (currentDays < 14) {
    status = 'expiring';
  } else {
    // After successful refresh, verify live again
    status = 'ok';
  }

  const health: TokenHealth = {
    last_checked: now.toISOString(),
    expires_at: currentTokens?.expires_at ?? 0,
    days_remaining: currentDays,
    last_refresh: refreshed ? now.toISOString() : null,
    ...(refreshError ? { refresh_error: refreshError } : {}),
    status,
  };
  saveTokenHealth(health);

  return health;
}

export function evaluateTokenAlert(
  health: TokenHealth,
  refreshed: boolean,
): Escalation | null {
  if (health.status === 'missing') {
    return escalate('Token Guardian', 'ACTION_REQUIRED',
      'Kein Instagram-Token vorhanden.',
      'Token im Meta Developer Portal generieren und via /instasync einrichten.');
  }
  if (health.status === 'refresh_failed') {
    const errDetail = health.refresh_error ? `\nFehler: ${health.refresh_error}` : '';
    return escalate('Token Guardian', 'ACTION_REQUIRED',
      `Token-Refresh fehlgeschlagen! Verbleibend: ${health.days_remaining} Tage.${errDetail}`,
      '1. Meta Developer Portal öffnen\n2. Neuen Long-Lived Token generieren\n3. Token in ~/.config/openclaw/env eintragen\n4. /instasync ausführen');
  }
  if (health.status === 'expired') {
    const errDetail = health.refresh_error ? `\nFehler: ${health.refresh_error}` : '';
    return escalate('Token Guardian', 'ACTION_REQUIRED',
      `Token abgelaufen${refreshed ? ' (Refresh-Versuch gescheitert)' : ''}!${errDetail}`,
      'Neuen Token im Meta Developer Portal generieren.');
  }
  if (health.days_remaining < 3) {
    return escalate('Token Guardian', 'ACTION_REQUIRED',
      `Token läuft in ${health.days_remaining} Tagen ab!${refreshed ? ' Wurde soeben erneuert.' : ''}`,
      'Bitte zeitnah prüfen.');
  }
  if (refreshed) {
    return escalate('Token Guardian', 'AUTO_RESOLVE',
      `Token erfolgreich erneuert, ${health.days_remaining} Tage verbleibend.`);
  }
  return null;
}

// ── 5. DAILY HEALTH CHECK (08:00 UTC) ──────────────────────────────────

export async function runDailyHealthCheck(): Promise<HealthReport> {
  const checks: HealthCheck[] = [];

  // Instagram Token (live validation)
  try {
    const tokens = loadInstaTokens();
    if (!tokens) {
      checks.push({ name: 'Instagram Token', status: 'warn', detail: 'Nicht vorhanden' });
    } else {
      const days = tokenDaysRemaining();
      const live = await validateTokenLive(tokens.access_token);
      if (!live.valid) {
        checks.push({ name: 'Instagram Token', status: 'error', detail: `Meta-seitig abgelaufen (gespeichert: ${days}d)` });
      } else if (days <= 0) {
        checks.push({ name: 'Instagram Token', status: 'error', detail: 'Abgelaufen' });
      } else if (days < 7) {
        checks.push({ name: 'Instagram Token', status: 'warn', detail: `${days} Tage` });
      } else {
        checks.push({ name: 'Instagram Token', status: 'ok', detail: `${days} Tage` });
      }
    }
  } catch (e: any) {
    checks.push({ name: 'Instagram Token', status: 'error', detail: e.message });
  }

  // Anthropic API
  try {
    const key = readAnthropicKey();
    if (!key) {
      checks.push({ name: 'Anthropic API', status: 'error', detail: 'Key fehlt' });
    } else {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) checks.push({ name: 'Anthropic API', status: 'ok', detail: 'OK' });
      else if (res.status === 401) checks.push({ name: 'Anthropic API', status: 'error', detail: 'Key ungültig' });
      else checks.push({ name: 'Anthropic API', status: 'warn', detail: `HTTP ${res.status}` });
    }
  } catch {
    checks.push({ name: 'Anthropic API', status: 'error', detail: 'Nicht erreichbar' });
  }

  // IBKR (only during trading hours: Mon-Fri 14:30-21:00 UTC)
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const isWeekday = utcDay >= 1 && utcDay <= 5;
  const isTradingHours = (utcHour > 14 || (utcHour === 14 && utcMin >= 30)) && utcHour < 21;
  if (isWeekday && isTradingHours) {
    try {
      const res = await fetch(`${TRADING_URL}/status`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const s = await res.json();
        if (s.connected) checks.push({ name: 'IBKR', status: 'ok', detail: 'Verbunden' });
        else checks.push({ name: 'IBKR', status: 'warn', detail: 'Nicht verbunden' });
      } else {
        checks.push({ name: 'IBKR', status: 'warn', detail: 'Service antwortet nicht' });
      }
    } catch {
      checks.push({ name: 'IBKR', status: 'warn', detail: 'Service nicht erreichbar' });
    }
  }

  // Key JSON Files
  const jsonFiles: [string, string][] = [
    ['style-profile.json', path.join(ARTIFACTS_DIR, 'instagram/style-profile.json')],
    ['insights-cache.json', path.join(ARTIFACTS_DIR, 'instagram/insights-cache.json')],
    ['vehicles.json', path.join(ARTIFACTS_DIR, 'fleet/vehicles.json')],
    ['properties.json', path.join(ARTIFACTS_DIR, 'assets/properties.json')],
  ];
  for (const [label, filePath] of jsonFiles) {
    try {
      if (!fs.existsSync(filePath)) {
        checks.push({ name: label, status: 'warn', detail: 'Fehlt' });
      } else {
        JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        checks.push({ name: label, status: 'ok', detail: 'OK' });
      }
    } catch {
      checks.push({ name: label, status: 'error', detail: 'JSON ungültig' });
    }
  }

  // Disk Space
  try {
    const dfOut = execSync('df -BG --output=avail / 2>/dev/null | tail -1', { encoding: 'utf-8' }).trim();
    const gbFree = parseInt(dfOut);
    if (isNaN(gbFree)) {
      checks.push({ name: 'Disk Space', status: 'warn', detail: 'Konnte nicht geprüft werden' });
    } else if (gbFree < 1) {
      checks.push({ name: 'Disk Space', status: 'error', detail: `${gbFree} GB frei` });
    } else if (gbFree < 5) {
      checks.push({ name: 'Disk Space', status: 'warn', detail: `${gbFree} GB frei` });
    } else {
      checks.push({ name: 'Disk Space', status: 'ok', detail: `${gbFree} GB frei` });
    }
  } catch {
    checks.push({ name: 'Disk Space', status: 'warn', detail: 'Prüfung fehlgeschlagen' });
  }

  // Service Uptime
  for (const svc of ['openclaw-gateway', 'openclaw-trading']) {
    try {
      const out = execSync(
        `systemctl --user is-active ${svc}.service 2>/dev/null`,
        { encoding: 'utf-8' },
      ).trim();
      if (out === 'active') {
        checks.push({ name: svc, status: 'ok', detail: 'Läuft' });
      } else {
        checks.push({ name: svc, status: 'warn', detail: out });
      }
    } catch {
      checks.push({ name: svc, status: 'warn', detail: 'Nicht aktiv' });
    }
  }

  const hasError = checks.some(c => c.status === 'error');
  const hasWarn = checks.some(c => c.status === 'warn');
  const status: HealthReport['status'] = hasError ? 'red' : hasWarn ? 'yellow' : 'green';

  return { timestamp: new Date().toISOString(), status, checks };
}

// ── 6. PRE-SEND VALIDATION WRAPPER ─────────────────────────────────────

export async function safeTelegramSend(
  sendFn: (chatId: string, message: string) => Promise<boolean>,
  chatId: string,
  message: string,
  verifyFn?: () => boolean,
  operation?: string,
): Promise<void> {
  if (verifyFn) {
    const ok = verifyFn();
    if (!ok) {
      const opLabel = operation || 'Operation';
      const errorMsg = `⚠️ [${opLabel}] konnte nicht abgeschlossen werden: Verifikation fehlgeschlagen`;
      await sendFn(chatId, errorMsg);
      throw new Error(errorMsg);
    }
  }
  const sent = await sendFn(chatId, message);
  if (!sent) {
    const opLabel = operation || 'Nachricht';
    throw new Error(`[${opLabel}] Telegram-Zustellung fehlgeschlagen`);
  }
}
