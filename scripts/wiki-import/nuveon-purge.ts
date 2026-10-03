#!/usr/bin/env bun
/**
 * nuveon-purge — Quellwiki bei Nuveon leeren, nach abgeschlossenem Import.
 *
 * Aufruf:
 *   bun run scripts/wiki-import/nuveon-purge.ts --dry-run   # nur anzeigen
 *   bun run scripts/wiki-import/nuveon-purge.ts             # löschen
 *
 * **Dieses Skript löscht unwiderruflich auf einem fremden System.** Es ist die
 * einzige Stelle im Repo, die gegenüber Nuveon schreibend arbeitet; der
 * Importer bleibt strikt lesend. Grundlage ist die Owner-Direktive vom
 * 2026-10-03, die die Stop-Condition „strikt lesend" für genau diesen Zweck
 * aufhebt.
 *
 * Schutzmaßnahmen, die im Code durchgesetzt sind:
 *
 *  1. **Kein Löschen ohne lokales Gegenstück.** Vor jeder einzelnen Löschung
 *     wird die lokale Kopie geprüft: bei Anhängen der sha256 der Datei auf der
 *     Platte gegen den Datenbankwert, bei Seiten die Existenz in `wiki_pages`.
 *     Schlägt das fehl, bleibt der Eintrag im Quellwiki stehen.
 *  2. **Passwortseiten sind ausgenommen** (`PASSWORD_PAGES`) — der Eigentümer
 *     überträgt sie zuerst nach 1Password und löscht sie selbst.
 *  3. **Anhänge zuerst, dann Seiten.** Eine gelöschte Seite nimmt ihre Anhänge
 *     mit; die umgekehrte Reihenfolge würde den Einzelnachweis je Anhang
 *     verlieren.
 *  4. **Sequenziell mit Pause** — keine Parallelität gegenüber dem Fremdsystem.
 *  5. **Wiederaufnahmefähig** über `_state/purge-state.json`; ein Abbruch
 *     wiederholt nichts.
 *  6. **Abbruch nach zu vielen Fehlern desselben Bildes** (Fix-Runden-Grenze).
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';

import {
  parsePageIndex, parseAttachmentIndex, normalizePageName,
  readNuveonCredentials, PASSWORD_PAGES, SYSTEM_PAGES,
} from '../../src/modules/wiki/index.js';

const BASE_URL = 'https://asp.nuveon.de';
const WIKI_PATH = '/biko';
const HOME = homedir();
const WIKI_DIR = join(HOME, '.openclaw/workspace/artifacts/personal/wiki');
const STATE_DIR = join(WIKI_DIR, '_state');
const STATE_FILE = join(STATE_DIR, 'purge-state.json');
const SUMMARY_FILE = join(STATE_DIR, 'purge-summary.json');
const CRED_FILE = join(HOME, '.config/openclaw/nuveon-wiki.env');
const ENV_FILE = join(HOME, '.config/openclaw/env');

const DRY_RUN = process.argv.includes('--dry-run');
const PAUSE_MS = 400;
/** Grenze gleichartiger Fehler, bevor abgebrochen wird. */
const MAX_FEHLER_GLEICHER_ART = 2;

function log(m: string): void { console.log(`[purge] ${m}`); }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

interface PurgeState {
  startedAt: string;
  attachments: Record<string, string>;
  pages: Record<string, string>;
}

interface Problem { ziel: string; grund: string }

interface Summary {
  finishedAt: string;
  dryRun: boolean;
  attachmentsDeleted: number;
  pagesDeleted: number;
  systemPagesDeleted: string[];
  systemPagesRefused: string[];
  skippedNoLocalCopy: Problem[];
  skippedException: string[];
  failures: Problem[];
  remainingPages: string[];
  remainingAttachments: string[];
}

/** Schreibende Sitzung zum Quellwiki — nur für diesen Auftrag. */
class WikiClient {
  private cookies = new Map<string, string>();

