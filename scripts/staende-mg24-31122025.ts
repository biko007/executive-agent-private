/**
 * scripts/staende-mg24-31122025 — die Owner-Ablesung zum 31.12.2025 in MG24 festhalten.
 *
 * ZWEI ARTEN VON ÄNDERUNG, und der Unterschied ist wichtig:
 *
 * 1. ZWEI NEUE STÄNDE. Aus der Mail von Herrn Bauser an die Stadtwerke vom
 *    16.09.2025 gehen zwei Zählerstände hervor, die bisher fehlten — der
 *    Ausbaustand des alten Zählers und ein Zwischenstand des neuen. Beide fügen
 *    sich lückenlos in die vorhandenen Reihen ein und werden erfasst.
 *
 * 2. NOTIZEN AN VORHANDENEN STÄNDEN. Für den 31.12.2025 ist bereits je ein Stand
 *    aus der Abrechnung der Kundenanlage erfasst. Die Owner-Ablesung desselben
 *    Tages weicht um 1 bis 10 kWh ab. Der erfasste Wert bleibt der Wert der
 *    Abrechnung — nicht weil er richtiger wäre, sondern weil er mit dem
 *    erfassten Anfangsstand und der abgerechneten Menge zusammenpasst. Würde man
 *    ihn durch die Owner-Ablesung ersetzen, stimmte die Abrechnung, die der
 *    Mieter bekommt, nicht mehr mit der Datenbank überein. Die Owner-Ablesung
 *    steht deshalb vollständig in der Notiz des jeweiligen Standes.
 *
 * Nicht erfasst wird der Wert 79 des PV-Zählers 1LGZ0075675536: 79 kWh seit dem
 * 11.09.2025 sind bei 25,73 kWp nicht möglich. Es ist offensichtlich das falsche
 * Register abgelesen. Siehe Report.
 *
 * Aufruf:  bun run scripts/staende-mg24-31122025.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';

const Q_OWNER = 'Owner-Meldung an energiekonzept, Bestätigung 31.12.2025';
const Q_BAUSER = 'Mail Matthias Bauser an Stadtwerke Tuttlingen vom 16.09.2025, '
  + 'Kd 133224-348661, Vertrag 198440';

/** Stände, die bisher ganz fehlen. */
const NEU: { nummer: string; tag: string; wert: number; typ: string; notiz: string }[] = [
  {
    nummer: '1EMH0012291975', tag: '2025-06-26', wert: 1655.0, typ: 'interim',
    notiz: 'AUSBAUSTAND. Registerstand 1.8.0 = 33,1 mal Wandlerfaktor 50. '
      + 'Der Zähler wurde am 26.06.2025 ausgebaut und an die Stadtwerke zurückgegeben; '
      + 'ersetzt hat ihn der Messstellenbetreiber metiundo durch 1LGZ0071678615. '
      + 'Das Einspeiseregister 2.8.0 stand am selben Tag auf 169,2 (mal 50 = 8.460 kWh). '
      + 'ABWEICHUNG zur SWT-Endabrechnung 0001-ARV-2026-8728: Diese nennt als letzten '
      + 'Stand den 16.06.2025 mit Register 33,0 („Ablesung MSB"). Der Unterschied beträgt '
      + '0,1 Registereinheiten, also 5 kWh.',
  },
  {
    nummer: '1LGZ0071678615', tag: '2025-09-16', wert: 415.0, typ: 'interim',
    notiz: 'Registerstand 1.8.0 = 8,3 mal Wandlerfaktor 50. Vom Eigentümer am Gerät '
      + 'abgelesen und den Stadtwerken gemeldet. Das Einspeiseregister 2.8.0 stand am '
      + 'selben Tag auf 59,0 (mal 50 = 2.950 kWh). '
      + 'DIESER STAND WIDERLEGT DIE SWT-ENDABRECHNUNG: Die Rechnung '
      + '0001-ARV-2026-8728 setzt für denselben Zähler bereits zum 21.08.2025 einen '
      + 'Registerstand von 243,993 an und rechnet daraus 12.200 kWh Bezug ab. Ein '
      + 'Zählwerk läuft nicht rückwärts — am 16.09.2025, also knapp einen Monat später, '
      + 'stand das Bezugsregister auf 8,3. Die Stadtwerke lesen ein anderes Register '
      + '(1-65:1.8.0 „Stand tariflos") als der Eigentümer (1.8.0).',
  },
];

