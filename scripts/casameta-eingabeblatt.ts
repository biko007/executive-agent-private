#!/usr/bin/env bun
/**
 * Erzeugt das Casameta-Eingabeblatt von der Kommandozeile.
 *
 * Die Logik liegt in src/modules/assets/casameta.ts — dieselbe Funktion nutzt
 * auch die Core-Route, damit Blatt aus dem Dashboard und Blatt von Hand nie
 * auseinanderlaufen.
 *
 * Aufruf:
 *   bun run scripts/casameta-eingabeblatt.ts --objekt mg24 --jahr 2025
 */
import { erzeugeEingabeblatt } from '../src/modules/assets/casameta.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function envWert(schluessel: string): string {
  const treffer = readFileSync(join(homedir(), '.config', 'openclaw', 'env'), 'utf-8')
    .match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in der Env-Datei`);
  return treffer[1].trim();
}

async function main() {
  const argv = process.argv;
  const objektCode = argv[argv.indexOf('--objekt') + 1];
  const jahr = parseInt(argv[argv.indexOf('--jahr') + 1] || '', 10);
  if (!objektCode || !Number.isInteger(jahr)) {
    console.error('Aufruf: bun run scripts/casameta-eingabeblatt.ts --objekt <code> --jahr <jjjj>');
    process.exit(1);
  }
  if (!process.env.POSTGRES_URL) process.env.POSTGRES_URL = envWert('POSTGRES_URL');

  const e = await erzeugeEingabeblatt(objektCode, jahr);
  console.log(`\nCasameta-Eingabeblatt ${e.objekt} ${e.jahr}`);
  console.log(`  Wohnungen        : ${e.wohnungen}`);
  console.log(`  Nutzerzeitraeume : ${e.nutzerzeitraeume}`);
  console.log(`  Zaehler          : ${e.zaehler_aktiv} aktiv, ${e.zaehler_abgeschaltet} abgeschaltet`);
  console.log(`  Kostenbuchungen  : ${e.kostenbuchungen} (davon umlagefaehig ${e.umlagefaehig_anzahl})`);
  console.log(`  Summe umlagefaehig: ${e.summe_umlagefaehig.toFixed(2)} EUR`);
  console.log(`  Luecken          : ${e.luecken.length}`);
  console.log(`\n  ${e.pfad_md}`);
  console.log(`  ${e.pfad_csv}`);
}

main().then(() => process.exit(0)).catch(e => { console.error('FEHLER:', e.message); process.exit(1); });
