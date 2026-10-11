/**
 * nk/heating — Heating cost allocation per §7/§8/§9 HeizKV.
 * Sprint 5.5b — Etappe c
 */
import type {
  HeatingConfigRow, ExpenseBookingRow, MeterRow, MeterReadingRow,
  UnitRow, LeaseRow, AllocationShareRow, AllocationRuleRow,
  ItemResult, EngineWarning, HeatingResult,
} from './types.js';
import { roundKaufmaennisch } from './engine.js';
import {
  nutzerAnteilWaerme, nutzerAnteilZeit, findeEinzugsstand, nutzungsAbschnitt,
  tageZwischen, isoTag, grundlageKlartext,
  type Grundlage,
} from './nutzerzeit.js';

/**
 * Heizkosten verteilen — einschließlich des Anteils, den kein Mietverhältnis trägt.
 *
 * WARUM DIESER MANTEL (11.10.2026): Jede Verteilung multipliziert den Anteil
 * einer Wohnung mit ihrem Zeitanteil (`calcProRata`). Stand eine Wohnung einen
 * Teil des Jahres leer, bleibt entsprechend etwas übrig — bei MG24 2025 sind
 * das 999,72 € von 4.943,22 €, weil alle drei Mietverhältnisse im Lauf des
 * Jahres begonnen haben.
 *
 * Dieser Rest fiel bisher ERSATZLOS WEG: `heatingAllocation` gab nur Posten mit
 * `lease_id` zurück, und die Engine reichte ausschließlich solche weiter. In
 * der Abrechnung erschienen dadurch weniger Heizkosten, als es gab — der
 * Eigentümer sah seinen eigenen Leerstandsanteil nirgends, und die Objektsumme
 * war zu niedrig. Bei allen anderen Kostenarten wird derselbe Rest seit jeher
 * als `vacancy_owner_share` ausgewiesen (engine.ts, „Vacancy share → owner
 * block"); die Heizung war die Ausnahme.
 *
 * Der Mantel rechnet nicht neu: Er bildet die Differenz zwischen der Summe der
 * Buchungen und der Summe der verteilten Posten. Damit gilt für jede Methode
 * (A, B, Grundaufteilung) dasselbe, ohne jede von ihnen anzufassen.
 */
export function heatingAllocation(
  heatingConfig: HeatingConfigRow | null,
  bookings: ExpenseBookingRow[],
  meters: MeterRow[],
  readings: MeterReadingRow[],
  units: UnitRow[],
  leases: LeaseRow[],
  periodStart: string,
  periodEnd: string,
  shares: AllocationShareRow[],
  rule: AllocationRuleRow,
): HeatingResult {
  const ergebnis = verteileHeizkosten(
    heatingConfig, bookings, meters, readings, units, leases,
    periodStart, periodEnd, shares, rule,
  );

  const gesamt = bookings.reduce((s, b) => s + parseFloat(String(b.amount_gross)), 0);
  const verteilt = ergebnis.items.reduce((s, i) => s + i.amount, 0);
  const rest = roundKaufmaennisch(gesamt - verteilt);

  /* Ein Cent Rundungsrest ist kein Leerstand. Erst ab einem Euro entsteht ein
     eigener Posten — darunter bliebe eine Zeile stehen, die niemand erklären
     kann. Der Rundungsrest selbst gehört in die bestehende Rundungsspalte. */
  if (rest >= 1) {
    ergebnis.items.push({
      item_type: 'vacancy_owner_share',
      /* Ohne Kostenart und ohne Regel — genau wie die Posten der Methoden A
         und B. Die Darstellung führt sie dadurch unter derselben Überschrift
         „Heizung und Warmwasser"; eine eigene Kostenart würde den
         Eigentümeranteil als zweite Kostenart erscheinen lassen. */
      cost_category_id: null,
      allocation_rule_id: null,
      related_lease_id: null,
      total_property: gesamt,
      allocation_basis: 'leerstand',
      share_numerator: rest,
      share_denominator: gesamt,
      share_fraction: gesamt > 0 ? rest / gesamt : 0,
      amount: rest,
      rounding_remainder: null,
      source_booking_ids: [],
      notes: 'Leerstandsanteil',
      metadata_jsonb: null,
    });
  }

  return ergebnis;
}

