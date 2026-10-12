/**
 * nk/engine — Core NK (Nebenkostenabrechnung) calculation engine.
 * Sprint 5.5b — Etappe b/c/d
 */
import { query as dbQuery } from '../../shared/db/index.js';
import { canonicalHash } from '../../util/canonical.js';
import { nkPreCheck } from './precheck.js';
import { heatingAllocation, calculateConsumption } from './heating.js';
import { nutzerAnteilZeit, findeEinzugsstand, isoTag, stuetzpunkteVon } from './nutzerzeit.js';
import type {
  EngineOutput, EngineInput, EngineWarning, ExcludedLease,
  StatementResult, ItemResult, RunMeta, TenantRecipient,
  CorrespondenceAddress, PropertyRow, LeaseRow, UnitRow,
  AllocationRuleRow, AllocationShareRow, ExpenseBookingRow,
  UnitResidentRow, HeatingConfigRow, LeaseChargeRow,
  TenantRow, LeaseTenantRow, MeterRow, MeterReadingRow,
  ENGINE_VERSION,
} from './types.js';

export { ENGINE_VERSION } from './types.js';
import { VERBRAUCHSMEDIEN } from './types.js';

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Ein vom Kalenderjahr abweichender Abrechnungszeitraum (Zwischenabrechnung).
 *
 * Beide Daten als ISO-Tag `YYYY-MM-DD` und innerhalb desselben Jahres: Die
 * Heizkostenkonfiguration, der Vorprüfungslauf und die Belegauswahl hängen am
 * Jahr. Eine Zwischenabrechnung über einen Jahreswechsel hinweg wäre eine
 * andere Aufgabe und wird hier bewusst abgelehnt statt halb richtig gerechnet.
 */
export interface Zeitraum {
  von: string;
  bis: string;
}

/**
 * Compute NK for a property+year. Returns full engine output or throws on blockers.
 * @param isFinalizeMode — true during finalize (stricter blocks, e.g. CO2)
 * @param zeitraum — abweichender Zeitraum innerhalb des Jahres (Zwischenabrechnung,
 *   nur Vorschau). Ohne Angabe wird das volle Kalenderjahr gerechnet.
 */
