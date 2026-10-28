#!/usr/bin/env bun
/**
 * Owner-Freigaben 28.10.2026 20:53 („Freigabe MG24 Grundsteuer+Kehrung / Freigabe Mietbuch N24 W2 /
 * DGUV-Prüfung umlegen"): drei Datenkorrekturen in einer Transaktion.
 *
 *   1. MG24 2025: Grundsteuer (Buchung 80) 409,45 → 905,45 laut Bescheid …0006.2; Kehrrechnung
 *      Börtzler R25/807 75,70 umlagefähig neu; Mahngebühr 5,05 als nicht umlagefähige Buchung.
 *      Offen nur als Notiz: Grundsteuer Flst. 239/4 (438,82) und SWT-Gutschrift 0001-ARV-2024-30664.
 *   2. Mietbuch N24 W2 (Mietvertrag 23): fünf Mieten Dez 2025–Apr 2026 vom Stromkonto N24 (Konto 202)
 *      zuordnen; die ab Mai 2026 um einen Monat verschobenen Verknüpfungen auf ihren Monat setzen.
 *   3. N24 2025: DGUV-Prüfung der Absturzsicherung (Buchung 69) umlagefähig, wie in der Abrechnung 2024.
 *
 *   bun run scripts/freigaben-mg24-n24-20261028.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung ~/backups/freigaben-20261028/, Audit nach dem Commit.
 * Report: report-freigaben-mg24-n24-20261028.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'freigaben-20261028');
const AKTOR = 'cc-bikosoc';
const QUELLE = 'Owner-Freigabe 28.10.2026 20:53';
const STEMPEL = `[28.10.2026, ${QUELLE}]`;
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

const MG24 = 2;
const N24 = 4;
const LEASE_N24_W2 = 23;

/** Neue Buchungen MG24 (source_key macht sie eindeutig und den Rückweg sicher). */
const NEUE_BUCHUNGEN = [
  {
    source_key: 'mg24-2025-schornstein-r25-807', cost_category_id: 12, umlagefaehig: true, amount_gross: '75.70',
    vendor_name: 'Markus Börtzler Schornsteinfegermeisterbetrieb', invoice_number: 'R25/807',
    invoice_date: '2025-03-31', payment_date: '2025-05-15',
    document_path: '/Austausch/belege-nk2025/MG24/2025-03-31_MG24_Boertzler_R25-807-Kehrrechnung.pdf',
    notes: `${STEMPEL} Erste Kehrrechnung 2025 Marktgasse 24 (Kehr- und Überprüfungsordnung BW), 75,70 EUR. Bezahlt am 15.05.2025 zusammen mit 5,05 EUR Mahngebühr (80,75 EUR, DATEV-Buchungsliste 2025 Konto 4280). Umlagefähig nach BetrKV § 2 Nr. 12; die Mahngebühr ist getrennt und nicht umlagefähig gebucht.`,
  },
  {
    source_key: 'mg24-2025-boertzler-r25-807-mahngebuehr', cost_category_id: 17, umlagefaehig: false, amount_gross: '5.05',
    vendor_name: 'Markus Börtzler Schornsteinfegermeisterbetrieb', invoice_number: 'R25/807 Mahnung',
    invoice_date: '2025-04-30', payment_date: '2025-05-15',
    document_path: '/Austausch/belege-nk2025/MG24/2025-04-30_MG24_Boertzler_Mahnung-R25-807.pdf',
    notes: `${STEMPEL} Mahngebühr zur Kehrrechnung R25/807. NICHT umlagefähig (Verzugskosten des Eigentümers). In DATEV mit der Rechnung auf Konto 4280 gebucht; die Buchhaltung bucht sie auf Konto 4900 um (wie bei R25/2820).`,
  },
];

