/**
 * scripts/mg24-energyportal — die am 13.10.2026 aus dem EnergyPortal geholten
 * MG24-Daten in bikosoc nachführen.
 *
 * Das Portal ist die genauere Quelle als die Abrechnung: Es nennt die Stände auf
 * drei Nachkommastellen, die Abrechnung rundet. Wo beide denselben Tag meinen,
 * wird der vorhandene Stand auf den Portalwert geschärft.
 *
 * Die Owner-Ablesung vom 31.12.2025 kommt als EIGENER Stand dazu und ersetzt den
 * Portalwert nicht. Beide sind an diesem Tag richtig: Der eine ist, was der
 * Eigentümer am Gerät gesehen hat, der andere, womit energiekonzept rechnet. Sie
 * unterscheiden sich um 2 bis 10 kWh, und genau diese Differenz soll sichtbar
 * bleiben statt in einer Notiz zu verschwinden.
 *
 * Gebucht wird der Allgemeinstrom 24.06.–31.12.2025 mit 413,33 EUR brutto. Weil
 * er umlagefähig ist, braucht er eine Umlageregel — ohne sie sperrt die
 * Vorprüfung die Abrechnung (ALLOCATION_RULE_GAP). Die Regel wird deshalb
 * mitangelegt, nach Fläche, wie alle anderen flächenbezogenen Kostenarten in
 * MG24.
 *
 * Aufruf:  bun run scripts/mg24-energyportal.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';
const Q_PORTAL = 'EnergyPortal energiekonzept, abgerufen 13.10.2026';
const Q_OWNER = 'Owner-Meldung an energiekonzept, Bestätigung 31.12.2025';

interface Stand {
  nummer: string; tag: string; wert: number; typ: string; leser: string;
  quelle: string; notiz: string;
}

/** Stände, die bisher ganz fehlen. */
const NEU: Stand[] = [
  {
    nummer: '1LGZ0075661373', tag: '2026-09-01', wert: 3920.62, typ: 'interim',
    leser: 'energiekonzept (Portal)', quelle: Q_PORTAL,
    notiz: 'Letzter im Portal geführter Stand. Zwischen dem 31.12.2025 und dem 01.09.2026 '
      + 'sind damit 2.338,62 kWh verbraucht worden (3.920,62 − 1.582).',
  },
  {
    nummer: '1LGZ0075661371', tag: '2026-09-01', wert: 2093.495, typ: 'interim',
    leser: 'energiekonzept (Portal)', quelle: Q_PORTAL,
    notiz: 'Letzter im Portal geführter Stand des Allgemeinstromzählers. Zwischen dem '
      + '31.12.2025 und dem 01.09.2026 sind damit 1.114,495 kWh verbraucht worden '
      + '(2.093,495 − 979) — in acht Monaten also mehr als im gesamten Rumpfjahr 2025.',
  },
  /* Die Ablesung des Eigentümers vom 31.12.2025. Sie steht neben dem Portalwert
     desselben Tages, nicht an seiner Stelle. */
  {
    nummer: '1LGZ0075661373', tag: '2025-12-31', wert: 1580, typ: 'annual',
    leser: 'Owner-Ablesung vor Ort', quelle: Q_OWNER,
    notiz: 'KUNDENABLESUNG. Am 31.12.2025 vor Ort abgelesen und über das EnergyPortal '
      + 'gemeldet. Für denselben Tag ist ein zweiter Stand erfasst — 1.582 aus der '
      + 'Abrechnung der Kundenanlage. Differenz 2 kWh.',
  },
  {
    nummer: '1LGZ0078617709', tag: '2025-12-31', wert: 665, typ: 'annual',
    leser: 'Owner-Ablesung vor Ort', quelle: Q_OWNER,
    notiz: 'KUNDENABLESUNG. Für denselben Tag ist ein zweiter Stand erfasst — 666,575 '
      + 'laut Portal. Differenz 1,575 kWh.',
  },
  {
    nummer: '1LGZ0075661426', tag: '2025-12-31', wert: 3548, typ: 'annual',
    leser: 'Owner-Ablesung vor Ort', quelle: Q_OWNER,
    notiz: 'KUNDENABLESUNG. Für denselben Tag ist ein zweiter Stand erfasst — 3.557,731 '
      + 'laut Portal. Differenz 9,731 kWh. Auffällig bleibt, dass 3.548 genau die Menge '
      + 'ist, die die Abrechnung als Verbrauch ausweist.',
  },
  {
    nummer: '1LGZ0075661371', tag: '2025-12-31', wert: 979, typ: 'annual',
    leser: 'Owner-Ablesung vor Ort', quelle: Q_OWNER,
    notiz: 'KUNDENABLESUNG. Sie stimmt mit dem Wert der Abrechnung überein; für denselben '
      + 'Tag ist dieser zweite Stand mit demselben Wert erfasst.',
  },
];

