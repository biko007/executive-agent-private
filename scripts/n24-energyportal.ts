#!/usr/bin/env bun
/**
 * scripts/n24-energyportal — die am 13.10.2026 aus dem EnergyPortal geholten
 * N24-Daten nachführen.
 *
 * DREI PLATZHALTER BEKOMMEN IHRE NUMMER. Beim Anlegen der Zähler waren drei
 * Nummern unbekannt und wurden als `OHNE-NR-…` geführt. Das Portal nennt sie:
 * Whg. 5 ist 1LGZ0064308150, die Erzeugungsmessung 1MCS0010125166, der alte
 * Summenzähler 1MCS0010125156.
 *
 * WANDLERFAKTOR 50 bei Übergabe- und Erzeugungsmessung. Erfasst wird wie bei
 * MG24 der bereits multiplizierte Wert in kWh, der Registerstand steht in der
 * Notiz der Ablesung. Nur so stimmt der Verbrauch unmittelbar.
 *
 * ZWEI RICHTUNGEN, EIN DATENSATZ. Der Übergabezähler misst Bezug (1.8.0) und
 * Einspeisung (2.8.0). Erfasst ist der Bezug, weil nur er in die Nebenkosten
 * führt; die Einspeisereihe steht vollständig in der Zählernotiz.
 *
 * WAS NICHT GEHT: Der Stand zum 31.12.2025 fehlt für alle Submeter. Das Portal
 * zeigt nur den jeweils letzten Stand, und die Jahresabrechnung 2025 ist noch
 * nicht erstellt. Damit ist der Wärmepumpenstrom 2025 nicht bestimmbar — und
 * wird auch nicht geschätzt. Der Befund steht als Vermerk am Zähler.
 *
 * Aufruf:  bun run scripts/n24-energyportal.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';
const Q = 'EnergyPortal energiekonzept N24, abgerufen 13.10.2026';
const Q_R0043 = 'Mieterstrom-Schlussrechnung R0043 vom 18.12.2025 (La Perla GmbH)';

/** Platzhalter → echte Nummer. */
const NUMMERN: { alt: string; neu: string }[] = [
  { alt: 'OHNE-NR-N24-WHG5', neu: '1LGZ0064308150' },
  { alt: 'OHNE-NR-N24-PV-ERZEUGUNG', neu: '1MCS0010125166' },
  { alt: 'OHNE-NR-N24-Z2-SUMME', neu: '1MCS0010125156' },
];

interface Stand { tag: string; wert: number; typ: 'annual' | 'interim'; quelle: string; notiz: string }

