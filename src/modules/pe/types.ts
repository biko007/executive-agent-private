/**
 * pe/types — Domain types for Private Equity module.
 */

export interface PEInvestment {
  id: string;
  company: string;
  sector: string;
  investmentDate: string;
  shares: number;
  totalShares: number;
  ownershipPct: number;
  investedAmount: number;
  currentValuation: number;
  valuationDate: string;
  valuationMethod: string;
  status: 'active' | 'exited' | 'written-off';
  contactPerson?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ValuationEntry {
  investmentId: string;
  date: string;
  amount: number;
  method?: string;
  notes?: string;
}
