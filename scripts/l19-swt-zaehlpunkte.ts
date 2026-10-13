/**
 * scripts/l19-swt-zaehlpunkte — die fehlenden SWT-Zählpunkte in L19 nachtragen.
 *
 * ANLASS. Eine SWT-Ablesebestätigung vom 08.07.2025 nannte sechs Stände, von
 * denen vier nicht zu bikosoc passten, darunter zwei Zähler, die hier gar nicht
 * geführt wurden. Die Rechnungen der beiden Wohnungsverträge klären beides:
 *
 *   - 1ISK0068679824 ist der Haushaltsstrom der Wohnung 2. OG links
 *     (Kd 133224-237710, Vertrag 106949). Am 29.09.2025 ausgebaut.
 *   - 1ISK0086922705 hat ihn am 30.09.2025 ersetzt.
 *   - 64128137 ist der Haushaltsstrom der Wohnung 2. OG rechts
 *     (Kd 133224-237712, Vertrag 106951).
 *
 * Damit sind alle fünf Stromzählpunkte der Liegenschaft belegt, und die
 * Ablesebestätigung passt in ihrer STRUKTUR genau: fünf Stromregister plus
 * Wasser. Ihre WERTE stimmen für drei der fünf Register trotzdem nicht — was
 * daran liegt, dass sie nie in eine Rechnung eingegangen sind. Deshalb wird an
 * den vorhandenen Ständen nichts geändert; sie stammen aus den Rechnungen, nach
 * denen die Stadtwerke tatsächlich abrechnen. Die Abweichung steht in der Notiz.
 *
 * Die drei neuen Zähler sind Haushaltsstrom einzelner Wohnungen auf dem Vertrag
 * des Eigentümers — wie bei N24 und MG24 gehört er NICHT in die
 * Nebenkostenabrechnung.
 *
 * Aufruf:  bun run scripts/l19-swt-zaehlpunkte.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';
const SWT = '/Apps/bikosoc-reports/bikosoc-reports/transfer/SWT-Rechnungen/';
const R10_2024 = '5-L19/Nebenkostenabrechnungen Mieter/2024/Abrechnungen in 2025 erstellt/'
  + 'Rg. Energie/0001-ARV-2024-18525.pdf';
const R10_2025 = '5-L19/Nebenkostenabrechnungen Mieter/2024/Abrechnungen in 2025 erstellt/'
  + 'Rg. Energie/0001-ARV-2025-16547.pdf';
const R10_2026 = SWT + 'SWT_2026-08-17_Leutenbergstr_19_237710_0001-ARV-2026-13850.pdf';
const R12_2024 = '5-L19/Nebenkostenabrechnungen Mieter/2024/Abrechnungen in 2025 erstellt/'
  + 'Rg. Energie/0001-ARV-2024-18528.pdf';
const R12_2025 = '5-L19/Nebenkostenabrechnungen Mieter/2024/Abrechnungen in 2025 erstellt/'
  + 'Rg. Energie/0001-ARV-2025-16550.pdf';
const R12_2026 = SWT + 'SWT_2026-08-17_Leutenbergstr_19_237712_0001-ARV-2026-13851.pdf';

const MIETERSTROM = 'HAUSHALTSSTROM – NICHT NK-RELEVANT. ';
const HR = 'Hochrechnung der Stadtwerke Tuttlingen';

interface Stand {
  tag: string; wert: number; typ: 'annual' | 'interim'; geschaetzt: boolean;
  beleg: string; notiz: string;
}
interface Zaehler {
  nummer: string; einheit: string; notiz: string; staende: Stand[];
}

const ZAEHLER: Zaehler[] = [
  {
    nummer: '1ISK0068679824', einheit: 'W3',
    notiz: MIETERSTROM + 'Haushaltsstrom der Wohnung 2. OG links. Stadtwerke Tuttlingen '
      + 'Kd 133224-237710, Vertrag 106949 „Allgemeiner Tarif Eintarif", Marktlokation '
      + '51422528584, Messlokation DE000642785320001005760019000S003. '
      + 'AM 29.09.2025 AUSGEBAUT und durch 1ISK0086922705 ersetzt; der Ausbaustand von '
      + '7.380 kWh ist eine echte Ablesung des Netzbetreibers. '
      + 'Der Verbrauch wird dem Eigentümer in Rechnung gestellt, nicht der Liegenschaft — '
      + 'er gehört deshalb nicht in die Nebenkostenabrechnung. '
      + 'Angelegt am 13.10.2026: Dieser Zählpunkt fehlte in bikosoc; er tauchte erstmals '
      + 'in der SWT-Ablesebestätigung vom 08.07.2025 als „1ISK00****9824" auf.',
    staende: [
      { tag: '2023-07-13', wert: 4028, typ: 'interim', geschaetzt: false, beleg: R10_2024,
        notiz: 'Beginn des Abrechnungszeitraums der Rechnung 0001-ARV-2024-18525.' },
      { tag: '2023-12-31', wert: 4728, typ: 'annual', geschaetzt: true, beleg: R10_2024,
        notiz: 'Ablesekennzeichen „Hochrechnung".' },
      { tag: '2024-07-15', wert: 5536, typ: 'interim', geschaetzt: true, beleg: R10_2024,
        notiz: 'Ablesekennzeichen „Hochrechnung". Ende des Abrechnungszeitraums 2023/24 '
          + 'und Beginn des folgenden.' },
      { tag: '2024-12-31', wert: 6231, typ: 'annual', geschaetzt: true, beleg: R10_2025,
        notiz: 'Ablesekennzeichen „Hochrechnung". Anfangsstand 2025.' },
      { tag: '2025-06-30', wert: 6993, typ: 'interim', geschaetzt: true, beleg: R10_2025,
        notiz: 'Ablesekennzeichen „Hochrechnung System".' },
      { tag: '2025-07-31', wert: 7098, typ: 'interim', geschaetzt: true, beleg: R10_2025,
        notiz: 'Ablesekennzeichen „Hochrechnung". Ende des Abrechnungszeitraums 2024/25.' },
      { tag: '2025-09-29', wert: 7380, typ: 'interim', geschaetzt: false, beleg: R10_2026,
        notiz: 'AUSBAUSTAND, Ablesekennzeichen „Ablesung Netzbetreiber" — eine echte '
          + 'Ablesung, keine Hochrechnung. Verbrauch 01.01.–29.09.2025: 1.149 kWh.' },
    ],
  },
  {
    nummer: '1ISK0086922705', einheit: 'W3',
    notiz: MIETERSTROM + 'NACHFOLGER von 1ISK0068679824, eingebaut am 30.09.2025 mit '
      + 'Stand 3 kWh. Haushaltsstrom der Wohnung 2. OG links, Stadtwerke Tuttlingen '
      + 'Kd 133224-237710, Vertrag 106949. '
      + 'Der Wechsel geht auf die gesetzliche Umrüstung auf moderne Messeinrichtungen '
      + 'zurück; die Stadtwerke hatten sie am 13.03.2025 angekündigt. '
      + 'Verbrauch 30.09.–31.12.2025: 245 kWh. Zusammen mit dem Vorgänger ergibt das für '
      + '2025 insgesamt 1.394 kWh.',
    staende: [
      { tag: '2025-09-30', wert: 3, typ: 'interim', geschaetzt: false, beleg: R10_2026,
        notiz: 'Einbaustand.' },
      { tag: '2025-12-31', wert: 248, typ: 'annual', geschaetzt: true, beleg: R10_2026,
        notiz: 'Ablesekennzeichen „Hochrechnung". Verbrauch seit Einbau: 245 kWh.' },
      { tag: '2026-07-10', wert: 757, typ: 'interim', geschaetzt: false, beleg: R10_2026,
        notiz: 'Ablesekennzeichen „Ablesung Kunde". Ende des Abrechnungszeitraums.' },
    ],
  },
  {
    nummer: '64128137', einheit: 'W4+',
    notiz: MIETERSTROM + 'Haushaltsstrom der Wohnung 2. OG rechts. Stadtwerke Tuttlingen '
      + 'Kd 133224-237712, Vertrag 106951 „Allgemeiner Tarif Eintarif", Marktlokation '
      + '51422589461, Messlokation DE000642785320001005760019000S004. '
      + 'Kein Zählerwechsel bis mindestens 31.07.2026. '
      + 'Verbrauch 2025: 2.224 kWh (21.253 − 19.029). '
      + 'Angelegt am 13.10.2026: Dieser Zählpunkt fehlte in bikosoc; er tauchte erstmals '
      + 'in der SWT-Ablesebestätigung vom 08.07.2025 als „64****37" auf.',
    staende: [
      { tag: '2023-07-13', wert: 15754, typ: 'interim', geschaetzt: false, beleg: R12_2024,
        notiz: 'Beginn des Abrechnungszeitraums der Rechnung 0001-ARV-2024-18528.' },
      { tag: '2023-12-31', wert: 16799, typ: 'annual', geschaetzt: true, beleg: R12_2024,
        notiz: 'Ablesekennzeichen „Hochrechnung".' },
      { tag: '2024-07-15', wert: 17996, typ: 'interim', geschaetzt: true, beleg: R12_2024,
        notiz: 'Ablesekennzeichen „Hochrechnung".' },
      { tag: '2024-12-31', wert: 19029, typ: 'annual', geschaetzt: true, beleg: R12_2025,
        notiz: 'Ablesekennzeichen „Hochrechnung". Anfangsstand 2025.' },
      { tag: '2025-06-30', wert: 20161, typ: 'interim', geschaetzt: true, beleg: R12_2025,
        notiz: 'Ablesekennzeichen „Hochrechnung System".' },
      { tag: '2025-07-31', wert: 20317, typ: 'interim', geschaetzt: true, beleg: R12_2025,
        notiz: 'Ablesekennzeichen „Hochrechnung". Ende des Abrechnungszeitraums 2024/25.' },
      { tag: '2025-12-31', wert: 21253, typ: 'annual', geschaetzt: true, beleg: R12_2026,
        notiz: 'Ablesekennzeichen „Hochrechnung". Endstand 2025; Verbrauch 2.224 kWh.' },
      { tag: '2026-07-31', wert: 22541, typ: 'interim', geschaetzt: true, beleg: R12_2026,
        notiz: 'Ablesekennzeichen „Hochrechnung".' },
    ],
  },
];

/* Was an den vorhandenen Zählern zur Ablesebestätigung vom 08.07.2025 zu
   vermerken ist. Geändert wird KEIN Wert — die erfassten Stände stammen aus den
   Rechnungen, nach denen die Stadtwerke abrechnen. */
