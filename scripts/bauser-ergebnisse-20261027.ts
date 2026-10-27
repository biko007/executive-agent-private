#!/usr/bin/env bun
/**
 * Owner-Antworten nach dem Bauser-Termin 27.10.2026 (19:00) — nur Fristen und Notizen.
 * Keine Beträge, keine Zählerstände (Owner-Grenze dieses Auftrags).
 *
 *   bun run scripts/bauser-ergebnisse-20261027.ts --probe       zeigen, nichts schreiben
 *   bun run scripts/bauser-ergebnisse-20261027.ts --ausfuehren  ausfuehren (eine Transaktion)
 *   bun run scripts/bauser-ergebnisse-20261027.ts --rueckweg <sicherung.json>
 *
 * Vorher: `bash scripts/cc-pre-backup.sh`. Jede geaenderte Zeile wird als JSON
 * gesichert (~/backups/bauser-ergebnisse-20261027/), jede Aenderung bekommt
 * nach dem Commit einen Audit-Eintrag. Report: report-bauser-ergebnisse-20261027.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'bauser-ergebnisse-20261027');
const AKTOR = 'cc-bikosoc';
const QUELLE = 'Owner-Antworten 27.10.2026 19:00 nach Bauser-Termin';
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

const L19 = 1; const MG24 = 2; const N24 = 4;

type Tx = { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

async function withTransaction(f: (tx: Tx) => Promise<void>): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await f(client as unknown as Tx);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function aenderungen(tx: Tx, protokoll: any): Promise<void> {
  const notiz = (alt: string | null, neu: string) => `${alt ? alt + '\n\n' : ''}[27.10.2026, ${QUELLE}] ${neu}`;
  const upd = async (tabelle: string, id: number, neu: string, aktion: string) => {
    const vorher = (await tx.query(`SELECT * FROM ${tabelle} WHERE id = $1`, [id])).rows[0];
    if (!vorher) throw new Error(`${tabelle} ${id} fehlt`);
    protokoll.vorher.push({ tabelle, id, zeile: vorher });
    const text = notiz(vorher.notes, neu);
    await tx.query(`UPDATE ${tabelle} SET notes = $2, updated_at = now() WHERE id = $1`, [id, text]);
    protokoll.schritte.push({ aktion, tabelle, id });
    protokoll.audit.push({ actor: AKTOR, module: 'nk', action: `bauser_20261027.${aktion}`, entityType: tabelle, entityId: String(id),
      before: { notes: vorher.notes }, after: { notes: text }, source: 'cc' });
  };
  const meter = async (nr: string) => {
    const r = (await tx.query('SELECT id FROM meters WHERE meter_number = $1', [nr])).rows[0];
    if (!r) throw new Error(`Zähler ${nr} fehlt`);
    return r.id as number;
  };
  const frist = async (propertyId: number, termin: string, bezeichnung: string, notes: string, aktion: string) => {
    // Idempotent: dieselbe Frist am selben Tag nicht doppelt anlegen.
    const schon = (await tx.query('SELECT 1 FROM objekt_fristen WHERE property_id = $1 AND termin = $2 AND bezeichnung = $3', [propertyId, termin, bezeichnung])).rows.length;
    if (schon) return;
    const felder = { property_id: propertyId, art: 'wartung', termin, vorlauf_tage: 14, verantwortlich: 'owner', bezeichnung, quelle: QUELLE, notes };
    const keys = Object.keys(felder);
    const r = await tx.query(`INSERT INTO objekt_fristen (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, keys.map((k) => (felder as any)[k]));
    const id = r.rows[0].id;
    protokoll.neu.push({ tabelle: 'objekt_fristen', id });
    protokoll.schritte.push({ aktion, tabelle: 'objekt_fristen', id });
    protokoll.audit.push({ actor: AKTOR, module: 'nk', action: `bauser_20261027.${aktion}`, entityType: 'objekt_fristen', entityId: String(id), before: null, after: felder, source: 'cc' });
  };

  // 1 Heizstab: Ablesedatum unbekannt — die Stände werden nicht erfasst (E2 unverändert).
  await upd('meters', await meter('1LGZ0064308208'),
    'HEIZSTAB-STÄNDE 19.821 / 22.006 kWh: Ablesedatum ist NICHT bekannt (Bauser-Termin). Die Stände werden nicht als Ablesung erfasst; '
    + 'die Differenz 2.185 kWh bleibt nur hier dokumentiert. E2 unverändert (voll Heizkosten). Keine Nachfrage mehr nötig.', 'heizstab_datum_unbekannt');

  // 2 WP-Schaden: Versicherung wird nicht weiterverfolgt — Notiz an der Hotboy-Buchung (Schadensfolge).
  await upd('expense_bookings', 88,
    'VERSICHERUNG: Der Wärmepumpen-Schaden 2025 (Allianz-Meldung 09.02.2025) wird NICHT weiterverfolgt (Owner). Vorgang geschlossen.', 'wp_schaden_versicherung_nein');

  // 3 W5a Fühlerfehler: Reparatur mit der Maurer-Wartung November 2026.
  await upd('meters', await meter('24454033'),
    'FÜHLERFEHLER: Reparatur beauftragt, Ausführung mit der Maurer-Wartung voraussichtlich November 2026 (Frist angelegt).', 'w5a_fuehler_notiz');
  await frist(N24, '2026-11-30', 'N24 W5a Fühler bei Maurer-Wartung, Nov 2026',
    'Wärmezähler W5 Einliegerwohnung (5a), Seriennummer 24454033: Fühlerfehler, Reparatur mit der Maurer-Wartung. Keine Mail.', 'frist_w5a_fuehler');

  // 4 Hauswart: nur vorbereitet; Betrag bleibt 0 € bis „Freigabe N24 Hauswart 960".
  await upd('expense_bookings', 54,
    'OWNER-FRAGE: „Haben wir nicht die 960 Euro angesetzt?" Wiederaufnahme 960 € (umlagefähig, Fläche/NHN) ist vorbereitet, NICHT gebucht; '
    + 'Buchung erst nach „Freigabe N24 Hauswart 960". Bericht: report-bauser-ergebnisse-20261027.md.', 'hauswart_vorbereitung');

  // 5 MG24 Nullstellung: Owner-Entscheidung an den betroffenen Zählern.
  const mg24 = 'OWNER-ENTSCHEIDUNG NULLSTELLUNG: „Wir nehmen die Bestände, die wir haben, und starten bei 0; die Mieter haben dann halt einen kleinen Vorteil — '
    + 'das gilt auch für den Strom." Anfangsstand 0 ab Reset, vorhandene Stände unverändert, keine Rückrechnung oder Schätzung des Vorlaufs. ';
  await upd('meters', await meter('MG24-WMZ-HEIZUNG-GESAMT'), mg24 + 'Hier: Nullstellung 09.04.2025, Jan.–Anf. April 2025 bleibt ungemessen.', 'mg24_null_heizung');
  await upd('meters', await meter('MG24-WMZ-WARMWASSER-GESAMT'), mg24 + 'Hier: Nullstellung 09.04.2025, Jan.–Anf. April 2025 bleibt ungemessen.', 'mg24_null_warmwasser');
  await upd('meters', await meter('1LGZ0071678615'), mg24 + 'Hier: Stand 0 ab 17.06.2025 (SWT) bzw. 23.06.2025 (Kundenanlage); kein Vorlauf. '
    + 'Der SWT-Einspruch (12.200 kWh) ist davon nicht berührt — er betrifft den falschen Ablesewert 243,993 zum 21.08.2025.', 'mg24_null_strom');

  // 6 L19 Enthärtungsanlage: Wartung bei Maurer beauftragt, voraussichtlich Januar 2027.
  await frist(L19, '2027-01-31', 'L19 Enthärtungsanlage: Wartung durch Maurer (Wartungsleuchte), Jan 2027',
    'Bei Fa. Maurer beauftragt (Owner nach Bauser-Termin 27.10.2026). Keine Mail.', 'frist_l19_enthaertung');

  // 7 N24 Abluftventilator W6: beauftragt, Ausführung mit der Wartung November 2026.
  await frist(N24, '2026-11-30', 'N24 W6 Abluftventilator Bad: Tausch durch Maurer (AN2611082931) mit Wartung, Nov 2026',
    'Auftragsbestätigung Maurer AN2611082931; Ausführung mit der Maurer-Wartung November 2026. Keine Mail.', 'frist_n24_w6_abluft');
}

async function rueckweg(datei: string): Promise<void> {
  const p = JSON.parse(readFileSync(datei, 'utf-8'));
  await withTransaction(async (tx: Tx) => {
    for (const n of [...p.neu].reverse()) await tx.query(`DELETE FROM ${n.tabelle} WHERE id = $1`, [n.id]);
    for (const v of p.vorher) await tx.query(`UPDATE ${v.tabelle} SET notes = $2 WHERE id = $1`, [v.id, v.zeile.notes]);
    await audit.log({ actor: AKTOR, module: 'nk', action: 'bauser_20261027.rueckweg', entityType: 'bauser_20261027', entityId: path.basename(datei), before: null, after: { neu_geloescht: p.neu.length, notizen_zurueck: p.vorher.length }, source: 'cc' });
  });
  console.log(`Rückweg: ${p.neu.length} Fristen gelöscht, ${p.vorher.length} Notizen zurückgesetzt`);
}

async function main(): Promise<void> {
  if (rueckIdx > 0) return rueckweg(process.argv[rueckIdx + 1]);
  if (!probe && !ausfuehren) throw new Error('--probe, --ausfuehren oder --rueckweg <datei>');
  mkdirSync(SICHERUNG, { recursive: true });
  // Audit erst nach dem Commit, damit eine Probe keine Einträge hinterlässt.
  const protokoll: any = { quelle: QUELLE, zeit: new Date().toISOString(), vorher: [], neu: [], schritte: [], audit: [] };
  try {
    await withTransaction(async (tx: Tx) => {
      await aenderungen(tx, protokoll);
      if (probe) throw new Error('PROBE');
    });
  } catch (e: any) {
    if (e?.message !== 'PROBE') throw e;
    console.log(`Probe: ${protokoll.schritte.length} Schritte, zurückgerollt`);
    for (const s of protokoll.schritte) console.log(`  ${s.aktion} ${s.tabelle} ${s.id}`);
    return;
  }
  const ids: number[] = [];
  for (const a of protokoll.audit) { const r: any = await audit.log(a); if (r?.id) ids.push(r.id); }
  const datei = path.join(SICHERUNG, `sicherung-${protokoll.zeit.replace(/[:.]/g, '-')}.json`);
  writeFileSync(datei, JSON.stringify(protokoll, null, 1));
  console.log(`Ausgeführt: ${protokoll.schritte.length} Schritte. Rückweg: --rueckweg ${datei}`);
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => closePool());