function verteileHeizkosten(
  heatingConfig: HeatingConfigRow | null,
  bookings: ExpenseBookingRow[],
  meters: MeterRow[],
  readings: MeterReadingRow[],
  units: UnitRow[],
  leases: LeaseRow[],
  periodStart: string,
  periodEnd: string,
  shares: AllocationShareRow[],
  rule: AllocationRuleRow,
): HeatingResult {
  const warnings: EngineWarning[] = [];
  const items: ItemResult[] = [];

  if (!heatingConfig) {
    warnings.push({
      code: 'HEATING_CONFIG_MISSING_FOR_ALLOCATION',
      severity: 'warning',
      message: 'No heating config — skipping heating allocation',
    });
    return { items, warnings };
  }

  const totalAmount = bookings.reduce((s, b) => s + parseFloat(String(b.amount_gross)), 0);
  if (totalAmount <= 0) return { items, warnings };

  const basePct = heatingConfig.base_share_percent != null
    ? parseFloat(String(heatingConfig.base_share_percent)) : 30;
  const consumptionPct = heatingConfig.consumption_share_percent != null
    ? parseFloat(String(heatingConfig.consumption_share_percent)) : 70;

  /* § 7 Abs. 1 HeizkostenV verlangt 50 bis 70 Prozent nach Verbrauch. Bis zum
     11.10.2026 erzwang die Datenbank diesen Rahmen; der Owner hat ihn für MG24
     bewusst verlassen (0 Prozent Grundkosten, 100 Prozent Verbrauch) und trägt
     das Kürzungsrisiko aus § 12 HeizkostenV selbst.

     Eine Sperre, die eine bewusste Entscheidung des Eigentümers blockiert,
     wäre an dieser Stelle falsch — eine stillschweigende Abweichung aber
     auch. Deshalb steht die Abweichung ab jetzt als Befund in jeder
     Abrechnung. */
  if (consumptionPct < 50 || consumptionPct > 70) {
    warnings.push({
      code: 'HEATING_SPLIT_OUTSIDE_HEIZKOSTENV',
      severity: 'warning',
      message: `Heizkostenverteilung ${basePct} % Grundkosten / ${consumptionPct} % Verbrauch. `
        + '§ 7 Abs. 1 HeizkostenV sieht 50 bis 70 % Verbrauchsanteil vor. Bei einer Abweichung '
        + 'kann der Mieter die Heizkosten nach § 12 HeizkostenV um 15 % kürzen, sofern keine '
        + 'wirksame abweichende Vereinbarung im Mietvertrag besteht.',
      details: { base_share_percent: basePct, consumption_share_percent: consumptionPct },
    });
  }

  const basePool = totalAmount * (basePct / 100);
  const consumptionPool = totalAmount * (consumptionPct / 100);

  // Determine method based on available meters
  const mainHeatMeter = meters.find(m => m.is_main_meter && (m.medium === 'heat' || m.medium === 'gas'));
  const wwMeters = meters.filter(m => m.medium === 'warm_water' && m.unit_id);
  const heatMeters = meters.filter(m =>
    m.medium === 'heat' && !m.is_main_meter && m.unit_id &&
    (m.submetering_purpose === 'space_heating_heat' || m.submetering_purpose === 'warm_water_heat' || !m.submetering_purpose),
  );

  const hasWwSubmetering = heatMeters.some(m => m.submetering_purpose === 'warm_water_heat');

  /* GEMESSENE Warmwasserwärme auf Objektebene.

     § 9 Abs. 2 HeizkostenV lässt die Schätzformel Q = 2,5 · V · (tw − 10) nur
     zu, WENN die Wärmemenge für das Warmwasser nicht gemessen wird. Wird sie
     gemessen, gilt der Messwert.

     MG24 hat genau so einen Zähler: Für 2025 weist er 7.559 kWh aus, während
     die Formel auf 18.331 kWh kommt — mehr als das Doppelte. Die Kappung bei
     50 Prozent hat das bis zum 11.10.2026 verdeckt: Dem Warmwasser wurde die
     Hälfte aller Heizkosten zugeordnet statt der gemessenen knapp 31 Prozent.
     Das verschiebt Geld zwischen den Wohnungen, weil das Warmwasser nach den
     Warmwasserzählern verteilt wird und die Raumwärme nach den
     Wärmemengenzählern. */
  const wwWaermeZaehler = meters.filter(
    m => m.medium === 'heat' && !m.unit_id && m.submetering_purpose === 'warm_water_heat');
  const raumWaermeZaehler = meters.filter(
    m => m.medium === 'heat' && !m.unit_id && m.submetering_purpose === 'space_heating_heat');
  const gemesseneWwWaerme = wwWaermeZaehler.reduce(
    (s, m) => s + calculateConsumption(m.id, periodStart, periodEnd, readings), 0);
  const gemesseneRaumWaerme = raumWaermeZaehler.reduce(
    (s, m) => s + calculateConsumption(m.id, periodStart, periodEnd, readings), 0);

  // Separate WW and heating costs if hot_water_via_heating
  let wwCostPool = 0;
  let heatingCostPool = totalAmount;

  if (heatingConfig.hot_water_via_heating) {
    if (hasWwSubmetering) {
      // Method B: heat meters distinguish WW vs space heating
      const result = methodB(
        totalAmount, heatMeters, readings, units, leases,
        periodStart, periodEnd, basePct, consumptionPct,
      );
      items.push(...result.items);
      warnings.push(...result.warnings);
      return { items, warnings };
    } else if (wwMeters.length > 0 && mainHeatMeter) {
      // Method A: WW volume formula
      const result = methodA(
        totalAmount, mainHeatMeter, wwMeters, readings, meters, units, leases,
        periodStart, periodEnd, basePct, consumptionPct, heatingConfig,
        gemesseneWwWaerme > 0 ? gemesseneWwWaerme : null,
        gemesseneRaumWaerme > 0 ? gemesseneRaumWaerme : null,
      );
      items.push(...result.items);
      warnings.push(...result.warnings);
      return { items, warnings };
    } else {
      // Fallback: 30/70 default split for WW
      wwCostPool = totalAmount * 0.30;
      heatingCostPool = totalAmount * 0.70;
      warnings.push({
        code: 'HEATING_WW_FALLBACK_SPLIT',
        severity: 'warning',
        message: 'No WW meters or heat meters — using 30/70 default split',
      });
    }
  }

  // Base share: allocate by sqm (area-based)
  const totalSqm = units.reduce((s, u) => s + (u.living_area_qm || 0), 0);

  if (totalSqm <= 0) {
    warnings.push({
      code: 'HEATING_NO_SQM',
      severity: 'warning',
      message: 'No unit areas — cannot allocate heating base share',
    });
    return { items, warnings };
  }

  // Consumption share: allocate by unit heat meters or shares
  const unitHeatMeters = meters.filter(m => m.medium === 'heat' && !m.is_main_meter && m.unit_id);
  let consumptionByUnit: Map<number, number>;

  if (unitHeatMeters.length > 0) {
    consumptionByUnit = new Map();
    for (const meter of unitHeatMeters) {
      if (!meter.unit_id) continue;
      const consumption = calculateConsumption(meter.id, periodStart, periodEnd, readings);
      const existing = consumptionByUnit.get(meter.unit_id) || 0;
      consumptionByUnit.set(meter.unit_id, existing + consumption);
    }
  } else if (shares.length > 0) {
    // Use allocation shares as consumption proxy
    consumptionByUnit = new Map();
    for (const share of shares) {
      consumptionByUnit.set(share.unit_id, parseFloat(String(share.share_value)));
    }
  } else {
    // Fallback: equal distribution
    consumptionByUnit = new Map();
    for (const unit of units) {
      consumptionByUnit.set(unit.id, 1);
    }
    warnings.push({
      code: 'HEATING_NO_CONSUMPTION_DATA',
      severity: 'warning',
      message: 'No heat meters or shares — using equal distribution for consumption',
    });
  }

  const totalConsumption = Array.from(consumptionByUnit.values()).reduce((s, v) => s + v, 0);

  // Distribute to leases
  for (const lease of leases) {
    const unit = units.find(u => u.id === lease.unit_id);
    if (!unit) continue;

    /* § 9b-Anteile. Dieser Zweig verteilt reine Heizkosten ohne
       Warmwasseranteil — deshalb zählen nur die Wärmemengenzähler. */
    const f = nutzerFaktoren(
      lease, unit,
      meters.filter(m => m.medium === 'heat' && !m.is_main_meter && m.unit_id === unit.id),
      [], readings, periodStart, periodEnd, warnings);
    if (!f) continue;

    // Base share (sqm)
    const sqm = unit.living_area_qm || 0;
    const flaechenAnteil = totalSqm > 0 ? sqm / totalSqm : 0;
    const baseAmount = roundKaufmaennisch(basePool * flaechenAnteil * f.waermeBasis);

    // Consumption share
    const unitConsumption = consumptionByUnit.get(unit.id) || 0;
    const consFraction = totalConsumption > 0
      ? (unitConsumption / totalConsumption) * f.waerme : 0;
    const consAmount = roundKaufmaennisch(consumptionPool * consFraction);

    const totalPerLease = roundKaufmaennisch(baseAmount + consAmount);

    items.push({
      item_type: 'regular',
      cost_category_id: bookings[0]?.cost_category_id || null,
      allocation_rule_id: rule.id,
      related_lease_id: null,
      total_property: totalAmount,
      allocation_basis: `heating_split(${basePct}/${consumptionPct})`,
      share_numerator: totalPerLease,
      share_denominator: totalAmount,
      share_fraction: totalAmount > 0 ? totalPerLease / totalAmount : 0,
      amount: totalPerLease,
      rounding_remainder: null,
      source_booking_ids: [],
      notes: `Basis: ${baseAmount} (${basePct}% Fläche) + Verbrauch: ${consAmount} (${consumptionPct}%)`,
      metadata_jsonb: { lease_id: lease.id, base_amount: baseAmount, consumption_amount: consAmount },
    });
  }

  return { items, warnings };
}