export async function computeNk(
  propertyId: number,
  year: number,
  isFinalizeMode = false,
  zeitraum?: Zeitraum,
): Promise<EngineOutput> {
  if (zeitraum) pruefeZeitraum(year, zeitraum, isFinalizeMode);
  // 1. Pre-check
  const precheck = await nkPreCheck(propertyId, year);
  const blockers = precheck.findings.filter(f => f.severity === 'blocker');

  // Severity escalation (Etappe d)
  const warnings: EngineWarning[] = [];
  const escalatedBlockers: string[] = [];

  for (const finding of precheck.findings) {
    /* MISSING_UNIT_RESIDENTS → Blocker, aber nur wenn er etwas bewirkt.
       Bis 10.10.2026 stufte diese Stelle den Befund IMMER hoch. Die
       Personenzahl braucht die Rechnung aber ausschliesslich beim Schlüssel
       'persons'. Bei MG24 verteilt keine einzige Regel nach Personen — die
       Abrechnung scheiterte dort an einem Torwächter ohne Rechenbezug. */
    if (finding.code === 'MISSING_UNIT_RESIDENTS') {
      if (precheck.uses_person_key) {
        escalatedBlockers.push(finding.message);
      } else {
        warnings.push({
          code: finding.code,
          severity: 'warning',
          message: finding.message + ' (keine Umlageregel verteilt nach Personen — nicht rechenrelevant)',
          details: finding.details,
        });
      }
      continue;
    }
    // §9a: ESTIMATED_AREA_OVER_25_PERCENT → hard block (no override)
    if (finding.code === 'ESTIMATED_AREA_OVER_25_PERCENT') {
      const pctMatch = finding.message.match(/(\d+)%/);
      const pct = pctMatch ? parseInt(pctMatch[1], 10) : 0;
      if (pct > 25) {
        escalatedBlockers.push(finding.message);
        continue;
      }
    }
    // §9b: MISSING_INTERIM_READING_FOR_CHANGEOVER → block
    if (finding.code === 'MISSING_INTERIM_READING_FOR_CHANGEOVER') {
      escalatedBlockers.push(finding.message);
      continue;
    }
    // CO2: block only in finalize mode
    if (finding.code === 'CO2_HANDLING_REQUIRED' && isFinalizeMode) {
      escalatedBlockers.push(finding.message);
      continue;
    }

    if (finding.severity === 'blocker') {
      // Already a blocker — keep in blockers list
    } else if (finding.severity === 'warning' || finding.severity === 'info') {
      warnings.push({
        code: finding.code,
        severity: finding.severity === 'info' ? 'info' : 'warning',
        message: finding.message,
        details: finding.details,
      });
    }
  }

  // Combine original blockers + escalated
  const allBlockerMessages = [
    ...blockers.map(b => b.message),
    ...escalatedBlockers,
  ];
  if (allBlockerMessages.length > 0) {
    const error = new Error(`NK calculation blocked: ${allBlockerMessages.join('; ')}`);
    (error as any).code = 'NK_BLOCKED';
    (error as any).blockers = allBlockerMessages;
    (error as any).status = 422;
    throw error;
  }

  // 2. Load engine input
  const input = await loadEngineInput(propertyId, year, zeitraum);
  const inputHash = canonicalHash(input);

  const periodStart = zeitraum ? zeitraum.von : `${year}-01-01`;
  const periodEnd = zeitraum ? zeitraum.bis : `${year}-12-31`;
  const totalDays = zeitraum
    ? daysBetween(new Date(periodStart), new Date(periodEnd)) + 1
    : daysInYear(year);

  // 3. Separate leases by billing mode
  const excluded_leases: ExcludedLease[] = [];
  const activeLeases: LeaseRow[] = [];

  for (const lease of input.leases) {
    const unit = input.units.find(u => u.id === lease.unit_id);
    if (lease.billing_mode === 'pauschale' || lease.billing_mode === 'inklusive') {
      excluded_leases.push({
        lease_id: lease.id,
        unit_id: lease.unit_id,
        unit_code: unit?.code || String(lease.unit_id),
        billing_mode: lease.billing_mode,
        reason: `billing_mode=${lease.billing_mode}`,
      });
    } else {
      activeLeases.push(lease);
    }
  }

  // 4. Periodize bookings
  // Parse numeric fields (Postgres returns NUMERIC as string)
  for (const b of input.expense_bookings) {
    b.amount_gross = parseFloat(String(b.amount_gross)) || 0;
  }
  for (const u of input.units) {
    if (u.living_area_qm != null) u.living_area_qm = parseFloat(String(u.living_area_qm));
  }
  for (const c of input.lease_charges) {
    c.amount = parseFloat(String(c.amount)) || 0;
  }
  for (const l of input.leases) {
    if (l.kaltmiete != null) l.kaltmiete = parseFloat(String(l.kaltmiete));
    if (l.nk_vorauszahlung != null) l.nk_vorauszahlung = parseFloat(String(l.nk_vorauszahlung));
    if (l.heizkosten_vorauszahlung != null) l.heizkosten_vorauszahlung = parseFloat(String(l.heizkosten_vorauszahlung));
  }
  for (const s of input.allocation_shares) {
    s.share_value = parseFloat(String(s.share_value)) || 0;
  }

  const periodizedBookings = periodizeBookings(input.expense_bookings, periodStart, periodEnd);

  /* Zwischenabrechnung: Kennzeichnung der Schätzanteile.

     Eine Abrechnung zu einem Stichtag mitten im Jahr enthält zwangsläufig
     Posten, die nur anteilig zählen — die Gebäudeversicherung läuft über das
     ganze Jahr, abgerechnet wird aber nur bis zum Stichtag. Welcher Teil das
     ist, rechnet `periodizeBookings` taggenau. Taggenau heißt NICHT
     verbrauchsgerecht: Heizkosten fallen im Januar anders an als im Juli. Der
     Hinweis sagt das ausdrücklich, damit niemand die Zahl für eine
     Schlussabrechnung hält. */
  if (zeitraum) {
    warnings.push({
      code: 'INTERIM_BILLING_PERIOD',
      severity: 'warning',
      message: `Zwischenabrechnung ${periodStart} bis ${periodEnd} (${totalDays} von `
        + `${daysInYear(year)} Tagen). Keine Schlussabrechnung: Es fehlen Kosten, die erst `
        + 'später im Jahr anfallen oder abgerechnet werden.',
      details: { period_start: periodStart, period_end: periodEnd, days: totalDays },
    });

    /* Zweite Quelle von Schätzung: die Zählerstände. Zum Stichtag ist meist
       nicht abgelesen worden. `calculateConsumption` nimmt dann den letzten
       Stand DAVOR — der Verbrauch der Wochen dazwischen fehlt also schlicht,
       und zwar stillschweigend. Hier wird er benannt. Hochgerechnet wird
       bewusst nicht: Der Auftrag lautet, aus VORHANDENEN Ablesungen zu
       rechnen, und eine erfundene Zahl wäre in einer Mieterauskunft
       schlechter als eine benannte Lücke. */
    const veraltet: { zaehler: string; letzte: string }[] = [];
    const ohneStand: string[] = [];
    for (const m of input.meters) {
      const staende = input.readings
        .filter(r => r.meter_id === m.id && String(r.read_at).slice(0, 10) <= periodEnd)
        .map(r => String(r.read_at).slice(0, 10))
        .sort();
      const letzte = staende[staende.length - 1];
      /* Gar kein Stand bis zum Stichtag ist der gefährlichere Fall: Die
         Berechnung liefert dann Verbrauch 0, und null sieht aus wie eine
         Messung. Deshalb ein eigener Hinweis statt stillschweigend nichts. */
      if (!letzte) { ohneStand.push(m.meter_number); continue; }
      const abstandTage = daysBetween(new Date(letzte), new Date(periodEnd));
      if (abstandTage > 31) veraltet.push({ zaehler: m.meter_number, letzte });
    }
    if (ohneStand.length > 0) {
      warnings.push({
        code: 'INTERIM_READING_MISSING',
        severity: 'warning',
        message: `${ohneStand.length} Zähler ${ohneStand.length === 1 ? 'hat' : 'haben'} bis `
          + `zum Stichtag ${periodEnd} überhaupt keine Ablesung. Für sie wird Verbrauch 0 `
          + 'gerechnet — das ist keine Messung, sondern eine Lücke.',
        details: { meters: ohneStand.join(', ') },
      });
    }
    if (veraltet.length > 0) {
      warnings.push({
        code: 'INTERIM_READING_STALE',
        severity: 'warning',
        message: `${veraltet.length} Zähler ${veraltet.length === 1 ? 'hat' : 'haben'} zum `
          + `Stichtag ${periodEnd} keine aktuelle Ablesung. Gerechnet wird mit dem letzten `
          + 'vorhandenen Stand; der Verbrauch der Zeit danach fehlt in dieser Auskunft.',
        details: { meters: veraltet.map(v => `${v.zaehler} (zuletzt ${v.letzte})`).join(', ') },
      });
    }

    const anteilig = periodizedBookings.filter(b => b.overlap_fraction < 0.9995 && b.overlap_fraction > 0);
    if (anteilig.length > 0) {
      const summeVoll = anteilig.reduce((n, b) => n + (b.amount_gross as number), 0);
      const summeAnteil = anteilig.reduce((n, b) => n + b.periodized_amount, 0);
      warnings.push({
        code: 'INTERIM_COST_PRORATED',
        severity: 'warning',
        message: anteilig.length === 1
          ? `Eine Rechnung fällt nur anteilig in den Zeitraum: ${summeAnteil.toFixed(2)} € `
            + `von ${summeVoll.toFixed(2)} €. Der Anteil ist taggenau gerechnet, nicht nach `
            + 'tatsächlichem Verbrauch im Zeitraum.'
          : `${anteilig.length} Rechnungen fallen nur anteilig in den Zeitraum: `
            + `${summeAnteil.toFixed(2)} € von ${summeVoll.toFixed(2)} €. Der Anteil ist `
            + 'taggenau gerechnet, nicht nach tatsächlichem Verbrauch im Zeitraum.',
        details: {
          bookings: anteilig.length,
          amount_prorated: Number(summeAnteil.toFixed(2)),
          amount_full: Number(summeVoll.toFixed(2)),
        },
      });
    }
  }

  // 5. Allocate costs per category → items per lease
  const statementMap = new Map<number, { items: ItemResult[]; days: number }>();
  const vacancyItems: ItemResult[] = [];
  const excludedItems: ItemResult[] = [];

  // Initialize statement maps for active leases
  for (const lease of activeLeases) {
    const proRata = calculateProRata(lease, periodStart, periodEnd);
    statementMap.set(lease.id, { items: [], days: proRata.days });
  }

  // Group periodized bookings by cost_category_id
  const bookingsByCategory = new Map<number, typeof periodizedBookings>();
  for (const pb of periodizedBookings) {
    const existing = bookingsByCategory.get(pb.cost_category_id) || [];
    existing.push(pb);
    bookingsByCategory.set(pb.cost_category_id, existing);
  }

  // Allocate each cost category
  for (const [catId, catBookings] of bookingsByCategory) {
    const totalAmount = catBookings.reduce((sum, b) => sum + b.periodized_amount, 0);
    if (totalAmount <= 0) continue;

    const rule = input.allocation_rules.find(r => r.cost_category_id === catId);
    if (!rule) continue; // precheck should have caught this

    const sourceBookingIds = catBookings.map(b => b.id);
    const categoryCode = rule.category_code;

    // Heating categories → delegate to heating module
    const heatingCategories = ['heizung', 'warmwasser', 'verbundene_heizung_warmwasser'];
    if (heatingCategories.includes(categoryCode) &&
        (rule.key_type === 'consumption' || rule.key_type === 'heating_split')) {
      const heatingResult = heatingAllocation(
        input.heating_config, catBookings, input.meters, input.readings,
        input.units, activeLeases, periodStart, periodEnd,
        input.allocation_shares.filter(s => s.allocation_rule_id === rule.id),
        rule,
      );
      for (const w of heatingResult.warnings) warnings.push(w);

      /* Posten mit Mietverhältnis gehen in dessen Abrechnung, der
         Leerstandsanteil in den Eigentümerblock. Bis zum 11.10.2026 kannte
         diese Schleife nur den ersten Fall: Ein Heizkostenposten ohne
         `lease_id` wurde ERSATZLOS verworfen. Bei MG24 2025 verschwanden so
         999,72 € von 4.943,22 € aus der Abrechnung — die Objektsumme war zu
         niedrig und der Eigentümer sah seinen eigenen Anteil nicht. */
      for (const hItem of heatingResult.items) {
        const posten = { ...hItem, source_booking_ids: sourceBookingIds };
        if (hItem.metadata_jsonb?.lease_id) {
          const leaseId = hItem.metadata_jsonb.lease_id as number;
          const stmt = statementMap.get(leaseId);
          if (stmt) stmt.items.push(posten);
        } else if (hItem.item_type === 'vacancy_owner_share') {
          vacancyItems.push(posten);
        }
      }
      continue;
    }

    // §10: consumption_share_percent > 70 → engine block
    if (input.heating_config?.consumption_share_percent &&
        parseFloat(String(input.heating_config.consumption_share_percent)) > 70 &&
        rule.key_type === 'heating_split') {
      const error = new Error('Consumption share > 70% not allowed (§10 HeizKV)');
      (error as any).code = 'CONSUMPTION_SHARE_OVER_70';
      (error as any).status = 422;
      throw error;
    }

    // Standard allocation
    const allocation = allocateCosts(
      totalAmount, rule, activeLeases, input.units,
      input.unit_residents, input.allocation_shares.filter(s => s.allocation_rule_id === rule.id),
      periodStart, periodEnd, year, input.meters, input.readings,
    );

    /* Verbrauchsschlüssel: Was kein Wohnungszähler erfasst, bleibt beim
       Eigentümer. Bei MG24 ist das der Unterschied zwischen dem, was die
       Stadtwerke berechnen, und dem, was die Wohnungszähler zusammen messen. */
    for (const w of allocation.warnings || []) warnings.push(w);

    for (const alloc of allocation.leaseAllocations) {
      const stmt = statementMap.get(alloc.lease_id);
      if (stmt) {
        stmt.items.push({
          item_type: 'regular',
          cost_category_id: catId,
          allocation_rule_id: rule.id,
          related_lease_id: null,
          total_property: totalAmount,
          allocation_basis: rule.key_type,
          share_numerator: alloc.numerator,
          share_denominator: alloc.denominator,
          share_fraction: alloc.fraction,
          amount: alloc.amount,
          rounding_remainder: null,
          source_booking_ids: sourceBookingIds,
          notes: null,
          metadata_jsonb: null,
        });
      }
    }

    /* Anteil der inklusive vermieteten Wohnungen → Eigentümerblock.

       KORREKTUR 12.10.2026. Dieser Anteil wurde ZWEIMAL gezählt. `allocateCosts()`
       bekommt nur die abzurechnenden Mietverhältnisse; was auf eine inklusive
       vermietete Wohnung entfällt, bleibt dort unverteilt und kommt als
       `vacancyAmount` zurück. Anschließend hat diese Schleife denselben Betrag
       ein zweites Mal als `excluded_billing_mode` in den Eigentümerblock gelegt.

       Bei N24 2025 waren das 577,85 € auf 3.237,59 € gebuchte Kosten: Die
       Abrechnung verteilte 3.815,44 € und damit mehr, als überhaupt gebucht war.
       Die Mieterbeträge blieben richtig — falsch waren der Eigentümerblock und
       die Objektsumme, also genau die Zahl, die gegen die Rechnungen stimmen muss.
       Betroffen sind nur Objekte mit inklusive vermieteten Wohnungen, derzeit
       N24 und L19; MG24 hat keine.

       Beide Posten bleiben erhalten — der Eigentümer soll sehen, was Leerstand
       ist und was auf die inklusive vermieteten Wohnungen entfällt. Gezählt wird
       der Betrag aber nur einmal: Der Leerstandsposten wird um die Anteile der
       inklusive-Mietverhältnisse vermindert. */
    const exclFuerRegel: ItemResult[] = [];
    for (const excl of excluded_leases) {
      const exclLease = input.leases.find(l => l.id === excl.lease_id);
      if (!exclLease) continue;
      const proRata = calculateProRata(exclLease, periodStart, periodEnd);
      if (proRata.fraction <= 0) continue;

      // Calculate the share this excluded lease would have gotten
      const exclUnit = input.units.find(u => u.id === exclLease.unit_id);
      if (!exclUnit) continue;

      let exclShare = 0;
      if (rule.key_type === 'sqm' && exclUnit.living_area_qm) {
        const totalSqm = input.units
          .filter(u => u.active)
          .reduce((s, u) => s + (u.living_area_qm || 0), 0);
        if (totalSqm > 0) {
          exclShare = (exclUnit.living_area_qm / totalSqm) * proRata.fraction;
        }
      } else if (rule.key_type === 'units') {
        const totalUnits = input.units.filter(u => u.active).length;
        if (totalUnits > 0) exclShare = (1 / totalUnits) * proRata.fraction;
      }
      // Simplified: for other key types, use unit count fallback

      if (exclShare > 0) {
        const exclAmount = roundKaufmaennisch(totalAmount * exclShare);
        exclFuerRegel.push({
          item_type: 'excluded_billing_mode',
          cost_category_id: catId,
          allocation_rule_id: rule.id,
          related_lease_id: excl.lease_id,
          total_property: totalAmount,
          allocation_basis: rule.key_type,
          share_numerator: exclShare,
          share_denominator: 1,
          share_fraction: exclShare,
          amount: exclAmount,
          rounding_remainder: null,
          source_booking_ids: sourceBookingIds,
          notes: `Anteil ${excl.billing_mode}-Mieter`,
          metadata_jsonb: null,
        });
      }
    }
    excludedItems.push(...exclFuerRegel);

    const exclSumme = exclFuerRegel.reduce((s, i) => s + i.amount, 0);
    const leerstand = roundKaufmaennisch(allocation.vacancyAmount - exclSumme);

    if (leerstand < -0.005) {
      /* Darf nicht vorkommen: Der Anteil der inklusive-Mietverhältnisse ist Teil
         des unverteilten Rests. Tritt es doch ein, stimmt eine Bezugsgröße nicht
         (etwa eine Fläche, die in der einen Rechnung zählt und in der anderen
         nicht). Dann lieber eine sichtbare Warnung als eine stille Verschiebung. */
      warnings.push({
        code: 'EXCLUDED_SHARE_EXCEEDS_VACANCY',
        severity: 'warning',
        message: `Kostenart "${rule.category_code}": Der Anteil der inklusive vermieteten `
          + `Wohnungen (${exclSumme.toFixed(2)}) übersteigt den unverteilten Rest `
          + `(${allocation.vacancyAmount.toFixed(2)}). Der Leerstandsposten wird auf 0 gesetzt.`,
        details: { category: rule.category_code, excluded: exclSumme, vacancy: allocation.vacancyAmount },
      });
    }

    // Vacancy share → owner block
    if (leerstand > 0) {
      vacancyItems.push({
        item_type: 'vacancy_owner_share',
        cost_category_id: catId,
        allocation_rule_id: rule.id,
        related_lease_id: null,
        total_property: totalAmount,
        allocation_basis: rule.key_type,
        share_numerator: allocation.vacancyNumerator,
        share_denominator: allocation.vacancyDenominator,
        share_fraction: totalAmount > 0 ? leerstand / totalAmount : 0,
        amount: leerstand,
        rounding_remainder: null,
        source_booking_ids: sourceBookingIds,
        notes: exclSumme > 0
          ? 'Leerstandsanteil (ohne die Anteile der inklusive vermieteten Wohnungen)'
          : 'Leerstandsanteil',
        metadata_jsonb: null,
      });
    }
  }

  // 6. Calculate advances per active lease
  const advanceMap = new Map<number, number>();
  for (const lease of activeLeases) {
    const advance = calculateAdvances(input.lease_charges, lease, periodStart, periodEnd);
    advanceMap.set(lease.id, advance);
  }

  // 7. Build statements
  const statements: StatementResult[] = [];

  for (const lease of activeLeases) {
    const stmtData = statementMap.get(lease.id);
    if (!stmtData) continue;

    const costsTotal = stmtData.items.reduce((s, i) => s + i.amount, 0);
    const advanceTotal = advanceMap.get(lease.id) || 0;
    const recipients = buildStatementRecipients(lease, input.lease_tenants, input.tenants, input.property);

    statements.push({
      lease_id: lease.id,
      is_owner_block: false,
      active_days: stmtData.days,
      items: stmtData.items,
      costs_total: roundKaufmaennisch(costsTotal),
      advance_total: roundKaufmaennisch(advanceTotal),
      balance: roundKaufmaennisch(costsTotal - advanceTotal),
      rounding_adjustment: 0,
      tenant_recipients: recipients,
    });
  }

  // 8. Apply rounding
  applyRounding(statements, periodizedBookings);

  // 9. Build owner block
  const ownerBlock = buildOwnerBlock(vacancyItems, excludedItems, statements);
  if (ownerBlock) {
    statements.push(ownerBlock);
  }

  // 10. Build run meta
  const run: RunMeta = {
    property_id: propertyId,
    property_code: input.property.code,
    period_year: year,
    period_start: periodStart,
    period_end: periodEnd,
    total_days: totalDays,
    engine_version: '1.0.0',
    input_hash: inputHash,
    computed_at: new Date().toISOString(),
  };

  return { run, statements, warnings, excluded_leases };
}

