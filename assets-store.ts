/**
 * assets-store.ts — Re-export shim for backwards compatibility.
 * Real implementation: src/modules/assets/store.ts
 */
export {
  listProperties, getProperty, createProperty, updateProperty, deleteProperty,
  addUnit, updateUnit, removeUnit,
  setDistributionKey, removeDistributionKey,
  listLeases, getLease, getLeaseByUnit, setLease, deleteLease,
  getOperatingCosts, setOperatingCosts, calculateNk,
  formatPropertyList, formatPropertyDetail, formatRentOverview, formatNkResult,
  seedInitialData,
} from './src/modules/assets/store.js';

export type {
  Property, PropertyType, OwnerEntity, RentType, Unit, DistributionKey,
  Lease, CostCategory, OperatingCosts, NkResult,
} from './src/modules/assets/types.js';

export { COST_CATEGORIES } from './src/modules/assets/types.js';
