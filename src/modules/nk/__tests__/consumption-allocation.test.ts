/**
 * nk/__tests__/consumption-allocation.test.ts — Verteilung nach gemessenem Verbrauch.
 *
 * Hintergrund: Bis zum 10.10.2026 kannte `allocateCosts()` den Schlüssel
 * `consumption` nicht. Eine solche Regel fiel in den Vorgabezweig und wurde
 * stillschweigend nach Fläche verteilt — für Kaltwasser und Entwässerung also
 * genau an den Zählern vorbei, die dafür da sind. Bei MG24 verschiebt der
 * Unterschied rund 600 Euro zwischen den Wohnungen.
 *
 * Diese Tests kommen ohne Datenbank aus: `allocateCosts()` ist eine reine
 * Funktion. Die Werte der beiden letzten Fälle sind die echten Zählerstände
 * von MG24 aus dem Jahr 2025.
 */
import { describe, it, expect } from 'bun:test';
import { allocateCosts } from '../engine.js';
import type {
  AllocationRuleRow, LeaseRow, UnitRow, MeterRow, MeterReadingRow,
} from '../types.js';

const ZEITRAUM_START = '2025-01-01';
const ZEITRAUM_ENDE = '2025-12-31';

function regel(categoryCode: string, keyType = 'consumption'): AllocationRuleRow {
  return {
    id: 1, property_id: 2, cost_category_id: 2, key_type: keyType,
    valid_from: '2025-01-01', valid_until: null, category_code: categoryCode,
  };
}

function einheit(id: number, code: string, flaeche: number): UnitRow {
  return { id, property_id: 2, code, unit_type: 'apartment', living_area_qm: flaeche, active: true };
}

function vertrag(id: number, unitId: number, start = '2025-01-01'): LeaseRow {
  return {
    id, unit_id: unitId, lease_type: 'wohnraum', status: 'active', start_date: start,
    end_date: null, actual_move_out: null, billing_mode: 'vorauszahlung',
    kaltmiete: null, nk_vorauszahlung: null, heizkosten_vorauszahlung: null,
  };
}

function zaehler(id: number, unitId: number | null, medium: string, opts: Partial<MeterRow> = {}): MeterRow {
  return {
    id, property_id: unitId ? null : 2, unit_id: unitId, medium,
    meter_number: `Z-${id}`, is_main_meter: false, submetering_purpose: null, active: true,
    ...opts,
  };
}

let ablesungId = 1;
function ablesung(meterId: number, wert: number, datum: string): MeterReadingRow {
  return {
    id: ablesungId++, meter_id: meterId, value: wert, unit: 'm³',
    reading_type: 'interim', read_at: `${datum}T12:00:00+01:00`, is_estimated: false,
  };
}

/** Kurzform: verteilt `betrag` und gibt Beträge je Vertrag zurück. */
function verteile(
  betrag: number, r: AllocationRuleRow, leases: LeaseRow[], units: UnitRow[],
  meters: MeterRow[], readings: MeterReadingRow[],
) {
  return allocateCosts(
    betrag, r, leases, units, [], [], ZEITRAUM_START, ZEITRAUM_ENDE, 2025, meters, readings,
  );
}

