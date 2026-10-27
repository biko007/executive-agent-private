#!/usr/bin/env bun
/**
 * N24 NK 2025 — Datenänderungen nach Owner-Freigabe „Freigabe N24" (C2),
 * 27.10.2026 11:29, Auftrag „Probeabrechnung in bikosoc + Eingabeblatt".
 *
 *   bun run scripts/n24-nk2025-freigabe-20261027.ts --probe       zeigen, nichts schreiben
 *   bun run scripts/n24-nk2025-freigabe-20261027.ts --ausfuehren  ausfuehren (eine Transaktion)
 *   bun run scripts/n24-nk2025-freigabe-20261027.ts --rueckweg <sicherung.json>
 *
 * Vorher: `bash scripts/cc-pre-backup.sh` (pg_dump). Jede geaenderte Zeile wird
 * vorher als JSON gesichert (~/backups/n24-nk2025-20261027/), jede Aenderung
 * bekommt einen Audit-Eintrag. Annahmen A1–A7 stehen im Report
 * report-n24-nk2025-probeabrechnung-20261027.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'n24-nk2025-20261027');
const AKTOR = 'cc-bikosoc';
const FREIGABE = 'Owner-Freigabe „Freigabe N24" 27.10.2026 11:29';
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

const N24 = 4;
const SP_MAURER = 'N24/N24 - Gebäudeakte/8. Rechnungen/Maurer/2025-12-09_N24_RE25116549_Maurer_Wartung_Heizung.pdf';
const SP_DACH = 'N24/N24 - Gebäudeakte/8. Rechnungen/Haller+Gabele/2025-12-09_N24_Haller+Gabele_RE 2025213_Projekt 25124_Dachwartung 2025.pdf';

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
  const notiz = (alt: string | null, neu: string) => `${alt ? alt + '\n' : ''}[27.10.2026, ${FREIGABE}] ${neu}`;
  const upd = async (tabelle: string, id: number, felder: Record<string, unknown>, aktion: string) => {
    const vorher = await zeile(tx, tabelle, id);
    protokoll.vorher.push({ tabelle, id, zeile: vorher });
    const keys = Object.keys(felder);
    const werte = keys.map((k) => (typeof felder[k] === 'function' ? (felder[k] as any)(vorher) : felder[k]));
    await tx.query(`UPDATE ${tabelle} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}${tabelle === 'expense_bookings' || tabelle === 'leases' ? ', updated_at = now()' : ''} WHERE id = $1`, [id, ...werte]);
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

  // 1. Kundenanlagen-Staende (Vorschlag vom 23.10.)
  await neu('meter_readings', { meter_id: await meter('1LGZ0064308209'), value: 16659, unit: 'kWh', reading_type: 'annual', read_at: '2026-01-01T00:00:00Z', source: 'manual', is_estimated: false,
    notes: 'Kundenanlage 2025 energiekonzept vom 23.10.2026 (Stand 01.01.2026). Allgemeinstrom 2025 = 16.659 − 5.945 = 10.714 kWh. Messart bei energiekonzept angefragt.' }, 'stand_allgemeinstrom');
  await neu('meter_readings', { meter_id: await meter('1LGZ0064308208'), value: 33714, unit: 'kWh', reading_type: 'annual', read_at: '2026-01-01T00:00:00Z', source: 'manual', is_estimated: false,
    notes: 'Kundenanlage 2025 energiekonzept vom 23.10.2026 (Stand 01.01.2026). WP-Strom 2025 = 33.714 − 17.196 = 16.518 kWh. Messart bei energiekonzept angefragt.' }, 'stand_waermepumpe');
  await neu('meter_readings', { meter_id: await meter('1MCS0010125165'), value: 42913.25, unit: 'kWh', reading_type: 'annual', read_at: '2025-12-31T00:00:00Z', source: 'manual', is_estimated: false,
    notes: 'Kundenanlage 2025 vom 23.10.2026: Register 1.8.0 Rohwert 858,265 × 50 = 42.913,25 kWh; Bezug 2025 24.356,6 kWh. Einspeisung 2.8.0 (159,458 → 319,783 × 50 = 8.016,25 kWh) hat keinen eigenen Zähler in bikosoc.' }, 'stand_uebergabe');

  // 2. W5a 24454033: Ersatzwert § 9a (Vorjahr 146 kWh) statt gemessener 153 kWh (Fuehlerfehler)
  const w5a = (await tx.query(`SELECT r.id FROM meter_readings r JOIN meters m ON m.id = r.meter_id
    WHERE m.meter_number = '24454033' AND r.read_at::date = '2025-12-31'`)).rows;
  if (w5a.length !== 1) throw new Error(`W5a: ${w5a.length} Staende am 31.12.2025`);
  await upd('meter_readings', w5a[0].id, {
    value: 312, is_estimated: true, estimate_method: '§ 9a Abs. 1 HeizkostenV — Verbrauch des Vorjahres',
    estimate_reason: 'Fühlerfehler (Flag 16, −327 °C); Vorjahr 2024: 166 − 20 = 146 kWh; 166 + 146 = 312',
    notes: (z: any) => notiz(z.notes, 'Gemessener Stichtagswert 319 kWh (Verbrauch 153 kWh) durch Ersatzwert 312 kWh (Verbrauch 146 kWh) ersetzt, Annahme A4. Für 2026 beginnt der Verbrauch damit bei 312 statt 319 (+7 kWh).'),
  }, 'w5a_ersatzwert');

  // 3. Buchungen 72/73 auf A1
  await upd('expense_bookings', 72, { amount_gross: 4136.02,
    notes: (z: any) => notiz(z.notes, 'ANNAHME A1: 10.714 kWh (Kundenanlage 23.10.) × 37,53 ct brutto (Entscheidung E) = 4.136,02 €. Vorher 4.125,10 € (TEST-JA 10.684,9 kWh). Die Schlussrechnung energiekonzept ersetzt den Wert.') }, 'allgemeinstrom_a1');
  await upd('expense_bookings', 73, { amount_gross: 6314.42,
    notes: (z: any) => notiz(z.notes, 'ANNAHME A1: 16.518 kWh (Kundenanlage 23.10.) × 37,53 ct brutto = 6.314,42 €. Vorher 6.297,53 € (TEST-JA 16.473 kWh). Hotboy-Abzug als eigene Minderung. Die Schlussrechnung energiekonzept ersetzt den Wert.') }, 'wp_strom_a1');

  // 4. Hotboy-Abzug (A2): Minderung im Heizkostenpool + Eigentuemerposten
  const heizung = (await tx.query("SELECT id FROM cost_categories WHERE code = 'heizung'")).rows[0].id;
  const gemeinsam = { property_id: N24, cost_category_id: heizung, vendor_name: 'energiekonzept ortenau (WP-Strom, Hotboy-Anteil)',
    service_period_start: '2025-02-02', service_period_end: '2025-03-05', maintenance_vs_operating: 'operating' };
  await neu('expense_bookings', { ...gemeinsam, source_key: 'n24-2025-hotboy-abzug', amount_gross: -820.03, umlagefaehig: true,
    notes: `ANNAHME A2 (${FREIGABE}): Hotboy-Provisorium 02.02.–05.03.2025, 2.185 kWh (Heizungszähler laut Kieninger-Fotos 19.821 → 22.006) × 37,53 ct = 820,03 €. Minderung des WP-Strompools — nicht umlegen. Bauser-Bestätigung steht aus.` }, 'hotboy_minderung');
  await neu('expense_bookings', { ...gemeinsam, source_key: 'n24-2025-hotboy-eigentuemer', amount_gross: 820.03, umlagefaehig: false,
    notes: `Gegenbuchung zur Hotboy-Minderung (A2): 820,03 € trägt der Eigentümer; Forderung gegen Maurer bzw. Versicherung (report-n24-hotboy-forderung-maurer-20261018.md).` }, 'hotboy_eigentuemer');

  // 5. Hauswart auf 0 (A3)
  await upd('expense_bookings', 54, { amount_gross: 0,
    notes: (z: any) => notiz(z.notes, 'ANNAHME A3: ohne Beleg und ohne Zahlung — vorläufig 0 € (vorher 960,00 €). Offen; mit Beleg wieder einsetzen.') }, 'hauswart_null');

  // 6. Rechnungen verknuepfen
  await upd('expense_bookings', 67, { document_path: SP_MAURER, invoice_number: 'RE25116549',
    notes: (z: any) => notiz(z.notes, 'Rechnung in SharePoint verknüpft.') }, 'maurer_beleg');
  await upd('expense_bookings', 68, { document_path: SP_DACH, invoice_number: 'RE 2025213',
    notes: (z: any) => notiz(z.notes, 'Rechnung in SharePoint verknüpft. Umlagefähig nach Owner-Entscheidung 2 (sonstige Betriebskosten).') }, 'dachwartung_beleg');

  // 7. Blitzschutz (A6)
  await upd('expense_bookings', 44, {
    notes: (z: any) => notiz(z.notes, 'ANNAHME A6: umlagefähig als „Prüfungskosten der Betriebssicherheit technischer Anlagen" (§ 3 Nr. 2 a Mietvertrag).') }, 'blitzschutz_annahme');

  // 8. Vorauszahlung W2 auf 2.400 € (Dezember auf …5844 belegt)
  await upd('lease_charges', 5, { valid_until: '2025-12-31',
    notes: (z: any) => notiz(z.notes, 'Dezember 2025 belegt: 1.650,00 € am 02.12.2025 auf dem Stromkonto N24 …5844. Vorauszahlung 2025 damit 12 × 200 = 2.400 €.') }, 'w2_vorauszahlung');

  // 9. W6 alt: Juni-Ausfall als Aussenstand
  await upd('leases', 27, {
    notes: (z: any) => notiz(z.notes, 'AUSSENSTAND: Miete Juni 2025 1.845,00 € (Kaltmiete 1.490,00 + Stellplätze 155,00 + NK-Vorauszahlung 200,00) in keinem Konto eingegangen, fällig 03.06.2025. Wird im Begleitschreiben der NK-Abrechnung 2025 eingefordert (Owner-Entscheidung 3).') }, 'w6alt_aussenstand');

  // 10. Fristeintrag N24 2025 je Einheit — die Tabelle erlaubt eine Zeile je
  //     Einheit und Jahr; bei W6 traegt sie den Vormieter, der Nachmieter steht in der Notiz.
  const gesehen = new Set<number>();
  for (const [lease, unit, tenant] of (await tx.query(`
      SELECT l.id, l.unit_id, (SELECT lt.tenant_id FROM lease_tenants lt WHERE lt.lease_id = l.id ORDER BY lt.is_primary_contact DESC, lt.tenant_id LIMIT 1) t
        FROM leases l JOIN units u ON u.id = l.unit_id
       WHERE u.property_id = $1 AND l.billing_mode = 'vorauszahlung'
         AND l.start_date <= '2025-12-31' AND (l.end_date IS NULL OR l.end_date >= '2025-01-01')
       ORDER BY l.id`, [N24])).rows.map((r: any) => [r.id, r.unit_id, r.t])) {
    if (gesehen.has(unit)) continue;
    gesehen.add(unit);
    const w6 = lease === 27 ? ' Gilt auch für den Nachmieter W6 ab 01.12.2025 (Mietvertrag n24-w6-2025).' : '';
    await neu('nk_period_obligations', { property_id: N24, year: 2025, unit_id: unit, lease_id: lease, tenant_id: tenant,
      status: 'data_collection', due_date: '2026-12-31', service_deadline_at: '2026-12-31',
      notes: `Abrechnungsfrist § 556 Abs. 3 BGB: Zugang bis 31.12.2026.${w6} Angelegt ${FREIGABE}.` }, 'frist');
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
