#!/usr/bin/env bun
/**
 * Owner-Anweisung 29.10.2026 07:29 („zwei neue porsche rechnungen im sharepoint unter Scans …
 * den jeweiligen Fahrzeugen zuordnen"): zwei Werkstattrechnungen Porsche Zentrum Schwarzwald-Baar
 * als Fahrzeugkosten im Fuhrpark, dazu die HU-Fälligkeit des Panamera aus der Rechnung.
 *
 *   81045762 (28.10.2026) → FZG-911T     (TUT-ZZ 3,  FIN …161351)  332,07 EUR
 *   81045736 (26.10.2026) → FZG-PANAMERA (TUT-ZZ 2E, FIN …110567) 2.365,67 EUR, HU/AU 05/2027
 *
 * Kilometerstand nur im Kostensatz; vehicles.current_mileage_km bleibt unverändert (Auftrag:
 * keine anderen Datenänderungen). Kein Bankumsatz bis Datenstand 26.10.2026 → nichts verknüpft.
 *
 *   bun run scripts/fuhrpark-porsche-rechnungen-20261029.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung ~/backups/fuhrpark-20261029/, Audit nach dem Commit.
 * Report: report-porsche-rechnungen-fuhrpark-20261029.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'fuhrpark-20261029');
const AKTOR = 'cc-bikosoc';
const QUELLE = 'Owner-Anweisung 29.10.2026 07:29';
const STEMPEL = `[29.10.2026, ${QUELLE}]`;
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

const WERKSTATT = 'Porsche Zentrum Schwarzwald-Baar (Hahn Sportwagen Reutlingen GmbH), Villingen-Schwenningen';
const OFFEN = 'ZAHLSTATUS OFFEN: Zahlungsziel sofort (bar/EC); kein passender Bankumsatz bis Datenstand 26.10.2026 (Volksbank …0028 bis 23.10.). Frühere Porsche-Zentrum-Rechnung R81043588 lief per Überweisung von Volksbank …0028. Nicht umlagefähig. Rechnung privat adressiert (Herrn Jürgen Bickel); privat/Firma ist im Fuhrpark nicht hinterlegt.';

/** Erwartete Fahrzeuge: Kennzeichen und FIN müssen passen (911: FIN im Fuhrpark mit „O“ statt „0“ erfasst). */
const RECHNUNGEN = [
  {
    code: 'FZG-911T', id: 4, kennzeichen: 'TUT-ZZ 3', fin: /^WP[0O]ZZZ99ZHS161351$/, rechnung: '81045762',
    service_date: '2026-10-28', mileage_km: 87193, service_type: 'Reifenwechsel / Einlagerung', cost: '332.07',
    document_url: 'sharepoint:Scans/2026-10-29_Porsche 911 Lavaorange Winterreifenwechsel.pdf',
    notes: `${STEMPEL} Rechnung 81045762 vom 28.10.2026 (Auftrag 2026002819, Kd. 86677587): Arbeit 253,56 + Material 25,49 = netto 279,05 + 19 % USt 53,02 = 332,07 EUR. Winterräder montiert, 4 Räder gewuchtet, Sommerräder gereinigt und eingelagert, Scheibenklar, 0,5 l Mobil 1 0W-40, Kleinteile. Km 87.193. HU/AU laut Rechnung 03/2028 (Fuhrpark 30.03.2028, unverändert). ${OFFEN}`,
  },
  {
    code: 'FZG-PANAMERA', id: 14, kennzeichen: 'TUT-ZZ 2E', fin: /^WP0ZZZYA5RL110567$/, rechnung: '81045736',
    service_date: '2026-10-26', mileage_km: 50563, service_type: 'Reifen: Sommerreifen neu / Reifenwechsel / Einlagerung', cost: '2365.67',
    document_url: 'sharepoint:Scans/2026-10-29_Porsche Panamer a Sommerreifen und Reifenwechsel .pdf',
    notes: `${STEMPEL} Rechnung 81045736 vom 26.10.2026 (Auftrag 2026002820, Annahme 21.10.2026, Kd. 86677587): Arbeit 468,46 + Material 1.519,50 = netto 1.987,96 + 19 % USt 377,71 = 2.365,67 EUR. Neue Sommerreifen 2× Michelin Pilot Sport S 5 275/35 R21 103Y NDO XL (641,76) und 2× Michelin Pilot Sport Cup 2 R 325/30 ZR21 108Y (869,76), vor Einlagerung montiert und gewuchtet; Winterräder montiert und gewuchtet; Sommerräder gereinigt und eingelagert. Km 50.563. ${OFFEN}`,
  },
];
const HU_PANAMERA = {
  vehicle_id: 14, next_due_date: '2027-05-31',
  document_url: 'sharepoint:Scans/2026-10-29_Porsche Panamer a Sommerreifen und Reifenwechsel .pdf',
  notes: `${STEMPEL} HU/AU fällig 05/2027 laut Porsche-Rechnung 81045736 vom 26.10.2026 (Erstzulassung 31.05.2024); Monatsende als Termin. Keine Untersuchung erfasst, nur die Fälligkeit.`,
};

