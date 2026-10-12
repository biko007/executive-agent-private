/**
 * scripts/protokollstaende-n24-w6 — Verbrauchsschnitt in N24 W6 auf die
 * Übergabeprotokolle legen.
 *
 * OWNER-ENTSCHEIDUNG 13.10.2026: „Verbrauch nach Protokoll, Umlage nach
 * Vertrag." Die Wohnung stand zwischen Auszug und Einzug rund einen Monat
 * leer; was in dieser Zeit verbraucht wurde, trägt der Eigentümer.
 *
 *   Schweigert-Hasi   Verbrauch 01.01. bis 27.10.2025, Vertrag bis 30.11.2025
 *   Zwischenzeit      27.10. bis 24.11.2025 — kein Mietverhältnis
 *   Westhauser        Verbrauch ab 24.11.2025, Vertrag ab 01.12.2025
 *
 * Umgesetzt ohne neues Mietverhältnis: `nutzungsAbschnitt()` bildet den
 * Verbrauchsabschnitt aus `handover_at` und `actual_move_out`, die Kosten nach
 * Fläche laufen über `calculateProRata()` unverändert nach Vertrag. Der
 * Verbrauch in der Lücke ist keinem Mietverhältnis zugeordnet und landet im
 * Eigentümerblock — wirtschaftlich dasselbe wie eine Zwischenmiete, aber ohne
 * ein Mietverhältnis, das sich mit den beiden anderen überschneidet.
 *
 * ZWEI KORREKTUREN AN VORHANDENEN DATEN:
 *
 *   1. `actual_move_out` von Schweigert-Hasi stand auf dem 15.11.2025. Das
 *      unterschriebene Übergabeprotokoll trägt den 27.10.2025, und der
 *      Logger zeigt für den 27.10. dieselben Stände wie das Protokoll. Der
 *      15.11. stammt aus einer mündlichen Angabe und ist durch das Dokument
 *      überholt.
 *   2. Die Logger-Stände zum 30.11.2025 bleiben erhalten, sind aber nicht mehr
 *      der Wechselschnitt. Sie werden von `move_out` auf `interim` umgestellt.
 *
 * EIN WERT IST BEWUSST KORRIGIERT: Im Protokoll vom 27.10.2025 steht für den
 * Warmwasserzähler 24355989 „0,817 MWh". Der Logger weist für denselben Tag
 * 916 kWh aus, das Protokoll vom 24.11.2025 nennt 0,917 MWh, und 817 läge
 * UNTER dem Stand vom 20.10. (905). Die 8 ist eine verschriebene 9.
 *
 * Aufruf:  bun run scripts/protokollstaende-n24-w6.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';

const PROTOKOLL_AUSZUG = '2025-10-27';
const PROTOKOLL_EINZUG = '2025-11-24';

const BELEG_AUSZUG = 'N24/Übergabeprotokolle/'
  + '2025-10-27_N24_Übergabeprotokoll_Schweigert_WHG 6+6a_signed.pdf';
const BELEG_EINZUG = 'N24/Übergabeprotokolle/'
  + '2025-11-24_N24_Übergabeprotokoll vor Einzug_Fam. Westhauser_WHG6+6a_signed.pdf';

interface Stand {
  zaehler: string;
  einheit: 'kWh' | 'm3';
  bezeichnung: string;
  /** Stand im Auszugsprotokoll vom 27.10.2025. */
  auszug: number;
  /** Stand im Protokoll vor Einzug vom 24.11.2025. */
  einzug: number;
  /** Abweichung zum Protokollwert, falls korrigiert. */
  korrektur?: string;
}

