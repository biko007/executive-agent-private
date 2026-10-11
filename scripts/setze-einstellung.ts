#!/usr/bin/env bun
/**
 * Setzt einen Wert in `system_settings` aus einer JSON-Datei.
 *
 * Geht über `setSetting()` aus dem gemeinsamen Einstellungsmodul und nicht per
 * SQL: Diese Funktion schreibt den Audit-Eintrag in derselben Transaktion.
 * Einstellungen tragen fachliche Entscheidungen (Umlageregeln, Zuordnungen,
 * Mieterstromzahlen) — wer sie wann geändert hat, muss beantwortbar bleiben.
 *
 * Aufruf:
 *   bun run scripts/setze-einstellung.ts <schluessel> <datei.json> [--actor name]
 */
import { setSetting, getSetting } from '../src/shared/settings/index.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function envWert(schluessel: string): string {
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  const treffer = readFileSync(envFile, 'utf-8').match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in der Env-Datei`);
  return treffer[1].trim();
}

async function main() {
  const [schluessel, datei] = process.argv.slice(2);
  if (!schluessel || !datei) {
    console.error('Aufruf: bun run scripts/setze-einstellung.ts <schluessel> <datei.json>');
    process.exit(1);
  }
  if (!existsSync(datei)) throw new Error(`Datei nicht gefunden: ${datei}`);
  if (!process.env.POSTGRES_URL) process.env.POSTGRES_URL = envWert('POSTGRES_URL');

  const wert = JSON.parse(readFileSync(datei, 'utf-8'));
  const vorher = await getSetting(schluessel);

  await setSetting(schluessel, wert);

  const nachher = await getSetting(schluessel);
  console.log(`Einstellung "${schluessel}" gesetzt.`);
  console.log(`  vorher : ${vorher === undefined ? 'nicht vorhanden' : JSON.stringify(vorher).length + ' Byte'}`);
  console.log(`  nachher: ${JSON.stringify(nachher).length} Byte`);
}

main().then(() => process.exit(0)).catch(e => { console.error('FEHLER:', e.message); process.exit(1); });
