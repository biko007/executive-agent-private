#!/usr/bin/env bun
/**
 * N24 NK 2025 — Wasser-Endstand und Heizstab-Notiz nach Owner-Entscheidungen
 * vom 27.10.2026 15:35 (E2, E3; „Freigabe N24 Wasserstand" erteilt, C2).
 *
 *   bun run scripts/n24-nk2025-wasser-20261027.ts --probe       zeigen, nichts schreiben
 *   bun run scripts/n24-nk2025-wasser-20261027.ts --ausfuehren  ausfuehren (eine Transaktion)
 *   bun run scripts/n24-nk2025-wasser-20261027.ts --rueckweg <sicherung.json>
 *
 * Vorher: `bash scripts/cc-pre-backup.sh` (pg_dump). Jede geaenderte Zeile wird
 * vorher als JSON gesichert (~/backups/n24-nk2025-20261027/), jede Aenderung
 * bekommt einen Audit-Eintrag. Report: report-n24-nk2025-schaetzprotokolle-20261027.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'n24-nk2025-20261027');
const AKTOR = 'cc-bikosoc';
const FREIGABE = 'Owner-Entscheidungen 27.10.2026 15:35 (E2, E3, „Freigabe N24 Wasserstand")';
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

const N24 = 4;
/* Lineare Fortschreibung des Gemeindewasserzaehlers 8AXI1005533567 (E3):
   letzte echte Ablesung vor dem 22.09.2025 war der 15.10.2024 mit 301,661 m³. */
