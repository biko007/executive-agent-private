#!/usr/bin/env bun
/**
 * Owner-Auftrag 30.10.2026 07:31 Berlin (Rüge „Schon wieder???“): veraltete NK-Frist energiekonzept
 * schliessen und offene Fristen gegen Gesendete Elemente (juergen.bickel@) abgleichen — Teil A, einmalig.
 *
 *   1. objekt_fristen #2 „energiekonzept: finale Jahresabrechnungen 2025 anmahnen (N24 und MG24)“ →
 *      erledigt_am 27.10.2026. Beleg: Mail „AW: Monatliche Verbrauchsinformation …“ an
 *      Abrechnung@ekonzept.eu, gesendet 27.10.2026 19:31:18 UTC.
 *   2. Neue Objektfrist N24 „energiekonzept: Antwort auf Mail vom 27.10. …“, Termin 10.11.2026
 *      (Frist aus dem Mailtext), Vorlauf 3 Tage.
 *   3. Sekretariat v-772abaee (ZZ5 Soleleitungen): Owner-Antwort an Kieninger am 28.10.2026 17:52:25 UTC
 *      gesendet („ja bitte bestellen und Termin einplanen“) → Status wartet, Folgefrist 11.11.2026
 *      „Antwort von Maurer“.
 *
 *   bun run scripts/fristen-abgleich-20261030.ts --probe | --ausfuehren | --rueckweg <sicherung.json>
 *
 * Vorher `bash scripts/cc-pre-backup.sh`. Sicherung ~/backups/fristen-abgleich-20261030/.
 * Report: report-fristen-abgleich-20261030.md.
 */