/** Vorhandene Stände, die das Portal genauer angibt als die gerundete Abrechnung. */
const SCHAERFEN: { nummer: string; tag: string; wert: number; notiz: string }[] = [
  {
    nummer: '1LGZ0078617709', tag: '2025-12-31', wert: 666.575,
    notiz: 'Verbrauch 24.06.–31.12.2025: 639 kWh. Wert am 13.10.2026 aus dem EnergyPortal '
      + 'geschärft — die Abrechnung der Kundenanlage rundet auf 667, das Portal führt '
      + '666,575. Die Owner-Ablesung desselben Tages (665) ist als eigener Stand erfasst.',
  },
  {
    nummer: '1LGZ0075661426', tag: '2025-12-31', wert: 3557.731,
    notiz: 'Verbrauch 24.06.–31.12.2025: 3.548 kWh. Wert am 13.10.2026 aus dem '
      + 'EnergyPortal geschärft — die Abrechnung rundet auf 3.558, das Portal führt '
      + '3.557,731. Die Owner-Ablesung desselben Tages (3.548) ist als eigener Stand '
      + 'erfasst.',
  },
];

/** Zählernotizen: Mieterstromforderungen 2025 und Mahnstand 2026. */
const ZAEHLERNOTIZ: { nummer: string; anhang: string }[] = [
  {
    nummer: '1LGZ0075661371',
    anhang: 'MIETERSTROMRECHNUNG 2025 (Stand 13.10.2026): Kunde 390-001, Vertrag 390-V001, '
      + 'Allgemeinstrom auf Jürgen Bickel selbst. 29,6 + 927,3 kWh, 413,33 EUR brutto '
      + '(347,34 EUR netto). Preise brutto 38,00 ct/kWh und 95,00 EUR im Jahr, '
      + 'einschließlich 19 % Umsatzsteuer. '
      + 'STATUS: Testrechnung, Versand ungeklärt — die Rechnung liegt im EnergyPortal nur '
      + 'als TEST-JA2025 vor, und in keiner Mahnung von März bis September 2026 taucht '
      + 'eine Forderung aus 2025 auf. Als Ertrag ist nichts gebucht. '
      + 'Die abgerechnete Menge von 956,9 kWh weicht um 2,9 kWh von den 954 kWh ab, die '
      + 'die Abrechnung der Kundenanlage als Verbrauch ausweist.',
  },
  {
    nummer: '1LGZ0075661373',
    anhang: 'MIETERSTROMRECHNUNG 2025 (Stand 13.10.2026): Kunde 390-002, Vertrag 390-V002, '
      + 'Wohnung 1 (Abert). 636,01 EUR brutto. '
      + 'STATUS: Testrechnung, Versand ungeklärt — nur als TEST-JA2025 im EnergyPortal; '
      + 'in keiner Mahnung von März bis September 2026 erscheint eine Forderung aus 2025. '
      + 'Als Ertrag ist nichts gebucht.',
  },
  {
    nummer: '1LGZ0078617709',
    anhang: 'MIETERSTROMRECHNUNG 2025 (Stand 13.10.2026): Kunde 390-003, Vertrag 390-V004, '
      + 'Wohnung 2 (Lazic). 299,14 EUR brutto. '
      + 'STATUS: Testrechnung, Versand ungeklärt — nur als TEST-JA2025 im EnergyPortal. '
      + 'Als Ertrag ist nichts gebucht. '
      + 'MAHNSTAND 2026: Mahnung vom 23.09.2026 über die Abschläge Juli bis September 2026, '
      + '3 × 71,00 = 213,00 EUR offen. Die Zahlungen laufen über das Stromkonto mit der '
      + 'Endziffer 8621, das in bikosoc nicht synchronisiert ist; der Ausgleich ist hier '
      + 'deshalb nicht nachvollziehbar.',
  },
  {
    nummer: '1LGZ0075661426',
    anhang: 'MIETERSTROMRECHNUNG 2025 (Stand 13.10.2026): Kunde 390-004, Vertrag 390-V003, '
      + 'Wohnung 3 (Saber). 1.391,18 EUR brutto. '
      + 'STATUS: Testrechnung, Versand ungeklärt — nur als TEST-JA2025 im EnergyPortal. '
      + 'Als Ertrag ist nichts gebucht. '
      + 'MAHNSTAND 2026: Mahnung vom 23.09.2026 über die Abschläge August und September '
      + '2026, 2 × 71,00 = 142,00 EUR offen. Die Zahlungen laufen über das Stromkonto mit '
      + 'der Endziffer 8621, das in bikosoc nicht synchronisiert ist.',
  },
  {
    nummer: '1LGZ0071678615',
    anhang: 'BESTÄTIGT AM 13.10.2026 aus dem EnergyPortal: Die Abrechnung der Kundenanlage '
      + 'rechnet mit Wandlerfaktor 50 — Bezug 1.8.0 von 0 am 23.06.2025 auf 66,926 am '
      + '31.12.2025 (= 3.346,3 kWh), Einspeisung 2.8.0 von 0 auf 102,004 (= 5.100,2 kWh). '
      + 'DER FAKTOR 50 IST ALSO RICHTIG; der frühere Verdacht, er sei zu Unrecht '
      + 'angesetzt, ist damit erledigt. Der Widerspruch gegen die Stadtwerke stützt sich '
      + 'allein auf den ABLESEWERT: Die SWT-Schlussrechnung setzt für dieses Register zum '
      + '21.08.2025 bereits 243,993 an, während es am 31.12.2025 erst auf 66,926 steht. '
      + 'Ein Zählwerk läuft nicht rückwärts.',
  },
];

