#!/usr/bin/env bun
/**
 * N24 NK 2025 — Hauswart 960 € wieder ansetzen („Freigabe N24 Hauswart 960", Owner 27.10.2026 19:04, C2).
 *
 *   bun run scripts/n24-hauswart-960-20261027.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung der Zeile in ~/backups/n24-nk2025-20261027/,
 * Audit nach dem Commit. Report: report-n24-hauswart-v4-20261027.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'n24-nk2025-20261027');
const AKTOR = 'cc-bikosoc';
const FREIGABE = 'Owner-Freigabe „Freigabe N24 Hauswart 960" 27.10.2026 19:04';
const BUCHUNG = 54; // source_key n24-2025-hauswart
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

async function main(): Promise<void> {
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const p = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      await client.query('UPDATE expense_bookings SET amount_gross = $2, notes = $3, updated_at = now() WHERE id = $1', [BUCHUNG, p.vorher.amount_gross, p.vorher.notes]);
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'nk', action: 'n24_2025.hauswart_rueckweg', entityType: 'expense_bookings', entityId: String(BUCHUNG), before: p.nachher, after: p.vorher, source: 'cc' });
      console.log('Rückweg: Buchung 54 zurückgesetzt');
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe, --ausfuehren oder --rueckweg <datei>');
    await client.query('BEGIN');
    const vorher = (await client.query('SELECT * FROM expense_bookings WHERE id = $1 FOR UPDATE', [BUCHUNG])).rows[0];
    if (!vorher || vorher.source_key !== 'n24-2025-hauswart') throw new Error('Buchung 54 ist nicht die Hauswart-Buchung N24 2025');
    const notes = `${vorher.notes}\n\n[27.10.2026, ${FREIGABE}] WIEDER ANGESETZT: 0 € → 960,00 € (umlagefähig, Fläche/NHN, wie Abrechnung 2024 = 12 × 80 €). `
      + 'Beleg: Owner-Freigabe; Rechnung bzw. Zahlungsnachweis (Weiterbelastung bikolino GmbH → La Perla GmbH) weiterhin offen.';
    await client.query('UPDATE expense_bookings SET amount_gross = 960.00, notes = $2, updated_at = now() WHERE id = $1', [BUCHUNG, notes]);
    const nachher = (await client.query('SELECT amount_gross, notes FROM expense_bookings WHERE id = $1', [BUCHUNG])).rows[0];
    if (probe) { await client.query('ROLLBACK'); console.log('Probe: Buchung 54', vorher.amount_gross, '→', nachher.amount_gross, '(zurückgerollt)'); return; }
    await client.query('COMMIT');
    const zeit = new Date().toISOString();
    const datei = path.join(SICHERUNG, `sicherung-hauswart-${zeit.replace(/[:.]/g, '-')}.json`);
    mkdirSync(SICHERUNG, { recursive: true });
    writeFileSync(datei, JSON.stringify({ freigabe: FREIGABE, zeit, zeile: vorher, vorher: { amount_gross: vorher.amount_gross, notes: vorher.notes }, nachher }, null, 1));
    await audit.log({ actor: AKTOR, module: 'nk', action: 'n24_2025.hauswart_960', entityType: 'expense_bookings', entityId: String(BUCHUNG),
      before: { amount_gross: vorher.amount_gross }, after: { amount_gross: nachher.amount_gross, freigabe: FREIGABE }, source: 'cc' });
    console.log(`Ausgeführt: Buchung 54 ${vorher.amount_gross} → ${nachher.amount_gross}. Rückweg: --rueckweg ${datei}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => closePool());