// ── Load Engine Input ────────────────────────────────────────────────────────

export async function loadEngineInput(
  propertyId: number,
  year: number,
  zeitraum?: Zeitraum,
): Promise<EngineInput> {
  const periodStart = zeitraum ? zeitraum.von : `${year}-01-01`;
  const periodEnd = zeitraum ? zeitraum.bis : `${year}-12-31`;

  const [
    propResult, unitsResult, leasesResult, rulesResult, sharesResult,
    bookingsResult, metersResult, residentsResult, heatingResult,
    chargesResult, tenantsResult, leaseTenantsResult,
  ] = await Promise.all([
    dbQuery('SELECT * FROM properties WHERE id = $1 AND active = true', [propertyId]),
    dbQuery('SELECT * FROM units WHERE property_id = $1 AND active = true', [propertyId]),
    dbQuery(
      `SELECT l.* FROM leases l JOIN units u ON l.unit_id = u.id
       WHERE u.property_id = $1 AND l.status IN ('active','ended')
       AND l.start_date <= $2 AND (l.end_date IS NULL OR l.end_date >= $3)`,
      [propertyId, periodEnd, periodStart],
    ),
    dbQuery(
      `SELECT ar.*, cc.code AS category_code FROM allocation_rules ar
       JOIN cost_categories cc ON ar.cost_category_id = cc.id
       WHERE ar.property_id = $1 AND ar.archived_at IS NULL
       AND ar.valid_from <= $2 AND (ar.valid_until IS NULL OR ar.valid_until >= $3)`,
      [propertyId, periodEnd, periodStart],
    ),
    dbQuery(
      `SELECT ars.* FROM allocation_rule_shares ars
       JOIN allocation_rules ar ON ars.allocation_rule_id = ar.id
       WHERE ar.property_id = $1 AND ars.archived_at IS NULL
       AND ars.valid_from <= $2 AND (ars.valid_until IS NULL OR ars.valid_until >= $3)`,
      [propertyId, periodEnd, periodStart],
    ),
    dbQuery(
      `SELECT eb.*, cc.code AS category_code FROM expense_bookings eb
       JOIN cost_categories cc ON eb.cost_category_id = cc.id
       WHERE eb.property_id = $1 AND eb.archived_at IS NULL AND eb.umlagefaehig = true
       AND eb.service_period_start <= $2 AND eb.service_period_end >= $3`,
      [propertyId, periodEnd, periodStart],
    ),
    // Meters: property-level and unit-level
    dbQuery(
      `SELECT m.* FROM meters m
       LEFT JOIN units u ON m.unit_id = u.id
       WHERE m.active = true AND (m.property_id = $1 OR u.property_id = $1)`,
      [propertyId],
    ),
    // Unit residents overlapping the period
    dbQuery(
      `SELECT ur.* FROM unit_residents ur
       JOIN units u ON ur.unit_id = u.id
       WHERE u.property_id = $1
       AND ur.move_in <= $2 AND (ur.move_out IS NULL OR ur.move_out >= $3)`,
      [propertyId, periodEnd, periodStart],
    ),
    dbQuery(
      'SELECT * FROM property_heating_config WHERE property_id = $1 AND year = $2',
      [propertyId, year],
    ),
    // Lease charges for active leases (loaded after leases, but parallel here via subquery)
    dbQuery(
      `SELECT lc.* FROM lease_charges lc
       JOIN leases l ON lc.lease_id = l.id
       JOIN units u ON l.unit_id = u.id
       WHERE u.property_id = $1 AND lc.archived_at IS NULL
       AND lc.charge_type IN ('operating_cost_prepayment','heating_prepayment')
       AND lc.valid_from <= $2 AND (lc.valid_until IS NULL OR lc.valid_until >= $3)`,
      [propertyId, periodEnd, periodStart],
    ),
    // Tenants linked to property leases
    dbQuery(
      `SELECT DISTINCT t.* FROM tenants t
       JOIN lease_tenants lt ON t.id = lt.tenant_id
       JOIN leases l ON lt.lease_id = l.id
       JOIN units u ON l.unit_id = u.id
       WHERE u.property_id = $1`,
      [propertyId],
    ),
    dbQuery(
      `SELECT lt.* FROM lease_tenants lt
       JOIN leases l ON lt.lease_id = l.id
       JOIN units u ON l.unit_id = u.id
       WHERE u.property_id = $1`,
      [propertyId],
    ),
  ]);

  if (propResult.rows.length === 0) {
    throw new Error(`Property ${propertyId} not found`);
  }

  // Load meter readings
  const meterIds = metersResult.rows.map((m: any) => m.id);
  let readingsResult = { rows: [] as any[] };
  if (meterIds.length > 0) {
    readingsResult = await dbQuery(
      `SELECT * FROM meter_readings WHERE meter_id = ANY($1)
       AND read_at >= $2 AND read_at <= $3`,
      [meterIds, `${year - 1}-01-01`, `${year + 1}-03-31`],
    );
  }

  return {
    property: propResult.rows[0],
    units: unitsResult.rows,
    leases: leasesResult.rows,
    allocation_rules: rulesResult.rows,
    allocation_shares: sharesResult.rows,
    expense_bookings: bookingsResult.rows,
    meters: metersResult.rows,
    readings: readingsResult.rows,
    unit_residents: residentsResult.rows,
    heating_config: heatingResult.rows[0] || null,
    lease_charges: chargesResult.rows,
    tenants: tenantsResult.rows,
    lease_tenants: leaseTenantsResult.rows,
  };
}