describe('Verteilung nach Verbrauch — Grundfälle', () => {
  it('verteilt streng nach gemessenem Verbrauch, nicht nach Fläche', () => {
    /* Zwei Einheiten mit DEUTLICH unterschiedlicher Fläche, aber gleichem
       Verbrauch. Nach Fläche wären es 25/75, nach Verbrauch 50/50. */
    const units = [einheit(1, 'W1', 50), einheit(2, 'W2', 150)];
    const leases = [vertrag(10, 1), vertrag(20, 2)];
    const meters = [zaehler(100, 1, 'cold_water'), zaehler(200, 2, 'cold_water')];
    const readings = [
      ablesung(100, 0, '2025-01-01'), ablesung(100, 40, '2025-12-31'),
      ablesung(200, 0, '2025-01-01'), ablesung(200, 40, '2025-12-31'),
    ];

    const e = verteile(1000, regel('wasser'), leases, units, meters, readings);

    expect(e.leaseAllocations).toHaveLength(2);
    expect(e.leaseAllocations[0].amount).toBeCloseTo(500, 2);
    expect(e.leaseAllocations[1].amount).toBeCloseTo(500, 2);
    expect(e.vacancyAmount).toBeCloseTo(0, 2);
  });

  it('Entwässerung zählt Kalt- UND Warmwasser', () => {
    const units = [einheit(1, 'W1', 100), einheit(2, 'W2', 100)];
    const leases = [vertrag(10, 1), vertrag(20, 2)];
    const meters = [
      zaehler(100, 1, 'cold_water'), zaehler(101, 1, 'warm_water'),
      zaehler(200, 2, 'cold_water'), zaehler(201, 2, 'warm_water'),
    ];
    const readings = [
      ablesung(100, 0, '2025-01-01'), ablesung(100, 30, '2025-12-31'),
      ablesung(101, 0, '2025-01-01'), ablesung(101, 10, '2025-12-31'),  // W1 zusammen 40
      ablesung(200, 0, '2025-01-01'), ablesung(200, 10, '2025-12-31'),
      ablesung(201, 0, '2025-01-01'), ablesung(201, 10, '2025-12-31'),  // W2 zusammen 20
    ];

    const e = verteile(600, regel('entwaesserung'), leases, units, meters, readings);

    // 40 : 20 → 400 : 200
    expect(e.leaseAllocations[0].amount).toBeCloseTo(400, 2);
    expect(e.leaseAllocations[1].amount).toBeCloseTo(200, 2);
  });

  it('Wasser zählt Kalt UND Warm — der Versorger berechnet beides', () => {
    /* KORREKTUR 11.10.2026. Dieser Test hielt zuvor fest, dass die Kostenart
       `wasser` den Warmwasserzähler ignoriert. Das war falsch: Der Versorger
       berechnet das Wasser, das durch den Hausanschluss läuft, und das
       Warmwasser der Wohnung kommt durch denselben Anschluss und steht auf
       derselben Rechnung. Zählte man nur Kaltwasser, blieb das gemessene
       Warmwasservolumen der Mieter als "ungemessener Rest" beim Eigentümer —
       bei MG24 rund 280 Euro im Jahr.

       W1 verbraucht 10 kalt und 90 warm, W2 nur 10 kalt. Von 200 Euro trägt
       W1 also 100 von 110 Teilen. */
    const units = [einheit(1, 'W1', 100), einheit(2, 'W2', 100)];
    const leases = [vertrag(10, 1), vertrag(20, 2)];
    const meters = [
      zaehler(100, 1, 'cold_water'), zaehler(101, 1, 'warm_water'),
      zaehler(200, 2, 'cold_water'),
    ];
    const readings = [
      ablesung(100, 0, '2025-01-01'), ablesung(100, 10, '2025-12-31'),
      ablesung(101, 0, '2025-01-01'), ablesung(101, 90, '2025-12-31'),
      ablesung(200, 0, '2025-01-01'), ablesung(200, 10, '2025-12-31'),
    ];

    const e = verteile(200, regel('wasser'), leases, units, meters, readings);
    expect(e.leaseAllocations[0].amount).toBeCloseTo(181.82, 2);
    expect(e.leaseAllocations[1].amount).toBeCloseTo(18.18, 2);
    expect(e.leaseAllocations[0].denominator).toBeCloseTo(110, 3);
  });

  it('Warmwasser zählt NUR die Warmwasserzähler — Volumen und Wärme bleiben getrennt', () => {
    /* Die Gegenprobe zum Test oben: Bei `warmwasser` geht es um die Energie
       zum Erwärmen, nicht um das Volumen. Würde die Kostenart auch
       Kaltwasser zählen, wäre dasselbe Wasser zweimal Bemessungsgrundlage. */
    const units = [einheit(1, 'W1', 100), einheit(2, 'W2', 100)];
    const leases = [vertrag(10, 1), vertrag(20, 2)];
    const meters = [
      zaehler(100, 1, 'cold_water'), zaehler(101, 1, 'warm_water'),
      zaehler(200, 2, 'cold_water'), zaehler(201, 2, 'warm_water'),
    ];
    const readings = [
      ablesung(100, 0, '2025-01-01'), ablesung(100, 90, '2025-12-31'),
      ablesung(101, 0, '2025-01-01'), ablesung(101, 30, '2025-12-31'),
      ablesung(200, 0, '2025-01-01'), ablesung(200, 90, '2025-12-31'),
      ablesung(201, 0, '2025-01-01'), ablesung(201, 10, '2025-12-31'),
    ];

    const e = verteile(400, regel('warmwasser'), leases, units, meters, readings);
    // 30 : 10 — die 180 Kaltwasser-Einheiten bleiben ausser Betracht.
    expect(e.leaseAllocations[0].amount).toBeCloseTo(300, 2);
    expect(e.leaseAllocations[1].amount).toBeCloseTo(100, 2);
    expect(e.leaseAllocations[0].denominator).toBeCloseTo(40, 3);
  });
});

