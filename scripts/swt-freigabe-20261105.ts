#!/usr/bin/env bun
/**
 * Owner-Freigabe 05.11.2026 10:33 („Freigabe SWT M1 M2 Z1 W1 W2") zum Report
 * report-swt-portal-abgleich-20261105.md, Abschnitt 6.
 *
 *   M2  Buchungen 17, 18, 19 (MG24, 0001-ARV-2025-32342): Beleg verknüpfen, Beträge unverändert
 *   M1  Buchungen 21–25 (MG24, 0001-ARV-2026-8728): Beleg verknüpfen, Beträge unverändert
 *   Z1  Zähler 79 (1MCS0010125165): nur Notiz zu den Portal-Monatswerten 10/2026, kein Zählerstand
 *   W2  Neuzähler 8ZRI0012230358 (N24 Wasser, Nachfolger von Zähler 54): anlegen, Einbaustand 0 am
 *       24.03.2026, Ablesung 371,977 m³ am 27.10.2026 (SWT-Portal)
 *
 * W1 ist bewusst NICHT enthalten: Der Wert 912,495 der Ablesung 408 ist die Owner-Entscheidung E3
 * vom 27.10.2026 (Schätzprotokoll), nicht eine eigene Schätzung, wie der Report vom 05.11. es
 * darstellte. Er wird erst nach erneuter Entscheidung geändert.
 *
 * W2 legt den Zähler mit is_main_meter = false an: Hauptzähler-Nenner N24 bleibt Zähler 54 bzw.
 * die SWT-Abrechnungsmenge (Zähler 104); NK 2025 bleibt unverändert. Die Umstellung für NK 2026
 * gehört zur Frist 20 (Jahresablesung 31.12.2026).
 *
 *   bun run scripts/swt-freigabe-20261105.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung ~/backups/swt-freigabe-20261105/ (vor dem Commit).
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'swt-freigabe-20261105');
const AKTOR = 'cc-bikosoc';
const QUELLE = 'Owner-Freigabe 05.11.2026 10:33';
const STEMPEL = '[05.11.2026, Owner-Freigabe 05.11.2026 10:33]';
const ORDNER = '/Apps/bikosoc-reports/bikosoc-reports/transfer/SWT-Rechnungen/';
const BELEG = {
  M2: { ids: [17, 18, 19], rechnung: '0001-ARV-2025-32342', datei: ORDNER + 'SWT_2026-02-18_Marktgasse_24_307008_0001-ARV-2025-32342.pdf' },
  M1: { ids: [21, 22, 23, 24, 25], rechnung: '0001-ARV-2026-8728', datei: ORDNER + 'SWT_2026-06-10_Marktgasse_24_348661_0001-ARV-2026-8728.pdf' },
} as const;
const Z1_NOTIZ = 'Portal 31.10.2026: Monatswerte 10/2026 HT 773,421 kWh, NT 590,416 kWh, Leistung 17,9 kW, Faktor 1 laut Monatsrechnungen (z. B. 0001-ARV-2026-16787). Kein Zählerstand erfasst: Die Werte sind Monatsmengen ab 0, keine fortlaufenden Registerstände (vgl. 31.12.2025 = 858,265 × 50). Die Angabe „Wandler 50" aus dem Portal-Befund widerspricht den Monatsrechnungen (Zählerfaktor 1).';
const W2 = {
  nummer: '8ZRI0012230358',
  notiz: 'NACHFOLGER des Hauptwasserzählers 8AXI1005533567 (Messstelle N24-LS01-GEMEINDEWASSER, Zähler 54). Eingebaut am 24.03.2026 bei 0,000 m³. SWT Kd 492014, Rechnungseinheit 378953, Vertrag 228819 ab 01.01.2026. is_main_meter bewusst false: Für NK 2025 bleibt der Nenner die SWT-Abrechnungsmenge (Zähler 104); für NK 2026 gilt Altzähler bis zum Ausbau + dieser Zähler ab 24.03.2026 – Umstellung mit Frist 20 (Jahresablesung 31.12.2026). OFFEN: Endstand des Altzählers beim Ausbau.',
  einbau: '2026-03-24',
  ablesung: { wert: 371.977, datum: '2026-10-27' },
};

const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

async function main(): Promise<void> {
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const datei = process.argv[rueckIdx + 1];
      const s = JSON.parse(readFileSync(datei, 'utf-8'));
      await client.query('BEGIN');
      for (const b of s.vorher.buchungen) await client.query('UPDATE expense_bookings SET document_path = $2, notes = $3 WHERE id = $1', [b.id, b.document_path, b.notes]);
      for (const m of s.vorher.zaehler) await client.query('UPDATE meters SET notes = $2 WHERE id = $1', [m.id, m.notes]);
      if (s.neu?.ablesungen?.length) await client.query('DELETE FROM meter_readings WHERE id = ANY($1)', [s.neu.ablesungen]);
      if (s.neu?.zaehler) await client.query('DELETE FROM meters WHERE id = $1', [s.neu.zaehler]);
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'nk', action: 'swt_freigabe_20261105.rueckweg', entityType: 'expense_bookings', entityId: path.basename(datei), before: null, after: { neu: s.neu }, source: 'cc' });
      console.log('Rückweg ausgeführt.');
      return;
    }
    /* Nachsteuerung W2 (05.11.2026): Die NK-Vorprüfung lädt alle aktiven Zähler ohne Blick auf
       das Einbaudatum. Ein aktiver Neuzähler (Einbau 2026) erzeugte in N24 2025 zwei neue
       Warnungen (MISSING_ANNUAL_READING, MISSING_PERIOD_START_READING). Damit NK 2025 unverändert
       bleibt, ruht er bis zur Umstellung NK 2026 (Frist 20). Zurück: active = true. */
    if (process.argv.includes('--w2-ruhen')) {
      await client.query('BEGIN');
      const z = (await client.query("SELECT id, active, notes FROM meters WHERE meter_number = $1 FOR UPDATE", [W2.nummer])).rows[0];
      if (!z) throw new Error('W2-ruhen: Zähler fehlt');
      const notiz = 'active = false bis zur Umstellung NK 2026 (Frist 20): Die NK-Vorprüfung 2025 würde den 2026 eingebauten Zähler sonst als fehlende Ablesung melden. Bei Umstellung active = true und is_main_meter prüfen.';
      await client.query('UPDATE meters SET active = false, notes = $2 WHERE id = $1', [z.id, `${z.notes}\n\n${STEMPEL} ${notiz}`]);
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'nk', action: 'swt_freigabe_20261105.zaehler_ruht', entityType: 'meters', entityId: String(z.id), before: { active: z.active }, after: { active: false, grund: notiz }, source: 'cc' });
      console.log(`W2 Zähler ${z.id}: active ${z.active} → false`);
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe, --ausfuehren, --w2-ruhen oder --rueckweg <datei>');
    await client.query('BEGIN');
    const auditListe: audit.AuditEntry[] = [];
    const vorher = { buchungen: [] as any[], zaehler: [] as any[] };

    /* M1, M2: Beleg verknüpfen. */
    for (const [schritt, b] of Object.entries(BELEG)) {
      const { rows } = await client.query(
        'SELECT id, invoice_number, amount_gross, document_path, notes FROM expense_bookings WHERE id = ANY($1) ORDER BY id FOR UPDATE', [b.ids]);
      if (rows.length !== b.ids.length) throw new Error(`${schritt}: ${rows.length} von ${b.ids.length} Buchungen gefunden`);
      for (const z of rows) {
        if (z.invoice_number !== b.rechnung) throw new Error(`${schritt}: Buchung ${z.id} trägt ${z.invoice_number}, erwartet ${b.rechnung}`);
        if (z.document_path) throw new Error(`${schritt}: Buchung ${z.id} hat schon einen Beleg (${z.document_path})`);
        vorher.buchungen.push(z);
        const notes = `${z.notes ? z.notes + '\n\n' : ''}${STEMPEL} Beleg verknüpft: ${b.datei} (Freigabe SWT ${schritt}). Betrag unverändert.`;
        await client.query('UPDATE expense_bookings SET document_path = $2, notes = $3 WHERE id = $1', [z.id, b.datei, notes]);
        const n = (await client.query('SELECT amount_gross, document_path FROM expense_bookings WHERE id = $1', [z.id])).rows[0];
        if (n.amount_gross !== z.amount_gross || n.document_path !== b.datei) throw new Error(`${schritt}: Rücklesen Buchung ${z.id} fehlgeschlagen`);
        auditListe.push({ actor: AKTOR, module: 'nk', action: 'swt_freigabe_20261105.beleg_verknuepft', entityType: 'expense_bookings', entityId: String(z.id),
          before: { document_path: null }, after: { document_path: b.datei, freigabe: `SWT ${schritt}` }, source: 'cc' });
        console.log(`${schritt} Buchung ${z.id} (${z.amount_gross} €): Beleg verknüpft`);
      }
    }

    /* Z1: nur Notiz an Zähler 79. */
    const z79 = (await client.query("SELECT id, meter_number, notes FROM meters WHERE id = 79 FOR UPDATE")).rows[0];
    if (z79?.meter_number !== '1MCS0010125165') throw new Error('Z1: Zähler 79 ist nicht 1MCS0010125165');
    if (String(z79.notes ?? '').includes('Portal 31.10.2026: Monatswerte 10/2026')) throw new Error('Z1: Notiz steht schon da');
    vorher.zaehler.push({ id: 79, notes: z79.notes });
    await client.query('UPDATE meters SET notes = $2 WHERE id = $1', [79, `${z79.notes ? z79.notes + '\n\n' : ''}${STEMPEL} ${Z1_NOTIZ}`]);
    auditListe.push({ actor: AKTOR, module: 'nk', action: 'swt_freigabe_20261105.zaehler_notiz', entityType: 'meters', entityId: '79', before: null, after: { notiz: Z1_NOTIZ, freigabe: 'SWT Z1' }, source: 'cc' });
    console.log('Z1 Zähler 79: Notiz ergänzt, keine Ablesung');

    /* W2: Neuzähler anlegen, zwei Ablesungen, Querverweis an Zähler 54. */
    const da = (await client.query('SELECT id FROM meters WHERE meter_number = $1', [W2.nummer])).rows;
    if (da.length) throw new Error(`W2: Zähler ${W2.nummer} existiert schon (id ${da[0].id})`);
    const z54 = (await client.query("SELECT id, property_id, meter_number, notes FROM meters WHERE id = 54 FOR UPDATE")).rows[0];
    if (z54?.meter_number !== 'N24-LS01-GEMEINDEWASSER' || z54.property_id !== 4) throw new Error('W2: Zähler 54 ist nicht N24-LS01-GEMEINDEWASSER');
    const neu = (await client.query(
      `INSERT INTO meters (scope_type, property_id, medium, meter_number, provider, installed_at, is_main_meter, initial_reading, notes, active)
       VALUES ('property', 4, 'cold_water', $1, 'Stadtwerke Tuttlingen GmbH', $2, false, 0, $3, true) RETURNING id`,
      [W2.nummer, W2.einbau, `${STEMPEL} ${W2.notiz}`])).rows[0].id as number;
    const r0 = (await client.query(
      `INSERT INTO meter_readings (meter_id, value, unit, reading_type, read_at, source, reader_name, notes, is_estimated)
       VALUES ($1, 0, 'm3', 'meter_reset', $2, 'manual', 'SWT-Kundenportal', $3, false) RETURNING id`,
      [neu, W2.einbau, `${STEMPEL} Einbaustand 0,000 m³ am 24.03.2026 laut SWT-Kundenportal (Befund Chat 28.10. und 05.11.2026).`])).rows[0].id as number;
    const r1 = (await client.query(
      `INSERT INTO meter_readings (meter_id, value, unit, reading_type, read_at, source, reader_name, notes, is_estimated)
       VALUES ($1, $2, 'm3', 'interim', $3, 'manual', 'SWT-Kundenportal', $4, false) RETURNING id`,
      [neu, W2.ablesung.wert, W2.ablesung.datum, `${STEMPEL} Stand 371,977 m³ am 27.10.2026 laut SWT-Kundenportal (Befund Chat 05.11.2026). Ablesekennzeichen im Portal-Befund nicht genannt.`])).rows[0].id as number;
    vorher.zaehler.push({ id: 54, notes: z54.notes });
    await client.query('UPDATE meters SET notes = $2 WHERE id = $1', [54, `${z54.notes ? z54.notes + '\n\n' : ''}${STEMPEL} Nachfolger-Zähler ${W2.nummer} als eigener Zähler angelegt (id ${neu}, Einbau 24.03.2026 bei 0, Stand 371,977 m³ am 27.10.2026). Dieser Eintrag bleibt Nenner für NK 2025.`]);
    auditListe.push({ actor: AKTOR, module: 'nk', action: 'swt_freigabe_20261105.zaehler_angelegt', entityType: 'meters', entityId: String(neu),
      before: null, after: { meter_number: W2.nummer, property: 'N24', medium: 'cold_water', installed_at: W2.einbau, is_main_meter: false, ablesungen: [r0, r1], freigabe: 'SWT W2' }, source: 'cc' });
    console.log(`W2 Zähler ${W2.nummer} angelegt (id ${neu}), Ablesungen ${r0} (0 am 24.03.2026), ${r1} (371,977 am 27.10.2026)`);

    if (probe) { await client.query('ROLLBACK'); console.log('Probe zurückgerollt'); return; }
    const zeit = new Date().toISOString();
    mkdirSync(SICHERUNG, { recursive: true });
    const datei = path.join(SICHERUNG, `sicherung-${zeit.replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: QUELLE, zeit, vorher, neu: { zaehler: neu, ablesungen: [r0, r1] } }, null, 1));
    await client.query('COMMIT');
    for (const a of auditListe) await audit.log(a);
    console.log(`Ausgeführt. Sicherung: ${datei}\nRückweg: bun run scripts/swt-freigabe-20261105.ts --rueckweg ${datei}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => closePool());
