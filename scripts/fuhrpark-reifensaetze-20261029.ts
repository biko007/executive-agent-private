#!/usr/bin/env bun
/**
 * Owner-Freigabe 29.10.2026 13:52 („Freigabe Fuhrpark Reifensätze Winter 911 Panamera“), Folge zu
 * scripts/fuhrpark-nacharbeit-porsche-20261029.ts. Legt genau drei Reifensätze an:
 *
 *   1. FZG-911T Winter, montiert 28.10.2026 (Rechnung 81045762), removed_at leer = montiert.
 *   2. FZG-911T Sommer, am 28.10.2026 gereinigt und eingelagert beim Porsche Zentrum Schwarzwald-Baar.
 *   3. FZG-PANAMERA Winter, montiert 26.10.2026 (Rechnung 81045736), removed_at leer.
 *
 * Marke, Modell und Dimension nennen beide Rechnungen für diese Räder nicht, deshalb bleiben brand/model leer.
 * Km-Stand und Lagerort haben keine eigene Spalte und stehen in der Notiz.
 * Doppelschutz: Abbruch, wenn das Fahrzeug schon einen Satz gleichen Typs hat; Reifensatz 3 (Panamera Sommer)
 * wird vor und nach dem Schreiben verglichen und darf sich nicht ändern.
 *
 *   bun run scripts/fuhrpark-reifensaetze-20261029.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung ~/backups/fuhrpark-20261029/, Audit nach dem Commit.
 * Report: report-fuhrpark-reifensaetze-20261029.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'fuhrpark-20261029');
const AKTOR = 'cc-bikosoc';
const QUELLE = 'Owner-Freigabe 29.10.2026 13:52';
const STEMPEL = `[29.10.2026, ${QUELLE}]`;
const LAGER = 'Porsche Zentrum Schwarzwald-Baar, Villingen-Schwenningen';
const BESTAND_ID = 3;
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

const SAETZE = [
  {
    vehicle_id: 4, code: 'FZG-911T', tire_type: 'winter', installed_at: '2026-10-28', removed_at: null,
    notes: `${STEMPEL} Status: MONTIERT am 28.10.2026, Km-Stand 87.193 (Annahme 28.10.2026), Rechnung 81045762 Pos. 2 „Winterräder montiert“, Kostensatz vehicle_service_records 28. Marke/Modell/Dimension nicht auf der Rechnung.`,
  },
  {
    vehicle_id: 4, code: 'FZG-911T', tire_type: 'summer', installed_at: null, removed_at: '2026-10-28',
    notes: `${STEMPEL} Status: EINGELAGERT beim ${LAGER} seit 28.10.2026 (Rechnung 81045762 Pos. 4 „Sommerräder gereinigt und eingelagert“, Einlagerung Wintersaison), Kostensatz vehicle_service_records 28. Marke/Modell/Dimension nicht auf der Rechnung; Montagedatum nicht belegt.`,
  },
  {
    vehicle_id: 14, code: 'FZG-PANAMERA', tire_type: 'winter', installed_at: '2026-10-26', removed_at: null,
    notes: `${STEMPEL} Status: MONTIERT am 26.10.2026 (Leistungsdatum), Km-Stand 50.563 (Annahme 21.10.2026), Rechnung 81045736 Pos. 1 „Winterräder montiert“, Kostensatz vehicle_service_records 29. Marke/Modell/Dimension nicht auf der Rechnung.`,
  },
];

async function main(): Promise<void> {
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const s = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      const r = await client.query('DELETE FROM vehicle_tire_sets WHERE id = ANY($1::bigint[]) AND created_by = $2 RETURNING id', [s.reifen_ids, AKTOR]);
      if (r.rowCount !== s.reifen_ids.length) throw new Error('Rückweg: nicht alle Reifensätze gefunden, nichts geändert');
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'fleet', action: 'reifensaetze_20261029.rueckweg', entityType: 'tire_set',
        entityId: s.reifen_ids.join(','), before: s, source: QUELLE });
      console.log('Rückweg ausgeführt: Reifensätze', s.reifen_ids.join(','), 'gelöscht');
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe | --ausfuehren | --rueckweg <datei>');

    await client.query('BEGIN');
    await client.query('LOCK TABLE vehicle_tire_sets IN SHARE ROW EXCLUSIVE MODE');
    const bestandVorher = (await client.query('SELECT * FROM vehicle_tire_sets WHERE id = $1', [BESTAND_ID])).rows[0];
    if (!bestandVorher || Number(bestandVorher.vehicle_id) !== 14 || bestandVorher.tire_type !== 'summer') {
      throw new Error('Reifensatz 3 nicht wie erwartet (Panamera Sommer)');
    }
    const auditListe: Parameters<typeof audit.log>[0][] = [];
    const reifen_ids: string[] = [];

    for (const s of SAETZE) {
      const da = await client.query('SELECT id FROM vehicle_tire_sets WHERE vehicle_id = $1 AND tire_type = $2', [s.vehicle_id, s.tire_type]);
      if (da.rowCount) throw new Error(`${s.code} hat schon einen Satz ${s.tire_type} (${da.rows.map((r) => r.id).join(',')}): Abbruch`);
      const t = await client.query(
        `INSERT INTO vehicle_tire_sets (vehicle_id, tire_type, installed_at, removed_at, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
        [s.vehicle_id, s.tire_type, s.installed_at, s.removed_at, s.notes, AKTOR]);
      reifen_ids.push(t.rows[0].id);
      auditListe.push({ actor: AKTOR, module: 'fleet', action: 'tire_set.create', entityType: 'tire_set', entityId: s.code,
        after: t.rows[0], source: QUELLE });
      console.log(`${s.code}: id ${t.rows[0].id}, ${s.tire_type}, ${s.removed_at ? 'eingelagert' : 'montiert'}`);
    }

    const bestandNachher = (await client.query('SELECT * FROM vehicle_tire_sets WHERE id = $1', [BESTAND_ID])).rows[0];
    if (JSON.stringify(bestandNachher) !== JSON.stringify(bestandVorher)) throw new Error('Reifensatz 3 hat sich verändert: Abbruch');

    if (probe) { await client.query('ROLLBACK'); console.log('Probe zurückgerollt'); return; }
    await client.query('COMMIT');
    for (const a of auditListe) await audit.log(a);
    mkdirSync(SICHERUNG, { recursive: true });
    const zeit = new Date().toISOString();
    const datei = path.join(SICHERUNG, `reifensaetze-${zeit.replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: QUELLE, zeit, bestand_satz_3: bestandVorher, reifen_ids }, null, 1));
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
