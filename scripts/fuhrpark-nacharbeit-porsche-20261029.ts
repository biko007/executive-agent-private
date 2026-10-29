#!/usr/bin/env bun
/**
 * Owner-Freigabe 29.10.2026 07:57 („Freigabe Fuhrpark Nacharbeit Porsche“), Nacharbeit zu
 * scripts/fuhrpark-porsche-rechnungen-20261029.ts:
 *
 *   1. Kilometerstand im Fahrzeugstamm: FZG-911T 85.600 → 87.193 (28.10.2026), FZG-PANAMERA leer → 50.563
 *      (21.10.2026). Datum und Quelle in source_payload (der Stamm hat keine Datumsspalte).
 *   2. Reifensatz FZG-PANAMERA: Michelin-Sommerreifen aus Rechnung 81045736, eingelagert. removed_at = 26.10.2026,
 *      weil Fuhrpark und Dashboard einen Satz ohne removed_at als montiert anzeigen. Bestehende Sätze für
 *      911/Panamera gibt es nicht (geprüft 29.10.2026), also nichts zu aktualisieren.
 *   3. FIN FZG-911T: „WPO…“ → „WP0…“ laut Rechnung 81045762, mit 17-Stellen-Prüfung (keine I/O/Q).
 *
 *   bun run scripts/fuhrpark-nacharbeit-porsche-20261029.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung ~/backups/fuhrpark-20261029/, Audit nach dem Commit.
 * Report: report-fuhrpark-nacharbeit-porsche-20261029.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'fuhrpark-20261029');
const AKTOR = 'cc-bikosoc';
const QUELLE = 'Owner-Freigabe 29.10.2026 07:57';
const STEMPEL = `[29.10.2026, ${QUELLE}]`;
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

/** Erwarteter Altwert je Feld schützt davor, eine inzwischen geänderte Zeile zu überschreiben. */
const KM = [
  { id: 4, code: 'FZG-911T', alt: 85600, neu: 87193, datum: '2026-10-28', beleg: 'Rechnung 81045762 (Annahme 28.10.2026)' },
  { id: 14, code: 'FZG-PANAMERA', alt: null, neu: 50563, datum: '2026-10-21', beleg: 'Rechnung 81045736 (Annahme 21.10.2026)' },
];
const FIN_911 = { id: 4, alt: 'WPOZZZ99ZHS161351', neu: 'WP0ZZZ99ZHS161351' };
const REIFEN_PANAMERA = {
  vehicle_id: 14, tire_type: 'summer', brand: 'Michelin',
  model: '2× Pilot Sport S 5 275/35 R21 103Y NDO XL + 2× Pilot Sport Cup 2 R 325/30 ZR21 108Y',
  removed_at: '2026-10-26',
  notes: `${STEMPEL} Kauf 26.10.2026, Rechnung 81045736 (641,76 + 869,76 EUR netto), Kostensatz vehicle_service_records 29. Status: EINGELAGERT beim Porsche Zentrum Schwarzwald-Baar, Villingen-Schwenningen (vor Einlagerung auf die Sommerräder montiert und gewuchtet). Nie gefahren; removed_at = Einlagerung, damit der Satz nicht als montiert gilt.`,
};

/** 17 Stellen, nur A–Z ohne I/O/Q und Ziffern (ISO 3779). */
const finGueltig = (fin: string) => /^[A-HJ-NPR-Z0-9]{17}$/.test(fin);

