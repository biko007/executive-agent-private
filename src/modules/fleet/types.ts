/**
 * fleet/types — Domain types for the Fleet module.
 */

export type VehicleType = 'car' | 'bike' | 'boat';

export interface ServiceEntry {
  date: string;
  type: string;
  mileage?: number;
  cost?: number;
  notes?: string;
}

export interface VehicleDocument {
  filename: string;
  label: string;
  uploadedAt: string;
}

export interface Insurance {
  provider: string;
  policyNumber?: string;
  type: string;
  validUntil?: string;
  annualCost?: number;
}

export interface Vehicle {
  id: string;
  type: VehicleType;
  name: string;
  plate?: string;
  vin?: string;
  make: string;
  model: string;
  year: number;
  color?: string;
  mileage?: number;
  tuevDate?: string;
  purchasePrice?: number;
  vehicleTax?: number;
  insurance?: Insurance;
  serviceLog: ServiceEntry[];
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
