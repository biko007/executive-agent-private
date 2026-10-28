#!/usr/bin/env bun
/**
 * SWT-Portalabgleich (Auftrag Chat 28.10.2026 06:40): Wasserzählerwechsel N24 als Notiz vermerken.
 * Nur Notizen an meters 54/104 und objekt_fristen 20 — keine Stammdatenänderung (Owner-Grenze).
 *
 *   bun run scripts/n24-wasserzaehlerwechsel-notiz-20261028.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung ~/backups/swt-portal-20261028/, Audit nach dem Commit.
 * Report: report-swt-portal-abgleich-20261028.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'swt-portal-20261028');
const AKTOR = 'cc-bikosoc';
const QUELLE = 'SWT-Portalabgleich 28.10.2026';
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

const WECHSEL = 'ZÄHLERWECHSEL laut SWT-Kundenportal (Inventur des Chats 28.10.2026; Kunde 492014, Rechnungseinheit 378953, Vertrag 228819 ab 01.01.2026): neuer Hauptwasserzähler 8ZRI0012230358, Stand 0,000 m³ am 24.03.2026; Altzähler 8AXI1005533567. OFFEN: Endstand des Altzählers beim Ausbau ist unbekannt (Wechselprotokoll oder nächste SWT-Abrechnung). Für NK 2025 ohne Einfluss (Stände bis 31.12.2025). NK 2026: Verbrauch = Altzähler 01.01. bis Ausbau + Neuzähler 24.03. bis 31.12.2026. Zählernummer, Ein- und Ausbau in den Stammdaten NICHT geändert (Freigabe nötig).';

/** Tabelle, id, Notiz. */
const NOTIZEN: { tabelle: 'meters' | 'objekt_fristen'; id: number; notiz: string }[] = [
  { tabelle: 'meters', id: 54, notiz: WECHSEL },
  { tabelle: 'meters', id: 104, notiz: 'ZÄHLERWECHSEL: Der Hauptwasserzähler 8AXI1005533567 ist laut SWT-Portal am 24.03.2026 durch 8ZRI0012230358 ersetzt (Notiz an N24-LS01-GEMEINDEWASSER). Die Abrechnungsmenge 2025 (546,576 m³) ist davon nicht berührt.' },
  { tabelle: 'objekt_fristen', id: 20, notiz: 'Am 31.12.2026 den NEUEN Hauptwasserzähler 8ZRI0012230358 ablesen (seit 24.03.2026, Anfangsstand 0,000 m³). Bis dahin OFFEN: Endstand des Altzählers 8AXI1005533567 beim Ausbau am 24.03.2026 beschaffen (Wechselprotokoll SWT oder Abrechnung 2026).' },
];

async function main(): Promise<void> {
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const p = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      for (const v of p.vorher) await client.query(`UPDATE ${v.tabelle} SET notes = $2 WHERE id = $1`, [v.id, v.notes]);
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'nk', action: 'swt_portal.zaehlerwechsel_notiz.rueckweg', entityType: 'meters', entityId: path.basename(process.argv[rueckIdx + 1]), before: null, after: { zeilen: p.vorher.length }, source: 'cc' });
      console.log(`Rückweg: ${p.vorher.length} Notizen zurückgesetzt`);
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe, --ausfuehren oder --rueckweg <datei>');
    await client.query('BEGIN');
    const vorher: any[] = []; const auditListe: any[] = [];
    for (const v of NOTIZEN) {
      const z = (await client.query(`SELECT id, notes FROM ${v.tabelle} WHERE id = $1 FOR UPDATE`, [v.id])).rows[0];
      if (!z) throw new Error(`${v.tabelle} ${v.id} fehlt`);
      vorher.push({ tabelle: v.tabelle, ...z });
      const notes = `${z.notes ? z.notes + '\n\n' : ''}[28.10.2026, ${QUELLE}] ${v.notiz}`;
      await client.query(`UPDATE ${v.tabelle} SET notes = $2, updated_at = now() WHERE id = $1`, [v.id, notes]);
      auditListe.push({ actor: AKTOR, module: 'nk', action: 'swt_portal.zaehlerwechsel_notiz', entityType: v.tabelle, entityId: String(v.id),
        before: null, after: { notiz: v.notiz }, source: 'cc' });
      console.log(`${v.tabelle} ${v.id}: Notiz ergänzt`);
    }
    if (probe) { await client.query('ROLLBACK'); console.log('Probe zurückgerollt'); return; }
    await client.query('COMMIT');
    for (const a of auditListe) await audit.log(a);
    const zeit = new Date().toISOString();
    mkdirSync(SICHERUNG, { recursive: true });
    const datei = path.join(SICHERUNG, `sicherung-${zeit.replace(/[:.]/g, '-')}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: QUELLE, zeit, vorher }, null, 1));
    console.log(`Ausgeführt. Rückweg: --rueckweg ${datei}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; }).finally(() => closePool());
