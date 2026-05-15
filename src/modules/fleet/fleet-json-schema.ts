import { z } from 'zod';

// ── Sub-entity schemas ──────────────────────────────────────────────────────

const FleetInsuranceSchema = z.object({
  provider: z.string(),
  type: z.string(),
  annualCost: z.number().optional(),
  policyNumber: z.string().optional(),
  validUntil: z.string().optional(),
}).strict();

const FleetServiceEntrySchema = z.object({
  date: z.string(),
  type: z.string(),
  mileage: z.number().optional(),
  cost: z.number().optional(),
  notes: z.string().optional(),
}).strict();

const FleetDocumentSchema = z.object({
  filename: z.string(),
  label: z.string(),
  uploadedAt: z.string(),
}).strict();

// ── Vehicle schema ──────────────────────────────────────────────────────────

const FleetVehicleSchema = z.object({
  // Direct-mapped fields
  id: z.string(),
  name: z.string(),
  plate: z.string().optional(),
  make: z.string(),
  model: z.string(),
  vin: z.string().optional(),
  year: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // source_payload candidates (explicitly typed, not passthrough)
  type: z.string(),
  color: z.string().optional(),
  mileage: z.number().int().optional(),
  purchasePrice: z.number().optional(),
  vehicleTax: z.number().optional(),
  tuevDate: z.string().optional(),
  // Sub-entities
  insurance: FleetInsuranceSchema.optional(),
  serviceLog: z.array(FleetServiceEntrySchema),
  documents: z.array(FleetDocumentSchema),
}).strict();

// ── File-level schema (array of vehicles) ───────────────────────────────────

export const FleetVehiclesFileSchema = z.array(FleetVehicleSchema);

export type FleetVehicle = z.infer<typeof FleetVehicleSchema>;
export type FleetInsurance = z.infer<typeof FleetInsuranceSchema>;
export type FleetServiceEntry = z.infer<typeof FleetServiceEntrySchema>;
export type FleetDocument = z.infer<typeof FleetDocumentSchema>;
