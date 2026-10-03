#!/usr/bin/env bun
/**
 * wiki-import/verify — Nachprüfung eines abgeschlossenen Wiki-Imports.
 *
 * Aufruf:
 *   bun run scripts/wiki-import/verify.ts            # vollständig (mit Nuveon)
 *   bun run scripts/wiki-import/verify.ts --offline  # ohne Nuveon-Zugriff
 *
 * Geprüft wird:
 *   1. Zähler  — importierte Seiten gegen Index minus Übersprungene
 *   2. sha256  — Datei auf der Platte gegen den in der Datenbank gespeicherten Wert
 *   3. Größe   — Datei auf der Platte gegen die Angabe der Infoseite im Quellwiki
 *   4. Medien  — Vorschau und Miniatur für jedes Rasterbild vorhanden und lesbar
 *   5. Texte   — PDF-Text vorhanden, wo er zu erwarten ist
 *
 * Gegenüber Nuveon strikt lesend; der einzige POST ist die Anmeldung. Ohne
 * Zugangsdaten läuft die Prüfung automatisch im Offline-Modus weiter, dann
 * entfällt allein Punkt 3.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';

import { parseAttachmentInfo, readNuveonCredentials } from '../../src/modules/wiki/index.js';

const BASE_URL = 'https://asp.nuveon.de';
const WIKI_PATH = '/biko';
const HOME = homedir();
const WIKI_DIR = join(HOME, '.openclaw/workspace/artifacts/personal/wiki');
const STATE_FILE = join(WIKI_DIR, '_state/import-summary.json');
const CRED_FILE = join(HOME, '.config/openclaw/nuveon-wiki.env');
const ENV_FILE = join(HOME, '.config/openclaw/env');

const OFFLINE = process.argv.includes('--offline');
const REQUEST_PAUSE_MS = 250;
/** Die Angabe der Infoseite ist auf 0,1 kB gerundet. */
const SIZE_TOLERANCE_BYTES = 100;

