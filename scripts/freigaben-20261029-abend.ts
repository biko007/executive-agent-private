#!/usr/bin/env bun
/**
 * Owner-Freigaben 29.10.2026 21:43 Berlin („Freigabe Umsatz Doppelverknüpfungen · Freigabe Scan Riess“),
 * Inhalt exakt wie A5/B2 in report-neue-umsaetze-scans-20261029.md. Datenbankteil:
 *
 *   1. Doppelverknüpfungen: Mietverknüpfungen (rent_payment_links), deren Umsatz ein Doppelimport ist
 *      (duplicate_of gesetzt), auf das Original umhängen. Betrag, Monat und Mietbuchzeile bleiben.
 *      rent_ledger.bank_transaction_id zeigt bei 37 Zeilen ebenfalls auf den Doppelimport und wird
 *      mit umgehängt — sonst stünde im Mietbuch eine andere Buchung als in der Verknüpfung.
 *      Nachkontrolle in derselben Transaktion: Rückstand je Vertrag, Ist je Mietbuchzeile und
 *      Verknüpfungssumme je Zeile vorher = nachher, sonst Abbruch.
 *   2. Scan Riess FZG-G580 (Riess GmbH & Co. KG, Kd. 498116): zwei Kostensätze (Radwechsel 27.10.2026,
 *      Frontscheibe 02.06.2026), Km-Stand 9.366 → 15.012, zwei Reifensätze (montiert / eingelagert bei
 *      Riess), Typ leer, weil die Rechnung ihn nicht nennt.
 *
 * Danach (eigener Aufruf): zahlungenZuordnen nur als Probe, nichts schreiben.
 *
 *   bun run scripts/freigaben-20261029-abend.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *   bun run scripts/freigaben-20261029-abend.ts --zuordnen-probe
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung ~/backups/freigaben-20261029-abend/, Audit nach dem Commit.
 * Report: report-freigaben-abendbriefing-20261029.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';
import { zahlungenZuordnen } from '../src/modules/assets/mietforderungen.js';

const SICHERUNG = path.join(homedir(), 'backups', 'freigaben-20261029-abend');
const AKTOR = 'cc-bikosoc';
const QUELLE = 'Owner-Freigabe 29.10.2026 21:43';
const STEMPEL = `[29.10.2026, ${QUELLE}]`;
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const zuordnenProbe = process.argv.includes('--zuordnen-probe');
const rueckIdx = process.argv.indexOf('--rueckweg');

const G580 = { id: 2, code: 'FZG-G580', kmAlt: 9366, kmNeu: 15012 };
const WERKSTATT = 'Riess GmbH & Co. KG (Mercedes-Benz), Stockacher Straße 186, Tuttlingen';
const BELEG_RADWECHSEL = 'sharepoint:Scans/2026-10-29_G-Klasse Radwechsel .pdf';
const BELEG_SCHEIBE = 'sharepoint:Scans/2026-10-29_G-Klasse Schadensregulierung Eigenanteil.pdf';
const ERWARTET_VERKNUEPFUNGEN = 40;

const KOSTEN = [
  {
    service_date: '2026-10-27', mileage_km: 15012, service_type: 'Reifenwechsel / Einlagerung', cost: 169.0,
    document_url: BELEG_RADWECHSEL,
    notes: `${STEMPEL} Rechnung 0126153896 vom 27.10.2026 (Auftrag 110599, Kd. 498116): Radwechsel vier Kompletträder 41,18 + vier Laufräder (ab 20 Zoll) wuchten, waschen, kennzeichnen, prüfen und eine Saison einlagern 100,84 = netto 142,02 + 19 % USt 26,98 = 169,00 EUR. Km 15.012. ZAHLSTATUS BEZAHLT: 29.10.2026 per Überweisung von Volksbank …0028, Umsatz 11478 (319,00 EUR = 169,00 diese Rechnung + 150,00 Selbstbeteiligung Rechnung 0126149839). Reifentyp (Sommer/Winter) nicht auf der Rechnung.`,
  },
  {
    service_date: '2026-06-02', mileage_km: 11905, service_type: 'Glasschaden: Frontscheibe erneuert', cost: 3274.59,
    document_url: BELEG_SCHEIBE,
    notes: `${STEMPEL} Rechnung 0126149839 vom 02.06.2026 (Auftrag 106663, Kd. 498116, angenommen 23.04.2026): Frontscheibe erneuern samt Zusatz für Multifunktionskamera, Kurztest, Festpreis netto 2.751,76 + 19 % USt 522,83 = 3.274,59 EUR. Km 11.905. Regulierung laut Riess-Schreiben vom 22.10.2026: Gothaer zahlte 3.124,59 EUR direkt an Riess, Selbstbeteiligung 150,00 EUR. ZAHLSTATUS BEZAHLT (SB): 29.10.2026 per Überweisung von Volksbank …0028, Umsatz 11478 (zusammen mit Rechnung 0126153896).`,
  },
];

const REIFEN = [
  {
    installed_at: '2026-10-27', removed_at: null,
    notes: `${STEMPEL} Status: MONTIERT am 27.10.2026, Km-Stand 15.012, Rechnung Riess 0126153896 („Radwechsel vier Kompletträder“). Typ, Marke, Dimension nicht auf der Rechnung.`,
  },
  {
    installed_at: null, removed_at: '2026-10-27',
    notes: `${STEMPEL} Status: EINGELAGERT bei ${WERKSTATT} seit 27.10.2026 („vier Laufräder ab 20 Zoll gewuchtet, gewaschen, gekennzeichnet, geprüft, eine Saison eingelagert“, Rechnung 0126153896). Typ, Marke, Dimension nicht auf der Rechnung; Montagedatum nicht belegt.`,
  },
];

/* Rückstand je Vertrag, Ist je Zeile, Verknüpfungssumme je Zeile — muss beim Umhängen gleich bleiben. */
const KONTROLLE_SQL = `
  SELECT r.lease_id, r.id AS zeile, r.expected_amount::text AS soll, coalesce(r.paid_amount,0)::text AS ist, r.status,
         coalesce((SELECT sum(l.amount) FROM rent_payment_links l WHERE l.rent_ledger_id = r.id),0)::text AS verkn
    FROM rent_ledger r ORDER BY r.id`;
