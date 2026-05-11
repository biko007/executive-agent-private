/**
 * assets module — public interface.
 * Other modules MUST import from here — never from internal files.
 */

// Types
export type {
  Property, PropertyType, OwnerEntity, RentType, Unit, DistributionKey,
  Lease, CostCategory, OperatingCosts, NkResult,
} from './types.js';
export { COST_CATEGORIES } from './types.js';

// Store (data access)
export {
  listProperties, getProperty, createProperty, updateProperty, deleteProperty,
  addUnit, updateUnit, removeUnit,
  setDistributionKey, removeDistributionKey,
  listLeases, getLease, getLeaseByUnit, setLease, deleteLease,
  getOperatingCosts, setOperatingCosts, calculateNk,
  formatPropertyList, formatPropertyDetail, formatRentOverview, formatNkResult,
  seedInitialData,
} from './store.js';

// Commands (Telegram registration)
export { registerAssetsCommands } from './commands.js';