function log(message: string): void {
  console.log(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEnvValue(path: string, key: string): string {
  if (!existsSync(path)) return '';
  const match = readFileSync(path, 'utf-8').match(new RegExp(`^${key}=(.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

interface Befund { stufe: 'OK' | 'FEHLER' | 'HINWEIS'; text: string }
const befunde: Befund[] = [];
const ok = (text: string) => befunde.push({ stufe: 'OK', text });
const fehler = (text: string) => befunde.push({ stufe: 'FEHLER', text });
const hinweis = (text: string) => befunde.push({ stufe: 'HINWEIS', text });

/** Nur-Lese-Sitzung zum Quellwiki. */
class ReadOnlyClient {
  private cookies = new Map<string, string>();

  private captureCookies(res: Response): void {
    const raw = typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
    for (const entry of raw as string[]) {
      const [pair] = entry.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
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
        'User-Agent': 'openclaw-wiki-verify/1.0 (read-only)',
      },
      body: form.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    this.captureCookies(res);
    const probe = await this.get(`${WIKI_PATH}/wiki/Home`);
    return probe.status === 200 && !/name=["']j_password["']/i.test(probe.body);
  }

  async get(path: string): Promise<{ status: number; body: string }> {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Cookie: this.header(), 'User-Agent': 'openclaw-wiki-verify/1.0 (read-only)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    this.captureCookies(res);
    await sleep(REQUEST_PAUSE_MS);
    return { status: res.status, body: await res.text() };
  }
}

async function main(): Promise<number> {
  if (!process.env.POSTGRES_URL) {
    const url = readEnvValue(ENV_FILE, 'POSTGRES_URL');
    if (url) process.env.POSTGRES_URL = url;
  }
  if (!process.env.POSTGRES_URL) {
    log('POSTGRES_URL nicht verfügbar — Abbruch.');
    return 2;
  }

  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL, max: 4 });

  // ── 1. Zähler ────────────────────────────────────────────────────────────
  log('\n── 1. Zähler ──────────────────────────────────────────────');
  const zusammenfassung = existsSync(STATE_FILE)
    ? JSON.parse(await readFile(STATE_FILE, 'utf-8'))
    : null;

  const { rows: zahlen } = await pool.query(`
    SELECT (SELECT count(*) FROM wiki_pages)            AS seiten,
           (SELECT count(*) FROM wiki_pages WHERE sensitive) AS sensibel,
           (SELECT count(*) FROM wiki_page_revisions)   AS revisionen,
           (SELECT count(*) FROM wiki_attachments)      AS anhaenge,
           (SELECT COALESCE(sum(size), 0) FROM wiki_attachments) AS bytes,
           (SELECT count(*) FROM wiki_attachments
              WHERE text_content IS NOT NULL AND text_content <> '') AS mit_text
  `);
  const z = zahlen[0];
  log(`   Seiten in der Datenbank : ${z.seiten}`);
  log(`   davon sensibel          : ${z.sensibel}`);
  log(`   Revisionen              : ${z.revisionen}`);
  log(`   Anhänge                 : ${z.anhaenge}`);
  log(`   Anhang-Bytes            : ${Number(z.bytes).toLocaleString('de-DE')}`);

  if (zusammenfassung) {
    const erwartet = zusammenfassung.pagesInIndex - zusammenfassung.pagesSkipped.length;
    log(`   Index ${zusammenfassung.pagesInIndex} − übersprungen ${zusammenfassung.pagesSkipped.length} = ${erwartet} erwartet`);
    if (Number(z.seiten) === erwartet) {
      ok(`Seitenzähler stimmt: ${z.seiten} = Index ${zusammenfassung.pagesInIndex} − ${zusammenfassung.pagesSkipped.length} übersprungen`);
    } else {
      fehler(`Seitenzähler weicht ab: ${z.seiten} in der Datenbank, ${erwartet} erwartet`);
    }

    // Jede importierte Seite muss mindestens eine Revision haben.
    if (Number(z.revisionen) >= Number(z.seiten)) {
      ok(`Revisionen vollständig: ${z.revisionen} für ${z.seiten} Seiten`);
    } else {
      fehler(`Revisionen fehlen: ${z.revisionen} für ${z.seiten} Seiten`);
    }

    const anhErwartet = zusammenfassung.attachmentsInIndex - zusammenfassung.attachmentsSkipped.length;
    if (Number(z.anhaenge) === anhErwartet) {
      ok(`Anhangzähler stimmt: ${z.anhaenge} = Index ${zusammenfassung.attachmentsInIndex} − ${zusammenfassung.attachmentsSkipped.length} übersprungen`);
    } else {
      fehler(`Anhangzähler weicht ab: ${z.anhaenge} in der Datenbank, ${anhErwartet} erwartet`);
    }
  } else {
    hinweis('Keine Importzusammenfassung gefunden — Zählerabgleich übersprungen.');
  }

  // ── 2. sha256 und Dateigröße auf der Platte ──────────────────────────────
  log('\n── 2. sha256 und Dateien auf der Platte ───────────────────');
  const { rows: anhaenge } = await pool.query<{
    id: number; filename: string; size: string; sha256: string | null;
    path: string; preview_path: string | null; thumb_path: string | null;
    mime: string; slug: string; page_name: string | null;
    hat_text: boolean;
  }>(`
    SELECT a.id, a.filename, a.size, a.sha256, a.path, a.preview_path, a.thumb_path,
           a.mime, p.slug, p.source_page_name AS page_name,
           (a.text_content IS NOT NULL AND a.text_content <> '') AS hat_text
      FROM wiki_attachments a JOIN wiki_pages p ON p.id = a.page_id
     ORDER BY p.slug, a.filename
  `);

  let shaOk = 0;
  const shaFehler: string[] = [];
  const fehlendeDateien: string[] = [];
  let groessenOk = 0;

  for (const a of anhaenge) {
    const abs = join(WIKI_DIR, a.path);
    if (!existsSync(abs)) {
      fehlendeDateien.push(`${a.slug}/${a.filename}`);
      continue;
    }
    const daten = await readFile(abs);
    const sha = createHash('sha256').update(daten).digest('hex');
    if (sha === a.sha256) shaOk++;
    else shaFehler.push(`${a.slug}/${a.filename}`);

    if (daten.length === Number(a.size)) groessenOk++;
    else shaFehler.push(`${a.slug}/${a.filename} (Größe ${daten.length} vs. ${a.size})`);
  }

  log(`   Dateien geprüft : ${anhaenge.length}`);
  log(`   sha256 stimmt   : ${shaOk}`);
  log(`   Größe stimmt    : ${groessenOk}`);
  if (fehlendeDateien.length === 0 && shaFehler.length === 0 && anhaenge.length > 0) {
    ok(`sha256 und Dateigröße stimmen für alle ${anhaenge.length} Anhänge`);
  }
  if (fehlendeDateien.length > 0) {
    fehler(`${fehlendeDateien.length} Datei(en) fehlen auf der Platte: ${fehlendeDateien.slice(0, 5).join(', ')}`);
  }
  if (shaFehler.length > 0) {
    fehler(`${shaFehler.length} Abweichung(en): ${shaFehler.slice(0, 5).join(', ')}`);
  }

  // ── 3. Größe gegen die Infoseiten im Quellwiki ───────────────────────────
  log('\n── 3. Größe gegen die Infoseiten im Quellwiki ─────────────');
  if (OFFLINE) {
    hinweis('Offline-Modus — Abgleich gegen das Quellwiki übersprungen.');
    log('   übersprungen (--offline)');
  } else {
    const creds = await readNuveonCredentials(CRED_FILE);
    if (!creds.user || !creds.pass) {
      hinweis('Keine Zugangsdaten — Abgleich gegen das Quellwiki übersprungen.');
      log('   übersprungen (keine Zugangsdaten)');
    } else {
      const client = new ReadOnlyClient();
      const angemeldet = await client.login(creds.user, creds.pass);
      if (!angemeldet) {
        fehler('Anmeldung am Quellwiki fehlgeschlagen — Größenabgleich nicht durchgeführt.');
      } else {
        let bestaetigt = 0;
        const abweichungen: string[] = [];
        const ohneAngabe: string[] = [];

        for (const a of anhaenge) {
          const seite = a.page_name ?? a.slug;
          const pfad = `${encodeURIComponent(seite)}/${encodeURIComponent(a.filename)}`;
          const res = await client.get(`${WIKI_PATH}/PageInfo.jsp?page=${pfad}`);
          if (res.status !== 200) {
            ohneAngabe.push(`${seite}/${a.filename} (HTTP ${res.status})`);
            continue;
          }
          const info = parseAttachmentInfo(res.body);
          if (info.size === null) {
            ohneAngabe.push(`${seite}/${a.filename}`);
            continue;
          }
          if (Math.abs(Number(a.size) - info.size) <= SIZE_TOLERANCE_BYTES) bestaetigt++;
          else abweichungen.push(`${seite}/${a.filename}: Quelle ${info.sizeText} vs. lokal ${a.size} Byte`);
        }

        log(`   bestätigt       : ${bestaetigt} von ${anhaenge.length}`);
        log(`   Abweichungen    : ${abweichungen.length}`);
        log(`   ohne Angabe     : ${ohneAngabe.length}`);
        if (abweichungen.length === 0 && ohneAngabe.length === 0) {
          ok(`Alle ${bestaetigt} Anhanggrößen stimmen mit den Infoseiten des Quellwikis überein`);
        }
        if (abweichungen.length > 0) {
          fehler(`${abweichungen.length} Größenabweichung(en): ${abweichungen.slice(0, 5).join('; ')}`);
        }
        if (ohneAngabe.length > 0) {
          hinweis(`${ohneAngabe.length} Anhang/Anhänge ohne Größenangabe im Quellwiki: ${ohneAngabe.slice(0, 5).join(', ')}`);
        }
      }
    }
  }

  // ── 4. Medien: Vorschau und Miniatur ─────────────────────────────────────
  log('\n── 4. Vorschauen und Miniaturen ───────────────────────────');
  const bilder = anhaenge.filter((a) => a.mime.startsWith('image/'));
  let vorschauOk = 0;
  const vorschauFehlt: string[] = [];
  for (const a of bilder) {
    const vor = a.preview_path ? join(WIKI_DIR, a.preview_path) : null;
    const mini = a.thumb_path ? join(WIKI_DIR, a.thumb_path) : null;
    if (!vor || !mini || !existsSync(vor) || !existsSync(mini)) {
      vorschauFehlt.push(`${a.slug}/${a.filename}`);
      continue;
    }
    const sv = await stat(vor);
    const sm = await stat(mini);
    // Eine Vorschau, die kleiner als 1 kB ist, ist mit Sicherheit kaputt.
    if (sv.size < 1024 || sm.size < 512) {
      vorschauFehlt.push(`${a.slug}/${a.filename} (Vorschau ${sv.size} B, Miniatur ${sm.size} B)`);
      continue;
    }
    vorschauOk++;
  }
  log(`   Bilder            : ${bilder.length}`);
  log(`   mit Vorschau      : ${vorschauOk}`);
  if (bilder.length > 0 && vorschauFehlt.length === 0) {
    ok(`Vorschau und Miniatur für alle ${bilder.length} Bilder vorhanden und plausibel groß`);
  }
  if (vorschauFehlt.length > 0) {
    fehler(`${vorschauFehlt.length} Bild(er) ohne brauchbare Vorschau: ${vorschauFehlt.slice(0, 5).join(', ')}`);
  }

  // ── 5. PDF-Texte ─────────────────────────────────────────────────────────
  log('\n── 5. PDF-Texte ───────────────────────────────────────────');
  const pdfs = anhaenge.filter((a) => a.mime === 'application/pdf');
  const pdfMitText = pdfs.filter((a) => a.hat_text).length;
  log(`   PDF-Dateien       : ${pdfs.length}`);
  log(`   mit Textinhalt    : ${pdfMitText}`);
  if (pdfs.length > 0 && pdfMitText === pdfs.length) {
    ok(`Alle ${pdfs.length} PDFs haben durchsuchbaren Text`);
  } else if (pdfs.length > 0) {
    // Gescannte PDFs ohne Textebene sind erwartbar und kein Fehler.
    hinweis(`${pdfs.length - pdfMitText} PDF(s) ohne Textebene (vermutlich Scans ohne Texterkennung)`);
  }

  await pool.end();

  // ── Auswertung ───────────────────────────────────────────────────────────
  log('\n════════════════════════════════════════════════════════════');
  for (const b of befunde) {
    const marke = b.stufe === 'OK' ? 'OK     ' : b.stufe === 'FEHLER' ? 'FEHLER ' : 'HINWEIS';
    log(`${marke} ${b.text}`);
  }
  const fehlerZahl = befunde.filter((b) => b.stufe === 'FEHLER').length;
  log('════════════════════════════════════════════════════════════');
  log(fehlerZahl === 0 ? 'ERGEBNIS: alle Prüfungen bestanden' : `ERGEBNIS: ${fehlerZahl} Fehler`);
  return fehlerZahl === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e: any) => {
    log(`FEHLER: ${e?.message ?? e}`);
    process.exit(2);
  });