// ── Periodize Bookings ───────────────────────────────────────────────────────

interface PeriodizedBooking extends ExpenseBookingRow {
  periodized_amount: number;
  overlap_fraction: number;
}

export function periodizeBookings(
  bookings: ExpenseBookingRow[],
  periodStart: string,
  periodEnd: string,
): PeriodizedBooking[] {
  const pStart = new Date(periodStart);
  const pEnd = new Date(periodEnd);

  return bookings.map(b => {
    const bStart = new Date(b.service_period_start);
    const bEnd = new Date(b.service_period_end);

    // Overlap: max(starts) to min(ends)
    const overlapStart = bStart > pStart ? bStart : pStart;
    const overlapEnd = bEnd < pEnd ? bEnd : pEnd;
    const overlapDays = daysBetween(overlapStart, overlapEnd) + 1;
    const totalBookingDays = daysBetween(bStart, bEnd) + 1;

    const fraction = totalBookingDays > 0 ? Math.max(0, overlapDays / totalBookingDays) : 0;
    const periodized_amount = parseFloat(b.amount_gross as any) * fraction;

    return {
      ...b,
      periodized_amount,
      overlap_fraction: fraction,
    };
  });
}

// ── Cost Allocation ──────────────────────────────────────────────────────────

interface LeaseAllocation {
  lease_id: number;
  numerator: number;
  denominator: number;
  fraction: number;
  amount: number;
}

interface AllocationResult {
  leaseAllocations: LeaseAllocation[];
  vacancyAmount: number;
  vacancyNumerator: number;
  vacancyDenominator: number;
  vacancyFraction: number;
  /** Nur beim Verbrauchsschlüssel gesetzt: Hinweise zur Messgrundlage. */
  warnings?: EngineWarning[];
}