const WASSER_15_10_2024 = 301.661;
const WASSER_22_09_2025 = 774.297;
const TAGE_ABLESUNGEN = 342; // 15.10.2024 -> 22.09.2025
const TAGE_REST = 100; // 22.09.2025 -> 31.12.2025
const TAGESMITTEL = (WASSER_22_09_2025 - WASSER_15_10_2024) / TAGE_ABLESUNGEN;
const ENDSTAND = Math.round((WASSER_22_09_2025 + TAGESMITTEL * TAGE_REST) * 1000) / 1000;

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
    await tx.query(`UPDATE ${tabelle} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}${tabelle === 'meters' || tabelle === 'objekt_fristen' ? ', updated_at = now()' : ''} WHERE id = $1`, [id, ...werte]);
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
  const meter = async (nr: string) => (await tx.query('SELECT id FROM meters WHERE meter_number = $1', [nr])).rows[0].id as number;
  const ablesung = async (meterId: number, tag: string) =>
    (await tx.query('SELECT id FROM meter_readings WHERE meter_id = $1 AND read_at::date = $2::date', [meterId, tag])).rows[0]?.id as number;

  // 2 (E2) Heizungszaehler: Funktion der Heizstaebe festhalten — Benennung als Notiz.
  /* Der Zaehler misst ganzjaehrig Waermepumpe UND Heizung; nur im Ausfall
     02.02.–05.03.2025 lief allein die Zusatzheizung (Heizstaebe). Deshalb keine
     Umbenennung der Zaehlernummer, sondern eine Notiz. */
  await upd('meters', await meter('1LGZ0064308208'), {
    notes: (v: any) => notiz(v.notes, 'BENENNUNG: Wärmepumpe + Heizung EINSCHLIESSLICH Heizstab Warmwasserspeicher / Zusatzheizung (9 kW). '
      + 'Im Ausfall der Wärmepumpe 02.02.–05.03.2025 lief über diesen Zähler nur der Heizstab: 19.821 → 22.006 kWh = 2.185 kWh (Fotos Pfeifhofer, Fa. Maurer; '
      + 'Mail Bauser 27.10.2026). Owner-Entscheidung E2: Dieser Verbrauch bleibt Wärme-Stromverbrauch und wird voll als Heizkosten abgerechnet. '
      + 'Die beiden Stände werden erst erfasst, wenn ihr Datum bekannt ist (Frage an Bauser über den Chat).'),
  }, 'zaehler_heizstab_notiz');

  // 3a (E3) Wasser 22.09.2025: Ablesung besteht bereits (774,297 m³) — Quelle ergaenzen, keine Doppelzeile.
  const wz = await meter('N24-LS01-GEMEINDEWASSER');
  const a2209 = await ablesung(wz, '2025-09-22');
  await upd('meter_readings', a2209, {
    source_reference: 'SWT-Ableseportal, Foto Bauser 27.10.2026 (Hauptwasserzähler 8AXI1005533567)',
    notes: (v: any) => notiz(v.notes, 'Bestätigt durch SWT-Ableseportal (Foto Bauser 27.10.2026): 774,297 m³ am 22.09.2025, Zähler 8AXI1005533567.'),
  }, 'wasser_2209_quelle');

  // 3b (E3) Endstand 31.12.2025: lineare Fortschreibung statt SWT-Hochrechnung 954,576.
  const a3112 = await ablesung(wz, '2025-12-31');
  await upd('meter_readings', a3112, {
    value: ENDSTAND,
    is_estimated: true,
    estimate_method: `Lineare Fortschreibung (Owner-Entscheidung E3): Tagesmittel zwischen den echten Ablesungen 15.10.2024 (301,661 m³) und 22.09.2025 (774,297 m³) = 472,636 m³ / 342 Tage = ${TAGESMITTEL.toFixed(5)} m³/Tag; Endstand = 774,297 + ${TAGESMITTEL.toFixed(5)} × 100 Tage = ${ENDSTAND.toFixed(3)} m³`,
    estimate_reason: 'Zum 31.12.2025 wurde nicht abgelesen. Ersetzt die Systemhochrechnung der Stadtwerke (954,576 m³). Schätzprotokoll: /Austausch/n24-nk2025/schaetzprotokolle/N24_NK2025_Schaetzprotokoll_Wasser_Hauptzaehler.pdf',
    notes: (v: any) => notiz(v.notes, `Wert ersetzt: 954,576 → ${ENDSTAND.toFixed(3)} m³ (Schätzwert). Die SWT-Rechnung bleibt unverändert (546 m³ berechnet); der Unterschied gleicht sich mit der nächsten echten Ablesung der Stadtwerke aus.`),
  }, 'wasser_endstand_2025');
  await upd('meters', wz, {
    notes: (v: any) => notiz(v.notes, `STAND 31.12.2025 jetzt als Schätzwert erfasst: ${ENDSTAND.toFixed(3)} m³ (lineare Fortschreibung, E3). Ab 2026 jedes Jahr am 31.12. ablesen (Frist angelegt).`),
  }, 'wasser_zaehler_notiz');

  // 3d (E3) Jahresaufgabe: Hauptwasserzaehler (und alle Zaehler) am 31.12. ablesen — je Objekt eine Frist, ohne Mail.
  const objekte = (await tx.query(`SELECT id, name FROM properties WHERE active ORDER BY name`)).rows;
  for (const o of objekte) {
    const schon = (await tx.query(`SELECT 1 FROM objekt_fristen WHERE property_id = $1 AND art = 'ablesung' AND termin = '2026-12-31'`, [o.id])).rows.length;
    if (schon) continue;
    await neu('objekt_fristen', { property_id: o.id, art: 'ablesung', termin: '2026-12-31', vorlauf_tage: 19, verantwortlich: 'owner',
      bezeichnung: `${o.name}: Jahresablesung 31.12.2026 – Hauptwasserzähler und alle Zähler ablesen (Foto)`,
      quelle: FREIGABE,
      notes: 'Jährlich am 31.12. Checkliste „Zaehler_Checkliste_Jahresablesung_2026" in /Austausch/zaehler/ (Vorlage durch den Chat am 12.12.). Keine Mail.' }, 'frist_jahresablesung');
  }
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
