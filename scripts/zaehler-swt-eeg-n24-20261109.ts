#!/usr/bin/env bun
/**
 * Owner-Freigabe 09.11.2026 13:45 („Freigabe Buchung SWT-EEG-N24-2025 ohne Gutschrift"),
 * Grundlage report-nk-swt-eeg-abrechnung-n24-20261109-1044.md, Teil B Abschnitt 5 b).
 *
 * Freigegeben ist NUR:
 *  1. neuer Zähler N24 „1MCS0010125165 2.8.0 Einspeisung" (Strom, Zweck einspeisung,
 *     übergeordnet Zähler 79, kein Hauptzähler),
 *  2. drei Ablesungen dieses Zählers (Faktor 50) zum 31.12.2023/2024/2025,
 *  3. Zähler 81, Ablesung 578: Vermerk „SWT: 497,168".
 * KEINE Gutschrift in expense_bookings, kein zahlungenZuordnen.
 *
 *   bun run scripts/zaehler-swt-eeg-n24-20261109.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung ~/backups/zaehler-swt-eeg-n24-20261109/.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'zaehler-swt-eeg-n24-20261109');
const AKTOR = 'cc-bikosoc';
const N24 = 4;
const PARENT = 79;
const NUMMER = '1MCS0010125165 2.8.0 Einspeisung';
const VORSPANN = '[09.11.2026, Owner-Freigabe 09.11.2026 13:45]';
const BELEG = '/Austausch/belege-nk2025/N24/2026-11-09_N24_SWT-EEG-Abrechnung-2025_0001-ARV-2026-170659.pdf';
const FAKTOR = 50;

const ZAEHLER_NOTIZ = `${VORSPANN} EINSPEISUNG 2.8.0 der Übergabemessung 1MCS0010125165 (Zähler 79), eigene Registerreihe, `
  + `Wandlerfaktor 50, Werte in kWh (Registerstand × 50). Zählpunkt DE000642785320008406076024000S002, OBIS 1-1:2.8.0. `
  + `EEG-Einspeisevergütung über Stadtwerke Tuttlingen Kd 580080-348474, Vertrag 194625, La Perla GmbH, nicht umlagefähig. `
  + `Anlage 28,35 kWp, Inbetriebnahme 01.06.2023 (laut SWT). Die SWT rechnet 2025 ab Anfangsstand 164,500 statt 159,458 `
  + `(Ausgleich zur Pauschale 7.500 kWh 2024). Grundlage report-nk-swt-eeg-abrechnung-n24-20261109-1044.md.`;

interface Ablesung { stichtag: string; register: number; leser: string; dokument: string | null; referenz: string | null; notiz: string }
const ABLESUNGEN: Ablesung[] = [
  { stichtag: '2023-12-31', register: 14.5, leser: 'SWT (Gutschrift 2023)', dokument: null, referenz: 'SWT-Gutschrift 2023',
    notiz: `${VORSPANN} Registerstand 14,500 × 50 = 725,00 kWh laut SWT-Gutschrift 2023. Abweichend nennt die Notiz zu Zähler 79 (energiekonzept) 5,03 = 251,5 kWh.` },
  { stichtag: '2024-12-31', register: 159.458, leser: 'energiekonzept (EnergyPortal)', dokument: 'EnergyPortal energiekonzept N24, abgerufen 13.10.2026', referenz: null,
    notiz: `${VORSPANN} Registerstand 159,458 × 50 = 7.972,90 kWh laut energiekonzept. SWT rechnet mit 164,500 (Gutschrift 2025).` },
  { stichtag: '2025-12-31', register: 319.783, leser: 'energiekonzept + SWT', dokument: BELEG, referenz: '0001-ARV-2026-170659',
    notiz: `${VORSPANN} Registerstand 319,783 × 50 = 15.989,15 kWh, energiekonzept und SWT-Gutschrift 0001-ARV-2026-170659 übereinstimmend (Ablesung Kunde).` },
];
const VERMERK_578 = ` ${VORSPANN} SWT: 497,168 (Gutschrift 0001-ARV-2026-170659, Zählerstand 31.12.2024).`;

const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

async function main(): Promise<void> {
  const kwh = ABLESUNGEN.map((a) => Math.round(a.register * FAKTOR * 1000) / 1000);
  if (kwh.join('|') !== '725|7972.9|15989.15') throw new Error(`kWh weichen von der Freigabe ab: ${kwh}`);

  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const s = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      const r1 = await client.query('DELETE FROM meter_readings WHERE id = ANY($1) AND meter_id = $2', [s.ablesungen, s.zaehler]);
      const r2 = await client.query('DELETE FROM meters WHERE id = $1 AND meter_number = $2', [s.zaehler, NUMMER]);
      await client.query('UPDATE meter_readings SET notes = $1 WHERE id = 578', [s.vorher578.notes]);
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'nk', action: 'swt_eeg_n24_20261109.rueckweg', entityType: 'meters', entityId: String(s.zaehler),
        before: null, after: { ablesungen_geloescht: r1.rowCount, zaehler_geloescht: r2.rowCount, notiz_578: 'wiederhergestellt' }, source: 'cc' });
      console.log(`Rückweg: ${r1.rowCount} Ablesungen, ${r2.rowCount} Zähler entfernt, Notiz 578 wiederhergestellt`);
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe, --ausfuehren oder --rueckweg <datei>');

    await client.query('BEGIN');
    const dup = await client.query(`SELECT id FROM meters WHERE meter_number = $1 OR (parent_meter_id = $2 AND submetering_purpose = 'einspeisung')`, [NUMMER, PARENT]);
    if (dup.rows.length) throw new Error(`Zähler existiert schon: ${JSON.stringify(dup.rows)}`);
    const eltern = await client.query('SELECT id, property_id, meter_number FROM meters WHERE id = $1', [PARENT]);
    if (eltern.rows[0]?.property_id !== N24 || eltern.rows[0]?.meter_number !== '1MCS0010125165') throw new Error('Zähler 79 passt nicht');
    const v578 = (await client.query('SELECT id, meter_id, value, notes FROM meter_readings WHERE id = 578')).rows[0];
    if (!v578 || v578.meter_id !== 81) throw new Error('Ablesung 578 gehört nicht zu Zähler 81');
    if (String(v578.notes ?? '').includes('SWT: 497,168')) throw new Error('Vermerk 578 schon vorhanden');

    const m = await client.query(
      `INSERT INTO meters (scope_type, property_id, medium, meter_number, is_main_meter, parent_meter_id, submetering_purpose, notes, active)
       VALUES ('property', $1, 'electricity', $2, false, $3, 'einspeisung', $4, true) RETURNING *`,
      [N24, NUMMER, PARENT, ZAEHLER_NOTIZ]);
    const zaehler = m.rows[0].id as number;
    const ids: number[] = [];
    for (const [i, a] of ABLESUNGEN.entries()) {
      const r = await client.query(
        `INSERT INTO meter_readings (meter_id, value, unit, reading_type, read_at, source, reader_name, document_path, source_reference, notes, is_estimated)
         VALUES ($1, $2, 'kWh', 'annual', $3, 'manual', $4, $5, $6, $7, false) RETURNING id`,
        [zaehler, kwh[i], `${a.stichtag}T00:00:00Z`, a.leser, a.dokument, a.referenz, a.notiz]);
      ids.push(r.rows[0].id);
    }
    const n578 = String(v578.notes ?? '') + VERMERK_578;
    await client.query('UPDATE meter_readings SET notes = $1 WHERE id = 578', [n578]);

    const nachher = (await client.query('SELECT id, value, read_at, notes FROM meter_readings WHERE meter_id = $1 ORDER BY read_at', [zaehler])).rows;
    console.log(JSON.stringify({ modus: probe ? 'probe' : 'ausfuehren', zaehler, ablesungen: ids, werte: nachher.map((r) => [r.id, r.value, r.read_at]) }));

    if (probe) { await client.query('ROLLBACK'); console.log('Probe: ROLLBACK'); return; }

    mkdirSync(SICHERUNG, { recursive: true });
    const datei = path.join(SICHERUNG, `sicherung-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ zaehler, ablesungen: ids, vorher578: v578 }, null, 2));
    await client.query('COMMIT');
    console.log(`COMMIT · Sicherung ${datei}`);

    await audit.log({ actor: AKTOR, module: 'nk', action: 'swt_eeg_n24_20261109.zaehler_angelegt', entityType: 'meters', entityId: String(zaehler), before: null,
      after: { freigabe: 'SWT-EEG-N24-2025 ohne Gutschrift', property: 'N24', medium: 'electricity', meter_number: NUMMER, parent_meter_id: PARENT,
        is_main_meter: false, submetering_purpose: 'einspeisung', ablesungen: ids, kwh }, source: 'cc' });
    await audit.log({ actor: AKTOR, module: 'nk', action: 'swt_eeg_n24_20261109.ablesung_notiz', entityType: 'meter_readings', entityId: '578',
      before: { notiz_ende: String(v578.notes ?? '').slice(-80) }, after: { ergaenzt: VERMERK_578.trim() }, source: 'cc' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
