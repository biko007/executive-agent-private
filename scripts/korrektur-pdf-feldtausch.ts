#!/usr/bin/env bun
/**
 * Korrigiert die Zeilen des Kontoauszug-Imports vom 10.10.2026, in denen
 * Gegenpartei und Verwendungszweck vertauscht sind.
 *
 * BEFUND (16.10.2026). Die Quell-CSV aus den Kontoauszugs-PDF
 * (`~/bikosoc-spec/import/umsaetze-*-pdfimport-20261010.csv`) hat bei elf
 * Zeilen die Spalten verschoben:
 *
 *   gegenpartei      = "<Verwendungszweck> <TT.MM.JJJJ> | <Buchungsart>"
 *   verwendungszweck = der Name einer BENACHBARTEN Buchung
 *   buchungsart      = leer
 *
 * Der eigene Zahlername fehlt in der CSV; er steht nur im PDF. Deshalb wird
 * NICHT stumpf zurueckgetauscht — das wuerde jeder Zeile den Namen der
 * Nachbarbuchung anheften. Stattdessen:
 *
 *   reference        = der Verwendungszweck ohne den Datums- und
 *                      Buchungsart-Anhang
 *   counterparty_name= der Zahler, soweit er sich aus dem Zweck, dem Betrag
 *                      und der laufenden Zahlungsreihe BELEGEN laesst
 *   raw_payload      = das Original beider Felder plus die Begruendung
 *
 * Folge fuer die Mietforderungen: N24 W1 (2.265,00 EUR Juli und August 2026)
 * und N24 W5 (1.360,00 EUR August 2026) sind bezahlt. Sie standen nur deshalb
 * als Rueckstand, weil der Zahlername in der falschen Spalte lag.
 *
 * Aufruf:  bun run scripts/korrektur-pdf-feldtausch.ts [--apply]
 * Ohne --apply ist es ein Probelauf.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function envWert(schluessel: string): string {
  if (process.env[schluessel]) return process.env[schluessel]!;
  const envFile = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(envFile)) throw new Error(`${schluessel} nicht gesetzt und ~/.config/openclaw/env fehlt`);
  const treffer = readFileSync(envFile, 'utf-8').match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in der Env-Datei`);
  return treffer[1].trim();
}
if (!process.env.POSTGRES_URL) process.env.POSTGRES_URL = envWert('POSTGRES_URL');
const { query } = await import('../src/shared/db/index.js');

/** Der Anhang, den der PDF-Text in die Gegenpartei-Spalte geschoben hat. */
const ANHANG = /\s*\d{2}\.\d{2}\.\d{4}\s*(\|.*)?$/;

/**
 * Der belegte Zahler je Zeile. Schluessel ist Betrag + Zweckanfang, damit die
 * Zuordnung nicht an einer Zeilennummer haengt.
 */
const ZAHLER: { zweck: string; betrag: number; name: string | null; beleg: string }[] = [
  { zweck: 'Miete Nonnenburgstrasse 24 W1', betrag: 2265,
    name: 'Eva Moeller',
    beleg: 'Zweck nennt die Einheit W1; Betrag, Buchungsart (Dauerauftrag) und Text stimmen mit den 18 '
         + 'vorangehenden Monaten dieses Mietverhaeltnisses ueberein. Kein anderes N24-Mietverhaeltnis '
         + 'hat eine Miete von 2.265,00 EUR.' },
  { zweck: 'Miete TG-Platz Nonnenburgstr', betrag: 75,
    name: 'ANNA-LENA WESTHAUSER',
    beleg: 'In 08, 09 und 10/2026 kommt derselbe Betrag mit demselben Zweck als Echtzeit-Gutschrift von '
         + 'Anna-Lena Westhauser, jeweils am selben Tag wie ihre Miete von 1.765,00 EUR. Am 02.07.2026 '
         + 'ist ihre Miete ebenfalls eingegangen, die 75,00 EUR am selben Tag.' },
  { zweck: 'Miete N24', betrag: 1360,
    name: 'Klaus Bickel',
    beleg: 'Betrag, Zweck und Buchungsart (Dauerauftrag) sind identisch mit den 22 uebrigen Zahlungen '
         + 'von Klaus Bickel; seine Reihe hat genau eine Luecke, August 2026. Kein anderes '
         + 'N24-Mietverhaeltnis hat eine Miete von 1.360,00 EUR.' },
  { zweck: 'Übertrag La Perla', betrag: 30000,
    name: 'Jürgen Bickel Privat',
    beleg: 'Der Uebertrag mit demselben Zweck kommt am 23.09.2026 von Juergen Bickel Privat; der Name '
         + 'steht ausserdem in der Zweckspalte derselben Auszugsseite.' },
  { zweck: 'SUMUP PID1329353 PAYOUT 140826', betrag: 1059.07,
    name: 'SUMUP LIMITED',
    beleg: 'Alle uebrigen Payouts mit Zweck „SUMUP PID… PAYOUT" kommen von SumUp Limited.' },
  { zweck: '501000041156/Grundsteuer B 2026', betrag: -149.57,
    name: 'Stadt Tuttlingen',
    beleg: 'Kassenzeichen 501000041156 ist die Grundsteuer B fuer N24 bei der Stadtkasse Tuttlingen '
         + '(vier Raten, Bescheid vom 10.01.2025).' },
  { zweck: '2026-0035', betrag: 2236,
    name: 'Fabian Mann',
    beleg: 'Dieselbe Rechnungsnummernreihe (2026-0033 am 19.08.2026, 2026-0034 am 03.09.2026) kommt von '
         + 'Fabian Mann, immer 2.236,00 EUR als Echtzeit-Gutschrift.' },
  { zweck: '2026-0036', betrag: 2236,
    name: 'Fabian Mann',
    beleg: 'Dieselbe Rechnungsnummernreihe (2026-0033, 2026-0034, 2026-0035) kommt von Fabian Mann, '
         + 'immer 2.236,00 EUR als Echtzeit-Gutschrift.' },
  { zweck: 'NO.0000001662888395/11785234', betrag: -128.88,
    name: 'Booking.com B.V.',
    beleg: 'Format der Referenz und Kundennummer 11785234 stimmen mit den uebrigen '
         + 'Booking.com-Lastschriften ueberein.' },
  { zweck: 'Entgeltabrechnung siehe Anlage', betrag: -17.08,
    name: 'ENTGELTABSCHLUSS',
    beleg: 'Monatlicher Entgeltabschluss der Bank; an allen uebrigen Monatsenden steht derselbe Satz '
         + 'mit der Gegenpartei ENTGELTABSCHLUSS.' },
];

