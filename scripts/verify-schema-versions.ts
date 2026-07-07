#!/usr/bin/env bun
/**
 * Schema Drift Detector — Sprint 11.5
 *
 * Read-only comparison: SQL migration files on disk vs entries in schema_version table.
 * Reports gaps (file exists but no DB entry) and orphans (DB entry but no file).
 *
 * Exit codes:
 *   0 = no drift
 *   1 = drift found (gaps or orphans)
 *   2 = error (DB not reachable, etc.)
 *
 * Usage:
 *   bun run scripts/verify-schema-versions.ts
 *   bun run scripts/verify-schema-versions.ts --notify   # push to Telegram on drift
 */

import fs from 'fs';
import path from 'path';
import pg from 'pg';

// ── Config ──────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || '/home/biko';
const ENV_FILE = path.join(HOME, '.config/openclaw/env');
const AGENT_ROOT = path.resolve(import.meta.dir, '..');
const CHAT_ID = '133260792';
const NOTIFY = process.argv.includes('--notify');

/**
 * Mapping: relative migration directory → module name in schema_version.
 * Derived from runMigrations() calls in index.ts and migrate-* scripts.
 */
const MIGRATION_DIRS: Array<{ dir: string; module: string }> = [
  { dir: 'src/shared/migrations',              module: 'shared' },
  { dir: 'src/shared/settings/migrations',     module: 'settings' },
  { dir: 'src/modules/executive/migrations',   module: 'executive' },
  { dir: 'src/modules/instagram/migrations',   module: 'instagram' },
  { dir: 'src/modules/health/migrations',      module: 'health' },
  { dir: 'src/modules/assets/migrations',      module: 'assets' },
  { dir: 'src/modules/fleet/migrations',       module: 'fleet' },
  { dir: 'src/modules/banking/migrations',     module: 'banking' },
  { dir: 'src/modules/location/migrations',    module: 'location' },
  { dir: 'src/modules/links/migrations',       module: 'links' },
  { dir: 'src/modules/sharepoint/migrations',  module: 'sharepoint' },
  { dir: 'src/modules/memory/migrations',      module: 'memory' },
];

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
  const fromEnv = readEnvVar('TELEGRAM_BOT_TOKEN');
  if (fromEnv) return fromEnv;
  try {
    const cfgPath = path.join(HOME, '.openclaw/openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const raw = cfg?.channels?.telegram?.botToken;
    if (typeof raw === 'string') return raw;
    if (raw?.source === 'env' && raw?.id) return readEnvVar(raw.id);
    return '';
  } catch { return ''; }
}

async function sendTelegram(text: string): Promise<void> {
  const botToken = loadTelegramBotToken();
  if (!botToken) { console.log('[drift] Kein Bot-Token — Telegram übersprungen'); return; }
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e: any) {
    console.log(`[drift] Telegram-Fehler: ${e.message}`);
  }
}

/** Extract version number from migration filename (NNN_*.sql or VNNN__*.sql) */
function extractVersion(filename: string): number | null {
  const match = filename.match(/^V?(\d+)[_]/);
  return match ? parseInt(match[1], 10) : null;
}

// ── Core Logic ──────────────────────────────────────────────────────────────

interface ModuleResult {
  module: string;
  fileVersions: number[];
  dbVersions: number[];
  gaps: number[];     // in file but not in DB
  orphans: number[];  // in DB but not in file
  status: 'OK' | 'DRIFT' | 'ORPHAN' | 'DRIFT+ORPHAN';
}

