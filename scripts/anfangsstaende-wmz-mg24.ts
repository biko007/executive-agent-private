/**
 * scripts/anfangsstaende-wmz-mg24 — Anfangsstände der Wärmemengenzähler zum
 * 01.01.2025 aus dem GLT-Jahreszähler ableiten und erfassen.
 *
 * HERLEITUNG. Die Gebäudeleittechnik zeigt je Zähler drei Spalten:
 * „Stand" (kumuliert), „Jahr aktuell" (laufendes Jahr bis zum Ablesetag) und
 * „Vorjahr". Dass „Vorjahr" ein echter JAHRESZÄHLER ist und nicht der Stand
 * zum Jahreswechsel, ist in Paket 2 (Abschnitt 1f) am Kaltwasser-Hausanschluss
 * bewiesen: Dort ergibt Stand − Jahr aktuell = 105,4 m³, die GLT nennt als
 * Vorjahr aber 38,5 m³. Die Spalte zählt also den Jahresverbrauch.
 *
 * Damit gilt für jeden Zähler:
 *
 *     Stand(01.01.2025) = Stand(Ablesetag) − Jahr aktuell − Vorjahr
 *
 * Quelle der Zahlen: Owner-Ablesung an der GLT (Schneider-Panel
 * TPC230390-ISP01, Anlage „Badhaus Tuttlingen") vom 10.10.2026, übergeben im
 * Auftrag paket2-nachtrag-glt-zaehlerstaende-20261010.
 *
 * Geschrieben wird ausschließlich über die bestehende Core-Route
 * `POST /api/assets/meters/:id/readings/bulk` — mit Idempotency-Key und
 * Audit-Eintrag. Kein Direktschreiben an der Datenbank.
 *
 * Aufruf:  bun run scripts/anfangsstaende-wmz-mg24.ts [--apply]
 * Ohne `--apply` wird nur gerechnet und angezeigt.
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

/** Die acht Wärmemengenzähler aus der GLT-Ablesung vom 10.10.2026. */
const GLT_ABLESUNG: { zaehler: string; stand: number; jahrAktuell: number; vorjahr: number }[] = [
  { zaehler: 'MG24-WMZ-HEIZUNG-GESAMT', stand: 76717, jahrAktuell: 22388, vorjahr: 54329 },
  { zaehler: 'MG24-WMZ-WARMWASSER-GESAMT', stand: 19524, jahrAktuell: 10373, vorjahr: 9151 },
  { zaehler: 'MG24-W1-WMZ-SW', stand: 13730, jahrAktuell: 4313, vorjahr: 9417 },
  { zaehler: 'MG24-W1-WMZ-NO', stand: 9872, jahrAktuell: 2272, vorjahr: 7600 },
  { zaehler: 'MG24-W2-WMZ-SW', stand: 10670, jahrAktuell: 3208, vorjahr: 7462 },
  { zaehler: 'MG24-W2-WMZ-NO', stand: 13975, jahrAktuell: 3560, vorjahr: 10415 },
  { zaehler: 'MG24-W3-WMZ-SW', stand: 165, jahrAktuell: 22, vorjahr: 143 },
  { zaehler: 'MG24-W3-WMZ-NO', stand: 1308, jahrAktuell: 671, vorjahr: 637 },
];

const ABLESETAG = '2026-10-10';
const STICHTAG = '2025-01-01';

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt`);
  return treffer[1];
}

async function main() {
  const anwenden = process.argv.includes('--apply');
  const token = env('CORE_SERVICE_TOKEN');

  const { rows: zaehler } = await dbQuery<any>(
    `SELECT m.id, m.meter_number FROM meters m
       LEFT JOIN units u ON u.id = m.unit_id
      WHERE (m.property_id = 2 OR u.property_id = 2) AND m.medium = 'heat'`);
  const idVon = new Map(zaehler.map(z => [z.meter_number, z.id]));

  let angelegt = 0;
  for (const g of GLT_ABLESUNG) {
    const id = idVon.get(g.zaehler);
    if (!id) { console.log(`FEHLT in der Datenbank: ${g.zaehler}`); continue; }

    const anfang = g.stand - g.jahrAktuell - g.vorjahr;
    const hinweis = anfang < 0 ? '  ← NEGATIV, nicht erfassen' : '';
    console.log(
      `${g.zaehler.padEnd(26)} ${String(g.stand).padStart(6)} − ${String(g.jahrAktuell).padStart(6)}`
      + ` − ${String(g.vorjahr).padStart(6)} = ${String(anfang).padStart(6)} kWh${hinweis}`);
    if (anfang < 0) continue;

    /* Schon vorhanden? Der Lauf muss wiederholbar sein, ohne zwei Stände zum
       selben Tag zu erzeugen. */
    const { rows: vorhanden } = await dbQuery<any>(
      `SELECT id, value FROM meter_readings
        WHERE meter_id = $1 AND read_at::date = $2::date`, [id, STICHTAG]);
    if (vorhanden.length > 0) {
      console.log(`   bereits erfasst (${vorhanden[0].value}) — übersprungen`);
      continue;
    }
    if (!anwenden) continue;

    const antwort = await fetch(
      `http://127.0.0.1:18789/api/assets/meters/${id}/readings/bulk`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${token}`,
          'Idempotency-Key': `wmz-anfang-${g.zaehler}-${STICHTAG}`,
        },
        body: JSON.stringify({
          readings: [{
            value: anfang,
            unit: 'kWh',
            reading_type: 'annual',
            read_at: `${STICHTAG}T00:00:00+01:00`,
            source: 'manual',
            reader_name: 'GLT-Jahreszähler',
            is_estimated: false,
            notes: `Anfangsstand ${STICHTAG}, abgeleitet aus der GLT-Ablesung vom ${ABLESETAG}: `
              + `Stand ${g.stand} − Jahr aktuell ${g.jahrAktuell} − Vorjahr ${g.vorjahr} = ${anfang} kWh. `
              + 'Die Spalte „Vorjahr" ist ein echter Jahreszähler (Nachweis: Paket 2, Abschnitt 1f, '
              + 'Kaltwasser-Hausanschluss).',
          }],
        }),
      });
    if (!antwort.ok) {
      console.log(`   FEHLER ${antwort.status}: ${(await antwort.text()).slice(0, 200)}`);
      continue;
    }
    angelegt++;
    console.log('   erfasst');
  }

  console.log(anwenden ? `\n${angelegt} Anfangsstände erfasst.` : '\nProbelauf — nichts geschrieben.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