const apply = process.argv.includes('--apply');

/* V027 hat banking_transactions den Trigger set_updated_at() ohne die Spalte
   updated_at gegeben; jede Aenderung an einem Umsatz bricht deshalb ab. V042
   traegt die Spalte nach. Ohne V042 laeuft nur der Probelauf. */
if (apply) {
  const { rows: spalte } = await query<any>(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name='banking_transactions' AND column_name='updated_at'`);
  if (!spalte.length) {
    console.error('banking_transactions.updated_at fehlt — zuerst V042 anwenden.');
    console.error('Grund: Der Trigger trg_banking_transactions_updated_at setzt die Spalte,');
    console.error('die V027 nie angelegt hat. Ohne sie scheitert jedes UPDATE.');
    process.exit(2);
  }
}

const { rows } = await query<any>(`
  SELECT id, account_id, to_char(booking_date,'YYYY-MM-DD') AS d, amount::float AS betrag,
         counterparty_name, reference, raw_payload
    FROM banking_transactions
   WHERE source = 'pdf_import'
     AND counterparty_name ~ ' [0-9]{2}\\.[0-9]{2}\\.[0-9]{4}( \\|)?'
   ORDER BY booking_date, id`);

console.log(`Zeilen mit vertauschten Feldern: ${rows.length}${apply ? '' : '  (Probelauf)'}\n`);
let geaendert = 0, offen = 0;
for (const r of rows) {
  const zweck = String(r.counterparty_name).replace(ANHANG, '').trim();
  const treffer = ZAHLER.find(z => zweck.startsWith(z.zweck)
    && Math.abs(z.betrag - r.betrag) < 0.005);
  const name = treffer ? treffer.name : null;
  if (!treffer) offen++;
  console.log(`${String(r.id).padStart(5)} ${r.d} ${r.betrag.toFixed(2).padStart(11)} K${r.account_id}`);
  console.log(`      vorher   Name: ${JSON.stringify(r.counterparty_name)}  Zweck: ${JSON.stringify(r.reference)}`);
  console.log(`      nachher  Name: ${JSON.stringify(name)}  Zweck: ${JSON.stringify(zweck)}`);
  if (!treffer) console.log('      ! kein belegter Zahler — Name bleibt leer');
  if (!apply) continue;
  const roh = { ...(r.raw_payload || {}) };
  roh.feldtausch_korrigiert_am = new Date().toISOString().slice(0, 10);
  roh.original_counterparty_name = r.counterparty_name;
  roh.original_reference = r.reference;
  roh.hinweis = 'Quell-CSV aus Kontoauszug-PDF: Spalten verschoben. Der Name in der Zweckspalte '
    + 'gehoerte zu einer Nachbarbuchung und wurde verworfen.';
  if (treffer) roh.zahler_beleg = treffer.beleg;
  await query(
    `UPDATE banking_transactions SET counterparty_name = $1, reference = $2, raw_payload = $3
      WHERE id = $4`,
    [name, zweck, JSON.stringify(roh), r.id]);
  geaendert++;
}
console.log(`\n${apply ? 'geaendert' : 'zu aendern'}: ${rows.length}, davon ohne belegten Zahler: ${offen}`);
if (apply) console.log(`geschrieben: ${geaendert}`);
process.exit(0);
