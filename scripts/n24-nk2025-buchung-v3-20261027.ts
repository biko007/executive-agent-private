#!/usr/bin/env bun
/**
 * N24 NK 2025 — Buchungen nach den Owner-Freigaben vom 27.10.2026 16:57
 * („Freigabe N24 Hotboy 4.535", „Wasser Nenner SWT", „Freigabe N24 W6 ab 24.11.", C2).
 *
 *   bun run scripts/n24-nk2025-buchung-v3-20261027.ts --probe       zeigen, nichts schreiben
 *   bun run scripts/n24-nk2025-buchung-v3-20261027.ts --ausfuehren  ausfuehren (eine Transaktion)
 *   bun run scripts/n24-nk2025-buchung-v3-20261027.ts --rueckweg <sicherung.json>
 *
 * Vorher: `bash scripts/cc-pre-backup.sh` (pg_dump). Jede geaenderte Zeile wird
 * vorher als JSON gesichert (~/backups/n24-nk2025-20261027/), jede Aenderung
 * bekommt einen Audit-Eintrag. Report: report-n24-nk2025-v3-20261027.md.
 *
 * W6 ab 24.11. braucht keine Datenaenderung: Die Uebergabestaende vom 24.11.2025
 * stehen als `move_in` in meter_readings; seit 27.10.2026 gehen sie in
 * `findeEinzugsstand()` (nk/nutzerzeit.ts) einer naeheren Logger-Ablesung vor.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'n24-nk2025-20261027');
const AKTOR = 'cc-bikosoc';
const FREIGABE = 'Owner-Freigaben 27.10.2026 16:57 („Freigabe N24 Hotboy 4.535", „Wasser Nenner SWT", „Freigabe N24 W6 ab 24.11.")';
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

const N24 = 4;
/* E1: Hotboy 4.535 kWh zum Arbeitspreis brutto 31,54 ct × 1,19 = 37,5326 ct. */
const HOTBOY_KWH = 4535;
const HOTBOY_EUR = 1702.10;
const ALLGEMEINSTROM_ALT = 4136.02;
const ALLGEMEINSTROM_NEU = 2433.92; // 6.179 kWh umlagefaehig
const PROTOKOLL_HOTBOY = '/Austausch/n24-nk2025/schaetzprotokolle/N24_NK2025_Schaetzprotokoll_Hotboy_Allgemeinstrom.pdf';
/* Wasser: Nenner ist die von den Stadtwerken berechnete Jahresmenge. */
const SWT_ANFANG = 408.000;
const SWT_ENDE = 954.576; // Systemhochrechnung SWT zum 31.12.2025 = 546,576 m³ Jahresmenge

