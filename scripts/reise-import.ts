#!/usr/bin/env bun
/**
 * Holt Reisedateien des Reiseassistenten aus Dropbox ins Dashboard.
 *
 * Weg (Owner-Auftrag 18.10.2026): Der Assistent legt je Reise eine
 * JSON-Datei nach `transfer/reisen/<id>.json` im App-Ordner, die PDFs nach
 * `transfer/reisen/dokumente/`. Dieses Skript prueft die Datei, schreibt die
 * Reisedatei des Dashboards, uebernimmt die PDFs in die Dokumentenablage und
 * legt die verarbeitete Datei nach `transfer/reisen/done/`.
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
import { dropboxZugang } from '../src/adapters/dropbox-zugang.js';
import {
  pruefeReise, nachTrip, ersetzen, dokumentZiel, dokumenteMitDatei, ergebnisText,
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

const zugang = dropboxZugang((k) => process.env[k]);
if (!zugang) {
  process.stdout.write('reise-import: kein Dropbox-Zugang — nichts zu tun.\n');
  process.exit(0);
}
const dropbox = zugang.adapter;

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

try {
  const eintraege = await dropbox.listFolder(DROPBOX_REISEN);
  const dateien = eintraege
    .filter((e) => e.tag === 'file' && e.name.toLowerCase().endsWith('.json'))
    .filter((e) => !nurDatei || e.name === nurDatei)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!dateien.length) {
    process.stdout.write(`reise-import: keine Datei in ${DROPBOX_REISEN}.\n`);
    process.exit(0);
  }

  const ergebnisse: ImportErgebnis[] = [];

  for (const datei of dateien) {
    const erg: ImportErgebnis = {
      datei: datei.name, uebernommen: false, grund: '', fehler: [], warnungen: [],
      dokumente: [], fehlendeDokumente: [],
    };
    try {
      const inhalt = await dropbox.downloadFile(datei.pathLower);
      const roh = JSON.parse(inhalt.toString('utf-8'));
      const befund = pruefeReise(roh);
      erg.fehler = befund.fehler;
      erg.warnungen = befund.warnungen;
      if (!befund.ok) {
        erg.grund = 'Prüfung fehlgeschlagen';
        ergebnisse.push(erg);
        continue;
      }
      const reise = roh as ReiseDatei;
      erg.id = reise.id;

      const zielDatei = path.join(TRAVEL_DIR, `${reise.id}.json`);
      const vorhanden = fs.existsSync(zielDatei)
        ? JSON.parse(fs.readFileSync(zielDatei, 'utf-8')) as Record<string, unknown>
        : null;
      const entscheid = ersetzen(reise, vorhanden);
      erg.grund = entscheid.grund;
      if (!entscheid.ersetzen) { ergebnisse.push(erg); continue; }

      /* Dokumente zuerst: Liegt ein PDF nicht in Dropbox, soll das in der
         Reise sichtbar sein, bevor sie geschrieben wird. */
      const meta = metadatenLesen();
      for (const d of dokumenteMitDatei(reise)) {
        const quelle = `${DROPBOX_REISEN_DOKUMENTE}/${d.datei}`;
        try {
          const bytes = await dropbox.downloadFile(quelle);
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
        await dropbox.createFolder(DROPBOX_REISEN_DONE).catch(() => { /* existiert */ });
        await dropbox.moveFile(datei.pathLower,
          `${DROPBOX_REISEN_DONE}/${stempel(new Date())}-${datei.name}`)
          .catch((e: any) => {
            process.stderr.write(`  Hinweis: nicht nach done verschoben (${e.message})\n`);
          });
      }
      erg.uebernommen = true;
      ergebnisse.push(erg);
    } catch (e: any) {
      erg.fehler.push(e?.message ?? String(e));
      erg.grund = 'Fehler beim Verarbeiten';
      ergebnisse.push(erg);
    }
  }

  for (const e of ergebnisse) {
    process.stdout.write((probe ? '[Probe] ' : '') + ergebnisText(e) + '\n');
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
          .map((e) => `${e.id}: ${e.dokumente.length} Dokument(e), ${e.grund}`),
      }),
    }).catch(() => { /* Meldung ist Beiwerk */ });
  }
  process.exit(ergebnisse.some((e) => e.fehler.length) ? 1 : 0);
} catch (e: any) {
  process.stderr.write(`reise-import Fehler: ${e?.message ?? e}\n`);
  process.exit(1);
}