// ── Consumption Calculation ──────────────────────────────────────────────────

/**
 * Calculate consumption for a meter between two dates.
 * Uses latest_reading_before(end) - latest_reading_before(start).
 * Handles meter_reset readings.
 */
export function calculateConsumption(
  meterId: number,
  startDate: string,
  endDate: string,
  readings: MeterReadingRow[],
): number {
  const meterReadings = readings
    .filter(r => r.meter_id === meterId)
    .sort((a, b) => new Date(a.read_at).getTime() - new Date(b.read_at).getTime());

  if (meterReadings.length === 0) return 0;

  const startD = new Date(startDate);
  /* Das Periodenende ist ein TAG, kein Zeitpunkt. `new Date('2025-12-31')`
     ergibt Mitternacht — eine Ablesung vom 31.12. um 22:41 Uhr fiele damit aus
     dem Zeitraum heraus und der Jahresverbrauch waere zu klein. Genau so
     stehen die Staende aus den Monatsberichten in der Datenbank. Deshalb wird
     bis zum Tagesende gerechnet. Ein Zeitstempel im Eingabewert bleibt
     unveraendert. (10.10.2026) */
  const endD = /^\d{4}-\d{2}-\d{2}$/.test(endDate)
    ? new Date(`${endDate}T23:59:59.999Z`)
    : new Date(endDate);

  // Find latest reading before or at end
  const endReading = findLatestBefore(meterReadings, endD);
  // Find latest reading before or at start
  const startReading = findLatestBefore(meterReadings, startD);

  if (!endReading) return 0;
  if (!startReading) return parseFloat(String(endReading.value));

  // Check for meter_reset between start and end
  const resetReadings = meterReadings.filter(
    r => r.reading_type === 'meter_reset' &&
    new Date(r.read_at) > startD && new Date(r.read_at) <= endD,
  );

  if (resetReadings.length > 0) {
    // Sum consumption segments around resets
    let total = 0;
    let lastValue = parseFloat(String(startReading.value));

    for (const reset of resetReadings) {
      // Consumption before reset
      total += parseFloat(String(reset.value)) - lastValue;
      lastValue = 0; // meter restarted at 0
    }

    // Consumption after last reset
    total += parseFloat(String(endReading.value)) - lastValue;
    return Math.max(0, total);
  }

  return Math.max(0, parseFloat(String(endReading.value)) - parseFloat(String(startReading.value)));
}

function findLatestBefore(readings: MeterReadingRow[], date: Date): MeterReadingRow | null {
  let latest: MeterReadingRow | null = null;
  for (const r of readings) {
    if (new Date(r.read_at) <= date) {
      if (!latest || new Date(r.read_at) > new Date(latest.read_at)) {
        latest = r;
      }
    }
  }
  return latest;
}

// ── Method A: WW Volume Formula ──────────────────────────────────────────────

/**
 * §9(2) Method A: Q_WW = 2.5 * V_m3 * (tw - 10)
 * Splits total heating cost into WW and space-heating pools.
 */
function methodA(
  totalCost: number,
  mainHeatMeter: MeterRow,
  wwMeters: MeterRow[],
  readings: MeterReadingRow[],
  allMeters: MeterRow[],
  units: UnitRow[],
  leases: LeaseRow[],
  periodStart: string,
  periodEnd: string,
  basePct: number,
  consumptionPct: number,
  heatingConfig: HeatingConfigRow,
  /** Gemessene Warmwasserwärme in kWh. Hat Vorrang vor der Schätzformel. */
  gemesseneWwWaerme: number | null = null,
  /** Gemessene Raumwärme in kWh. Nenner, wenn beide Kreise gemessen werden. */
  gemesseneRaumWaerme: number | null = null,
): HeatingResult {
  const warnings: EngineWarning[] = [];
  const items: ItemResult[] = [];

  // Total WW volume (m3) from WW meters
  let totalWwVolume = 0;
  for (const meter of wwMeters) {
    totalWwVolume += calculateConsumption(meter.id, periodStart, periodEnd, readings);
  }

  /* Warmwasserwärme: Messwert vor Schätzung (§ 9 Abs. 2 HeizkostenV). */
  const geschaetztesQWw = 2.5 * totalWwVolume * (60 - 10);
  const qWw = gemesseneWwWaerme ?? geschaetztesQWw;
  if (gemesseneWwWaerme !== null) {
    warnings.push({
      code: 'HEATING_WW_MEASURED',
      severity: 'warning',
      message: `Warmwasserwärme gemessen: ${Math.round(gemesseneWwWaerme)} kWh. Die Formel des `
        + `§ 9 Abs. 2 HeizkostenV käme auf ${Math.round(geschaetztesQWw)} kWh `
        + `(2,5 × ${Math.round(totalWwVolume * 100) / 100} m³ × 50 K); der Messwert hat Vorrang.`,
      details: {
        gemessen_kwh: Math.round(gemesseneWwWaerme),
        formel_kwh: Math.round(geschaetztesQWw),
        ww_volumen_m3: Math.round(totalWwVolume * 100) / 100,
      },
    });
  }

  /* Nenner: Werden beide Kreise gemessen, ist die erzeugte Nutzwärme ihre
     Summe. Der Hauptzähler misst bei MG24 nur den Heizkreis — ihn als Nenner
     zu nehmen hiesse, das Warmwasser doppelt zu zählen. */
  const totalHeat = (gemesseneWwWaerme !== null && gemesseneRaumWaerme !== null)
    ? gemesseneWwWaerme + gemesseneRaumWaerme
    : calculateConsumption(mainHeatMeter.id, periodStart, periodEnd, readings);

  if (totalHeat <= 0) {
    warnings.push({
      code: 'HEATING_MAIN_METER_ZERO',
      severity: 'warning',
      message: 'Main heat meter consumption is 0 — cannot split WW/heating',
    });
    // Fallback: allocate all by area
    return applyHeatingBaseSplit(basePct, consumptionPct, totalCost, units, leases,
      periodStart, periodEnd, new Map(), warnings, null);
  }

  const wwFraction = Math.min(qWw / totalHeat, 0.5); // cap at 50%
  const wwCostPool = totalCost * wwFraction;
  const heatingCostPool = totalCost * (1 - wwFraction);

  // WW: allocate by WW consumption per unit
  const wwConsumptionByUnit = new Map<number, number>();
  for (const meter of wwMeters) {
    if (!meter.unit_id) continue;
    const cons = calculateConsumption(meter.id, periodStart, periodEnd, readings);
    const existing = wwConsumptionByUnit.get(meter.unit_id) || 0;
    wwConsumptionByUnit.set(meter.unit_id, existing + cons);
  }

  // Heating: allocate by unit heat meters or sqm
  const unitHeatMeters = allMeters.filter(m =>
    m.medium === 'heat' && !m.is_main_meter && m.unit_id,
  );
  const heatConsumptionByUnit = new Map<number, number>();
  for (const meter of unitHeatMeters) {
    if (!meter.unit_id) continue;
    const cons = calculateConsumption(meter.id, periodStart, periodEnd, readings);
    const existing = heatConsumptionByUnit.get(meter.unit_id) || 0;
    heatConsumptionByUnit.set(meter.unit_id, existing + cons);
  }

  const totalSqm = units.reduce((s, u) => s + (u.living_area_qm || 0), 0);
  const totalWwCons = Array.from(wwConsumptionByUnit.values()).reduce((s, v) => s + v, 0);
  const totalHeatCons = Array.from(heatConsumptionByUnit.values()).reduce((s, v) => s + v, 0);

  for (const lease of leases) {
    const unit = units.find(u => u.id === lease.unit_id);
    if (!unit) continue;

    /* Nutzeranteil nach § 9b HeizkostenV statt eines einheitlichen
       Zeitanteils: Wärme nach Gradtagszahlen, Warmwasser nach Zeit, eine
       vorhandene Zwischenablesung geht beidem vor. */
    const f = nutzerFaktoren(
      lease, unit,
      allMeters.filter(m => m.medium === 'heat' && !m.is_main_meter && m.unit_id === unit.id),
      wwMeters.filter(m => m.unit_id === unit.id),
      readings, periodStart, periodEnd, warnings);
    if (!f) continue;

    const sqm = unit.living_area_qm || 0;

    // WW costs: base (sqm) + consumption (ww meters) — beides zeitanteilig
    const wwBase = roundKaufmaennisch(wwCostPool * (basePct / 100) *
      (totalSqm > 0 ? (sqm / totalSqm) * f.zeit : 0));
    const wwCons = totalWwCons > 0
      ? roundKaufmaennisch(wwCostPool * (consumptionPct / 100) *
          ((wwConsumptionByUnit.get(unit.id) || 0) / totalWwCons) * f.zeit)
      : 0;

    // Heating costs: base (sqm) + consumption (heat meters or sqm fallback)
    const hBase = roundKaufmaennisch(heatingCostPool * (basePct / 100) *
      (totalSqm > 0 ? (sqm / totalSqm) * f.waermeBasis : 0));
    const hCons = totalHeatCons > 0
      ? roundKaufmaennisch(heatingCostPool * (consumptionPct / 100) *
          ((heatConsumptionByUnit.get(unit.id) || 0) / totalHeatCons) * f.waerme)
      : roundKaufmaennisch(heatingCostPool * (consumptionPct / 100) *
          (totalSqm > 0 ? (sqm / totalSqm) * f.waerme : 0));

    const totalPerLease = roundKaufmaennisch(wwBase + wwCons + hBase + hCons);

    items.push({
      item_type: 'regular',
      cost_category_id: null,
      allocation_rule_id: null,
      related_lease_id: null,
      total_property: totalCost,
      allocation_basis: `methodA(Q_WW=${Math.round(qWw)}kWh,${basePct}/${consumptionPct})`,
      share_numerator: totalPerLease,
      share_denominator: totalCost,
      share_fraction: totalCost > 0 ? totalPerLease / totalCost : 0,
      amount: totalPerLease,
      rounding_remainder: null,
      source_booking_ids: [],
      notes: `WW: ${wwBase}+${wwCons}, Heizung: ${hBase}+${hCons}`,
      metadata_jsonb: {
        lease_id: lease.id,
        method: 'A',
        q_ww_kwh: Math.round(qWw),
        ww_volume_m3: totalWwVolume,
      },
    });
  }

  return { items, warnings };
}

// ── Method B: Heat Meter Submetering ─────────────────────────────────────────

/**
 * §9(1) Method B: direct heat metering per submetering_purpose.
 */
function methodB(
  totalCost: number,
  heatMeters: MeterRow[],
  readings: MeterReadingRow[],
  units: UnitRow[],
  leases: LeaseRow[],
  periodStart: string,
  periodEnd: string,
  basePct: number,
  consumptionPct: number,
): HeatingResult {
  const warnings: EngineWarning[] = [];
  const items: ItemResult[] = [];

  // Split meters by purpose
  const wwHeatMeters = heatMeters.filter(m => m.submetering_purpose === 'warm_water_heat');
  const spaceHeatMeters = heatMeters.filter(m =>
    m.submetering_purpose === 'space_heating_heat' || !m.submetering_purpose,
  );

  // Get total consumption per purpose
  let totalWwHeat = 0;
  let totalSpaceHeat = 0;
  const wwByUnit = new Map<number, number>();
  const spaceByUnit = new Map<number, number>();

  for (const meter of wwHeatMeters) {
    if (!meter.unit_id) continue;
    const cons = calculateConsumption(meter.id, periodStart, periodEnd, readings);
    totalWwHeat += cons;
    wwByUnit.set(meter.unit_id, (wwByUnit.get(meter.unit_id) || 0) + cons);
  }

  for (const meter of spaceHeatMeters) {
    if (!meter.unit_id) continue;
    const cons = calculateConsumption(meter.id, periodStart, periodEnd, readings);
    totalSpaceHeat += cons;
    spaceByUnit.set(meter.unit_id, (spaceByUnit.get(meter.unit_id) || 0) + cons);
  }

  const totalHeat = totalWwHeat + totalSpaceHeat;
  if (totalHeat <= 0) {
    warnings.push({ code: 'HEATING_ZERO_CONSUMPTION', severity: 'warning', message: 'Zero heat consumption — using area-based fallback' });
    return applyHeatingBaseSplit(basePct, consumptionPct, totalCost, units, leases,
      periodStart, periodEnd, new Map(), warnings, null);
  }

  const wwFraction = totalWwHeat / totalHeat;
  const wwCostPool = totalCost * wwFraction;
  const heatingCostPool = totalCost * (1 - wwFraction);

  const totalSqm = units.reduce((s, u) => s + (u.living_area_qm || 0), 0);

  for (const lease of leases) {
    const unit = units.find(u => u.id === lease.unit_id);
    if (!unit) continue;

    /* § 9b-Anteile wie in Methode A. Die Zähler für Warmwasserwärme tragen
       hier den Zeitanteil, die für Raumwärme den Gradtagsanteil. */
    const f = nutzerFaktoren(
      lease, unit,
      spaceHeatMeters.filter(m => m.unit_id === unit.id),
      wwHeatMeters.filter(m => m.unit_id === unit.id),
      readings, periodStart, periodEnd, warnings);
    if (!f) continue;

    const sqm = unit.living_area_qm || 0;

    // WW
    const wwBase = roundKaufmaennisch(wwCostPool * (basePct / 100) *
      (totalSqm > 0 ? (sqm / totalSqm) * f.zeit : 0));
    const wwCons = totalWwHeat > 0
      ? roundKaufmaennisch(wwCostPool * (consumptionPct / 100) *
          ((wwByUnit.get(unit.id) || 0) / totalWwHeat) * f.zeit)
      : 0;

    // Space heating
    const hBase = roundKaufmaennisch(heatingCostPool * (basePct / 100) *
      (totalSqm > 0 ? (sqm / totalSqm) * f.waermeBasis : 0));
    const hCons = totalSpaceHeat > 0
      ? roundKaufmaennisch(heatingCostPool * (consumptionPct / 100) *
          ((spaceByUnit.get(unit.id) || 0) / totalSpaceHeat) * f.waerme)
      : 0;

    const totalPerLease = roundKaufmaennisch(wwBase + wwCons + hBase + hCons);

    items.push({
      item_type: 'regular',
      cost_category_id: null,
      allocation_rule_id: null,
      related_lease_id: null,
      total_property: totalCost,
      allocation_basis: `methodB(${basePct}/${consumptionPct})`,
      share_numerator: totalPerLease,
      share_denominator: totalCost,
      share_fraction: totalCost > 0 ? totalPerLease / totalCost : 0,
      amount: totalPerLease,
      rounding_remainder: null,
      source_booking_ids: [],
      notes: `WW: ${wwBase}+${wwCons}, Heizung: ${hBase}+${hCons}`,
      metadata_jsonb: { lease_id: lease.id, method: 'B' },
    });
  }

  return { items, warnings };
}

// ── Heating Base Split Helper ────────────────────────────────────────────────

function applyHeatingBaseSplit(
  basePct: number,
  consumptionPct: number,
  totalCost: number,
  units: UnitRow[],
  leases: LeaseRow[],
  periodStart: string,
  periodEnd: string,
  consumptionByUnit: Map<number, number>,
  warnings: EngineWarning[],
  rule: AllocationRuleRow | null,
): HeatingResult {
  const items: ItemResult[] = [];
  const totalSqm = units.reduce((s, u) => s + (u.living_area_qm || 0), 0);
  const totalConsumption = Array.from(consumptionByUnit.values()).reduce((s, v) => s + v, 0);

  for (const lease of leases) {
    const unit = units.find(u => u.id === lease.unit_id);
    if (!unit) continue;

    /* Auch hier der Nutzeranteil nach § 9b. Zähler gibt es in diesem Zweig
       keine — er greift gerade dann, wenn nicht gemessen wird —, also bleibt
       es bei der Aufteilung nach Gradtagszahlen. */
    const f = nutzerFaktoren(lease, unit, [], [], [], periodStart, periodEnd, warnings);
    if (!f) continue;

    const sqm = unit.living_area_qm || 0;
    const flaechenAnteil = totalSqm > 0 ? sqm / totalSqm : 0;
    const baseAmount = roundKaufmaennisch(
      totalCost * (basePct / 100) * flaechenAnteil * f.waermeBasis);

    let consAmount = 0;
    if (totalConsumption > 0) {
      const unitCons = consumptionByUnit.get(unit.id) || 0;
      consAmount = roundKaufmaennisch(
        totalCost * (consumptionPct / 100) * (unitCons / totalConsumption) * f.waerme);
    } else {
      // Fallback: consumption share also by sqm
      consAmount = roundKaufmaennisch(
        totalCost * (consumptionPct / 100) * flaechenAnteil * f.waerme);
    }

    const total = roundKaufmaennisch(baseAmount + consAmount);

    items.push({
      item_type: 'regular',
      cost_category_id: null,
      allocation_rule_id: rule?.id || null,
      related_lease_id: null,
      total_property: totalCost,
      allocation_basis: `heating_split(${basePct}/${consumptionPct})`,
      share_numerator: total,
      share_denominator: totalCost,
      share_fraction: totalCost > 0 ? total / totalCost : 0,
      amount: total,
      rounding_remainder: null,
      source_booking_ids: [],
      notes: `Basis: ${baseAmount} + Verbrauch: ${consAmount}`,
      metadata_jsonb: { lease_id: lease.id },
    });
  }

  return { items, warnings };
}

