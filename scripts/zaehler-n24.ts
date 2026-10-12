/**
 * scripts/zaehler-n24 — Zähler und Zählerstände für N24 anlegen.
 *
 * QUELLE. `docs/projekt/N24-Zaehler-Merkblatt.md` (Dropbox, Stand 12.10.2026,
 * 22:30 Uhr). Darin sind alle 36 Wohnungszähler des Hauses eindeutig zwischen
 * drei Systemen zugeordnet: M-Bus-Logger (Relay WebLog 250 TX8M), Casameta
 * (LS-Nr. 0030757-2) und bikosoc.
 *
 * Drei Stände je Zähler:
 *
 *   - 31.12.2024 — Endstand der Casameta-Abrechnung 2024 (Quelle: Portal)
 *   - 31.12.2025 — der im Zähler gespeicherte Stichtagswert, per M-Bus gelesen
 *     am 12.10.2026. Deshalb ist die Abrechnung 2025 ohne Ablesung vor Ort
 *     möglich.
 *   - 12.10.2026 — der Live-Wert desselben LeseVorgangs, als Beleg und für die
 *     Plausibilität 2026.
 *
 * ZÄHLERTYPEN. Die Warmwasserzähler sind WÄRMEZÄHLER: Sie messen die Energie
 * zum Erwärmen in kWh, nicht das Volumen. Casameta führt sie 2024 ebenso.
 * Deshalb `medium = 'heat'` mit `submetering_purpose = 'warm_water_heat'` —
 * damit greift in der NK-Engine Methode B (§ 9 Abs. 1 HeizkostenV, getrennte
 * Messung von Raumwärme und Warmwasserwärme) und nicht die Schätzformel nach
 * § 9 Abs. 2. Das Warmwasser-VOLUMEN wird in diesem Haus nirgends gemessen.
 *
 * ZUORDNUNG. Casameta zählt die Wohnungen anders als bikosoc: Casameta Nr. 3
 * ist bikosoc W4, Casameta Nr. 4 ist bikosoc W3. Jede bikosoc-Einheit umfasst
 * die Hauptwohnung UND die Einliegerwohnung („a"), also sechs Zähler.
 *
 * Geschrieben wird ausschließlich über die bestehenden Core-Routen
 * `POST /api/assets/meters`, `POST /api/assets/meters/:id/readings/bulk` und
 * `PUT /api/assets/properties/n24/heating-config` — jeweils mit Audit-Eintrag.
 * Kein Direktschreiben an der Datenbank. Der Lauf ist wiederholbar: Vorhandenes
 * wird übersprungen, nicht überschrieben.
 *
 * Aufruf:  bun run scripts/zaehler-n24.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';
const OBJEKT_ID = 4;
const OBJEKT_CODE = 'n24';
const JAHR = 2025;

/** Lesezeitpunkt der Stichtags- und Live-Werte (Ortszeit 21:40 Uhr MESZ). */
const LIVE_ZEITPUNKT = '2026-10-12T19:40:00Z';

type Art = 'heizung' | 'warmwasser' | 'kaltwasser';

interface Zaehler {
  seriennummer: string;
  logger: string;
  art: Art;
  /** bikosoc-Einheit */
  wohnung: string;
  /** Hauptwohnung oder Einliegerwohnung */
  teil: 'Hauptwohnung' | 'Einliegerwohnung';
  /** Casameta-Abschnittsnummer */
  casameta: string;
  stand2024: number;
  stand2025: number;
  live: number;
  /** Gerätefehler aus dem Merkblatt, Abschnitt „Auffälligkeiten". */
  befund?: string;
}

/* Die 36 Wohnungszähler. Reihenfolge wie im Merkblatt, nach Casameta-Nummern.
   „E1" ist das EG, „E2" das 1. OG, „E3" das 2. OG (Logger-Bezeichnung). */
