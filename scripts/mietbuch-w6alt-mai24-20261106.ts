#!/usr/bin/env bun
/**
 * Owner-Freigabe 06.11.2026 08:34 („Freigabe Mietbuch W6alt-Mai24"): Außenstand N24 W6 alt
 * (Vormieter, Wohnung 6) von 1.645,00 € auf 822,50 € korrigieren.
 *
 * Grundlage: report-mietrueckstaende-pruefung-20261030.md (Freigabetabelle) und Prüfung
 * Außenstände v4 (/Austausch/aussenstaende-20261030/). Der Mietvertrag (Zusatz Nr. 4) schuldet
 * für Mai 2024 nur anteilig 922,50 € (15.–31.05.2024); gezahlt wurden am 03.05.2024 1.845,00 €
 * (Umsatz 459). Von der Überzahlung 922,50 € sind 100,00 € in der NK 2024 verrechnet
 * (8 × 200 € Vorauszahlung angesetzt statt 1.500 €), 822,50 € nicht.
 *
 * Umsetzung wie in der Freigabetabelle beschrieben: die 822,50 € aus Umsatz 459 als Teilzahlung
 * an die einzige offene Mietbuchzeile des Vertrags (rent_ledger #2, Juni 2025, 1.645,00 €)
 * verknüpfen. Für Mai 2024 gibt es keine Mietbuchzeile; Umsatz 459 ist bisher nirgends verknüpft.
 * Ergebnis: bezahlt 822,50, offen 822,50, Status partial.
 *
 * NICHT Teil dieser Freigabe: Kautionsnotiz, weitere Buchungen, Zuordnungslauf.
 *
 *   bun run scripts/mietbuch-w6alt-mai24-20261106.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'mietbuch-w6alt-mai24-20261106');
const AKTOR = 'cc-bikosoc';
const LEDGER_ID = 2;
const LEASE_ID = 27;
const UMSATZ_ID = 459;
const BETRAG = 822.5;
const LINK_NOTIZ = 'Überzahlung Mai 2024 verrechnet: 03.05.2024 gezahlt 1.845,00, laut Mietvertrag Zusatz Nr. 4 anteilig 922,50 geschuldet (15.–31.05.2024); '
  + '100,00 davon in NK 2024 verrechnet, 822,50 hier. Owner-Freigabe 06.11.2026 08:34 „Freigabe Mietbuch W6alt-Mai24".';
const LEDGER_NOTIZ = '\nKORREKTUR (Owner-Freigabe 06.11.2026 08:34, „Freigabe Mietbuch W6alt-Mai24"): 822,50 EUR aus der Überzahlung Mai 2024 '
  + '(Umsatz 459 vom 03.05.2024) als Teilzahlung verknüpft. Offen bleiben 822,50 EUR. Grundlage: Prüfung Mietrückstände 30.10.2026 / Außenstände v4.';

const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

const zeile = `SELECT id, lease_id, period_month::text pm, expected_amount, paid_amount, status, payment_date::text pd, bank_transaction_id, md5(coalesce(notes,'')) notes_md5, updated_at
                 FROM rent_ledger WHERE id = $1`;

async function main(): Promise<void> {
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const s = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      const d = await client.query('DELETE FROM rent_payment_links WHERE id = $1 AND rent_ledger_id = $2 AND transaction_id = $3', [s.link_id, LEDGER_ID, UMSATZ_ID]);
      await client.query('UPDATE rent_ledger SET paid_amount = $2, status = $3, notes = $4 WHERE id = $1',
        [LEDGER_ID, s.vorher.paid_amount, s.vorher.status, s.vorher_notes]);
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'mietbuch', action: 'mietbuch_w6alt_mai24.rueckweg', entityType: 'rent_ledger', entityId: String(LEDGER_ID),
        before: null, after: { link_geloescht: d.rowCount, paid_amount: s.vorher.paid_amount, status: s.vorher.status }, source: 'cc' });
      console.log(`Rückweg: Verknüpfung entfernt (${d.rowCount}), Zeile #${LEDGER_ID} zurückgesetzt`);
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe, --ausfuehren oder --rueckweg <datei>');

    await client.query('BEGIN');
    // Eindeutigkeit prüfen — sonst nicht schreiben (Auftrag Teil B).
    const offen = await client.query(`SELECT id, expected_amount, paid_amount, status FROM rent_ledger WHERE lease_id = $1 AND status <> 'paid'`, [LEASE_ID]);
    if (offen.rows.length !== 1 || Number(offen.rows[0].id) !== LEDGER_ID) throw new Error(`nicht eindeutig: offene Zeilen ${JSON.stringify(offen.rows)}`);
    const vorher = (await client.query(zeile, [LEDGER_ID])).rows[0];
    if (Number(vorher.expected_amount) !== 1645 || Number(vorher.paid_amount) !== 0 || vorher.status !== 'open')
      throw new Error(`Betrag/Stand weicht ab: ${JSON.stringify(vorher)}`);
    const vorherNotes = (await client.query('SELECT notes FROM rent_ledger WHERE id = $1', [LEDGER_ID])).rows[0].notes;
    const links459 = await client.query('SELECT id FROM rent_payment_links WHERE transaction_id = $1', [UMSATZ_ID]);
    if (links459.rows.length) throw new Error(`Umsatz ${UMSATZ_ID} ist bereits verknüpft: ${JSON.stringify(links459.rows)}`);
    const u = (await client.query('SELECT id, booking_date::text bd, amount, duplicate_of FROM banking_transactions WHERE id = $1', [UMSATZ_ID])).rows[0];
    if (!u || Number(u.amount) !== 1845 || u.bd !== '2024-05-03' || u.duplicate_of) throw new Error(`Umsatz ${UMSATZ_ID} weicht ab: ${JSON.stringify(u)}`);
    console.log('VORHER', JSON.stringify(vorher));

    const link = (await client.query(
      `INSERT INTO rent_payment_links (rent_ledger_id, transaction_id, amount, grundlage, notes) VALUES ($1, $2, $3, 'manuell', $4) RETURNING id, amount`,
      [LEDGER_ID, UMSATZ_ID, BETRAG, LINK_NOTIZ])).rows[0];
    await client.query(`UPDATE rent_ledger SET paid_amount = $2, status = 'partial', notes = coalesce(notes,'') || $3 WHERE id = $1`,
      [LEDGER_ID, BETRAG, LEDGER_NOTIZ]);
    const nachher = (await client.query(zeile, [LEDGER_ID])).rows[0];
    const summe = (await client.query('SELECT sum(amount) s FROM rent_payment_links WHERE rent_ledger_id = $1', [LEDGER_ID])).rows[0].s;
    if (Number(nachher.paid_amount) !== BETRAG || nachher.status !== 'partial' || Number(summe) !== BETRAG
      || Number(nachher.expected_amount) - Number(nachher.paid_amount) !== 822.5) throw new Error(`Rücklesen weicht ab: ${JSON.stringify(nachher)}`);
    console.log('NACHHER', JSON.stringify(nachher), 'Link', JSON.stringify(link), 'offen', Number(nachher.expected_amount) - Number(nachher.paid_amount));
    const andere = await client.query(`SELECT count(*) n FROM rent_ledger WHERE updated_at >= now() - interval '1 minute' AND id <> $1`, [LEDGER_ID]);
    if (Number(andere.rows[0].n) !== 0) throw new Error('weitere Zeilen geändert');

    if (probe) { await client.query('ROLLBACK'); console.log('Probe zurückgerollt'); return; }
    const zeit = new Date().toISOString();
    mkdirSync(SICHERUNG, { recursive: true });
    const datei = path.join(SICHERUNG, `sicherung-${zeit.replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: 'Owner-Freigabe 06.11.2026 08:34', zeit, link_id: link.id, vorher, vorher_notes: vorherNotes }, null, 1));
    await client.query('COMMIT');
    await audit.log({ actor: AKTOR, module: 'mietbuch', action: 'mietbuch_w6alt_mai24.korrigiert', entityType: 'rent_ledger', entityId: String(LEDGER_ID),
      before: { expected_amount: 1645, paid_amount: 0, status: 'open', offen: 1645 },
      after: { paid_amount: BETRAG, status: 'partial', offen: 822.5, link_id: link.id, umsatz: UMSATZ_ID, freigabe: 'Freigabe Mietbuch W6alt-Mai24' }, source: 'cc' });
    const a = (await client.query(`SELECT id FROM audit_log WHERE action = 'mietbuch_w6alt_mai24.korrigiert' ORDER BY id DESC LIMIT 1`)).rows[0];
    console.log(`Ausgeführt. Audit ${a?.id}. Sicherung: ${datei}\nRückweg: bun run scripts/mietbuch-w6alt-mai24-20261106.ts --rueckweg ${datei}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => closePool());