async function main(): Promise<void> {
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const s = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      const a = await client.query('DELETE FROM vehicle_service_records WHERE id = ANY($1::int[]) AND created_by = $2 RETURNING id', [s.service_ids, AKTOR]);
      const b = await client.query('DELETE FROM vehicle_tuev_records WHERE id = ANY($1::int[]) AND created_by = $2 RETURNING id', [s.tuev_ids, AKTOR]);
      if (a.rowCount !== s.service_ids.length || b.rowCount !== s.tuev_ids.length) throw new Error('Rückweg: Zeilenzahl passt nicht, nichts geändert');
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'fleet', action: 'porsche_20261029.rueckweg', entityType: 'service_record',
        entityId: s.service_ids.join(','), before: s, source: QUELLE });
      console.log('Rückweg ausgeführt:', a.rowCount, 'Kostensätze,', b.rowCount, 'HU-Sätze gelöscht');
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe | --ausfuehren | --rueckweg <datei>');

    await client.query('BEGIN');
    const summe = async () => (await client.query(
      `SELECT vehicle_id, sum(cost)::text s, count(*)::int n FROM vehicle_service_records
        WHERE vehicle_id IN (4, 14) AND service_date >= '2026-01-01' GROUP BY 1 ORDER BY 1`)).rows;
    const vorher = await summe();
    const auditListe: Parameters<typeof audit.log>[0][] = [];
    const service_ids: number[] = [];
    const tuev_ids: number[] = [];

    for (const r of RECHNUNGEN) {
      const v = (await client.query('SELECT id, vehicle_code, license_plate, vin FROM vehicles WHERE vehicle_code = $1', [r.code])).rows[0];
      if (!v || Number(v.id) !== r.id || v.license_plate !== r.kennzeichen || !r.fin.test(v.vin)) throw new Error(`Fahrzeug passt nicht: ${r.code}`);
      const dopp = await client.query(`SELECT id FROM vehicle_service_records WHERE vehicle_id = $1 AND notes LIKE $2`, [r.id, `%Rechnung ${r.rechnung} %`]);
      if (dopp.rowCount) throw new Error(`Rechnung ${r.rechnung} ist schon erfasst (id ${dopp.rows[0].id})`);
      const ins = await client.query(
        `INSERT INTO vehicle_service_records (vehicle_id, service_date, service_type, mileage_km, workshop, cost, notes, document_url, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`,
        [r.id, r.service_date, r.service_type, r.mileage_km, WERKSTATT, r.cost, r.notes, r.document_url, AKTOR]);
      service_ids.push(ins.rows[0].id);
      auditListe.push({ actor: AKTOR, module: 'fleet', action: 'service_record.create', entityType: 'service_record',
        entityId: r.code, after: ins.rows[0], source: QUELLE });
      console.log(`Kosten ${r.code}: id ${ins.rows[0].id}, ${r.cost} EUR, Rechnung ${r.rechnung}`);
    }

    const huDa = await client.query(`SELECT id FROM vehicle_tuev_records WHERE vehicle_id = $1 AND next_due_date = $2`, [HU_PANAMERA.vehicle_id, HU_PANAMERA.next_due_date]);
    if (huDa.rowCount) throw new Error(`HU Panamera schon erfasst (id ${huDa.rows[0].id})`);
    const hu = await client.query(
      `INSERT INTO vehicle_tuev_records (vehicle_id, next_due_date, notes, document_url, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
      [HU_PANAMERA.vehicle_id, HU_PANAMERA.next_due_date, HU_PANAMERA.notes, HU_PANAMERA.document_url, AKTOR]);
    tuev_ids.push(hu.rows[0].id);
    auditListe.push({ actor: AKTOR, module: 'fleet', action: 'tuev_record.create', entityType: 'tuev_record',
      entityId: 'FZG-PANAMERA', after: hu.rows[0], source: QUELLE });
    console.log(`HU Panamera: id ${hu.rows[0].id}, fällig ${HU_PANAMERA.next_due_date}`);

    const km = (await client.query('SELECT vehicle_code, current_mileage_km FROM vehicles WHERE id IN (4, 14) ORDER BY id')).rows;
    console.log('Summe 2026 vorher', JSON.stringify(vorher), '| nachher', JSON.stringify(await summe()), '| km unverändert', JSON.stringify(km));

    if (probe) { await client.query('ROLLBACK'); console.log('Probe zurückgerollt'); return; }
    await client.query('COMMIT');
    for (const a of auditListe) await audit.log(a);
    mkdirSync(SICHERUNG, { recursive: true });
    const zeit = new Date().toISOString();
    const datei = path.join(SICHERUNG, `sicherung-${zeit.replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: QUELLE, zeit, service_ids, tuev_ids, vorher }, null, 1));
    console.log('Ausgeführt. Sicherung:', datei);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await closePool();
  }
}

await main();
