/**
 * fleet module — public interface.
 * Other modules MUST import from here — never from internal files.
 */

// Types
export type {
  Vehicle, VehicleType, ServiceEntry, VehicleDocument, Insurance,
  DeadlineWarning, DeadlineSeverity,
} from './types.js';

// Store (data access)
export {
  getAllVehicles, getVehicle, createVehicle, updateVehicle, deleteVehicle,
  addServiceEntry, setInsurance, setTuevDate, addDocument, removeDocument,
  checkDeadlines, formatVehicleList, formatVehicleDetail,
  changeVehicleId, migrateHexIds,
} from './store.js';

// Commands (Telegram registration)
export { registerFleetCommands, initFleetCommands } from './commands.js';
export type { FleetDeps } from './commands.js';
