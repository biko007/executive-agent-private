/**
 * scripts/wechselstaende-n24-w6 — Zählerstände zum Nutzerwechsel in N24 W6.
 *
 * ANLASS. Das Mietverhältnis Schweigert-Hasi endete am 30.11.2025, Westhauser
 * zog am 01.12.2025 ein. Die Vorprüfung verlangt für jeden der sechs Zähler
 * eine Ablesung zum Vertragsende (± 3 Tage) und sperrt die Abrechnung 2025
 * sonst mit sechs Blockern.
 *
 * WELCHER WERT. Der M-Bus-Logger protokolliert WÖCHENTLICH, montags um
 * 00:00 Uhr. Die Aufzeichnung vom **01.12.2025, 00:00:20 Uhr** ist damit der
 * Stand am ENDE des 30.11.2025 — auf zwanzig Sekunden genau der
 * Vertragsschnitt. Besser geht es nicht; eine Ablesung genau zum Vertragsende
 * gibt es nicht und wird es nicht geben.
 *
 * Quelle sind die Exporte, die Fa. Maurer am 08.01.2026 aus dem Logger gezogen
 * hat — bereits entlang der Vertragsgrenze geteilt:
 *
 *   N24/N24 - Gebäudeakte/9. WebLog/2025_Export/
 *     2026-01-08_N24_E3_WHG6_Ost_01.12.2025 bis 31.12.2025_Westhauser.xlsx
 *     2026-01-08_N24_E3_WHG6_ELW_Ost_01.12.2025 bis 31.12.2025_Westhauser.xlsx
 *
 * Deren Anfangswerte sind die hier erfassten Stände.
 *
 * WARUM NICHT DIE ÜBERGABESTÄNDE. Die Owner-Entscheidung vom 12.10.2026 sah
 * vor, die Stände der Übergabe vom 15.11.2025 ersatzweise für den 30.11.2025
 * zu verwenden, weil der Verbrauch dazwischen vernachlässigbar sei. Ein Beleg
 * mit Ständen vom 15.11.2025 existiert nicht; dokumentiert sind der 27.10.2025
 * (Auszugsprotokoll Schweigert) und der 24.11.2025 (Protokoll vor Einzug
 * Westhauser). Vor allem aber ist die Annahme für die Wärme nicht haltbar: Die
 * Wohnung wurde weiter beheizt. Zwischen dem 24.11. und dem 01.12.2025 zählt
 * der Wärmemengenzähler 120 kWh, in der Einliegerwohnung 47 kWh. Mit den
 * Protokollständen trüge der Nachmieter diese 167 kWh.
 *
 * Mit dem Logger-Stand ist die Ersatzannahme nicht mehr nötig — gemessen geht
 * vor geschätzt.
 *
 * Geschrieben wird über `POST /api/assets/meters/:id/readings/bulk` mit
 * Idempotency-Key und Audit. Mehrfacher Aufruf ist unschädlich.
 *
 * Aufruf:  bun run scripts/wechselstaende-n24-w6.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';

/** Vertragsende Schweigert-Hasi; Mietbeginn Westhauser ist der Folgetag. */
const WECHSEL = '2025-11-30';

/**
 * Der Zeitpunkt der Logger-Aufzeichnung: 01.12.2025, 00:00:20 Uhr Ortszeit
 * (MEZ, UTC+1). In UTC ist das der 30.11.2025 um 23:00:20 Uhr — der Stand
 * fällt damit auch im Datum auf den letzten Tag des Mietverhältnisses.
 */
const ZEITPUNKT = '2025-11-30T23:00:20Z';

const QUELLE = 'N24/N24 - Gebäudeakte/9. WebLog/2025_Export/'
  + '2026-01-08_N24_E3_WHG6_{Ost|ELW_Ost}_01.12.2025 bis 31.12.2025_Westhauser.xlsx';

interface Wechselstand {
  zaehler: string;
  wert: number;
  einheit: 'kWh' | 'm3';
  bezeichnung: string;
  /** Stand im Auszugsprotokoll Schweigert vom 27.10.2025. */
  protokoll2710: number | null;
  /** Stand im Protokoll vor Einzug Westhauser vom 24.11.2025. */
  protokoll2411: number;
}

