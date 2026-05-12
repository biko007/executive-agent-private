/**
 * travel-store.ts — Re-export shim for backwards compatibility.
 * Real implementation: src/modules/travel/store.ts
 */
export {
  createTrip, getTrip, listTrips,
  addSegment, removeSegment, updateSegment, updateTrip,
  generatePacklist,
} from './src/modules/travel/store.js';

export type { Trip, TripSegment, SegmentType, Climate, ActivityType } from './src/modules/travel/types.js';
