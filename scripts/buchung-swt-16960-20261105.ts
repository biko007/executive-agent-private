#!/usr/bin/env bun
/**
 * Owner-Freigabe 05.11.2026 11:35 („Freigabe Buchung SWT 16960 – Diese ist aber nicht relevant
 * für die Nebenkostenabrechnung."): SWT-Rechnung 0001-ARV-2026-16960 vom 14.10.2026,
 * Netzbezug N24 16.11.2024–31.03.2026, Rechnungseinheit 527415-334364.
 *
 * Gebucht wird der Rechnungsbetrag (Restzahlung nach Abschlägen) 9.422,32 € wie freigegeben,
 * Kostenart 17, NICHT umlagefähig. Die NK-Engine lädt nur umlagefähige Buchungen
 * (engine.ts loadEngineInput: `umlagefaehig = true`), die Vorprüfung prüft nicht umlagefähige
 * Kostenarten nicht auf Verteilschlüssel (precheck.ts Regel 7) — der Leistungszeitraum
 * 16.11.2024–31.03.2026 berührt die Mietersalden 2025 deshalb nicht. Nachweis im Report.
 *
 *   bun run scripts/buchung-swt-16960-20261105.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'buchung-swt-16960-20261105');
const AKTOR = 'cc-bikosoc';
const SOURCE_KEY = 'n24-swt-netzbezug-334364-2024-11-bis-2026-03';
const R = {
  nr: '0001-ARV-2026-16960', datum: '2026-10-14', von: '2024-11-16', bis: '2026-03-31',
  netto: 7917.89, ust: 1504.43, brutto: 9422.32,
  beleg: '/Apps/bikosoc-reports/bikosoc-reports/transfer/SWT-Rechnungen/SWT_2026-10-14_Nonnenburgstr_24_334364_0001-ARV-2026-16960.pdf',
};
const NOTIZ = 'SWT Strom, Kd 527415-334364 (La Perla GmbH), Vertrag 188471 „Allgemeiner Tarif Eintarif", Verbrauchsstelle Nonnenburgstr. 24, Netzbezug 16.11.2024 bis 31.03.2026. '
  + 'Gebucht ist der Rechnungsbetrag nach Abschlägen: Gesamtbetrag 12.243,97 netto + 2.326,35 USt = 14.570,32 brutto, abzüglich angeforderter Abschläge 5.148,00 brutto (4.326,08 + 821,92) = 9.422,32 brutto (7.917,89 netto + 1.504,43 USt). Die Abschläge sind nicht Teil dieser Buchung. '
  + 'Owner-Vermerk 05.11.2026: „nicht relevant für die Nebenkostenabrechnung" – deshalb nicht umlagefähig. '
  + 'Gebucht nach Owner-Freigabe 05.11.2026 11:35 („Freigabe Buchung SWT 16960"). '
  + 'Banking-Hinweis (keine Zuordnung): Lastschrift 30.10.2026 −9.422,32 € Geschäftsgiro La Perla GmbH, „527415 DTAUS Rechnung 334364/Nonnenburgstr.24".';

const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

async function main(): Promise<void> {
  if (Math.round((R.netto + R.ust) * 100) !== Math.round(R.brutto * 100)) throw new Error('netto + USt ≠ brutto');
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const s = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      const r = await client.query('DELETE FROM expense_bookings WHERE id = $1 AND source_key = $2', [s.id, SOURCE_KEY]);
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'nk', action: 'buchung_swt_16960.rueckweg', entityType: 'expense_bookings', entityId: String(s.id), before: null, after: { geloescht: r.rowCount }, source: 'cc' });
      console.log(`Rückweg: ${r.rowCount} Buchung entfernt`);
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe, --ausfuehren oder --rueckweg <datei>');
    await client.query('BEGIN');
    const dup = await client.query(
      `SELECT id, source_key, invoice_number, amount_gross FROM expense_bookings
        WHERE invoice_number = $1 OR source_key = $2 OR (property_id = 4 AND amount_gross = $3)`, [R.nr, SOURCE_KEY, R.brutto]);
    if (dup.rows.length) throw new Error(`Duplikat gefunden: ${JSON.stringify(dup.rows)}`);
    console.log('Duplikatprüfung: keine Treffer (Rechnungsnummer, source_key, Betrag N24)');
    const { rows } = await client.query(
      `INSERT INTO expense_bookings (source_key, property_id, cost_category_id, vendor_name, invoice_number, invoice_date,
          service_period_start, service_period_end, amount_gross, amount_net, vat_amount, vat_rate, umlagefaehig,
          maintenance_vs_operating, document_path, notes)
       VALUES ($1, 4, 17, 'Stadtwerke Tuttlingen GmbH', $2, $3, $4, $5, $6, $7, $8, 19, false, 'operating', $9, $10)
       RETURNING id, amount_gross, amount_net, vat_amount, umlagefaehig, service_period_start::text sps, service_period_end::text spe`,
      [SOURCE_KEY, R.nr, R.datum, R.von, R.bis, R.brutto, R.netto, R.ust, R.beleg, NOTIZ]);
    const z = rows[0];
    if (Number(z.amount_gross) !== R.brutto || Number(z.amount_net) !== R.netto || Number(z.vat_amount) !== R.ust || z.umlagefaehig !== false
      || z.sps !== R.von || z.spe !== R.bis) throw new Error(`Rücklesen weicht ab: ${JSON.stringify(z)}`);
    console.log(`${R.nr} → Buchung ${z.id}: ${z.amount_net} + ${z.vat_amount} = ${z.amount_gross} €, ${z.sps}–${z.spe}, nicht umlagefähig`);
    if (probe) { await client.query('ROLLBACK'); console.log('Probe zurückgerollt'); return; }
    const zeit = new Date().toISOString();
    mkdirSync(SICHERUNG, { recursive: true });
    const datei = path.join(SICHERUNG, `sicherung-${zeit.replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: 'Owner-Freigabe 05.11.2026 11:35', zeit, id: z.id }, null, 1));
    await client.query('COMMIT');
    await audit.log({ actor: AKTOR, module: 'nk', action: 'buchung_swt_16960.angelegt', entityType: 'expense_bookings', entityId: String(z.id),
      before: null, after: { rechnung: R.nr, brutto: R.brutto, netto: R.netto, ust: R.ust, zeitraum: `${R.von}–${R.bis}`, kostenart: 17, umlagefaehig: false, freigabe: 'Freigabe Buchung SWT 16960' }, source: 'cc' });
    console.log(`Ausgeführt. Sicherung: ${datei}\nRückweg: bun run scripts/buchung-swt-16960-20261105.ts --rueckweg ${datei}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => closePool());