const STAENDE: Stand[] = [
  {
    zaehler: '24454023', einheit: 'kWh', bezeichnung: 'Heizung Hauptwohnung',
    auszug: 6027, einzug: 6401,
  },
  {
    zaehler: '24355989', einheit: 'kWh', bezeichnung: 'Warmwasser Hauptwohnung',
    auszug: 916, einzug: 917,
    korrektur: 'Im Protokoll steht „0,817 MWh". Übernommen sind 916 kWh — der Stand, den '
      + 'der Logger für den 27.10.2025 ausweist. Begründung: 817 läge unter dem Stand vom '
      + '20.10.2025 (905 kWh), ein Zähler läuft nicht rückwärts; das Protokoll vom '
      + '24.11.2025 nennt 0,917 MWh; der Logger zeigt am 27.10. genau 916 und ab dem '
      + '03.11. 917 kWh. Die 8 ist eine verschriebene 9.',
  },
  {
    zaehler: '02153079', einheit: 'm3', bezeichnung: 'Kaltwasser Hauptwohnung',
    auszug: 81.033, einzug: 81.108,
  },
  {
    zaehler: '24454030', einheit: 'kWh', bezeichnung: 'Heizung Einliegerwohnung',
    auszug: 684, einzug: 731,
  },
  {
    zaehler: '24355985', einheit: 'kWh', bezeichnung: 'Warmwasser Einliegerwohnung',
    auszug: 14, einzug: 14,
  },
  {
    zaehler: '02156403', einheit: 'm3', bezeichnung: 'Kaltwasser Einliegerwohnung',
    auszug: 5.035, einzug: 5.047,
  },
];

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt`);
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

  const { rows: vertraege } = await dbQuery<any>(
    `SELECT l.id, l.lease_number, l.start_date, l.handover_at, l.end_date, l.actual_move_out
       FROM leases l JOIN units u ON l.unit_id = u.id
      WHERE u.property_id = 4 AND u.code = 'W6' ORDER BY l.start_date`);
  const alt = vertraege.find(v => v.lease_number === 'n24-w6-2024');
  const neu = vertraege.find(v => v.lease_number === 'n24-w6-2025');
  if (!alt || !neu) throw new Error('Mietverhältnisse W6 nicht gefunden');

  // ── 1. Übergabedaten setzen ──────────────────────────────────────────────
  console.log('Übergabedaten:');
  console.log(`  ${alt.lease_number}: actual_move_out ${String(alt.actual_move_out).slice(0, 10)} → ${PROTOKOLL_AUSZUG}`);
  console.log(`  ${neu.lease_number}: handover_at     ${String(neu.handover_at).slice(0, 10)} → ${PROTOKOLL_EINZUG}`);
  if (anwenden) {
    await ruf(`/api/assets/leases/${alt.id}`, 'PATCH', {
      actual_move_out: PROTOKOLL_AUSZUG,
      notes: 'Übergabe am 27.10.2025 laut unterschriebenem Übergabeprotokoll '
        + `(${BELEG_AUSZUG}); der Logger bestätigt die Stände desselben Tages. Der früher `
        + 'erfasste 15.11.2025 beruhte auf einer mündlichen Angabe und ist damit überholt. '
        + 'Vertragsende bleibt der 30.11.2025: Bis dahin trägt der Vormieter die Kosten '
        + 'nach Fläche; der Verbrauch endet mit der Übergabe (Owner-Entscheidung '
        + '13.10.2026).',
    });
    await ruf(`/api/assets/leases/${neu.id}`, 'PATCH', {
      handover_at: PROTOKOLL_EINZUG,
      notes: `Übergabe vor Einzug am 24.11.2025 laut Protokoll (${BELEG_EINZUG}). `
        + 'Mietbeginn bleibt der 01.12.2025: Die Kosten nach Fläche laufen ab Vertrag, '
        + 'der Verbrauch ab Übergabe.',
    });
  }

  // ── 2. Protokollstände erfassen ──────────────────────────────────────────
  const { rows: zaehler } = await dbQuery<any>(
    `SELECT m.id, m.meter_number FROM meters m JOIN units u ON m.unit_id = u.id
      WHERE u.property_id = 4 AND u.code = 'W6'`);
  const idVon = new Map<string, number>(zaehler.map(z => [z.meter_number, z.id]));

  let erfasst = 0;
  console.log('\nProtokollstände:');
  for (const s of STAENDE) {
    const meterId = idVon.get(s.zaehler);
    if (!meterId) { console.log(`  ${s.zaehler} FEHLT in der Datenbank`); continue; }
    const { rows: da } = await dbQuery<any>(
      'SELECT read_at::date AS tag FROM meter_readings WHERE meter_id = $1', [meterId]);
    const schonDa = new Set(da.map(d => String(d.tag).slice(0, 10)));

    for (const [tag, wert, art, beleg] of [
      [PROTOKOLL_AUSZUG, s.auszug, 'Auszug Schweigert-Hasi', BELEG_AUSZUG],
      [PROTOKOLL_EINZUG, s.einzug, 'Einzug Westhauser', BELEG_EINZUG],
    ] as [string, number, string, string][]) {
      const status = schonDa.has(tag) ? 'besteht' : 'anlegen';
      console.log(`  ${s.zaehler}  ${tag}  ${String(wert).padStart(9)} ${s.einheit.padEnd(3)} `
        + `${art.padEnd(24)} ${status}${s.korrektur && tag === PROTOKOLL_AUSZUG ? '  (korrigiert)' : ''}`);
      if (schonDa.has(tag) || !anwenden) continue;
      await ruf(`/api/assets/meters/${meterId}/readings/bulk`, 'POST', {
        readings: [{
          value: wert,
          unit: s.einheit,
          reading_type: tag === PROTOKOLL_AUSZUG ? 'move_out' : 'move_in',
          read_at: `${tag}T12:00:00Z`,
          source: 'manual',
          reader_name: 'Übergabeprotokoll',
          is_estimated: false,
          notes: `${s.bezeichnung}, Stand laut unterschriebenem Übergabeprotokoll vom `
            + `${tag} (${beleg}). Dieser Stand schneidet den VERBRAUCH zwischen den `
            + 'Nutzern (Owner-Entscheidung 13.10.2026: Verbrauch nach Protokoll, Umlage '
            + 'nach Vertrag). ' + (s.korrektur && tag === PROTOKOLL_AUSZUG ? s.korrektur : ''),
        }],
      }, `n24-w6-protokoll-${s.zaehler}-${tag}`);
      erfasst++;
    }
  }

  // ── 3. Die Logger-Stände zum 30.11. sind nicht mehr der Schnitt ──────────
  const { rows: alte } = await dbQuery<any>(
    `SELECT r.id, m.meter_number FROM meter_readings r JOIN meters m ON r.meter_id = m.id
      JOIN units u ON m.unit_id = u.id
     WHERE u.property_id = 4 AND u.code = 'W6' AND r.read_at::date = '2025-11-30'`);
  console.log(`\nLogger-Stände 30.11.2025: ${alte.length} Stück → auf "interim" umstellen`);
  if (anwenden) {
    for (const a of alte) {
      await ruf(`/api/assets/meters/0/readings`, 'PATCH', {
        id: a.id,
        reading_type: 'interim',
        notes: 'Logger-Aufzeichnung vom 01.12.2025, 00:00:20 Uhr — der Stand am Ende des '
          + '30.11.2025 (Vertragsende Schweigert-Hasi). NICHT MEHR DER VERBRAUCHSSCHNITT: '
          + 'Seit der Owner-Entscheidung vom 13.10.2026 wird der Verbrauch an den '
          + 'Übergabeprotokollen geschnitten (27.10. und 24.11.2025); bis zum Vertragsende '
          + 'laufen nur noch die Kosten nach Fläche. Der Stand bleibt als Beleg des '
          + 'Verlaufs erfasst.',
      });
    }
  }

  console.log(anwenden
    ? `\n${erfasst} Protokollstände erfasst, ${alte.length} Ablesungen umgestellt.`
    : '\nProbelauf — nichts geschrieben.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