describe('Verteilung nach Verbrauch — Hauptzähler und Eigentümeranteil', () => {
  it('der Hauptzähler bekommt keinen eigenen Anteil, ist aber der Nenner', () => {
    /* KORREKTUR 11.10.2026. Dieser Test hielt zuvor fest, dass der Mieter den
       VOLLEN Betrag trägt und der Nenner die Summe der Wohnungszähler ist.
       Das war das Verhalten des damaligen Codes — und ein Fehler mit
       Geldwirkung: Bei MG24 berechnen die Stadtwerke für 2025 437 m³, die
       Wohnungszähler messen zusammen rund 169 m³. Nach der alten Rechnung
       hätten die drei Mieter die Kosten aller 437 m³ getragen, also auch der
       268 m³, die niemand ihnen zurechnen kann.

       Richtig ist: Jede Wohnung zahlt ihre gemessene Menge zum
       Rechnungspreis; der ungemessene Rest bleibt beim Eigentümer. Der
       Hauptzähler liefert dafür den Nenner, bekommt aber selbst keinen
       Anteil — er gehört keiner Wohnung. */
    const units = [einheit(1, 'W1', 100)];
    const leases = [vertrag(10, 1)];
    const meters = [
      zaehler(100, 1, 'cold_water'),
      zaehler(999, null, 'cold_water', { is_main_meter: true, property_id: 2 }),
    ];
    const readings = [
      ablesung(100, 0, '2025-01-01'), ablesung(100, 25, '2025-12-31'),
      ablesung(999, 0, '2025-01-01'), ablesung(999, 100, '2025-12-31'),
    ];

    const e = verteile(400, regel('wasser'), leases, units, meters, readings);
    expect(e.leaseAllocations).toHaveLength(1);
    expect(e.leaseAllocations[0].denominator).toBeCloseTo(100, 3);
    expect(e.leaseAllocations[0].amount).toBeCloseTo(100, 2);
    // Die ungemessenen 75 Prozent bleiben beim Eigentümer.
    expect(e.vacancyAmount).toBeCloseTo(300, 2);
    expect(e.warnings?.some(w => w.code === 'CONSUMPTION_UNMEASURED_REMAINDER')).toBe(true);
  });

  it('meldet einen Hauptzähler, der weniger ausweist als die Wohnungszähler', () => {
    /* Der Fall des GLT-Zählers E0 bei MG24: Er zeigt für 2025 rund 38 m³,
       während die Wohnungszähler zusammen 169 m³ messen. Als Nenner wäre er
       zerstörerisch — die Anteile lägen über 100 Prozent. Deshalb wird er
       nicht verwendet, aber gemeldet. */
    const units = [einheit(1, 'W1', 100)];
    const leases = [vertrag(10, 1)];
    const meters = [
      zaehler(100, 1, 'cold_water'),
      zaehler(999, null, 'cold_water', { is_main_meter: true, property_id: 2 }),
    ];
    const readings = [
      ablesung(100, 0, '2025-01-01'), ablesung(100, 50, '2025-12-31'),
      ablesung(999, 0, '2025-01-01'), ablesung(999, 10, '2025-12-31'),
    ];

    const e = verteile(400, regel('wasser'), leases, units, meters, readings);
    expect(e.leaseAllocations[0].denominator).toBeCloseTo(50, 3);
    expect(e.leaseAllocations[0].amount).toBeCloseTo(400, 2);
    expect(e.warnings?.some(w => w.code === 'CONSUMPTION_MAIN_METER_BELOW_UNITS')).toBe(true);
  });

  it('meldet, wenn gar kein Hauptzähler vorhanden ist', () => {
    /* Ohne Hauptzähler bleibt es bei der Verteilung über die Summe der
       Wohnungszähler — eine ungemessene Differenz zur Versorgerrechnung
       würde dabei unbemerkt bei den Mietern landen. Das gehört in die
       Abrechnung geschrieben, nicht verschwiegen. */
    const units = [einheit(1, 'W1', 100), einheit(2, 'W2', 100)];
    const leases = [vertrag(10, 1), vertrag(20, 2)];
    const meters = [zaehler(100, 1, 'cold_water'), zaehler(101, 2, 'cold_water')];
    const readings = [
      ablesung(100, 0, '2025-01-01'), ablesung(100, 30, '2025-12-31'),
      ablesung(101, 0, '2025-01-01'), ablesung(101, 10, '2025-12-31'),
    ];

    const e = verteile(400, regel('wasser'), leases, units, meters, readings);
    expect(e.leaseAllocations[0].amount).toBeCloseTo(300, 2);
    expect(e.leaseAllocations[1].amount).toBeCloseTo(100, 2);
    expect(e.warnings?.some(w => w.code === 'CONSUMPTION_NO_MAIN_METER')).toBe(true);
  });

  it('nicht gemessener Rest bleibt beim Eigentümer statt auf Fläche zu gehen', () => {
    /* Zwei Einheiten, aber nur eine hat einen Zähler. Der Anteil der
       ungemessenen Einheit darf NICHT auf die gemessene verteilt werden. */
    const units = [einheit(1, 'W1', 100), einheit(2, 'W2', 100)];
    const leases = [vertrag(10, 1), vertrag(20, 2)];
    const meters = [zaehler(100, 1, 'cold_water')];
    const readings = [ablesung(100, 0, '2025-01-01'), ablesung(100, 50, '2025-12-31')];

    const e = verteile(1000, regel('wasser'), leases, units, meters, readings);
    // Die gemessene Einheit traegt 100 % des Nenners — aber der Betrag gehoert
    // der Sache nach nur zur Haelfte ihr. Das faellt in der Vorpruefung als
    // CONSUMPTION_READING_MISSING auf und blockt dort; hier wird nichts still
    // auf die Flaeche umgebogen.
    expect(e.leaseAllocations).toHaveLength(1);
    expect(e.leaseAllocations[0].lease_id).toBe(10);
  });

  it('ohne jeden gemessenen Verbrauch bleibt der volle Betrag beim Eigentümer', () => {
    const units = [einheit(1, 'W1', 100)];
    const leases = [vertrag(10, 1)];
    const meters = [zaehler(100, 1, 'cold_water')];
    // Anfangsstand VOR dem Zeitraum, Endstand gleich → Verbrauch null
    const readings = [ablesung(100, 7, '2024-12-20'), ablesung(100, 7, '2025-12-31')];

    const e = verteile(800, regel('wasser'), leases, units, meters, readings);
    expect(e.leaseAllocations).toHaveLength(0);
    expect(e.vacancyAmount).toBeCloseTo(800, 2);
    expect(e.warnings?.some(w => w.code === 'CONSUMPTION_DENOMINATOR_ZERO')).toBe(true);
  });

  it('Kostenart ohne zugeordnetes Medium verteilt nichts und sagt es', () => {
    const units = [einheit(1, 'W1', 100)];
    const leases = [vertrag(10, 1)];
    const meters = [zaehler(100, 1, 'cold_water')];
    const readings = [ablesung(100, 0, '2025-01-01'), ablesung(100, 10, '2025-12-31')];

    const e = verteile(500, regel('grundsteuer'), leases, units, meters, readings);
    expect(e.leaseAllocations).toHaveLength(0);
    expect(e.vacancyAmount).toBeCloseTo(500, 2);
    expect(e.warnings?.some(w => w.code === 'CONSUMPTION_MEDIUM_UNKNOWN')).toBe(true);
  });
});