/** Die beiden Buchungen, die den überholten Einspruchsgrund tragen. */
const EINSPRUCH_UEBERHOLT =
  ' BERICHTIGT AM 13.10.2026 — DIESE BEGRÜNDUNG IST ÜBERHOLT. Die Abrechnung der '
  + 'Kundenanlage im EnergyPortal rechnet selbst mit dem Wandlerfaktor 50 (Register '
  + '66,926 × 50 = 3.346,3 kWh Bezug, 102,004 × 50 = 5.100,2 kWh Einspeisung). Der Faktor '
  + 'ist damit korrekt, und die oben vermutete Rückforderung von rund 4.744 EUR wegen '
  + 'eines zu Unrecht angesetzten Wandlers besteht nicht. '
  + 'DER WIDERSPRUCH BLEIBT, aber aus einem anderen Grund: Die Stadtwerke setzen für das '
  + 'Bezugsregister 1.8.0 zum 21.08.2025 den Stand 243,993 an. Dasselbe Register stand am '
  + '16.09.2025 auf 8,3 und am 31.12.2025 auf 66,926. Nicht der Faktor ist falsch, '
  + 'sondern der Ablesewert.';

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
    `SELECT m.id, m.meter_number FROM meters m
       LEFT JOIN properties p1 ON m.property_id = p1.id
       LEFT JOIN units u ON m.unit_id = u.id
       LEFT JOIN properties p2 ON u.property_id = p2.id
      WHERE COALESCE(p1.code, p2.code) = 'mg24' AND m.medium = 'electricity'`);
  const idVon = new Map(zaehler.map(z => [z.meter_number, z.id]));

  let neue = 0; let geschaerft = 0; let notizen = 0; let gebucht = 0; let regeln = 0;

  console.log('Neue Stände:');
  for (const n of NEU) {
    const meterId = idVon.get(n.nummer);
    if (!meterId) { console.log(`  ${n.nummer} FEHLT`); continue; }
    /* Gleicher Tag UND gleicher Leser gilt als derselbe Stand — so kann die
       Owner-Ablesung neben dem Portalwert desselben Tages stehen. */
    const { rows } = await dbQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM meter_readings
        WHERE meter_id = $1 AND read_at::date = $2::date AND reader_name = $3`,
      [meterId, n.tag, n.leser]);
    if (rows[0].n !== '0') {
      console.log(`  ${n.nummer.padEnd(16)} ${n.tag} ${n.leser} vorhanden`);
      continue;
    }
    console.log(`  ${n.nummer.padEnd(16)} ${n.tag} = ${n.wert}  (${n.leser})`);
    if (!anwenden) continue;
    await ruf(`/api/assets/meters/${meterId}/readings/bulk`, 'POST', {
      readings: [{
        value: n.wert, unit: 'kWh', reading_type: n.typ,
        read_at: `${n.tag}T00:00:00Z`, source: 'manual', reader_name: n.leser,
        is_estimated: false, document_path: n.quelle, notes: n.notiz,
      }],
    }, `mg24ep-${n.nummer}-${n.tag}-${n.leser.slice(0, 12)}`);
    neue++;
  }

  console.log('\nAuf die Portalgenauigkeit geschärft:');
  for (const s of SCHAERFEN) {
    const meterId = idVon.get(s.nummer);
    if (!meterId) { console.log(`  ${s.nummer} FEHLT`); continue; }
    const { rows } = await dbQuery<{ id: number; value: string; notes: string | null }>(
      `SELECT id, value::text, notes FROM meter_readings
        WHERE meter_id = $1 AND read_at::date = $2::date
          AND reader_name <> 'Owner-Ablesung vor Ort'`, [meterId, s.tag]);
    if (rows.length !== 1) { console.log(`  ${s.nummer} ${rows.length} Treffer — übersprungen`); continue; }
    if (Number(rows[0].value) === s.wert && rows[0].notes === s.notiz) {
      console.log(`  ${s.nummer.padEnd(16)} unveraendert`); continue;
    }
    console.log(`  ${s.nummer.padEnd(16)} ${rows[0].value} → ${s.wert}`);
    if (!anwenden) continue;
    await ruf(`/api/assets/meters/${meterId}/readings`, 'PATCH',
      { id: rows[0].id, value: s.wert, notes: s.notiz, document_path: Q_PORTAL });
    geschaerft++;
  }

  console.log('\nZählernotizen:');
  for (const z of ZAEHLERNOTIZ) {
    const meterId = idVon.get(z.nummer);
    if (!meterId) { console.log(`  ${z.nummer} FEHLT`); continue; }
    const { rows } = await dbQuery<{ notes: string | null }>(
      'SELECT notes FROM meters WHERE id = $1', [meterId]);
    const marke = z.anhang.split(':')[0];
    const basis = (rows[0].notes ?? '').split(` ${marke}`)[0].trimEnd();
    const neuText = `${basis} ${z.anhang}`;
    if (rows[0].notes === neuText) { console.log(`  ${z.nummer.padEnd(16)} unveraendert`); continue; }
    console.log(`  ${z.nummer.padEnd(16)} Notiz`);
    if (!anwenden) continue;
    await ruf(`/api/assets/meters/${meterId}`, 'PATCH', { notes: neuText });
    notizen++;
  }

  console.log('\nÜberholter Einspruchsgrund:');
  const { rows: buchungen } = await dbQuery<{ id: number; notes: string }>(
    "SELECT id, notes FROM expense_bookings WHERE notes ~* 'PRUEFUNG 11.10.2026' ORDER BY id");
  for (const b of buchungen) {
    const basis = b.notes.split(' BERICHTIGT AM 13.10.2026')[0].trimEnd();
    const neuText = basis + EINSPRUCH_UEBERHOLT;
    if (b.notes === neuText) { console.log(`  Buchung ${b.id} unveraendert`); continue; }
    console.log(`  Buchung ${b.id} berichtigt`);
    if (!anwenden) continue;
    /* Die Buchungs-ID steht im Pfad, nicht im Rumpf. */
    await ruf(`/api/assets/properties/mg24/expense-bookings/${b.id}`, 'PATCH',
      { notes: neuText });
    notizen++;
  }

  console.log('\nAllgemeinstrom 2025:');
  const { rows: vorhanden } = await dbQuery<{ n: string }>(
    `SELECT count(*)::text AS n FROM expense_bookings b
       JOIN properties p ON b.property_id = p.id
      WHERE p.code = 'mg24' AND b.cost_category_id = 11
        AND b.service_period_start = '2025-06-24'`);
  if (vorhanden[0].n !== '0') {
    console.log('  Buchung vorhanden');
  } else {
    console.log('  413,33 EUR brutto, 24.06.–31.12.2025, umlagefähig, Kostenart beleuchtung');
    if (anwenden) {
      await ruf('/api/assets/properties/mg24/expense-bookings', 'POST', {
        cost_category_id: 11, amount_gross: 413.33, amount_net: 347.34,
        vat_amount: 65.99, vat_rate: 19,
        service_period_start: '2025-06-24', service_period_end: '2025-12-31',
        vendor_name: 'Jürgen Bickel (Mieterstrom, Eigenbelieferung)',
        invoice_number: '390-001 / 390-V001',
        umlagefaehig: true, document_path: Q_PORTAL,
        notes: 'Allgemeinstrom der Kundenanlage, 24.06.–31.12.2025, 956,9 kWh '
          + '(29,6 + 927,3). Grundlage ist die Mieterstromrechnung 390-001 aus dem '
          + 'EnergyPortal: 38,00 ct/kWh und 95,00 EUR im Jahr, beides brutto und '
          + 'einschließlich 19 % Umsatzsteuer. Umlagefähig nach BetrKV § 2 Nr. 11. '
          + 'VORLÄUFIG — PREISANSATZ OFFEN: Angesetzt ist der Mieterstromtarif, den der '
          + 'Vermieter sich selbst in Rechnung stellt. Ob das zulässig ist oder nur die '
          + 'tatsächlichen Bezugskosten angesetzt werden dürfen, ist die offene '
          + 'Entscheidung E aus report-mieterstrom-energiekonzept-recherche-20261013. '
          + 'Der Zeitraum 01.01.–23.06.2025 ist weiter offen: Dort lief über denselben '
          + 'Zählpunkt der gesamte Hausstrom (900 kWh, 378,22 EUR netto), eine Aufteilung '
          + 'in Allgemein- und Wohnungsanteil ist nicht belegt.',
      }, 'mg24-allgemeinstrom-2025');
      gebucht++;
    }
  }

  const { rows: regel } = await dbQuery<{ n: string }>(
    `SELECT count(*)::text AS n FROM allocation_rules a JOIN properties p ON a.property_id = p.id
      WHERE p.code = 'mg24' AND a.cost_category_id = 11`);
  if (regel[0].n !== '0') {
    console.log('  Umlageregel vorhanden');
  } else {
    console.log('  Umlageregel beleuchtung nach Fläche anlegen');
    if (anwenden) {
      await ruf('/api/assets/properties/mg24/allocation-rules', 'POST', {
        cost_category_id: 11, key_type: 'sqm', valid_from: '2025-01-01',
        source: 'manual',
        notes: 'Allgemeinstrom nach Wohnfläche. Angelegt am 13.10.2026 zusammen mit der '
          + 'ersten Allgemeinstrombuchung — eine umlagefähige Kostenart ohne Umlageregel '
          + 'sperrt die Abrechnung. Fläche ist der Schlüssel, den MG24 für alle übrigen '
          + 'nicht verbrauchsabhängigen Kostenarten verwendet.',
      }, 'mg24-regel-beleuchtung');
      regeln++;
    }
  }

  console.log(anwenden
    ? `\n${neue} Stände erfasst, ${geschaerft} geschärft, ${notizen} Notizen, `
      + `${gebucht} Buchung, ${regeln} Umlageregel.`
    : '\nProbelauf — nichts geschrieben. Mit --apply ausführen.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
