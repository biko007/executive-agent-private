/**
 * banking-kontonamen-kuerzen-20261023.ts — Kontobezeichnungen mit voller IBAN
 * auf Endziffern kürzen (Owner-Freigabe 23.10.2026 17:04 „(a) und umbenennen";
 * report-banking-zweite-freigabe-historie-umbenennen-20261023).
 *
 * Heißt ein Konto nur wie seine IBAN, wird es „<Bank> …1234" (dieselbe Regel
 * wie für neue Konten, `neueKontoBezeichnung`). Enthält die Bezeichnung die
 * IBAN neben einer Kennzeichnung („Dritte – nicht auswerten (…)"), bleibt die
 * Kennzeichnung und nur die IBAN wird gekürzt.
 *
 *   (ohne Schalter)  Trockenlauf — zeigt alt/neu nur mit Endziffern.
 *   --schreiben      ändert in einer Transaktion und schreibt einen Audit-Eintrag.
 */
import { query, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';
import { kuerzeIbansImText } from '../src/shared/audit/index.js';
import { neueKontoBezeichnung } from '../src/modules/banking/banken.js';

const schreiben = process.argv.includes('--schreiben');
const NUR_IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;

const { rows } = await query(
  `SELECT a.id, a.iban, a.status, a.display_name, i.blz, i.name AS bank
     FROM banking_accounts a JOIN banking_institutions i ON i.id = a.institution_id
    ORDER BY a.id`);
const aenderungen = (rows as any[])
  .map(r => {
    const alt = String(r.display_name ?? '');
    const neu = NUR_IBAN.test(alt.replace(/\s+/g, ''))
      ? neueKontoBezeichnung(r.blz, r.bank, r.iban, null)
      : kuerzeIbansImText(alt);
    return { id: Number(r.id), status: r.status, alt, neu };
  })
  .filter(a => a.neu !== a.alt);

if (schreiben && aenderungen.length > 0) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    for (const a of aenderungen) {
      await client.query('UPDATE banking_accounts SET display_name = $2, updated_at = NOW() WHERE id = $1', [a.id, a.neu]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await audit.log({
    module: 'banking', action: 'account.rename', actor: 'cc-bikosoc',
    entityType: 'banking_account', entityId: aenderungen.map(a => a.id).join(','),
    before: { konten: aenderungen.map(a => ({ id: a.id, display_name: kuerzeIbansImText(a.alt) })) },
    after: {
      konten: aenderungen.map(a => ({ id: a.id, display_name: a.neu })),
      grund: 'volle IBAN als Kontobezeichnung', freigabe: 'Owner 23.10.2026 17:04 „(a) und umbenennen"',
    },
  });
}

console.log(JSON.stringify({
  modus: schreiben ? 'schreiben' : 'trocken',
  anzahl: aenderungen.length,
  konten: aenderungen.map(a => ({ id: a.id, status: a.status, alt: kuerzeIbansImText(a.alt), neu: a.neu })),
}, null, 1));
process.exit(0);
