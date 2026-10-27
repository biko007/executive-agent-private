/**
 * doc-register/lauf — ein Durchlauf ueber alle Dokumentenablagen.
 *
 * Register je Quelle: `artifacts/personal/doc-register/<quelle>.jsonl`, eine
 * Zeile je Datei-VERSION (id + Hash). Eine unveraenderte Datei erscheint nie
 * zweimal; eine geaenderte bekommt eine neue Zeile mit Status `geaendert`.
 * Gemeldet wird nichts — das macht `scripts/neuheiten-stunde.ts`.
 *
 * Nur lesend: Die Quellen kennen keine Schreibbefehle, und dieses Modul ruft
 * nur `aenderungen`, `pfadErgaenzen` und `inhalt` auf.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { vorschlagText, maskiere, type Regelwerk, type VorschlagCode } from '../mail-register/relevanz.js';
import { ladeJson, schreibeJson, type NeuheitZeile } from '../neuheiten/bericht.js';
import {
  bewerteDok, brauchtText, dokAusschluss, dokKennung, endung, type DokRegeln,
} from './relevanz.js';
import type { DokDatei, DokQuelle } from './quellen.js';
import type { DropboxAdapter } from '../../adapters/dropbox.js';

/** Neuheiten zaehlen ab diesem Datum (Auftrag 27.10.2026). */
export const DOK_START = '2026-10-18T00:00:00.000Z';
/** Groesser wird fuer die erste Seite nichts geladen. */
const MAX_TEXT_BYTES = 25 * 1024 * 1024;
const MAX_VERSUCHE = 3;
export const DROPBOX_DOK_REGISTER = '/bikosoc-reports/transfer/doc-register';

export const ABLAGE: Record<string, string> = {
  sharepoint: 'SharePoint', onedrive: 'OneDrive', dropbox: 'Dropbox', icloud: 'iCloud',
};

export interface DokEintrag {
  quelle: string;
  id: string;
  pfad: string;
  name: string;
  groesse: number;
  geaendertIso: string;
  hash: string;
  erkanntIso: string;
  status: 'neu' | 'geaendert';
  relevant: boolean;
  grund: string;
  vorschlag: VorschlagCode;
  text: string;
  objekt?: string;
  thema?: string;
  kennung: string;
}

interface Stand {
  version: 1;
  quellen: Record<string, { stand: string; letzterLauf: string }>;
  /** Dateien, deren erste Seite nicht lesbar war — naechster Lauf versucht es erneut. */
  nachholen: Record<string, Array<DokDatei & { versuche: number }>>;
}

export interface DokLaufOptionen {
  zustand: string;
  regeln: Regelwerk;
  dokRegeln: DokRegeln;
  quellen: DokQuelle[];
  probe?: boolean;
  nachlauf?: boolean;
  jetzt?: Date;
  /** `<groesse>.<endung>` aller Dateien in SharePoint/OneDrive — erkennt Kopien in Dropbox/Austausch. */
  kopieMerkmale?: Set<string>;
  /** Text der ersten PDF-Seite; Vorgabe: pdftotext. */
  ersteSeite?: (pdf: Buffer) => string;
  dropbox?: DropboxAdapter | null;
  log?: (m: string) => void;
  warn?: (m: string) => void;
  /**
   * Sekretariat-Nachlauf: alle Dateien seit 18.10. liefern, auch schon
   * registrierte (nur zusammen mit `probe`, damit nichts doppelt registriert wird).
   */
  alleSeitStart?: boolean;
}

export interface DokLaufErgebnis {
  /** Gelesener Text je Kennung (PDF), für das Sekretariat. */
  texte: Record<string, string>;
  neu: DokEintrag[];
  relevant: DokEintrag[];
  zaehler: Record<string, number>;
  jeQuelle: Record<string, { gesehen: number; neu: number; relevant: number }>;
  /** Fehler: eine Quelle oder ein Upload ist ausgefallen. */
  fehler: string[];
  /** Hinweise: nichts verloren, wird nachgeholt oder ist nur zu wissen. */
  hinweise: string[];
  zusammen: string;
}

