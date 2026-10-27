#!/usr/bin/env bun
/**
 * Belegsuche NK 2025 (Auftrag 27.10.2026 19:05): gefundene Belege an die Buchungen hängen.
 * Nur document_path (wo leer) und Notiz — keine Beträge (Owner-Grenze).
 *
 *   bun run scripts/belege-nk2025-verknuepfen-20261027.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung ~/backups/belege-nk2025-20261027/, Audit nach dem Commit.
 * Report: report-belegsuche-nk2025-20261027.md.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'belege-nk2025-20261027');
const AKTOR = 'cc-bikosoc';
const QUELLE = 'Belegsuche NK 2025, 27.10.2026';
const A = '/Austausch/belege-nk2025';
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

/** Buchung → neuer Belegpfad (nur gesetzt, wenn bisher leer) und Notiz. */
const VERKNUEPFUNG: { id: number; pfad?: string; notiz: string }[] = [
  { id: 74, pfad: `${A}/N24/2025-01-10_N24_Stadt-Tuttlingen_Grundsteuerbescheid-2025.pdf`,
    notiz: 'BELEG GEFUNDEN: Jahresbescheid 2025 vom 10.01.2025, Buchungszeichen 5.0100.004115.6 (Kassenzeichen 501000041156), Grundsteuer B 598,30 €. Quelle: Mail Buchhaltung „Rg." vom 26.01.2025. Raten bezahlt 17.02., 15.05., 15.08., 17.11.2025.' },
  { id: 76, pfad: `${A}/N24/2025-02-06_N24_Vohrer-Helvetia_Beitragserhebung-Wohngebaeude-2025.pdf`,
    notiz: `BELEG GEFUNDEN: Beitragserhebung 2025/000821926 vom 06.02.2025 (Helvetia, Vertrag 130010036764412612, 01.01.2025–01.01.2026) 4.810,86 € + Nachtrag 2025/000836053 vom 04.04.2025 (Erhöhung Versicherungssumme) 561,14 € = 5.372,00 €; bezahlt 21.03. und 22.04.2025. Nachtrag: ${A}/N24/2025-04-04_N24_Vohrer-Helvetia_Nachtrag-Wohngebaeude-2025.pdf` },
  { id: 75,
    notiz: `BESCHEID NICHT GEFUNDEN. Beleg zweiter Klasse: Zahlung 938,40 € am 16.04.2025 (Kontoumsatz La Perla „Bz. 73 056 921 / 001", DATEV-Konto 4969, Beleg 73056921/001 vom 14.03.2025). Zuordnung zu N24 bestätigt die Mahnung 2026: ${A}/N24/2026-06-05_N24_Landratsamt-Tuttlingen_Abfall-Mahnung-2026-Aktenzeichen.pdf` },
  { id: 44, notiz: `Kopie des Belegs: ${A}/N24/2025-03-25_N24_FP-Blitzschutz_RE-2251343-Pruefung.pdf` },
  { id: 43, notiz: `Kopie des Belegs: ${A}/N24/2024-08-11_N24_Tuerenstudio-Geiger_RE-2406130-Wartung-Brandschutztueren-2025.pdf. ABWEICHUNG: Zahlung und DATEV-Liste nennen die Rechnungsnummer 2508123; ein PDF mit dieser Nummer wurde nicht gefunden.` },
  { id: 54, notiz: 'BELEGSUCHE 27.10.2026: kein Beleg und keine Zahlung gefunden. Die DATEV-Liste N24 2025 enthält nur „bikolino, Verwaltungskosten" 300 €/Monat netto (RE 4000089–4000117); ob der Hauswart darin steckt, ist unbekannt.' },
  { id: 80, pfad: `${A}/MG24/2025-01-10_MG24_Stadt-Tuttlingen_Grundsteuerbescheid-2025-Flst239.pdf`,
    notiz: `BELEG GEFUNDEN, ABWEICHUNG: Der Bescheid vom 10.01.2025 (Buchungszeichen 5.0100.043280.5, Marktgasse 24, Flst. 239) setzt für 2025 905,45 € fest. Gebucht sind 409,45 € nach der DATEV-Aufteilung (L19 496,95 €). Betrag NICHT geändert — klären. Flst. 239/4 (438,82 €): ${A}/MG24/2025-01-10_MG24_Stadt-Tuttlingen_Grundsteuerbescheid-2025-Flst239-4.pdf` },
  { id: 4, pfad: `${A}/MG24/2025-10-27_MG24_Boertzler_R25-2820-Kehrrechnung.pdf`,
    notiz: `BELEG GEFUNDEN: R25/2820 vom 27.10.2025, 75,70 €; bezahlt 15.12.2025 in einer Sammelüberweisung 269,81 € (75,70 + 5,05 Mahngebühr + 189,06 ista; DATEV Konto 1200). HINWEIS: 2025 gab es eine ZWEITE Kehrrechnung R25/807 vom 31.03.2025 über 75,70 € (bezahlt 15.05.2025 mit 80,75 € inkl. Mahngebühr), nicht gebucht: ${A}/MG24/2025-03-31_MG24_Boertzler_R25-807-Kehrrechnung.pdf. Feuerstättenbescheid 718.000-4-1 vom 19.11.2024: ${A}/MG24/2024-11-19_MG24_Boertzler_Feuerstaettenbescheid-718.000-4-1-und-R24-2702.pdf (Seiten 6–7).` },
  { id: 5, pfad: `${A}/MG24/2025-04-09_MG24_Landratsamt-Tuttlingen_Abfallgebuehrenbescheid-2025-419.pdf`,
    notiz: 'ERSTE RATE GEFUNDEN: Bescheid vom 09.04.2025 über 419,00 € (Bz. 73 058 488/001); bezahlt 15.05.2025 in einer Sammelüberweisung vom Mietkonto (DATEV Konto 1200, Beleg 73058488/001). Mit 511,00 € am 16.09.2025 ist die Jahresgebühr 930,00 € damit vollständig bezahlt.' },
];

