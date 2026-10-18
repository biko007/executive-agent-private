#!/usr/bin/env bun
/**
 * Holt Reisedateien des Reiseassistenten aus Dropbox ins Dashboard.
 *
 * Weg (Owner-Auftrag 18.10.2026, 21:30): **Ein Ort fuer Owner und Assistent**
 * — `/Austausch/reisen/`. Dort liegen das lebende Reisedokument und die
 * Original-PDFs; nur der Owner kann Binaerdateien ablegen, also muss der
 * Import dorthin schauen. Erreichbar ist der Ordner ueber den
 * Vollzugriff-Adapter (App „BikosOpenClawFA", Basis leer = Kontowurzel).
 *
 * `transfer/reisen/` im App-Ordner wird als **alter** zweiter Weg weiter
 * gelesen, damit dort abgelegte Dateien nicht liegenbleiben.
 *
 *   bun run scripts/reise-import.ts            (einmal durchlaufen)
 *   bun run scripts/reise-import.ts --probe    (nur pruefen, nichts schreiben)
 *   bun run scripts/reise-import.ts --datei 261107-trip-winnipeg.json
 *
 * Es versendet nichts und loescht keine Reise. Eine Datei mit gleicher oder
 * kleinerer Versionsnummer ersetzt eine vorhandene Reise nicht.
 */
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { dropboxZugang, dropboxVollzugang } from '../src/adapters/dropbox-zugang.js';
import type { DropboxAdapter } from '../src/adapters/dropbox.js';
import {
  pruefeReise, nachTrip, ersetzen, dokumentZiel, dokumenteMitDatei, ergebnisText,
  DROPBOX_AUSTAUSCH, DROPBOX_AUSTAUSCH_DOKUMENTE, DROPBOX_AUSTAUSCH_DONE,
  DROPBOX_REISEN, DROPBOX_REISEN_DOKUMENTE, DROPBOX_REISEN_DONE, DOKUMENTE_KATEGORIE,
  type ReiseDatei, type ImportErgebnis,
} from '../src/modules/reise-import/index.js';

const HOME = process.env.HOME || homedir();
const TRAVEL_DIR = path.join(HOME, '.openclaw/workspace/artifacts/personal/travel');
const DOCS_DIR = path.join(HOME, '.openclaw/workspace/artifacts/personal/documents');
const DOCS_META = path.join(DOCS_DIR, 'metadata.json');

const probe = process.argv.includes('--probe');
const nurDatei = (() => {
  const i = process.argv.indexOf('--datei');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

/** Ein Ordner, aus dem gelesen wird — mit dem Adapter, der ihn erreicht. */
interface Quelle {
  name: string;
  adapter: DropboxAdapter;
  ordner: string;
  dokumente: string;
  done: string;
}

const quellen: Quelle[] = [];

const voll = dropboxVollzugang((k) => process.env[k]);
if (voll) {
  quellen.push({
    name: 'Austausch', adapter: voll.adapter, ordner: DROPBOX_AUSTAUSCH,
    dokumente: DROPBOX_AUSTAUSCH_DOKUMENTE, done: DROPBOX_AUSTAUSCH_DONE,
  });
}
const zugang = dropboxZugang((k) => process.env[k]);
if (zugang) {
  quellen.push({
    name: 'App-Ordner (alt)', adapter: zugang.adapter, ordner: DROPBOX_REISEN,
    dokumente: DROPBOX_REISEN_DOKUMENTE, done: DROPBOX_REISEN_DONE,
  });
}
if (!quellen.length) {
  process.stdout.write('reise-import: kein Dropbox-Zugang — nichts zu tun.\n');
  process.exit(0);
}

function metadatenLesen(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(DOCS_META, 'utf-8')); } catch { return {}; }
}
function metadatenSchreiben(m: Record<string, unknown>): void {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(DOCS_META, JSON.stringify(m, null, 2), 'utf-8');
}

/** Stempel fuer den done-Ordner, Europe/Berlin. */
function stempel(now: Date): string {
  const t = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const v = (x: string) => t.find((p) => p.type === x)?.value ?? '00';
  return `${v('year')}${v('month')}${v('day')}-${v('hour')}${v('minute')}${v('second')}`;
}

