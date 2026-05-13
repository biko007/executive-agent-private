/**
 * nk/types — Type definitions for the NK calculation engine.
 * Sprint 5.5b
 */

// ── Engine Output ────────────────────────────────────────────────────────────

export interface EngineOutput {
  run: RunMeta;
  statements: StatementResult[];
  warnings: EngineWarning[];
  excluded_leases: ExcludedLease[];
}

export interface RunMeta {
  property_id: number;
  property_code: string;
  period_year: number;
  period_start: string;   // YYYY-MM-DD
  period_end: string;     // YYYY-MM-DD
  total_days: number;
  engine_version: string;
  input_hash: string;
  computed_at: string;     // ISO timestamp
}

export interface EngineWarning {
  code: string;
  severity: 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

export interface ExcludedLease {
  lease_id: number;
  unit_id: number;
  unit_code: string;
  billing_mode: string;
  reason: string;
}

// ── Statement / Items ────────────────────────────────────────────────────────

export interface StatementResult {
  lease_id: number | null;
  is_owner_block: boolean;
  active_days: number;
  items: ItemResult[];
  costs_total: number;
  advance_total: number;
  balance: number;
  rounding_adjustment: number;
  tenant_recipients: TenantRecipient[] | null;
}

export interface ItemResult {
  item_type: 'regular' | 'vacancy_owner_share' | 'excluded_billing_mode' | 'rounding_adjustment';
  cost_category_id: number | null;
  allocation_rule_id: number | null;
  related_lease_id: number | null;
  total_property: number | null;
  allocation_basis: string | null;
  share_numerator: number | null;
  share_denominator: number | null;
  share_fraction: number | null;
  amount: number;
  rounding_remainder: number | null;
  source_booking_ids: number[];
  notes: string | null;
  metadata_jsonb: Record<string, unknown> | null;
}

// ── Recipient / Snapshot helpers ─────────────────────────────────────────────

export interface TenantRecipient {
  tenant_id: number;
  tenant_type: string;
  first_name: string | null;
  last_name: string;
  company_name: string | null;
  is_primary_contact: boolean;
  correspondence_address: CorrespondenceAddress | null;
}

export interface CorrespondenceAddress {
  street: string | null;
  postal_code: string | null;
  city: string | null;
  country: string | null;
}

export interface RecipientInfo {
  lease_id: number;
  recipients: TenantRecipient[];
}

// ── Engine Input (loaded from DB) ────────────────────────────────────────────

export interface EngineInput {
  property: PropertyRow;
  units: UnitRow[];
  leases: LeaseRow[];
  allocation_rules: AllocationRuleRow[];
  allocation_shares: AllocationShareRow[];
  expense_bookings: ExpenseBookingRow[];
  meters: MeterRow[];
  readings: MeterReadingRow[];
  unit_residents: UnitResidentRow[];
  heating_config: HeatingConfigRow | null;
  lease_charges: LeaseChargeRow[];
  tenants: TenantRow[];
  lease_tenants: LeaseTenantRow[];
}

export interface PropertyRow {
  id: number;
  code: string;
  name: string;
  street: string;
  postal_code: string;
  city: string;
  property_type: string;
  owner: string;
  ownership_end: string | null;
  heating_type: string | null;
  co2_cost_relevant: boolean;
}

export interface UnitRow {
  id: number;
  property_id: number;
  code: string;
  unit_type: string;
  living_area_qm: number | null;
  active: boolean;
}

export interface LeaseRow {
  id: number;
  unit_id: number;
  lease_type: string;
  status: string;
  start_date: string;
  end_date: string | null;
  actual_move_out: string | null;
  billing_mode: string;
  kaltmiete: number | null;
  nk_vorauszahlung: number | null;
  heizkosten_vorauszahlung: number | null;
}

export interface AllocationRuleRow {
  id: number;
  property_id: number;
  cost_category_id: number;
  key_type: string;
  valid_from: string;
  valid_until: string | null;
  category_code: string;
}

export interface AllocationShareRow {
  id: number;
  allocation_rule_id: number;
  unit_id: number;
  share_value: number;
  valid_from: string;
  valid_until: string | null;
}

export interface ExpenseBookingRow {
  id: number;
  property_id: number;
  cost_category_id: number;
  amount_gross: number;
  umlagefaehig: boolean;
  service_period_start: string;
  service_period_end: string;
  category_code: string;
}

export interface MeterRow {
  id: number;
  property_id: number | null;
  unit_id: number | null;
  medium: string;
  meter_number: string;
  is_main_meter: boolean;
  submetering_purpose: string | null;
  active: boolean;
}

export interface MeterReadingRow {
  id: number;
  meter_id: number;
  value: number;
  unit: string;
  reading_type: string;
  read_at: string;
  is_estimated: boolean;
}

export interface UnitResidentRow {
  id: number;
  unit_id: number;
  tenant_id: number;
  move_in: string;
  move_out: string | null;
  persons_count: number;
}

export interface HeatingConfigRow {
  id: number;
  property_id: number;
  year: number;
  heating_system: string;
  hot_water_via_heating: boolean;
  base_share_percent: number | null;
  consumption_share_percent: number | null;
  co2_emissions_kg: number | null;
  co2_cost_total: number | null;
  co2_tenant_share_percent: number | null;
}

export interface LeaseChargeRow {
  id: number;
  lease_id: number;
  charge_type: string;
  amount: number;
  valid_from: string;
  valid_until: string | null;
}

export interface TenantRow {
  id: number;
  tenant_type: string;
  first_name: string | null;
  last_name: string;
  company_name: string | null;
  address_street: string | null;
  address_postal_code: string | null;
  address_city: string | null;
  address_country: string | null;
}

export interface LeaseTenantRow {
  id: number;
  lease_id: number;
  tenant_id: number;
  is_primary_contact: boolean;
}

// ── Heating Types ────────────────────────────────────────────────────────────

export interface HeatingResult {
  items: ItemResult[];
  warnings: EngineWarning[];
}

export const ENGINE_VERSION = '1.0.0';