async function main(): Promise<void> {
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const p = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      for (const v of p.vorher) await client.query('UPDATE expense_bookings SET document_path = $2, notes = $3 WHERE id = $1', [v.id, v.document_path, v.notes]);
      await client.query('COMMIT');
      await audit.log({ actor: AKTOR, module: 'nk', action: 'belege_nk2025.rueckweg', entityType: 'expense_bookings', entityId: path.basename(process.argv[rueckIdx + 1]), before: null, after: { zeilen: p.vorher.length }, source: 'cc' });
      console.log(`Rückweg: ${p.vorher.length} Buchungen zurückgesetzt`);
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe, --ausfuehren oder --rueckweg <datei>');
    await client.query('BEGIN');
    const vorher: any[] = []; const auditListe: any[] = [];
    for (const v of VERKNUEPFUNG) {
      const z = (await client.query('SELECT id, document_path, notes FROM expense_bookings WHERE id = $1 FOR UPDATE', [v.id])).rows[0];
      if (!z) throw new Error(`Buchung ${v.id} fehlt`);
      vorher.push(z);
      // Einen vorhandenen Belegpfad nie überschreiben — dann nur die Notiz.
      const pfad = z.document_path || v.pfad || null;
      const notes = `${z.notes ? z.notes + '\n\n' : ''}[27.10.2026, ${QUELLE}] ${v.notiz}`;
      await client.query('UPDATE expense_bookings SET document_path = $2, notes = $3, updated_at = now() WHERE id = $1', [v.id, pfad, notes]);
      auditListe.push({ actor: AKTOR, module: 'nk', action: 'belege_nk2025.verknuepfen', entityType: 'expense_bookings', entityId: String(v.id),
        before: { document_path: z.document_path }, after: { document_path: pfad, notiz: v.notiz }, source: 'cc' });
      console.log(`${v.id}: Pfad ${z.document_path ? 'blieb' : pfad ? 'gesetzt' : 'leer'}, Notiz ergänzt`);
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