// ── Nutzeranteil bei unterjährigem Mietverhältnis ────────────────────────────

/**
 * Die Faktoren, mit denen der Anteil einer Wohnung auf den Nutzer
 * heruntergebrochen wird.
 *
 * WARUM DREI FAKTOREN UND NICHT EINER. Bis zum 11.10.2026 stand hier überall
 * derselbe Zeitanteil. § 9b HeizkostenV unterscheidet aber:
 *
 *   - Wärme ohne Zwischenablesung → Gradtagszahlen (Abs. 3). Januar wiegt
 *     schwerer als Juli; der Zeitanteil bildet das nicht ab.
 *   - Warmwasser → immer zeitanteilig.
 *   - Mit Zwischenablesung → der gemessene Anteil für die verbrauchsabhängigen
 *     Kosten, Zeitanteil für die übrigen (Abs. 2).
 */
interface NutzerFaktoren {
  /** Verbrauchsabhängiger Wärmeanteil. */
  waerme: number;
  /** Grundkostenanteil Wärme — bei Zwischenablesung zeitanteilig. */
  waermeBasis: number;
  /** Warmwasser, Verbrauch wie Grundkosten. */
  zeit: number;
  grundlage: Grundlage;
}

/**
 * Stände einer Wohnung zusammengefasst: Anfang, Ende und — wenn für JEDEN
 * Zähler der Wohnung vorhanden — der Stand zum Einzug.
 *
 * Alles oder nichts: Hat nur einer von zwei Wärmemengenzählern eine
 * Zwischenablesung, ist der Wohnungsverbrauch nicht messbar getrennt. Dann
 * wird aufgeteilt, statt zwei Grundlagen zu mischen.
 */