async function main() {
  console.log(`\n📋 Schema Drift Detector — ${new Date().toISOString().replace('T', ' ').slice(0, 19)}\n`);

  // 1. Connect to DB
  const connStr = readEnvVar('POSTGRES_URL');
  if (!connStr) {
    console.error('ERROR: POSTGRES_URL nicht gesetzt');
    process.exit(2);
  }

  const pool = new pg.Pool({ connectionString: connStr });
  let dbVersionsByModule: Map<string, Set<number>>;

  try {
    const { rows } = await pool.query<{ module: string; version: number }>(
      'SELECT module, version FROM schema_version ORDER BY module, version'
    );
    dbVersionsByModule = new Map();
    for (const r of rows) {
      if (!dbVersionsByModule.has(r.module)) dbVersionsByModule.set(r.module, new Set());
      dbVersionsByModule.get(r.module)!.add(r.version);
    }
  } catch (e: any) {
    console.error(`ERROR: DB nicht erreichbar — ${e.message}`);
    await pool.end();
    process.exit(2);
  }

  // 2. Scan migration directories
  const results: ModuleResult[] = [];

  for (const { dir, module: moduleName } of MIGRATION_DIRS) {
    const absDir = path.join(AGENT_ROOT, dir);
    const fileVersions: number[] = [];

    try {
      const files = fs.readdirSync(absDir).filter(f => f.endsWith('.sql')).sort();
      for (const f of files) {
        const v = extractVersion(f);
        if (v !== null) fileVersions.push(v);
      }
    } catch {
      // No migrations dir — skip (e.g., pe, travel)
    }

    if (fileVersions.length === 0 && !dbVersionsByModule.has(moduleName)) continue;

    const dbVersions = [...(dbVersionsByModule.get(moduleName) || [])].sort((a, b) => a - b);
    const dbSet = new Set(dbVersions);
    const fileSet = new Set(fileVersions);

    const gaps = fileVersions.filter(v => !dbSet.has(v));
    const orphans = dbVersions.filter(v => !fileSet.has(v));

    let status: ModuleResult['status'] = 'OK';
    if (gaps.length > 0 && orphans.length > 0) status = 'DRIFT+ORPHAN';
    else if (gaps.length > 0) status = 'DRIFT';
    else if (orphans.length > 0) status = 'ORPHAN';

    results.push({ module: moduleName, fileVersions, dbVersions, gaps, orphans, status });
  }

  // 3. Check for DB modules with no matching migration dir
  const knownModules = new Set(MIGRATION_DIRS.map(d => d.module));
  for (const [dbModule, dbVersionsSet] of dbVersionsByModule) {
    if (!knownModules.has(dbModule)) {
      const dbVersions = [...dbVersionsSet].sort((a, b) => a - b);
      results.push({
        module: dbModule,
        fileVersions: [],
        dbVersions,
        gaps: [],
        orphans: dbVersions,
        status: 'ORPHAN',
      });
    }
  }

  // Sort by module name
  results.sort((a, b) => a.module.localeCompare(b.module));

  // 4. Output table
  const colModule = 14;
  const colFile = 20;
  const colDb = 20;
  const colStatus = 14;

  const header = `${'Module'.padEnd(colModule)} ${'File Versions'.padEnd(colFile)} ${'DB Versions'.padEnd(colDb)} ${'Status'.padEnd(colStatus)}`;
  const sep = '─'.repeat(header.length);

  console.log(sep);
  console.log(header);
  console.log(sep);

  let hasDrift = false;

  for (const r of results) {
    const fileStr = r.fileVersions.join(',') || '–';
    const dbStr = r.dbVersions.join(',') || '–';
    const statusIcon = r.status === 'OK' ? '✅ OK' : `❌ ${r.status}`;
    console.log(`${r.module.padEnd(colModule)} ${fileStr.padEnd(colFile)} ${dbStr.padEnd(colDb)} ${statusIcon}`);

    if (r.gaps.length > 0) {
      console.log(`${''.padEnd(colModule)}   ↳ Gaps (file, no DB): ${r.gaps.join(', ')}`);
    }
    if (r.orphans.length > 0) {
      console.log(`${''.padEnd(colModule)}   ↳ Orphans (DB, no file): ${r.orphans.join(', ')}`);
    }

    if (r.status !== 'OK') hasDrift = true;
  }

  console.log(sep);
  console.log(hasDrift ? '\nRESULT: DRIFT DETECTED' : '\nRESULT: ALL OK — no drift');

  // 5. Telegram on drift
  if (hasDrift && NOTIFY) {
    const driftModules = results.filter(r => r.status !== 'OK');
    const lines = ['⚠️ <b>Schema Drift Detected</b>', ''];
    for (const r of driftModules) {
      lines.push(`<b>${r.module}</b>: ${r.status}`);
      if (r.gaps.length > 0) lines.push(`  Gaps: ${r.gaps.join(', ')}`);
      if (r.orphans.length > 0) lines.push(`  Orphans: ${r.orphans.join(', ')}`);
    }
    await sendTelegram(lines.join('\n'));
    console.log('\n[drift] Telegram-Report gesendet');
  }

  await pool.end();
  process.exit(hasDrift ? 1 : 0);
}

main().catch(e => {
  console.error(`[drift] Fatal: ${e.message}`);
  process.exit(2);
});