type Tx = { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

/** Eine Transaktion; wirft f(), wird zurueckgerollt. */
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

async function zeile(tx: Tx, tabelle: string, id: number): Promise<any> {
  const r = await tx.query(`SELECT * FROM ${tabelle} WHERE id = $1`, [id]);
  if (!r.rows[0]) throw new Error(`${tabelle} ${id} fehlt`);
  return r.rows[0];
}

async function aenderungen(tx: Tx, protokoll: any): Promise<void> {
  const notiz = (alt: string | null, neu: string) => `${alt ? alt + '\n\n' : ''}[27.10.2026, ${FREIGABE}] ${neu}`;
  const upd = async (tabelle: string, id: number, felder: Record<string, unknown>, aktion: string) => {
    const vorher = await zeile(tx, tabelle, id);
    protokoll.vorher.push({ tabelle, id, zeile: vorher });
    const keys = Object.keys(felder);
    const werte = keys.map((k) => (typeof felder[k] === 'function' ? (felder[k] as any)(vorher) : felder[k]));
    await tx.query(`UPDATE ${tabelle} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...werte]);
    const nachher = await zeile(tx, tabelle, id);
    protokoll.schritte.push({ aktion, tabelle, id, felder: keys });
    protokoll.audit.push({ actor: AKTOR, module: 'nk', action: `n24_2025.${aktion}`, entityType: tabelle, entityId: String(id),
      before: Object.fromEntries(keys.map((k) => [k, vorher[k]])), after: Object.fromEntries(keys.map((k) => [k, nachher[k]])), source: 'cc' });
  };
  const neu = async (tabelle: string, felder: Record<string, unknown>, aktion: string) => {
    const keys = Object.keys(felder);
    const r = await tx.query(`INSERT INTO ${tabelle} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, keys.map((k) => felder[k]));
    const id = r.rows[0].id;
    protokoll.neu.push({ tabelle, id });
    protokoll.schritte.push({ aktion, tabelle, id });
    protokoll.audit.push({ actor: AKTOR, module: 'nk', action: `n24_2025.${aktion}`, entityType: tabelle, entityId: String(id), before: null, after: felder, source: 'cc' });
    return id;
  };

  // 1 (E1) Allgemeinstrom umlagefaehig ohne Hotboy. Vorher-Wert pruefen: nur von 4.136,02 aus buchen.
  const b72 = await zeile(tx, 'expense_bookings', 72);
  if (Number(b72.amount_gross) !== ALLGEMEINSTROM_ALT) throw new Error(`Buchung 72 steht auf ${b72.amount_gross}, erwartet ${ALLGEMEINSTROM_ALT}`);
  await upd('expense_bookings', 72, {
    amount_gross: ALLGEMEINSTROM_NEU,
    notes: (v: any) => notiz(v.notes, `E1 HOTBOY GEBUCHT: Von 10.714 kWh sind ${HOTBOY_KWH.toLocaleString('de-DE')} kWh Hotboy (Schätzprotokoll ${PROTOKOLL_HOTBOY}) herausgerechnet; umlagefähig bleiben 6.179 kWh = 2.433,92 € (4.136,02 − 1.702,10). `
      + 'Die Hotboy-Kosten trägt der Eigentümer (eigene Buchung n24-2025-hotboy-allgemeinstrom, nicht umlagefähig). '
      + 'KORREKTUR DER HERLEITUNG A1: 4.136,02 € = (10.714 kWh × 31,54 ct + 96,445 € Grundpreis) × 1,19; der Betrag war richtig, die Formel „× 37,53 ct" ungenau.'),
  }, 'allgemeinstrom_ohne_hotboy');

  // 2 (E1) Eigentuemerbuchung Hotboy, nicht umlagefaehig.
  await neu('expense_bookings', {
    source_key: 'n24-2025-hotboy-allgemeinstrom', property_id: N24, cost_category_id: 18,
    vendor_name: 'energiekonzept ortenau GmbH (Allgemeinstrom, Hotboy-Anteil)',
    service_period_start: '2025-02-02', service_period_end: '2025-03-05',
    amount_gross: HOTBOY_EUR, umlagefaehig: false, maintenance_vs_operating: 'maintenance',
    document_path: PROTOKOLL_HOTBOY,
    notes: `Instandhaltung / Schadensfolge Wärmepumpen-Ausfall 02.02.–05.03.2025: Hotboy 20 kW am Allgemeinstrom, geschätzt ${HOTBOY_KWH.toLocaleString('de-DE')} kWh × 37,5326 ct brutto = 1.702,10 € `
      + '(gemessene Heizwärme aller Wohnungen im Ausfall, Weblog; Gegenprobe Gradtage 4.349 kWh). Beleg: Schätzprotokoll Hotboy, vom Owner freigegeben 27.10.2026, Unterschrift offen. '
      + `Trägt der Eigentümer, nicht umlagefähig. Owner-Entscheidung 18.10.2026: Forderung gegen Fa. Maurer bzw. Versicherung prüfen. ${FREIGABE}.`,
  }, 'hotboy_eigentuemer');

  // 3 (E2) A2 entfaellt: Heizstab bleibt Heizstrom, Minderung und Gegenbuchung archivieren.
  for (const id of [85, 86]) {
    await upd('expense_bookings', id, {
      archived_at: new Date().toISOString(),
      notes: (v: any) => notiz(v.notes, 'ARCHIVIERT (E2): Die 2.185 kWh des Zählers 1LGZ0064308208 im Ausfall sind der Heizstab und bleiben voll umlagefähiger Heizstrom. A2 entfällt.'),
    }, `a2_archiviert_${id}`);
  }

  // 4 Wasser Nenner SWT: Abrechnungsmenge der Stadtwerke als eigener Hauptzaehler-Eintrag (kein Geraet).
  const wz = (await tx.query(`SELECT id FROM meters WHERE meter_number = 'N24-LS01-GEMEINDEWASSER'`)).rows[0].id as number;
  const swt = await neu('meters', {
    scope_type: 'property', property_id: N24, medium: 'cold_water', meter_number: 'N24-LS01-SWT-ABRECHNUNGSMENGE',
    provider: 'Stadtwerke Tuttlingen', is_main_meter: true, parent_meter_id: wz, submetering_purpose: 'versorger_abrechnung', active: true,
    notes: 'KEIN GERÄT, NICHT ABLESEN. Abrechnungsmenge der Stadtwerke für den Hauptwasserzähler 8AXI1005533567 (N24-LS01-GEMEINDEWASSER). '
      + 'Owner-Entscheidung „Wasser Nenner SWT" 27.10.2026: Nenner für Kaltwasser und Entwässerung 2025 ist die von SWT berechnete Jahresmenge 546,576 m³ '
      + '(408,000 → 954,576), nicht der geschätzte Endstand 912,495 m³ des echten Zählers. Preis je m³ = SWT-Kosten / 546,576 m³; der nicht gemessene Rest bleibt beim Eigentümer; '
      + 'die SWT-Gutschrift nach der nächsten echten Ablesung geht an den Eigentümer. Die Engine nimmt diesen Eintrag nur in Jahren mit Stand (nk/engine.ts, allocateByConsumption).',
  }, 'wasser_swt_menge_zaehler');
  await neu('meter_readings', {
    meter_id: swt, value: SWT_ANFANG, unit: 'm3', reading_type: 'annual', read_at: '2025-01-01T00:00:00Z', source: 'manual',
    reader_name: 'SWT-Rechnung 0001-ARV-2025-22056', is_estimated: true,
    estimate_method: 'Anfangsstand laut SWT-Rechnung (Hochrechnung der Stadtwerke)', estimate_reason: 'Abrechnungsgrundlage SWT, Owner-Entscheidung „Wasser Nenner SWT" 27.10.2026',
  }, 'wasser_swt_anfang');
  await neu('meter_readings', {
    meter_id: swt, value: SWT_ENDE, unit: 'm3', reading_type: 'annual', read_at: '2025-12-31T00:00:00Z', source: 'manual',
    reader_name: 'SWT-Endabrechnung 0001-ARV-2025-38715', is_estimated: true,
    estimate_method: 'Systemhochrechnung der Stadtwerke zum 31.12.2025 (Abrechnungsgrundlage, 546,576 m³ berechnet)',
    estimate_reason: 'Nenner der Wasserverteilung 2025, Owner-Entscheidung „Wasser Nenner SWT" 27.10.2026. Der echte Zähler führt den Schätzwert 912,495 m³ (Ablesung 408).',
  }, 'wasser_swt_ende');
  await upd('meters', wz, {
    notes: (v: any) => notiz(v.notes, 'NENNER 2025: Für die Verteilung gilt die SWT-Abrechnungsmenge 546,576 m³ (Eintrag N24-LS01-SWT-ABRECHNUNGSMENGE). Der Schätzwert 912,495 m³ bleibt als Zählerstand erfasst.'),
  }, 'wasser_zaehler_notiz_nenner');
}

async function rueckweg(datei: string): Promise<void> {
  const p = JSON.parse(readFileSync(datei, 'utf-8'));
  await withTransaction(async (tx: Tx) => {
    for (const n of [...p.neu].reverse()) await tx.query(`DELETE FROM ${n.tabelle} WHERE id = $1`, [n.id]);
    for (const v of p.vorher) {
      const keys = Object.keys(v.zeile).filter((k) => k !== 'id');
      await tx.query(`UPDATE ${v.tabelle} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [v.id, ...keys.map((k) => v.zeile[k])]);
    }
    await audit.log({ actor: AKTOR, module: 'nk', action: 'n24_2025.rueckweg', entityType: 'n24_2025', entityId: path.basename(datei), before: null, after: { neu_geloescht: p.neu.length, zeilen_zurueck: p.vorher.length }, source: 'cc' });
  });
  console.log(`Rückweg: ${p.neu.length} neue Zeilen gelöscht, ${p.vorher.length} Zeilen zurückgesetzt`);
}

async function main(): Promise<void> {
  if (rueckIdx > 0) return rueckweg(process.argv[rueckIdx + 1]);
  if (!probe && !ausfuehren) throw new Error('--probe, --ausfuehren oder --rueckweg <datei>');
  mkdirSync(SICHERUNG, { recursive: true });
  /* Audit erst nach dem Commit: Eine Probe oder ein Abbruch soll keine
     Eintraege fuer Aenderungen hinterlassen, die es nicht gibt. */
  const protokoll: any = { freigabe: FREIGABE, zeit: new Date().toISOString(), vorher: [], neu: [], schritte: [], audit: [] };
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
  for (const a of protokoll.audit) await audit.log(a);
  const datei = path.join(SICHERUNG, `sicherung-${protokoll.zeit.replace(/[:.]/g, '-')}.json`);
  writeFileSync(datei, JSON.stringify(protokoll, null, 1));
  console.log(`Ausgeführt: ${protokoll.schritte.length} Schritte. Rückweg: --rueckweg ${datei}`);
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => closePool());