  private capture(res: Response): void {
    const raw = typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
    for (const e of raw as string[]) {
      const [pair] = e.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  private header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async login(user: string, pass: string): Promise<boolean> {
    await this.get(`${WIKI_PATH}/Login.jsp`);
    const form = new URLSearchParams({
      j_username: user, j_password: pass, submitlogin: 'Login', redirect: 'Home',
    });
    const res = await fetch(`${BASE_URL}${WIKI_PATH}/Login.jsp?redirect=Home`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: this.header(),
        'User-Agent': 'openclaw-wiki-purge/1.0',
      },
      body: form.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    this.capture(res);
    const probe = await this.get(`${WIKI_PATH}/wiki/Home`);
    return probe.status === 200 && !/name=["']j_password["']/i.test(probe.body);
  }

  async get(path: string): Promise<{ status: number; body: string }> {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Cookie: this.header(), 'User-Agent': 'openclaw-wiki-purge/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    });
    this.capture(res);
    return { status: res.status, body: await res.text() };
  }

  /** Prüft, ob eine Adresse noch Inhalt liefert. */
  async exists(path: string): Promise<boolean> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      headers: { Cookie: this.header(), 'User-Agent': 'openclaw-wiki-purge/1.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    this.capture(res);
    return res.status === 200;
  }

  /**
   * Der einzige schreibende Aufruf: die reguläre Löschfunktion von JSPWiki.
   * `ziel` ist entweder "Seite" oder "Seite/Datei".
   */
  async delete(ziel: string, label: string): Promise<number> {
    const [seite, ...rest] = ziel.split('/');
    const pfad = rest.length
      ? `${encodeURIComponent(seite)}/${encodeURIComponent(rest.join('/'))}`
      : encodeURIComponent(seite);
    const res = await fetch(`${BASE_URL}${WIKI_PATH}/Delete.jsp?page=${pfad}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: this.header(),
        'User-Agent': 'openclaw-wiki-purge/1.0',
      },
      body: new URLSearchParams({ 'delete-all': label }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(120_000),
    });
    this.capture(res);
    return res.status;
  }
}

async function ladeZustand(): Promise<PurgeState> {
  try {
    const d = JSON.parse(await readFile(STATE_FILE, 'utf-8')) as PurgeState;
    if (d?.attachments && d?.pages) return d;
  } catch { /* frisch beginnen */ }
  return { startedAt: new Date().toISOString(), attachments: {}, pages: {} };
}

async function speichereZustand(s: PurgeState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2), 'utf-8');
}

async function main(): Promise<number> {
  if (!process.env.POSTGRES_URL) {
    const m = existsSync(ENV_FILE)
      ? readFileSync(ENV_FILE, 'utf-8').match(/^POSTGRES_URL=(.+)$/m) : null;
    if (m) process.env.POSTGRES_URL = m[1];
  }
  if (!process.env.POSTGRES_URL) { log('POSTGRES_URL fehlt — Abbruch.'); return 2; }

  const creds = await readNuveonCredentials(CRED_FILE);
  if (!creds.user || !creds.pass) {
    log('Keine Zugangsdaten — Abbruch, keine Anfrage gesendet.');
    return 3;
  }

  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL, max: 4 });

  // ── Lokaler Bestand als Nachweisgrundlage ────────────────────────────────
  const { rows: dbSeiten } = await pool.query<{ slug: string; source_page_name: string | null }>(
    'SELECT slug, source_page_name FROM wiki_pages');
  const { rows: dbAnh } = await pool.query<{
    filename: string; sha256: string | null; path: string; page_name: string | null;
  }>(`SELECT a.filename, a.sha256, a.path, p.source_page_name AS page_name
        FROM wiki_attachments a JOIN wiki_pages p ON p.id = a.page_id`);

  const seiteLokal = new Set(dbSeiten.map((r) => normalizePageName(r.source_page_name ?? r.slug)));
  const anhLokal = new Map<string, { sha256: string | null; path: string }>();
  for (const a of dbAnh) {
    anhLokal.set(`${normalizePageName(a.page_name ?? '')}/${a.filename.toLowerCase()}`,
      { sha256: a.sha256, path: a.path });
  }
  log(`Lokaler Bestand: ${dbSeiten.length} Seiten, ${dbAnh.length} Anhänge.`);

  // ── Anmeldung ────────────────────────────────────────────────────────────
  const client = new WikiClient();
  if (!await client.login(creds.user, creds.pass)) {
    log('Anmeldung fehlgeschlagen — Abbruch ohne weiteren Versuch.');
    await pool.end();
    return 1;
  }
  log('Anmeldung erfolgreich.');

  // ── Lebender Bestand ─────────────────────────────────────────────────────
  const indexSeite = await client.get(`${WIKI_PATH}/wiki/Index`);
  const anhangSeite = await client.get(`${WIKI_PATH}/wiki/AnhangIndex`);
  const liveSeiten = parsePageIndex(indexSeite.body, WIKI_PATH);
  const liveAnh = parseAttachmentIndex(anhangSeite.body, WIKI_PATH);
  log(`Im Wiki: ${liveSeiten.length} Seitennamen, ${liveAnh.length} Anhänge.`);

  const state = await ladeZustand();
  const summary: Summary = {
    finishedAt: '', dryRun: DRY_RUN,
    attachmentsDeleted: 0, pagesDeleted: 0,
    systemPagesDeleted: [], systemPagesRefused: [],
    skippedNoLocalCopy: [], skippedException: [], failures: [],
    remainingPages: [], remainingAttachments: [],
  };

  const fehlerArten = new Map<string, number>();
  const fehlerZaehlen = (art: string): boolean => {
    const n = (fehlerArten.get(art) ?? 0) + 1;
    fehlerArten.set(art, n);
    return n <= MAX_FEHLER_GLEICHER_ART;
  };

  // ── 1. Anhänge ───────────────────────────────────────────────────────────
  log('── Anhänge ──────────────────────────────────────────');
  for (const a of liveAnh) {
    const key = `${a.pageName}/${a.filename}`;

    if (PASSWORD_PAGES.has(a.pageName)) {
      summary.skippedException.push(`Anhang ${key}`);
      continue;
    }
    if (state.attachments[key]) continue;   // bereits erledigt

    // Lokales Gegenstück: sha256 der Datei auf der Platte gegen die Datenbank.
    const lokal = anhLokal.get(`${normalizePageName(a.pageName)}/${a.filename.toLowerCase()}`);
    if (!lokal) {
      summary.skippedNoLocalCopy.push({ ziel: `Anhang ${key}`, grund: 'nicht in wiki_attachments' });
      log(`  ÜBERSPRUNGEN ${key} — kein lokales Gegenstück`);
      continue;
    }
    let ist: string;
    try {
      ist = createHash('sha256').update(await readFile(join(WIKI_DIR, lokal.path))).digest('hex');
    } catch (e: any) {
      summary.skippedNoLocalCopy.push({ ziel: `Anhang ${key}`, grund: `Datei nicht lesbar: ${e?.message}` });
      log(`  ÜBERSPRUNGEN ${key} — lokale Datei nicht lesbar`);
      continue;
    }
    if (ist !== lokal.sha256) {
      summary.skippedNoLocalCopy.push({ ziel: `Anhang ${key}`, grund: 'sha256 weicht ab' });
      log(`  ÜBERSPRUNGEN ${key} — sha256 weicht ab`);
      continue;
    }

    if (DRY_RUN) { summary.attachmentsDeleted++; continue; }

    const status = await client.delete(key, 'Delete attachment');
    await sleep(PAUSE_MS);

    const nochDa = await client.exists(
      `${WIKI_PATH}/attach/${encodeURIComponent(a.pageName)}/${encodeURIComponent(a.filename)}`);
    if (nochDa) {
      summary.failures.push({ ziel: `Anhang ${key}`, grund: `nach HTTP ${status} weiterhin vorhanden` });
      log(`  FEHLER ${key} — weiterhin vorhanden (HTTP ${status})`);
      if (!fehlerZaehlen('anhang-bleibt')) {
        log('Zu viele gleichartige Fehler — Abbruch.');
        break;
      }
      continue;
    }

    state.attachments[key] = new Date().toISOString();
    await speichereZustand(state);
    summary.attachmentsDeleted++;
    if (summary.attachmentsDeleted % 10 === 0 || summary.attachmentsDeleted < 4) {
      log(`  ${summary.attachmentsDeleted} gelöscht (zuletzt ${key})`);
    }
    await sleep(PAUSE_MS);
  }
  log(`Anhänge gelöscht: ${summary.attachmentsDeleted}`);

  // ── 2. Seiten ────────────────────────────────────────────────────────────
  log('── Seiten ───────────────────────────────────────────');
  for (const name of liveSeiten) {
    if (PASSWORD_PAGES.has(name)) {
      summary.skippedException.push(`Seite ${name}`);
      continue;
    }
    if (state.pages[name]) continue;

    const istSystem = SYSTEM_PAGES.has(name);
    if (!istSystem && !seiteLokal.has(normalizePageName(name))) {
      summary.skippedNoLocalCopy.push({ ziel: `Seite ${name}`, grund: 'nicht in wiki_pages' });
      log(`  ÜBERSPRUNGEN ${name} — kein lokales Gegenstück`);
      continue;
    }

    if (DRY_RUN) {
      if (istSystem) summary.systemPagesDeleted.push(name); else summary.pagesDeleted++;
      continue;
    }

    const status = await client.delete(name, 'Delete entire page');
    await sleep(PAUSE_MS);

    const nochDa = await client.get(`${WIKI_PATH}/wiki/${encodeURIComponent(name)}`);
    const weg = nochDa.status !== 200
      || /this page does not exist|diese seite existiert nicht/i.test(nochDa.body);

    if (!weg) {
      if (istSystem) {
        // Erwartbar: JSPWiki schützt einige Systemseiten.
        summary.systemPagesRefused.push(name);
        log(`  SYSTEMSEITE BLEIBT ${name} (HTTP ${status})`);
        state.pages[name] = 'refused';
        await speichereZustand(state);
        continue;
      }
      summary.failures.push({ ziel: `Seite ${name}`, grund: `nach HTTP ${status} weiterhin vorhanden` });
      log(`  FEHLER ${name} — weiterhin vorhanden (HTTP ${status})`);
      if (!fehlerZaehlen('seite-bleibt')) {
        log('Zu viele gleichartige Fehler — Abbruch.');
        break;
      }
      continue;
    }

    state.pages[name] = new Date().toISOString();
    await speichereZustand(state);
    if (istSystem) summary.systemPagesDeleted.push(name);
    else summary.pagesDeleted++;
    const n = summary.pagesDeleted + summary.systemPagesDeleted.length;
    if (n % 10 === 0 || n < 4) log(`  ${n} Seiten gelöscht (zuletzt ${name})`);
    await sleep(PAUSE_MS);
  }
  log(`Seiten gelöscht: ${summary.pagesDeleted} (+ ${summary.systemPagesDeleted.length} Systemseiten)`);

  // ── 3. Verifikation am lebenden Wiki ─────────────────────────────────────
  if (!DRY_RUN) {
    log('── Verifikation ─────────────────────────────────────');
    const nachIndex = await client.get(`${WIKI_PATH}/wiki/Index`);
    const nachAnhang = await client.get(`${WIKI_PATH}/wiki/AnhangIndex`);
    summary.remainingPages = parsePageIndex(nachIndex.body, WIKI_PATH);
    summary.remainingAttachments = parseAttachmentIndex(nachAnhang.body, WIKI_PATH)
      .map((a) => `${a.pageName}/${a.filename}`);
    log(`Verbleibend: ${summary.remainingPages.length} Seitennamen, ${summary.remainingAttachments.length} Anhänge`);
  }

  summary.finishedAt = new Date().toISOString();
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(SUMMARY_FILE, JSON.stringify(summary, null, 2), 'utf-8');

  log('─── Zusammenfassung ───');
  log(`Anhänge gelöscht      : ${summary.attachmentsDeleted}`);
  log(`Seiten gelöscht       : ${summary.pagesDeleted}`);
  log(`Systemseiten gelöscht : ${summary.systemPagesDeleted.length}`);
  log(`Systemseiten verweigert: ${summary.systemPagesRefused.length}`);
  log(`Ausnahmen (unberührt) : ${summary.skippedException.length}`);
  log(`ohne lokale Kopie     : ${summary.skippedNoLocalCopy.length}`);
  log(`Fehler                : ${summary.failures.length}`);
  log(`Bericht               : ${SUMMARY_FILE}`);

  await pool.end();
  return summary.failures.length > 0 ? 1 : 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e: any) => { log(`FEHLER: ${e?.message ?? e}`); process.exit(2); });
