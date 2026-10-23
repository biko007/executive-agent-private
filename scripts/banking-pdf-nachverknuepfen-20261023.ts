/**
 * banking-pdf-nachverknuepfen-20261023.ts — PDF-Zeilen nachträglich mit ihren
 * FinTS-Zeilen verknüpfen (Owner-Freigabe 23.10.2026 17:01 „Freigabe 1-3",
 * Punkt 1; report-banking-doppelzaehlung-sitzung22-lokale-ibans-20261023).
 *
 * Gleiche Logik wie bei der Übernahme (`verknuepfePdfNachtraeglich` in
 * store.ts): paarweise für gleich hohe Buchungen, bei Kartenabrechnungen das
 * Umsatzdatum aus dem Zweck.
 *
 *   (ohne Schalter)  Trockenlauf: zeigt, was verknüpft würde — ändert nichts.
 *                    Das ist zugleich die Gegenprüfung: nach dem Schreiben
 *                    muss er leer sein.
 *   --schreiben      verknüpft und schreibt einen Audit-Eintrag.
 *
 * Betrachtet werden alle Konten mit PDF- und FinTS-Zeilen. Ausgabe nur mit
 * Endziffern.
 */
import { query } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';
import { verknuepfePdfNachtraeglich } from '../src/modules/banking/store.js';

const schreiben = process.argv.includes('--schreiben');

const konten = (await query(
  `SELECT a.id, right(a.iban, 4) AS endziffern
     FROM banking_accounts a
    WHERE EXISTS (SELECT 1 FROM banking_transactions t WHERE t.account_id = a.id AND t.source = 'fints')
      AND EXISTS (SELECT 1 FROM banking_transactions t WHERE t.account_id = a.id AND t.source IN ('pdf_import', 'kk_pdf_import'))
    ORDER BY a.id`)).rows as { id: string; endziffern: string }[];
const endziffern = new Map(konten.map(k => [Number(k.id), `…${k.endziffern}`]));

const treffer = await verknuepfePdfNachtraeglich(konten.map(k => Number(k.id)), schreiben);
const summe = treffer.reduce((s, t) => s + t.betrag, 0);

if (schreiben && treffer.length > 0) {
  await audit.log({
    module: 'banking', action: 'transactions.pdf_nachverknuepft', actor: 'cc-bikosoc',
    entityType: 'banking_transaction', entityId: treffer.map(t => t.pdfId).join(','),
    before: { duplicate_of: null, pdf_ids: treffer.map(t => t.pdfId) },
    after: {
      paare: treffer.map(t => ({ pdf: t.pdfId, fints: t.fintsId })),
      summe_doppelt_gezaehlt: Math.round(summe * 100) / 100,
      freigabe: 'Owner 23.10.2026 17:01 „Freigabe 1-3"',
    },
  });
}

console.log(JSON.stringify({
  modus: schreiben ? 'schreiben' : 'trocken',
  konten: konten.map(k => `…${k.endziffern}`),
  anzahl: treffer.length,
  summe: Math.round(summe * 100) / 100,
  paare: treffer.map(t => ({ konto: endziffern.get(t.kontoId), fints: t.fintsId, pdf: t.pdfId, betrag: t.betrag, nurReihenfolge: t.mehrdeutig })),
}, null, 1));
process.exit(0);