const WOHNUNGSZAEHLER: Zaehler[] = [
  // Casameta Nr. 1 — bikosoc W1 (EG West)
  { seriennummer: '24355982', logger: 'E1 West Warmwasser', art: 'warmwasser', wohnung: 'W1', teil: 'Hauptwohnung', casameta: '1', stand2024: 233, stand2025: 552, live: 770 },
  { seriennummer: '02156411', logger: 'E1 West Kaltwasser', art: 'kaltwasser', wohnung: 'W1', teil: 'Hauptwohnung', casameta: '1', stand2024: 20.240, stand2025: 47.789, live: 69.352 },
  { seriennummer: '24454035', logger: 'E1 West Heizung', art: 'heizung', wohnung: 'W1', teil: 'Hauptwohnung', casameta: '1', stand2024: 5226, stand2025: 9769, live: 12408 },
  { seriennummer: '24355990', logger: 'E1 West ELW Warmwasser', art: 'warmwasser', wohnung: 'W1', teil: 'Einliegerwohnung', casameta: '1a', stand2024: 68, stand2025: 161, live: 216 },
  { seriennummer: '02156427', logger: 'E1 West ELW Kaltwasser', art: 'kaltwasser', wohnung: 'W1', teil: 'Einliegerwohnung', casameta: '1a', stand2024: 10.270, stand2025: 26.191, live: 36.708 },
  { seriennummer: '24355988', logger: 'E1 West ELW Heizung', art: 'heizung', wohnung: 'W1', teil: 'Einliegerwohnung', casameta: '1a', stand2024: 554, stand2025: 675, live: 1003 },

  // Casameta Nr. 2 — bikosoc W2 (EG Ost)
  {
    seriennummer: '24355987', logger: 'E1 Ost Warmwasser', art: 'warmwasser', wohnung: 'W2', teil: 'Hauptwohnung', casameta: '2',
    stand2024: 3365, stand2025: 7795, live: 11872,
    befund: 'FEHLERCODE: Fehler-Flag 64 (Herstellercode, Bedeutung laut Datenblatt zu klären). '
      + 'Zugleich der höchste Warmwasserverbrauch im Haus: 4.430 kWh 2025, bis 12.10.2026 '
      + 'bereits 4.077 kWh. Der Zähler prägt die Warmwasserverteilung und sollte vor der '
      + 'Abrechnung geprüft werden.',
  },
  { seriennummer: '02156440', logger: 'E1 Ost Kaltwasser', art: 'kaltwasser', wohnung: 'W2', teil: 'Hauptwohnung', casameta: '2', stand2024: 171.030, stand2025: 372.905, live: 583.291 },
  { seriennummer: '24454027', logger: 'E1 Ost Heizung', art: 'heizung', wohnung: 'W2', teil: 'Hauptwohnung', casameta: '2', stand2024: 5046, stand2025: 8901, live: 10985 },
  { seriennummer: '24454031', logger: 'E1 Ost ELW Warmwasser', art: 'warmwasser', wohnung: 'W2', teil: 'Einliegerwohnung', casameta: '2a', stand2024: 1271, stand2025: 2017, live: 3491 },
  { seriennummer: '02156407', logger: 'E1 Ost ELW Kaltwasser', art: 'kaltwasser', wohnung: 'W2', teil: 'Einliegerwohnung', casameta: '2a', stand2024: 48.190, stand2025: 72.753, live: 135.367 },
  { seriennummer: '24454024', logger: 'E1 Ost ELW Heizung', art: 'heizung', wohnung: 'W2', teil: 'Einliegerwohnung', casameta: '2a', stand2024: 1566, stand2025: 2968, live: 3502 },

  // Casameta Nr. 3 — bikosoc W4 (1. OG Ost)
  { seriennummer: '24355984', logger: 'E2 Ost Warmwasser', art: 'warmwasser', wohnung: 'W4', teil: 'Hauptwohnung', casameta: '3', stand2024: 1, stand2025: 194, live: 370 },
  { seriennummer: '02153579', logger: 'E2 Ost Kaltwasser', art: 'kaltwasser', wohnung: 'W4', teil: 'Hauptwohnung', casameta: '3', stand2024: 1.650, stand2025: 15.650, live: 30.445 },
  { seriennummer: '24454029', logger: 'E2 Ost Heizung', art: 'heizung', wohnung: 'W4', teil: 'Hauptwohnung', casameta: '3', stand2024: 2477, stand2025: 8976, live: 10462 },
  { seriennummer: '24355981', logger: 'E2 Ost ELW Warmwasser', art: 'warmwasser', wohnung: 'W4', teil: 'Einliegerwohnung', casameta: '3a', stand2024: 1, stand2025: 32, live: 67 },
  { seriennummer: '02156405', logger: 'E2 Ost ELW Kaltwasser', art: 'kaltwasser', wohnung: 'W4', teil: 'Einliegerwohnung', casameta: '3a', stand2024: 0.730, stand2025: 2.798, live: 7.283 },
  { seriennummer: '24454032', logger: 'E2 Ost ELW Heizung', art: 'heizung', wohnung: 'W4', teil: 'Einliegerwohnung', casameta: '3a', stand2024: 877, stand2025: 1713, live: 1812 },

  // Casameta Nr. 4 — bikosoc W3 (1. OG West)
  { seriennummer: '24355980', logger: 'E2 West Warmwasser', art: 'warmwasser', wohnung: 'W3', teil: 'Hauptwohnung', casameta: '4', stand2024: 644, stand2025: 2479, live: 2676 },
  { seriennummer: '02156442', logger: 'E2 West Kaltwasser', art: 'kaltwasser', wohnung: 'W3', teil: 'Hauptwohnung', casameta: '4', stand2024: 34.780, stand2025: 117.961, live: 131.021 },
  { seriennummer: '24454028', logger: 'E2 West Heizung', art: 'heizung', wohnung: 'W3', teil: 'Hauptwohnung', casameta: '4', stand2024: 2685, stand2025: 5454, live: 6887 },
  { seriennummer: '24454025', logger: 'E2 West ELW Warmwasser', art: 'warmwasser', wohnung: 'W3', teil: 'Einliegerwohnung', casameta: '4a', stand2024: 33, stand2025: 412, live: 480 },
  { seriennummer: '02156414', logger: 'E2 West ELW Kaltwasser', art: 'kaltwasser', wohnung: 'W3', teil: 'Einliegerwohnung', casameta: '4a', stand2024: 2.980, stand2025: 21.189, live: 26.336 },
  { seriennummer: '24454026', logger: 'E2 West ELW Heizung', art: 'heizung', wohnung: 'W3', teil: 'Einliegerwohnung', casameta: '4a', stand2024: 687, stand2025: 1096, live: 1290 },

  // Casameta Nr. 5 — bikosoc W5 (2. OG West)
  { seriennummer: '24355979', logger: 'E3 West Warmwasser', art: 'warmwasser', wohnung: 'W5', teil: 'Hauptwohnung', casameta: '5', stand2024: 570, stand2025: 873, live: 1106 },
  { seriennummer: '02153096', logger: 'E3 West Kaltwasser', art: 'kaltwasser', wohnung: 'W5', teil: 'Hauptwohnung', casameta: '5', stand2024: 75.920, stand2025: 121.073, live: 156.394 },
  {
    seriennummer: '24355986', logger: 'E3 West Heizung', art: 'heizung', wohnung: 'W5', teil: 'Hauptwohnung', casameta: '5',
    stand2024: 4663, stand2025: 8269, live: 9974,
    befund: 'FEHLERCODE: Fehler-Flag 64 (Herstellercode, Bedeutung laut Datenblatt zu klären). '
      + 'Die Werte selbst sind plausibel.',
  },
  { seriennummer: '24355983', logger: 'E3 West ELW Warmwasser', art: 'warmwasser', wohnung: 'W5', teil: 'Einliegerwohnung', casameta: '5a', stand2024: 4, stand2025: 6, live: 16 },
  { seriennummer: '02153185', logger: 'E3 West ELW Kaltwasser', art: 'kaltwasser', wohnung: 'W5', teil: 'Einliegerwohnung', casameta: '5a', stand2024: 1.350, stand2025: 2.108, live: 3.924 },
  {
    seriennummer: '24454033', logger: 'E3 West ELW Heizung', art: 'heizung', wohnung: 'W5', teil: 'Einliegerwohnung', casameta: '5a',
    stand2024: 166, stand2025: 319, live: 384,
    befund: 'FEHLERCODE: Fehler-Flag 16, M-Bus-Status 0x08, Vor- und Rücklauftemperatur −327 °C. '
      + 'Der Temperaturfühler ist defekt oder abgezogen; seitdem zählt das Gerät möglicherweise '
      + 'falsch. Vor der Abrechnung prüfen lassen, andernfalls Schätzung nach § 9a HeizkostenV. '
      + 'Die ausgewiesene Energie ist 2026 trotzdem gestiegen (319 → 384 kWh).',
  },

  // Casameta Nr. 6 — bikosoc W6 (2. OG Ost)
  {
    seriennummer: '24355989', logger: 'E3 Ost Warmwasser', art: 'warmwasser', wohnung: 'W6', teil: 'Hauptwohnung', casameta: '6',
    stand2024: 480, stand2025: 999, live: 1944,
    befund: 'FEHLERCODE: Volumensprung 2026 — das gemessene Volumen springt von 220 m³ '
      + '(31.12.2025) auf 5.883 m³ (12.10.2026), während die Energie nur um 945 kWh steigt. '
      + 'Die Durchflussmessung ist unplausibel (Zirkulation, Einbaulage oder Defekt). '
      + 'Abgerechnet wird die Energie; der Zähler sollte dennoch geprüft werden.',
  },
  { seriennummer: '02153079', logger: 'E3 Ost Kaltwasser', art: 'kaltwasser', wohnung: 'W6', teil: 'Hauptwohnung', casameta: '6', stand2024: 41.400, stand2025: 87.358, live: 151.183 },
  { seriennummer: '24454023', logger: 'E3 Ost Heizung', art: 'heizung', wohnung: 'W6', teil: 'Hauptwohnung', casameta: '6', stand2024: 3319, stand2025: 6990, live: 8006 },
  { seriennummer: '24355985', logger: 'E3 Ost ELW Warmwasser', art: 'warmwasser', wohnung: 'W6', teil: 'Einliegerwohnung', casameta: '6a', stand2024: 12, stand2025: 14, live: 30 },
  { seriennummer: '02156403', logger: 'E3 Ost ELW Kaltwasser', art: 'kaltwasser', wohnung: 'W6', teil: 'Einliegerwohnung', casameta: '6a', stand2024: 2.420, stand2025: 5.290, live: 9.191 },
  { seriennummer: '24454030', logger: 'E3 Ost ELW Heizung', art: 'heizung', wohnung: 'W6', teil: 'Einliegerwohnung', casameta: '6a', stand2024: 493, stand2025: 878, live: 987 },
];

