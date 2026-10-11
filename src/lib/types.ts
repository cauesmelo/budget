export type TransactionKind = 'income' | 'expense' | 'transfer';
export type TransactionSource = 'bank' | 'card' | 'budget' | 'manual';
export interface Transaction {
  id: string;
  fingerprint: string;
  date: string;
  month: string;
  amountCents: number;
  kind: TransactionKind;
  source: TransactionSource;
  account: string;
  originalDescription: string;
  description: string;
  category: string;
  installment?: string;
  importId?: string;
  sourceFile?: string;
  sourceRow?: number;
  updatedAt: string;
  deletedAt?: string;
}
export interface PlanItem {
  id: string;
  name: string;
  category: string;
  kind: 'income' | 'expense' | 'contribution';
  defaultAmountCents: number;
  amounts: Record<string, number>;
  startMonth: string;
  endMonth?: string;
  updatedAt: string;
  deletedAt?: string;
}
export interface BudgetSnapshot {
  id: string;
  month: string;
  incomeCents: number;
  expenseCents: number;
  categories: Record<string, number>;
  updatedAt: string;
}
export interface ImportBatch {
  id: string;
  filename: string;
  source: TransactionSource;
  importedAt: string;
  count: number;
  updatedAt: string;
}
export interface Settings {
  initialReserveCents: number;
  reserveStartMonth: string;
  monthlyReturnPercent: number;
  reserveGoalCents: number;
  horizonMonths: number;
  googleClientId: string;
  updatedAt: string;
}
export interface FinanceData {
  version: 1;
  transactions: Transaction[];
  planItems: PlanItem[];
  snapshots: BudgetSnapshot[];
  imports: ImportBatch[];
  settings: Settings;
  updatedAt: string;
}
export interface ImportResult {
  source: TransactionSource;
  transactions: Transaction[];
  planItems: PlanItem[];
  snapshots: BudgetSnapshot[];
  warnings: string[];
  suggestedSettings?: Partial<Settings>;
  summary?: string;
}
export interface ImportOptions { cardMonth?: string; referenceYear?: number }
export interface MonthSummary { month: string; incomeCents: number; expenseCents: number; netCents: number; categories: Record<string, number>; count: number }
export interface ProjectionMonth { month: string; openingCents: number; incomeCents: number; expenseCents: number; returnCents: number; netCents: number; closingCents: number }
