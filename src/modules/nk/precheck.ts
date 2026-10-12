/**
 * nk/precheck — NK Readiness shared pre-check module.
 * Runs 21 diagnostic checks to determine if a property+year is ready
 * for Nebenkostenabrechnung calculation.
 */
import { query as dbQuery } from '../../shared/db/index.js';
import {
  nutzungsAbschnitt, findeEinzugsstand, gradtagsSumme, tageZwischen, isoTag,
} from './nutzerzeit.js';

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
  /** Verteilt mindestens eine Umlageregel nach Personen? Steuert, ob
      MISSING_UNIT_RESIDENTS in der Engine zum Blocker wird. */
  uses_person_key: boolean;
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
      /* Ab November des Vorjahres: Die Prüfung auf einen Anfangsstand sucht
         in genau diesem Fenster. Bis zum 11.10.2026 begann die Abfrage erst
         am 1. Januar — ein Stand vom Dezember war damit nie zu sehen, und die
         Prüfung konnte nur negativ ausfallen. */
      `SELECT * FROM meter_readings WHERE meter_id = ANY($1)
       AND read_at >= $2 AND read_at <= $3`,
      [meterIds, `${year - 1}-11-01`, `${year + 1}-03-31`]
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

  /* 13b. HEAT_METER_NO_DOCUMENTED_START — Blocker.

     Fehlt einem Wärmemengenzähler der Anfangsstand, rechnet
     `calculateConsumption()` mit null und gibt den gesamten Zählerstand als
     Verbrauch des Zeitraums aus. Bei MG24 heißt das: Was der Zähler seit dem
     Einbau gezählt hat — Estrichtrocknung, Bauheizung, Leerstand — landet
     beim Mieter. Das ist nicht „etwas zu hoch", sondern als Abrechnung
     unbrauchbar.

     Ein Hinweis genügt dafür nicht: Die Zahl sieht aus wie gemessen. Deshalb
     ein Blocker — die Abrechnung entsteht erst, wenn der Anfangsstand belegt
     ist.

     Zulässig und kein Blocker sind zwei Fälle:
       - eine Ablesung am oder vor dem Periodenbeginn (das Fenster beginnt im
         November des Vorjahres),
       - ein im Zeitraum eingebauter Zähler mit hinterlegtem Anfangswert — dann
         ist der Startpunkt dokumentiert.

     Strom bleibt wie bei den übrigen Prüfungen außen vor; er wird bei MG24
     nicht nach Verbrauch verteilt. */
  for (const w of waermezaehlerOhneAnfangsstand(meters, readings, year)) findings.push(w);

  /* 13d. HEAT_METER_START_FROM_GLT_DERIVATION — Hinweis, kein Blocker.

     Die Anfangsstände der Wärmemengenzähler zum 01.01.2025 wurden am
     11.10.2026 aus der GLT-Spalte „Vorjahr" abgeleitet (Stand − Jahr aktuell
     − Vorjahr) und ergaben für alle acht Zähler exakt null. Am selben Tag hat
     ein Owner-Foto diese Ableitung für einen Zähler WIDERLEGT: W1 Süd/West
     stand am 31.12.2024 auf 2.772 kWh.

     Die Fiehn-Berichte führen die Spalte „Zählerstand aktuell (Wh)" und laufen
     über den Jahreswechsel weiter — die Reihe ist also der absolute
     Zählerstand und nicht der Jahresverbrauch. Damit sagt die GLT-Spalte
     „Vorjahr" bei diesen Zählern nichts über den Stand zum Jahresanfang.

     Für die übrigen Zähler fehlt der Gegenbeweis in beide Richtungen. Ihr
     Anfangsstand null ist eine ARBEITSANNAHME, und ist er zu niedrig, ist der
     Verbrauch 2025 zu hoch. Deshalb dieser Hinweis in jeder Abrechnung, bis
     die Stichtagswerte vorliegen. */
  for (const meter of meters) {
    if (meter.medium !== 'heat') continue;
    const abgeleitet = readings.some((r: any) =>
      r.meter_id === meter.id && r.reader_name === 'GLT-Jahreszähler');
    if (!abgeleitet) continue;
    findings.push({
      code: 'HEAT_METER_START_FROM_GLT_DERIVATION',
      severity: 'warning',
      message: `Wärmemengenzähler ${meter.meter_number}: Der Anfangsstand zum ${year}-01-01 `
        + 'ist aus der GLT-Spalte „Vorjahr" abgeleitet und nicht abgelesen. Diese Ableitung '
        + 'ist für den Zähler 33050523 (W1 Süd/West) durch ein Foto widerlegt worden — dort '
        + 'stand der Zähler zum Jahreswechsel auf 2.772 kWh statt null. Liegt der wahre '
        + 'Anfangsstand über null, ist der Verbrauch dieses Zeitraums zu hoch angesetzt.',
      details: { meter_id: meter.id, meter_number: meter.meter_number },
    });
  }

  /* 13c. NUTZERWECHSEL_OHNE_AUFTEILUNG — Blocker.

     Beginnt oder endet ein Mietverhältnis im Abrechnungszeitraum, verlangt
     § 9b Abs. 1 HeizkostenV eine Zwischenablesung. Fehlt sie, tritt die
     Aufteilung nach Absatz 3 an ihre Stelle — Wärme nach Gradtagszahlen,
     Warmwasser und Wasser zeitanteilig. Beides zusammen deckt jeden Fall ab.

     Gesperrt wird deshalb nur, wenn WEDER das eine NOCH das andere möglich
     ist: kein Stand zum Einzug und keine brauchbare Aufteilung, weil der
     Nutzungsabschnitt leer ist oder die Gradtagstabelle für den Zeitraum
     nichts hergibt. Das ist der Fall, in dem stillschweigend irgendetwas
     herauskäme — und genau der soll nicht durchgehen. */
  const { rows: mietverhaeltnisse } = await dbQuery(
    `SELECT l.id, l.unit_id, l.start_date, l.end_date FROM leases l
       JOIN units u ON u.id = l.unit_id
      WHERE u.property_id = $1 AND l.status IN ('active','ended')
        AND l.start_date <= $2 AND (l.end_date IS NULL OR l.end_date >= $3)`,
    [propertyId, `${year}-12-31`, `${year}-01-01`]);
  for (const w of nutzerwechselOhneAufteilung(
    mietverhaeltnisse as any, units as any, meters as any, readings as any, year)) {
    findings.push(w);
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

  // 14b. CONSUMPTION_READING_MISSING / CONSUMPTION_START_ASSUMED_ZERO
  //
  // Eine Regel mit key_type 'consumption' verteilt nach gemessenem Verbrauch.
  // Fehlt ein Zählerstand, darf NICHT stillschweigend nach Fläche verteilt
  // werden (Owner-Entscheidung 10.10.2026) — dann ist die Abrechnung gesperrt,
  // bis der Stand nachgetragen ist.
  //
  // Eine Ausnahme ist belegt und damit zulässig: Hat der Zähler im Zeitraum
  // keinen Anfangsstand, ist aber in `meters.initial_reading` ein Startwert
  // hinterlegt und war er zu Periodenbeginn bereits eingebaut, dann ist der
  // Verbrauch bestimmbar. Das ist der Fall bei MG24 2025 — die Zähler standen
  // am 01.01.2025 auf null, belegt durch den Jahreszähler der Gebäude-
  // leittechnik und die Brennstoffbilanz. Dafür gibt es eine Warnung statt
  // eines Blockers.
  const VERBRAUCHSMEDIEN_CHECK: Record<string, string[]> = {
    wasser: ['cold_water'],
    entwaesserung: ['cold_water', 'warm_water'],
    warmwasser: ['warm_water'],
  };
  /* Die Ablesungen oben sind erst ab Periodenbeginn geladen — ein Stand VOR
     dem Zeitraum kann darin nicht vorkommen. Für diese Prüfung wird er
     deshalb eigens ermittelt, statt die gemeinsame Abfrage zu verbreitern:
     das würde MISSING_ANNUAL_READING stillschweigend aufweichen, weil dort
     nicht nach Jahr gefiltert wird. */
  const verbrauchsZaehlerIds = meters
    .filter((m: any) => m.unit_id && !m.is_main_meter)
    .map((m: any) => m.id);
  const anfangsStaende = new Set<number>();
  if (verbrauchsZaehlerIds.length > 0 && allocRules.some((r: any) => r.key_type === 'consumption')) {
    const { rows: vorPeriode } = await dbQuery(
      `SELECT DISTINCT meter_id FROM meter_readings
        WHERE meter_id = ANY($1) AND read_at <= $2`,
      [verbrauchsZaehlerIds, `${year}-01-01`],
    );
    for (const r of vorPeriode) anfangsStaende.add(r.meter_id);
  }

  for (const rule of allocRules) {
    if (rule.key_type !== 'consumption') continue;
    const medien = VERBRAUCHSMEDIEN_CHECK[rule.category_code];
    if (!medien) continue; // Heizkostenarten laufen über heatingAllocation

    const regelZaehler = meters.filter((m: any) =>
      m.unit_id && !m.is_main_meter && medien.includes(m.medium));

    for (const meter of regelZaehler) {
      const eigene = readings
        .filter((r: any) => r.meter_id === meter.id)
        .sort((a: any, b: any) => new Date(a.read_at).getTime() - new Date(b.read_at).getTime());

      const endStand = eigene.filter((r: any) => new Date(r.read_at) <= new Date(`${year}-12-31T23:59:59`));
      if (endStand.length === 0) {
        findings.push({
          code: 'CONSUMPTION_READING_MISSING',
          severity: 'blocker',
          message: `Zähler ${meter.meter_number} hat keinen Stand bis zum Periodenende — `
            + `Kostenart "${rule.category_code}" wird nach Verbrauch verteilt und ist ohne diesen Stand nicht rechenbar`,
          details: { meter_id: meter.id, meter_number: meter.meter_number, category: rule.category_code },
        });
        continue;
      }

      if (anfangsStaende.has(meter.id)) continue;

      const startBelegt = meter.initial_reading != null
        && (!meter.installed_at || new Date(meter.installed_at) <= new Date(`${year}-01-01`));

      findings.push(startBelegt
        ? {
          code: 'CONSUMPTION_START_ASSUMED_ZERO',
          severity: 'warning',
          message: `Zähler ${meter.meter_number} hat keinen Anfangsstand im Zeitraum; gerechnet wird `
            + `mit dem hinterlegten Anfangswert ${meter.initial_reading}`,
          details: { meter_id: meter.id, meter_number: meter.meter_number, initial_reading: meter.initial_reading },
        }
        : {
          code: 'CONSUMPTION_READING_MISSING',
          severity: 'blocker',
          message: `Zähler ${meter.meter_number} hat weder einen Anfangsstand im Zeitraum noch einen `
            + `hinterlegten Anfangswert — Kostenart "${rule.category_code}" ist nicht rechenbar`,
          details: { meter_id: meter.id, meter_number: meter.meter_number, category: rule.category_code },
        });
    }
  }

  // 15. MISSING_INTERIM_READING_FOR_CHANGEOVER
  const { rows: wechselVertraege } = await dbQuery(
    `SELECT l.id, l.lease_number, l.unit_id, l.end_date, l.actual_move_out, u.code AS unit_code
       FROM leases l JOIN units u ON l.unit_id = u.id
      WHERE u.property_id = $1
        AND (l.end_date BETWEEN $2 AND $3 OR l.actual_move_out BETWEEN $2 AND $3)`,
    [propertyId, `${year}-01-01`, `${year}-12-31`]
  );
  for (const f of zwischenablesungFehlt(wechselVertraege as any, meters as any, readings as any)) {
    findings.push(f);
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

  const usesPersonKey = allocRules.some((r: any) => r.key_type === 'persons');
  return makeResult(propertyId, prop.code, year, findings, usesPersonKey);
}

function makeResult(
  propertyId: number,
  propertyCode: string,
  year: number,
  findings: PreCheckFinding[],
  usesPersonKey = false,
): PreCheckResult {
  const blocking_count = findings.filter(f => f.severity === 'blocker').length;
  const warning_count = findings.filter(f => f.severity === 'warning').length;
  const info_count = findings.filter(f => f.severity === 'info').length;

  return {
    property_id: propertyId,
    property_code: propertyCode,
    year,
    ready: blocking_count === 0,
    uses_person_key: usesPersonKey,
    blocking_count,
    warning_count,
    info_count,
    findings,
  };
}

/**
 * Wärmemengenzähler ohne belegten Anfangsstand.
 *
 * Reine Funktion, damit die Regel ohne Datenbank prüfbar ist — sie entscheidet
 * über eine Sperre und muss deshalb an ihren Grenzfällen nachweisbar richtig
 * sein.
 *
 * Zwei Fälle gelten als belegt und lösen KEINE Sperre aus:
 *   - eine Ablesung am oder vor dem Periodenbeginn,
 *   - ein im Zeitraum eingebauter Zähler mit hinterlegtem Anfangswert.
 */
export function waermezaehlerOhneAnfangsstand(
  meters: { id: number; medium: string; meter_number: string;
    installed_at?: string | Date | null; initial_reading?: number | string | null }[],
  readings: { meter_id: number; read_at: string | Date }[],
  year: number,
): PreCheckFinding[] {
  const beginn = new Date(`${year}-01-01T00:00:00Z`);
  const ende = new Date(`${year}-12-31T23:59:59Z`);
  const out: PreCheckFinding[] = [];

  for (const meter of meters) {
    if (meter.medium !== 'heat') continue;

    const standVorBeginn = readings.some(r =>
      r.meter_id === meter.id && new Date(r.read_at) <= beginn);
    if (standVorBeginn) continue;

    const eingebautImZeitraum = Boolean(meter.installed_at)
      && new Date(meter.installed_at as any) > beginn
      && new Date(meter.installed_at as any) <= ende;
    if (eingebautImZeitraum
      && meter.initial_reading !== null && meter.initial_reading !== undefined) {
      continue;
    }

    out.push({
      code: 'HEAT_METER_NO_DOCUMENTED_START',
      severity: 'blocker',
      message: `Wärmemengenzähler ${meter.meter_number} hat keinen belegten Anfangsstand `
        + `zum ${year}-01-01. Ohne ihn würde der gesamte Zählerstand seit Einbau als `
        + 'Verbrauch des Zeitraums abgerechnet.',
      details: { meter_id: meter.id, meter_number: meter.meter_number },
    });
  }
  return out;
}


/**
 * Mietverhältnisse, die im Zeitraum beginnen oder enden, ohne dass sich ihr
 * Anteil bestimmen lässt.
 *
 * Reine Funktion — die Sperre entscheidet über Geld und braucht prüfbare
 * Grenzfälle.
 */
export function nutzerwechselOhneAufteilung(
  leases: { id: number; unit_id: number; start_date: string | Date; end_date?: string | Date | null }[],
  units: { id: number; code: string }[],
  meters: { id: number; medium: string; unit_id?: number | null; is_main_meter?: boolean }[],
  readings: { meter_id: number; read_at: string | Date; value: number | string }[],
  year: number,
): PreCheckFinding[] {
  const periodStart = `${year}-01-01`;
  const periodEnd = `${year}-12-31`;
  const out: PreCheckFinding[] = [];

  for (const lease of leases) {
    const abschnitt = nutzungsAbschnitt(lease as any, periodStart, periodEnd);
    const unit = units.find(u => u.id === lease.unit_id);
    const code = unit?.code ?? String(lease.unit_id);

    if (!abschnitt) continue;  // läuft im Zeitraum gar nicht — kein Fall für § 9b
    const unterjaehrig = abschnitt.von !== periodStart || abschnitt.bis !== periodEnd;
    if (!unterjaehrig) continue;

    // Variante 1: Zwischenablesung an allen Wärmemengenzählern der Wohnung.
    const waermezaehler = meters.filter(
      m => m.medium === 'heat' && !m.is_main_meter && m.unit_id === lease.unit_id);
    const alleAbgelesen = waermezaehler.length > 0 && waermezaehler.every(
      m => findeEinzugsstand(m.id, isoTag(lease.start_date), readings as any) !== null);
    if (alleAbgelesen) continue;

    // Variante 2: Aufteilung nach § 9b Abs. 3.
    const gradtageZeitraum = gradtagsSumme(periodStart, periodEnd);
    const tageZeitraum = tageZwischen(periodStart, periodEnd);
    if (gradtageZeitraum > 0 && tageZeitraum > 0) continue;

    out.push({
      code: 'NUTZERWECHSEL_OHNE_AUFTEILUNG',
      severity: 'blocker',
      message: `Einheit ${code}: Das Mietverhältnis läuft nur von ${abschnitt.von} bis `
        + `${abschnitt.bis}. Es gibt weder eine Zwischenablesung zum Nutzerwechsel noch eine `
        + 'anwendbare Aufteilung nach § 9b Abs. 3 HeizkostenV.',
      details: { unit_code: code, von: abschnitt.von, bis: abschnitt.bis },
    });
  }
  return out;
}

/**
 * Wie weit darf die Zwischenablesung vom Nutzerwechsel entfernt liegen?
 *
 * Drei Tage. Enger als die sieben Tage, die eine ÜBERGABE vor dem
 * Mietbeginn haben darf (`EINZUGSSTAND_TOLERANZ_TAGE`): Dort geht es um einen
 * terminlichen Vorlauf, der zum Geschäft gehört. Hier geht es um den Schnitt
 * zwischen zwei Abrechnungen, und der soll auf dem Tag liegen.
 */
export const WECHSEL_TOLERANZ_TAGE = 3;

/**
 * Mietverhältnisse, die im Zeitraum enden, ohne Zwischenablesung am
 * Nutzerwechsel.
 *
 * KORREKTUR 12.10.2026. Die Regel verlangte bisher irgendeine Ablesung vom Typ
 * `move_out` an den Zählern der Wohnung — ohne Datum. Zwei Dinge waren daran
 * falsch:
 *
 *   1. **Der Tag fehlte.** Eine Ablesung vom Februar erfüllte die Regel für
 *      einen Auszug im November.
 *   2. **Der falsche Tag war gemeint.** Maßgeblich ist der Nutzerwechsel, also
 *      das VERTRAGSENDE — bis dahin trägt der Vormieter die Kosten. Bei N24 W6
 *      liegt die Übergabe am 15.11.2025, das Vertragsende am 30.11.2025; eine
 *      Ablesung zum 15.11. schneidet die Abrechnung an der falschen Stelle.
 *
 * Maßgeblich ist deshalb `end_date`; `actual_move_out` dient nur noch als
 * Ersatz, wenn kein Vertragsende erfasst ist, und bleibt im Übrigen eine
 * informative Angabe zum Übergabetermin.
 *
 * Als Zwischenablesung zählt JEDE Ablesung innerhalb der Toleranz, nicht nur
 * eine vom Typ `move_out`. Was zählt, ist der Stand an diesem Tag — nicht,
 * welches Etikett jemand beim Erfassen gewählt hat.
 */
export function zwischenablesungFehlt(
  vertraege: { id: number; lease_number?: string | null; unit_id: number;
    unit_code?: string | null; end_date?: string | Date | null;
    actual_move_out?: string | Date | null }[],
  meters: { id: number; unit_id?: number | null; meter_number: string }[],
  readings: { meter_id: number; read_at: string | Date }[],
  toleranzTage = WECHSEL_TOLERANZ_TAGE,
): PreCheckFinding[] {
  const out: PreCheckFinding[] = [];

  for (const v of vertraege) {
    const wechsel = v.end_date ? isoTag(v.end_date) : (v.actual_move_out ? isoTag(v.actual_move_out) : null);
    if (!wechsel) continue;

    const uebergabe = v.actual_move_out ? isoTag(v.actual_move_out) : null;
    const zusatz = uebergabe && uebergabe !== wechsel
      ? ` Die Wohnungsübergabe war am ${uebergabe}; für die Abrechnung zählt das `
        + 'Vertragsende, bis dahin trägt der Vormieter die Kosten.'
      : '';

    for (const meter of meters.filter(m => m.unit_id === v.unit_id)) {
      if (findeEinzugsstand(meter.id, wechsel, readings as any, toleranzTage)) continue;
      out.push({
        code: 'MISSING_INTERIM_READING_FOR_CHANGEOVER',
        severity: 'warning',
        message: `Zähler ${meter.meter_number}: keine Zwischenablesung zum Nutzerwechsel am `
          + `${wechsel} (± ${toleranzTage} Tage). § 9b Abs. 1 HeizkostenV verlangt sie; ohne `
          + 'sie wird der Verbrauch zwischen Vor- und Nachmieter aufgeteilt statt gemessen.'
          + zusatz,
        details: {
          lease_id: v.id, meter_id: meter.id, meter_number: meter.meter_number,
          unit_code: v.unit_code ?? null, wechsel, uebergabe,
        },
      });
    }
  }
  return out;
}
