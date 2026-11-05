#!/usr/bin/env bun
/**
 * Owner-Freigabe 05.11.2026 11:21 („Freigabe Buchung SWT N24 2026"), Grundlage
 * report-swt-18213-20261105.md Abschnitt 4: sieben SWT-Monatsrechnungen Reststrom der
 * Kundenanlage N24 (Kd 527415-318635, Vertrag 239575), April bis Oktober 2026.
 *
 * Kostenart 17 „Sonstige Betriebskosten", NICHT umlagefähig: Netzbezug der Kundenanlage;
 * die Mieterstromkosten kommen aus der energiekonzept-Abrechnung (Owner-Entscheidung 15.10.2026).
 * Gehört zu 2026, nicht zu NK 2025. 0001-ARV-2026-16960 ist ausdrücklich NICHT enthalten.
 * payment_date bleibt leer: Lastschriften nur als Hinweis im Report, keine Zuordnung (Owner).
 *
 *   bun run scripts/buchung-swt-n24-2026-20261105.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Duplikatprüfung über source_key, Rechnungsnummer und
 * Betrag. Sicherung ~/backups/buchung-swt-n24-2026-20261105/ vor dem Commit.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'buchung-swt-n24-2026-20261105');
const AKTOR = 'cc-bikosoc';
const ORDNER = '/Apps/bikosoc-reports/bikosoc-reports/transfer/SWT-Rechnungen/';
const N24 = 4;
const KOSTENART = 17; // sonstige_betrkv

interface Rechnung { nr: string; datum: string; monat: string; netto: number; ust: number; brutto: number; datei: string }
const RECHNUNGEN: Rechnung[] = [
  { nr: '0001-ARV-2026-16680', datum: '2026-10-01', monat: '2026-04', netto: 334.02, ust: 63.46, brutto: 397.48, datei: 'SWT_2026-10-01_Nonnenburgstr_24_318635_0001-ARV-2026-16680.pdf' },
  { nr: '0001-ARV-2026-16681', datum: '2026-10-01', monat: '2026-05', netto: 169.89, ust: 32.28, brutto: 202.17, datei: 'SWT_2026-10-01_Nonnenburgstr_24_318635_0001-ARV-2026-16681.pdf' },
  { nr: '0001-ARV-2026-16682', datum: '2026-10-01', monat: '2026-06', netto: 109.45, ust: 20.80, brutto: 130.25, datei: 'SWT_2026-10-01_Nonnenburgstr_24_318635_0001-ARV-2026-16682.pdf' },
  { nr: '0001-ARV-2026-16683', datum: '2026-10-01', monat: '2026-07', netto: 107.96, ust: 20.51, brutto: 128.47, datei: 'SWT_2026-10-01_Nonnenburgstr_24_318635_0001-ARV-2026-16683.pdf' },
  { nr: '0001-ARV-2026-16684', datum: '2026-10-01', monat: '2026-08', netto: 176.14, ust: 33.47, brutto: 209.61, datei: 'SWT_2026-10-01_Nonnenburgstr_24_318635_0001-ARV-2026-16684.pdf' },
  { nr: '0001-ARV-2026-16787', datum: '2026-10-06', monat: '2026-09', netto: 201.87, ust: 38.36, brutto: 240.23, datei: 'SWT_2026-10-06_Nonnenburgstr_24_318635_0001-ARV-2026-16787.pdf' },
  { nr: '0001-ARV-2026-18213', datum: '2026-11-03', monat: '2026-10', netto: 444.49, ust: 84.45, brutto: 528.94, datei: 'SWT_2026-11-03_Nonnenburgstr_24_318635_0001-ARV-2026-18213.pdf' },
];

/** Letzter Tag des Monats als JJJJ-MM-TT. */
function monatsEnde(monat: string): string {
  const [j, m] = monat.split('-').map(Number);
  return new Date(Date.UTC(j, m, 0)).toISOString().slice(0, 10);
}

const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