/** Eine Reisedatei verarbeiten. Schreibt nichts, wenn `probe` gesetzt ist. */
async function verarbeite(
  q: Quelle, datei: { name: string; pathLower: string },
): Promise<ImportErgebnis> {
  const erg: ImportErgebnis = {
    datei: datei.name, quelle: q.name, uebernommen: false, grund: '',
    fehler: [], warnungen: [], dokumente: [], fehlendeDokumente: [],
  };
  try {
    const inhalt = await q.adapter.downloadFile(datei.pathLower);
    const roh = JSON.parse(inhalt.toString('utf-8'));
    const befund = pruefeReise(roh);
    erg.fehler = befund.fehler;
    erg.warnungen = befund.warnungen;
    if (!befund.ok) {
      erg.grund = 'Prüfung fehlgeschlagen';
      return erg;
    }
    const reise = roh as ReiseDatei;
    erg.id = reise.id;

    const zielDatei = path.join(TRAVEL_DIR, `${reise.id}.json`);
    const vorhanden = fs.existsSync(zielDatei)
      ? JSON.parse(fs.readFileSync(zielDatei, 'utf-8')) as Record<string, unknown>
      : null;
    const entscheid = ersetzen(reise, vorhanden);
    erg.grund = entscheid.grund;
    if (!entscheid.ersetzen) return erg;

    /* Dokumente zuerst: Liegt ein PDF nicht in Dropbox, soll das in der
       Reise sichtbar sein, bevor sie geschrieben wird. */
    const meta = metadatenLesen();
    for (const d of dokumenteMitDatei(reise)) {
      const quellPfad = `${q.dokumente}/${d.datei}`;
      try {
        const bytes = await q.adapter.downloadFile(quellPfad);
        const rel = dokumentZiel(reise.id, String(d.datei));
        const ziel = path.join(DOCS_DIR, rel);
        if (!probe) {
          fs.mkdirSync(path.dirname(ziel), { recursive: true });
          fs.writeFileSync(ziel, bytes);
          meta[rel] = {
            kategorie: DOKUMENTE_KATEGORIE, tripId: reise.id,
            uploadedAt: new Date().toISOString(),
          };
        }
        erg.dokumente.push({ datei: String(d.datei), ziel: rel, bytes: bytes.length });
      } catch {
        erg.fehlendeDokumente.push(String(d.datei));
      }
    }
    if (!probe && erg.dokumente.length) metadatenSchreiben(meta);

    const trip = nachTrip(reise, vorhanden, new Date().toISOString(),
      erg.dokumente.map((d) => d.datei));
    if (!probe) {
      fs.mkdirSync(TRAVEL_DIR, { recursive: true });
      fs.writeFileSync(zielDatei, JSON.stringify(trip, null, 2), 'utf-8');
      /* Erst nach dem Schreiben verschieben — bricht es vorher ab, liegt die
         Datei noch in Dropbox und der naechste Lauf holt sie erneut. */
      await q.adapter.createFolder(q.done).catch(() => { /* existiert */ });
      await q.adapter.moveFile(datei.pathLower,
        `${q.done}/${stempel(new Date())}-${datei.name}`)
        .catch((e: any) => {
          process.stderr.write(`  Hinweis: nicht nach done verschoben (${e.message})\n`);
        });
    }
    erg.uebernommen = true;
    return erg;
  } catch (e: any) {
    erg.fehler.push(e?.message ?? String(e));
    erg.grund = 'Fehler beim Verarbeiten';
    return erg;
  }
}

try {
  const ergebnisse: ImportErgebnis[] = [];
  const gesehen = new Set<string>();

  for (const q of quellen) {
    /* Ein fehlender oder nicht lesbarer Ordner ist kein Abbruch — der alte
       Weg darf leer bleiben, und ohne Vollzugriff gibt es den Austausch-
       ordner nicht. */
    let eintraege;
    try {
      eintraege = await q.adapter.listFolder(q.ordner);
    } catch (e: any) {
      process.stdout.write(`reise-import: ${q.ordner} nicht lesbar (${e?.message ?? e}).\n`);
      continue;
    }
    const dateien = eintraege
      .filter((e) => e.tag === 'file' && e.name.toLowerCase().endsWith('.json'))
      .filter((e) => !nurDatei || e.name === nurDatei)
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const datei of dateien) {
      /* Liegt dieselbe Datei in beiden Ordnern, zaehlt der erste Fund —
         `/Austausch` steht vorn. Der zweite wuerde an der Versionsregel
         ohnehin abprallen, aber so bleibt das Protokoll lesbar. */
      if (gesehen.has(datei.name.toLowerCase())) continue;
      gesehen.add(datei.name.toLowerCase());
      ergebnisse.push(await verarbeite(q, datei));
    }
  }

  if (!ergebnisse.length) {
    process.stdout.write(
      `reise-import: keine Datei in ${quellen.map((q) => q.ordner).join(' und ')}.\n`);
    process.exit(0);
  }

  for (const e of ergebnisse) {
    process.stdout.write((probe ? '[Probe] ' : '') + `[${e.quelle}] ` + ergebnisText(e) + '\n');
    for (const f of e.fehler) process.stdout.write(`    Fehler: ${f}\n`);
    for (const w of e.warnungen) process.stdout.write(`    Hinweis: ${w}\n`);
  }

  const gut = ergebnisse.filter((e) => e.uebernommen).length;
  if (gut && !probe) {
    /* Kurzmeldung nach bikosoc-dev; der interne Endpunkt kennt die Bindung. */
    await fetch('http://127.0.0.1:18789/api/internal/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Reise-Import: ${gut} Reise(n) übernommen`,
        severity: 'info', role: 'dev', lage: 'ok', titel: 'Reise-Import',
        zeilen: ergebnisse.filter((e) => e.uebernommen)
          .map((e) => `${e.id}: ${e.dokumente.length} Dokument(e), ${e.grund}`
            + e.fehlendeDokumente.map((d) => `, PDF fehlt: ${d}`).join('')),
      }),
    }).catch(() => { /* Meldung ist Beiwerk */ });
  }
  process.exit(ergebnisse.some((e) => e.fehler.length) ? 1 : 0);
} catch (e: any) {
  process.stderr.write(`reise-import Fehler: ${e?.message ?? e}\n`);
  process.exit(1);
}
