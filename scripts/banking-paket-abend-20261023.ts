/**
 * banking-paket-abend-20261023.ts — Datenteil der Owner-Freigabe 23.10.2026
 * 21:40 „Freigabe Paket Abend" (report-banking-auswertung-neuverbinden-abend-20261023).
 *
 *  1. Drei PDF-Zeilen, die neben ihrem Bankumsatz doppelt zählen, als
 *     Dublette markieren (duplicate_of): 3491 → 9212, 4661 → 8309, 4662 → 8310.
 *  3. Die sechs am 23.10. erstmals gemeldeten KSK-Konten benennen:
 *     vier Kautionskonten ausgeblendet („Mietergeld – nicht auswerten"),
 *     Stromkonto N24 aktiv, Darlehen aktiv mit Kontoart `darlehen`
 *     (zählt nicht zur Kontensumme, Dashboard weist es getrennt aus).
 *
 * Jede Änderung prüft den erwarteten Ausgangszustand; weicht er ab, bricht
 * das Skript ohne Änderung ab.
 *
 *   (ohne Schalter)  Trockenlauf.
 *   --schreiben      ändert in einer Transaktion und schreibt die Audit-Einträge.
 */
import { query, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const schreiben = process.argv.includes('--schreiben');
const FREIGABE = 'Owner 23.10.2026 21:40 „Freigabe Paket Abend"';

const PAARE = [
  { pdf: 3491, bank: 9212, konto: 107, betrag: -11.5 },
  { pdf: 4661, bank: 8309, konto: 134, betrag: -3345 },
  { pdf: 4662, bank: 8310, konto: 134, betrag: -246 },
];

const KONTEN = [
  { id: 207, endziffern: '4303', display_name: 'Kaution N24 W1 …4303', status: 'archived', account_type: 'kaution', owner_name: 'Mietergeld – nicht auswerten' },
  { id: 206, endziffern: '3452', display_name: 'Kaution …3452', status: 'archived', account_type: 'kaution', owner_name: 'Mietergeld – nicht auswerten' },
  { id: 208, endziffern: '6631', display_name: 'Kaution …6631', status: 'archived', account_type: 'kaution', owner_name: 'Mietergeld – nicht auswerten' },
  { id: 212, endziffern: '1795', display_name: 'Kaution …1795', status: 'archived', account_type: 'kaution', owner_name: 'Mietergeld – nicht auswerten' },
  { id: 202, endziffern: '5844', display_name: 'Stromkonto N24 (…5844)', status: 'active', account_type: 'strom', owner_name: null },
  { id: 213, endziffern: '4413', display_name: 'Darlehen …4413', status: 'active', account_type: 'darlehen', owner_name: 'La Perla GmbH' },
];

const { rows: tx } = await query(
  `SELECT id, account_id, source, amount, duplicate_of FROM banking_transactions WHERE id = ANY($1)`,
  [PAARE.flatMap(p => [p.pdf, p.bank])]);
const zeile = (id: number) => (tx as any[]).find(r => Number(r.id) === id);
for (const p of PAARE) {
  const pdf = zeile(p.pdf), bank = zeile(p.bank);
  const ok = pdf && bank && Number(pdf.account_id) === p.konto && Number(bank.account_id) === p.konto
    && pdf.source !== 'fints' && bank.source === 'fints'
    && Number(pdf.amount) === p.betrag && Number(bank.amount) === p.betrag
    && pdf.duplicate_of === null && bank.duplicate_of === null;
  if (!ok) throw new Error(`Ausgangszustand weicht ab: PDF ${p.pdf} / Bank ${p.bank}`);
}

const { rows: konten } = await query(
  `SELECT id, iban, status, account_type, display_name, owner_name, institution_id FROM banking_accounts WHERE id = ANY($1)`,
  [KONTEN.map(k => k.id)]);
for (const k of KONTEN) {
  const r = (konten as any[]).find(x => Number(x.id) === k.id);
  if (!r || !String(r.iban).endsWith(k.endziffern) || Number(r.institution_id) !== 1 || r.status !== 'active') {
    throw new Error(`Ausgangszustand weicht ab: Konto ${k.id}`);
  }
}

if (schreiben) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    for (const p of PAARE) {
      const r = await client.query(
        'UPDATE banking_transactions SET duplicate_of = $2, updated_at = NOW() WHERE id = $1 AND duplicate_of IS NULL RETURNING id',
        [p.pdf, p.bank]);
      if (r.rows.length !== 1) throw new Error(`PDF-Zeile ${p.pdf} nicht geändert`);
    }
    for (const k of KONTEN) {
      await client.query(
        `UPDATE banking_accounts SET display_name = $2, status = $3, account_type = $4, owner_name = $5, updated_at = NOW() WHERE id = $1`,
        [k.id, k.display_name, k.status, k.account_type, k.owner_name]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await audit.log({
    module: 'banking', action: 'transactions.pdf_verknuepft', actor: 'cc-bikosoc',
    entityType: 'banking_transaction', entityId: PAARE.map(p => p.pdf).join(','),
    before: { duplicate_of: null },
    after: { paare: PAARE.map(p => ({ pdf: p.pdf, bank: p.bank, betrag: p.betrag })), grund: 'Doppelzählung PDF neben Bankumsatz (Datum außerhalb der Toleranz)', freigabe: FREIGABE },
  });
  await audit.log({
    module: 'banking', action: 'account.zuordnung', actor: 'cc-bikosoc',
    entityType: 'banking_account', entityId: KONTEN.map(k => k.id).join(','),
    before: { konten: (konten as any[]).map(r => ({ id: Number(r.id), display_name: r.display_name, status: r.status, account_type: r.account_type, owner_name: r.owner_name })) },
    after: { konten: KONTEN.map(({ endziffern, ...k }) => k), freigabe: FREIGABE },
  });
}

console.log(JSON.stringify({ modus: schreiben ? 'schreiben' : 'trocken', paare: PAARE, konten: KONTEN.map(k => ({ id: k.id, neu: k.display_name, status: k.status, art: k.account_type })) }, null, 1));
process.exit(0);
