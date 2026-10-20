#!/usr/bin/env bun
/**
 * Einmalig — Owner-Freigaben 20.10.2026 17:23 (C2):
 *
 *  --karte-6411     Kartenkonto …4112 (Karte …6411, Claudia, bezahlt vom Owner)
 *                   aktiv setzen und benennen; gehört in die Privatausgaben.
 *  --zusammenfuehren PDF-Kartenkonten „Visa …6047" (id 108) und „Mastercard
 *                   …7303" (id 109) in die FinTS-Kartenkonten …0125 / …0133
 *                   überführen: Die PDF-Umsätze wandern auf das FinTS-Konto
 *                   (Quelle bleibt 'kk_pdf_import'), die leeren PDF-Konten
 *                   werden ausgeblendet. Beim nächsten FinTS-Abruf werden die
 *                   PDF-Zeilen als Dubletten der FinTS-Zeilen verknüpft
 *                   (uebernimmSynchronisiertenUmsatz) — FinTS ist führend.
 *
 * Sicherung vorher nach ~/backups/banking-karten-20261020/, Audit je Schritt.
 * Nichts wird gelöscht.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getClient, query } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'banking-karten-20261020');
mkdirSync(SICHERUNG, { recursive: true });
const stempel = new Date().toISOString().replace(/[:.]/g, '-');
const sichere = (name: string, daten: unknown) =>
  writeFileSync(path.join(SICHERUNG, `${name}-${stempel}.json`), JSON.stringify(daten, null, 1));
const FREIGABE = 'Owner 20.10.2026 17:23';

async function konto(nummer: string) {
  const r = (await query(`SELECT * FROM banking_accounts WHERE institution_id = 29 AND account_number = $1`, [nummer])).rows;
  if (r.length !== 1) throw new Error(`Konto ${nummer.slice(-4)} nicht eindeutig gefunden (${r.length})`);
  return r[0];
}

async function karte6411() {
  const k = await konto('238664112');
  sichere('konto-4112-vorher', k);
  await query(
    `UPDATE banking_accounts SET status = 'active', display_name = $2, owner_name = $3, updated_at = now() WHERE id = $1`,
    [k.id, 'Kreditkarte …6411 (Claudia, zahlt Owner)', 'Jürgen Bickel (zahlt)'],
  );
  await audit.log({
    module: 'banking', action: 'account.reactivate', actor: 'cc-bikosoc', entityType: 'banking_account', entityId: String(k.id),
    before: { status: k.status, display_name: k.display_name },
    after: { status: 'active', display_name: 'Kreditkarte …6411 (Claudia, zahlt Owner)', privatausgaben: true, freigabe: FREIGABE },
  } as any);
  return { id: Number(k.id), konto: '…' + String(k.iban).slice(-4) };
}

async function zusammenfuehren() {
  const paare = [
    { pdfId: 108, karte: '6047', fintsNummer: '34840125', name: 'Kreditkarte Visa (…6047)' },
    { pdfId: 109, karte: '7303', fintsNummer: '34840133', name: 'Kreditkarte Mastercard (…7303)' },
  ];
  const ergebnis: any[] = [];
  for (const p of paare) {
    const pdf = (await query('SELECT * FROM banking_accounts WHERE id = $1', [p.pdfId])).rows[0];
    const fints = await konto(p.fintsNummer);
    if (!pdf) throw new Error(`PDF-Konto ${p.pdfId} fehlt`);
    const zeilen = (await query(
      `SELECT id, account_id, bank_transaction_id, booking_date, amount, source FROM banking_transactions WHERE account_id = $1 ORDER BY id`,
      [p.pdfId])).rows;
    sichere(`karte-${p.karte}-vorher`, { pdf, fints, zeilen });

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const umgezogen = await client.query(
        `UPDATE banking_transactions SET account_id = $2, updated_at = now() WHERE account_id = $1 RETURNING id`,
        [p.pdfId, fints.id]);
      await client.query(
        `UPDATE banking_accounts SET status = 'archived', display_name = $2, updated_at = now() WHERE id = $1`,
        [p.pdfId, `PDF-Kartenkonto …${p.karte} (zusammengeführt in …${String(fints.iban).slice(-4)})`]);
      await client.query(
        `UPDATE banking_accounts SET display_name = $2, updated_at = now() WHERE id = $1`,
        [fints.id, p.name]);
      await client.query('COMMIT');
      await audit.log({
        module: 'banking', action: 'account.merge_card', actor: 'cc-bikosoc', entityType: 'banking_account',
        entityId: `${p.pdfId}->${fints.id}`,
        before: { pdf_konto: p.pdfId, umsaetze: zeilen.length },
        after: { fints_konto: Number(fints.id), umgezogen: umgezogen.rowCount, pdf_konto_status: 'archived', freigabe: FREIGABE },
      } as any);
      ergebnis.push({ karte: p.karte, von: p.pdfId, nach: Number(fints.id), umgezogen: umgezogen.rowCount });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return ergebnis;
}

const aus: Record<string, unknown> = {};
try {
  if (process.argv.includes('--karte-6411')) aus.karte6411 = await karte6411();
  if (process.argv.includes('--zusammenfuehren')) aus.zusammenfuehren = await zusammenfuehren();
  process.stdout.write(JSON.stringify(aus, null, 1) + '\n');
  process.exit(0);
} catch (e: any) {
  process.stdout.write(JSON.stringify({ ...aus, fehler: String(e?.message || e) }, null, 1) + '\n');
  process.exit(1);
}
