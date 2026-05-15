/**
 * fleet module — public interface.
 * Other modules MUST import from here — never from internal files.
 * Sprint 6c: Updated for Postgres-backed store.
 */

// Types
export type {
  Vehicle, VehicleType, ServiceEntry, VehicleDocument, Insurance,
  TuevRecord, TaxRecord,
  DeadlineWarning, DeadlineSeverity,
  VehicleRow, ServiceRecordRow, InsurancePolicyRow, TuevRecordRow,
  TaxRecordRow, FleetDocumentRow,
} from './types.js';

// Store (data access)
export {
  listVehicles, getVehicleByCode, createVehicle, updateVehicle,
  archiveVehicle, unarchiveVehicle, resolveVehicleCodeToId,
  addServiceRecord, updateServiceRecord, deleteServiceRecord,
  addInsurancePolicy, updateInsurancePolicy, deleteInsurancePolicy,
  addTaxRecord, updateTaxRecord, deleteTaxRecord,
  addTuevRecord, updateTuevRecord, deleteTuevRecord,
  addDocument, deleteDocument,
  checkDeadlines, formatVehicleList, formatVehicleDetail,
} from './store.js';

// HTTP routes
export { registerFleetHttpRoutes } from './routes.js';

// Commands (Telegram registration)
export { registerFleetCommands, initFleetCommands } from './commands.js';
export type { FleetDeps } from './commands.js';