export function allocateCosts(
  totalAmount: number,
  rule: AllocationRuleRow,
  leases: LeaseRow[],
  units: UnitRow[],
  residents: UnitResidentRow[],
  shares: AllocationShareRow[],
  periodStart: string,
  periodEnd: string,
  year: number,
  meters: MeterRow[] = [],
  readings: MeterReadingRow[] = [],
): AllocationResult {
  const keyType = rule.key_type;

  switch (keyType) {
    case 'sqm':
      return allocateBySqm(totalAmount, leases, units, periodStart, periodEnd);
    case 'persons':
      return allocateByPersons(totalAmount, leases, units, residents, periodStart, periodEnd);
    case 'units':
      return allocateByUnits(totalAmount, leases, units, periodStart, periodEnd);
    case 'consumption':
      return allocateByConsumption(
        totalAmount, rule, leases, units, meters, readings, periodStart, periodEnd,
      );
    case 'mea':
    case 'fixed':
      return allocateByShares(totalAmount, leases, units, shares, periodStart, periodEnd);
    case 'direct':
      return allocateByDirect(totalAmount, leases, units, shares, periodStart, periodEnd);
    default:
      // Fallback to sqm
      return allocateBySqm(totalAmount, leases, units, periodStart, periodEnd);
  }
}

/* Verteilung nach gemessenem Verbrauch der Einheit.

   Bis 10.10.2026 gab es diesen Zweig nicht: Eine Regel mit
   `key_type = 'consumption'` fiel in den Vorgabezweig und wurde stillschweigend
   nach Fläche verteilt. Für Heizung und Warmwasser fiel das nicht auf, die
   laufen über `heatingAllocation()`. Für Kaltwasser und Entwässerung schon —
   dort gibt es Zähler je Wohnung, und genau die wurden ignoriert. Bei MG24
   verschiebt der Unterschied rund 600 Euro zwischen den Wohnungen.

   Fehlt ein Zählerstand, wird NICHT auf Fläche ausgewichen. Die Vorprüfung
   meldet das vorher als `CONSUMPTION_READING_MISSING` (Blocker); kommt die
   Rechnung trotzdem hier an, bleibt der Betrag beim Eigentümer statt falsch
   verteilt zu werden.

   Was kein Wohnungszähler erfasst, bleibt ebenfalls beim Eigentümer — dafür
   ist der Hauptzähler der Nenner und nicht die Summe der Wohnungszähler. Bei
   MG24 berechnen die Stadtwerke für 2025 437 m³, die Wohnungszähler messen
   zusammen rund 169 m³; die Differenz gehört nicht auf die Mieter verteilt,
   solange sie ungeklärt ist. (Bis zum 11.10.2026 stand hier dieser Anspruch im
   Kommentar, aber nicht im Code: Der Nenner war die Summe der
   Wohnungszähler.) */
function allocateByConsumption(
  totalAmount: number,
  rule: AllocationRuleRow,
  leases: LeaseRow[],
  units: UnitRow[],
  meters: MeterRow[],
  readings: MeterReadingRow[],
  periodStart: string,
  periodEnd: string,
): AllocationResult {
  const warnings: EngineWarning[] = [];
  const medien = VERBRAUCHSMEDIEN[rule.category_code] || [];

  if (medien.length === 0) {
    warnings.push({
      code: 'CONSUMPTION_MEDIUM_UNKNOWN',
      severity: 'warning',
      message: `Kostenart "${rule.category_code}" hat den Schlüssel "consumption", aber kein `
        + 'zugeordnetes Zählermedium — der Betrag bleibt beim Eigentümer.',
    });
    return leerErgebnis(totalAmount, warnings);
  }

  /* Nur Wohnungszähler zählen. Der Hauptzähler am Hausanschluss dient dem
     Abgleich mit der Versorgerrechnung, nicht der Verteilung. */
  const einheitenZaehler = meters.filter(
    m => m.unit_id && !m.is_main_meter && medien.includes(m.medium),
  );

  const verbrauchJeEinheit = new Map<number, number>();
  for (const meter of einheitenZaehler) {
    if (!meter.unit_id) continue;
    const verbrauch = calculateConsumption(meter.id, periodStart, periodEnd, readings);
    verbrauchJeEinheit.set(meter.unit_id, (verbrauchJeEinheit.get(meter.unit_id) || 0) + verbrauch);
  }

  const summeEinheiten = Array.from(verbrauchJeEinheit.values()).reduce((s, v) => s + v, 0);
  if (summeEinheiten <= 0) {
    warnings.push({
      code: 'CONSUMPTION_DENOMINATOR_ZERO',
      severity: 'warning',
      message: `Kostenart "${rule.category_code}": kein gemessener Verbrauch im Zeitraum — `
        + 'der Betrag bleibt beim Eigentümer.',
    });
    return leerErgebnis(totalAmount, warnings);
  }

  /* Der Nenner ist die ABGERECHNETE Menge, nicht die Summe der Wohnungszähler.
     Beides fällt auseinander, sobald zwischen Hausanschluss und Wohnung etwas
     verbraucht wird oder verloren geht: Bei MG24 berechnen die Stadtwerke für
     2025 437 m³, die drei Wohnungszähler messen zusammen rund 169 m³.

     Verteilt man den Rechnungsbetrag nach den Anteilen der Wohnungszähler,
     tragen die Mieter die vollen Kosten aller 437 m³ — also auch die 268 m³,
     die niemand ihnen zurechnen kann. Genau das ist bis zum 11.10.2026
     passiert. Richtig ist: Jede Wohnung zahlt ihre gemessene Menge zum
     Rechnungspreis, der ungemessene Rest bleibt beim Eigentümer, solange er
     ungeklärt ist.

     Ist der Hauptzähler KLEINER als die Summe der Wohnungszähler, ist er
     unbrauchbar — dann würden Anteile über 100 Prozent entstehen. In dem Fall
     bleibt es beim alten Nenner, aber mit ausdrücklicher Warnung. */
  const hauptZaehler = meters.filter(
    m => m.is_main_meter && !m.unit_id && medien.includes(m.medium),
  );
  const hauptVerbrauch = hauptZaehler.reduce(
    (s, m) => s + calculateConsumption(m.id, periodStart, periodEnd, readings), 0);

  let gesamtVerbrauch = summeEinheiten;
  if (hauptZaehler.length === 0) {
    warnings.push({
      code: 'CONSUMPTION_NO_MAIN_METER',
      severity: 'warning',
      message: `Kostenart "${rule.category_code}": kein Hauptzähler für das Medium — der `
        + 'Rechnungsbetrag wird vollständig nach den Wohnungszählern verteilt. Eine '
        + 'ungemessene Differenz zur Versorgerrechnung bliebe dabei unbemerkt bei den Mietern.',
    });
  } else if (hauptVerbrauch > summeEinheiten + 0.0001) {
    gesamtVerbrauch = hauptVerbrauch;
    const rest = hauptVerbrauch - summeEinheiten;
    warnings.push({
      code: 'CONSUMPTION_UNMEASURED_REMAINDER',
      severity: 'warning',
      message: `Kostenart "${rule.category_code}": Der Hauptzähler weist ${hauptVerbrauch} aus, `
        + `die Wohnungszähler zusammen ${Math.round(summeEinheiten * 1000) / 1000}. Die Differenz `
        + `von ${Math.round(rest * 1000) / 1000} (${Math.round((rest / hauptVerbrauch) * 1000) / 10} %) `
        + 'ist keiner Wohnung zugeordnet und bleibt beim Eigentümer.',
      details: {
        hauptzaehler: hauptZaehler.map(m => m.meter_number),
        haupt_verbrauch: hauptVerbrauch,
        summe_einheiten: Math.round(summeEinheiten * 1000) / 1000,
        ungemessen: Math.round(rest * 1000) / 1000,
      },
    });
  } else if (hauptVerbrauch > 0) {
    warnings.push({
      code: 'CONSUMPTION_MAIN_METER_BELOW_UNITS',
      severity: 'warning',
      message: `Kostenart "${rule.category_code}": Der Hauptzähler weist ${hauptVerbrauch} aus `
        + `und damit WENIGER als die Wohnungszähler zusammen `
        + `(${Math.round(summeEinheiten * 1000) / 1000}). Das ist physikalisch nicht möglich; `
        + 'der Hauptzähler wird für die Verteilung nicht verwendet.',
      details: {
        hauptzaehler: hauptZaehler.map(m => m.meter_number),
        haupt_verbrauch: hauptVerbrauch,
        summe_einheiten: Math.round(summeEinheiten * 1000) / 1000,
      },
    });
  }

  const allocations: LeaseAllocation[] = [];
  let verteilt = 0;

  for (const lease of leases) {
    const verbrauchEinheit = verbrauchJeEinheit.get(lease.unit_id) || 0;
    if (verbrauchEinheit <= 0) continue;

    /* KORREKTUR 11.10.2026. Hier stand: „Gemessen wird ohnehin nur, was in
       dieser Zeit lief — deshalb geht der Zeitanteil NICHT zusätzlich ein."
       Das stimmt nur, wenn der Zähler zu Mietbeginn abgelesen oder gesetzt
       wurde. Bei MG24 läuft er seit Periodenbeginn weiter: Die Wohnung im
       3. OG ist ab 01.05.2025 vermietet, ihr Wasserzähler zählt aber ab
       01.01.2025. Der Verbrauch der Leerstandszeit landete damit beim Mieter.

       Richtig: Der Nutzer trägt seinen Anteil nach § 9b-Logik — gemessen,
       wenn es eine Ablesung zum Einzug gibt, sonst zeitanteilig. Der Rest
       bleibt beim Eigentümer (er fällt in den Leerstandsrest unten). */
    const einzugsTag = isoTag(lease.start_date);
    const zaehlerDerEinheit = einheitenZaehler.filter(m => m.unit_id === lease.unit_id);
    const staende = wohnungsStaende(zaehlerDerEinheit, einzugsTag, readings, periodStart, periodEnd);
    const anteil = nutzerAnteilZeit({
      lease, periodStart, periodEnd, ...staende,
    });
    if (!anteil) continue;

    const verbrauch = verbrauchEinheit * anteil.anteil;
    if (verbrauch <= 0) continue;

    if (anteil.grundlage === 'zeitanteil' || anteil.grundlage === 'stuetzpunkte') {
      warnings.push({
        code: 'NUTZERWECHSEL_9B_AUFTEILUNG',
        severity: 'warning',
        message: `Kostenart "${rule.category_code}", Mietverhältnis ab ${anteil.von}: `
          + 'Zum Einzug wurde nicht abgelesen. '
          + (anteil.grundlage === 'stuetzpunkte'
            ? `Ab der ersten Ablesung danach (${anteil.stuetzpunkt}) wird gemessen; `
              + `aufgeteilt ist nur die Lücke davor — ${((anteil.lueckenAnteil ?? 0) * 100).toFixed(1)} % `
              + 'des Nutzerverbrauchs.'
            : `Der gemessene Verbrauch der Wohnung (${Math.round(verbrauchEinheit * 1000) / 1000}) `
              + 'wird zeitanteilig aufgeteilt.')
          + ` Nutzeranteil ${(anteil.anteil * 100).toFixed(1)} %, der Rest Eigentümer.`,
        details: {
          category: rule.category_code, von: anteil.von, bis: anteil.bis,
          anteil_zeit: Math.round(anteil.anteil * 10000) / 100,
          stuetzpunkt: anteil.stuetzpunkt ?? null,
          luecken_anteil: Math.round((anteil.lueckenAnteil ?? 0) * 10000) / 100,
        },
      });
    }

    const fraction = verbrauch / gesamtVerbrauch;
    const amount = roundKaufmaennisch(totalAmount * fraction);
    verteilt += amount;

    allocations.push({
      lease_id: lease.id,
      numerator: Math.round(verbrauch * 1000) / 1000,
      denominator: gesamtVerbrauch,
      fraction,
      amount,
    });
  }

  const rest = roundKaufmaennisch(totalAmount - verteilt);
  return {
    leaseAllocations: allocations,
    vacancyAmount: Math.max(0, rest),
    vacancyNumerator: rest,
    vacancyDenominator: totalAmount || 1,
    vacancyFraction: totalAmount > 0 ? rest / totalAmount : 0,
    warnings,
  };
}