async function main(): Promise<void> {
  /* Summenprobe gegen die Freigabe, bevor irgendetwas geschrieben wird. */
  const summe = (f: keyof Rechnung) => Math.round(RECHNUNGEN.reduce((s, r) => s + (r[f] as number), 0) * 100) / 100;
  if (summe('netto') !== 1543.82 || summe('ust') !== 293.33 || summe('brutto') !== 1837.15) throw new Error('Summen weichen von der Freigabe ab');
  for (const r of RECHNUNGEN) if (Math.round((r.netto + r.ust) * 100) !== Math.round(r.brutto * 100)) throw new Error(`${r.nr}: netto + USt ≠ brutto`);

  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const datei = process.argv[rueckIdx + 1];
      const s = JSON.parse(readFileSync(datei, 'utf-8'));
      await client.query('BEGIN');
      const r = await client.query('DELETE FROM expense_bookings WHERE id = ANY($1) AND source_key LIKE $2', [s.ids, 'n24-2026-swt-ka-reststrom-%']);
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'nk', action: 'buchung_swt_n24_2026.rueckweg', entityType: 'expense_bookings', entityId: s.ids.join(','), before: null, after: { geloescht: r.rowCount }, source: 'cc' });
      console.log(`Rückweg: ${r.rowCount} Buchungen entfernt`);
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe, --ausfuehren oder --rueckweg <datei>');
    await client.query('BEGIN');

    /* Duplikatprüfung: gleiche Rechnungsnummer (auch archiviert) oder gleicher source_key → Abbruch. */
    const dup = await client.query(
      `SELECT id, source_key, invoice_number, amount_gross FROM expense_bookings
        WHERE invoice_number = ANY($1) OR source_key LIKE 'n24-2026-swt-ka-reststrom-%'
           OR (property_id = $2 AND vendor_name ILIKE '%Stadtwerke%' AND amount_gross = ANY($3::numeric[]) AND invoice_date >= '2026-09-01')`,
      [RECHNUNGEN.map(r => r.nr), N24, RECHNUNGEN.map(r => r.brutto)]);
    if (dup.rows.length) throw new Error(`Duplikat gefunden: ${JSON.stringify(dup.rows)}`);
    console.log('Duplikatprüfung: keine Treffer (Rechnungsnummer, source_key, Betrag)');

    const ids: number[] = []; const auditListe: audit.AuditEntry[] = [];
    for (const r of RECHNUNGEN) {
      const von = `${r.monat}-01`; const bis = monatsEnde(r.monat);
      const notiz = `SWT Reststrom Kundenanlage N24, Kd 527415-318635, Vertrag 239575 „SV Jahresleistung", Zähler 1MCS0010125165 (RLM, Faktor 1), Zeitraum ${von.split('-').reverse().join('.')} bis ${bis.split('-').reverse().join('.')}. `
        + 'Nicht umlagefähig: Netzbezug der Kundenanlage; die Mieterstromkosten kommen aus der energiekonzept-Abrechnung (Owner-Entscheidung 15.10.2026). '
        + (r.nr.endsWith('18213') ? 'Enthält Nachberechnung Leistungspreis 01.04.–30.09.2026 auf 17,9 kW (+14,37 € netto). ' : '')
        + 'Gebucht nach Owner-Freigabe 05.11.2026 11:21 („Freigabe Buchung SWT N24 2026"); Zahlung nicht zugeordnet.';
      const { rows } = await client.query(
        `INSERT INTO expense_bookings (source_key, property_id, cost_category_id, vendor_name, invoice_number, invoice_date,
            service_period_start, service_period_end, amount_gross, amount_net, vat_amount, vat_rate, umlagefaehig,
            maintenance_vs_operating, document_path, notes)
         VALUES ($1, $2, $3, 'Stadtwerke Tuttlingen GmbH', $4, $5, $6, $7, $8, $9, $10, 19, false, 'operating', $11, $12)
         RETURNING id, amount_gross, amount_net, vat_amount, invoice_number, document_path`,
        [`n24-2026-swt-ka-reststrom-${r.monat}`, N24, KOSTENART, r.nr, r.datum, von, bis, r.brutto, r.netto, r.ust, ORDNER + r.datei, notiz]);
      const z = rows[0];
      if (Number(z.amount_gross) !== r.brutto || Number(z.amount_net) !== r.netto || Number(z.vat_amount) !== r.ust) throw new Error(`${r.nr}: Rücklesen weicht ab`);
      ids.push(z.id);
      auditListe.push({ actor: AKTOR, module: 'nk', action: 'buchung_swt_n24_2026.angelegt', entityType: 'expense_bookings', entityId: String(z.id),
        before: null, after: { rechnung: r.nr, monat: r.monat, brutto: r.brutto, netto: r.netto, ust: r.ust, kostenart: KOSTENART, umlagefaehig: false, freigabe: 'Freigabe Buchung SWT N24 2026' }, source: 'cc' });
      console.log(`${r.nr}  ${r.monat}  ${r.brutto.toFixed(2)} €  → Buchung ${z.id}`);
    }
    const s = (await client.query('SELECT sum(amount_gross) b, sum(amount_net) n, sum(vat_amount) u FROM expense_bookings WHERE id = ANY($1)', [ids])).rows[0];
    console.log(`Summe zurückgelesen: netto ${s.n} / USt ${s.u} / brutto ${s.b}`);
    if (Number(s.b) !== 1837.15) throw new Error('Summe zurückgelesen ≠ 1.837,15');

    if (probe) { await client.query('ROLLBACK'); console.log('Probe zurückgerollt'); return; }
    const zeit = new Date().toISOString();
    mkdirSync(SICHERUNG, { recursive: true });
    const datei = path.join(SICHERUNG, `sicherung-${zeit.replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: 'Owner-Freigabe 05.11.2026 11:21', zeit, ids }, null, 1));
    await client.query('COMMIT');
    for (const a of auditListe) await audit.log(a);
    console.log(`Ausgeführt. Sicherung: ${datei}\nRückweg: bun run scripts/buchung-swt-n24-2026-20261105.ts --rueckweg ${datei}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => closePool());
