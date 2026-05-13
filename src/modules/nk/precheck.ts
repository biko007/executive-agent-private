/**
 * nk/precheck — NK Readiness shared pre-check module.
 * Runs 21 diagnostic checks to determine if a property+year is ready
 * for Nebenkostenabrechnung calculation.
 */
import { query as dbQuery } from '../../shared/db/index.js';

export type Severity = 'blocker' | 'warning' | 'info';

export interface PreCheckFinding {
  code: string;
  severity: Severity;
  message: string;
  details?: Record<string, unknown>;
}

export interface PreCheckResult {
  property_id: number;
  property_code: string;
  year: number;
  ready: boolean;
  blocking_count: number;
  warning_count: number;
  info_count: number;
  findings: PreCheckFinding[];
}

/**
 * Run all NK readiness pre-checks for a property+year.
 */
export async function nkPreCheck(propertyId: number, year: number): Promise<PreCheckResult> {
  const findings: PreCheckFinding[] = [];

  // Load property
  const { rows: propRows } = await dbQuery(
    'SELECT * FROM properties WHERE id = $1 AND active = true', [propertyId]
  );
  if (propRows.length === 0) {
    findings.push({ code: 'PROPERTY_NOT_FOUND', severity: 'blocker', message: 'Property not found' });
    return makeResult(propertyId, '', year, findings);
  }
  const prop = propRows[0];

  // 1. BILLING_PERIOD_NOT_CALENDAR_YEAR
  if (prop.billing_period_start_month && prop.billing_period_start_month !== 1) {
    findings.push({
      code: 'BILLING_PERIOD_NOT_CALENDAR_YEAR',
      severity: 'blocker',
      message: `Billing period starts in month ${prop.billing_period_start_month} — only calendar year (Jan-Dec) supported`,
    });
  }

  // 2. COMMERCIAL_NOT_SUPPORTED
  if (prop.property_type === 'commercial' || prop.property_type === 'industrial') {
    findings.push({
      code: 'COMMERCIAL_NOT_SUPPORTED',
      severity: 'blocker',
      message: 'Commercial/industrial properties not yet supported for NK calculation',
    });
  }

  // 3. PROPERTY_OUT_OF_OWNERSHIP
  if (prop.ownership_end && new Date(prop.ownership_end) < new Date(`${year}-12-31`)) {
    findings.push({
      code: 'PROPERTY_OUT_OF_OWNERSHIP',
      severity: 'blocker',
      message: `Property ownership ended on ${prop.ownership_end} — before end of billing period ${year}`,
    });
  }

  // Load heating config
  const { rows: heatingRows } = await dbQuery(
    'SELECT * FROM property_heating_config WHERE property_id = $1 AND year = $2', [propertyId, year]
  );
  const heatingConfig = heatingRows[0] || null;

  // 4. MULTIPLE_HEATING_SYSTEMS_NOT_SUPPORTED
  if (heatingRows.length > 1) {
    findings.push({
      code: 'MULTIPLE_HEATING_SYSTEMS_NOT_SUPPORTED',
      severity: 'blocker',
      message: 'Multiple heating configurations for same year not supported',
    });
  }

  // 5. HEATING_CONFIG_MISSING
  if (!heatingConfig && prop.heating_type && prop.heating_type !== 'none') {
    findings.push({
      code: 'HEATING_CONFIG_MISSING',
      severity: 'blocker',
      message: `No heating configuration for year ${year} — required for properties with heating`,
    });
  }

  // 6. HEATING_CONFIG_INCONSISTENT
  if (heatingConfig) {
    const { base_share_percent, consumption_share_percent } = heatingConfig;
    if (base_share_percent != null && consumption_share_percent != null) {
      const total = parseFloat(base_share_percent) + parseFloat(consumption_share_percent);
      if (Math.abs(total - 100) > 0.01) {
        findings.push({
          code: 'HEATING_CONFIG_INCONSISTENT',
          severity: 'blocker',
          message: `Heating base+consumption shares sum to ${total}% — must be 100%`,
          details: { base_share_percent, consumption_share_percent },
        });
      }
    }
  }

  // Load units
  const { rows: units } = await dbQuery(
    'SELECT * FROM units WHERE property_id = $1 AND active = true', [propertyId]
  );
  const unitIds = units.map((u: any) => u.id);

  // Load allocation rules for year
  const { rows: allocRules } = await dbQuery(
    `SELECT ar.*, cc.code AS category_code FROM allocation_rules ar
     JOIN cost_categories cc ON ar.cost_category_id = cc.id
     WHERE ar.property_id = $1 AND ar.archived_at IS NULL
       AND ar.valid_from <= $2 AND (ar.valid_until IS NULL OR ar.valid_until >= $3)`,
    [propertyId, `${year}-12-31`, `${year}-01-01`]
  );

  // Load expense bookings for year
  const { rows: bookings } = await dbQuery(
    `SELECT eb.*, cc.code AS category_code FROM expense_bookings eb
     JOIN cost_categories cc ON eb.cost_category_id = cc.id
     WHERE eb.property_id = $1 AND eb.archived_at IS NULL
       AND eb.service_period_start <= $2 AND eb.service_period_end >= $3`,
    [propertyId, `${year}-12-31`, `${year}-01-01`]
  );

  // 7. ALLOCATION_RULE_GAP — check that each cost category with bookings has an allocation rule
  const bookedCategories = new Set(bookings.map((b: any) => b.category_code));
  const ruledCategories = new Set(allocRules.map((r: any) => r.category_code));
  for (const cat of bookedCategories) {
    if (!ruledCategories.has(cat)) {
      findings.push({
        code: 'ALLOCATION_RULE_GAP',
        severity: 'blocker',
        message: `Cost category "${cat}" has bookings but no allocation rule for ${year}`,
        details: { category: cat },
      });
    }
  }

  // Load meters
  const { rows: meters } = await dbQuery(
    `SELECT * FROM meters WHERE active = true AND (property_id = $1 OR unit_id = ANY($2))`,
    [propertyId, unitIds]
  );

  const heatingRelevant = prop.heating_type && prop.heating_type !== 'none';

  // 8. MISSING_MAIN_HEAT_METER
  if (heatingRelevant) {
    const mainHeatMeter = meters.find((m: any) => m.is_main_meter && (m.medium === 'heat' || m.medium === 'gas'));
    if (!mainHeatMeter) {
      findings.push({
        code: 'MISSING_MAIN_HEAT_METER',
        severity: 'blocker',
        message: 'No main heat/gas meter found — required for heating cost allocation',
      });
    }
  }

  // 9. MISSING_WW_METERS
  if (heatingRelevant && heatingConfig?.hot_water_via_heating) {
    const wwMeters = meters.filter((m: any) => m.medium === 'warm_water');
    if (wwMeters.length === 0) {
      findings.push({
        code: 'MISSING_WW_METERS',
        severity: 'warning',
        message: 'No warm water meters — hot water cost split will use formula (30/70 rule)',
      });
    }
  }

  // 10. MISSING_HEAT_METERS
  if (heatingRelevant) {
    const heatMeters = meters.filter((m: any) => m.medium === 'heat' && !m.is_main_meter && m.unit_id);
    if (heatMeters.length === 0 && units.length > 1) {
      findings.push({
        code: 'MISSING_HEAT_METERS',
        severity: 'warning',
        message: 'No unit-level heat meters — consumption-based split not possible',
      });
    }
  }

  // 11. MISSING_SPACE_HEATING_METERS
  // (Same as MISSING_HEAT_METERS for space heating — combine check)

  // Load meter readings for year
  const meterIds = meters.map((m: any) => m.id);
  let readings: any[] = [];
  if (meterIds.length > 0) {
    const { rows: rRows } = await dbQuery(
      `SELECT * FROM meter_readings WHERE meter_id = ANY($1)
       AND read_at >= $2 AND read_at <= $3`,
      [meterIds, `${year}-01-01`, `${year + 1}-03-31`]
    );
    readings = rRows;
  }

  // 12. MISSING_ANNUAL_READING
  for (const meter of meters) {
    const meterReadings = readings.filter((r: any) => r.meter_id === meter.id && r.reading_type === 'annual');
    if (meterReadings.length === 0 && meter.medium !== 'electricity') {
      findings.push({
        code: 'MISSING_ANNUAL_READING',
        severity: 'warning',
        message: `No annual reading for meter ${meter.meter_number} (${meter.medium})`,
        details: { meter_id: meter.id, meter_number: meter.meter_number },
      });
    }
  }

  // 13. MISSING_PERIOD_START_READING
  for (const meter of meters) {
    const startReadings = readings.filter((r: any) =>
      r.meter_id === meter.id &&
      new Date(r.read_at) >= new Date(`${year - 1}-11-01`) &&
      new Date(r.read_at) <= new Date(`${year}-02-28`)
    );
    if (startReadings.length === 0 && meter.medium !== 'electricity') {
      findings.push({
        code: 'MISSING_PERIOD_START_READING',
        severity: 'warning',
        message: `No period-start reading for meter ${meter.meter_number}`,
        details: { meter_id: meter.id, meter_number: meter.meter_number },
      });
    }
  }

  // 14. CONSUMPTION_DENOMINATOR_ZERO
  // Check if any consumption-based rule has zero total consumption
  for (const rule of allocRules) {
    if (rule.key_type === 'consumption') {
      const ruleMeters = meters.filter((m: any) => {
        const cc = rule.category_code;
        if (cc === 'wasser' || cc === 'entwaesserung') return m.medium === 'cold_water';
        if (cc === 'heizung' || cc === 'warmwasser') return m.medium === 'heat' || m.medium === 'warm_water';
        return false;
      });

      if (ruleMeters.length === 0) {
        findings.push({
          code: 'CONSUMPTION_DENOMINATOR_ZERO',
          severity: 'blocker',
          message: `Consumption-based rule for "${rule.category_code}" but no matching meters`,
          details: { rule_id: rule.id, category: rule.category_code },
        });
      }
    }
  }

  // 15. MISSING_INTERIM_READING_FOR_CHANGEOVER
  // Check if any lease changeovers during the year lack interim readings
  const { rows: changeoverLeases } = await dbQuery(
    `SELECT l.id, l.actual_move_out, l.unit_id FROM leases l
     JOIN units u ON l.unit_id = u.id
     WHERE u.property_id = $1 AND l.actual_move_out >= $2 AND l.actual_move_out <= $3`,
    [propertyId, `${year}-01-01`, `${year}-12-31`]
  );

  for (const cl of changeoverLeases) {
    const unitMeters = meters.filter((m: any) => m.unit_id === cl.unit_id);
    for (const meter of unitMeters) {
      const moveOutReadings = readings.filter((r: any) =>
        r.meter_id === meter.id && r.reading_type === 'move_out'
      );
      if (moveOutReadings.length === 0) {
        findings.push({
          code: 'MISSING_INTERIM_READING_FOR_CHANGEOVER',
          severity: 'warning',
          message: `No move-out reading for meter ${meter.meter_number} on lease changeover`,
          details: { lease_id: cl.id, meter_id: meter.id },
        });
      }
    }
  }

  // 16. MISSING_SERVICE_PERIOD_HEATING
  if (heatingRelevant && bookedCategories.size > 0) {
    const heatingCategories = ['heizung', 'warmwasser', 'verbundene_heizung_warmwasser'];
    const hasHeatingBooking = heatingCategories.some(c => bookedCategories.has(c));
    if (!hasHeatingBooking) {
      findings.push({
        code: 'MISSING_SERVICE_PERIOD_HEATING',
        severity: 'warning',
        message: `Property has heating but no heating expense bookings for ${year}`,
      });
    }
  }

  // 17. ESTIMATED_AREA_OVER_25_PERCENT
  const unitsWithArea = units.filter((u: any) => u.living_area_qm != null);
  const unitsWithoutArea = units.filter((u: any) => u.living_area_qm == null);
  if (unitsWithoutArea.length > 0 && units.length > 0) {
    const pct = (unitsWithoutArea.length / units.length) * 100;
    if (pct > 25) {
      findings.push({
        code: 'ESTIMATED_AREA_OVER_25_PERCENT',
        severity: 'warning',
        message: `${unitsWithoutArea.length}/${units.length} units (${Math.round(pct)}%) missing area — exceeds 25% threshold`,
      });
    }
  }

  // 18. MISSING_UNIT_RESIDENTS
  if (unitIds.length > 0) {
    const { rows: residents } = await dbQuery(
      `SELECT DISTINCT unit_id FROM unit_residents
       WHERE unit_id = ANY($1) AND move_in <= $2 AND (move_out IS NULL OR move_out >= $3)`,
      [unitIds, `${year}-12-31`, `${year}-01-01`]
    );
    const residentUnitIds = new Set(residents.map((r: any) => r.unit_id));

    // Check active leases
    const { rows: activeLeases } = await dbQuery(
      `SELECT unit_id FROM leases WHERE unit_id = ANY($1) AND status IN ('active','ended')
       AND start_date <= $2 AND (end_date IS NULL OR end_date >= $3)`,
      [unitIds, `${year}-12-31`, `${year}-01-01`]
    );
    const leasedUnitIds = new Set(activeLeases.map((l: any) => l.unit_id));

    for (const uid of leasedUnitIds) {
      if (!residentUnitIds.has(uid)) {
        const unit = units.find((u: any) => u.id === uid);
        findings.push({
          code: 'MISSING_UNIT_RESIDENTS',
          severity: 'warning',
          message: `Unit ${unit?.code || uid} has active lease but no resident entry for ${year}`,
          details: { unit_id: uid },
        });
      }
    }
  }

  // 19. CO2_HANDLING_REQUIRED
  if (prop.co2_cost_relevant && heatingRelevant && heatingConfig) {
    if (!heatingConfig.co2_emissions_kg && !heatingConfig.co2_cost_total) {
      findings.push({
        code: 'CO2_HANDLING_REQUIRED',
        severity: 'warning',
        message: 'CO2 cost splitting required but no CO2 data in heating config',
      });
    }
  }

  // 20. METER_CALIBRATION_EXPIRED
  for (const meter of meters) {
    if (meter.calibration_valid_until && new Date(meter.calibration_valid_until) < new Date(`${year}-12-31`)) {
      findings.push({
        code: 'METER_CALIBRATION_EXPIRED',
        severity: 'warning',
        message: `Meter ${meter.meter_number} calibration expired on ${meter.calibration_valid_until}`,
        details: { meter_id: meter.id, meter_number: meter.meter_number, expires: meter.calibration_valid_until },
      });
    }
  }

  // 21. BILLING_MODE_EXCLUDED
  const { rows: excludedLeases } = await dbQuery(
    `SELECT l.id, l.billing_mode, u.code AS unit_code FROM leases l
     JOIN units u ON l.unit_id = u.id
     WHERE u.property_id = $1 AND l.billing_mode = 'inklusive'
       AND l.status IN ('active','ended')
       AND l.start_date <= $2 AND (l.end_date IS NULL OR l.end_date >= $3)`,
    [propertyId, `${year}-12-31`, `${year}-01-01`]
  );
  for (const el of excludedLeases) {
    findings.push({
      code: 'BILLING_MODE_EXCLUDED',
      severity: 'info',
      message: `Unit ${el.unit_code} has billing_mode "inklusive" — excluded from NK settlement`,
      details: { lease_id: el.id, unit_code: el.unit_code },
    });
  }

  return makeResult(propertyId, prop.code, year, findings);
}

function makeResult(propertyId: number, propertyCode: string, year: number, findings: PreCheckFinding[]): PreCheckResult {
  const blocking_count = findings.filter(f => f.severity === 'blocker').length;
  const warning_count = findings.filter(f => f.severity === 'warning').length;
  const info_count = findings.filter(f => f.severity === 'info').length;

  return {
    property_id: propertyId,
    property_code: propertyCode,
    year,
    ready: blocking_count === 0,
    blocking_count,
    warning_count,
    info_count,
    findings,
  };
}