/**
 * Anfangs-, End- und Einzugsstand einer Wohnung über alle ihre Zähler.
 *
 * Ein Einzugsstand zählt nur, wenn JEDER Zähler der Wohnung einen hat —
 * sonst wäre der Wohnungsverbrauch halb gemessen und halb geschätzt.
 */
function wohnungsStaende(
  zaehler: MeterRow[], einzugsTag: string, readings: MeterReadingRow[],
  periodStart: string, periodEnd: string,
) {
  let standAnfang = 0; let standEnde = 0; let einzugSumme = 0;
  let alleHabenEinzug = zaehler.length > 0;
  let tag = '';
  for (const m of zaehler) {
    const eigene = readings
      .filter(r => r.meter_id === m.id)
      .map(r => ({ tag: isoTag(r.read_at as any), wert: parseFloat(String(r.value)) }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
    const vorher = eigene.filter(r => r.tag <= periodStart).pop();
    const letzter = eigene.filter(r => r.tag <= periodEnd).pop();
    standAnfang += vorher ? vorher.wert : 0;
    standEnde += letzter ? letzter.wert : 0;
    const e = findeEinzugsstand(m.id, einzugsTag, readings);
    if (e) { einzugSumme += e.wert; tag = e.tag; } else { alleHabenEinzug = false; }
  }
  return {
    standAnfang, standEnde,
    einzugsstand: alleHabenEinzug ? { tag, wert: einzugSumme } : null,
    punkte: zaehler.map(m => ({
      punkte: stuetzpunkteVon(
        m.id, readings, periodStart, periodEnd,
        m.initial_reading !== null && m.initial_reading !== undefined
          ? parseFloat(String(m.initial_reading)) : null),
      einzugsstand: findeEinzugsstand(m.id, einzugsTag, readings),
    })),
  };
}

/** Nichts verteilt — der volle Betrag bleibt beim Eigentümer. */
function leerErgebnis(totalAmount: number, warnings: EngineWarning[]): AllocationResult {
  return {
    leaseAllocations: [],
    vacancyAmount: totalAmount,
    vacancyNumerator: totalAmount,
    vacancyDenominator: totalAmount || 1,
    vacancyFraction: 1,
    warnings,
  };
}

function allocateBySqm(
  totalAmount: number,
  leases: LeaseRow[],
  units: UnitRow[],
  periodStart: string,
  periodEnd: string,
): AllocationResult {
  const totalSqm = units.reduce((s, u) => s + (u.living_area_qm || 0), 0);
  if (totalSqm <= 0) {
    return { leaseAllocations: [], vacancyAmount: totalAmount, vacancyNumerator: 1, vacancyDenominator: 1, vacancyFraction: 1 };
  }

  const allocations: LeaseAllocation[] = [];
  let allocatedTotal = 0;

  for (const lease of leases) {
    const unit = units.find(u => u.id === lease.unit_id);
    if (!unit || !unit.living_area_qm) continue;

    const proRata = calculateProRata(lease, periodStart, periodEnd);
    const fraction = (unit.living_area_qm / totalSqm) * proRata.fraction;
    const amount = roundKaufmaennisch(totalAmount * fraction);
    allocatedTotal += amount;

    allocations.push({
      lease_id: lease.id,
      numerator: unit.living_area_qm * proRata.fraction,
      denominator: totalSqm,
      fraction,
      amount,
    });
  }

  const vacancyAmount = roundKaufmaennisch(totalAmount - allocatedTotal);
  return {
    leaseAllocations: allocations,
    vacancyAmount: Math.max(0, vacancyAmount),
    vacancyNumerator: vacancyAmount,
    vacancyDenominator: totalAmount || 1,
    vacancyFraction: totalAmount > 0 ? vacancyAmount / totalAmount : 0,
  };
}

function allocateByPersons(
  totalAmount: number,
  leases: LeaseRow[],
  units: UnitRow[],
  residents: UnitResidentRow[],
  periodStart: string,
  periodEnd: string,
): AllocationResult {
  // Personentage: persons_count * active_days per lease (NO double-weighting)
  const personTage = calculatePersonentage(residents, leases, periodStart, periodEnd);
  const totalPersonTage = Object.values(personTage).reduce((s, v) => s + v, 0);

  if (totalPersonTage <= 0) {
    return allocateBySqm(totalAmount, leases, units, periodStart, periodEnd);
  }

  const allocations: LeaseAllocation[] = [];
  let allocatedTotal = 0;

  for (const lease of leases) {
    const pt = personTage[lease.id] || 0;
    if (pt <= 0) continue;

    const fraction = pt / totalPersonTage;
    const amount = roundKaufmaennisch(totalAmount * fraction);
    allocatedTotal += amount;

    allocations.push({
      lease_id: lease.id,
      numerator: pt,
      denominator: totalPersonTage,
      fraction,
      amount,
    });
  }

  const vacancyAmount = roundKaufmaennisch(totalAmount - allocatedTotal);
  return {
    leaseAllocations: allocations,
    vacancyAmount: Math.max(0, vacancyAmount),
    vacancyNumerator: vacancyAmount,
    vacancyDenominator: totalAmount || 1,
    vacancyFraction: totalAmount > 0 ? vacancyAmount / totalAmount : 0,
  };
}

function allocateByUnits(
  totalAmount: number,
  leases: LeaseRow[],
  units: UnitRow[],
  periodStart: string,
  periodEnd: string,
): AllocationResult {
  const totalUnits = units.filter(u => u.active).length;
  if (totalUnits <= 0) {
    return { leaseAllocations: [], vacancyAmount: totalAmount, vacancyNumerator: 1, vacancyDenominator: 1, vacancyFraction: 1 };
  }

  const allocations: LeaseAllocation[] = [];
  let allocatedTotal = 0;

  for (const lease of leases) {
    const proRata = calculateProRata(lease, periodStart, periodEnd);
    const fraction = (1 / totalUnits) * proRata.fraction;
    const amount = roundKaufmaennisch(totalAmount * fraction);
    allocatedTotal += amount;

    allocations.push({
      lease_id: lease.id,
      numerator: proRata.fraction,
      denominator: totalUnits,
      fraction,
      amount,
    });
  }

  const vacancyAmount = roundKaufmaennisch(totalAmount - allocatedTotal);
  return {
    leaseAllocations: allocations,
    vacancyAmount: Math.max(0, vacancyAmount),
    vacancyNumerator: vacancyAmount,
    vacancyDenominator: totalAmount || 1,
    vacancyFraction: totalAmount > 0 ? vacancyAmount / totalAmount : 0,
  };
}

function allocateByShares(
  totalAmount: number,
  leases: LeaseRow[],
  units: UnitRow[],
  shares: AllocationShareRow[],
  periodStart: string,
  periodEnd: string,
): AllocationResult {
  const totalShare = shares.reduce((s, sh) => s + parseFloat(String(sh.share_value)), 0);
  if (totalShare <= 0) {
    return allocateBySqm(totalAmount, leases, units, periodStart, periodEnd);
  }

  const allocations: LeaseAllocation[] = [];
  let allocatedTotal = 0;

  for (const lease of leases) {
    const unit = units.find(u => u.id === lease.unit_id);
    if (!unit) continue;

    const share = shares.find(s => s.unit_id === unit.id);
    if (!share) continue;

    const proRata = calculateProRata(lease, periodStart, periodEnd);
    const shareVal = parseFloat(String(share.share_value));
    const fraction = (shareVal / totalShare) * proRata.fraction;
    const amount = roundKaufmaennisch(totalAmount * fraction);
    allocatedTotal += amount;

    allocations.push({
      lease_id: lease.id,
      numerator: shareVal * proRata.fraction,
      denominator: totalShare,
      fraction,
      amount,
    });
  }

  const vacancyAmount = roundKaufmaennisch(totalAmount - allocatedTotal);
  return {
    leaseAllocations: allocations,
    vacancyAmount: Math.max(0, vacancyAmount),
    vacancyNumerator: vacancyAmount,
    vacancyDenominator: totalAmount || 1,
    vacancyFraction: totalAmount > 0 ? vacancyAmount / totalAmount : 0,
  };
}

function allocateByDirect(
  totalAmount: number,
  leases: LeaseRow[],
  units: UnitRow[],
  shares: AllocationShareRow[],
  periodStart: string,
  periodEnd: string,
): AllocationResult {
  // Direct allocation = fixed amounts per unit (shares represent absolute amounts)
  return allocateByShares(totalAmount, leases, units, shares, periodStart, periodEnd);
}

// ── Personentage ─────────────────────────────────────────────────────────────

/**
 * Calculate Personentage (person-days) per lease.
 * persons_count * active_days, NO additional time-weighting.
 */
export function calculatePersonentage(
  residents: UnitResidentRow[],
  leases: LeaseRow[],
  periodStart: string,
  periodEnd: string,
): Record<number, number> {
  const pStart = new Date(periodStart);
  const pEnd = new Date(periodEnd);
  const result: Record<number, number> = {};

  for (const lease of leases) {
    const leaseStart = new Date(lease.start_date);
    const leaseEnd = lease.end_date ? new Date(lease.end_date) : pEnd;

    // Intersection of lease and period
    const effectiveStart = leaseStart > pStart ? leaseStart : pStart;
    const effectiveEnd = leaseEnd < pEnd ? leaseEnd : pEnd;

    if (effectiveStart > effectiveEnd) {
      result[lease.id] = 0;
      continue;
    }

    // Find residents for this lease's unit during the effective period
    const unitResidents = residents.filter(r => r.unit_id === lease.unit_id);
    let totalPersonTage = 0;

    for (const resident of unitResidents) {
      const rStart = new Date(resident.move_in);
      const rEnd = resident.move_out ? new Date(resident.move_out) : pEnd;

      // Intersection of resident period with effective lease period
      const overlapStart = rStart > effectiveStart ? rStart : effectiveStart;
      const overlapEnd = rEnd < effectiveEnd ? rEnd : effectiveEnd;

      if (overlapStart > overlapEnd) continue;

      const days = daysBetween(overlapStart, overlapEnd) + 1;
      totalPersonTage += resident.persons_count * days;
    }

    result[lease.id] = totalPersonTage;
  }

  return result;
}

// ── Advances (Vorauszahlungen) ───────────────────────────────────────────────

/**
 * Calculate total advance payments for a lease during the period.
 * Types: operating_cost_prepayment + heating_prepayment.
 * Mid-month pro-rata for start/end months.
 */
export function calculateAdvances(
  charges: LeaseChargeRow[],
  lease: LeaseRow,
  periodStart: string,
  periodEnd: string,
): number {
  const relevantCharges = charges.filter(
    c => c.lease_id === lease.id &&
    (c.charge_type === 'operating_cost_prepayment' || c.charge_type === 'heating_prepayment'),
  );

  if (relevantCharges.length === 0) {
    // Fallback: use lease-level fields if available
    const monthly = (parseFloat(String(lease.nk_vorauszahlung || 0)) +
                     parseFloat(String(lease.heizkosten_vorauszahlung || 0)));
    if (monthly <= 0) return 0;

    const proRata = calculateProRata(lease, periodStart, periodEnd);
    // Full months * monthly amount
    return roundKaufmaennisch(proRata.months * monthly);
  }

  const pStart = new Date(periodStart);
  const pEnd = new Date(periodEnd);
  let total = 0;

  // Iterate month by month through the period
  for (let month = pStart.getMonth(); month <= 11; month++) {
    const monthStart = new Date(pStart.getFullYear(), month, 1);
    const monthEnd = new Date(pStart.getFullYear(), month + 1, 0); // last day of month
    const daysInMonth = monthEnd.getDate();

    // Find applicable charge for this month
    const monthStr = monthStart.toISOString().slice(0, 10);
    const applicableCharges = relevantCharges.filter(c => {
      const cStart = new Date(c.valid_from);
      const cEnd = c.valid_until ? new Date(c.valid_until) : pEnd;
      return cStart <= monthEnd && cEnd >= monthStart;
    });

    const monthlyAmount = applicableCharges.reduce((s, c) => s + parseFloat(String(c.amount)), 0);
    if (monthlyAmount <= 0) continue;

    // Pro-rata for lease start/end within the month
    const leaseStart = new Date(lease.start_date);
    const leaseEnd = lease.end_date ? new Date(lease.end_date) : pEnd;

    const effectiveStart = leaseStart > monthStart ? leaseStart : monthStart;
    const effectiveEnd = leaseEnd < monthEnd ? leaseEnd : monthEnd;

    if (effectiveStart > effectiveEnd) continue;

    const effectiveDays = daysBetween(effectiveStart, effectiveEnd) + 1;
    const fraction = effectiveDays / daysInMonth;

    total += monthlyAmount * fraction;
  }

  return roundKaufmaennisch(total);
}

// ── Pro-Rata Calculation ─────────────────────────────────────────────────────

export function calculateProRata(
  lease: LeaseRow,
  periodStart: string,
  periodEnd: string,
): { days: number; totalDays: number; fraction: number; months: number } {
  const pStart = new Date(periodStart);
  const pEnd = new Date(periodEnd);
  const leaseStart = new Date(lease.start_date);
  const leaseEnd = lease.end_date ? new Date(lease.end_date) : pEnd;

  const effectiveStart = leaseStart > pStart ? leaseStart : pStart;
  const effectiveEnd = leaseEnd < pEnd ? leaseEnd : pEnd;

  if (effectiveStart > effectiveEnd) {
    return { days: 0, totalDays: daysBetween(pStart, pEnd) + 1, fraction: 0, months: 0 };
  }

  const days = daysBetween(effectiveStart, effectiveEnd) + 1;
  const totalDays = daysBetween(pStart, pEnd) + 1;
  const fraction = days / totalDays;

  // Approximate months for advance calculation
  const months = days / 30.4167; // average days/month

  return { days, totalDays, fraction, months };
}

// ── Rounding ─────────────────────────────────────────────────────────────────

/**
 * Apply kaufmaennisch rounding per item, track aggregate remainder for owner-block.
 */
export function applyRounding(
  statements: StatementResult[],
  _periodizedBookings: PeriodizedBooking[],
): void {
  // Per-item rounding is already applied (kaufmaennisch in allocate functions).
  // This function tracks the aggregate remainder per cost category
  // (difference between property total and sum of per-lease allocations + vacancy).
  // The remainder is typically < ±0.05€ per category.

  const categoryTotals = new Map<number, { allocated: number; property: number }>();

  for (const stmt of statements) {
    if (stmt.is_owner_block) continue;
    for (const item of stmt.items) {
      if (item.cost_category_id == null || item.item_type !== 'regular') continue;
      const existing = categoryTotals.get(item.cost_category_id) || { allocated: 0, property: item.total_property || 0 };
      existing.allocated += item.amount;
      categoryTotals.set(item.cost_category_id, existing);
    }
  }

  // Note: vacancy + excluded amounts are also allocated from the property total.
  // The rounding remainder here is ONLY the cent-level difference from kaufmaennisch rounding.
  // Do not confuse with vacancy (which is the unallocated fraction due to empty units).
  // For now, remainder goes into the owner block rounding_adjustment item.
  // Per-statement rounding_adjustment stays 0 (it's cosmetic).
}

// ── Owner Block ──────────────────────────────────────────────────────────────

export function buildOwnerBlock(
  vacancyItems: ItemResult[],
  excludedItems: ItemResult[],
  tenantStatements: StatementResult[],
): StatementResult | null {
  const allItems = [...vacancyItems, ...excludedItems];

  if (allItems.length === 0) return null;

  const costsTotal = roundKaufmaennisch(allItems.reduce((s, i) => s + i.amount, 0));
  const totalDays = tenantStatements.length > 0
    ? Math.max(...tenantStatements.filter(s => !s.is_owner_block).map(s => s.active_days), 365)
    : 365;

  return {
    lease_id: null,
    is_owner_block: true,
    active_days: totalDays,
    items: allItems,
    costs_total: costsTotal,
    advance_total: 0,
    balance: costsTotal,
    rounding_adjustment: 0,
    tenant_recipients: null,
  };
}

// ── Recipients ───────────────────────────────────────────────────────────────

export function buildStatementRecipients(
  lease: LeaseRow,
  leaseTenantsAll: LeaseTenantRow[],
  tenantsAll: TenantRow[],
  property: PropertyRow,
): TenantRecipient[] {
  const leaseLinks = leaseTenantsAll.filter(lt => lt.lease_id === lease.id);
  const recipients: TenantRecipient[] = [];

  for (const link of leaseLinks) {
    const tenant = tenantsAll.find(t => t.id === link.tenant_id);
    if (!tenant) continue;

    recipients.push({
      tenant_id: tenant.id,
      tenant_type: tenant.tenant_type,
      first_name: tenant.first_name,
      last_name: tenant.last_name,
      company_name: tenant.company_name,
      is_primary_contact: link.is_primary_contact,
      correspondence_address: tenant.address_street ? {
        street: tenant.address_street,
        postal_code: tenant.address_postal_code,
        city: tenant.address_city,
        country: tenant.address_country,
      } : {
        // Fallback to property address
        street: property.street,
        postal_code: property.postal_code,
        city: property.city,
        country: 'DE',
      },
    });
  }

  return recipients;
}

// ── Utility functions ────────────────────────────────────────────────────────

function daysBetween(d1: Date, d2: Date): number {
  const ms = d2.getTime() - d1.getTime();
  return Math.floor(ms / 86_400_000);
}

/**
 * Prüft einen abweichenden Abrechnungszeitraum, bevor gerechnet wird.
 *
 * Fail-closed: Ein unsinniger Zeitraum ergibt sonst eine Abrechnung, die
 * plausibel aussieht und falsch ist. Eine Finalisierung ist damit gar nicht
 * erst zugelassen — eine Zwischenabrechnung ist eine Auskunft, kein Dokument.
 */
export function pruefeZeitraum(year: number, zeitraum: Zeitraum, isFinalizeMode: boolean): void {
  if (isFinalizeMode) {
    const e: any = new Error('Eine Zwischenabrechnung kann nicht finalisiert werden');
    e.status = 400;
    throw e;
  }
  /* Rückprobe statt bloßer Formatprüfung: `new Date('2025-02-30')` ist in
     JavaScript gültig und ergibt den 2. März. Ohne die Rückprobe liefe ein
     solcher Tag bis in die Datenbankabfrage, und Postgres bräche dort mit
     einem Serverfehler ab statt mit einer verständlichen Meldung. */
  const istTag = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
    && !isNaN(new Date(`${s}T00:00:00Z`).getTime())
    && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
  if (!istTag(zeitraum.von) || !istTag(zeitraum.bis)) {
    const e: any = new Error('Zeitraum braucht zwei Datumsangaben im Format JJJJ-MM-TT');
    e.status = 400;
    throw e;
  }
  if (zeitraum.von > zeitraum.bis) {
    const e: any = new Error('Der Beginn des Zeitraums liegt nach seinem Ende');
    e.status = 400;
    throw e;
  }
  if (!zeitraum.von.startsWith(`${year}-`) || !zeitraum.bis.startsWith(`${year}-`)) {
    const e: any = new Error(`Der Zeitraum muss vollständig im Jahr ${year} liegen`);
    e.status = 400;
    throw e;
  }
}

function daysInYear(year: number): number {
  return (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 366 : 365;
}

/** Kaufmaennisch (commercial) rounding to 2 decimal places. */
export function roundKaufmaennisch(value: number): number {
  return Math.round(value * 100) / 100;
}