const RUECKSTAND_SQL = `
  SELECT r.lease_id, sum(greatest(r.expected_amount - coalesce(r.paid_amount,0),0))::text AS rueckstand
    FROM rent_ledger r WHERE r.period_month <= current_date GROUP BY r.lease_id ORDER BY r.lease_id`;

async function main(): Promise<void> {
  if (zuordnenProbe) {
    const erg = await zahlungenZuordnen({ probelauf: true });
    console.log(JSON.stringify({ geprueft: erg.geprueft, zugeordnet: erg.zugeordnet, nicht_zugeordnet: erg.nicht_zugeordnet.length }));
    await closePool();
    return;
  }
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const s = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      for (const v of s.verknuepfungen) {
        const r = await client.query('UPDATE rent_payment_links SET transaction_id = $1 WHERE id = $2 AND transaction_id = $3', [v.alt, v.id, v.neu]);
        if (r.rowCount !== 1) throw new Error(`Rückweg: Verknüpfung ${v.id} nicht im erwarteten Zustand, nichts geändert`);
      }
      for (const z of s.mietbuch) {
        const r = await client.query('UPDATE rent_ledger SET bank_transaction_id = $1 WHERE id = $2 AND bank_transaction_id = $3', [z.alt, z.id, z.neu]);
        if (r.rowCount !== 1) throw new Error(`Rückweg: Mietbuchzeile ${z.id} nicht im erwarteten Zustand, nichts geändert`);
      }
      const k = await client.query('DELETE FROM vehicle_service_records WHERE id = ANY($1::int[]) AND created_by = $2 RETURNING id', [s.kosten_ids, AKTOR]);
      const t = await client.query('DELETE FROM vehicle_tire_sets WHERE id = ANY($1::bigint[]) AND created_by = $2 RETURNING id', [s.reifen_ids, AKTOR]);
      if (k.rowCount !== s.kosten_ids.length || t.rowCount !== s.reifen_ids.length) throw new Error('Rückweg: Fuhrpark-Zeilen fehlen, nichts geändert');
      await client.query('UPDATE vehicles SET current_mileage_km = $1, updated_by = $2 WHERE id = $3 AND current_mileage_km = $4', [G580.kmAlt, AKTOR, G580.id, G580.kmNeu]);
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'assets', action: 'freigaben_20261029_abend.rueckweg', entityType: 'rent_payment_link',
        entityId: 'mehrere', before: s, source: QUELLE });
      console.log('Rückweg ausgeführt');
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe | --ausfuehren | --rueckweg <datei> | --zuordnen-probe');

    await client.query('BEGIN');
    await client.query('LOCK TABLE rent_payment_links, rent_ledger IN SHARE ROW EXCLUSIVE MODE');
    const auditListe: Parameters<typeof audit.log>[0][] = [];

    /* ── 1. Doppelverknüpfungen ─────────────────────────────────────────── */
    const kontrolleVorher = (await client.query(KONTROLLE_SQL)).rows;
    const rueckVorher = (await client.query(RUECKSTAND_SQL)).rows;
    const { rows: links } = await client.query(
      `SELECT l.id, l.rent_ledger_id, l.transaction_id::text AS alt, t.duplicate_of::text AS neu, l.amount::text AS betrag,
              o.duplicate_of AS kette, o.amount = t.amount AS gleicher_betrag, o.account_id = t.account_id AS gleiches_konto
         FROM rent_payment_links l
         JOIN banking_transactions t ON t.id = l.transaction_id
         JOIN banking_transactions o ON o.id = t.duplicate_of
        WHERE t.duplicate_of IS NOT NULL ORDER BY l.id`);
    if (links.length !== ERWARTET_VERKNUEPFUNGEN) throw new Error(`Erwartet ${ERWARTET_VERKNUEPFUNGEN} Verknüpfungen, gefunden ${links.length}`);
    for (const l of links) {
      if (l.kette || !l.gleicher_betrag || !l.gleiches_konto) throw new Error(`Verknüpfung ${l.id}: Original ${l.neu} passt nicht (Kette/Betrag/Konto)`);
      const da = await client.query('SELECT 1 FROM rent_payment_links WHERE transaction_id = $1', [l.neu]);
      if (da.rowCount) throw new Error(`Original ${l.neu} ist schon verknüpft (Verknüpfung ${l.id})`);
    }
    const verknuepfungen = [];
    for (const l of links) {
      await client.query('UPDATE rent_payment_links SET transaction_id = $1 WHERE id = $2', [l.neu, l.id]);
      verknuepfungen.push({ id: l.id, zeile: l.rent_ledger_id, alt: l.alt, neu: l.neu, betrag: l.betrag });
    }
    const { rows: mb } = await client.query(
      `UPDATE rent_ledger r SET bank_transaction_id = t.duplicate_of::text
         FROM banking_transactions t
        WHERE t.id::text = r.bank_transaction_id AND t.duplicate_of IS NOT NULL
        RETURNING r.id, t.id::text AS alt, t.duplicate_of::text AS neu`);
    const mietbuch = mb.map((z: any) => ({ id: z.id, alt: z.alt, neu: z.neu }));
    const kontrolleNachher = (await client.query(KONTROLLE_SQL)).rows;
    const rueckNachher = (await client.query(RUECKSTAND_SQL)).rows;
    if (JSON.stringify(kontrolleVorher) !== JSON.stringify(kontrolleNachher)) throw new Error('Mietbuch oder Verknüpfungssummen haben sich verändert: Abbruch');
    if (JSON.stringify(rueckVorher) !== JSON.stringify(rueckNachher)) throw new Error('Rückstand je Vertrag hat sich verändert: Abbruch');
    const rest = await client.query(
      'SELECT count(*)::int n FROM rent_payment_links l JOIN banking_transactions t ON t.id = l.transaction_id WHERE t.duplicate_of IS NOT NULL');
    if (rest.rows[0].n !== 0) throw new Error(`Nach dem Umhängen hängen noch ${rest.rows[0].n} Verknüpfungen an Doppelimporten`);
    console.log(`Doppelverknüpfungen: ${verknuepfungen.length} umgehängt, Mietbuchzeilen mit Buchungsverweis umgehängt: ${mietbuch.length}; Rückstand je Vertrag (${rueckNachher.length} Verträge) und Ist je Zeile (${kontrolleNachher.length}) unverändert`);
    auditListe.push({ actor: AKTOR, module: 'assets', action: 'rent_payment_link.umhaengen_doppelimport', entityType: 'rent_payment_link',
      entityId: verknuepfungen.map((v) => v.id).join(','), before: { verknuepfungen: verknuepfungen.map((v) => ({ id: v.id, transaction_id: v.alt })), mietbuch: mietbuch.map((z) => ({ id: z.id, bank_transaction_id: z.alt })) },
      after: { verknuepfungen: verknuepfungen.map((v) => ({ id: v.id, transaction_id: v.neu })), mietbuch: mietbuch.map((z) => ({ id: z.id, bank_transaction_id: z.neu })) }, source: QUELLE });

    /* ── 2. Scan Riess FZG-G580 ─────────────────────────────────────────── */
    const { rows: [fz] } = await client.query('SELECT id, vehicle_code, current_mileage_km FROM vehicles WHERE id = $1 FOR UPDATE', [G580.id]);
    if (!fz || fz.vehicle_code !== G580.code || fz.current_mileage_km !== G580.kmAlt) throw new Error(`Fahrzeug ${G580.code} nicht wie erwartet (Km ${fz?.current_mileage_km})`);
    const vorhanden = await client.query(
      `SELECT (SELECT count(*)::int FROM vehicle_service_records WHERE vehicle_id = $1) AS k, (SELECT count(*)::int FROM vehicle_tire_sets WHERE vehicle_id = $1) AS r`, [G580.id]);
    if (vorhanden.rows[0].k || vorhanden.rows[0].r) throw new Error(`${G580.code} hat schon Kosten- oder Reifensätze: Abbruch`);
    const { rows: [u] } = await client.query('SELECT amount::float AS amount, reference FROM banking_transactions WHERE id = 11478 AND duplicate_of IS NULL');
    if (!u || u.amount !== -319 || !u.reference.includes('0126153896') || !u.reference.includes('0126149839')) throw new Error('Umsatz 11478 passt nicht');

    const kosten_ids: number[] = [];
    for (const k of KOSTEN) {
      const { rows: [n] } = await client.query(
        `INSERT INTO vehicle_service_records (vehicle_id, service_date, mileage_km, service_type, workshop, cost, notes, document_url, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
        [G580.id, k.service_date, k.mileage_km, k.service_type, WERKSTATT, k.cost, k.notes, k.document_url, AKTOR]);
      kosten_ids.push(n.id);
      auditListe.push({ actor: AKTOR, module: 'fleet', action: 'service_record.create', entityType: 'vehicle_service_record', entityId: String(n.id), after: n, source: QUELLE });
      console.log(`Kostensatz ${n.id}: ${k.service_date} ${k.service_type} ${k.cost.toFixed(2)}`);
    }
    const reifen_ids: string[] = [];
    for (const r of REIFEN) {
      const { rows: [n] } = await client.query(
        `INSERT INTO vehicle_tire_sets (vehicle_id, tire_type, installed_at, removed_at, notes, created_by, updated_by)
         VALUES ($1, NULL, $2, $3, $4, $5, $5) RETURNING *`, [G580.id, r.installed_at, r.removed_at, r.notes, AKTOR]);
      reifen_ids.push(n.id);
      auditListe.push({ actor: AKTOR, module: 'fleet', action: 'tire_set.create', entityType: 'tire_set', entityId: G580.code, after: n, source: QUELLE });
      console.log(`Reifensatz ${n.id}: ${r.removed_at ? 'eingelagert' : 'montiert'}`);
    }
    const { rows: [fzNeu] } = await client.query(
      'UPDATE vehicles SET current_mileage_km = $1, updated_by = $2 WHERE id = $3 RETURNING id, vehicle_code, current_mileage_km', [G580.kmNeu, AKTOR, G580.id]);
    auditListe.push({ actor: AKTOR, module: 'fleet', action: 'vehicle.update', entityType: 'vehicle', entityId: G580.code,
      before: { current_mileage_km: G580.kmAlt }, after: { current_mileage_km: fzNeu.current_mileage_km, stand: '2026-10-27', beleg: '0126153896' }, source: QUELLE });
    console.log(`Km ${G580.code}: ${G580.kmAlt} → ${fzNeu.current_mileage_km}`);

    if (probe) { await client.query('ROLLBACK'); console.log('Probe zurückgerollt'); return; }
    await client.query('COMMIT');
    for (const a of auditListe) await audit.log(a);
    mkdirSync(SICHERUNG, { recursive: true });
    const zeit = new Date().toISOString();
    const datei = path.join(SICHERUNG, `sicherung-${zeit.replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: QUELLE, zeit, verknuepfungen, mietbuch, kosten_ids, reifen_ids, km_alt: G580.kmAlt, rueckstand_vorher: rueckVorher }, null, 1));
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
