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

  it('Kaltwasser ignoriert den Warmwasserzähler', () => {
    const units = [einheit(1, 'W1', 100), einheit(2, 'W2', 100)];
    const leases = [vertrag(10, 1), vertrag(20, 2)];
    const meters = [
      zaehler(100, 1, 'cold_water'), zaehler(101, 1, 'warm_water'),
      zaehler(200, 2, 'cold_water'),
    ];
    const readings = [
      ablesung(100, 0, '2025-01-01'), ablesung(100, 10, '2025-12-31'),
      ablesung(101, 0, '2025-01-01'), ablesung(101, 90, '2025-12-31'),  // darf nicht zählen
      ablesung(200, 0, '2025-01-01'), ablesung(200, 10, '2025-12-31'),
    ];

    const e = verteile(200, regel('wasser'), leases, units, meters, readings);
    expect(e.leaseAllocations[0].amount).toBeCloseTo(100, 2);
    expect(e.leaseAllocations[1].amount).toBeCloseTo(100, 2);
  });
});

describe('Verteilung nach Verbrauch — Hauptzähler und Eigentümeranteil', () => {
  it('der Hauptzähler am Hausanschluss verteilt nicht mit', () => {
    /* Bei MG24 berechnen die Stadtwerke weit mehr, als die Wohnungszähler
       zusammen messen. Der Hauptzähler dient dem Abgleich, nicht der
       Verteilung — sonst bekäme er einen Anteil und niemanden, dem er
       zuzurechnen wäre. */
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
    expect(e.leaseAllocations[0].amount).toBeCloseTo(400, 2);
    expect(e.leaseAllocations[0].denominator).toBeCloseTo(25, 3);
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

  it('verteilt im Verhältnis 16,0 : 12,0 : 72,0 Prozent', () => {
    const e = verteile(1214.01, regel('wasser'), leases, units, meters, readings);
    const anteil = (leaseId: number) =>
      (e.leaseAllocations.find(a => a.lease_id === leaseId)!.fraction) * 100;

    expect(anteil(29)).toBeCloseTo(16.0, 1);
    expect(anteil(30)).toBeCloseTo(12.0, 1);
    expect(anteil(31)).toBeCloseTo(72.0, 1);
  });

  it('weicht deutlich von der Flächenverteilung ab — darum die Änderung', () => {
    const nachVerbrauch = verteile(1214.01, regel('wasser'), leases, units, meters, readings);
    const nachFlaeche = allocateCosts(
      1214.01, regel('wasser', 'sqm'), leases, units, [], [],
      ZEITRAUM_START, ZEITRAUM_ENDE, 2025, meters, readings,
    );

    const w3Verbrauch = nachVerbrauch.leaseAllocations.find(a => a.lease_id === 31)!.amount;
    const w3Flaeche = nachFlaeche.leaseAllocations.find(a => a.lease_id === 31)!.amount;

    // W3 traegt nach Verbrauch deutlich mehr als nach Flaeche
    expect(w3Verbrauch).toBeGreaterThan(w3Flaeche + 300);
  });

  it('die Summe über alle Einheiten ergibt wieder den Rechnungsbetrag', () => {
    const e = verteile(1214.01, regel('wasser'), leases, units, meters, readings);
    const summe = e.leaseAllocations.reduce((s, a) => s + a.amount, 0) + e.vacancyAmount;
    expect(summe).toBeCloseTo(1214.01, 2);
  });
});