/** Erste PDF-Seite ueber pdftotext; leer, wenn es keine Textebene gibt. */
export function pdfErsteSeite(pdf: Buffer, seiten = 1): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dok-seite-'));
  const datei = path.join(dir, 'd.pdf');
  try {
    fs.writeFileSync(datei, pdf);
    const r = spawnSync('pdftotext', ['-f', '1', '-l', String(seiten), '-q', datei, '-'], { timeout: 20_000, encoding: 'utf-8' });
    if (r.error) throw r.error;
    return String(r.stdout ?? '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export function ladeDokRegister(pfad: string): DokEintrag[] {
  try {
    return fs.readFileSync(pfad, 'utf-8').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  } catch { return []; }
}

function csvWert(w: unknown): string {
  const s = String(w ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""');
  return /[",;]/.test(s) ? `"${s}"` : s;
}

/**
 * Register als CSV. Name und Pfad ohne IBAN/Kontonummern; Gesundheitspost
 * nur als Zeile ohne Name und Pfad — die CSV liegt in Dropbox.
 */
export function dokCsv(e: DokEintrag[]): string {
  const kopf = ['quelle', 'pfad', 'name', 'groesse', 'geaendert', 'hash', 'erkannt', 'status',
    'relevant', 'grund', 'objekt', 'vorschlag', 'kennung'];
  return [kopf.join(';'), ...[...e].sort((a, b) => a.geaendertIso.localeCompare(b.geaendertIso)).map((x) =>
    [x.quelle, x.grund === 'Gesundheit' ? '(Gesundheit)' : maskiere(x.pfad),
      x.grund === 'Gesundheit' ? '' : maskiere(x.name), x.groesse, x.geaendertIso, x.hash, x.erkanntIso, x.status,
      x.relevant ? 'ja' : 'nein', x.grund, x.objekt ?? '', x.relevant ? x.text : '', x.kennung].map(csvWert).join(';'))]
    .join('\n') + '\n';
}

export function dokZeile(e: DokEintrag): NeuheitZeile {
  const ordner = e.pfad.slice(0, Math.max(0, e.pfad.lastIndexOf('/'))) || '/';
  return {
    kennung: e.kennung, art: 'Dok', datum: e.geaendertIso, quelle: ABLAGE[e.quelle] ?? e.quelle,
    von: ordner, titel: `${e.name}${e.status === 'geaendert' ? ' (geändert)' : ''}`,
    vorschlag: e.vorschlag, text: e.text,
  };
}

export async function dokLauf(o: DokLaufOptionen): Promise<DokLaufErgebnis> {
  const log = o.log ?? (() => {});
  const warn = o.warn ?? (() => {});
  const jetzt = o.jetzt ?? new Date();
  const ersteSeite = o.ersteSeite ?? pdfErsteSeite;
  const standPfad = path.join(o.zustand, 'stand.json');
  const stand = ladeJson<Stand>(standPfad, { version: 1, quellen: {}, nachholen: {} });
  stand.nachholen ??= {};
  const erg: DokLaufErgebnis = { texte: {}, neu: [], relevant: [], zaehler: {}, jeQuelle: {}, fehler: [], hinweise: [], zusammen: '' };
  if (o.alleSeitStart && !o.probe) throw new Error('alleSeitStart nur mit probe');

  for (const q of o.quellen) {
    const registerPfad = path.join(o.zustand, `${q.name}.jsonl`);
    const vorhanden = ladeDokRegister(registerPfad);
    /* Letzter bekannter Hash je id — eine unveraenderte Datei wird uebersprungen. */
    const letzterHash = new Map<string, string>();
    for (const e of vorhanden) letzterHash.set(e.id, e.hash);
    const alt = stand.quellen[q.name]?.stand ?? null;
    const statistik = { gesehen: 0, neu: 0, relevant: 0 };
    erg.jeQuelle[q.name] = statistik;

    /* Ohne Stand und ohne Nachlauf: nur den Stand setzen, nichts melden —
       sonst kaeme beim ersten Stundenlauf alles seit 18.10. als Meldung. */
    const nurStandSetzen = !alt && !o.nachlauf && !q.privat;
    let aend;
    try {
      aend = await q.aenderungen(o.nachlauf ? null : alt);
    } catch (e: any) {
      erg.fehler.push(`${ABLAGE[q.name]}: nicht lesbar (${String(e?.message ?? e).slice(0, 160)})`);
      warn(`doc-register ${q.name}: ${e?.message ?? e}`);
      continue;
    }
    if (nurStandSetzen) {
      if (!o.probe) stand.quellen[q.name] = { stand: aend.stand, letzterLauf: jetzt.toISOString() };
      log(`[doc-register:${q.name}] Stand gesetzt (${aend.dateien.length} Dateien), erst ab jetzt Neuheiten`);
      /* Haben andere Quellen schon einen Stand, lief der Nachlauf ohne diese —
         ihre Aenderungen seit 18.10. fehlen dann. Das soll sichtbar sein. */
      if (Object.keys(stand.quellen).some((k) => k !== q.name)) {
        erg.hinweise.push(`${ABLAGE[q.name]}: erstmals erfasst, Neuheiten erst ab jetzt (seit 18.10. nicht nachgeholt)`);
      }
      continue;
    }
    /* Kopien in Dropbox/Austausch auch gegen Dateien desselben Laufs erkennen —
       der SharePoint-Index wird nur nachts abgeglichen. */
    if (!q.privat && q.name !== 'dropbox' && o.kopieMerkmale) {
      for (const d of aend.dateien) o.kopieMerkmale.add(`${d.groesse}.${endung(d.name)}`);
    }

    const frisch = aend.dateien.filter((d) => d.geaendertIso >= DOK_START);
    const frischeIds = new Set(frisch.map((d) => d.id));
    /* Aus der Nachholliste nur, was nicht inzwischen in neuerer Version kommt. */
    const kandidaten = [
      ...(stand.nachholen[q.name] ?? []).filter((d) => !frischeIds.has(d.id)),
      ...frisch,
    ].filter((d, i, a) => a.findIndex((x) => x.id === d.id && x.hash === d.hash) === i)
      .filter((d) => o.alleSeitStart || letzterHash.get(d.id) !== d.hash);
    statistik.gesehen = aend.dateien.length;
    const nachholen: Array<DokDatei & { versuche: number }> = [];

    try { await q.pfadErgaenzen?.(kandidaten); } catch (e: any) {
      erg.fehler.push(`${ABLAGE[q.name]}: Pfade nicht vollständig (${String(e?.message ?? e).slice(0, 120)})`);
    }

    const neu: DokEintrag[] = [];
    for (const d of kandidaten) {
      /* Ohne Pfad greifen die Pfadausschluesse nicht — nicht raten, spaeter erneut. */
      if (!d.pfad) {
        const versuche = ((d as any).versuche ?? 0) + 1;
        if (versuche < MAX_VERSUCHE) nachholen.push({ ...d, versuche });
        else erg.hinweise.push(`${ABLAGE[q.name]}: Pfad für ${d.name} nicht bestimmbar — übergangen`);
        continue;
      }
      /* Eigener Kanal, cc-Ablagen und Systemdateien kommen gar nicht ins
         Register: Sonst erzeugen unsere eigenen Uploads (CSV, Reports) jede
         Stunde neue Zeilen und damit den naechsten Upload. */
      const frueh = dokAusschluss(d, o.dokRegeln);
      if (frueh === 'eigener Kanal/cc-Ablage' || frueh === 'System/temporär') {
        erg.zaehler[frueh] = (erg.zaehler[frueh] ?? 0) + 1;
        continue;
      }
      const kopie = q.name === 'dropbox' && /^\/austausch\//i.test(d.pfad)
        && !!o.kopieMerkmale?.has(`${d.groesse}.${endung(d.name)}`);
      let text: string | undefined;
      if (!dokAusschluss(d, o.dokRegeln, kopie) && brauchtText(d, o.dokRegeln) && d.groesse <= MAX_TEXT_BYTES) {
        try { text = ersteSeite(await q.inhalt(d)); } catch (e: any) {
          const versuche = ((d as any).versuche ?? 0) + 1;
          if (versuche < MAX_VERSUCHE) { nachholen.push({ ...d, versuche }); continue; }
          warn(`doc-register ${q.name}: erste Seite nicht lesbar, nur Name bewertet: ${d.pfad}`);
        }
      }
      if (text) erg.texte[dokKennung(d)] = text;
      const b = bewerteDok(d, o.regeln, o.dokRegeln, { kopie, text });
      const { versuche: _v, ...datei } = d as DokDatei & { versuche?: number };
      const eintrag: DokEintrag = {
        quelle: datei.quelle, id: datei.id, pfad: datei.pfad, name: datei.name, groesse: datei.groesse,
        geaendertIso: datei.geaendertIso, hash: datei.hash, erkanntIso: jetzt.toISOString(),
        status: letzterHash.has(d.id) ? 'geaendert' : 'neu',
        relevant: b.relevant, grund: b.grund, vorschlag: b.vorschlag,
        text: b.relevant ? vorschlagText(b) : '', objekt: b.objekt, thema: b.thema, kennung: dokKennung(d),
      };
      letzterHash.set(d.id, d.hash);
      neu.push(eintrag);
      if (b.relevant) { erg.relevant.push(eintrag); statistik.relevant++; }
      else erg.zaehler[b.grund] = (erg.zaehler[b.grund] ?? 0) + 1;
    }
    statistik.neu = neu.length;
    erg.neu.push(...neu);
    if (nachholen.length) erg.hinweise.push(`${ABLAGE[q.name]}: ${nachholen.length} Datei(en) nicht vollständig lesbar — nächster Lauf versucht es erneut`);

    if (!o.probe) {
      if (neu.length) {
        fs.mkdirSync(o.zustand, { recursive: true });
        fs.appendFileSync(registerPfad, neu.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
      }
      stand.quellen[q.name] = { stand: aend.stand, letzterLauf: jetzt.toISOString() };
      stand.nachholen[q.name] = nachholen;
      /* CSV nur, wenn das Register gewachsen ist. */
      if (neu.length) {
        const inhalt = dokCsv(ladeDokRegister(registerPfad));
        fs.writeFileSync(path.join(o.zustand, `${q.name}-register.csv`), inhalt, 'utf-8');
        if (o.dropbox && !q.privat) {
          await o.dropbox.uploadFile({
            path: `${DROPBOX_DOK_REGISTER}/${q.name}-register.csv`, body: Buffer.from(inhalt, 'utf-8'),
            contentType: 'text/csv; charset=utf-8',
          }).catch((e: any) => erg.fehler.push(`CSV ${q.name} nicht hochgeladen: ${e?.message ?? e}`));
        }
      }
    }
    log(`[doc-register:${q.name}] ${aend.dateien.length} gemeldet, ${neu.length} neu/geändert, ${statistik.relevant} relevant`);
  }
  if (!o.probe) schreibeJson(standPfad, stand);
  erg.zusammen = `dokumente: ${Object.entries(erg.jeQuelle).map(([k, v]) => `${k} ${v.neu} neu`).join(', ')}; `
    + `${erg.relevant.length} relevant`;
  return erg;
}
