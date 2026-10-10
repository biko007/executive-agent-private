#!/usr/bin/env bun
/**
 * Trägt Umsätze aus einer CSV nachträglich in den Bestand ein.
 *
 * Die CSV entstand in Paket 2 aus den Kontoauszugs-PDF; ihr Aufbau ist
 * `buchungsdatum;wertstellung;betrag_eur;gegenpartei;verwendungszweck;buchungsart;konto_maskiert`
 * mit deutschem Dezimalkomma.
 *
 * Das Skript schreibt NICHT selbst in die Datenbank, sondern ruft
 * `POST /api/internal/banking/import-transactions` auf — dieselbe Route, die
 * auch ein anderer Aufrufer benutzen würde. Dadurch gilt der Abgleich, der
 * Audit-Eintrag und die Herkunftskennzeichnung ohne Sonderweg.
 *
 * Aufruf:
 *   bun run scripts/import-umsaetze-csv.ts <datei.csv> --konto <id> [--apply]
 *
 * Ohne --apply ist es ein Probelauf: Die Route gleicht ab und schreibt nichts.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://127.0.0.1:18789';

function envWert(schluessel: string): string {
  if (process.env[schluessel]) return process.env[schluessel]!;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error(`${schluessel} nicht gesetzt und ~/.config/openclaw/env fehlt`);
  const treffer = readFileSync(envFile, 'utf-8').match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in der Env-Datei`);
  return treffer[1].trim();
}

/** Eine CSV-Zeile in Felder zerlegen; Anführungszeichen schützen das Semikolon. */
function felder(zeile: string): string[] {
  const out: string[] = [];
  let feld = '';
  let inAnf = false;
  for (let i = 0; i < zeile.length; i++) {
    const c = zeile[i];
    if (c === '"') {
      if (inAnf && zeile[i + 1] === '"') { feld += '"'; i++; }
      else inAnf = !inAnf;
    } else if (c === ';' && !inAnf) {
      out.push(feld); feld = '';
    } else {
      feld += c;
    }
  }
  out.push(feld);
  return out;
}

/** "-1.234,56" → -1234.56 */
function betrag(s: string): number {
  return parseFloat(s.trim().replace(/\./g, '').replace(',', '.'));
}

function lese(datei: string) {
  const text = readFileSync(datei, 'utf-8').replace(/^﻿/, '');
  const zeilen = text.split(/\r?\n/).filter(z => z.trim().length > 0);
  const kopf = felder(zeilen[0]).map(s => s.trim());
  const idx = (name: string) => {
    const i = kopf.indexOf(name);
    if (i < 0) throw new Error(`Spalte ${name} fehlt in ${datei}`);
    return i;
  };
  const iBuchung = idx('buchungsdatum');
  const iWert = idx('wertstellung');
  const iBetrag = idx('betrag_eur');
  const iGegen = idx('gegenpartei');
  const iZweck = idx('verwendungszweck');
  const iArt = idx('buchungsart');

  return zeilen.slice(1).map(z => {
    const f = felder(z);
    return {
      booking_date: f[iBuchung].trim(),
      value_date: f[iWert].trim() || null,
      amount: betrag(f[iBetrag]),
      currency: 'EUR',
      counterparty_name: f[iGegen].trim() || null,
      reference: f[iZweck].trim() || null,
      transaction_code: f[iArt].trim() || null,
    };
  });
}

async function main() {
  const datei = process.argv[2];
  const kontoArg = process.argv[process.argv.indexOf('--konto') + 1];
  const anwenden = process.argv.includes('--apply');

  if (!datei || !existsSync(datei)) throw new Error('CSV-Datei fehlt oder ist nicht lesbar');
  const konto = parseInt(kontoArg || '', 10);
  if (!Number.isInteger(konto) || konto <= 0) throw new Error('--konto <id> fehlt');

  const zeilen = lese(datei);
  console.log(`\n${datei}`);
  console.log(`  Zeilen gelesen : ${zeilen.length}`);
  console.log(`  Zeitraum       : ${zeilen[0]?.booking_date} bis ${zeilen[zeilen.length - 1]?.booking_date}`);
  console.log(`  Konto          : ${konto}`);
  console.log(`  Modus          : ${anwenden ? 'ANWENDEN' : 'Probelauf'}`);

  const antwort = await fetch(`${GATEWAY}/api/internal/banking/import-transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${envWert('CORE_SERVICE_TOKEN')}`,
      'X-Actor': 'owner-import',
    },
    body: JSON.stringify({
      account_id: konto,
      source: 'pdf_import',
      dry_run: !anwenden,
      transactions: zeilen,
    }),
  });

  const text = await antwort.text();
  if (!antwort.ok) throw new Error(`HTTP ${antwort.status}: ${text.slice(0, 300)}`);
  const e = JSON.parse(text);

  console.log('\nErgebnis:');
  console.log(`  neu              : ${e.neu}`);
  console.log(`  Dublette (Tag)   : ${e.dublette_exakt}`);
  console.log(`  Dublette (±3 Tg) : ${e.dublette_fenster}`);
  console.log(`  übersprungen     : ${e.uebersprungen}`);
  for (const h of e.hinweise || []) console.log(`  · ${h}`);
  const summe = e.neu + e.dublette_exakt + e.dublette_fenster + e.uebersprungen;
  if (summe !== e.gelesen) {
    console.log(`\nWARNUNG: Summe ${summe} weicht von ${e.gelesen} gelesenen Zeilen ab.`);
    process.exit(1);
  }
  console.log(`\nAbgleich vollständig: ${summe} von ${e.gelesen} Zeilen erklärt.`);
}

main().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });
