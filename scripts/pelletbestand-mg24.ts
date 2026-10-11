#!/usr/bin/env bun
/**
 * Stellt die Brennstoffkosten von MG24 auf die Lagerbestandsrechnung um.
 *
 * § 7 Abs. 2 HeizkostenV legt „die Kosten der verbrauchten Brennstoffe" um —
 * nicht die Kosten der im Abrechnungsjahr GELIEFERTEN. Beides fällt
 * auseinander, sobald zum Jahreswechsel Pellets im Lager liegen:
 *
 *     Verbrauch = Anfangsbestand + Zukauf − Endbestand
 *
 * Bei MG24 kommt die Differenz nicht aus der Menge, sondern aus dem PREIS:
 * Anfangs- und Endbestand sind beide mit 5,00 t angesetzt, aber der
 * Anfangsbestand ist zum Preis der Lieferung vom 20.12.2024 bewertet
 * (339,17 EUR/t) und der Endbestand zum Preis der letzten Lieferung 2025
 * (437,55 EUR/t). Verbraucht wurde also das billige alte Lager, liegen blieb
 * das teurere neue — genau das bildet die Rechnung ab.
 *
 * UMSETZUNG über zwei zusätzliche Buchungen statt über eine Änderung der
 * Lieferbuchungen: Die drei Lieferungen bleiben als Zukauf stehen, dazu kommen
 * der Anfangsbestand als Zugang und der Endbestand als Abgang (negativ). So
 * bleibt jede Rechnung einzeln nachvollziehbar und die Bestandsrechnung ist an
 * den Buchungen selbst ablesbar.
 *
 * ZWEI ARBEITSANNAHMEN, beide in den Notizen gekennzeichnet:
 *   - Anfangsbestand 01.01.2025 = 5,00 t. Belegt ist nur, dass am 20.12.2024
 *     5,00 t geliefert wurden; dass davon zum Jahreswechsel noch (fast) alles
 *     im Lager lag, ist plausibel, aber nicht gemessen.
 *   - Endbestand 31.12.2025 = 5,00 t. Reine Annahme bis zur Owner-Antwort.
 *
 * Aufruf:
 *   bun run scripts/pelletbestand-mg24.ts --dry-run
 *   bun run scripts/pelletbestand-mg24.ts --apply
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

/** Die Lieferungen mit Menge und Betrag, aus den Koch-Rechnungen. */
const LIEFERUNGEN = {
  '910222': { tonnen: 5.00, brutto: 1695.84, datum: '2024-12-20' },
  '101657': { tonnen: 5.12, brutto: 2173.79, datum: '2025-03-11' },
  '106971': { tonnen: 3.80, brutto: 1502.39, datum: '2025-09-25' },
  '109505': { tonnen: 4.02, brutto: 1758.95, datum: '2025-12-15' },
} as const;

const JAHR = 2025;
const ANFANG_TONNEN = 5.00;
const ENDE_TONNEN = 5.00;

function preisJeTonne(re: keyof typeof LIEFERUNGEN): number {
  const l = LIEFERUNGEN[re];
  return l.brutto / l.tonnen;
}

async function main() {
  const anwenden = process.argv.includes('--apply');

  const anfangWert = LIEFERUNGEN['910222'].brutto;           // 5,00 t zum Preis von 910222
  const endePreis = preisJeTonne('109505');
  const endeWert = Math.round(ENDE_TONNEN * endePreis * 100) / 100;
  const zukaufTonnen = LIEFERUNGEN['101657'].tonnen + LIEFERUNGEN['106971'].tonnen
    + LIEFERUNGEN['109505'].tonnen;
  const zukaufWert = LIEFERUNGEN['101657'].brutto + LIEFERUNGEN['106971'].brutto
    + LIEFERUNGEN['109505'].brutto;
  const verbrauchWert = Math.round((anfangWert + zukaufWert - endeWert) * 100) / 100;
  const verbrauchTonnen = Math.round((ANFANG_TONNEN + zukaufTonnen - ENDE_TONNEN) * 100) / 100;

  console.log(`\nPelletbestand MG24 ${JAHR} — ${anwenden ? 'ANWENDEN' : 'Probelauf'}\n`);
  console.log(`  Anfangsbestand 01.01.  ${ANFANG_TONNEN.toFixed(2)} t  ${anfangWert.toFixed(2)} EUR`);
  console.log(`  Zukauf                 ${zukaufTonnen.toFixed(2)} t  ${zukaufWert.toFixed(2)} EUR`);
  console.log(`  Endbestand 31.12.     -${ENDE_TONNEN.toFixed(2)} t -${endeWert.toFixed(2)} EUR`);
  console.log(`  Verbrauch              ${verbrauchTonnen.toFixed(2)} t  ${verbrauchWert.toFixed(2)} EUR`);
  console.log(`  bisher nach Lieferdatum          ${zukaufWert.toFixed(2)} EUR`);
  console.log(`  Differenz                        ${(verbrauchWert - zukaufWert).toFixed(2)} EUR`);
  console.log(`  Energiemenge bei Hi 5 kWh/kg     ${(verbrauchTonnen * 5000).toFixed(0)} kWh\n`);

  const arten: any[] = await ruf('/api/assets/cost-categories');
  const heizungId = arten.find(a => a.code === 'heizung')?.id;
  if (!heizungId) throw new Error('Kostenart heizung nicht gefunden');

  const vorhanden: any[] = await ruf(`/api/assets/properties/${OBJEKT}/expense-bookings`);
  const nachKey = new Map(vorhanden.map(b => [b.source_key, b]));

  const buchungen = [
    {
      source_key: `mg24-${JAHR}-pellets-anfangsbestand`,
      betrag: anfangWert,
      von: `${JAHR}-01-01`, bis: `${JAHR}-01-01`,
      notiz: `Anfangsbestand Pelletlager 01.01.${JAHR}: ${ANFANG_TONNEN.toFixed(2)} t, bewertet `
        + `zum Preis der Lieferung 910222 vom 20.12.2024 (${preisJeTonne('910222').toFixed(2)} EUR/t). `
        + 'Umlage nach § 7 Abs. 2 HeizkostenV erfasst die Kosten der VERBRAUCHTEN Brennstoffe; '
        + 'der Verbrauch ergibt sich aus Anfangsbestand + Zukauf − Endbestand. '
        + 'ARBEITSANNAHME: Belegt ist nur die Liefermenge vom 20.12.2024. Dass davon zum '
        + 'Jahreswechsel noch 5,00 t im Lager lagen, ist plausibel (elf Tage Heizbetrieb), aber '
        + 'nicht gemessen. Zu ersetzen, sobald eine Bestandsangabe aus der KWB-Kesselsteuerung, '
        + 'der Leittechnik oder von Fa. Maurer vorliegt. Owner-Entscheidung 11.10.2026.',
    },
    {
      source_key: `mg24-${JAHR}-pellets-endbestand`,
      betrag: -endeWert,
      von: `${JAHR}-12-31`, bis: `${JAHR}-12-31`,
      notiz: `Endbestand Pelletlager 31.12.${JAHR}: ${ENDE_TONNEN.toFixed(2)} t, bewertet zum Preis `
        + `der letzten Lieferung 109505 vom 15.12.${JAHR} (${endePreis.toFixed(2)} EUR/t). `
        + 'Negativer Betrag, weil der Bestand am Jahresende NICHT verbraucht wurde und damit '
        + 'nicht in die Abrechnung gehört. '
        + 'ARBEITSANNAHME: Der Endbestand ist nicht erhoben. Angesetzt ist derselbe Wert wie der '
        + 'Anfangsbestand (5,00 t) — eine reine Annahme bis zur Antwort des Owners. Die '
        + 'Preisdifferenz zwischen Anfangs- und Endbestand ist der eigentliche Effekt dieser '
        + 'Rechnung: Verbraucht wurde das billigere alte Lager, liegen blieb das teurere neue. '
        + 'Owner-Entscheidung 11.10.2026.',
    },
  ];

  console.log('Buchungen:');
  let angelegt = 0;
  for (const b of buchungen) {
    if (nachKey.has(b.source_key)) {
      console.log(`  besteht  ${b.source_key}`);
      continue;
    }
    console.log(`  ${b.betrag.toFixed(2).padStart(10)} EUR  ${b.von}  ${b.source_key}`);
    if (anwenden) {
      await ruf(`/api/assets/properties/${OBJEKT}/expense-bookings`, 'POST', {
        source_key: b.source_key,
        cost_category_id: heizungId,
        vendor_name: 'Matthias Koch Brennstoffe, Trossingen',
        service_period_start: b.von,
        service_period_end: b.bis,
        amount_gross: b.betrag,
        umlagefaehig: true,
        notes: b.notiz,
      });
      angelegt++;
    }
  }

  // Kontrolle: Was steht jetzt als Heizungskosten im Zeitraum?
  if (anwenden) {
    const nachher: any[] = await ruf(`/api/assets/properties/${OBJEKT}/expense-bookings?year=${JAHR}`);
    const summe = nachher
      .filter(b => b.cost_category_code === 'heizung' && b.umlagefaehig)
      .reduce((s, b) => s + parseFloat(b.amount_gross), 0);
    console.log(`\n  Heizungskosten ${JAHR} jetzt: ${summe.toFixed(2)} EUR`);
    if (Math.abs(summe - verbrauchWert) > 0.02) {
      console.log(`  WARNUNG: erwartet ${verbrauchWert.toFixed(2)} EUR — Abweichung pruefen.`);
      process.exit(1);
    }
    console.log(`  stimmt mit der Bestandsrechnung ueberein.`);
    console.log(`\n  Angelegt: ${angelegt}`);
  } else {
    console.log('\n  Es wird NICHTS geschrieben. Anwenden mit --apply.');
  }
}

main().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });
