/**
 * nk/__tests__/heizkosten-split.test.ts — Grund- und Verbrauchsanteil bei der
 * Heizkostenverteilung.
 *
 * Hintergrund: § 7 Abs. 1 HeizkostenV sieht 50 bis 70 Prozent Verbrauchsanteil
 * vor; der Rest geht nach Fläche. Bis zum 11.10.2026 erzwang die Datenbank
 * diesen Rahmen über einen CHECK auf `allocation_rules`. Der Owner hat sich für
 * MG24 bewusst dagegen entschieden — 0 Prozent Grundkosten, 100 Prozent
 * Verbrauch, wie bei N24 für 2024 praktiziert — und trägt das Kürzungsrisiko
 * aus § 12 HeizkostenV selbst.
 *
 * Die Sperre ist deshalb aus der Datenbank verschwunden. An ihre Stelle tritt
 * ein Befund in jeder Abrechnung. Diese Tests sichern beides ab: dass die
 * Engine 0/100, 30/70 und 50/50 richtig rechnet, und dass die Abweichung vom
 * Verordnungsrahmen gemeldet wird.
 *
 * Zweites Thema: Die Warmwasserwärme. § 9 Abs. 2 HeizkostenV lässt die
 * Schätzformel Q = 2,5 · V · (tw − 10) nur zu, wenn die Wärmemenge NICHT
 * gemessen wird. MG24 hat einen Zähler dafür; die Engine hat ihn bis zum
 * 11.10.2026 ignoriert und über die Formel geschätzt — mit mehr als dem
 * Doppelten des Messwerts.
 *
 * Ohne Datenbank: `heatingAllocation()` ist eine reine Funktion.
 */
import { describe, it, expect } from 'bun:test';
import { heatingAllocation } from '../heating.js';
import type {
  AllocationRuleRow, ExpenseBookingRow, HeatingConfigRow, LeaseRow,
  MeterReadingRow, MeterRow, UnitRow,
} from '../types.js';

const VON = '2025-01-01';
const BIS = '2025-12-31';

function konfig(base: number, consumption: number): HeatingConfigRow {
  return {
    id: 1, property_id: 2, year: 2025, heating_system: 'central_pellets',
    hot_water_via_heating: true,
    base_share_percent: base, consumption_share_percent: consumption,
    co2_emissions_kg: null, co2_cost_total: null, co2_tenant_share_percent: null,
  } as HeatingConfigRow;
}

function buchung(betrag: number): ExpenseBookingRow {
  return {
    id: 1, property_id: 2, unit_id: null, cost_category_id: 4, amount_gross: betrag,
    umlagefaehig: true, service_period_start: VON, service_period_end: BIS,
    category_code: 'heizung',
  } as ExpenseBookingRow;
}

function einheit(id: number, code: string, flaeche: number): UnitRow {
  return { id, property_id: 2, code, unit_type: 'apartment', living_area_qm: flaeche, active: true } as UnitRow;
}

function vertrag(id: number, unitId: number): LeaseRow {
  return {
    id, unit_id: unitId, lease_type: 'wohnraum', status: 'active', start_date: VON,
    end_date: null, actual_move_out: null, billing_mode: 'vorauszahlung',
    kaltmiete: null, nk_vorauszahlung: null, heizkosten_vorauszahlung: null,
  } as LeaseRow;
}

function zaehler(id: number, unitId: number | null, medium: string, opts: Partial<MeterRow> = {}): MeterRow {
  return {
    id, property_id: unitId ? null : 2, unit_id: unitId, medium,
    meter_number: `Z-${id}`, is_main_meter: false, submetering_purpose: null, active: true,
    ...opts,
  } as MeterRow;
}

let ablesungId = 1;
function ablesung(meterId: number, wert: number, datum: string): MeterReadingRow {
  return {
    id: ablesungId++, meter_id: meterId, value: wert, unit: 'kWh',
    reading_type: 'interim', read_at: `${datum}T12:00:00+01:00`, is_estimated: false,
  } as MeterReadingRow;
}

const REGEL: AllocationRuleRow = {
  id: 1, property_id: 2, cost_category_id: 4, key_type: 'heating_split',
  valid_from: VON, valid_until: null, category_code: 'heizung',
} as AllocationRuleRow;

/**
 * Zwei Wohnungen gleicher Fläche, aber mit 3:1 unterschiedlichem Verbrauch —
 * so wird sofort sichtbar, wie viel über Fläche und wie viel über Zähler geht.
 * Kein Warmwasser im Spiel: `hot_water_via_heating` ist hier aus.
 */
function nurHeizung(base: number, consumption: number, betrag = 1000) {
  const k = { ...konfig(base, consumption), hot_water_via_heating: false };
  const units = [einheit(1, 'W1', 100), einheit(2, 'W2', 100)];
  const leases = [vertrag(10, 1), vertrag(20, 2)];
  const meters = [
    zaehler(100, 1, 'heat'), zaehler(200, 2, 'heat'),
    zaehler(999, null, 'heat', { is_main_meter: true }),
  ];
  const readings = [
    ablesung(100, 0, '2024-12-31'), ablesung(100, 1500, BIS),
    ablesung(200, 0, '2024-12-31'), ablesung(200, 500, BIS),
    ablesung(999, 0, '2024-12-31'), ablesung(999, 2000, BIS),
  ];
  return heatingAllocation(k, [buchung(betrag)], meters, readings, units, leases, VON, BIS, [], REGEL);
}

function betragJeVertrag(e: ReturnType<typeof heatingAllocation>) {
  const out = new Map<number, number>();
  for (const i of e.items) {
    const lease = (i.metadata_jsonb as any)?.lease_id;
    if (lease) out.set(lease, (out.get(lease) || 0) + i.amount);
  }
  return out;
}

describe('Leerstandsanteil der Heizkosten', () => {
  /* Bis zum 11.10.2026 verschwand der Teil der Heizkosten, der auf keinen
     Mietzeitraum entfällt, ersatzlos: `heatingAllocation` lieferte nur Posten
     mit `lease_id`, und die Engine reichte nur solche weiter. Bei MG24 2025
     waren das 999,72 € von 4.943,22 € — die Objektsumme war zu niedrig und
     der Eigentümer sah seinen eigenen Anteil nirgends. */

  function mitLeerstand(startW2: string, betrag = 1000) {
    const k = { ...konfig(30, 70), hot_water_via_heating: false };
    const units = [einheit(1, 'W1', 100), einheit(2, 'W2', 100)];
    const leases = [vertrag(10, 1), { ...vertrag(20, 2), start_date: startW2 }];
    const meters = [
      zaehler(100, 1, 'heat'), zaehler(200, 2, 'heat'),
      zaehler(999, null, 'heat', { is_main_meter: true }),
    ];
    const readings = [
      ablesung(100, 0, '2024-12-31'), ablesung(100, 1000, BIS),
      ablesung(200, 0, '2024-12-31'), ablesung(200, 1000, BIS),
      ablesung(999, 0, '2024-12-31'), ablesung(999, 2000, BIS),
    ];
    return heatingAllocation(k, [buchung(betrag)], meters, readings, units, leases, VON, BIS, [], REGEL);
  }

  it('weist den nicht vermieteten Zeitanteil als Eigentuemerposten aus', () => {
    // W2 ab 01.07.: rund ein halbes Jahr ohne Mietverhaeltnis.
    const e = mitLeerstand('2025-07-01');
    const leer = e.items.filter(i => i.item_type === 'vacancy_owner_share');
    expect(leer).toHaveLength(1);
    expect(leer[0].amount).toBeGreaterThan(200);
    expect(leer[0].notes).toBe('Leerstandsanteil');
    expect((leer[0].metadata_jsonb as any)?.lease_id).toBeUndefined();
  });

  it('verteilt den vollen Betrag — Mieteranteile plus Leerstand ergeben die Buchung', () => {
    const e = mitLeerstand('2025-07-01');
    const summe = e.items.reduce((s, i) => s + i.amount, 0);
    expect(summe).toBeCloseTo(1000, 2);
  });

  it('veraendert die Mieteranteile nicht', () => {
    /* Der Posten ist eine Ergaenzung, keine Umverteilung: Was die Mieter
       zahlen, bleibt auf den Cent gleich. */
    const e = mitLeerstand('2025-07-01');
    const b = betragJeVertrag(e);
    const ohne = betragJeVertrag(mitLeerstand('2025-07-01'));
    expect(b.get(10)).toBeCloseTo(ohne.get(10)!, 2);
    expect(b.get(20)).toBeCloseTo(ohne.get(20)!, 2);
  });

  it('erzeugt ohne Leerstand keinen Posten', () => {
    const e = mitLeerstand(VON);
    expect(e.items.filter(i => i.item_type === 'vacancy_owner_share')).toHaveLength(0);
  });

  it('erzeugt fuer einen Rundungsrest unter einem Euro keinen Posten', () => {
    /* Ein Cent Rundung ist kein Leerstand — eine Zeile dafuer koennte
       niemand erklaeren. */
    const e = mitLeerstand(VON, 1000.004);
    expect(e.items.filter(i => i.item_type === 'vacancy_owner_share')).toHaveLength(0);
  });
});

describe('Heizkostenverteilung — die drei verlangten Aufteilungen', () => {
  it('0 / 100: alles nach Verbrauch', () => {
    // 1.500 zu 500 kWh → 750 zu 250 Euro. Die Fläche spielt keine Rolle.
    const b = betragJeVertrag(nurHeizung(0, 100));
    expect(b.get(10)).toBeCloseTo(750, 2);
    expect(b.get(20)).toBeCloseTo(250, 2);
  });

  it('30 / 70: der bisherige Standardfall', () => {
    // Grundkosten 300 nach Fläche (150/150), Verbrauch 700 nach kWh (525/175).
    const b = betragJeVertrag(nurHeizung(30, 70));
    expect(b.get(10)).toBeCloseTo(675, 2);
    expect(b.get(20)).toBeCloseTo(325, 2);
  });

  it('50 / 50: die untere Grenze der Verordnung', () => {
    // Grundkosten 500 nach Fläche (250/250), Verbrauch 500 nach kWh (375/125).
    const b = betragJeVertrag(nurHeizung(50, 50));
    expect(b.get(10)).toBeCloseTo(625, 2);
    expect(b.get(20)).toBeCloseTo(375, 2);
  });

  it('verteilt in jeder Aufteilung den vollen Betrag', () => {
    for (const [base, verbrauch] of [[0, 100], [30, 70], [50, 50]]) {
      const b = betragJeVertrag(nurHeizung(base, verbrauch));
      const summe = [...b.values()].reduce((s, v) => s + v, 0);
      expect(summe).toBeCloseTo(1000, 2);
    }
  });
});

describe('Befund bei Abweichung von § 7 HeizkostenV', () => {
  it('meldet 0 / 100 als Abweichung', () => {
    const e = nurHeizung(0, 100);
    const f = e.warnings.find(w => w.code === 'HEATING_SPLIT_OUTSIDE_HEIZKOSTENV');
    expect(f).toBeDefined();
    expect(f!.message).toContain('§ 12');
  });

  it('meldet 100 / 0 ebenfalls — die Grenze gilt in beide Richtungen', () => {
    const e = nurHeizung(100, 0);
    expect(e.warnings.some(w => w.code === 'HEATING_SPLIT_OUTSIDE_HEIZKOSTENV')).toBe(true);
  });

  it('meldet 30 / 70 NICHT — das liegt im Rahmen', () => {
    const e = nurHeizung(30, 70);
    expect(e.warnings.some(w => w.code === 'HEATING_SPLIT_OUTSIDE_HEIZKOSTENV')).toBe(false);
  });

  it('meldet 50 / 50 NICHT — genau an der Grenze ist zulässig', () => {
    const e = nurHeizung(50, 50);
    expect(e.warnings.some(w => w.code === 'HEATING_SPLIT_OUTSIDE_HEIZKOSTENV')).toBe(false);
  });
});

describe('Warmwasserwärme: Messwert vor Schätzformel (§ 9 Abs. 2 HeizkostenV)', () => {
  /**
   * Aufbau wie MG24: ein Wärmemengenzähler je Kreis auf Objektebene, dazu
   * Warmwasserzähler in den Wohnungen. Die Wassermenge ist absichtlich so
   * gewählt, dass die Formel ein Vielfaches des Messwerts ergibt — genau der
   * Fall, der bei MG24 aufgetreten ist.
   */
  function mitWarmwasser(gemessen: boolean, betrag = 10000) {
    const units = [einheit(1, 'W1', 100), einheit(2, 'W2', 100)];
    const leases = [vertrag(10, 1), vertrag(20, 2)];
    const meters: MeterRow[] = [
      zaehler(100, 1, 'heat'), zaehler(200, 2, 'heat'),
      zaehler(101, 1, 'warm_water'), zaehler(201, 2, 'warm_water'),
      zaehler(999, null, 'heat', { is_main_meter: true, submetering_purpose: 'space_heating_heat' }),
    ];
    const readings: MeterReadingRow[] = [
      ablesung(100, 0, '2024-12-31'), ablesung(100, 1500, BIS),
      ablesung(200, 0, '2024-12-31'), ablesung(200, 500, BIS),
      // Warmwasser GEGENLÄUFIG zur Raumwärme: W1 heizt viel und duscht wenig,
      // W2 umgekehrt. Nur so wird sichtbar, dass die Größe des
      // Warmwassertopfes die Verteilung verschiebt.
      ablesung(101, 0, '2024-12-31'), ablesung(101, 20, BIS),
      ablesung(201, 0, '2024-12-31'), ablesung(201, 60, BIS),
      ablesung(999, 0, '2024-12-31'), ablesung(999, 7000, BIS),
    ];
    if (gemessen) {
      meters.push(zaehler(998, null, 'heat', { submetering_purpose: 'warm_water_heat' }));
      readings.push(ablesung(998, 0, '2024-12-31'), ablesung(998, 3000, BIS));
    }
    return heatingAllocation(
      konfig(30, 70), [buchung(betrag)], meters, readings, units, leases, VON, BIS, [], REGEL);
  }

  it('nimmt den Messwert, wenn ein Warmwasser-Wärmezähler vorhanden ist', () => {
    const e = mitWarmwasser(true);
    const f = e.warnings.find(w => w.code === 'HEATING_WW_MEASURED');
    expect(f).toBeDefined();
    expect((f!.details as any).gemessen_kwh).toBe(3000);
    // Die Formel käme auf 2,5 × 80 m³ × 50 K = 10.000 kWh — mehr als das Dreifache.
    expect((f!.details as any).formel_kwh).toBe(10000);
    expect(e.items[0].allocation_basis).toContain('Q_WW=3000');
  });

  it('nimmt die Formel, wenn nichts gemessen wird', () => {
    const e = mitWarmwasser(false);
    expect(e.warnings.some(w => w.code === 'HEATING_WW_MEASURED')).toBe(false);
    expect(e.items[0].allocation_basis).toContain('Q_WW=10000');
  });

  it('der Messwert verschiebt Geld zwischen den Wohnungen', () => {
    /* Entscheidend ist der ANTEIL des Warmwassertopfes am Ganzen: gemessen
       3.000 von 10.000 kWh = 30 %, nach der Formel 10.000 von 7.000 — gekappt
       auf 50 %. Je größer der Topf, desto mehr Gewicht haben die
       Warmwasserzähler und desto weniger die Wärmemengenzähler.

       W1 heizt viel (1.500 von 2.000 kWh) und duscht wenig (20 von 80 m³).
       Ein zu großer Warmwassertopf entlastet W1 also auf Kosten von W2 — bei
       MG24 genau der Effekt, der zwei Jahre lang nicht aufgefallen wäre. */
    const gemessen = betragJeVertrag(mitWarmwasser(true));
    const geschaetzt = betragJeVertrag(mitWarmwasser(false));

    expect(gemessen.get(10)).toBeCloseTo(5700, 2);
    expect(gemessen.get(20)).toBeCloseTo(4300, 2);
    expect(geschaetzt.get(10)).toBeCloseTo(5000, 2);
    expect(geschaetzt.get(20)).toBeCloseTo(5000, 2);

    // Der Gesamtbetrag bleibt in beiden Fällen gleich — verschoben wird nur,
    // wer ihn trägt: hier 700 Euro.
    const summeG = [...gemessen.values()].reduce((s, v) => s + v, 0);
    const summeS = [...geschaetzt.values()].reduce((s, v) => s + v, 0);
    expect(summeG).toBeCloseTo(10000, 2);
    expect(summeS).toBeCloseTo(10000, 2);
    expect(Math.abs(gemessen.get(10)! - geschaetzt.get(10)!)).toBeCloseTo(700, 2);
  });
});