const STAENDE: Wechselstand[] = [
  { zaehler: '24454023', wert: 6521, einheit: 'kWh', bezeichnung: 'Heizung Hauptwohnung', protokoll2710: 6027, protokoll2411: 6401 },
  { zaehler: '24355989', wert: 921, einheit: 'kWh', bezeichnung: 'Warmwasser Hauptwohnung', protokoll2710: 817, protokoll2411: 917 },
  { zaehler: '02153079', wert: 81.31, einheit: 'm3', bezeichnung: 'Kaltwasser Hauptwohnung', protokoll2710: 81.033, protokoll2411: 81.108 },
  { zaehler: '24454030', wert: 778, einheit: 'kWh', bezeichnung: 'Heizung Einliegerwohnung', protokoll2710: 684, protokoll2411: 731 },
  { zaehler: '24355985', wert: 14, einheit: 'kWh', bezeichnung: 'Warmwasser Einliegerwohnung', protokoll2710: 14, protokoll2411: 14 },
  { zaehler: '02156403', wert: 5.07, einheit: 'm3', bezeichnung: 'Kaltwasser Einliegerwohnung', protokoll2710: 5.035, protokoll2411: 5.047 },
];

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt`);
  return treffer[1].trim();
}

async function main() {
  const anwenden = process.argv.includes('--apply');

  /* Die Grenzen für die Plausibilität: Ein Stand zum Nutzerwechsel muss
     zwischen dem Jahresanfangs- und dem Jahresendstand liegen. Liegt er
     daneben, stimmt etwas an der Zuordnung nicht — dann wird nichts
     geschrieben. */
  const { rows: zaehler } = await dbQuery<any>(
    `SELECT m.id, m.meter_number,
       (SELECT value FROM meter_readings r WHERE r.meter_id = m.id
         AND r.read_at::date = '2024-12-31') AS anfang,
       (SELECT value FROM meter_readings r WHERE r.meter_id = m.id
         AND r.read_at::date = '2025-12-31') AS ende,
       (SELECT count(*) FROM meter_readings r WHERE r.meter_id = m.id
         AND r.read_at::date = $1::date) AS schon_da
       FROM meters m JOIN units u ON m.unit_id = u.id
      WHERE u.code = 'W6' AND u.property_id = 4`, [WECHSEL]);
  const nach = new Map<string, any>(zaehler.map(z => [z.meter_number, z]));

  let geschrieben = 0;
  let fehler = 0;
  console.log(`Nutzerwechsel W6 zum ${WECHSEL} (Logger-Aufzeichnung 01.12.2025, 00:00:20 Uhr)\n`);
  console.log(`${'Zähler'.padEnd(10)} ${'Bezeichnung'.padEnd(28)} `
    + `${'31.12.24'.padStart(9)} ${'Wechsel'.padStart(9)} ${'31.12.25'.padStart(9)}  Prüfung`);

  for (const s of STAENDE) {
    const z = nach.get(s.zaehler);
    if (!z) { console.log(`${s.zaehler}  FEHLT in der Datenbank`); fehler++; continue; }
    const anfang = Number(z.anfang);
    const ende = Number(z.ende);
    const ok = s.wert >= anfang && s.wert <= ende;
    console.log(`${s.zaehler.padEnd(10)} ${s.bezeichnung.padEnd(28)} `
      + `${anfang.toFixed(3).padStart(9)} ${s.wert.toFixed(3).padStart(9)} `
      + `${ende.toFixed(3).padStart(9)}  ${ok ? 'plausibel' : 'AUSSERHALB — nicht erfasst'}`);
    if (!ok) { fehler++; continue; }
    if (Number(z.schon_da) > 0) { console.log('           bereits erfasst — übersprungen'); continue; }
    if (!anwenden) continue;

    const antwort = await fetch(`${BASIS}/api/assets/meters/${z.id}/readings/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env('CORE_SERVICE_TOKEN')}`,
        'X-Actor': 'owner',
        'Idempotency-Key': `n24-w6-wechsel-${s.zaehler}-${WECHSEL}`,
      },
      body: JSON.stringify({
        readings: [{
          value: s.wert,
          unit: s.einheit,
          reading_type: 'move_out',
          read_at: ZEITPUNKT,
          source: 'automatic',
          reader_name: 'M-Bus-Logger (Relay WebLog 250 TX8M)',
          is_estimated: false,
          notes: `Stand zum Nutzerwechsel am ${WECHSEL} (Vertragsende Schweigert-Hasi, `
            + 'Mietbeginn Westhauser 01.12.2025). Der Logger zeichnet wöchentlich montags '
            + 'um 00:00 Uhr auf; die Aufzeichnung vom 01.12.2025, 00:00:20 Uhr ist der '
            + 'Stand am Ende des 30.11.2025. Quelle: ' + QUELLE + ' (Export der Fa. Maurer '
            + 'vom 08.01.2026, bereits entlang der Vertragsgrenze geteilt). '
            + `Gegenprobe: Auszugsprotokoll Schweigert vom 27.10.2025 ${s.protokoll2710}, `
            + `Protokoll vor Einzug Westhauser vom 24.11.2025 ${s.protokoll2411}. `
            + 'Die Owner-Entscheidung vom 12.10.2026, ersatzweise die Übergabestände zu '
            + 'verwenden, ist damit nicht mehr nötig — hier ist gemessen, nicht ersetzt.',
        }],
      }),
    });
    if (!antwort.ok) {
      console.log(`           FEHLER ${antwort.status}: ${(await antwort.text()).slice(0, 200)}`);
      fehler++; continue;
    }
    geschrieben++;
  }

  console.log('\nVergleich der Quellen (Hauptwohnung + Einliegerwohnung, Wärme):');
  const summe = (f: (s: Wechselstand) => number) => STAENDE
    .filter(s => s.einheit === 'kWh' && s.bezeichnung.startsWith('Heizung'))
    .reduce((a, s) => a + f(s), 0);
  console.log(`  Protokoll 24.11.2025 : ${summe(s => s.protokoll2411)} kWh`);
  console.log(`  Logger 30.11.2025    : ${summe(s => s.wert)} kWh`);
  console.log(`  Differenz            : ${summe(s => s.wert) - summe(s => s.protokoll2411)} kWh `
    + 'zulasten des Vormieters statt des Nachmieters');

  if (fehler > 0) console.log(`\n${fehler} Zähler nicht erfasst.`);
  console.log(anwenden ? `\n${geschrieben} Wechselstände erfasst.` : '\nProbelauf — nichts geschrieben.');
  process.exit(fehler > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