/** Die Owner-Ablesung zum 31.12.2025, festgehalten an den vorhandenen Ständen. */
const OWNER_ABLESUNG: {
  nummer: string; tag: string; gemeldet: string; abrechnung: string; befund: string;
}[] = [
  {
    nummer: '1LGZ0075661373', tag: '2025-12-31', gemeldet: 'Bezug 1.580',
    abrechnung: '1.582',
    befund: 'Abweichung 2 kWh. Der Anfangsstand 0 vom 16.06.2025 ist in der Abrechnung '
      + 'ausgewiesen; der Verbrauch wäre nach der Owner-Ablesung 1.580 statt 1.582 kWh.',
  },
  {
    nummer: '1LGZ0078617709', tag: '2025-12-31', gemeldet: 'Bezug 665',
    abrechnung: '667',
    befund: 'Abweichung 2 kWh. Anfangsstand 28 vom 24.06.2025 laut Abrechnung; Verbrauch '
      + 'nach Owner-Ablesung 637 statt 639 kWh. Die im Auftrag genannte Rückrechnung '
      + '665 − 639 = 26 ergibt einen anderen Anfangsstand als die Abrechnung (28) — die '
      + 'Differenz ist dieselben 2 kWh.',
  },
  {
    nummer: '1LGZ0075661426', tag: '2025-12-31', gemeldet: 'Bezug 3.548',
    abrechnung: '3.558',
    befund: 'Abweichung 10 kWh. Anfangsstand 10 vom 24.06.2025 laut Abrechnung. '
      + 'Auffällig: Die Owner-Ablesung 3.548 ist genau die Menge, die die Abrechnung als '
      + 'VERBRAUCH ausweist (3.558 − 10). Ob der Eigentümer den Verbrauch statt des '
      + 'Standes gemeldet hat oder ob der Zähler tatsächlich bei 3.548 stand, ist aus '
      + 'der Bestätigung nicht zu erkennen.',
  },
  {
    nummer: '1LGZ0075661371', tag: '2025-12-31', gemeldet: 'Bezug 979',
    abrechnung: '979',
    befund: 'KEINE Abweichung im Stand. Aber die Abrechnung selbst ist in sich nicht '
      + 'stimmig: Sie nennt Anfangsstand 26, Endstand 979 und Verbrauch 954 — '
      + '979 − 26 sind jedoch 953. Ein Kilowattstunde Unterschied innerhalb desselben '
      + 'Dokuments. Die im Auftrag genannte Rückrechnung 979 − 954 = 25 trifft deshalb '
      + 'nicht den ausgewiesenen Anfangsstand 26.',
  },
  {
    nummer: '1LGZ0075675536', tag: '2025-12-31', gemeldet: 'Einspeisung 79',
    abrechnung: '4.430,98 (Erzeugung)',
    befund: 'AUFGEKLÄRT durch die Mail von Herrn Bauser an energiekonzept vom 07.01.2026: '
      + 'Das Gerät ist ein Zweiwegezähler und stand am 31.12.2025 auf 1.8.0 = 4.421 kWh '
      + 'und 2.8.0 = 79 kWh. Das Portal von energiekonzept lässt bei diesem Zähler nur '
      + 'ein Feld „Einspeisung" zu — deshalb wurden die 79 kWh gemeldet. Die erzeugte '
      + 'Menge ist 4.421 kWh und steht auf 1.8.0. Die 79 sind also kein Fehler des '
      + 'Ablesenden, sondern eine Einschränkung des Portals. Der erfasste Wert bleibt die '
      + 'Erzeugung aus der Abrechnung (4.430,98); zur Owner-Ablesung von 4.421 bleiben '
      + '10 kWh Unterschied.',
  },
  {
    nummer: '1LGZ0071678615', tag: '2025-12-31', gemeldet: 'Bezug nicht gemeldet, '
      + 'Einspeisung 5.095',
    abrechnung: 'Bezug 3.346,3 (Register 66,926 × 50); Einspeisung 5.100,2 '
      + '(Register 102,004 × 50)',
    befund: 'DER WANDLERFAKTOR 50 IST BESTÄTIGT. Die Mail von Herrn Bauser an '
      + 'energiekonzept vom 07.01.2026 nennt die Rohanzeige des Geräts zum 31.12.2025: '
      + '1.8.0 = 66,9 und 2.8.0 = 101,9. Mal 50 sind das 3.345 und 5.095 kWh. Die '
      + 'Abrechnung rechnet mit 66,926 und 102,004 — dieselben Werte. Das Portal von '
      + 'energiekonzept nimmt die Rohanzeige nicht an, sondern verlangt den bereits '
      + 'umgerechneten Wert; deshalb steht in der Meldung 5.095 statt 101,9. '
      + 'FOLGE FÜR DEN SWT-EINSPRUCH: Die Endabrechnung 0001-ARV-2026-8728 setzt für '
      + 'dieses Register bereits zum 21.08.2025 den Stand 243,993 an. Der Eigentümer hat '
      + 'am 16.09.2025 8,3 und am 31.12.2025 66,9 abgelesen. Ein Zählwerk läuft nicht '
      + 'rückwärts — der von den Stadtwerken angesetzte Stand kann für dieses Register '
      + 'nicht stimmen.',
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

  const { rows: zaehler } = await dbQuery<{ id: number; meter_number: string }>(
    /* Liegenschafts- UND Wohnungszähler: Die Wohnungszähler hängen an der
       Einheit, nicht am Objekt. */
    `SELECT m.id, m.meter_number FROM meters m
       LEFT JOIN properties p1 ON m.property_id = p1.id
       LEFT JOIN units u ON m.unit_id = u.id
       LEFT JOIN properties p2 ON u.property_id = p2.id
      WHERE COALESCE(p1.code, p2.code) = 'mg24' AND m.medium = 'electricity'`);
  const idVon = new Map(zaehler.map(z => [z.meter_number, z.id]));

  let neue = 0; let notizen = 0;

  console.log('Neue Stände aus der Mail vom 16.09.2025:');
  for (const n of NEU) {
    const meterId = idVon.get(n.nummer);
    if (!meterId) { console.log(`  ${n.nummer} FEHLT in der Datenbank`); continue; }
    const { rows } = await dbQuery<{ tag: string }>(
      "SELECT to_char(read_at,'YYYY-MM-DD') AS tag FROM meter_readings WHERE meter_id = $1",
      [meterId]);
    if (rows.some(r => r.tag === n.tag)) {
      console.log(`  ${n.nummer.padEnd(16)} ${n.tag} vorhanden`);
      continue;
    }
    console.log(`  ${n.nummer.padEnd(16)} ${n.tag} = ${n.wert} kWh  anlegen`);
    if (!anwenden) continue;
    await ruf(`/api/assets/meters/${meterId}/readings/bulk`, 'POST', {
      readings: [{
        value: n.wert, unit: 'kWh', reading_type: n.typ,
        read_at: `${n.tag}T00:00:00Z`, source: 'manual',
        reader_name: 'Matthias Bauser (Owner-Seite)', is_estimated: false,
        document_path: Q_BAUSER, notes: n.notiz,
      }],
    }, `mg24-${n.nummer}-${n.tag}`);
    neue++;
  }

  console.log('\nOwner-Ablesung 31.12.2025 an den vorhandenen Ständen festgehalten:');
  for (const a of OWNER_ABLESUNG) {
    const meterId = idVon.get(a.nummer);
    if (!meterId) { console.log(`  ${a.nummer} FEHLT in der Datenbank`); continue; }
    const { rows } = await dbQuery<{ id: number; notes: string | null }>(
      `SELECT id, notes FROM meter_readings
        WHERE meter_id = $1 AND read_at::date = $2::date`, [meterId, a.tag]);
    if (rows.length === 0) { console.log(`  ${a.nummer} ohne Stand am ${a.tag}`); continue; }
    if (rows.length > 1) { console.log(`  ${a.nummer} MEHRDEUTIG (${rows.length} Stände)`); continue; }

    const marke = 'OWNER-ABLESUNG 31.12.2025';
    const alt = (rows[0].notes ?? '').split(` ${marke}`)[0].trimEnd();
    const neuText = `${alt} ${marke} (${Q_OWNER}): gemeldet ${a.gemeldet}; `
      + `in der Abrechnung der Kundenanlage ${a.abrechnung}. ${a.befund}`;
    if (rows[0].notes === neuText) { console.log(`  ${a.nummer.padEnd(16)} unveraendert`); continue; }
    console.log(`  ${a.nummer.padEnd(16)} Notiz am ${a.tag}`);
    if (!anwenden) continue;
    await ruf(`/api/assets/meters/${meterId}/readings`, 'PATCH',
      { id: rows[0].id, notes: neuText });
    notizen++;
  }

  console.log(anwenden
    ? `\n${neue} Stände erfasst, ${notizen} Ablesenotizen ergänzt.`
    : '\nProbelauf — nichts geschrieben. Mit --apply ausführen.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
