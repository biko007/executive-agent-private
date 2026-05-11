/**
 * shared/utils — small universal helpers used across all modules.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** ISO timestamp string */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Random hex ID with prefix: prefix_<12hex> */
export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

/** Promise-based delay */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse Retry-After header (seconds) → ms, capped at 30s */
export function parseRetryAfterMs(res: Response): number | null {
  const ra = res.headers.get('retry-after');
  if (!ra) return null;
  const secs = Number(ra);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  return null;
}

/** Fetch with AbortController timeout */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`fetch_timeout_after_${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** YYYY-MM-DD in Europe/Berlin, with optional day offset */
export function berlinDate(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

/** Read a key from ~/.config/openclaw/env by variable name */
export function readEnvKey(name: string): string {
  // Check process.env first
  if (process.env[name]) return process.env[name]!;
  try {
    const envPath = path.join(process.env.HOME || '/root', '.config/openclaw/env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const eq = line.indexOf('=');
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key === name && val) return val;
    }
  } catch {}
  return '';
}

export function readAnthropicKey(): string {
  return readEnvKey('ANTHROPIC_API_KEY');
}

export function readOpenAIKey(): string {
  return readEnvKey('OPENAI_API_KEY');
}