/** Geänderte Buchungen: id, erwarteter source_key (Schutz vor falscher Zeile), neue Werte, Notiz. */
const BUCHUNGS_AENDERUNGEN = [
  { id: 80, source_key: 'mg24-2025-grundsteuer', set: { amount_gross: '905.45' },
    notiz: 'KORRIGIERT 409,45 → 905,45 EUR: Grundsteuerbescheid Marktgasse 24 vom 10.01.2025 (Vertragsgegenstand 5.0100.043280.0006.2) lautet auf 905,45 EUR; die Buchhaltung hat in der korrigierten DATEV-Liste 2025 ebenfalls 905,45 auf MG24 gebucht. Die 496,95 EUR für L19 sind ein eigener Bescheid (…0003.8). OFFEN: Grundsteuer Flst. 239/4 (MG24a, …0005.4) 438,82 EUR – ob sie zur Abrechnung MG24 gehört, klärt die Buchhaltung; bis dahin nicht angesetzt.' },
  { id: 22, source_key: null, set: {},
    notiz: 'OFFEN: SWT-Gutschrift 0001-ARV-2024-30664 (Vertrag 348661, 01.10.–15.11.2024) über 273,40 EUR steht in der DATEV-Liste 2025 (Konto 4243, 15.01.2025), in bikosoc nicht. Bauphase, ohne Wirkung auf die NK 2025; Erfassung offen.' },
  { id: 69, source_key: 'n24-2025-haller-absturzsicherung', set: { umlagefaehig: true },
    notiz: 'UMGESTELLT auf UMLAGEFÄHIG (Owner: „DGUV-Prüfung umlegen"): wie in der Abrechnung 2024 (eddi24 „Sonstige Kosten 3", 1.175,52 EUR) wird die jährliche DGUV-Prüfung der Absturzsicherung mit der Dachwartung umgelegt. Dachwartung Haller & Gabele RE 2025213 damit gesamt 1.210,78 EUR (835,18 + 375,60).' },
];

/** Mietbuch N24 W2: Forderungszeile → Umsatz. Grundlage manuell = Owner-Freigabe. */
const MIETBUCH = [
  { ledger: 3, monat: '2025-12', tx: 7842, datum: '2025-12-02', grundlage: 'manuell', soll: true },
  { ledger: 4, monat: '2026-01', tx: 7849, datum: '2026-01-06', grundlage: 'manuell', soll: true },
  { ledger: 5, monat: '2026-02', tx: 7857, datum: '2026-02-04', grundlage: 'manuell', soll: true },
  { ledger: 6, monat: '2026-03', tx: 7863, datum: '2026-03-06', grundlage: 'manuell', soll: true },
  { ledger: 2030, monat: '2026-04', tx: 7869, datum: '2026-04-07', grundlage: 'manuell', soll: false },
  { ledger: 2031, monat: '2026-05', tx: 426, datum: '2026-05-05', grundlage: 'iban', soll: false },
  { ledger: 2032, monat: '2026-06', tx: 442, datum: '2026-06-05', grundlage: 'iban', soll: false },
  { ledger: 7, monat: '2026-07', tx: 7697, datum: '2026-07-06', grundlage: 'name_zweck', soll: true }, // 1914 ist Doppelimport von 7697
];
const BETRAG = 1650;

