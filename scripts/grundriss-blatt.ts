#!/usr/bin/env bun
/**
 * Grundrissblatt erzeugen: JSON hinein, SVG und PDF heraus.
 *
 * Das Format steht in docs/projekt/Objektsteckbrief-Standard.md, Abschnitt D.
 * Die Zeichnung selbst macht `src/modules/assets/grundriss.ts`; dieses Skript
 * schreibt die Dateien und setzt das PDF ueber den Chromium von Playwright,
 * der im Projekt ohnehin installiert ist.
 *
 * Aufruf:
 *   bun run scripts/grundriss-blatt.ts <blatt.json> [<zielverzeichnis>]
 *
 * Die Eingabe traegt die Geometrie in Metern aus einer VERMESSENEN Quelle
 * (DXF, DWG, Aufmass). Gibt es keine solche Quelle, gehoert `massstab: null`
 * in die Datei — dann steht „nicht maßstäblich" im Kopf. Geschaetzte Masse
 * werden nicht gezeichnet.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { grundrissSvg, type Blatt } from '../src/modules/assets/grundriss.js';

const [eingabe, zielArg] = process.argv.slice(2);
if (!eingabe) {
  console.error('Aufruf: bun run scripts/grundriss-blatt.ts <blatt.json> [<zielverzeichnis>]');
  process.exit(1);
}
const ziel = resolve(zielArg || '.');
mkdirSync(ziel, { recursive: true });

const blatt = JSON.parse(readFileSync(eingabe, 'utf-8')) as Blatt;
const { svg, warnungen } = grundrissSvg(blatt);

const name = basename(eingabe).replace(/\.json$/i, '');
const svgDatei = join(ziel, `${name}.svg`);
const pdfDatei = join(ziel, `${name}.pdf`);
writeFileSync(svgDatei, svg, 'utf-8');

for (const w of warnungen) console.warn('Hinweis: ' + w);

/* PDF ueber den Chromium von Playwright — A4 quer, ohne Raender, weil das
   Blatt seinen Rahmen selbst zeichnet. */
const { chromium } = await import('playwright');
const browser = await chromium.launch();
try {
  const seite = await browser.newPage();
  await seite.setContent(
    `<!doctype html><html><head><meta charset="utf-8">`
    + `<style>html,body{margin:0;padding:0}svg{display:block}</style></head>`
    + `<body>${svg}</body></html>`, { waitUntil: 'load' });
  await seite.pdf({ path: pdfDatei, width: '297mm', height: '210mm', printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' } });
} finally {
  await browser.close();
}

console.log(`geschrieben:\n  ${svgDatei}\n  ${pdfDatei}`);
if (warnungen.length) console.log(`\n${warnungen.length} Hinweis(e) — siehe oben.`);
process.exit(0);
