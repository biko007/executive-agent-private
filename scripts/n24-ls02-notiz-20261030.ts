#!/usr/bin/env bun
/**
 * N24 Liegenschaftszähler 02 (Auftrag Owner 27.10.2026 14:18, ausgeführt 30.10.2026):
 * Owner-Feststellung „Zähler sitzt in der Wärmepumpe, WP-Tausch 05.03.2025" als Notiz an meters 55.
 * Nur das Notizfeld — keine Beträge, keine Schlüssel, keine Stände.
 *
 *   bun run scripts/n24-ls02-notiz-20261030.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung ~/backups/n24-ls02-20261030/, Audit nach dem Commit.
 * Report: report-n24-ls02-notiz-20261027.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'n24-ls02-20261030');
const AKTOR = 'cc-bikosoc';
const QUELLE = 'Owner-Feststellung 27.10.2026 14:18';
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

const LS02 = 'Der Liegenschafts-Wärmezähler (Casameta Liegenschaftszähler 02, Gesamt-WMZ Heizung + Warmwasser) sitzt INNERHALB der Wärmepumpe. Die Wärmepumpe wurde am 05.03.2025 getauscht; für 2025 gibt es deshalb keinen verlässlichen Stand dieses Zählers. Festlegung: Die Einzelzähler der Wohnungen werden addiert und als Gesamtwert angenommen (so in der Probeabrechnung und im Casameta-Eingabeblatt umgesetzt). Annahme: Summe Wohnungszähler; gilt ab 2025, bis ein neuer Gesamtzähler-Stand belastbar vorliegt (Stand bei WP-Tausch 05.03.2025 = Neubeginn).';

/** Tabelle, id, Notiz. */
const NOTIZEN: { tabelle: 'meters'; id: number; notiz: string }[] = [
  { tabelle: 'meters', id: 55, notiz: LS02 },
];

async function main(): Promise<void> {
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const p = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      for (const v of p.vorher) await client.query(`UPDATE ${v.tabelle} SET notes = $2 WHERE id = $1`, [v.id, v.notes]);
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'nk', action: 'n24_ls02.notiz.rueckweg', entityType: 'meters', entityId: path.basename(process.argv[rueckIdx + 1]), before: null, after: { zeilen: p.vorher.length }, source: 'cc' });
      console.log(`Rückweg: ${p.vorher.length} Notizen zurückgesetzt`);
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe, --ausfuehren oder --rueckweg <datei>');
    await client.query('BEGIN');
    const vorher: any[] = []; const auditListe: any[] = [];
    for (const v of NOTIZEN) {
      const z = (await client.query(`SELECT id, notes FROM ${v.tabelle} WHERE id = $1 FOR UPDATE`, [v.id])).rows[0];
      if (!z) throw new Error(`${v.tabelle} ${v.id} fehlt`);
      vorher.push({ tabelle: v.tabelle, ...z });
      const notes = `${z.notes ? z.notes + '\n\n' : ''}[30.10.2026, ${QUELLE}] ${v.notiz}`;
      await client.query(`UPDATE ${v.tabelle} SET notes = $2, updated_at = now() WHERE id = $1`, [v.id, notes]);
      auditListe.push({ actor: AKTOR, module: 'nk', action: 'n24_ls02.notiz', entityType: v.tabelle, entityId: String(v.id),
        before: null, after: { notiz: v.notiz }, source: 'cc' });
      console.log(`${v.tabelle} ${v.id}: Notiz ergänzt`);
    }
    if (probe) { await client.query('ROLLBACK'); console.log('Probe zurückgerollt'); return; }
    await client.query('COMMIT');
    for (const a of auditListe) await audit.log(a);
    const zeit = new Date().toISOString();
    mkdirSync(SICHERUNG, { recursive: true });
    const datei = path.join(SICHERUNG, `sicherung-${zeit.replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: QUELLE, zeit, vorher }, null, 1));
    console.log(`Ausgeführt. Rückweg: --rueckweg ${datei}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => closePool());
