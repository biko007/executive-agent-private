#!/usr/bin/env bun
/**
 * wiki-import — Einmal-Import des privaten JSPWiki bei Nuveon in das Modul wiki.
 *
 * Aufruf:
 *   bun run scripts/wiki-import/import.ts                 # voller Import
 *   bun run scripts/wiki-import/import.ts --pages-only    # ohne Anhänge
 *   bun run scripts/wiki-import/import.ts --dry-run       # nur lesen + berichten
 *
 * HARTE GRENZEN (aus dem Auftrag, im Code durchgesetzt):
 *   1. Gegenüber Nuveon strikt lesend. Der einzige POST ist die Anmeldung.
 *      Es gibt in dieser Datei keinen weiteren POST/PUT/DELETE-Aufruf.
 *   2. Höchstens zwei gleichzeitige Anfragen, dazwischen eine kurze Pause.
 *   3. Nach zwei fehlgeschlagenen Anmeldungen wird abgebrochen (keine
 *      Kontosperre riskieren).
 *   4. Die Seiten PW / Passwörter / PasswortÄndern werden weder geladen noch
 *      importiert — auch ihre Anhänge nicht.
 *   5. Zugangsdaten erscheinen nie in Ausgabe, Zustandsdatei oder Datenbank.
 *   6. Unter 15 GB freiem Plattenplatz werden keine Anhänge geladen.
 *
 * Der Lauf ist wiederaufnahmefähig: erledigte Seiten und Anhänge stehen in
 * _state/import-state.json und werden beim erneuten Aufruf übersprungen.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import {
  mkdir, writeFile, readFile, statfs,
} from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';

import {
  parsePageIndex, parseAttachmentIndex, extractRawMarkup, parsePageMeta,
  extractRenderedContent, looksLikeLoginPage, skipReason,
  PASSWORD_PAGES, type AttachmentIndexEntry,
  convertJspWikiToMarkdown, slugify, titleFromPageName, deriveCategory, detectSensitive,
  upsertImportedPage, upsertAttachment, getPageIdBySlug,
} from '../../src/modules/wiki/index.js';
import { closePool } from '../../src/shared/db/index.js';

const execFileAsync = promisify(execFile);

// ── Konfiguration ───────────────────────────────────────────────────────────

const BASE_URL = 'https://asp.nuveon.de';
const WIKI_PATH = '/biko';
const HOME = homedir();
const CRED_FILE = join(HOME, '.config/openclaw/nuveon-wiki.env');
const ENV_FILE = join(HOME, '.config/openclaw/env');
const WIKI_DIR = join(HOME, '.openclaw/workspace/artifacts/personal/wiki');
const RAW_DIR = join(WIKI_DIR, '_raw');
const STATE_DIR = join(WIKI_DIR, '_state');
const STATE_FILE = join(STATE_DIR, 'import-state.json');
const SUMMARY_FILE = join(STATE_DIR, 'import-summary.json');

const MIN_FREE_BYTES = 15 * 1024 * 1024 * 1024; // Stop-Condition 6
const MAX_PARALLEL = 2;                         // Stop-Condition 1
const REQUEST_PAUSE_MS = 300;
const MAX_LOGIN_ATTEMPTS = 2;                   // Stop-Condition 2
const REQUEST_TIMEOUT_MS = 120_000;
const PREVIEW_LONG_EDGE = 2000;
const PREVIEW_QUALITY = 85;
const THUMB_LONG_EDGE = 320;

const PAGES_ONLY = process.argv.includes('--pages-only');
const DRY_RUN = process.argv.includes('--dry-run');

// ── Zustand ─────────────────────────────────────────────────────────────────

interface ImportState {
  startedAt: string;
  pages: Record<string, { slug: string; at: string }>;
  attachments: Record<string, { sha256: string; size: number; at: string }>;
}

interface SkippedPage { page: string; reason: string }
interface AttachmentProblem { page: string; filename: string; problem: string }

interface Summary {
  finishedAt: string;
  dryRun: boolean;
  pagesInIndex: number;
  pagesImported: number;
  pagesSkipped: SkippedPage[];
  passwordPagesFound: string[];
  sensitivePages: string[];
  removedPlugins: Record<string, number>;
  attachmentsInIndex: number;
  attachmentsDownloaded: number;
  attachmentsSkipped: AttachmentProblem[];
  attachmentBytes: number;
  previewsCreated: number;
  pdfTextsExtracted: number;
  rawMarkupUnavailable: string[];
  sizeMismatches: AttachmentProblem[];
  diskFreeBytesAtStart: number;
}

// ── Kleine Helfer ───────────────────────────────────────────────────────────

function log(message: string): void {
  // Bewusst nur Struktur- und Zählinformationen — keine Inhalte, keine Secrets.
  console.log(`[wiki-import] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** KEY=VALUE-Datei einlesen; Werte dürfen in Anführungszeichen stehen. */
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.zip': 'application/zip', '.dxf': 'image/vnd.dxf', '.dwg': 'image/vnd.dwg',
  '.txt': 'text/plain', '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function mimeForFilename(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Deutsches JSPWiki-Datum in ein Date wandeln.
 * Formate: "28.09.2016", "28.09.2016 14:03", "28-Sep-2016".
 * Rückgabe null, wenn nichts Verlässliches erkennbar ist — ein falsches Datum
 * wäre schlechter als kein Datum.
 */
