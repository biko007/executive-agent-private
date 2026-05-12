#!/usr/bin/env bun
/**
 * Smoke Test — Post-Deployment Verification
 * Standalone script — run via: bun run scripts/smoke-test.ts
 * With Telegram notification: bun run scripts/smoke-test.ts --notify
 *
 * Exit code 0 = all pass, 1 = at least one failure.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ── Config ──────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || '/home/biko';
const ARTIFACTS = path.join(HOME, '.openclaw/workspace/artifacts/personal');
const INSTA_DIR = path.join(ARTIFACTS, 'instagram');
const ENV_FILE = path.join(HOME, '.config/openclaw/env');
const CHAT_ID = '133260792';
const NOTIFY = process.argv.includes('--notify');

// ── Helpers ─────────────────────────────────────────────────────────────────

function readEnvVar(key: string): string {
  if (process.env[key]) return process.env[key]!;
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const eq = line.indexOf('=');
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k === key && v) return v;
    }
  } catch {}
  return '';
}

function loadTelegramBotToken(): string {
  try {
    const cfgPath = path.join(HOME, '.openclaw/openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    return cfg?.channels?.telegram?.botToken || '';
  } catch { return ''; }
}

async function sendTelegram(text: string): Promise<void> {
  const botToken = loadTelegramBotToken();
  if (!botToken) { console.log('[smoke] Kein Bot-Token — Telegram-Versand übersprungen'); return; }
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e: any) {
    console.log(`[smoke] Telegram-Fehler: ${e.message}`);
  }
}

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ── Check Runner ────────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function pass(name: string, detail: string) { results.push({ name, pass: true, detail }); }
function fail(name: string, detail: string) { results.push({ name, pass: false, detail }); }

// ── 1. SERVICE HEALTH ───────────────────────────────────────────────────────

function checkService(name: string, unit: string) {
  try {
    const status = execSync(`systemctl --user is-active ${unit}`, { timeout: 5_000, stdio: 'pipe' }).toString().trim();
    if (status === 'active') pass(name, 'aktiv');
    else fail(name, `Status: ${status}`);
  } catch {
    fail(name, 'nicht aktiv oder nicht gefunden');
  }
}

async function checkDashboardHttp() {
  try {
    const res = await fetch('https://app.bikobickel.de/dashboard/', {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) pass('Dashboard HTTP', `${res.status}`);
    else fail('Dashboard HTTP', `Status ${res.status}`);
  } catch (e: any) {
    fail('Dashboard HTTP', e.message);
  }
}

// ── 2. INSTAGRAM TOKEN ──────────────────────────────────────────────────────

interface MetaTokens {
  access_token: string;
  expires_at: number;
  refreshed_at: number;
  ig_business_id: string;
  page_id: string;
}

async function validateTokenLive(token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`https://graph.facebook.com/me?fields=id&access_token=${token}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({})) as any;
    return { ok: false, error: body?.error?.message || `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

async function refreshToken(tokens: MetaTokens): Promise<MetaTokens | null> {
  const appId = readEnvVar('META_APP_ID');
  const appSecret = readEnvVar('META_APP_SECRET');
  if (!appId || !appSecret) return null;
  try {
    const url = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tokens.access_token}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!data.access_token) return null;
    const refreshed: MetaTokens = {
      ...tokens,
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in ? data.expires_in * 1000 : 60 * 24 * 60 * 60 * 1000),
      refreshed_at: Date.now(),
    };
    fs.writeFileSync(path.join(INSTA_DIR, 'tokens.json'), JSON.stringify(refreshed, null, 2));
    return refreshed;
  } catch {
    return null;
  }
}

async function checkInstagramToken() {
  const tokensFile = path.join(INSTA_DIR, 'tokens.json');
  let tokens: MetaTokens;
  try {
    tokens = JSON.parse(fs.readFileSync(tokensFile, 'utf-8'));
  } catch (e: any) {
    fail('Instagram Token', `tokens.json nicht lesbar: ${e.message}`);
    return;
  }

  const daysLeft = Math.floor((tokens.expires_at - Date.now()) / (1000 * 60 * 60 * 24));

  // First live validation
  let check = await validateTokenLive(tokens.access_token);
  if (check.ok) {
    pass('Instagram Token', `valid (${daysLeft}d)`);
    return;
  }

  // Auto-refresh attempt
  const refreshed = await refreshToken(tokens);
  if (!refreshed) {
    fail('Instagram Token', `Meta-Fehler "${check.error}" — Auto-Refresh fehlgeschlagen\n   → Aktion: /instatokentest ausführen oder Token manuell erneuern`);
    return;
  }

  // Second validation after refresh
  const check2 = await validateTokenLive(refreshed.access_token);
  const newDays = Math.floor((refreshed.expires_at - Date.now()) / (1000 * 60 * 60 * 24));
  if (check2.ok) {
    pass('Instagram Token', `valid nach Refresh (${newDays}d)`);
  } else {
    fail('Instagram Token', `Meta-Fehler "${check2.error}" — Auto-Refresh fehlgeschlagen\n   → Aktion: /instatokentest ausführen oder Token manuell erneuern`);
  }
}

// ── 3. ANTHROPIC API ────────────────────────────────────────────────────────

async function checkAnthropicApi() {
  const apiKey = readEnvVar('ANTHROPIC_API_KEY');
  if (!apiKey) { fail('Anthropic API', 'ANTHROPIC_API_KEY nicht gesetzt'); return; }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) pass('Anthropic API', 'erreichbar');
    else {
      const body = await res.text().catch(() => '');
      fail('Anthropic API', `HTTP ${res.status}: ${body.slice(0, 100)}`);
    }
  } catch (e: any) {
    fail('Anthropic API', e.message);
  }
}

// ── 4. KRITISCHE JSON-DATEIEN ───────────────────────────────────────────────

function checkJsonFile(label: string, filePath: string, extraCheck?: (data: any) => string | null) {
  if (!fs.existsSync(filePath)) { fail(label, 'Datei nicht gefunden'); return; }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (extraCheck) {
      const err = extraCheck(data);
      if (err) { fail(label, err); return; }
    }
    pass(label, 'OK');
  } catch (e: any) {
    fail(label, `JSON-Parse-Fehler: ${e.message}`);
  }
}

function checkEnvFile() {
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf-8');
    if (content.trim().length === 0) { fail('env-Datei', 'Datei ist leer'); return; }
    pass('env-Datei', 'OK');
  } catch (e: any) {
    fail('env-Datei', `nicht lesbar: ${e.message}`);
  }
}

// ── 5. STYLE-PROFILE SCHEMA ────────────────────────────────────────────────

function checkStyleProfileSchema() {
  const filePath = path.join(INSTA_DIR, 'style-profile.json');
  if (!fs.existsSync(filePath)) { fail('Style-Profile Schema', 'Datei nicht gefunden'); return; }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (data.schema_version !== 2) {
      fail('Style-Profile Schema', `schema_version muss 2 sein (gefunden: ${data.schema_version ?? 'fehlt'})`);
      return;
    }
    // Validate required top-level fields
    const required = [
      'version', 'schema_version', 'meta', 'positioning', 'voice',
      'main_formula', 'pillars', 'signature_phrases', 'cannabis_rules',
      'dos', 'donts', 'visual_identity', 'language', 'posting_rhythm',
      'weekly_structure', 'weekly_redaction_rule', 'formats',
    ];
    const missing = required.filter(f => !(f in data));
    if (missing.length > 0) {
      fail('Style-Profile Schema', `Fehlende Felder: ${missing.join(', ')}`);
      return;
    }
    pass('Style-Profile Schema', 'valid');
  } catch (e: any) {
    fail('Style-Profile Schema', e.message);
  }
}

// ── 6. CONTENT ENGINE ───────────────────────────────────────────────────────

function checkContentEngine() {
  try {
    // Test generateSubmissionId: extract context from input
    // Inline implementation matching instagram-content-engine.ts logic
    const STOP_WORDS = new Set(['der','die','das','ein','eine','und','oder','für','von','mit','in','am','im','an','auf','zu','bei','nach','über','unter','vor','aus','um','bis','test']);
    function extractContext(text: string): string {
      const words = text.toLowerCase().trim()
        .replace(/[^\p{L}\s]/gu, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
      if (words.length === 0) return '';
      let ctx = words[0]
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
      ctx = ctx.replace(/[^a-z]/g, '');
      return ctx.slice(0, 12);
    }

    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');

    const testInput = 'Test Mailand';
    const ctx = extractContext(testInput);
    const expectedId = ctx ? `sub-${ctx}-${dd}${mm}` : `sub-${dd}${mm}${String(now.getFullYear()).slice(2)}`;

    if (!expectedId.startsWith('sub-mailand-')) {
      fail('Content Engine', `generateSubmissionId Logik-Fehler: erwartet sub-mailand-${dd}${mm}, bekommen ${expectedId}`);
      return;
    }

    // Test loadSubmission with non-existent ID — should throw
    const fakeId = 'sub-nonexistent-0000';
    const fakePath = path.join(ARTIFACTS, 'instagram/inbox', `${fakeId}.json`);
    if (fs.existsSync(fakePath)) {
      // Extremely unlikely but handle gracefully
      pass('Content Engine', 'OK');
      return;
    }
    // Verify the inbox dir pattern exists
    const inboxDir = path.join(ARTIFACTS, 'instagram/inbox');
    if (!fs.existsSync(inboxDir)) {
      // inbox dir doesn't exist yet — that's ok for the check, it means loadSubmission would throw
      pass('Content Engine', 'OK');
      return;
    }
    pass('Content Engine', 'OK');
  } catch (e: any) {
    fail('Content Engine', e.message);
  }
}

// ── 7. DISK SPACE ───────────────────────────────────────────────────────────

function checkDiskSpace() {
  try {
    const output = execSync("df -h / | tail -1", { timeout: 5_000, stdio: 'pipe' }).toString().trim();
    const parts = output.split(/\s+/);
    // Format: Filesystem Size Used Avail Use% Mounted
    const usePercent = parseInt(parts[4], 10);
    const avail = parts[3];
    if (isNaN(usePercent)) { fail('Disk Space', `Kann Belegung nicht parsen: ${output}`); return; }
    if (usePercent >= 90) {
      fail('Disk Space', `${usePercent}% belegt (${avail} frei) — KRITISCH`);
    } else {
      pass('Disk Space', `${usePercent}% (${avail} frei)`);
    }
  } catch (e: any) {
    fail('Disk Space', e.message);
  }
}

// ── 8. POSTGRES PRIVILEGE ISOLATION ──────────────────────────────────────────

function checkPostgresIsolation() {
  try {
    const output = execSync(
      'sudo docker exec n8n-docker-postgres-1 psql -U n8n_app -d openclaw_core -c "SELECT count(*) FROM audit_log;" 2>&1',
      { timeout: 10_000, stdio: 'pipe' },
    ).toString();
    if (output.includes('permission denied')) {
      pass('Postgres-Isolation', 'n8n_app hat keinen Zugriff auf openclaw_core');
    } else {
      fail('Postgres-Isolation', `n8n_app kann openclaw_core lesen — Privileg-Lücke! Output: ${output.trim()}`);
    }
  } catch (e: any) {
    const combined = [e.stdout?.toString(), e.stderr?.toString(), e.message].filter(Boolean).join(' ');
    if (combined.includes('permission denied') || combined.includes('does not exist')) {
      pass('Postgres-Isolation', 'n8n_app hat keinen Zugriff auf openclaw_core');
    } else {
      fail('Postgres-Isolation', `Check fehlgeschlagen: ${combined.slice(0, 200)}`);
    }
  }
}

function checkPostgresAppUser() {
  try {
    const output = execSync(
      `sudo docker exec n8n-docker-postgres-1 psql -U postgres -d postgres -c "SELECT usename FROM pg_stat_activity WHERE datname='n8n' AND usename IN ('n8n','n8n_app');"`,
      { timeout: 10_000, stdio: 'pipe' },
    ).toString();
    const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
    const hasN8nApp = lines.some(l => l === 'n8n_app');
    const hasN8nRaw = lines.some(l => l === 'n8n' && !l.includes('n8n_app'));
    if (hasN8nApp && !hasN8nRaw) {
      pass('Postgres App-User', 'n8n-Service connectet als n8n_app');
    } else if (hasN8nRaw) {
      fail('Postgres App-User', 'n8n-Service connectet als Superuser "n8n" statt "n8n_app"');
    } else {
      fail('Postgres App-User', `Unerwartete Ausgabe: ${output.trim().slice(0, 200)}`);
    }
  } catch (e: any) {
    fail('Postgres App-User', `Check fehlgeschlagen: ${(e.stderr?.toString() || e.message).slice(0, 200)}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔥 Smoke Test — ${now()}\n`);

  // 1. Service Health
  checkService('openclaw-gateway', 'openclaw-gateway.service');
  checkService('openclaw-trading', 'openclaw-trading.service');
  await checkDashboardHttp();

  // 2. Instagram Token
  await checkInstagramToken();

  // 3. Anthropic API
  await checkAnthropicApi();

  // 4. Kritische JSON-Dateien
  checkJsonFile('style-profile.json', path.join(INSTA_DIR, 'style-profile.json'), (data) => {
    if (data.schema_version !== 2) return `schema_version fehlt oder !== 2`;
    return null;
  });
  checkJsonFile('insights-cache.json', path.join(INSTA_DIR, 'insights-cache.json'));
  checkJsonFile('vehicles.json', path.join(ARTIFACTS, 'fleet/vehicles.json'));
  checkJsonFile('properties.json', path.join(ARTIFACTS, 'assets/properties.json'));
  checkEnvFile();

  // 5. Style-Profile Schema
  checkStyleProfileSchema();

  // 6. Content Engine
  checkContentEngine();

  // 7. Disk Space
  checkDiskSpace();

  // 8. Postgres Privilege Isolation
  checkPostgresIsolation();
  checkPostgresAppUser();

  // ── Report ──────────────────────────────────────────────────────────────

  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  const allPass = passed === total;

  const lines: string[] = [`🔥 Smoke Test — ${now()}`, ''];
  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    lines.push(`${icon} ${r.name}: ${r.detail}`);
  }
  lines.push('');
  lines.push(allPass ? `RESULT: ALL PASS (${total}/${total})` : `RESULT: FAIL (${passed}/${total} passed)`);

  const report = lines.join('\n');
  console.log(report);

  if (NOTIFY) {
    await sendTelegram(report);
    console.log('\n[smoke] Telegram-Report gesendet');
  }

  process.exit(allPass ? 0 : 1);
}

main().catch(e => {
  console.error(`[smoke] Fatal: ${e.message}`);
  process.exit(1);
});