const STAENDE: { nummer: string; staende: Stand[] }[] = [
  {
    nummer: '1LGZ0064308154', staende: [
      { tag: '2023-10-19', wert: 0, typ: 'interim', quelle: Q,
        notiz: 'Inbetriebnahme der Kundenanlage; alle Submeter starten bei 0.' },
      { tag: '2023-12-31', wert: 95, typ: 'annual', quelle: Q, notiz: 'Verbrauch 19.10.–31.12.2023: 95 kWh.' },
      { tag: '2026-06-01', wert: 3456.147, typ: 'interim', quelle: Q, notiz: 'Letzter im Portal geführter Stand.' },
    ],
  },
  {
    nummer: '1LGZ0064308153', staende: [
      { tag: '2023-10-19', wert: 0, typ: 'interim', quelle: Q, notiz: 'Inbetriebnahme der Kundenanlage.' },
      { tag: '2023-12-31', wert: 95, typ: 'annual', quelle: Q, notiz: 'Verbrauch 19.10.–31.12.2023: 95 kWh.' },
      { tag: '2026-06-01', wert: 5963.057, typ: 'interim', quelle: Q, notiz: 'Letzter im Portal geführter Stand.' },
    ],
  },
  {
    nummer: '1LGZ0064308152', staende: [
      { tag: '2026-06-01', wert: 5223.252, typ: 'interim', quelle: Q, notiz: 'Letzter im Portal geführter Stand.' },
    ],
  },
  {
    nummer: '1LGZ0064308151', staende: [
      { tag: '2026-06-01', wert: 2106.471, typ: 'interim', quelle: Q, notiz: 'Letzter im Portal geführter Stand.' },
    ],
  },
  {
    nummer: '1LGZ0064308150', staende: [
      { tag: '2023-10-19', wert: 0, typ: 'interim', quelle: Q, notiz: 'Inbetriebnahme der Kundenanlage.' },
      { tag: '2023-12-31', wert: 630.1, typ: 'annual', quelle: Q,
        notiz: 'Verbrauch 19.10.–31.12.2023: 630,1 kWh; abgerechnet mit R0033.' },
      { tag: '2024-12-31', wert: 3248.9, typ: 'annual', quelle: Q,
        notiz: 'Verbrauch 2024: 2.618,8 kWh; abgerechnet mit R0038.' },
      { tag: '2026-08-01', wert: 7311.851, typ: 'interim', quelle: Q, notiz: 'Letzter im Portal geführter Stand.' },
    ],
  },
  {
    nummer: '1LGZ0064308210', staende: [
      { tag: '2023-10-19', wert: 0, typ: 'interim', quelle: Q, notiz: 'Inbetriebnahme der Kundenanlage.' },
      { tag: '2023-12-31', wert: 81, typ: 'annual', quelle: Q, notiz: 'Verbrauch 19.10.–31.12.2023: 81 kWh.' },
      { tag: '2025-11-30', wert: 3925.2, typ: 'interim', quelle: Q_R0043,
        notiz: 'Stand zum Ende des Mieterstromvertrags Schweigert. Verbrauch '
          + '01.01.–30.11.2025: 2.016,8 kWh. ACHTUNG: Das ist der Schnitt des '
          + 'STROMvertrags (Vertragsende Miete). Der Schnitt der Nebenkosten liegt '
          + 'nach Übergabeprotokoll beim 27.10.2025 beziehungsweise 24.11.2025 — '
          + 'die beiden Daten sind absichtlich verschieden.' },
      { tag: '2026-06-01', wert: 5225.947, typ: 'interim', quelle: Q, notiz: 'Letzter im Portal geführter Stand.' },
    ],
  },
  {
    nummer: '1LGZ0064308209', staende: [
      { tag: '2026-06-01', wert: 20033.065, typ: 'interim', quelle: Q,
        notiz: 'Letzter im Portal geführter Stand. Zwischen dem 31.12.2024 und dem '
          + '01.06.2026 also 14.088,565 kWh in 17 Monaten.' },
    ],
  },
  {
    nummer: '1LGZ0064308208', staende: [
      { tag: '2026-06-01', wert: 40988.232, typ: 'interim', quelle: Q,
        notiz: 'Letzter im Portal geführter Stand. Zwischen dem 31.12.2024 und dem '
          + '01.06.2026 also 23.792,432 kWh in 17 Monaten. Daraus lässt sich der '
          + 'Stand zum 31.12.2025 NICHT ableiten: Eine Wärmepumpe verbraucht im '
          + 'Winter ein Vielfaches des Sommerwerts, und der Zeitraum enthält zwei '
          + 'Heizperioden ungleicher Länge.' },
    ],
  },
  {
    nummer: '1MCS0010125165', staende: [
      { tag: '2023-12-31', wert: 4481.0, typ: 'annual', quelle: Q,
        notiz: 'Bezug 1.8.0: Registerstand 89,62 mal Wandlerfaktor 50.' },
      { tag: '2024-12-31', wert: 18556.65, typ: 'annual', quelle: Q,
        notiz: 'Bezug 1.8.0: Registerstand 371,133 mal 50. Netzbezug 2024: '
          + '14.075,65 kWh.' },
    ],
  },
  {
    nummer: '1MCS0010125166', staende: [
      { tag: '2023-12-31', wert: 1818.5, typ: 'annual', quelle: Q,
        notiz: 'Registerstand 36,37 mal Wandlerfaktor 50.' },
      { tag: '2024-12-31', wert: 24858.0, typ: 'annual', quelle: Q,
        notiz: 'Registerstand 497,16 mal 50. Erzeugung 2024: 23.039,5 kWh, also '
          + '813 kWh je kWp — ein normaler Wert, kein Spitzenjahr.' },
      { tag: '2026-01-01', wert: 49041.85, typ: 'annual', quelle: Q,
        notiz: 'Registerstand 980,837 mal 50, Stichtag 31.12.2025. Erzeugung 2025: '
          + '24.183,85 kWh. Dies ist der EINZIGE Zähler der Anlage, für den ein '
          + 'Stand zum Jahreswechsel 2025/26 vorliegt.' },
    ],
  },
  {
    nummer: '1MCS0010125156', staende: [
      { tag: '2023-10-19', wert: 0, typ: 'interim', quelle: Q,
        notiz: 'Stand bei Inbetriebnahme der Kundenanlage. Danach keine Fortschreibung '
          + 'im Portal — der Zähler wurde durch 1MCS0010125165 abgelöst.' },
    ],
  },
];