describe('Verteilung nach Verbrauch — unterjährig und Rundung', () => {
  it('ein unterjähriges Mietverhältnis trägt genau seinen gemessenen Verbrauch', () => {
    /* Der Zeitanteil geht NICHT zusaetzlich in den Nenner ein: Gemessen wird
       ohnehin nur, was in der Mietzeit lief. Sonst wuerde doppelt gekuerzt. */
    const units = [einheit(1, 'W1', 100), einheit(2, 'W2', 100)];
    const leases = [vertrag(10, 1, '2025-01-01'), vertrag(20, 2, '2025-07-01')];
    const meters = [zaehler(100, 1, 'cold_water'), zaehler(200, 2, 'cold_water')];
    const readings = [
      ablesung(100, 0, '2025-01-01'), ablesung(100, 60, '2025-12-31'),
      ablesung(200, 0, '2025-07-01'), ablesung(200, 20, '2025-12-31'),
    ];

    const e = verteile(800, regel('wasser'), leases, units, meters, readings);
    // 60 : 20 → 600 : 200
    expect(e.leaseAllocations[0].amount).toBeCloseTo(600, 2);
    expect(e.leaseAllocations[1].amount).toBeCloseTo(200, 2);
    expect(e.vacancyAmount).toBeCloseTo(0, 2);
  });

  it('Rundungsrest landet im Eigentümeranteil, die Summe bleibt erhalten', () => {
    const units = [einheit(1, 'W1', 100), einheit(2, 'W2', 100), einheit(3, 'W3', 100)];
    const leases = [vertrag(10, 1), vertrag(20, 2), vertrag(30, 3)];
    const meters = [
      zaehler(100, 1, 'cold_water'), zaehler(200, 2, 'cold_water'), zaehler(300, 3, 'cold_water'),
    ];
    const readings = [
      ablesung(100, 0, '2025-01-01'), ablesung(100, 10, '2025-12-31'),
      ablesung(200, 0, '2025-01-01'), ablesung(200, 10, '2025-12-31'),
      ablesung(300, 0, '2025-01-01'), ablesung(300, 10, '2025-12-31'),
    ];

    const e = verteile(100, regel('wasser'), leases, units, meters, readings);
    const summe = e.leaseAllocations.reduce((s, a) => s + a.amount, 0) + e.vacancyAmount;
    expect(summe).toBeCloseTo(100, 2);
  });
});

