#!/usr/bin/env bun
/**
 * Owner-Freigabe 30.10.2026 11:52 („Freigabe MG24 Grundsteuer 239/4"): MG24 2025, Buchung 80
 * Grundsteuer 905,45 → 1.344,27 EUR (+ 438,82 EUR Flst. 239/4, Bescheid …0005.4 vom 10.01.2025).
 * Grundlage: Mail der Buchhaltung 29.10.2026 08:48 („gehört zur Marktgasse"). Die Notiz
 * „OFFEN: Grundsteuer Flst. 239/4" an Buchung 80 wird geschlossen.
 *
 *   bun run scripts/mg24-grundsteuer-239-4-20261030.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung ~/backups/mg24-grundsteuer-20261030/, Audit nach dem Commit.
 * Report: report-mg24-grundsteuer-eingabeblatt-20261030.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'mg24-grundsteuer-20261030');
const AKTOR = 'cc-bikosoc';
const QUELLE = 'Owner-Freigabe 30.10.2026 11:52 (Freigabe MG24 Grundsteuer 239/4)';
const STEMPEL = `[30.10.2026, ${QUELLE}]`;
const BUCHUNG = 80;
const SOURCE_KEY = 'mg24-2025-grundsteuer';
const ALT = '905.45';
const NEU = '1344.27';
const NOTIZ = 'GESCHLOSSEN – Grundsteuer Flst. 239/4: 905,45 → 1.344,27 EUR. Hinzu kommen 438,82 EUR aus dem Grundsteuerbescheid Flst. 239/4 vom 10.01.2025 '
  + '(Vertragsgegenstand 5.0100.043280.0005.4, Grundsteuer B 102,05 × 430 %; SharePoint Scans/2025-01-10_MG24a Grundsteuerbescheid.pdf). '
  + 'Die Buchhaltung bestätigt am 29.10.2026 08:48 per Mail: „Die Grundsteuer für Flst. 239/4 (438,82 €) gehört zur Marktgasse". '
  + 'Umlagefähig, Schlüssel unverändert. Der Vermerk „OFFEN: Grundsteuer Flst. 239/4" oben ist damit erledigt.';

const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

async function main(): Promise<void> {
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const s = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      // Nur zurücksetzen, solange niemand die Buchung danach geändert hat.
      const { rowCount } = await client.query(
        `UPDATE expense_bookings SET amount_gross=$2, notes=$3, updated_at=now() WHERE id=$1 AND amount_gross=$4`,
        [BUCHUNG, s.vorher.amount_gross, s.vorher.notes, NEU]);
      if (rowCount !== 1) throw new Error('Buchung 80 wurde inzwischen geändert — Rückweg nicht automatisch');
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'nk', action: 'mg24_grundsteuer_20261030.rueckweg', entityType: 'expense_bookings',
        entityId: String(BUCHUNG), before: { amount_gross: NEU }, after: { amount_gross: s.vorher.amount_gross }, source: 'cc' });
      console.log(`Rückweg: Buchung ${BUCHUNG} → ${s.vorher.amount_gross}`);
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe, --ausfuehren oder --rueckweg <datei>');
    await client.query('BEGIN');
    const z = (await client.query(`SELECT id, source_key, property_id, amount_gross::text, umlagefaehig, cost_category_id, notes
        FROM expense_bookings WHERE id=$1 FOR UPDATE`, [BUCHUNG])).rows[0];
    if (!z || z.source_key !== SOURCE_KEY || z.property_id !== 2) throw new Error(`Buchung ${BUCHUNG} ist nicht ${SOURCE_KEY} (MG24)`);
    if (z.amount_gross !== ALT) throw new Error(`Buchung ${BUCHUNG} steht auf ${z.amount_gross}, erwartet ${ALT}`);
    if (!z.umlagefaehig) throw new Error('Buchung 80 ist nicht umlagefähig — Erwartung verletzt');
    const notes = `${z.notes}\n\n${STEMPEL} ${NOTIZ}`;
    await client.query(`UPDATE expense_bookings SET amount_gross=$2, notes=$3, updated_at=now() WHERE id=$1`, [BUCHUNG, NEU, notes]);
    console.log(`Buchung ${BUCHUNG}: ${z.amount_gross} → ${NEU} (umlagefähig, Kategorie ${z.cost_category_id} unverändert)`);
    if (probe) { await client.query('ROLLBACK'); console.log('Probe zurückgerollt'); return; }
    await client.query('COMMIT');
    await audit.log({ actor: AKTOR, module: 'nk', action: 'mg24_grundsteuer_20261030.buchung', entityType: 'expense_bookings',
      entityId: String(BUCHUNG), before: { amount_gross: z.amount_gross }, after: { amount_gross: NEU, notiz: NOTIZ }, source: 'cc' });
    const zeit = new Date().toISOString();
    mkdirSync(SICHERUNG, { recursive: true });
    const datei = path.join(SICHERUNG, `sicherung-${zeit.replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: QUELLE, zeit, vorher: z }, null, 1));
    console.log(`Ausgeführt. Rückweg: --rueckweg ${datei}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => closePool());
