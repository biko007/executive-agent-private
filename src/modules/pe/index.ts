/**
 * pe module — public interface.
 * Other modules MUST import from here — never from internal files.
 */

// Types
export type { PEInvestment, ValuationEntry } from './types.js';

// Store (data access)
export {
  getAllInvestments, getInvestment, createInvestment, updateInvestment, deleteInvestment,
  addValuation, getValuationHistory, calculateIRR,
  formatInvestmentList, formatInvestmentDetail,
} from './store.js';

// Commands (Telegram registration)
export { registerPECommands } from './commands.js';
