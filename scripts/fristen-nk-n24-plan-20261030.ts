/**
 * Datenskript 30.10.2026: vier Wiedervorlagen N24 für den Abschluss der NK-Abrechnung 2025
 * (Owner-Auftrag 30.10.2026 11:41, Mail an Doris „Stand Mietrückstände und NK N24“).
 *
 *   07.11. Doris: Rückmeldung v5 + Rückstandsfragen            (wartet auf Antwort)
 *   20.11. Entscheidung: energiekonzept-Schätzwerte übernehmen, falls keine Schlussrechnung
 *   21.11. Casameta: Abrechnung N24 2025 erstellen (Owner-Go)
 *   30.11. Versand NK N24 2025 an Mieter
 *
 * Vorlauf je 3 Tage. Die bestehende Frist #31 (energiekonzept, 10.11.) bleibt unberührt.
 *
 *   bun run scripts/fristen-nk-n24-plan-20261030.ts --probe | --ausfuehren | --rueckweg
 *
 * Probe: alles in einer Transaktion, danach ROLLBACK. Rückweg: löscht nur die vier
 * Fristen dieses Skripts, und nur solange sie unbearbeitet sind (Quelle gleich, nicht erledigt).
 */
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const QUELLE = 'Owner-Auftrag 30.10.2026 11:41 (Mail an Doris, NK N24 2025 Plan)';
const AKTOR = 'cc';
const NEU = [
  { termin: '2026-11-07', bezeichnung: 'Doris: Rückmeldung v5 + Rückstandsfragen (wartet auf Antwort)' },
  { termin: '2026-11-20', bezeichnung: 'Entscheidung: energiekonzept-Schätzwerte übernehmen, falls keine Schlussrechnung' },
  { termin: '2026-11-21', bezeichnung: 'Casameta: Abrechnung N24 2025 erstellen (Owner-Go)' },
  { termin: '2026-11-30', bezeichnung: 'Versand NK N24 2025 an Mieter' },
];
const VORLAUF = 3;

async function main(): Promise<void> {
  const probe = process.argv.includes('--probe');
  const ausfuehren = process.argv.includes('--ausfuehren');
  const rueckweg = process.argv.includes('--rueckweg');
  if (!probe && !ausfuehren && !rueckweg) throw new Error('--probe | --ausfuehren | --rueckweg');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows: [obj] } = await client.query(`SELECT id FROM properties WHERE code = 'n24'`);
    if (!obj) throw new Error('Objekt n24 fehlt');

    if (rueckweg) {
      const { rows } = await client.query(
        `DELETE FROM objekt_fristen WHERE quelle = $1 AND erledigt_am IS NULL RETURNING id, termin, bezeichnung`, [QUELLE]);
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'fristen', action: 'fristen_nk_n24_plan_20261030.rueckweg', entityType: 'objekt_frist',
        entityId: rows.map((r: any) => r.id).join(','), before: rows, source: QUELLE });
      console.log('Rückweg: gelöscht', rows.map((r: any) => r.id));
      return;
    }

    const { rows: [dopp] } = await client.query(`SELECT count(*)::int n FROM objekt_fristen WHERE quelle = $1`, [QUELLE]);
    if (dopp.n) throw new Error(`schon angelegt (${dopp.n}) — nichts getan`);
    const angelegt: any[] = [];
    for (const f of NEU) {
      const { rows: [r] } = await client.query(
        `INSERT INTO objekt_fristen (property_id, art, bezeichnung, termin, vorlauf_tage, verantwortlich, quelle, notes)
         VALUES ($1, 'wiedervorlage', $2, $3, $4, 'owner', $5, $6) RETURNING id, termin, bezeichnung, vorlauf_tage`,
        [obj.id, f.bezeichnung, f.termin, VORLAUF, QUELLE,
          'Mail-Bezug: Entwurf an doris.hilsenbeck@bikolino.com vom 30.10.2026 (Antwort auf ihre Mail 28.10. 15:23 UTC), Report report-doris-entwurf-rueckstaende-20261030.md']);
      angelegt.push(r);
    }
    for (const r of angelegt) console.log(probe ? 'PROBE' : 'NEU', r.id, r.termin.toISOString?.().slice(0, 10) ?? r.termin, r.vorlauf_tage, r.bezeichnung);
    if (probe) { await client.query('ROLLBACK'); console.log('Probe: zurückgerollt'); return; }
    await client.query('COMMIT');
    for (const r of angelegt) {
      await audit.log({ actor: AKTOR, module: 'fristen', action: 'frist.angelegt', entityType: 'objekt_frist',
        entityId: String(r.id), after: r, source: QUELLE });
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
