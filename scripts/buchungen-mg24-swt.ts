#!/usr/bin/env bun
/**
 * Richtet die MG24-Kostenbuchungen nach den echten SWT-Rechnungen aus
 * (Paket 3b, Teil B).
 *
 * Warum überhaupt eine Korrektur: In Paket 2 lagen die Rechnungen noch nicht
 * vor. Gebucht wurde deshalb der ZAHLBETRAG mit dem Zahlungsdatum als
 * Zeitraum. Beides ist für eine Nebenkostenabrechnung falsch:
 *
 *   - Der Zahlbetrag ist die Rechnungssumme MINUS der Abschläge. Kosten sind
 *     aber die Rechnungssumme; die Abschläge sind Vorauszahlungen und keine
 *     Kostenminderung. Standen Abschläge zusätzlich als eigene Buchung im
 *     Bestand, war die Summe zufällig richtig und die Zuordnung falsch.
 *   - Der Leistungszeitraum ist der abgerechnete Zeitraum, nicht der Zahltag.
 *     Die Wasserjahresrechnung für 2025 wurde im Februar 2026 abgebucht und lag
 *     damit im Abrechnungsjahr 2026 — also in keiner Abrechnung 2025.
 *
 * Außerdem war die Rechnung in EINER Buchung zusammengefasst, obwohl sie drei
 * Gebühren mit drei verschiedenen Verteilschlüsseln enthält: Wasser und
 * Schmutzwasser nach Verbrauch, Niederschlagswasser nach versiegelter Fläche.
 *
 * Alles läuft über die Core-Routen, damit jede Änderung im Audit-Log steht.
 * Mehrfacher Aufruf ist unschädlich: Buchungen werden über `source_key`
 * erkannt und dann übersprungen.
 *
 * Aufruf:
 *   bun run scripts/buchungen-mg24-swt.ts --dry-run
 *   bun run scripts/buchungen-mg24-swt.ts --apply
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const GATEWAY = process.env.OPENCLAW_GATEWAY || 'http://127.0.0.1:18789';
const OBJEKT = 'mg24';

function envWert(schluessel: string): string {
  if (process.env[schluessel]) return process.env[schluessel]!;
  const treffer = readFileSync(join(homedir(), '.config', 'openclaw', 'env'), 'utf-8')
    .match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in der Env-Datei`);
  return treffer[1].trim();
}
const TOKEN = envWert('CORE_SERVICE_TOKEN');

async function ruf(pfad: string, methode = 'GET', rumpf?: unknown) {
  const res = await fetch(`${GATEWAY}${pfad}`, {
    method: methode,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'X-Actor': 'owner',
    },
    ...(rumpf ? { body: JSON.stringify(rumpf) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${methode} ${pfad} → HTTP ${res.status}: ${text.slice(0, 250)}`);
  return text ? JSON.parse(text) : null;
}

// ── Stilllegen: Buchungen, die durch die Rechnungen ersetzt werden ──────────

interface Stilllegung { id: number; betrag: number; grund: string }

const STILLLEGEN: Stilllegung[] = [
  {
    id: 6, betrag: 210.00,
    grund: 'Vorauszahlung, keine Kostenposition: Die zehn Wasserabschläge 2025 sind in der '
      + 'Endabrechnung 0001-ARV-2025-32342 vom 18.02.2026 als "abzüglich angeforderte '
      + 'Abschläge -210,00" verrechnet. Die Kosten stehen jetzt in drei Buchungen aus '
      + 'dieser Rechnung. Stillgelegt am 11.10.2026 (Paket 3b B1).',
  },
  {
    id: 15, betrag: 2143.01,
    grund: 'Ersetzt durch drei Buchungen aus der Endabrechnung 0001-ARV-2025-32342. Diese '
      + 'Buchung trug den Zahlbetrag (2.353,01 minus 210,00 Abschläge) und als '
      + 'Leistungszeitraum das Jahr 2026 statt des abgerechneten Jahres 2025 — sie fiel '
      + 'damit aus jeder Abrechnung 2025 heraus. Stillgelegt am 11.10.2026 (Paket 3b B1).',
  },
  {
    id: 9, betrag: 1086.60,
    grund: 'Vorauszahlung, keine Kostenposition: Die Stromabschläge auf Vertrag 348661 sind '
      + 'in der Schlussrechnung 0001-ARV-2026-8728 vom 10.06.2026 als "abzüglich '
      + 'angeforderte Abschläge -1.360,00" verrechnet (darin 273,40 aus 2024). Die Kosten '
      + 'stehen jetzt in fünf Buchungen nach den Rechnungszeiträumen. '
      + 'Stillgelegt am 11.10.2026 (Paket 3b B3).',
  },
  {
    id: 16, betrag: 4102.08,
    grund: 'Ersetzt durch fünf Buchungen nach den Rechnungszeiträumen der Schlussrechnung '
      + '0001-ARV-2026-8728. Diese Buchung trug den Zahlbetrag und als Leistungszeitraum '
      + 'das Jahr 2026, obwohl die Rechnung den Zeitraum 16.11.2024 bis 20.08.2025 '
      + 'abrechnet. Stillgelegt am 11.10.2026 (Paket 3b B3).',
  },
];

// ── Neue Buchungen aus den Rechnungen ──────────────────────────────────────

interface NeueBuchung {
  source_key: string;
  kostenart: string;
  betrag: number;
  umlagefaehig: boolean;
  von: string;
  bis: string;
  rechnungsnummer: string;
  rechnungsdatum: string;
  zahltag: string | null;
  notiz: string;
}

const BUCHUNGEN: NeueBuchung[] = [
  // ── B1: Wasserendabrechnung 2025 ─────────────────────────────────────────
  {
    source_key: 'mg24-2025-swt-wasser', kostenart: 'wasser', betrag: 1214.01,
    umlagefaehig: true, von: '2025-01-01', bis: '2025-12-31',
    rechnungsnummer: '0001-ARV-2025-32342', rechnungsdatum: '2026-02-18', zahltag: '2026-03-06',
    notiz: 'SWT Endabrechnung Wasser 2025, Kd 133224-307008. 437 m³ x 2,470 EUR = 1.079,39 '
      + 'plus Messpreis 55,20, netto 1.134,59 plus 7 % USt 79,42. Zähler 8ZRI2316739802, '
      + 'Stand 14 auf 451 m³, Ablesekennzeichen "Ablesung Kunde". Verteilung nach den '
      + 'Wohnungszählern (consumption); der nicht gemessene Rest bleibt beim Eigentümer.',
  },
  {
    source_key: 'mg24-2025-swt-schmutzwasser', kostenart: 'entwaesserung', betrag: 1005.10,
    umlagefaehig: true, von: '2025-01-01', bis: '2025-12-31',
    rechnungsnummer: '0001-ARV-2025-32342', rechnungsdatum: '2026-02-18', zahltag: '2026-03-06',
    notiz: 'SWT Schmutzwassergebühr 2025 (im Namen der Stadt Tuttlingen erhoben). '
      + '437 m³ x 2,30 EUR, ohne USt. Bemessung ist die Frischwassermenge, daher '
      + 'dieselbe Verteilung wie beim Wasser.',
  },
  {
    source_key: 'mg24-2025-swt-niederschlagswasser', kostenart: 'niederschlagswasser',
    betrag: 133.90, umlagefaehig: true, von: '2025-01-01', bis: '2025-12-31',
    rechnungsnummer: '0001-ARV-2025-32342', rechnungsdatum: '2026-02-18', zahltag: '2026-03-06',
    notiz: 'SWT Niederschlagswassergebühr 2025: 206 m² versiegelte Fläche x 0,65 EUR x '
      + '365/365 Tage, ohne USt. Bemessung ist die versiegelte Fläche, nicht der '
      + 'Wasserverbrauch — deshalb eigene Kostenart und Verteilung nach Wohnfläche '
      + '(BetrKV §2 Nr. 3).',
  },

  // ── B2: Wasserabrechnung 2024 ────────────────────────────────────────────
  {
    source_key: 'mg24-2024-swt-wasser-gesamt', kostenart: 'wasser', betrag: 281.91,
    umlagefaehig: false, von: '2023-12-01', bis: '2024-12-31',
    rechnungsnummer: '0001-ARV-2024-31686', rechnungsdatum: '2025-01-30', zahltag: '2025-02-18',
    notiz: 'SWT Abrechnung 01.12.2023 bis 31.12.2024, Kd 133224-307008: Wasser 108,70 + '
      + 'Schmutzwasser 39,97 + Niederschlagswasser 133,24 = 281,91 brutto (Abschläge '
      + '233,00 waren verrechnet, Zahlbetrag 48,91). NICHT umlagefähig: Der Zeitraum liegt '
      + 'vor und um die Schlussabnahme vom 04.11.2024, MG24 war Bauphase und Leerstand. '
      + 'In diesem Zeitraum fand auch ein Zählerwechsel statt (8ZRI1814885533 auf '
      + '8ZRI2316739802). Als eine Buchung geführt, weil nichts verteilt wird.',
  },

  // ── B3: Stromschlussrechnung 348661, aufgeteilt nach Rechnungszeiträumen ─
  //
  // Die Aufteilung ist NICHT geschätzt: Die Rechnung weist je Zeitraum eigene
  // Preisblöcke aus. Die Nettosummen daraus sind 110,39 / 378,22 / 2.284,00 /
  // 1.817,37 und ergeben zusammen genau die ausgewiesenen 4.589,98 netto.
  {
    source_key: 'mg24-2024-swt-strom-bauphase', kostenart: 'modernisierung', betrag: 131.36,
    umlagefaehig: false, von: '2024-11-16', bis: '2024-12-31',
    rechnungsnummer: '0001-ARV-2026-8728', rechnungsdatum: '2026-06-10', zahltag: '2026-06-26',
    notiz: 'SWT Vertrag 348661, Rechnungszeitraum 16.11.2024 bis 31.12.2024: 255 kWh '
      + '(Zähler 1EMH0012291975, Faktor 50, Hochrechnung), netto 110,39 plus 19 % USt. '
      + 'Liegt vor der Erstvermietung; Herstellungs- beziehungsweise Leerstandsphase, '
      + 'nicht umlagefähig.',
  },
  {
    source_key: 'mg24-2025-swt-allgemeinstrom-h1', kostenart: 'sonstige_betrkv', betrag: 419.42,
    umlagefaehig: true, von: '2025-01-01', bis: '2025-06-16',
    rechnungsnummer: '0001-ARV-2026-8728', rechnungsdatum: '2026-06-10', zahltag: '2026-06-26',
    notiz: 'SWT Vertrag 348661, Rechnungszeitraum 01.01.2025 bis 16.06.2025: 900 kWh '
      + '(Zähler 1EMH0012291975, Faktor 50, Ablesung MSB), netto 378,22 plus 19 % USt = '
      + '450,08 brutto. Davon 419,42 als Allgemeinstrom umlagefähig. ARBEITSANNAHME: '
      + 'Ein eigener Allgemeinstromzähler besteht erst ab 24.06.2025; er zeigt 954 kWh in '
      + '190 Tagen = 5,02 kWh/Tag. Auf 167 Tage gerechnet sind das 838,7 kWh, also 93,19 % '
      + 'der gemessenen 900 kWh. Der Rest ist als Vorleistung der Kundenanlage gebucht. '
      + 'Zu ersetzen, sobald die Kundenanlagenabrechnung 2025 vorliegt.',
  },
  {
    source_key: 'mg24-2025-swt-strom-vorleistung-h1', kostenart: 'sonstige_betrkv', betrag: 30.66,
    umlagefaehig: false, von: '2025-01-01', bis: '2025-06-16',
    rechnungsnummer: '0001-ARV-2026-8728', rechnungsdatum: '2026-06-10', zahltag: '2026-06-26',
    notiz: 'Restbetrag des Zeitraums 01.01. bis 16.06.2025 über dem Vergleichswert des '
      + 'Allgemeinstromzählers (6,81 % von 450,08). Als Vorleistung des '
      + 'Mieterstrommodells nicht umlagefähig. ARBEITSANNAHME, siehe '
      + 'mg24-2025-swt-allgemeinstrom-h1.',
  },
  {
    source_key: 'mg24-2025-swt-kundenanlage-juni-juli', kostenart: 'sonstige_betrkv',
    betrag: 2717.96, umlagefaehig: false, von: '2025-06-17', bis: '2025-07-31',
    rechnungsnummer: '0001-ARV-2026-8728', rechnungsdatum: '2026-06-10', zahltag: '2026-06-26',
    notiz: 'SWT Vertrag 348661, Rechnungszeitraum 17.06.2025 bis 31.07.2025: 6.781,75 kWh '
      + 'über den Übergabezähler 1LGZ0071678615 (Faktor 50), netto 2.284,00 plus 19 % USt. '
      + 'Das ist der Sammelbezug der Kundenanlage, nicht Allgemeinstrom: Der '
      + 'Allgemeinstromzähler liegt bei rund 5 kWh am Tag, hier sind es rund 150. '
      + 'ARBEITSANNAHME: Die Menge wurde den Mietern über energiekonzept weiterberechnet '
      + 'und ist deshalb nicht umlagefähig — doppelt berechnet werden darf sie nicht. '
      + 'Zu prüfen an der Kundenanlagenabrechnung 2025.',
  },
  {
    source_key: 'mg24-2025-swt-kundenanlage-august', kostenart: 'sonstige_betrkv',
    betrag: 2162.68, umlagefaehig: false, von: '2025-08-01', bis: '2025-08-20',
    rechnungsnummer: '0001-ARV-2026-8728', rechnungsdatum: '2026-06-10', zahltag: '2026-06-26',
    notiz: 'SWT Vertrag 348661, Rechnungszeitraum 01.08.2025 bis 20.08.2025: 5.417,90 kWh '
      + 'über den Übergabezähler 1LGZ0071678615, netto 1.817,37 plus 19 % USt (2.162,67; '
      + 'ein Cent Rundungsdifferenz ist hier zugeschlagen, damit die fünf Buchungen genau '
      + 'die 5.462,08 der Rechnung ergeben). Ende der Belieferung durch SWT, danach NEW. '
      + 'ARBEITSANNAHME wie beim Vorzeitraum.',
  },

  // ── B4: Baustrom ─────────────────────────────────────────────────────────
  {
    source_key: 'mg24-2024-swt-baustrom', kostenart: 'modernisierung', betrag: 3042.69,
    umlagefaehig: false, von: '2023-12-01', bis: '2024-11-28',
    rechnungsnummer: '0001-ARV-2024-35345', rechnungsdatum: '2025-03-05', zahltag: '2025-03-21',
    notiz: 'SWT Baustrom, Kd 492014-328879, Zeitraum 01.12.2023 bis 28.11.2024: 7.960 kWh '
      + 'über Zähler 1APA0116042112, 3.042,69 brutto. Herstellungsaufwand und damit nicht '
      + 'umlagefähig (Schlussabnahme 04.11.2024, K8). Zum selben Vertrag gehören zwei '
      + 'Gutschriften: 394,20 vom 11.03.2024 (Zeitraum 24.04. bis 30.11.2023) und 9,17 vom '
      + '21.05.2025 aus der Strompreisbremse (Zeitraum 2023). Beide betreffen 2023 und '
      + 'sind hier nicht gegengerechnet.',
  },
];

// ── Umlageregel für die neue Kostenart ─────────────────────────────────────

const REGEL_NIEDERSCHLAG = {
  kostenart: 'niederschlagswasser',
  key_type: 'sqm',
  valid_from: '2025-01-01',
  notes: 'Niederschlagswassergebühr wird nach versiegelter Fläche erhoben (206 m²) und '
    + 'deshalb nach Wohnfläche verteilt — nicht nach Wasserverbrauch wie die '
    + 'Schmutzwassergebühr. BetrKV §2 Nr. 3. Angelegt 11.10.2026 (Paket 3b B1).',
};

async function main() {
  const anwenden = process.argv.includes('--apply');
  console.log(`\nMG24-Buchungen nach den SWT-Rechnungen — ${anwenden ? 'ANWENDEN' : 'Probelauf'}\n`);

  const arten: any[] = await ruf('/api/assets/cost-categories');
  const artId = new Map<string, number>(arten.map(a => [a.code, a.id]));

  const vorhanden: any[] = await ruf(`/api/assets/properties/${OBJEKT}/expense-bookings`);
  const nachKey = new Map<string, any>(vorhanden.map(b => [b.source_key, b]));

  // 1. Stilllegen
  console.log('Stillzulegen:');
  for (const s of STILLLEGEN) {
    const b = vorhanden.find(x => Number(x.id) === s.id);
    if (!b) { console.log(`  #${s.id}: nicht gefunden oder schon stillgelegt`); continue; }
    if (Math.abs(parseFloat(b.amount_gross) - s.betrag) > 0.005) {
      throw new Error(`#${s.id} trägt ${b.amount_gross}, erwartet ${s.betrag} — Abbruch`);
    }
    console.log(`  #${s.id}  ${s.betrag.toFixed(2).padStart(10)} EUR  ${b.cost_category_code}`);
    if (anwenden) {
      await ruf(`/api/assets/properties/${OBJEKT}/expense-bookings/${s.id}`, 'PATCH',
        { archived: true, notes: `${b.notes ? b.notes + ' — ' : ''}${s.grund}` });
    }
  }

  // 2. Umlageregel
  const regeln: any[] = await ruf(`/api/assets/properties/${OBJEKT}/allocation-rules`);
  const nsId = artId.get(REGEL_NIEDERSCHLAG.kostenart);
  const regelDa = regeln.some(r => Number(r.cost_category_id) === nsId);
  console.log(`\nUmlageregel ${REGEL_NIEDERSCHLAG.kostenart} (${REGEL_NIEDERSCHLAG.key_type}): `
    + (regelDa ? 'besteht' : 'wird angelegt'));
  if (anwenden && !regelDa && nsId) {
    await ruf(`/api/assets/properties/${OBJEKT}/allocation-rules`, 'POST', {
      cost_category_id: nsId, key_type: REGEL_NIEDERSCHLAG.key_type,
      valid_from: REGEL_NIEDERSCHLAG.valid_from, source: 'SWT-Rechnung 0001-ARV-2025-32342',
      notes: REGEL_NIEDERSCHLAG.notes,
    });
  }

  // 3. Neue Buchungen
  console.log('\nNeue Buchungen:');
  let angelegt = 0; let schonDa = 0;
  for (const n of BUCHUNGEN) {
    if (nachKey.has(n.source_key)) {
      schonDa++;
      console.log(`  besteht  ${n.source_key}`);
      continue;
    }
    const cid = artId.get(n.kostenart);
    if (!cid) throw new Error(`Kostenart ${n.kostenart} unbekannt — Abbruch`);
    console.log(`  ${n.betrag.toFixed(2).padStart(10)} EUR  ${n.kostenart.padEnd(22)} `
      + `${n.von}..${n.bis}  umlagefähig ${n.umlagefaehig ? 'ja ' : 'nein'}  ${n.source_key}`);
    if (anwenden) {
      await ruf(`/api/assets/properties/${OBJEKT}/expense-bookings`, 'POST', {
        source_key: n.source_key,
        cost_category_id: cid,
        vendor_name: 'Stadtwerke Tuttlingen GmbH',
        invoice_number: n.rechnungsnummer,
        invoice_date: n.rechnungsdatum,
        service_period_start: n.von,
        service_period_end: n.bis,
        payment_date: n.zahltag,
        amount_gross: n.betrag,
        umlagefaehig: n.umlagefaehig,
        notes: n.notiz,
      });
      angelegt++;
    }
  }

  // 4. Kontrollsummen
  const summeWasser = BUCHUNGEN.filter(b => b.rechnungsnummer === '0001-ARV-2025-32342')
    .reduce((s, b) => s + b.betrag, 0);
  const summeStrom = BUCHUNGEN.filter(b => b.rechnungsnummer === '0001-ARV-2026-8728')
    .reduce((s, b) => s + b.betrag, 0);
  console.log('\nKontrollsummen gegen die Rechnungen:');
  console.log(`  Wasser 2025 : ${summeWasser.toFixed(2)} (Rechnung 2353.01) `
    + (Math.abs(summeWasser - 2353.01) < 0.005 ? 'stimmt' : 'ABWEICHUNG'));
  console.log(`  Strom       : ${summeStrom.toFixed(2)} (Rechnung 5462.08) `
    + (Math.abs(summeStrom - 5462.08) < 0.005 ? 'stimmt' : 'ABWEICHUNG'));
  if (Math.abs(summeWasser - 2353.01) > 0.005 || Math.abs(summeStrom - 5462.08) > 0.005) {
    process.exit(1);
  }

  if (anwenden) console.log(`\nAngelegt: ${angelegt}, schon vorhanden: ${schonDa}.`);
  else console.log('\nEs wird NICHTS geschrieben. Anwenden mit --apply.');
}

main().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });
