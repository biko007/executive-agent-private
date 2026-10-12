/**
 * scripts/umlage-kosten-n24-2025 — Umlageregeln, Kostenbuchungen und die
 * Stände des Gemeindewasserzählers für N24 2025.
 *
 * UMLAGEREGELN. Vorbild ist die Nebenkostenabrechnung 2024, die eddi24 für
 * dieselbe Liegenschaft erstellt hat (Objekt 0030757-2, erstellt 27.01.2026).
 * Dort kommen drei Schlüssel vor:
 *
 *   NHN  Nutzfläche Hausnebenkosten [qm]      → bikosoc `sqm`
 *   VKW  Verbrauch Kaltwasser [cbm]           → bikosoc `consumption`
 *   WNZ  Wohnungen nach Nutzungszeit          → bikosoc `units`
 *
 * Heizung und Warmwasser laufen über `heating_split` 0/100, wie in der
 * Heizkostenabrechnung 2024 derselben Liegenschaft.
 *
 * KOSTENBUCHUNGEN. Gebucht wird nur, was belegt ist. Für 2025 liegen drei
 * SWT-Rechnungen vor; der Betrag jeder Buchung steht wörtlich als
 * Zeitraumzeile in der Rechnung. Nicht hochgerechnet und nicht geschätzt:
 *
 *   - Der Leistungszeitraum ist der abgerechnete Zeitraum, nicht der Zahltag.
 *     Die Wasserendabrechnung für Oktober bis Dezember 2025 wurde erst im
 *     März 2026 abgebucht.
 *   - Gebucht wird die Rechnungssumme, nicht der Zahlbetrag. Abschläge sind
 *     Vorauszahlungen und keine Kostenminderung.
 *   - Eine Rechnung über zwei Kalenderjahre wird an der Jahresgrenze geteilt,
 *     und zwar an den Zeitraumzeilen der Rechnung selbst. Tageweise zu
 *     verteilen wäre hier falsch: Die Wassermenge und der Preis je m³ sind in
 *     den Teilzeiträumen unterschiedlich.
 *
 * GEMEINDEWASSERZÄHLER. Der Zähler 8AXI1005533567 ist der Nenner für Wasser
 * und Entwässerung. Abgelesen wurde er zweimal: am 15.10.2024 mit 301,661 m³
 * und am 22.09.2025 mit 774,297 m³. Jeder Stand zum Jahreswechsel ist eine
 * Hochrechnung — und drei Stellen rechnen unterschiedlich hoch:
 *
 *   Casameta / eddi24   31.12.2024  401,661 m³   (301,661 + 100)
 *   Owner-Tabelle       31.12.2024  406,661 m³   (301,661 + 75/337 × 472,636)
 *   Stadtwerke          01.01.2025  408,000 m³   (Systemhochrechnung)
 *
 * Für die Verteilung zählt die ABGERECHNETE Menge: Jede Wohnung zahlt ihre
 * gemessene Menge zum Rechnungspreis, der ungemessene Rest bleibt beim
 * Eigentümer. Deshalb wird das Paar der Stadtwerke erfasst — 408,000 zum
 * 01.01.2025 und 954,576 zum 31.12.2025 —, denn genau diese Differenz von
 * 546,576 m³ haben die Stadtwerke in Rechnung gestellt. Beide Werte sind als
 * Hochrechnung gekennzeichnet (`is_estimated`). Die echte Ablesung vom
 * 22.09.2025 wird zusätzlich erfasst; sie liegt innerhalb des Jahres und
 * verändert die Jahresmenge nicht, belegt aber den Verlauf.
 *
 * Geschrieben wird ausschließlich über die bestehenden Core-Routen mit
 * Audit-Eintrag. Mehrfacher Aufruf ist unschädlich: Regeln, Buchungen und
 * Stände werden erkannt und übersprungen.
 *
 * Aufruf:  bun run scripts/umlage-kosten-n24-2025.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';
const OBJEKT_ID = 4;
const OBJEKT_CODE = 'n24';
const AB = '2025-01-01';

/** Ordner, in dem die SWT-Belege liegen (Dropbox, privater App-Ordner). */
const BELEGE = '/Apps/bikosoc-reports/bikosoc-reports/transfer/SWT-Rechnungen';

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt`);
  return treffer[1].trim();
}

async function ruf(pfad: string, methode = 'GET', rumpf?: unknown, idempotenz?: string) {
  const res = await fetch(`${BASIS}${pfad}`, {
    method: methode,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env('CORE_SERVICE_TOKEN')}`,
      'X-Actor': 'owner',
      ...(idempotenz ? { 'Idempotency-Key': idempotenz } : {}),
    },
    ...(rumpf ? { body: JSON.stringify(rumpf) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${methode} ${pfad} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ── 1. Umlageregeln ────────────────────────────────────────────────────────

interface Regel {
  kostenart: string;
  key_type: 'sqm' | 'units' | 'consumption' | 'heating_split';
  grundanteil?: number;
  verbrauchsanteil?: number;
  /** Bezeichnung und Schlüssel in der eddi24-Abrechnung 2024. */
  herkunft: string;
}

const REGELN: Regel[] = [
  { kostenart: 'grundsteuer', key_type: 'sqm', herkunft: 'eddi24 2024 "Grundsteuer", Schlüssel NHN (Nutzfläche)' },
  {
    kostenart: 'entwaesserung', key_type: 'sqm',
    herkunft: 'eddi24 2024 "Grundstücksentwässerung", Schlüssel NHN (Nutzfläche). '
      + 'ABWEICHUNG ZU MG24: Dort verteilt die Entwässerung nach Verbrauch '
      + '(Owner-Entscheidung 10.10.2026), weil die Schmutzwassergebühr nach der '
      + 'Frischwassermenge bemessen wird. Hier ist bewusst das Bestandsverfahren '
      + 'von eddi24 übernommen.',
  },
  { kostenart: 'hauswart', key_type: 'sqm', herkunft: 'eddi24 2024 "Hauswart", Schlüssel NHN' },
  {
    kostenart: 'wasser', key_type: 'consumption',
    herkunft: 'eddi24 2024 "Kaltwasser", Schlüssel VKW (Verbrauch Kaltwasser). '
      + 'bikosoc zählt dafür nur die Kaltwasserzähler der Wohnungen — die '
      + 'Warmwasserzähler messen in diesem Haus Energie, kein Volumen.',
  },
  { kostenart: 'strassenreinigung_muell', key_type: 'sqm', herkunft: 'eddi24 2024 "Müllabfuhr", Schlüssel NHN' },
  { kostenart: 'niederschlagswasser', key_type: 'sqm', herkunft: 'eddi24 2024 "Niederschlagswasser", Schlüssel NHN' },
  {
    kostenart: 'sonstige_betrkv', key_type: 'sqm',
    herkunft: 'eddi24 2024 "Sonstige Kosten" 1 bis 5, Schlüssel NHN: Torwartung (Bauer), '
      + 'Wartung Türanlagen (Eckermann), Flachdachwartung (Haller & Gabele), '
      + 'Heizungswartung (Maurer).',
  },
  {
    kostenart: 'aufzug', key_type: 'units',
    herkunft: 'eddi24 2024 "Wartung Fahrstuhl" (Schmitt+Sohn), Schlüssel WNZ '
      + '(Wohnungen nach Nutzungszeit) — in bikosoc `units`, zeitanteilig je Wohnung.',
  },
  { kostenart: 'versicherung', key_type: 'sqm', herkunft: 'eddi24 2024 "Wohngebäudeversicherung", Schlüssel NHN' },
  {
    kostenart: 'heizung', key_type: 'heating_split', grundanteil: 0, verbrauchsanteil: 100,
    herkunft: 'Heizkostenabrechnung eddi24 2024: 0 % Nutzfläche, 100 % Verbrauch',
  },
  {
    kostenart: 'warmwasser', key_type: 'heating_split', grundanteil: 0, verbrauchsanteil: 100,
    herkunft: 'Heizkostenabrechnung eddi24 2024: 0 % Nutzfläche, 100 % Verbrauch',
  },
];

// ── 2. Kostenbuchungen 2025 ────────────────────────────────────────────────

interface Buchung {
  source_key: string;
  kostenart: string;
  betrag: number;
  von: string;
  bis: string;
  rechnungsnummer: string;
  rechnungsdatum: string;
  zahltag: string;
  beleg: string;
  notiz: string;
}

const BUCHUNGEN: Buchung[] = [
  {
    source_key: 'n24-2025-swt-wasser-q1q3', kostenart: 'wasser', betrag: 1048.48,
    von: '2025-01-01', bis: '2025-09-30',
    rechnungsnummer: '0001-ARV-2025-22056', rechnungsdatum: '2025-11-10', zahltag: '2025-11-26',
    beleg: `${BELEGE}/SWT_2025-11-10_Nonnenburgstr_24_331631_0001-ARV-2025-22056.pdf`,
    notiz: 'SWT Wasser, Kd 492014-331631, Vertrag 187067. Zeitraumzeile der Rechnung für '
      + '01.01.2025 bis 30.09.2025: 380 m³ × 2,470 EUR = 938,60 plus Messpreis '
      + '55,20 × 273/365 = 41,29, netto 979,89 plus 7 % USt 68,59. Die Rechnung umfasst '
      + 'insgesamt 01.10.2024 bis 30.09.2025; der Anteil 2024 ist nicht gebucht. '
      + 'Zähler 8AXI1005533567.',
  },
  {
    source_key: 'n24-2025-swt-wasser-q4', kostenart: 'wasser', betrag: 453.61,
    von: '2025-10-01', bis: '2025-12-31',
    rechnungsnummer: '0001-ARV-2025-38715', rechnungsdatum: '2026-02-19', zahltag: '2026-03-09',
    beleg: `${BELEGE}/SWT_2026-02-19_Nonnenburgstr_24_331631_0001-ARV-2025-38715.pdf`,
    notiz: 'SWT Wasser, Endabrechnung 01.10.2025 bis 31.12.2025: 166 m³ × 2,470 EUR = '
      + '410,02 plus Messpreis 55,20 × 92/365 = 13,91, netto 423,93 plus 7 % USt 29,68.',
  },
  {
    source_key: 'n24-2025-swt-schmutzwasser-q1q3', kostenart: 'entwaesserung', betrag: 874.00,
    von: '2025-01-01', bis: '2025-09-30',
    rechnungsnummer: '0001-ARV-2025-22056', rechnungsdatum: '2025-11-10', zahltag: '2025-11-26',
    beleg: `${BELEGE}/SWT_2025-11-10_Nonnenburgstr_24_331631_0001-ARV-2025-22056.pdf`,
    notiz: 'Schmutzwassergebühr, im Namen der Stadt Tuttlingen erhoben, Vertrag 187068. '
      + 'Zeitraumzeile 01.01.2025 bis 30.09.2025: 380 m³ × 2,30 EUR, ohne USt. '
      + 'Bemessung ist die Frischwassermenge.',
  },
  {
    source_key: 'n24-2025-swt-schmutzwasser-q4', kostenart: 'entwaesserung', betrag: 381.80,
    von: '2025-10-01', bis: '2025-12-31',
    rechnungsnummer: '0001-ARV-2025-38715', rechnungsdatum: '2026-02-19', zahltag: '2026-03-09',
    beleg: `${BELEGE}/SWT_2026-02-19_Nonnenburgstr_24_331631_0001-ARV-2025-38715.pdf`,
    notiz: 'Schmutzwassergebühr, Endabrechnung 01.10.2025 bis 31.12.2025: '
      + '166 m³ × 2,30 EUR, ohne USt.',
  },
  {
    source_key: 'n24-2025-swt-niederschlagswasser', kostenart: 'niederschlagswasser',
    betrag: 479.70, von: '2025-01-01', bis: '2025-12-31',
    rechnungsnummer: '0001-ARV-2025-45059', rechnungsdatum: '2026-03-03', zahltag: '2026-03-19',
    beleg: `${BELEGE}/SWT_2026-03-03_Nonnenburgstr_24_334364_0001-ARV-2025-45059.pdf`,
    notiz: 'Niederschlagswassergebühr 2025, Kd 527415-334364 (La Perla GmbH), ohne USt. '
      + 'Drei Grundstücke zu 0,65 EUR/m² für 365/365 Tage: Flurstück 1125/1 mit 546 m² = '
      + '354,90, Flurstück 1123/10 "Garten" mit 15 m² = 9,75, Flurstück 1128/13 '
      + '"Stellplätze" mit 177 m² = 115,05. Die Rechnung umfasst 16.11.2024 bis '
      + '31.12.2025; der Anteil 2024 (54,73) ist nicht gebucht. Bemessung ist die '
      + 'versiegelte Fläche, nicht der Wasserverbrauch.',
  },
];

// ── 3. Stände des Gemeindewasserzählers ────────────────────────────────────

interface Stand {
  tag: string;
  wert: number;
  geschaetzt: boolean;
  methode: string | null;
  leser: string;
  notiz: string;
}

const WASSERSTAENDE: Stand[] = [
  {
    tag: '2025-01-01', wert: 408.000, geschaetzt: true,
    methode: 'Systemhochrechnung der Stadtwerke Tuttlingen',
    leser: 'SWT-Rechnung 0001-ARV-2025-22056',
    notiz: 'Anfangsstand 2025 laut SWT-Jahresrechnung vom 10.11.2025, Ablesekennzeichen '
      + '"Hochrechnung System". Grundlage ist die echte Ablesung 301,661 m³ am '
      + '15.10.2024. KEINE Ablesung. Erfasst, weil die Stadtwerke die Differenz zum '
      + 'Stand 31.12.2025 (954,576) in Rechnung gestellt haben: 546,576 m³. Casameta '
      + 'führt zum 31.12.2024 abweichend 401,661 m³, die Owner-Tabelle 406,661 m³ — '
      + 'drei Hochrechnungen derselben Lücke.',
  },
  {
    tag: '2025-09-22', wert: 774.297, geschaetzt: false,
    methode: null,
    leser: 'Owner-Ablesung vor Ort',
    notiz: 'ECHTE Ablesung am 22.09.2025, dokumentiert in '
      + '"N24/Nebenkosten/2024/2024 Nebenkosten_N24.xlsx", Blatt "Energie" '
      + '("Zählerstand Wasser Ablesung 22.09.2025"). Gegenüber der echten Ablesung '
      + '301,661 m³ vom 15.10.2024 ergibt das 472,636 m³ in 337 Tagen, also '
      + '1,40 m³ je Tag. Liegt innerhalb des Abrechnungsjahres und verändert die '
      + 'Jahresmenge nicht; belegt aber den Verlauf und zeigt, dass die SWT-Hochrechnung '
      + 'für den 30.09.2025 (788,446 m³) über dem gemessenen Verlauf liegt.',
  },
  {
    tag: '2025-12-31', wert: 954.576, geschaetzt: true,
    methode: 'Systemhochrechnung der Stadtwerke Tuttlingen',
    leser: 'SWT-Endabrechnung 0001-ARV-2025-38715',
    notiz: 'Endstand 2025 laut SWT-Endabrechnung vom 19.02.2026, Ablesekennzeichen '
      + '"Hochrechnung". KEINE Ablesung. Dies ist der Stand, mit dem die Stadtwerke '
      + 'abgerechnet haben; er ist deshalb der Nenner für Wasser und Entwässerung. '
      + 'Abgerechnete Menge 2025: 546 m³ (380 m³ für Januar bis September, 166 m³ für '
      + 'Oktober bis Dezember).',
  },
];

async function main() {
  const anwenden = process.argv.includes('--apply');

  const { rows: arten } = await dbQuery<any>('SELECT id, code FROM cost_categories');
  const artId = new Map<string, number>(arten.map(a => [a.code, a.id]));

  // ── Regeln ───────────────────────────────────────────────────────────────
  const bestehende: any[] = await ruf(`/api/assets/properties/${OBJEKT_CODE}/allocation-rules`);
  const hatRegel = new Set(bestehende.map(r => r.cost_category_code));
  let neueRegeln = 0;
  console.log('Umlageregeln:');
  for (const r of REGELN) {
    const cid = artId.get(r.kostenart);
    if (!cid) throw new Error(`Kostenart ${r.kostenart} unbekannt`);
    if (hatRegel.has(r.kostenart)) { console.log(`  besteht  ${r.kostenart}`); continue; }
    const anteil = r.key_type === 'heating_split' ? ` ${r.grundanteil}/${r.verbrauchsanteil}` : '';
    console.log(`  anlegen  ${r.kostenart.padEnd(24)} ${r.key_type}${anteil}`);
    if (!anwenden) continue;
    await ruf(`/api/assets/properties/${OBJEKT_CODE}/allocation-rules`, 'POST', {
      cost_category_id: cid,
      key_type: r.key_type,
      base_share_percent: r.grundanteil ?? null,
      consumption_share_percent: r.verbrauchsanteil ?? null,
      valid_from: AB,
      source: 'eddi24-Abrechnung 2024, Objekt 0030757-2 (Auftrag n24-kosten-umlage-2025-20261012)',
      notes: r.herkunft,
    });
    neueRegeln++;
  }

  // ── Buchungen ────────────────────────────────────────────────────────────
  const vorhandeneB: any[] = await ruf(`/api/assets/properties/${OBJEKT_CODE}/expense-bookings`);
  const hatBuchung = new Set(vorhandeneB.map(b => b.source_key));
  let neueBuchungen = 0;
  console.log('\nKostenbuchungen 2025:');
  for (const b of BUCHUNGEN) {
    if (hatBuchung.has(b.source_key)) { console.log(`  besteht  ${b.source_key}`); continue; }
    console.log(`  ${b.betrag.toFixed(2).padStart(9)} EUR  ${b.kostenart.padEnd(20)} `
      + `${b.von}..${b.bis}  ${b.rechnungsnummer}`);
    if (!anwenden) continue;
    await ruf(`/api/assets/properties/${OBJEKT_CODE}/expense-bookings`, 'POST', {
      source_key: b.source_key,
      cost_category_id: artId.get(b.kostenart),
      vendor_name: 'Stadtwerke Tuttlingen GmbH',
      invoice_number: b.rechnungsnummer,
      invoice_date: b.rechnungsdatum,
      service_period_start: b.von,
      service_period_end: b.bis,
      payment_date: b.zahltag,
      amount_gross: b.betrag,
      umlagefaehig: true,
      document_path: b.beleg,
      notes: b.notiz,
    });
    neueBuchungen++;
  }

  // ── Wasserzählerstände ───────────────────────────────────────────────────
  const { rows: zaehler } = await dbQuery<any>(
    'SELECT id FROM meters WHERE meter_number = $1 AND property_id = $2',
    ['N24-LS01-GEMEINDEWASSER', OBJEKT_ID]);
  if (zaehler.length === 0) throw new Error('Gemeindewasserzähler nicht gefunden');
  const meterId = zaehler[0].id;
  const { rows: da } = await dbQuery<any>(
    'SELECT read_at::date AS tag FROM meter_readings WHERE meter_id = $1', [meterId]);
  const schonDa = new Set(da.map(d => String(d.tag).slice(0, 10)));
  const offen = WASSERSTAENDE.filter(s => !schonDa.has(s.tag));
  let neueStaende = 0;
  console.log('\nGemeindewasserzähler:');
  for (const s of WASSERSTAENDE) {
    console.log(`  ${schonDa.has(s.tag) ? 'besteht ' : 'anlegen '} ${s.tag}  `
      + `${String(s.wert).padStart(9)} m³  ${s.geschaetzt ? 'Hochrechnung' : 'Ablesung'}`);
  }
  if (anwenden && offen.length > 0) {
    await ruf(`/api/assets/meters/${meterId}/readings/bulk`, 'POST', {
      readings: offen.map(s => ({
        value: s.wert,
        unit: 'm3',
        reading_type: s.tag === '2025-09-22' ? 'interim' : 'annual',
        read_at: `${s.tag}T00:00:00Z`,
        source: 'manual',
        reader_name: s.leser,
        is_estimated: s.geschaetzt,
        estimate_method: s.methode,
        estimate_reason: s.geschaetzt
          ? 'Zum Jahreswechsel wurde nicht abgelesen; die Stadtwerke rechnen den Stand hoch.'
          : null,
        notes: s.notiz,
      })),
    }, `n24-ls01-gemeindewasser-${offen.map(s => s.tag).join('-')}`);
    neueStaende = offen.length;
  }

  // ── Kontrollsummen ───────────────────────────────────────────────────────
  const summe = (art: string) => BUCHUNGEN.filter(b => b.kostenart === art)
    .reduce((s, b) => s + b.betrag, 0);
  console.log('\nKontrollsummen 2025:');
  console.log(`  Wasser         ${summe('wasser').toFixed(2)} EUR`);
  console.log(`  Entwässerung   ${summe('entwaesserung').toFixed(2)} EUR`);
  console.log(`  Niederschlag   ${summe('niederschlagswasser').toFixed(2)} EUR`);
  console.log(`  zusammen       ${BUCHUNGEN.reduce((s, b) => s + b.betrag, 0).toFixed(2)} EUR`);
  console.log(`  Wasser 2025 Menge laut Rechnungen: 380 + 166 = 546 m³`);
  console.log(`  Zählerdifferenz 954,576 − 408,000 = ${(954.576 - 408.0).toFixed(3)} m³`);

  console.log(anwenden
    ? `\n${neueRegeln} Regeln, ${neueBuchungen} Buchungen, ${neueStaende} Stände angelegt.`
    : '\nProbelauf — nichts geschrieben.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
