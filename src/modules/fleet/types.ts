/**
 * fleet/types — Domain types for the Fleet module.
 * Sprint 6c: DB row types added for Postgres-backed store.
 */

export type VehicleType = 'car' | 'bike' | 'boat';

export interface ServiceEntry {
  date: string;
  type: string;
  mileage?: number;
  cost?: number;
  workshop?: string;
  notes?: string;
  documentUrl?: string;
}

export interface VehicleDocument {
  id?: number;
  docType: string;
  title: string;
  url: string;
  notes?: string;
  createdAt?: string;
}

export interface Insurance {
  id?: number;
  provider: string;
  policyNumber?: string;
  type: string;
  validFrom?: string;
  validUntil?: string;
  annualCost?: number;
  status?: string;
}

export interface TuevRecord {
  id?: number;
  inspectionDate?: string;
  result?: 'pass' | 'conditional' | 'fail';
  nextDueDate?: string;
  mileageKm?: number;
  notes?: string;
  documentUrl?: string;
}

export interface TaxRecord {
  id?: number;
  taxYear: number;
  amount: number;
  paidAt?: string;
  notes?: string;
}

export interface Vehicle {
  id: string;
  vehicleCode: string;
  type: VehicleType;
  name: string;
  plate?: string;
  vin?: string;
  make: string;
  model: string;
  year?: number;
  color?: string;
  mileage?: number;
  holder?: string;
  status: 'active' | 'archived';
  archivedAt?: string;
  archivedReason?: string;
  notes?: string;
  sourcePayload?: Record<string, unknown>;
  tuevDate?: string;
  purchasePrice?: number;
  vehicleTax?: number;
  insurance?: Insurance;
  insurancePolicies: Insurance[];
  serviceLog: ServiceEntry[];
  tuevRecords: TuevRecord[];
  taxRecords: TaxRecord[];
  documents: VehicleDocument[];
  createdAt: string;
  updatedAt: string;
}

export type DeadlineSeverity = 'info' | 'warning' | 'overdue';

export interface DeadlineWarning {
  vehicleId: string;
  vehicleName: string;
  vehicleType: VehicleType;
  field: 'tuev' | 'insurance';
  date: string;
  daysLeft: number;
  severity: DeadlineSeverity;
}

// ── DB Row types (internal to store, exported for test access) ────────────

export interface VehicleRow {
  id: number;
  vehicle_code: string;
  display_name: string;
  license_plate: string | null;
  make: string;
  model: string;
  vin: string | null;
  first_registration: Date | null;
  holder: string | null;
  current_mileage_km: number | null;
  status: string;
  archived_at: Date | null;
  archived_reason: string | null;
  notes: string | null;
  source_payload: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

export interface ServiceRecordRow {
  id: number;
  vehicle_id: number;
  service_date: Date;
  mileage_km: number | null;
  service_type: string;
  workshop: string | null;
  cost: string | null;
  currency: string;
  notes: string | null;
  document_url: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

export interface InsurancePolicyRow {
  id: number;
  vehicle_id: number;
  company: string;
  policy_number: string | null;
  coverage_type: string;
  annual_premium: string | null;
  currency: string;
  valid_from: Date | null;
  valid_to: Date | null;
  status: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

export interface TuevRecordRow {
  id: number;
  vehicle_id: number;
  inspection_date: Date | null;
  result: string | null;
  next_due_date: Date | null;
  mileage_km: number | null;
  notes: string | null;
  document_url: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

export interface TaxRecordRow {
  id: number;
  vehicle_id: number;
  tax_year: number;
  amount: string;
  currency: string;
  paid_at: Date | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

export interface FleetDocumentRow {
  id: number;
  vehicle_id: number;
  doc_type: string;
  title: string | null;
  url: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}