/** Vermerke an den Zählern. */
const NOTIZEN: { nummer: string; marke: string; anhang: string }[] = [
  {
    nummer: '1LGZ0064308208', marke: 'WP-STROM 2025 FEHLT',
    anhang: 'WP-STROM 2025 FEHLT (Mail A9, Stand 13.10.2026). Der Verbrauch 2025 wäre '
      + 'Stand 31.12.2025 minus 17.195,8. Dieser Stand ist nirgends belegt: Das '
      + 'EnergyPortal zeigt nur den jeweils letzten Stand (01.06.2026 = 40.988,232), '
      + 'die Jahresabrechnung 2025 der Kundenanlage ist noch nicht erstellt — '
      + 'energiekonzept wartet auf die Abrechnung der Stadtwerke —, und die '
      + 'RLM-Lastgangdaten der Stadtwerke beginnen erst im April 2026. '
      + 'EINGRENZUNG, ausdrücklich KEINE Buchungsgrundlage: Der Wert liegt zwischen '
      + '17.195,8 und 40.988,232 kWh; über die 17 Monate wurden 23.792,4 kWh '
      + 'verbraucht. Eine zeitanteilige Aufteilung wäre falsch, weil eine Wärmepumpe '
      + 'im Winter ein Vielfaches des Sommerwerts zieht. Es wird nichts geschätzt und '
      + 'nichts gebucht. '
      + 'ZUM PREIS: La Perla stellt sich den Wärmepumpenstrom selbst in Rechnung — '
      + '2024 waren das 13.961,7 kWh zu 31,54 ct/kWh netto, also 5.354,96 EUR brutto '
      + '(Rechnung R0042). Ob dieser Preis in den Nebenkosten angesetzt werden darf, '
      + 'ist die offene Entscheidung E.',
  },
  {
    nummer: '1MCS0010125165', marke: 'EINSPEISUNG 2.8.0',
    anhang: 'EINSPEISUNG 2.8.0 (eigene Registerreihe, hier nicht als Ablesung erfasst, '
      + 'weil der Datensatz die Bezugsreihe trägt): 31.12.2023 Registerstand 5,03 = '
      + '251,5 kWh; 31.12.2024 Registerstand 159,458 = 7.972,9 kWh. Einspeisung 2024 '
      + 'also 7.721,4 kWh. '
      + 'ABGRENZUNG zur SWT-Abrechnung: Die Stadtwerke rechnen denselben Zähler unter '
      + 'Kd 527415-318635 monatlich als RLM-Lastgang ab und setzen ihn dabei zum '
      + 'Monatsersten auf 0 zurück. Die hier erfassten Stände stammen dagegen aus dem '
      + 'EnergyPortal und laufen durch. Beide Lesarten sind richtig, sie messen nur '
      + 'Verschiedenes.',
  },
  {
    nummer: '1LGZ0064308210', marke: 'MIETERSTROMFORDERUNG',
    anhang: 'MIETERSTROMFORDERUNG (Stand 13.10.2026, kein Ertrag gebucht): Joshua '
      + 'Schweigert schuldet aus R0032 (2024) 722,23 EUR und aus der Schlussrechnung '
      + 'R0043 (01.01.–30.11.2025) 861,98 EUR. Mahnstand 23.06.2026, Stufe 2, '
      + 'zusammen 1.592,21 EUR. Im Mahnlauf vom 20.07.2026 taucht die Forderung nicht '
      + 'mehr auf; ein Ausgleich ist aber nicht belegt. Die Zahlungen laufen über das '
      + 'La-Perla-Konto bei der Kreissparkasse Tuttlingen, das in bikosoc nicht '
      + 'synchronisiert ist. '
      + 'KAUTION: Im Mietvertrag sind 2.980,00 EUR vereinbart. In der Tabelle '
      + 'security_deposits steht dazu nichts, und in den erfassten Bankumsätzen findet '
      + 'sich weder eine Kautionszahlung noch eine Rückzahlung — nur die Mieten zu '
      + '1.845,00 EUR bis einschließlich 11/2025. Ob die Kaution eingegangen ist und '
      + 'ob mit ihr verrechnet wurde, ist aus bikosoc nicht zu beantworten.',
  },
  {
    nummer: '1LGZ0064308154', marke: 'MIETERSTROMFORDERUNG',
    anhang: 'MIETERSTROMFORDERUNG (Stand 13.10.2026, kein Ertrag gebucht): Aus R0030 '
      + '(26.04.–31.12.2024, 465,02 EUR brutto abzüglich 350,00 EUR Abschläge) sind '
      + '131,02 EUR offen; Mahnstand 20.07.2026, Stufe 3.',
  },
  {
    nummer: '1MCS0010125166', marke: 'ERZEUGUNG UND EINSPEISEVERGÜTUNG',
    anhang: 'ERZEUGUNG UND EINSPEISEVERGÜTUNG: Erzeugung 2024 23.039,5 kWh, 2025 '
      + '24.183,85 kWh bei 28,35 kWp. Davon gingen 2024 7.721,4 kWh ins Netz, '
      + '15.318,1 kWh blieben im Haus — ein PV-Anteil von rund 52 Prozent. '
      + 'Die Einspeisevergütung zahlen die Stadtwerke unter Kd 580080, Vertrag 348474.',
  },
];

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const t = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!t) throw new Error(`${schluessel} fehlt`);
  return t[1].trim();
}