async function main(): Promise<void> {
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const p = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      await client.query(`DELETE FROM expense_bookings WHERE source_key = ANY($1::text[])`, [NEUE_BUCHUNGEN.map((b) => b.source_key)]);
      for (const b of p.buchungen) {
        await client.query(`UPDATE expense_bookings SET amount_gross=$2, umlagefaehig=$3, notes=$4, updated_at=now() WHERE id=$1`,
          [b.id, b.amount_gross, b.umlagefaehig, b.notes]);
      }
      const ids = p.ledger.map((l: any) => l.id);
      await client.query(`DELETE FROM rent_payment_links WHERE rent_ledger_id = ANY($1::int[])`, [ids]);
      for (const l of p.ledger) {
        await client.query(`UPDATE rent_ledger SET expected_amount=$2, paid_amount=$3, payment_date=$4, bank_transaction_id=$5, status=$6,
            booking_text=$7, notes=$8, kaltmiete_amount=$9, nk_amount=$10, garage_amount=$11, updated_at=now() WHERE id=$1`,
          [l.id, l.expected_amount, l.paid_amount, l.payment_date, l.bank_transaction_id, l.status, l.booking_text, l.notes,
            l.kaltmiete_amount, l.nk_amount, l.garage_amount]);
      }
      for (const k of p.links) {
        await client.query(`INSERT INTO rent_payment_links (id, rent_ledger_id, transaction_id, amount, grundlage, notes, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`, [k.id, k.rent_ledger_id, k.transaction_id, k.amount, k.grundlage, k.notes, k.created_at]);
      }
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'nk', action: 'freigaben_20261028.rueckweg', entityType: 'expense_bookings',
        entityId: path.basename(process.argv[rueckIdx + 1]), before: null, after: { buchungen: p.buchungen.length, ledger: ids.length }, source: 'cc' });
      console.log(`Rückweg: ${p.buchungen.length} Buchungen, ${ids.length} Mietbuchzeilen und ${p.links.length} Verknüpfungen zurückgesetzt, neue Buchungen entfernt`);
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe, --ausfuehren oder --rueckweg <datei>');
    await client.query('BEGIN');
    const auditListe: any[] = [];

    // 1 + 3: Buchungen
    const buchungenVorher: any[] = [];
    for (const a of BUCHUNGS_AENDERUNGEN) {
      const z = (await client.query(`SELECT id, source_key, property_id, amount_gross, umlagefaehig, notes FROM expense_bookings WHERE id=$1 FOR UPDATE`, [a.id])).rows[0];
      if (!z) throw new Error(`Buchung ${a.id} fehlt`);
      if (a.source_key && z.source_key !== a.source_key) throw new Error(`Buchung ${a.id} ist nicht ${a.source_key}`);
      buchungenVorher.push(z);
      const neu = { amount_gross: a.set.amount_gross ?? z.amount_gross, umlagefaehig: a.set.umlagefaehig ?? z.umlagefaehig };
      const notes = `${z.notes ? z.notes + '\n\n' : ''}${STEMPEL} ${a.notiz}`;
      await client.query(`UPDATE expense_bookings SET amount_gross=$2, umlagefaehig=$3, notes=$4, updated_at=now() WHERE id=$1`,
        [a.id, neu.amount_gross, neu.umlagefaehig, notes]);
      auditListe.push({ actor: AKTOR, module: 'nk', action: 'freigaben_20261028.buchung', entityType: 'expense_bookings', entityId: String(a.id),
        before: { amount_gross: z.amount_gross, umlagefaehig: z.umlagefaehig }, after: { ...neu, notiz: a.notiz }, source: 'cc' });
      console.log(`Buchung ${a.id}: ${z.amount_gross} ${z.umlagefaehig ? 'U' : 'nU'} → ${neu.amount_gross} ${neu.umlagefaehig ? 'U' : 'nU'}`);
    }
    for (const b of NEUE_BUCHUNGEN) {
      const da = (await client.query(`SELECT id FROM expense_bookings WHERE source_key=$1`, [b.source_key])).rows[0];
      if (da) throw new Error(`Buchung ${b.source_key} existiert schon (id ${da.id})`);
      const r = (await client.query(`INSERT INTO expense_bookings (source_key, property_id, cost_category_id, vendor_name, invoice_number, invoice_date,
            service_period_start, service_period_end, payment_date, amount_gross, umlagefaehig, maintenance_vs_operating, document_path, notes)
          VALUES ($1,$2,$3,$4,$5,$6,'2025-01-01','2025-12-31',$7,$8,$9,'operating',$10,$11) RETURNING id`,
        [b.source_key, MG24, b.cost_category_id, b.vendor_name, b.invoice_number, b.invoice_date, b.payment_date, b.amount_gross,
          b.umlagefaehig, b.document_path, b.notes])).rows[0];
      auditListe.push({ actor: AKTOR, module: 'nk', action: 'freigaben_20261028.buchung_neu', entityType: 'expense_bookings', entityId: String(r.id),
        before: null, after: { source_key: b.source_key, amount_gross: b.amount_gross, umlagefaehig: b.umlagefaehig }, source: 'cc' });
      console.log(`Buchung neu ${r.id}: ${b.source_key} ${b.amount_gross} ${b.umlagefaehig ? 'U' : 'nU'}`);
    }

    // 2: Mietbuch N24 W2
    const ids = MIETBUCH.map((m) => m.ledger);
    const ledgerVorher = (await client.query(`SELECT id, lease_id, to_char(period_month,'YYYY-MM') AS monat, expected_amount, paid_amount, payment_date,
        bank_transaction_id, status, booking_text, notes, kaltmiete_amount, nk_amount, garage_amount
        FROM rent_ledger WHERE id = ANY($1::int[]) FOR UPDATE`, [ids])).rows;
    const linksVorher = (await client.query(`SELECT * FROM rent_payment_links WHERE rent_ledger_id = ANY($1::int[])`, [ids])).rows;
    for (const m of MIETBUCH) {
      const z = ledgerVorher.find((l: any) => l.id === m.ledger);
      if (!z || z.lease_id !== LEASE_N24_W2 || z.monat !== m.monat) throw new Error(`Mietbuchzeile ${m.ledger} ist nicht N24 W2 ${m.monat}`);
      const tx = (await client.query(`SELECT id, amount, booking_date::date::text AS d, account_id FROM banking_transactions WHERE id=$1 AND duplicate_of IS NULL`, [m.tx])).rows[0];
      if (!tx || Number(tx.amount) !== BETRAG || tx.d !== m.datum) throw new Error(`Umsatz ${m.tx} passt nicht (${JSON.stringify(tx)})`);
      // Der Umsatz darf nirgends sonst hängen als an der Zeile, von der er umgehängt wird.
      const fremd = (await client.query(`SELECT rent_ledger_id FROM rent_payment_links WHERE transaction_id=$1 AND NOT (rent_ledger_id = ANY($2::int[]))`, [m.tx, ids])).rows;
      if (fremd.length) throw new Error(`Umsatz ${m.tx} hängt an fremder Zeile ${fremd[0].rent_ledger_id}`);
    }
    await client.query(`DELETE FROM rent_payment_links WHERE rent_ledger_id = ANY($1::int[])`, [ids]);
    for (const m of MIETBUCH) {
      const z = ledgerVorher.find((l: any) => l.id === m.ledger);
      const konto = m.grundlage === 'manuell' ? 'Stromkonto N24 …5844' : 'La-Perla-Giro …4295';
      const notiz = m.grundlage === 'manuell'
        ? `${STEMPEL} BEZAHLT: 1.650,00 EUR am ${m.datum.split('-').reverse().join('.')} auf das ${konto} (Fehlüberweisung des Mieters, von der Buchhaltung am 28.10.2026 bestätigt). Kein Mietrückstand.`
        : `${STEMPEL} Zahlung vom ${m.datum.split('-').reverse().join('.')} (${konto}) diesem Monat zugeordnet; vorher um einen Monat verschoben, weil Dezember bis April fehlten.`;
      await client.query(`UPDATE rent_ledger SET expected_amount = CASE WHEN $8 THEN 1650.00 ELSE expected_amount END,
          kaltmiete_amount = CASE WHEN $8 THEN 1375.00 ELSE kaltmiete_amount END, nk_amount = CASE WHEN $8 THEN 200.00 ELSE nk_amount END,
          garage_amount = CASE WHEN $8 THEN 75.00 ELSE garage_amount END,
          paid_amount=$2, payment_date=$3, bank_transaction_id=$4, status='paid',
          booking_text = CASE WHEN $8 THEN $5 ELSE booking_text END, notes = CASE WHEN notes IS NULL THEN $6 ELSE notes || E'\n\n' || $6 END,
          updated_at=now() WHERE id=$1 AND lease_id=$7`,
        [m.ledger, BETRAG, m.datum, String(m.tx), `Sollstellung ${m.monat}`, notiz, LEASE_N24_W2, m.soll]);
      await client.query(`INSERT INTO rent_payment_links (rent_ledger_id, transaction_id, amount, grundlage, notes) VALUES ($1,$2,$3,$4,$5)`,
        [m.ledger, m.tx, BETRAG, m.grundlage, m.grundlage === 'manuell' ? QUELLE : `${QUELLE}: umgehängt`]);
      auditListe.push({ actor: AKTOR, module: 'assets', action: 'freigaben_20261028.mietbuch', entityType: 'rent_ledger', entityId: String(m.ledger),
        before: { status: z.status, paid_amount: z.paid_amount, bank_transaction_id: z.bank_transaction_id, expected_amount: z.expected_amount },
        after: { status: 'paid', paid_amount: BETRAG, bank_transaction_id: String(m.tx), monat: m.monat }, source: 'cc' });
      console.log(`Mietbuch ${m.monat} (Zeile ${m.ledger}): ${z.status} ${z.paid_amount} tx ${z.bank_transaction_id ?? '–'} → paid 1650 tx ${m.tx}`);
    }
    const offen = (await client.query(`SELECT coalesce(sum(expected_amount - coalesce(paid_amount,0)),0)::numeric(12,2) AS r
        FROM rent_ledger WHERE lease_id=$1 AND status <> 'paid' AND period_month <= '2026-10-01'`, [LEASE_N24_W2])).rows[0].r;
    console.log(`Rückstand N24 W2 bis Oktober 2026 nachher: ${offen}`);
    if (Number(offen) !== 0) throw new Error(`Rückstand W2 nicht 0 (${offen})`);

    if (probe) { await client.query('ROLLBACK'); console.log('Probe zurückgerollt'); return; }
    await client.query('COMMIT');
    for (const a of auditListe) await audit.log(a);
    const zeit = new Date().toISOString();
    mkdirSync(SICHERUNG, { recursive: true });
    const datei = path.join(SICHERUNG, `sicherung-${zeit.replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: QUELLE, zeit, buchungen: buchungenVorher, ledger: ledgerVorher, links: linksVorher }, null, 1));
    console.log(`Ausgeführt. Rückweg: --rueckweg ${datei}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => closePool());
