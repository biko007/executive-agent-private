/**
 * assets/types — Domain types for the Assets (Immobilien) module.
 */

export type PropertyType = 'residential' | 'commercial';
export type OwnerEntity = 'personal' | 'laperlgmbh' | 'la_perla_gmbh';
export type RentType = 'permanent' | 'temporary' | 'vacant';

export interface Unit {
  id: string;          // e.g. "l19-w1"
  label: string;       // e.g. "EG links"
  floor: string;       // e.g. "EG", "OG", "1.OG"
  sqm: number | null;
  rentType: RentType;
  tenant: string;      // Name + contact
  lease: string | null; // lease ID reference
  currentRent: number | null; // Kaltmiete
}

export interface DistributionKey {
  id: string;          // e.g. "l19-miteigentumsanteil"
  label: string;       // e.g. "Miteigentumsanteil"
  values: Record<string, number>; // unitId → percentage
}

export interface Property {
  id: string;
  label: string;
  address: string;
  type: PropertyType;
  owner: OwnerEntity;
  purchasePrice?: number;
  units: Unit[];
  distributionKeys: DistributionKey[];
  createdAt: string;
  updatedAt: string;
}

export interface Lease {
  id: string;
  unitId: string;
  propertyId: string;
  tenant: string;
  startDate: string;
  endDate: string | null;
  rentNet: number;          // Kaltmiete
  operatingCosts: number;   // Vorauszahlung Nebenkosten
  depositAmount: number;
  linkedDocs: string[];
  createdAt: string;
  updatedAt: string;
}

export type CostCategory =
  | 'heizung' | 'wasser' | 'abwasser' | 'muell' | 'hausmeister'
  | 'versicherung' | 'grundsteuer' | 'allgemeinstrom' | 'aufzug';

export const COST_CATEGORIES: { key: CostCategory; label: string }[] = [
  { key: 'heizung', label: 'Heizung' },
  { key: 'wasser', label: 'Wasser' },
  { key: 'abwasser', label: 'Abwasser' },
  { key: 'muell', label: 'Müll' },
  { key: 'hausmeister', label: 'Hausmeister' },
  { key: 'versicherung', label: 'Versicherung' },
  { key: 'grundsteuer', label: 'Grundsteuer' },
  { key: 'allgemeinstrom', label: 'Allgemeinstrom' },
  { key: 'aufzug', label: 'Aufzug' },
];

export interface OperatingCosts {
  propertyId: string;
  year: number;
  distributionKeyId: string; // which key to use for splitting
  costs: Partial<Record<CostCategory, number>>;
  updatedAt: string;
}

export interface NkResult {
  unitId: string;
  unitLabel: string;
  tenant: string;
  share: number;          // %
  totalCost: number;      // anteilige Gesamtkosten
  prepaid: number;        // geleistete Vorauszahlungen (12 Monate)
  balance: number;        // + = Guthaben, - = Nachzahlung
  details: { category: string; amount: number }[];
}

// ── V023 Types ──────────────────────────────────────────────────────────────

export type LeaseStatus = 'draft' | 'active' | 'terminated' | 'ended' | 'unverified_legacy';
export type TenantType = 'person' | 'company';
export type MeterMedium = 'cold_water' | 'warm_water' | 'heat' | 'electricity' | 'gas';
export type ReadingType = 'annual' | 'move_in' | 'move_out' | 'interim' | 'automatic' | 'meter_reset';
export type HeatingSystem = 'central_gas' | 'central_oil' | 'district' | 'heat_pump' | 'electric' | 'none';
export type ChargeType = 'base_rent' | 'operating_cost_prepayment' | 'heating_prepayment' | 'garage_rent' | 'vat';
export type NkObligationStatus = 'pending' | 'data_collection' | 'calculation_ready' | 'review' | 'approved' | 'sent' | 'objection' | 'served';

export interface TenantRecord {
  id: number;
  tenantCode: string | null;
  tenantType: TenantType;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UnitResident {
  id: number;
  unitId: number;
  tenantId: number;
  moveIn: string;
  moveOut: string | null;
  personsCount: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeaseCharge {
  id: number;
  leaseId: number;
  chargeType: ChargeType;
  amount: number;
  vatRate: number | null;
  validFrom: string;
  validUntil: string | null;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface MeterRecord {
  id: number;
  scopeType: 'property' | 'unit';
  propertyId: number | null;
  unitId: number | null;
  medium: MeterMedium;
  meterNumber: string;
  provider: string | null;
  installedAt: string | null;
  removedAt: string | null;
  calibrationValidUntil: string | null;
  isMainMeter: boolean;
  parentMeterId: number | null;
  submeteringPurpose: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MeterReadingRecord {
  id: number;
  meterId: number;
  value: number;
  unit: string;
  readingType: ReadingType;
  periodStart: string | null;
  periodEnd: string | null;
  readAt: string;
  source: 'manual' | 'automatic';
  readerName: string | null;
  isEstimated: boolean;
  estimateMethod: string | null;
  estimateReason: string | null;
  notes: string | null;
  createdAt: string;
}

export interface PropertyHeatingConfig {
  id: number;
  propertyId: number;
  year: number;
  heatingSystem: HeatingSystem;
  hotWaterViaHeating: boolean;
  baseSharePercent: number | null;
  consumptionSharePercent: number | null;
  co2EmissionsKg: number | null;
  co2CostTotal: number | null;
  co2TenantSharePercent: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AllocationRuleRecord {
  id: number;
  propertyId: number;
  costCategoryId: number;
  keyType: string;
  baseSharePercent: number | null;
  consumptionSharePercent: number | null;
  validFrom: string;
  validUntil: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AllocationShareRecord {
  id: number;
  allocationRuleId: number;
  unitId: number;
  shareValue: number;
  validFrom: string;
  validUntil: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface ExpenseBookingRecord {
  id: number;
  sourceKey: string | null;
  propertyId: number;
  unitId: number | null;
  costCategoryId: number;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  paymentDate: string | null;
  amountGross: number;
  amountNet: number | null;
  vatAmount: number | null;
  vatRate: number | null;
  umlagefaehig: boolean;
  archivedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NkPeriodObligation {
  id: number;
  propertyId: number;
  year: number;
  unitId: number;
  leaseId: number;
  tenantId: number;
  status: NkObligationStatus;
  resultAmount: number | null;
  dueDate: string | null;
  servedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CostCategoryRecord {
  id: number;
  code: string;
  name: string;
  betrkv_reference: string | null;
  umlagefaehig_default: boolean;
  heating_cost_relevant: boolean;
  co2_relevant: boolean;
  active: boolean;
  sort_order: number | null;
}