async function ruf(pfad: string, methode = 'GET', rumpf?: unknown, idem?: string) {
  const kopf: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env('CORE_SERVICE_TOKEN')}`, 'X-Actor': 'owner',
  };
  if (idem) kopf['Idempotency-Key'] = idem;
  const res = await fetch(`${BASIS}${pfad}`, {
    method: methode, headers: kopf, ...(rumpf ? { body: JSON.stringify(rumpf) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${methode} ${pfad} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function n24Zaehler(): Promise<Map<string, number>> {
  const { rows } = await dbQuery<{ id: number; meter_number: string }>(
    `SELECT m.id, m.meter_number FROM meters m
       LEFT JOIN properties p1 ON m.property_id = p1.id
       LEFT JOIN units u ON m.unit_id = u.id
       LEFT JOIN properties p2 ON u.property_id = p2.id
      WHERE COALESCE(p1.code, p2.code) = 'n24' AND m.medium = 'electricity'`);
  return new Map(rows.map(r => [r.meter_number, r.id]));
}

async function main() {
  const anwenden = process.argv.includes('--apply');
  let id = await n24Zaehler();
  let umbenannt = 0; let neueS = 0; let notizen = 0;

  console.log('Platzhalter bekommen ihre Nummer:');
  for (const n of NUMMERN) {
    if (id.has(n.neu)) { console.log(`  ${n.neu} bereits gesetzt`); continue; }
    const mid = id.get(n.alt);
    if (!mid) { console.log(`  ${n.alt} nicht gefunden`); continue; }
    console.log(`  ${n.alt} → ${n.neu}`);
    if (!anwenden) continue;
    const { rows: v } = await dbQuery<{ notes: string | null }>(
      'SELECT notes FROM meters WHERE id = $1', [mid]);
    const notiz = (v[0].notes ?? '')
      .replace(/^PLATZHALTER, Zählernummer unbekannt\.\s*/, '')
      .replace(/Die Nummer steht in keinem vorliegenden Dokument[^.]*\./g, '')
      .trim()
      + ` Die Zählernummer war beim Anlegen unbekannt und ist am 13.10.2026 aus dem `
      + `EnergyPortal ergänzt worden (${Q}).`;
    await ruf(`/api/assets/meters/${mid}`, 'PATCH', { meter_number: n.neu, notes: notiz });
    umbenannt++;
  }
  if (anwenden) id = await n24Zaehler();

  console.log('\nStände:');
  for (const z of STAENDE) {
    const mid = id.get(z.nummer);
    if (!mid) { console.log(`  ${z.nummer} FEHLT`); continue; }
    const { rows } = await dbQuery<{ tag: string }>(
      "SELECT to_char(read_at,'YYYY-MM-DD') AS tag FROM meter_readings WHERE meter_id = $1", [mid]);
    const da = new Set(rows.map(r => r.tag));
    const offen = z.staende.filter(s => !da.has(s.tag));
    if (offen.length === 0) { console.log(`  ${z.nummer.padEnd(16)} vollständig`); continue; }
    console.log(`  ${z.nummer.padEnd(16)} ` + offen.map(s => `${s.tag}=${s.wert}`).join('  '));
    if (!anwenden) continue;
    await ruf(`/api/assets/meters/${mid}/readings/bulk`, 'POST', {
      readings: offen.map(s => ({
        value: s.wert, unit: 'kWh', reading_type: s.typ,
        read_at: `${s.tag}T00:00:00Z`, source: 'manual',
        reader_name: 'energiekonzept (EnergyPortal)', is_estimated: false,
        document_path: s.quelle, notes: s.notiz,
      })),
    }, `n24ep-${z.nummer}-${offen.map(s => s.tag).join('-')}`);
    neueS += offen.length;
  }

  console.log('\nVermerke:');
  for (const n of NOTIZEN) {
    const mid = id.get(n.nummer);
    if (!mid) { console.log(`  ${n.nummer} FEHLT`); continue; }
    const { rows } = await dbQuery<{ notes: string | null }>(
      'SELECT notes FROM meters WHERE id = $1', [mid]);
    const basis = (rows[0].notes ?? '').split(` ${n.marke}`)[0].trimEnd();
    const neu = `${basis} ${n.anhang}`;
    if (rows[0].notes === neu) { console.log(`  ${n.nummer.padEnd(16)} unveraendert`); continue; }
    console.log(`  ${n.nummer.padEnd(16)} ${n.marke}`);
    if (!anwenden) continue;
    await ruf(`/api/assets/meters/${mid}`, 'PATCH', { notes: neu });
    notizen++;
  }

  console.log(anwenden
    ? `\n${umbenannt} Nummern ergänzt, ${neueS} Stände erfasst, ${notizen} Vermerke.`
    : '\nProbelauf — nichts geschrieben. Mit --apply ausführen.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