export function parseGermanDate(text: string | null): Date | null {
  if (!text) return null;
  const match = String(text).match(
    /(\d{1,2})[.\/-](\d{1,2}|[A-Za-zä]{3,})[.\/-](\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2}))?/,
  );
  if (!match) return null;

  const day = parseInt(match[1], 10);
  let month: number;
  if (/^\d+$/.test(match[2])) {
    month = parseInt(match[2], 10);
  } else {
    const months = ['jan', 'feb', 'mär', 'mar', 'apr', 'mai', 'may', 'jun', 'jul',
      'aug', 'sep', 'okt', 'oct', 'nov', 'dez', 'dec'];
    const idx = months.indexOf(match[2].slice(0, 3).toLowerCase());
    if (idx < 0) return null;
    const monthByIdx = [1, 2, 3, 3, 4, 5, 5, 6, 7, 8, 9, 10, 11, 12, 12];
    month = monthByIdx[idx];
  }
  let year = parseInt(match[3], 10);
  if (year < 100) year += year < 70 ? 2000 : 1900;
  const hour = match[4] ? parseInt(match[4], 10) : 12;
  const minute = match[5] ? parseInt(match[5], 10) : 0;

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── Lesende HTTP-Schicht mit Cookie-Sitzung ─────────────────────────────────

class ReadOnlyWikiClient {
  private cookies = new Map<string, string>();
  private inFlight = 0;
  private queue: Array<() => void> = [];

  /** Nimmt Set-Cookie-Header der Antwort in die Sitzung auf. */
  private captureCookies(res: Response): void {
    const raw = typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
    for (const entry of raw as string[]) {
      const [pair] = entry.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** Begrenzt die Parallelität auf MAX_PARALLEL (Stop-Condition 1). */
  private async acquire(): Promise<void> {
    if (this.inFlight < MAX_PARALLEL) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.inFlight++;
  }

  private release(): void {
    this.inFlight--;
    const next = this.queue.shift();
    if (next) next();
  }

  /**
   * Der einzige POST im gesamten Import: die Anmeldung.
   * Höchstens MAX_LOGIN_ATTEMPTS Versuche; danach wird abgebrochen.
   */
  async login(username: string, password: string): Promise<void> {
    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
      // Erst die Anmeldeseite lesen, damit eine Sitzung (JSESSIONID) existiert.
      await this.get(`${WIKI_PATH}/Login.jsp`);

      const form = new URLSearchParams({
        j_username: username,
        j_password: password,
        submitlogin: 'Login',
        redirect: 'Home',
      });

      await this.acquire();
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}${WIKI_PATH}/Login.jsp?redirect=Home`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: this.cookieHeader(),
            'User-Agent': 'openclaw-wiki-import/1.0 (read-only migration)',
          },
          body: form.toString(),
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } finally {
        this.release();
        await sleep(REQUEST_PAUSE_MS);
      }
      this.captureCookies(res);

      // Erfolg prüfen: eine geschützte Seite lesen. Kommt die Anmeldemaske
      // zurück, hat die Anmeldung nicht gegriffen.
      const probe = await this.get(`${WIKI_PATH}/wiki/Home`);
      if (!looksLikeLoginPage(probe.body) && probe.status === 200) {
        log(`Anmeldung erfolgreich (Versuch ${attempt}).`);
        return;
      }
      log(`Anmeldung fehlgeschlagen (Versuch ${attempt} von ${MAX_LOGIN_ATTEMPTS}).`);
      if (attempt < MAX_LOGIN_ATTEMPTS) await sleep(2000);
    }
    throw new Error(
      `Anmeldung nach ${MAX_LOGIN_ATTEMPTS} Versuchen fehlgeschlagen — Abbruch ohne weitere `
      + 'Versuche, um keine Kontosperre zu riskieren (Stop-Condition 2).',
    );
  }

  /** Lesende Anfrage; liefert Text. */
  async get(path: string): Promise<{ status: number; body: string; lastModified: string | null }> {
    await this.acquire();
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: 'GET',
        headers: {
          Cookie: this.cookieHeader(),
          'User-Agent': 'openclaw-wiki-import/1.0 (read-only migration)',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      this.captureCookies(res);
      return {
        status: res.status,
        body: await res.text(),
        lastModified: res.headers.get('last-modified'),
      };
    } finally {
      this.release();
      await sleep(REQUEST_PAUSE_MS);
    }
  }

  /** Lesende Anfrage; liefert Binärdaten. */
  async getBinary(path: string): Promise<{ status: number; data: Buffer; lastModified: string | null }> {
    await this.acquire();
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: 'GET',
        headers: {
          Cookie: this.cookieHeader(),
          'User-Agent': 'openclaw-wiki-import/1.0 (read-only migration)',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      this.captureCookies(res);
      const buffer = Buffer.from(await res.arrayBuffer());
      return { status: res.status, data: buffer, lastModified: res.headers.get('last-modified') };
    } finally {
      this.release();
      await sleep(REQUEST_PAUSE_MS);
    }
  }
}

// ── Medienaufbereitung ──────────────────────────────────────────────────────

/**
 * Vorschau- und Miniaturbild für ein Rasterbild erzeugen (vipsthumbnail).
 * Originale bleiben unangetastet. Fehler sind nicht fatal — ein fehlendes
 * Vorschaubild verhindert den Import nicht, wird aber im Report gezählt.
 */
async function createImagePreviews(
  absoluteFile: string,
  previewFile: string,
  thumbFile: string,
): Promise<boolean> {
  try {
    await mkdir(dirname(previewFile), { recursive: true });
    await mkdir(dirname(thumbFile), { recursive: true });
    // vipsthumbnail skaliert auf die lange Kante und behält das Seitenverhältnis.
    await execFileAsync('vipsthumbnail', [
      absoluteFile,
      '--size', `${PREVIEW_LONG_EDGE}x${PREVIEW_LONG_EDGE}`,
      '-o', `${previewFile}[Q=${PREVIEW_QUALITY},strip]`,
    ], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    await execFileAsync('vipsthumbnail', [
      absoluteFile,
      '--size', `${THUMB_LONG_EDGE}x${THUMB_LONG_EDGE}`,
      '-o', `${thumbFile}[Q=80,strip]`,
    ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    return true;
  } catch (e: any) {
    log(`Vorschau fehlgeschlagen für ${absoluteFile.split('/').pop()}: ${e?.message ?? e}`);
    return false;
  }
}

/** PDF-Text extrahieren (pdftotext). Leerer Rückgabewert bei Fehler. */
async function extractPdfText(absoluteFile: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'pdftotext',
      ['-layout', '-enc', 'UTF-8', absoluteFile, '-'],
      { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 },
    );
    // pdftotext trennt Seiten mit Seitenvorschub (U+000C) — fuer die Suche entfernen.
    return stdout.replace(/\u000c/g, '\n').trim();
  } catch (e: any) {
    log(`PDF-Text fehlgeschlagen für ${absoluteFile.split('/').pop()}: ${e?.message ?? e}`);
    return '';
  }
}

// ── Hauptlauf ───────────────────────────────────────────────────────────────

async function loadState(): Promise<ImportState> {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as ImportState;
    if (parsed && parsed.pages && parsed.attachments) return parsed;
  } catch {
    // Kein oder unlesbarer Zustand → frisch beginnen.
  }
  return { startedAt: new Date().toISOString(), pages: {}, attachments: {} };
}

async function saveState(state: ImportState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

async function main(): Promise<number> {
  // 1. Zugangsdaten
  const creds = readEnvFile(CRED_FILE);
  const username = (creds.NUVEON_WIKI_USER ?? '').trim();
  const password = creds.NUVEON_WIKI_PASS ?? '';
  if (!username || !password) {
    log('Keine Zugangsdaten in ~/.config/openclaw/nuveon-wiki.env (Variablen fehlen oder leer).');
    log('Import wird nicht gestartet. Es wurde keine Anfrage an Nuveon gesendet.');
    return 3;
  }

  // POSTGRES_URL bereitstellen, falls nicht im Prozess-Env.
  if (!process.env.POSTGRES_URL) {
    const env = readEnvFile(ENV_FILE);
    if (env.POSTGRES_URL) process.env.POSTGRES_URL = env.POSTGRES_URL;
  }
  if (!process.env.POSTGRES_URL) {
    log('POSTGRES_URL nicht verfügbar — Abbruch.');
    return 2;
  }

  // 2. Plattenplatz
  const fsStat = await statfs(HOME);
  const freeBytes = Number(fsStat.bavail) * Number(fsStat.bsize);
  const freeGb = (freeBytes / 1024 / 1024 / 1024).toFixed(1);
  let downloadAttachments = !PAGES_ONLY;
  if (freeBytes < MIN_FREE_BYTES) {
    log(`Nur ${freeGb} GB frei (Grenze 15 GB) — Anhänge werden NICHT geladen (Stop-Condition 6).`);
    downloadAttachments = false;
  } else {
    log(`Plattenplatz: ${freeGb} GB frei.`);
  }

  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(STATE_DIR, { recursive: true });
  const state = await loadState();

  const summary: Summary = {
    finishedAt: '',
    dryRun: DRY_RUN,
    pagesInIndex: 0,
    pagesImported: 0,
    pagesSkipped: [],
    passwordPagesFound: [],
    sensitivePages: [],
    removedPlugins: {},
    attachmentsInIndex: 0,
    attachmentsDownloaded: 0,
    attachmentsSkipped: [],
    attachmentBytes: 0,
    previewsCreated: 0,
    pdfTextsExtracted: 0,
    rawMarkupUnavailable: [],
    sizeMismatches: [],
    diskFreeBytesAtStart: freeBytes,
  };

  const client = new ReadOnlyWikiClient();
  await client.login(username, password);

  // 3. Seitenliste
  const indexPage = await client.get(`${WIKI_PATH}/wiki/Index`);
  const pageNames = parsePageIndex(indexPage.body, WIKI_PATH);
  summary.pagesInIndex = pageNames.length;
  log(`Index: ${pageNames.length} Seitennamen gefunden.`);

  // 4. Anhangliste
  const attachIndexPage = await client.get(`${WIKI_PATH}/wiki/AnhangIndex`);
  const attachments = parseAttachmentIndex(attachIndexPage.body, WIKI_PATH);
  summary.attachmentsInIndex = attachments.length;
  log(`AnhangIndex: ${attachments.length} Anhänge gefunden.`);

  // 5. Passwortseiten nur benennen, niemals laden
  for (const name of pageNames) {
    if (PASSWORD_PAGES.has(name)) summary.passwordPagesFound.push(name);
  }

  // Seitenname → Slug für interne Links (alle Seiten, auch noch nicht importierte)
  const slugByPage = new Map<string, string>();
  for (const name of pageNames) slugByPage.set(name, slugify(name));
  const slugForPage = (name: string): string => slugByPage.get(name) ?? slugify(name);

  // Anhänge je Seite, damit der Konverter Anhang-Links erkennt
  const attachmentsByPage = new Map<string, AttachmentIndexEntry[]>();
  for (const entry of attachments) {
    const list = attachmentsByPage.get(entry.pageName) ?? [];
    list.push(entry);
    attachmentsByPage.set(entry.pageName, list);
  }

  // 6. Seiten importieren
  const pageIdBySlug = new Map<string, number>();

  for (const pageName of pageNames) {
    // Passwort- und Systemseiten werden gar nicht erst angefragt.
    const earlySkip = skipReason(pageName, null);
    if (earlySkip) {
      summary.pagesSkipped.push({ page: pageName, reason: earlySkip });
      continue;
    }

    const slug = slugForPage(pageName);

    if (state.pages[pageName] && !DRY_RUN) {
      log(`Seite ${pageName} bereits importiert — übersprungen (Wiederaufnahme).`);
      continue;
    }

    // Rohmarkup über die Editor-Seite lesen (nur GET, nie absenden).
    const editResponse = await client.get(
      `${WIKI_PATH}/EditX.jsp?page=${encodeURIComponent(pageName)}`,
    );
    let markup = extractRawMarkup(editResponse.body);
    let markupIsRendered = false;

    if (markup === null || markup.trim().length === 0) {
      // Fallback: gerenderte Seite als Text. Wird im Report ausgewiesen.
      const view = await client.get(`${WIKI_PATH}/wiki/${encodeURIComponent(pageName)}`);
      markup = extractRenderedContent(view.body);
      markupIsRendered = true;
      summary.rawMarkupUnavailable.push(pageName);
    }

    const lateSkip = skipReason(pageName, markup);
    if (lateSkip) {
      summary.pagesSkipped.push({ page: pageName, reason: lateSkip });
      continue;
    }

    // Metadaten aus der Ansichtsseite
    const view = await client.get(`${WIKI_PATH}/wiki/${encodeURIComponent(pageName)}`);
    const meta = parsePageMeta(view.body);
    const modifiedAt = parseGermanDate(meta.dateText)
      ?? (view.lastModified ? new Date(view.lastModified) : null);

    const attachmentNames = (attachmentsByPage.get(pageName) ?? []).map((a) => a.filename);
    const { markdown, removedPlugins } = convertJspWikiToMarkdown(markup, {
      pageName,
      pageSlug: slug,
      attachmentNames,
      slugForPage,
    });
    for (const plugin of removedPlugins) {
      summary.removedPlugins[plugin] = (summary.removedPlugins[plugin] ?? 0) + 1;
    }

    const title = titleFromPageName(pageName);
    const category = deriveCategory(title, markdown);
    const sensitive = detectSensitive(title, markdown);
    if (sensitive) summary.sensitivePages.push(pageName);

    // Rohdaten unverändert sichern — Beweisstück für spätere Nachprüfung.
    const rawFile = join(RAW_DIR, `${slug}${markupIsRendered ? '.rendered.txt' : '.jspwiki.txt'}`);
    if (!DRY_RUN) await writeFile(rawFile, markup, 'utf-8');

    if (!DRY_RUN) {
      const pageId = await upsertImportedPage({
        slug,
        title,
        category,
        bodyMd: markdown,
        sourceMarkup: markup,
        sensitive,
        sourcePageName: pageName,
        sourceAuthor: meta.author,
        sourceModifiedAt: modifiedAt,
      });
      pageIdBySlug.set(slug, pageId);
      state.pages[pageName] = { slug, at: new Date().toISOString() };
      await saveState(state);
    }

    summary.pagesImported++;
    log(`Seite ${summary.pagesImported}: ${pageName} → ${slug} (${category}${sensitive ? ', sensibel' : ''})`);
  }

  // 7. Anhänge
  if (downloadAttachments && !DRY_RUN) {
    for (const entry of attachments) {
      const key = `${entry.pageName}/${entry.filename}`;

      if (PASSWORD_PAGES.has(entry.pageName)) {
        summary.attachmentsSkipped.push({
          page: entry.pageName, filename: entry.filename,
          problem: 'Anhang einer Passwortseite (Stop-Condition 3)',
        });
        continue;
      }

      const slug = slugForPage(entry.pageName);
      let pageId = pageIdBySlug.get(slug);
      if (pageId === undefined) {
        const resolved = await getPageIdBySlug(slug);
        if (resolved === null) {
          summary.attachmentsSkipped.push({
            page: entry.pageName, filename: entry.filename,
            problem: 'Seite nicht importiert (übersprungen oder leer)',
          });
          continue;
        }
        pageId = resolved;
        pageIdBySlug.set(slug, pageId);
      }

      if (state.attachments[key]) {
        log(`Anhang ${key} bereits geladen — übersprungen (Wiederaufnahme).`);
        continue;
      }

      const relPath = join(slug, entry.filename);
      const absPath = join(WIKI_DIR, relPath);
      await mkdir(dirname(absPath), { recursive: true });

      const response = await client.getBinary(
        `${WIKI_PATH}/attach/${encodeURIComponent(entry.pageName)}/${encodeURIComponent(entry.filename)}`,
      );
      if (response.status !== 200 || response.data.length === 0) {
        summary.attachmentsSkipped.push({
          page: entry.pageName, filename: entry.filename,
          problem: `Download HTTP ${response.status}, ${response.data.length} Byte`,
        });
        continue;
      }

      await writeFile(absPath, response.data);
      const sha256 = createHash('sha256').update(response.data).digest('hex');
      const size = response.data.length;

      // Größenvergleich gegen den Index, wo eine Angabe vorlag. Die Angabe im
      // Index ist gerundet ("12.4 kB"), daher 2 % Toleranz.
      if (entry.size !== null) {
        const tolerance = Math.max(1024, entry.size * 0.02);
        if (Math.abs(size - entry.size) > tolerance) {
          summary.sizeMismatches.push({
            page: entry.pageName, filename: entry.filename,
            problem: `Index ${entry.sizeText ?? entry.size} vs. geladen ${size} Byte`,
          });
        }
      }

      // Medienaufbereitung
      let previewPath: string | null = null;
      let thumbPath: string | null = null;
      let textContent: string | null = null;
      const ext = extname(entry.filename).toLowerCase();

      if (['.tif', '.tiff', '.png', '.jpg', '.jpeg', '.gif'].includes(ext)) {
        const previewRel = join(slug, '_preview', `${entry.filename}.jpg`);
        const thumbRel = join(slug, '_thumb', `${entry.filename}.jpg`);
        const ok = await createImagePreviews(
          absPath, join(WIKI_DIR, previewRel), join(WIKI_DIR, thumbRel),
        );
        if (ok) {
          previewPath = previewRel;
          thumbPath = thumbRel;
          summary.previewsCreated++;
        }
      } else if (ext === '.pdf') {
        const text = await extractPdfText(absPath);
        if (text) {
          textContent = text;
          summary.pdfTextsExtracted++;
        }
      }

      await upsertAttachment({
        pageId,
        filename: entry.filename,
        mime: mimeForFilename(entry.filename),
        size,
        sha256,
        path: relPath,
        previewPath,
        thumbPath,
        textContent,
        sourceAuthor: entry.author,
        sourceModifiedAt: parseGermanDate(entry.dateText)
          ?? (response.lastModified ? new Date(response.lastModified) : null),
      });

      state.attachments[key] = { sha256, size, at: new Date().toISOString() };
      await saveState(state);
      summary.attachmentsDownloaded++;
      summary.attachmentBytes += size;
      log(`Anhang ${summary.attachmentsDownloaded}/${attachments.length}: ${key} (${size} Byte)`);
    }
  } else if (!downloadAttachments) {
    log('Anhänge übersprungen (--pages-only oder zu wenig Plattenplatz).');
  }

  summary.finishedAt = new Date().toISOString();
  await writeFile(SUMMARY_FILE, JSON.stringify(summary, null, 2), 'utf-8');

  log('─── Zusammenfassung ───');
  log(`Seiten im Index: ${summary.pagesInIndex}`);
  log(`Seiten importiert: ${summary.pagesImported}`);
  log(`Seiten übersprungen: ${summary.pagesSkipped.length}`);
  log(`Sensibel markiert: ${summary.sensitivePages.length}`);
  log(`Anhänge im Index: ${summary.attachmentsInIndex}`);
  log(`Anhänge geladen: ${summary.attachmentsDownloaded} (${(summary.attachmentBytes / 1024 / 1024).toFixed(1)} MB)`);
  log(`Vorschauen: ${summary.previewsCreated}, PDF-Texte: ${summary.pdfTextsExtracted}`);
  log(`Zusammenfassung: ${SUMMARY_FILE}`);

  return 0;
}

main()
  .then(async (code) => {
    await closePool().catch(() => {});
    process.exit(code);
  })
  .catch(async (e: any) => {
    log(`FEHLER: ${e?.message ?? e}`);
    await closePool().catch(() => {});
    process.exit(1);
  });