/* Die beiden Liegenschaftszähler. Sie hängen nicht am Logger, sondern werden
   vor Ort abgelesen; in Casameta tragen sie die Nummern 01 und 02. Für sie gibt
   es nur die Stände 01.01.2024 und 31.12.2024 — der Stand zum 31.12.2025 fehlt
   und wird NICHT geschätzt. Hier tragen die Zähler eine sprechende Kennung,
   weil keine Fabriknummer dokumentiert ist. */
const LIEGENSCHAFTSZAEHLER = [
  {
    kennung: 'N24-LS01-GEMEINDEWASSER',
    medium: 'cold_water',
    einheit: 'm3',
    bezeichnung: 'Casameta Liegenschaftszähler „01 Gemeindewasserzähler"',
    beschreibung: 'Abrechnungszähler der Stadtwerke Tuttlingen für den Hausanschluss. '
      + 'Nenner für Wasser und Entwässerung: Was hier durchläuft, ist berechnet; die '
      + 'Differenz zu den Wohnungszählern ist ungemessen und bleibt beim Eigentümer. '
      + 'Nicht am M-Bus-Logger — Ablesung vor Ort oder Wasserrechnung.',
    staende: [
      { tag: '2024-01-01', wert: 58.257 },
      { tag: '2024-12-31', wert: 401.661 },
    ],
  },
  {
    kennung: 'N24-LS02-WMZ-GESAMT',
    medium: 'heat',
    einheit: 'kWh',
    bezeichnung: 'Casameta Liegenschaftszähler „02 Gesamt-WMZ Heizung + Warmwasser"',
    beschreibung: 'Misst Raumwärme UND Warmwasserwärme gemeinsam, deshalb ohne '
      + '`submetering_purpose`. Casameta bildet daraus den Warmwasseranteil („Andere WMZ": '
      + 'Summe der Wohnungs-WMZ Heizung im Verhältnis zum Gesamtzähler). bikosoc rechnet '
      + 'nach § 9 Abs. 1 HeizkostenV aus den Wohnungszählern und braucht ihn dafür nicht; '
      + 'er dient dem Abgleich und zeigt die Verteilverluste. Nicht am M-Bus-Logger.',
    staende: [
      { tag: '2024-01-01', wert: 8786 },
      { tag: '2024-12-31', wert: 27783 },
    ],
  },
];

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt`);
  return treffer[1];
}

const MEDIUM: Record<Art, string> = {
  heizung: 'heat',
  warmwasser: 'heat',
  kaltwasser: 'cold_water',
};
const ZWECK: Record<Art, string | null> = {
  heizung: 'space_heating_heat',
  warmwasser: 'warm_water_heat',
  kaltwasser: null,
};
const EINHEIT: Record<Art, string> = {
  heizung: 'kWh',
  warmwasser: 'kWh',
  kaltwasser: 'm3',
};
const GERAET: Record<Art, string> = {
  heizung: 'Wärmezähler EFE',
  warmwasser: 'Wärmezähler EFE',
  kaltwasser: 'Wasserzähler WZG',
};

/** Die Notiz am Zähler: Zuordnung über alle drei Systeme, dann der Befund. */
function notiz(z: Zaehler): string {
  const kopf = `${z.wohnung} ${z.teil} ${z.art === 'heizung' ? 'Heizung'
    : z.art === 'warmwasser' ? 'Warmwasser' : 'Kaltwasser'}`;
  const teile = [
    `${kopf}. Logger-Bezeichnung „${z.logger}" (Relay WebLog 250 TX8M, M-Bus). `
    + `Casameta-Abschnitt ${z.casameta} (LS-Nr. 0030757-2). Gerät: ${GERAET[z.art]}, `
    + `Seriennummer ${z.seriennummer}.`,
  ];
  if (z.art === 'warmwasser') {
    teile.push('Der Zähler misst die ENERGIE zum Erwärmen in kWh, nicht das Volumen — '
      + 'wie in Casameta 2024. Deshalb als Wärmezähler mit Zweck „warm_water_heat" geführt '
      + '(§ 9 Abs. 1 HeizkostenV, getrennte Messung).');
  }
  if (z.befund) teile.push(z.befund);
  teile.push('Quelle der Stände: Merkblatt Zähler N24 vom 12.10.2026 '
    + '(31.12.2024 aus Casameta, 31.12.2025 Stichtagswert aus dem Zähler, 12.10.2026 Live).');
  return teile.join(' ');
}

