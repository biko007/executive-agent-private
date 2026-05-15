/**
 * fleet-store.ts — Re-export shim for backwards compatibility.
 * Real implementation: src/modules/fleet/store.ts
 * Sprint 6c: Updated for Postgres-backed store (removed JSON-only exports).
 */
export {
  listVehicles, getVehicleByCode, createVehicle, updateVehicle,
  archiveVehicle, unarchiveVehicle, resolveVehicleCodeToId,
  addServiceRecord, updateServiceRecord, deleteServiceRecord,
  addInsurancePolicy, updateInsurancePolicy, deleteInsurancePolicy,
  addTaxRecord, updateTaxRecord, deleteTaxRecord,
  addTuevRecord, updateTuevRecord, deleteTuevRecord,
  addDocument, deleteDocument,
  checkDeadlines, formatVehicleList, formatVehicleDetail,
} from './src/modules/fleet/store.js';

export type {
  Vehicle, VehicleType, ServiceEntry, VehicleDocument, Insurance,
  TuevRecord, TaxRecord,
  DeadlineWarning, DeadlineSeverity,
} from './src/modules/fleet/types.js';
