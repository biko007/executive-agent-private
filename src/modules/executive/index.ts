// Public interface for the executive module
// Other modules MUST import from here — never from internal files
export { HealthMonitor, LOCATION_STALE_THRESHOLD_MS } from './health-monitor.js';
export type { ServiceState, TokenInfo } from './health-monitor.js';