async function post(pfad: string, token: string, koerper: unknown, idempotenz?: string) {
  const kopf: Record<string, string> = {
    'content-type': 'application/json',
    'authorization': `Bearer ${token}`,
  };
  if (idempotenz) kopf['Idempotency-Key'] = idempotenz;
  const antwort = await fetch(`${BASIS}${pfad}`, {
    method: 'POST', headers: kopf, body: JSON.stringify(koerper),
  });
  if (!antwort.ok) throw new Error(`POST ${pfad} → ${antwort.status}: ${(await antwort.text()).slice(0, 300)}`);
  return antwort.json();
}

async function main() {
  const anwenden = process.argv.includes('--apply');
  const token = env('CORE_SERVICE_TOKEN');

  const { rows: einheiten } = await dbQuery<any>(
    'SELECT id, code FROM units WHERE property_id = $1', [OBJEKT_ID]);
  const einheitId = new Map(einheiten.map(u => [u.code, u.id]));

  const { rows: bestand } = await dbQuery<any>(
    `SELECT m.id, m.meter_number FROM meters m
       LEFT JOIN units u ON u.id = m.unit_id
      WHERE m.property_id = $1 OR u.property_id = $1`, [OBJEKT_ID]);
  const idVon = new Map<string, number>(bestand.map(m => [m.meter_number, m.id]));

  let neueZaehler = 0;
  let neueStaende = 0;

  // ── 1. Wohnungszähler ─────────────────────────────────────────────────────
  for (const z of WOHNUNGSZAEHLER) {
    const unitId = einheitId.get(z.wohnung);
    if (!unitId) { console.log(`FEHLT: Einheit ${z.wohnung}`); continue; }

    let meterId = idVon.get(z.seriennummer);
    if (!meterId) {
      console.log(`${z.seriennummer}  ${z.wohnung} ${z.teil.padEnd(18)} ${z.art.padEnd(11)} → anlegen`);
      if (anwenden) {
        const erzeugt: any = await post('/api/assets/meters', token, {
          scope_type: 'unit',
          unit_id: unitId,
          medium: MEDIUM[z.art],
          meter_number: z.seriennummer,
          provider: 'Fa. Fiehn Gebäudeautomation (M-Bus-Logger)',
          is_main_meter: false,
          submetering_purpose: ZWECK[z.art],
          notes: notiz(z),
        });
        meterId = erzeugt.id;
        idVon.set(z.seriennummer, erzeugt.id);
        neueZaehler++;
      }
    } else {
      console.log(`${z.seriennummer}  vorhanden (id ${meterId})`);
    }
    if (!meterId) continue;

    neueStaende += await staendeSchreiben(meterId, token, anwenden, z.seriennummer, EINHEIT[z.art], [
      {
        tag: '2024-12-31', wert: z.stand2024, typ: 'annual', quelle: 'manual',
        leser: 'Casameta-Endstand 2024',
        notiz: 'Endstand des Abrechnungsjahres 2024 aus Casameta (LS-Nr. 0030757-2), '
          + 'übernommen am 12.10.2026. Zugleich der Anfangsstand für 2025.',
      },
      {
        tag: '2025-12-31', wert: z.stand2025, typ: 'annual', quelle: 'automatic',
        leser: 'M-Bus-Logger, Stichtagswert',
        notiz: 'Im Zähler gespeicherter Stichtagswert zum 31.12.2025, per M-Bus aus dem '
          + 'Logger Relay WebLog 250 TX8M gelesen am 12.10.2026 um 21:40 Uhr. Keine '
          + 'Ablesung vor Ort nötig. Die Zähleruhren gehen rund eine Stunde hinter der '
          + 'Logger-Uhr; für einen Stichtagswert ist das unerheblich.',
      },
      {
        zeitpunkt: LIVE_ZEITPUNKT, tag: '2026-10-12', wert: z.live, typ: 'interim', quelle: 'automatic',
        leser: 'M-Bus-Logger, Live-Wert',
        notiz: 'Live-Wert desselben Lesevorgangs am 12.10.2026, 21:40 Uhr. Dient als Beleg '
          + 'für den Stichtagswert und der Plausibilität 2026.',
      },
    ]);
  }

  // ── 2. Liegenschaftszähler ────────────────────────────────────────────────
  for (const l of LIEGENSCHAFTSZAEHLER) {
    let meterId = idVon.get(l.kennung);
    if (!meterId) {
      console.log(`${l.kennung} → anlegen`);
      if (anwenden) {
        const erzeugt: any = await post('/api/assets/meters', token, {
          scope_type: 'property',
          property_id: OBJEKT_ID,
          medium: l.medium,
          meter_number: l.kennung,
          is_main_meter: true,
          notes: `${l.bezeichnung}. ${l.beschreibung} `
            + 'STAND 31.12.2025 FEHLT — nicht geschätzt; die Vorprüfung weist ihn als '
            + 'offenen Punkt aus. Quelle der vorhandenen Stände: Casameta, übernommen am '
            + '12.10.2026.',
        });
        meterId = erzeugt.id;
        idVon.set(l.kennung, erzeugt.id);
        neueZaehler++;
      }
    } else {
      console.log(`${l.kennung} vorhanden (id ${meterId})`);
    }
    if (!meterId) continue;

    neueStaende += await staendeSchreiben(meterId, token, anwenden, l.kennung, l.einheit,
      l.staende.map(s => ({
        tag: s.tag, wert: s.wert, typ: 'annual' as const, quelle: 'manual' as const,
        leser: 'Casameta',
        notiz: `Stand ${s.tag} aus Casameta (LS-Nr. 0030757-2), übernommen am 12.10.2026.`,
      })));
  }

  // ── 3. Heizungskonfiguration 2025 ─────────────────────────────────────────
  const { rows: konfig } = await dbQuery<any>(
    'SELECT id FROM property_heating_config WHERE property_id = $1 AND year = $2',
    [OBJEKT_ID, JAHR]);
  if (konfig.length > 0) {
    console.log(`\nHeizungskonfiguration ${JAHR} vorhanden — nicht überschrieben.`);
  } else if (anwenden) {
    const antwort = await fetch(`${BASIS}/api/assets/properties/${OBJEKT_CODE}/heating-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
      body: JSON.stringify({
        year: JAHR,
        heating_system: 'heat_pump',
        hot_water_via_heating: true,
        base_share_percent: 0,
        consumption_share_percent: 100,
        notes: 'Wärmepumpe, Strom über den Hausanschluss (kWh). Heizung und Warmwasser zu '
          + '100 % nach Verbrauch (0/100) — wie in der Casameta-Abrechnung 2024 für dieselbe '
          + 'Liegenschaft. Warmwassertemperatur 54 °C. Raumwärme und Warmwasserwärme werden '
          + 'je Wohnung getrennt gemessen, deshalb Methode nach § 9 Abs. 1 HeizkostenV und '
          + 'nicht die Schätzformel nach § 9 Abs. 2. HINWEIS: 0/100 liegt außerhalb der '
          + 'Spanne von § 7 Abs. 1 HeizkostenV (50 bis 70 % Verbrauchsanteil); die '
          + 'Abrechnungsansicht weist das aus. Owner-Entscheidung, übernommen aus dem '
          + 'Bestandsverfahren in Casameta. Kaltwasser läuft über die Nebenkosten, nicht '
          + 'über die Heizkosten. Angelegt am 12.10.2026.',
      }),
    });
    if (!antwort.ok) throw new Error(`heating-config → ${antwort.status}: ${await antwort.text()}`);
    console.log(`\nHeizungskonfiguration ${JAHR} angelegt: 0/100, Wärmepumpe.`);
  }

  console.log(anwenden
    ? `\n${neueZaehler} Zähler und ${neueStaende} Stände angelegt.`
    : '\nProbelauf — nichts geschrieben.');
  process.exit(0);
}

interface StandEingabe {
  tag: string;
  zeitpunkt?: string;
  wert: number;
  typ: 'annual' | 'interim';
  quelle: 'manual' | 'automatic';
  leser: string;
  notiz: string;
}

/**
 * Schreibt Stände über die Bulk-Route. Ein Stand, der zu diesem Tag schon
 * erfasst ist, wird übersprungen — damit bleibt der Lauf wiederholbar, ohne
 * zwei Stände zum selben Tag zu erzeugen.
 */
async function staendeSchreiben(
  meterId: number, token: string, anwenden: boolean,
  kennung: string, einheit: string, staende: StandEingabe[],
): Promise<number> {
  const { rows: vorhanden } = await dbQuery<any>(
    'SELECT read_at::date AS tag FROM meter_readings WHERE meter_id = $1', [meterId]);
  const schonDa = new Set(vorhanden.map(v => String(v.tag).slice(0, 10)));

  const offen = staende.filter(s => !schonDa.has(s.tag));
  if (offen.length === 0) return 0;
  if (!anwenden) {
    console.log(`   ${offen.length} Stände offen: ${offen.map(s => `${s.tag}=${s.wert}`).join(', ')}`);
    return 0;
  }

  await post(`/api/assets/meters/${meterId}/readings/bulk`, token, {
    readings: offen.map(s => ({
      value: s.wert,
      unit: einheit,
      reading_type: s.typ,
      /* UTC-Mitternacht für Stichtage: `2025-12-31T00:00:00+01:00` ist in UTC
         der 30.12. und stünde dann mit falschem Datum in der Ansicht. */
      read_at: s.zeitpunkt ?? `${s.tag}T00:00:00Z`,
      source: s.quelle,
      reader_name: s.leser,
      is_estimated: false,
      notes: s.notiz,
    })),
  }, `n24-zaehler-${kennung}-${offen.map(s => s.tag).join('-')}`);
  console.log(`   ${offen.length} Stände erfasst: ${offen.map(s => `${s.tag}=${s.wert}`).join(', ')}`);
  return offen.length;
}

main().catch((e) => { console.error(e); process.exit(1); });
