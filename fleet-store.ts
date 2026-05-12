/**
 * fleet-store.ts — Re-export shim for backwards compatibility.
 * Real implementation: src/modules/fleet/store.ts
 */
export {
  getAllVehicles, getVehicle, createVehicle, updateVehicle, deleteVehicle,
  addServiceEntry, setInsurance, setTuevDate, addDocument, removeDocument,
  checkDeadlines, formatVehicleList, formatVehicleDetail,
  changeVehicleId, migrateHexIds,
} from './src/modules/fleet/store.js';

export type {
  Vehicle, VehicleType, ServiceEntry, VehicleDocument, Insurance,
  DeadlineWarning, DeadlineSeverity,
} from './src/modules/fleet/types.js';
