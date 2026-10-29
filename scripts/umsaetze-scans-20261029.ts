#!/usr/bin/env bun
/**
 * Owner-Auftrag 29.10.2026 14:06 („alle Umsätze aktualisiert … bitte analysieren und verarbeiten“), Teil A.
 * Nur die eindeutigen Treffer aus dem Import vom 29.10.2026 13:01/13:05 UTC:
 *
 *   1. Garagenmiete mg22 G3 (Mietvertrag 52): Umsatz 11451 (40,00 EUR, 28.10.2026, Mietkonto) ist die
 *      Novembermiete — so wie die Zahlungen vom 31.07., 28.08. und 30.09. jeweils den Folgemonat bezahlt haben.
 *      Die Forderung November 2026 fehlt noch (die Sollstellung läuft bis zum laufenden Monat); sie wird hier
 *      genau so angelegt, wie `sollstellungErzeugen` sie am 01.11. anlegen würde (dieselbe Funktion `sollZeilen`),
 *      und mit dem Umsatz verknüpft.
 *      Der allgemeine Lauf `zahlungenZuordnen` wird bewusst NICHT verwendet: Sein Probelauf am 29.10. hätte 76
 *      ältere Zahlungen neu zugeordnet, darunter rund 45 Originale, deren Doppelimport die Verknüpfung schon trägt.
 *   2. Porsche-Rechnungen 81045762 / 81045736: Zahlung am 29.10.2026 (Umsätze 11474 / 11475, Volksbank …0028)
 *      als Zahlstatus an die Kostensätze vehicle_service_records 28 und 29 schreiben.
 *
 *   bun run scripts/umsaetze-scans-20261029.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung ~/backups/umsaetze-20261029/, Audit nach dem Commit.
 * Report: report-neue-umsaetze-scans-20261029.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';
import { sollZeilen, vertragspositionen, SOLL_AB } from '../src/modules/assets/mietforderungen.js';

const SICHERUNG = path.join(homedir(), 'backups', 'umsaetze-20261029');
const AKTOR = 'cc-bikosoc';
const QUELLE = 'Owner-Auftrag 29.10.2026 14:06';
const STEMPEL = `[29.10.2026, ${QUELLE}]`;
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

const GARAGE = { lease_id: 52, monat: '2026-11-01', umsatz: '11451', betrag: 40, konto: 7 };
const PORSCHE = [
  { record: 28, umsatz: '11474', betrag: 332.07, rechnung: '81045762' },
  { record: 29, umsatz: '11475', betrag: 2365.67, rechnung: '81045736' },
];

async function main(): Promise<void> {
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const s = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      const l = await client.query('DELETE FROM rent_payment_links WHERE id = $1 AND transaction_id = $2 RETURNING id', [s.link_id, GARAGE.umsatz]);
      const r = await client.query('DELETE FROM rent_ledger WHERE id = $1 AND lease_id = $2 RETURNING id', [s.ledger_id, GARAGE.lease_id]);
      if (l.rowCount !== 1 || r.rowCount !== 1) throw new Error('Rückweg: Mietbuchzeile oder Verknüpfung nicht gefunden, nichts geändert');
      for (const v of s.service_records) {
        await client.query('UPDATE vehicle_service_records SET notes = $1, updated_by = $2 WHERE id = $3', [v.notes, AKTOR, v.id]);
      }
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'banking', action: 'umsaetze_20261029.rueckweg', entityType: 'rent_ledger',
        entityId: String(s.ledger_id), before: s, source: QUELLE });
      console.log('Rückweg ausgeführt: Mietbuchzeile', s.ledger_id, 'und Verknüpfung', s.link_id, 'gelöscht, Kostensätze 28/29 zurückgesetzt');
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe | --ausfuehren | --rueckweg <datei>');

    /* Soll November genau wie die Sollstellung: gleiche Funktion, gleiche Vertragsdaten. */
    const { rows: [v] } = await client.query(
      `SELECT l.id, to_char(l.start_date,'YYYY-MM-DD') AS start_date, to_char(l.end_date,'YYYY-MM-DD') AS end_date,
              l.kaltmiete::float, l.nk_vorauszahlung::float, l.heizkosten_vorauszahlung::float,
              l.garage_amount::float, l.kitchen_amount::float, l.rent_due_day, l.owner_hauptmieter
         FROM leases l WHERE l.id = $1`, [GARAGE.lease_id]);
    const soll = sollZeilen(v, '2026-11', SOLL_AB, await vertragspositionen()).find((z) => z.period_month === GARAGE.monat);
    if (!soll || Math.abs(soll.expected - GARAGE.betrag) > 0.005) throw new Error(`Soll November passt nicht: ${soll?.expected}`);

    await client.query('BEGIN');
    const { rows: [u] } = await client.query(
      'SELECT id, account_id, amount::float AS amount, to_char(booking_date,\'YYYY-MM-DD\') AS tag, duplicate_of FROM banking_transactions WHERE id = $1', [GARAGE.umsatz]);
    if (!u || Number(u.account_id) !== GARAGE.konto || u.amount !== GARAGE.betrag || u.duplicate_of) throw new Error('Umsatz 11451 nicht wie erwartet');
    const schon = await client.query('SELECT 1 FROM rent_payment_links WHERE transaction_id = $1', [GARAGE.umsatz]);
    if (schon.rowCount) throw new Error('Umsatz 11451 ist schon verknüpft');
    const da = await client.query('SELECT id FROM rent_ledger WHERE lease_id = $1 AND period_month = $2', [GARAGE.lease_id, GARAGE.monat]);
    if (da.rowCount) throw new Error(`Forderung November existiert schon (${da.rows[0].id})`);

    const { rows: [zeile] } = await client.query(
      `INSERT INTO rent_ledger (lease_id, period_month, due_date, expected_amount, paid_amount, payment_date, bank_transaction_id,
         status, anteil, kaltmiete_amount, nk_amount, heizkosten_amount, garage_amount, kitchen_amount, erzeugt, gilt_als_bezahlt, booking_text)
       VALUES ($1,$2,$3,$4,$4,$5,$6,'paid',$7,$8,$9,$10,$11,$12,true,$13,$14) RETURNING *`,
      [GARAGE.lease_id, soll.period_month, soll.due_date, soll.expected, u.tag, GARAGE.umsatz, soll.anteil, soll.kaltmiete,
        soll.nk, soll.heizkosten, soll.garage, soll.kitchen, soll.gilt_als_bezahlt, 'Sollstellung 2026-11']);
    const { rows: [link] } = await client.query(
      `INSERT INTO rent_payment_links (rent_ledger_id, transaction_id, amount, grundlage, notes)
       VALUES ($1,$2,$3,'iban',$4) RETURNING *`,
      [zeile.id, GARAGE.umsatz, GARAGE.betrag, `${STEMPEL} Zahlung 28.10. für November, wie die Vormonate (Folgemonat).`]);
    const auditListe: Parameters<typeof audit.log>[0][] = [
      { actor: AKTOR, module: 'assets', action: 'rent_ledger.create', entityType: 'rent_ledger', entityId: String(zeile.id), after: zeile, source: QUELLE },
      { actor: AKTOR, module: 'assets', action: 'rent_payment_link.create', entityType: 'rent_payment_link', entityId: String(link.id), after: link, source: QUELLE },
    ];
    console.log(`Garage mg22 G3: Forderung 2026-11 id ${zeile.id} (40,00, fällig ${soll.due_date}), bezahlt mit Umsatz ${GARAGE.umsatz}, Verknüpfung ${link.id}`);

    const service_records: any[] = [];
    for (const p of PORSCHE) {
      const { rows: [t] } = await client.query('SELECT amount::float AS amount, reference FROM banking_transactions WHERE id = $1 AND duplicate_of IS NULL', [p.umsatz]);
      if (!t || t.amount !== -p.betrag || !t.reference.includes(p.rechnung)) throw new Error(`Umsatz ${p.umsatz} passt nicht zu ${p.rechnung}`);
      const { rows: [vorher] } = await client.query('SELECT id, notes, cost::float AS cost FROM vehicle_service_records WHERE id = $1 FOR UPDATE', [p.record]);
      if (!vorher || Math.abs(vorher.cost - p.betrag) > 0.005 || !vorher.notes.includes('ZAHLSTATUS OFFEN')) throw new Error(`Kostensatz ${p.record} nicht wie erwartet`);
      if (vorher.notes.includes('ZAHLSTATUS BEZAHLT')) throw new Error(`Kostensatz ${p.record} schon als bezahlt vermerkt`);
      const neu = `${vorher.notes}\n${STEMPEL} ZAHLSTATUS BEZAHLT: 29.10.2026 per Überweisung von Volksbank …0028, Umsatz ${p.umsatz}, ${p.betrag.toFixed(2).replace('.', ',')} EUR = Rechnungsbetrag ${p.rechnung}.`;
      const { rows: [nachher] } = await client.query(
        'UPDATE vehicle_service_records SET notes = $1, updated_by = $2 WHERE id = $3 RETURNING id, notes', [neu, AKTOR, p.record]);
      service_records.push({ id: vorher.id, notes: vorher.notes });
      auditListe.push({ actor: AKTOR, module: 'fleet', action: 'service_record.update', entityType: 'vehicle_service_record',
        entityId: String(p.record), before: { notes: vorher.notes }, after: { notes: nachher.notes }, source: QUELLE });
      console.log(`Kostensatz ${p.record} (${p.rechnung}): bezahlt mit Umsatz ${p.umsatz}`);
    }

    if (probe) { await client.query('ROLLBACK'); console.log('Probe zurückgerollt'); return; }
    await client.query('COMMIT');
    for (const a of auditListe) await audit.log(a);
    mkdirSync(SICHERUNG, { recursive: true });
    const zeit = new Date().toISOString();
    const datei = path.join(SICHERUNG, `sicherung-${zeit.replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: QUELLE, zeit, ledger_id: zeile.id, link_id: link.id, service_records }, null, 1));
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
