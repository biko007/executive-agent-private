/**
 * assets/types — Domain types for the Assets (Immobilien) module.
 */

export type PropertyType = 'residential' | 'commercial';
export type OwnerEntity = 'personal' | 'laperlgmbh';
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
