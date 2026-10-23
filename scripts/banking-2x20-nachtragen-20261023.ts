/**
 * banking-2x20-nachtragen-20261023.ts — zwei Lastschriften auf dem Mietkonto
 * …9268 aus der PDF-Umsatzliste nachtragen (Owner-Freigabe 23.10.2026 23:09
 * „Freigabe Rollback-Fix und 2x20 nachtragen").
 *
 * Befund (report-banking-paket-abend-20261023): Im Altbestand vor dem
 * 02.09.2024 fehlen je eine Lastschrift über −20,00 € am 15.07.2024
 * (Rechnung 307008/MG24) und am 15.08.2024 (Rechnung 339065/S28). Der alte
 * Umsatzschlüssel (Datum + Betrag + Buchungsart) hat sie mit der zweiten
 * −20,00-€-Lastschrift desselben Tages zusammengezogen; die Bank liefert den
 * Zeitraum nicht mehr nach.
 *
 * Quelle: ~/bikosoc-spec/import/umsaetze-immobilien-2024-2026-pdfimport-20261010.csv
 * (Paket 2). Herkunft 'pdf_import' wie beim Import, Kennung nach
 * `herkunftsId`, im raw_payload Datei und Freigabe.
 *
 *   (ohne Schalter)  Trockenlauf.
 *   --schreiben      legt beide Zeilen in einer Transaktion an, Audit-Eintrag.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { query, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';
import { herkunftsId } from '../src/modules/banking/import.js';

const schreiben = process.argv.includes('--schreiben');
const KONTO_ID = 7;
const DATEI = 'umsaetze-immobilien-2024-2026-pdfimport-20261010.csv';
const FREIGABE = 'Owner 23.10.2026 23:09 „Freigabe Rollback-Fix und 2x20 nachtragen"';
const GESUCHT = [
  { datum: '2024-07-15', rechnung: '307008/Marktgasse 24' },
  { datum: '2024-08-15', rechnung: '339065/Schoenhalde 28' },
];

const { rows: [konto] } = await query(`SELECT id, iban FROM banking_accounts WHERE id = $1`, [KONTO_ID]);
if (!konto || !String(konto.iban).endsWith('9268')) throw new Error('Konto …9268 nicht gefunden');

const zeilen = readFileSync(join(homedir(), 'bikosoc-spec', 'import', DATEI), 'utf-8')
  .replace(/^﻿/, '').split('\n').slice(1).filter(Boolean);
const feld = (z: string) => z.split(';').map(f => f.replace(/^"|"$/g, ''));

const neu = GESUCHT.map(g => {
  const treffer = zeilen.map(feld).filter(f => f[0] === g.datum && f[2] === '-20,00' && f[4].includes(`Rechnung ${g.rechnung}`));
  if (treffer.length !== 1) throw new Error(`PDF-Zeile ${g.datum} ${g.rechnung}: ${treffer.length} Treffer`);
  const [buchung, valuta, , gegenpartei, zweck, art] = treffer[0];
  const z = { booking_date: buchung, value_date: valuta, amount: -20, currency: 'EUR',
    counterparty_name: gegenpartei, reference: zweck, transaction_code: art };
  return { ...z, bank_transaction_id: herkunftsId(z as any, 1) };
});

// Ausgangszustand: Weder die Kennung noch eine Zeile mit dieser Rechnung an diesem Tag darf schon da sein
for (const z of neu) {
  const rechnung = z.reference.match(/Rechnung (\d+)/)![1];
  const { rows } = await query(
    `SELECT id FROM banking_transactions
      WHERE account_id = $1 AND (bank_transaction_id = $2
        OR (coalesce(value_date, booking_date) = $3 AND amount = -20 AND reference LIKE $4))`,
    [KONTO_ID, z.bank_transaction_id, z.booking_date, `%${rechnung}%`]);
  if (rows.length > 0) throw new Error(`Schon vorhanden: ${z.booking_date} Rechnung ${rechnung} (id ${rows[0].id})`);
}

const ids: number[] = [];
if (schreiben) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    for (const z of neu) {
      const r = await client.query(
        `INSERT INTO banking_transactions
           (account_id, bank_transaction_id, booking_date, value_date, amount, currency,
            counterparty_name, reference, transaction_code, raw_payload, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pdf_import') RETURNING id`,
        [KONTO_ID, z.bank_transaction_id, z.booking_date, z.value_date, z.amount, z.currency,
          z.counterparty_name, z.reference, z.transaction_code,
          JSON.stringify({ quelle: 'pdf_import', datei: DATEI, nachgetragen_am: new Date().toISOString(), freigabe: FREIGABE })]);
      ids.push(Number(r.rows[0].id));
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await audit.log({
    module: 'banking', action: 'transaction.nachgetragen', actor: 'cc-bikosoc',
    entityType: 'banking_transaction', entityId: ids.join(','),
    after: {
      konto: '…9268', quelle: 'pdf_import', datei: DATEI,
      zeilen: neu.map((z, i) => ({ id: ids[i], datum: z.booking_date, betrag: z.amount, rechnung: z.reference.match(/Rechnung (\S+)/)![1] })),
      grund: 'vom alten Umsatzschlüssel zusammengezogen, Bank liefert den Zeitraum nicht mehr',
      freigabe: FREIGABE,
    },
  });
}

console.log(JSON.stringify({ modus: schreiben ? 'schreiben' : 'trocken', ids,
  zeilen: neu.map(z => ({ datum: z.booking_date, betrag: z.amount, kennung: z.bank_transaction_id, zweck: z.reference.slice(0, 50) })) }, null, 1));
process.exit(0);