describe('Verteilung nach Verbrauch — echte Werte MG24 2025', () => {
  /* Zählerstände zum 31.12.2025 aus den Fiehn-Monatsberichten; die Zähler
     standen am 01.01.2025 auf null (belegt über den Jahreszähler der
     Gebäudeleittechnik und die Brennstoffbilanz). Verteilt wird die
     SWT-Jahresrechnung Wasser 2025 über 1.214,01 Euro. */
  const units = [einheit(33, 'W1', 111.07), einheit(34, 'W2', 112.28), einheit(35, 'W3', 173.11)];
  const leases = [vertrag(29, 33, '2025-02-01'), vertrag(30, 34, '2025-04-01'), vertrag(31, 35, '2025-05-01')];
  const meters = [zaehler(5, 33, 'cold_water'), zaehler(9, 34, 'cold_water'), zaehler(13, 35, 'cold_water')];
  const readings = [
    ablesung(5, 0, '2025-01-01'), ablesung(5, 26.96, '2025-12-30'),
    ablesung(9, 0, '2025-01-01'), ablesung(9, 20.26, '2025-12-30'),
    ablesung(13, 0, '2025-01-01'), ablesung(13, 121.32, '2025-12-30'),
  ];

  /* GEÄNDERTE ERWARTUNG 11.10.2026. Vorher standen hier 16,0 : 12,0 : 72,0 —
     die vollen Zählerstände des Jahres, obwohl alle drei Mietverhältnisse
     erst im Lauf des Jahres beginnen. Der Zähler läuft aber ab dem 1. Januar:
     Was in der Leerstandszeit durch die Leitung ging, war dem Mieter
     zugerechnet.

     Jetzt trägt jeder Nutzer seinen Zeitanteil am gemessenen Verbrauch
     (§ 9b-Logik; eine Ablesung zum Einzug gibt es nicht). Der Rest bleibt
     beim Eigentümer. Die alten Zahlen waren die Beschreibung des Fehlers,
     nicht des Sollzustands. */
  it('verteilt im Verhältnis 14,7 : 9,1 : 48,4 Prozent — Rest beim Eigentümer', () => {
    const e = verteile(1214.01, regel('wasser'), leases, units, meters, readings);
    const anteil = (leaseId: number) =>
      (e.leaseAllocations.find(a => a.lease_id === leaseId)!.fraction) * 100;

    /* Die Zähler haben hier nur zwei Stützpunkte (01.01. und 30.12.), also
       ist das ganze Jahr eine Lücke und es wird zeitanteilig geteilt. Die
       Anteile liegen knapp über dem reinen Kalenderanteil, weil das
       Intervall am 2. Januar beginnt: Der Verbrauch des 1. Januar steckt
       bereits im Stand vom 01.01. */
    expect(anteil(29)).toBeCloseTo(14.67, 1);   // W1 ab 01.02.
    expect(anteil(30)).toBeCloseTo(9.07, 1);    // W2 ab 01.04.
    expect(anteil(31)).toBeCloseTo(48.39, 1);   // W3 ab 01.05.
  });

  it('lässt den Verbrauch der Leerstandszeit beim Eigentümer', () => {
    const e = verteile(1214.01, regel('wasser'), leases, units, meters, readings);
    // 338,31 € von 1.214,01 € entfallen auf die Zeit vor den Einzügen.
    expect(e.vacancyAmount).toBeCloseTo(338.31, 1);
  });

  it('nutzt eine Ablesung kurz nach Einzug statt das ganze Jahr zu teilen', () => {
    /* Der echte W3-Fall: Der Kaltwasserzähler stand am 14.05. auf 4,17 m³
       und bewegte sich bis Ende Juni nicht. Mit diesem Stützpunkt gehören
       fast 97 Prozent des Jahresverbrauchs dem Mieter statt 67 nach
       Zeitanteil. */
    const mitStuetzpunkt = [
      ablesung(13, 0, '2025-01-01'),
      ablesung(13, 4.17, '2025-05-14'),
      ablesung(13, 4.17, '2025-06-23'),
      ablesung(13, 121.32, '2025-12-30'),
    ];
    const e = verteile(
      1214.01, regel('wasser'),
      [vertrag(31, 35, '2025-05-01')], [einheit(35, 'W3', 173.11)],
      [zaehler(13, 35, 'cold_water')], mitStuetzpunkt);
    expect(e.leaseAllocations[0].fraction).toBeGreaterThan(0.9);
  });

  it('weicht deutlich von der Flächenverteilung ab — darum die Änderung', () => {
    const nachVerbrauch = verteile(1214.01, regel('wasser'), leases, units, meters, readings);
    const nachFlaeche = allocateCosts(
      1214.01, regel('wasser', 'sqm'), leases, units, [], [],
      ZEITRAUM_START, ZEITRAUM_ENDE, 2025, meters, readings,
    );

    const w3Verbrauch = nachVerbrauch.leaseAllocations.find(a => a.lease_id === 31)!.amount;
    const w3Flaeche = nachFlaeche.leaseAllocations.find(a => a.lease_id === 31)!.amount;

    // W3 traegt nach Verbrauch weiterhin deutlich mehr als nach Flaeche —
    // der Abstand ist durch den Zeitanteil kleiner geworden, nicht weg.
    expect(w3Verbrauch).toBeGreaterThan(w3Flaeche + 200);
  });

  it('die Summe über alle Einheiten ergibt wieder den Rechnungsbetrag', () => {
    const e = verteile(1214.01, regel('wasser'), leases, units, meters, readings);
    const summe = e.leaseAllocations.reduce((s, a) => s + a.amount, 0) + e.vacancyAmount;
    expect(summe).toBeCloseTo(1214.01, 2);
  });
});