import { mkdirSync, writeFileSync, readFileSync, renameSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { closePool, getClient } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';

const SICHERUNG = path.join(homedir(), 'backups', 'fristen-abgleich-20261030');
const SEK = path.join(homedir(), '.openclaw/workspace/artifacts/personal/sekretariat');
const AKTOR = 'cc-bikosoc';
const QUELLE = 'Owner-Auftrag 30.10.2026 07:31 (Fristen-Abgleich)';
const STEMPEL = `[30.10.2026, ${QUELLE}]`;
const probe = process.argv.includes('--probe');
const ausfuehren = process.argv.includes('--ausfuehren');
const rueckIdx = process.argv.indexOf('--rueckweg');

const ALT_ID = 2;
const BELEG_EKO = 'Mail „AW: Monatliche Verbrauchsinformation per E-Mail und Zählerstände – Nonnenburgstraße 24 (Projekt 34101) und Marktgasse 24 (Projekt 39001)“ an Abrechnung@ekonzept.eu (Cc 4), gesendet 27.10.2026 19:31:18 UTC (20:31 Berlin), Gesendete Elemente juergen.bickel@, Message-ID <FR0P281MB1808C0756564F6C85456EF88FE602@FR0P281MB1808.DEUP281.PROD.OUTLOOK.COM>';
const NEU = {
  bezeichnung: 'energiekonzept: Antwort auf Mail vom 27.10. (4 Punkte, Schlussrechnungen N24/MG24)',
  termin: '2026-11-10',
  vorlauf: 3,
  notes: `${STEMPEL} Erwartet wird die Antwort von energiekonzept (Frau Schlager, Abrechnung@ekonzept.eu) auf die Mail vom 27.10.2026 19:31 UTC; Frist 10.11.2026 steht im Mailtext. Eingangsbestätigung EKO-Ticket#801567 am 28.10.2026 07:19 UTC. Vier Punkte: (1) Monatsend- und Jahresendstände 2026, künftig monatlich von wattline an data@bikolino.com; (2) Antragsentwurf für die Bewohner; (3) überarbeitete TEST-Abrechnung N24 (gemessene Stände, W6 ab 01.12.2025 über V012), bis dahin keine Freigabe, kein Versand; (4) Schlussrechnungen 2025 Allgemeinstrom 1LGZ0064308209 und Wärmepumpenstrom 1LGZ0064308208 mit Arbeits- und Grundpreis. Gilt für N24 und MG24 (Projekte 34101 und 39001). Nach Ablauf ohne Antwort: Nachfass vorschlagen.`,
};
const SEK_VORGANG = 'v-772abaee';
const SEK_FRIST = { angelegt: '2026-10-30T06:38:45.000Z', termin: '2026-11-11', was: 'Antwort von Maurer (Kieninger): Bestellung Soleflüssigkeit und Termin ZZ5', vorlaufTage: 3, an: ['martin.kieninger@maurer-schramberg.de'] };
const SEK_BELEG = 'Owner-Antwort „AW: 20261028 Austausch Soleflüssigkeit & Manometer“ an Martin.Kieninger@maurer-schramberg.de, gesendet 28.10.2026 17:52:25 UTC („ja bitte bestellen und Termin einplanen“)';

function schreibeAtomar(datei: string, inhalt: string) {
  writeFileSync(`${datei}.tmp`, inhalt);
  renameSync(`${datei}.tmp`, datei);
}

async function main() {
  const client = await getClient();
  try {
    if (rueckIdx > 0) {
      const s = JSON.parse(readFileSync(process.argv[rueckIdx + 1], 'utf-8'));
      await client.query('BEGIN');
      await client.query('UPDATE objekt_fristen SET erledigt_am = $2, notes = $3, updated_at = now() WHERE id = $1', [ALT_ID, s.alt.erledigt_am, s.alt.notes]);
      // Neue Frist nur löschen, solange sie unbearbeitet ist; sonst bleibt sie und der Rückweg meldet es.
      const { rowCount } = await client.query(
        `DELETE FROM objekt_fristen WHERE id = $1 AND erledigt_am IS NULL AND notes = $2`, [s.neuId, NEU.notes]);
      if (!rowCount) console.log(`Frist ${s.neuId} inzwischen bearbeitet — nicht gelöscht`);
      await client.query('COMMIT');
      /* Nur v-772abaee zurücksetzen, nicht die ganze Datei: spätere Stundenläufe
         hätten sonst ihre Vorgänge verloren (Review 30.10.2026). */
      const vDatei = path.join(SEK, 'vorgaenge.json');
      const d = JSON.parse(readFileSync(vDatei, 'utf-8'));
      const v = d.vorgaenge.find((x: any) => x.kennung === SEK_VORGANG);
      if (v) {
        for (const feld of ['status', 'wartetAuf', 'fristen', 'verweis', 'naechsterSchritt']) {
          if (s.sekVorher[feld] === undefined) delete v[feld]; else v[feld] = s.sekVorher[feld];
        }
        v.aktualisiert = new Date().toISOString();
        schreibeAtomar(vDatei, JSON.stringify(d, null, 2));
      }
      await audit.log({ actor: AKTOR, module: 'fristen', action: 'fristen_abgleich_20261030.rueckweg', entityType: 'objekt_frist',
        entityId: `${ALT_ID},${s.neuId}`, before: s, source: QUELLE });
      console.log('Rückweg ausgeführt (korrekturen.jsonl bleibt als Protokoll)');
      return;
    }
    if (!probe && !ausfuehren) throw new Error('--probe | --ausfuehren | --rueckweg <datei>');

    await client.query('BEGIN');
    const { rows: [alt] } = await client.query('SELECT * FROM objekt_fristen WHERE id = $1 FOR UPDATE', [ALT_ID]);
    if (!alt || alt.erledigt_am !== null || !/energiekonzept: finale Jahresabrechnungen 2025 anmahnen/.test(alt.bezeichnung)) throw new Error('Frist #2 nicht im erwarteten Zustand');
    const { rows: [dopp] } = await client.query(`SELECT count(*)::int n FROM objekt_fristen WHERE bezeichnung = $1`, [NEU.bezeichnung]);
    if (dopp.n) throw new Error('Neue Frist existiert schon');
    const notesNeu = `${alt.notes ?? ''}\n\nERLEDIGT ${STEMPEL}: angemahnt per ${BELEG_EKO}. Folgefrist „Antwort von energiekonzept“ bis 10.11.2026 angelegt.`;
    await client.query(`UPDATE objekt_fristen SET erledigt_am = DATE '2026-10-27', notes = $2, updated_at = now() WHERE id = $1`, [ALT_ID, notesNeu]);
    const { rows: [neu] } = await client.query(
      `INSERT INTO objekt_fristen (property_id, art, bezeichnung, termin, vorlauf_tage, verantwortlich, quelle, notes)
       VALUES ($1, 'wiedervorlage', $2, $3, $4, 'owner', $5, $6) RETURNING *`,
      [alt.property_id, NEU.bezeichnung, NEU.termin, NEU.vorlauf, `${QUELLE}; Folgefrist zu #${ALT_ID}`, NEU.notes]);
    console.log('alt', ALT_ID, '→ erledigt 2026-10-27; neu', neu.id, neu.termin, neu.bezeichnung);

    const vDatei = path.join(SEK, 'vorgaenge.json');
    const d = JSON.parse(readFileSync(vDatei, 'utf-8'));
    const v = d.vorgaenge.find((x: any) => x.kennung === SEK_VORGANG);
    if (!v || v.status !== 'offen') throw new Error(`${SEK_VORGANG} nicht offen`);
    const vorher = { status: v.status, wartetAuf: v.wartetAuf, fristen: v.fristen, verweis: v.verweis, naechsterSchritt: v.naechsterSchritt };
    const zeit = new Date().toISOString();
    Object.assign(v, {
      status: 'wartet', wartetAuf: 'Maurer: Bestellung Soleflüssigkeit und Termin',
      fristen: [...(v.fristen ?? []), SEK_FRIST],
      verweis: `${v.verweis ? `${v.verweis}; ` : ''}${SEK_BELEG}`,
      naechsterSchritt: `Owner-Antwort an Kieninger am 28.10.2026 gesendet (Bestellung und Termin freigegeben). Warten auf Auftragsbestätigung/Termin von Maurer; ohne Antwort bis 11.11.2026 nachfassen. Offen aus dem früheren Vorschlag: formelles Angebot mit Gesamtkosten wurde in der Antwort nicht verlangt.`,
      aktualisiert: zeit,
    });

    if (probe) {
      await client.query('ROLLBACK');
      console.log('Sekretariat (Probe):', JSON.stringify({ vorher, nachher: { status: v.status, fristen: v.fristen } }));
      console.log('Probe zurückgerollt, nichts geschrieben');
      return;
    }
    mkdirSync(SICHERUNG, { recursive: true });
    const stempel = zeit.replace(/[:.]/g, '-');
    const sekSicherung = path.join(SICHERUNG, `vorgaenge-${stempel}.json`);
    copyFileSync(vDatei, sekSicherung);
    await client.query('COMMIT');
    schreibeAtomar(vDatei, JSON.stringify(d, null, 2));
    const kor = { zeit, quelle: QUELLE, art: 'bestaetigt', bezug: [SEK_VORGANG],
      befund: `Owner-Antwort an Maurer (Kieninger) am 28.10.2026 gesendet: Bestellung Soleflüssigkeit und Termin freigegeben; Vorgang wartet, Folgefrist 11.11.2026.`,
      aenderung: { vorgang: SEK_VORGANG, status: 'wartet', wartetAuf: v.wartetAuf, fristen: v.fristen } };
    writeFileSync(path.join(SEK, 'korrekturen.jsonl'), JSON.stringify(kor) + '\n', { flag: 'a' });
    const datei = path.join(SICHERUNG, `sicherung-${stempel}.json`);
    writeFileSync(datei, JSON.stringify({ quelle: QUELLE, zeit, alt: { erledigt_am: alt.erledigt_am, notes: alt.notes }, neuId: neu.id, sekSicherung, sekVorher: vorher }, null, 1));
    await audit.log({ actor: AKTOR, module: 'fristen', action: 'frist.erledigt', entityType: 'objekt_frist', entityId: String(ALT_ID),
      before: { erledigt_am: null }, after: { erledigt_am: '2026-10-27', beleg: BELEG_EKO }, source: QUELLE });
    await audit.log({ actor: AKTOR, module: 'fristen', action: 'frist.angelegt', entityType: 'objekt_frist', entityId: String(neu.id),
      after: { bezeichnung: NEU.bezeichnung, termin: NEU.termin, vorlauf_tage: NEU.vorlauf, folge_von: ALT_ID }, source: QUELLE });
    await audit.log({ actor: AKTOR, module: 'sekretariat', action: 'frist.erledigt', entityType: 'sekretariat_vorgang', entityId: SEK_VORGANG,
      before: vorher, after: { status: 'wartet', fristen: v.fristen, beleg: SEK_BELEG }, source: QUELLE });
    console.log('ausgeführt; Sicherung', datei);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await closePool();
  }
}

await main();