async function main(): Promise<void> {
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const s = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      for (const v of s.fahrzeuge) {
        await client.query('UPDATE vehicles SET current_mileage_km = $1, vin = $2, source_payload = $3, updated_by = $4 WHERE id = $5',
          [v.current_mileage_km, v.vin, v.source_payload, AKTOR, v.id]);
      }
      const r = await client.query('DELETE FROM vehicle_tire_sets WHERE id = ANY($1::bigint[]) AND created_by = $2 RETURNING id', [s.reifen_ids, AKTOR]);
      if (r.rowCount !== s.reifen_ids.length) throw new Error('Rückweg: Reifensatz nicht gefunden, nichts geändert');
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'fleet', action: 'nacharbeit_porsche_20261029.rueckweg', entityType: 'vehicle',
        entityId: s.fahrzeuge.map((v: any) => v.vehicle_code).join(','), before: s, source: QUELLE });
      console.log('Rückweg ausgeführt: Fahrzeuge zurückgesetzt, Reifensatz', s.reifen_ids.join(','), 'gelöscht');
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe | --ausfuehren | --rueckweg <datei>');
    if (!finGueltig(FIN_911.neu) || finGueltig(FIN_911.alt)) throw new Error('FIN-Prüfung widerspricht der Erwartung');

    await client.query('BEGIN');
    const vorher = (await client.query(
      'SELECT id, vehicle_code, current_mileage_km, vin, source_payload FROM vehicles WHERE id IN (4, 14) ORDER BY id FOR UPDATE')).rows;
    const auditListe: Parameters<typeof audit.log>[0][] = [];

    for (const k of KM) {
      const v = vorher.find((x) => Number(x.id) === k.id)!;
      if (v.vehicle_code !== k.code || v.current_mileage_km !== k.alt) throw new Error(`Km-Altwert passt nicht: ${k.code} ${v.current_mileage_km}`);
      const payload = { ...(v.source_payload ?? {}), km_stand_datum: k.datum, km_stand_quelle: k.beleg };
      const neuVin = k.id === FIN_911.id ? FIN_911.neu : v.vin;
      if (k.id === FIN_911.id && v.vin !== FIN_911.alt) throw new Error(`FIN-Altwert passt nicht: ${v.vin}`);
      const u = await client.query(
        `UPDATE vehicles SET current_mileage_km = $1, vin = $2, source_payload = $3, updated_by = $4 WHERE id = $5
         RETURNING id, vehicle_code, current_mileage_km, vin, source_payload`,
        [k.neu, neuVin, payload, AKTOR, k.id]);
      auditListe.push({ actor: AKTOR, module: 'fleet', action: 'vehicle.update', entityType: 'vehicle', entityId: k.code,
        before: v, after: u.rows[0], source: QUELLE });
      console.log(`${k.code}: km ${k.alt ?? 'leer'} → ${k.neu} (${k.datum})${k.id === FIN_911.id ? `, FIN ${FIN_911.alt} → ${FIN_911.neu}` : ''}`);
    }

    const da = await client.query('SELECT id FROM vehicle_tire_sets WHERE vehicle_id IN (4, 14)');
    if (da.rowCount) throw new Error(`Reifensätze vorhanden (${da.rows.map((r) => r.id).join(',')}): erst prüfen, nicht doppelt anlegen`);
    const t = await client.query(
      `INSERT INTO vehicle_tire_sets (vehicle_id, tire_type, brand, model, removed_at, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
      [REIFEN_PANAMERA.vehicle_id, REIFEN_PANAMERA.tire_type, REIFEN_PANAMERA.brand, REIFEN_PANAMERA.model,
        REIFEN_PANAMERA.removed_at, REIFEN_PANAMERA.notes, AKTOR]);
    const reifen_ids = [t.rows[0].id];
    auditListe.push({ actor: AKTOR, module: 'fleet', action: 'tire_set.create', entityType: 'tire_set', entityId: 'FZG-PANAMERA',
      after: t.rows[0], source: QUELLE });
    console.log(`Reifensatz FZG-PANAMERA: id ${t.rows[0].id}, Sommer Michelin, eingelagert`);

    if (probe) { await client.query('ROLLBACK'); console.log('Probe zurückgerollt'); return; }
    await client.query('COMMIT');
    for (const a of auditListe) await audit.log(a);
    mkdirSync(SICHERUNG, { recursive: true });
    const zeit = new Date().toISOString();
    const datei = path.join(SICHERUNG, `nacharbeit-${zeit.replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: QUELLE, zeit, fahrzeuge: vorher, reifen_ids }, null, 1));
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