function staendeDerWohnung(
  zaehler: MeterRow[], einzugsTag: string,
  readings: MeterReadingRow[], periodStart: string, periodEnd: string,
) {
  let anfang = 0; let ende = 0; let einzugSumme = 0; let alleHabenEinzug = zaehler.length > 0;
  let einzugsTagGenutzt = '';
  for (const m of zaehler) {
    const eigene = readings
      .filter(r => r.meter_id === m.id)
      .map(r => ({ tag: isoTag(r.read_at as any), wert: parseFloat(String(r.value)) }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
    const vorher = eigene.filter(r => r.tag <= periodStart).pop();
    const letzter = eigene.filter(r => r.tag <= periodEnd).pop();
    anfang += vorher ? vorher.wert : 0;
    ende += letzter ? letzter.wert : 0;
    const e = findeEinzugsstand(m.id, einzugsTag, readings);
    if (e) { einzugSumme += e.wert; einzugsTagGenutzt = e.tag; } else { alleHabenEinzug = false; }
  }
  return {
    standAnfang: anfang,
    standEnde: ende,
    einzugsstand: alleHabenEinzug ? { tag: einzugsTagGenutzt, wert: einzugSumme } : null,
  };
}

/**
 * Die Faktoren für ein Mietverhältnis. `null`, wenn es im Zeitraum gar nicht
 * läuft. Ein § 9b-Fall wird als Befund gemeldet — er gehört in die Abrechnung.
 */
function nutzerFaktoren(
  lease: LeaseRow,
  unit: UnitRow,
  waermeZaehler: MeterRow[],
  warmwasserZaehler: MeterRow[],
  readings: MeterReadingRow[],
  periodStart: string,
  periodEnd: string,
  warnings: EngineWarning[],
): NutzerFaktoren | null {
  const abschnitt = nutzungsAbschnitt(lease, periodStart, periodEnd);
  if (!abschnitt) return null;

  const einzugsTag = isoTag(lease.start_date);
  const w = nutzerAnteilWaerme({
    lease, periodStart, periodEnd,
    ...staendeDerWohnung(waermeZaehler, einzugsTag, readings, periodStart, periodEnd),
  });
  const z = nutzerAnteilZeit({
    lease, periodStart, periodEnd,
    ...staendeDerWohnung(warmwasserZaehler, einzugsTag, readings, periodStart, periodEnd),
  });
  if (!w || !z) return null;

  const reinZeit = tageZwischen(abschnitt.von, abschnitt.bis)
    / tageZwischen(periodStart, periodEnd);

  if (w.grundlage === 'gradtagszahlen' || z.grundlage === 'zeitanteil') {
    warnings.push({
      code: 'NUTZERWECHSEL_9B_AUFTEILUNG',
      severity: 'warning',
      message: `Einheit ${unit.code}: Das Mietverhältnis beginnt oder endet im `
        + `Abrechnungszeitraum (${abschnitt.von} bis ${abschnitt.bis}), eine Zwischenablesung `
        + 'zum Nutzerwechsel liegt nicht vor. Aufgeteilt wird nach § 9b Abs. 3 HeizkostenV: '
        + `Wärme nach Gradtagszahlen (${(w.anteil * 100).toFixed(1)} %), Warmwasser `
        + `zeitanteilig (${(z.anteil * 100).toFixed(1)} %). Der Rest trägt der Eigentümer.`,
      details: {
        unit_code: unit.code,
        von: abschnitt.von, bis: abschnitt.bis,
        anteil_waerme: Math.round(w.anteil * 10000) / 100,
        anteil_zeit: Math.round(z.anteil * 10000) / 100,
        grundlage_waerme: grundlageKlartext(w.grundlage),
      },
    });
  }

  return {
    waerme: w.anteil,
    /* Bei einer Zwischenablesung gehen nur die verbrauchsabhängigen Kosten
       nach dem Messwert; die Grundkosten bleiben zeitanteilig (§ 9b Abs. 2).
       Ohne Zwischenablesung gilt Absatz 3 — dann auch die Grundkosten nach
       Gradtagszahlen. */
    waermeBasis: w.grundlage === 'zwischenablesung' ? reinZeit : w.anteil,
    zeit: z.anteil,
    grundlage: w.grundlage,
  };
}

/* `calcProRata()` ist am 11.10.2026 entfallen. Die Funktion rechnete für JEDE
   Kostenart denselben Zeitanteil — für die Wärme ist das nach § 9b Abs. 3
   HeizkostenV falsch, dort gelten Gradtagszahlen. An ihre Stelle ist
   `nutzerFaktoren()` getreten, das die drei Fälle auseinanderhält. Wer den
   Zeitanteil wieder einführt, nimmt den Unterschied zurück. */
