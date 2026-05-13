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

/**
 * Allocate heating and warm-water costs per §7/§8/§9 HeizKV.
 * Returns items per lease, plus warnings.
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

    const proRata = calcProRata(lease, periodStart, periodEnd);
    if (proRata <= 0) continue;

    // Base share (sqm)
    const sqm = unit.living_area_qm || 0;
    const baseFraction = totalSqm > 0 ? (sqm / totalSqm) * proRata : 0;
    const baseAmount = roundKaufmaennisch(basePool * baseFraction);

    // Consumption share
    const unitConsumption = consumptionByUnit.get(unit.id) || 0;
    const consFraction = totalConsumption > 0 ? (unitConsumption / totalConsumption) * proRata : 0;
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
  const endD = new Date(endDate);

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
): HeatingResult {
  const warnings: EngineWarning[] = [];
  const items: ItemResult[] = [];

  // Total WW volume (m3) from WW meters
  let totalWwVolume = 0;
  for (const meter of wwMeters) {
    totalWwVolume += calculateConsumption(meter.id, periodStart, periodEnd, readings);
  }

  // Q formula: Q_WW = 2.5 * V_m3 * (tw - 10) kWh
  const tw = 60; // standard warm water temp
  const qWw = 2.5 * totalWwVolume * (tw - 10);

  // Total heat from main meter
  const totalHeat = calculateConsumption(mainHeatMeter.id, periodStart, periodEnd, readings);

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

    const proRata = calcProRata(lease, periodStart, periodEnd);
    if (proRata <= 0) continue;

    const sqm = unit.living_area_qm || 0;

    // WW costs: base (sqm) + consumption (ww meters)
    const wwBase = roundKaufmaennisch(wwCostPool * (basePct / 100) *
      (totalSqm > 0 ? (sqm / totalSqm) * proRata : 0));
    const wwCons = totalWwCons > 0
      ? roundKaufmaennisch(wwCostPool * (consumptionPct / 100) *
          ((wwConsumptionByUnit.get(unit.id) || 0) / totalWwCons) * proRata)
      : 0;

    // Heating costs: base (sqm) + consumption (heat meters or sqm fallback)
    const hBase = roundKaufmaennisch(heatingCostPool * (basePct / 100) *
      (totalSqm > 0 ? (sqm / totalSqm) * proRata : 0));
    const hCons = totalHeatCons > 0
      ? roundKaufmaennisch(heatingCostPool * (consumptionPct / 100) *
          ((heatConsumptionByUnit.get(unit.id) || 0) / totalHeatCons) * proRata)
      : roundKaufmaennisch(heatingCostPool * (consumptionPct / 100) *
          (totalSqm > 0 ? (sqm / totalSqm) * proRata : 0));

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

    const proRata = calcProRata(lease, periodStart, periodEnd);
    if (proRata <= 0) continue;

    const sqm = unit.living_area_qm || 0;

    // WW
    const wwBase = roundKaufmaennisch(wwCostPool * (basePct / 100) *
      (totalSqm > 0 ? (sqm / totalSqm) * proRata : 0));
    const wwCons = totalWwHeat > 0
      ? roundKaufmaennisch(wwCostPool * (consumptionPct / 100) *
          ((wwByUnit.get(unit.id) || 0) / totalWwHeat) * proRata)
      : 0;

    // Space heating
    const hBase = roundKaufmaennisch(heatingCostPool * (basePct / 100) *
      (totalSqm > 0 ? (sqm / totalSqm) * proRata : 0));
    const hCons = totalSpaceHeat > 0
      ? roundKaufmaennisch(heatingCostPool * (consumptionPct / 100) *
          ((spaceByUnit.get(unit.id) || 0) / totalSpaceHeat) * proRata)
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

    const proRata = calcProRata(lease, periodStart, periodEnd);
    if (proRata <= 0) continue;

    const sqm = unit.living_area_qm || 0;
    const baseFraction = totalSqm > 0 ? (sqm / totalSqm) * proRata : 0;
    const baseAmount = roundKaufmaennisch(totalCost * (basePct / 100) * baseFraction);

    let consAmount = 0;
    if (totalConsumption > 0) {
      const unitCons = consumptionByUnit.get(unit.id) || 0;
      consAmount = roundKaufmaennisch(totalCost * (consumptionPct / 100) * (unitCons / totalConsumption) * proRata);
    } else {
      // Fallback: consumption share also by sqm
      consAmount = roundKaufmaennisch(totalCost * (consumptionPct / 100) * baseFraction);
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

// ── Shared Utility ───────────────────────────────────────────────────────────

function calcProRata(lease: LeaseRow, periodStart: string, periodEnd: string): number {
  const pStart = new Date(periodStart);
  const pEnd = new Date(periodEnd);
  const leaseStart = new Date(lease.start_date);
  const leaseEnd = lease.end_date ? new Date(lease.end_date) : pEnd;

  const effectiveStart = leaseStart > pStart ? leaseStart : pStart;
  const effectiveEnd = leaseEnd < pEnd ? leaseEnd : pEnd;

  if (effectiveStart > effectiveEnd) return 0;

  const days = Math.floor((effectiveEnd.getTime() - effectiveStart.getTime()) / 86_400_000) + 1;
  const totalDays = Math.floor((pEnd.getTime() - pStart.getTime()) / 86_400_000) + 1;

  return days / totalDays;
}
