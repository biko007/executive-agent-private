/**
 * pe-store.ts — Re-export shim for backwards compatibility.
 * Real implementation: src/modules/pe/store.ts
 */
export {
  getAllInvestments, getInvestment, createInvestment, updateInvestment, deleteInvestment,
  addValuation, getValuationHistory, calculateIRR,
  formatInvestmentList, formatInvestmentDetail,
} from './src/modules/pe/store.js';

export type { PEInvestment, ValuationEntry } from './src/modules/pe/types.js';