const ABLESEBESTAETIGUNG: { nummer: string; anhang: string }[] = [
  {
    nummer: '64128135',
    anhang: 'ABLESEBESTÄTIGUNG 08.07.2025, geprüft am 13.10.2026: Die Stadtwerke '
      + 'bestätigen zu diesem Zähler („64****35") die Stände HT 13.904 und NT 5.684. '
      + 'Diese Werte passen zu KEINER Stelle der Zählerreihe: Die Rechnungen weisen zum '
      + '30.06.2025 HT 83.755 und NT 33.049 aus und laufen bis zum 31.07.2026 auf '
      + 'HT 93.896 weiter. Ein Zählwerk springt nicht um 70.000 kWh zurück. Die '
      + 'gemeldeten Werte sind zudem in keine Rechnung eingegangen — die Stadtwerke '
      + 'rechnen für den 30.06. und 31.07.2025 mit Hochrechnungen. Die erfassten Stände '
      + 'bleiben deshalb unverändert.',
  },
  {
    nummer: '64128140',
    anhang: 'ABLESEBESTÄTIGUNG 08.07.2025, geprüft am 13.10.2026: Die Stadtwerke '
      + 'bestätigen zu diesem Zähler („64****40") den Stand 1.192. Erfasst und abgerechnet '
      + 'sind 3.926 zum 30.06.2025 und 3.955 zum 31.07.2025. Auch dieser Wert ist in '
      + 'keine Rechnung eingegangen; der erfasste Stand bleibt unverändert. '
      + 'Ein Zählertausch war am 13.03.2025 für genau diesen Zähler angekündigt '
      + '(Messstelle DE000642785320001005760019000S006), ist aber bis mindestens '
      + '31.07.2026 nicht erfolgt — die Rechnungen führen 64128140 durchgehend.',
  },
];

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in ~/.config/openclaw/env`);
  return treffer[1].trim();
}

async function ruf(pfad: string, methode = 'GET', rumpf?: unknown, idempotenz?: string) {
  const kopf: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env('CORE_SERVICE_TOKEN')}`,
    'X-Actor': 'owner',
  };
  if (idempotenz) kopf['Idempotency-Key'] = idempotenz;
  const res = await fetch(`${BASIS}${pfad}`, {
    method: methode, headers: kopf, ...(rumpf ? { body: JSON.stringify(rumpf) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${methode} ${pfad} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const anwenden = process.argv.includes('--apply');

  const { rows: einheiten } = await dbQuery<{ id: number; code: string }>(
    `SELECT u.id, u.code FROM units u JOIN properties p ON u.property_id = p.id
      WHERE p.code = 'l19'`);
  const einheitId = new Map(einheiten.map(u => [u.code, u.id]));

  const { rows: bestand } = await dbQuery<{ id: number; meter_number: string }>(
    `SELECT m.id, m.meter_number FROM meters m
       LEFT JOIN properties p1 ON m.property_id = p1.id
       LEFT JOIN units u ON m.unit_id = u.id
       LEFT JOIN properties p2 ON u.property_id = p2.id
      WHERE COALESCE(p1.code, p2.code) = 'l19'`);
  const idVon = new Map(bestand.map(m => [m.meter_number, m.id]));

  let neueZ = 0; let neueS = 0; let notizen = 0;

  console.log('Fehlende SWT-Zählpunkte:');
  for (const z of ZAEHLER) {
    let meterId = idVon.get(z.nummer);
    if (!meterId) {
      if (!einheitId.has(z.einheit)) throw new Error(`Einheit ${z.einheit} fehlt in L19`);
      console.log(`  ${z.nummer.padEnd(16)} ${z.einheit.padEnd(4)} anlegen`);
      if (anwenden) {
        const erzeugt = await ruf('/api/assets/meters', 'POST', {
          scope_type: 'unit', unit_id: einheitId.get(z.einheit),
          medium: 'electricity', meter_number: z.nummer,
          provider: 'Stadtwerke Tuttlingen GmbH', is_main_meter: false, notes: z.notiz,
        });
        meterId = erzeugt.id as number;
        idVon.set(z.nummer, meterId);
        neueZ++;
      }
    } else {
      console.log(`  ${z.nummer.padEnd(16)} vorhanden`);
    }
    if (!meterId) continue;
    const { rows } = await dbQuery<{ tag: string }>(
      "SELECT to_char(read_at,'YYYY-MM-DD') AS tag FROM meter_readings WHERE meter_id = $1",
      [meterId]);
    const schonDa = new Set(rows.map(r => r.tag));
    const offen = z.staende.filter(s => !schonDa.has(s.tag));
    if (offen.length === 0) continue;
    console.log('       ' + offen.map(s => `${s.tag}=${s.wert}`).join('  '));
    if (!anwenden) continue;
    await ruf(`/api/assets/meters/${meterId}/readings/bulk`, 'POST', {
      readings: offen.map(s => ({
        value: s.wert, unit: 'kWh', reading_type: s.typ,
        read_at: `${s.tag}T00:00:00Z`, source: 'manual',
        reader_name: 'Stadtwerke Tuttlingen', is_estimated: s.geschaetzt,
        estimate_method: s.geschaetzt ? HR : null,
        estimate_reason: s.geschaetzt
          ? 'Zum Stichtag wurde nicht abgelesen; die Stadtwerke rechnen den Stand hoch '
            + 'und legen ihn ihrer eigenen Abrechnung zugrunde.' : null,
        document_path: s.beleg, notes: s.notiz,
      })),
    }, `l19swt-${z.nummer}-${offen.map(s => s.tag).join('-')}`);
    neueS += offen.length;
  }

  console.log('\nVermerk zur Ablesebestätigung vom 08.07.2025:');
  for (const a of ABLESEBESTAETIGUNG) {
    const meterId = idVon.get(a.nummer);
    if (!meterId) { console.log(`  ${a.nummer} FEHLT`); continue; }
    const { rows } = await dbQuery<{ notes: string | null }>(
      'SELECT notes FROM meters WHERE id = $1', [meterId]);
    const basis = (rows[0].notes ?? '').split(' ABLESEBESTÄTIGUNG 08.07.2025')[0].trimEnd();
    const neuText = `${basis} ${a.anhang}`;
    if (rows[0].notes === neuText) { console.log(`  ${a.nummer} unveraendert`); continue; }
    console.log(`  ${a.nummer} Notiz`);
    if (!anwenden) continue;
    await ruf(`/api/assets/meters/${meterId}`, 'PATCH', { notes: neuText });
    notizen++;
  }

  console.log(anwenden
    ? `\n${neueZ} Zähler angelegt, ${neueS} Stände erfasst, ${notizen} Notizen.`
    : '\nProbelauf — nichts geschrieben. Mit --apply ausführen.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
