export type TransactionKind = 'income' | 'expense' | 'transfer';
export type TransactionSource = 'bank' | 'card' | 'manual';
export type TransactionScope = 'personal' | 'work';
export interface Transaction {
  id: string;
  fingerprint: string;
  date: string;
  /** Card statement month retained for import identity; use getTransactionReportingMonth for spending reports. */
  month: string;
  amountCents: number;
  kind: TransactionKind;
  source: TransactionSource;
  account: string;
  originalDescription: string;
  description: string;
  category: string;
  scope?: TransactionScope;
  installment?: string;
  importId?: string;
  sourceFile?: string;
  sourceRow?: number;
  updatedAt: string;
  deletedAt?: string;
}
export interface PlanItem {
  id: string;
  sourcePlanId?: string;
  name: string;
  category: string;
  kind: 'income' | 'expense' | 'contribution';
  behavior?: 'fixed' | 'monthly' | 'installments';
  installments?: InstallmentSchedule[];
  defaultAmountCents: number;
  amounts: Record<string, number>;
  startMonth: string;
  endMonth?: string;
  updatedAt: string;
  deletedAt?: string;
}
export interface InstallmentSchedule {
  id: string;
  name: string;
  amountCents: number;
  firstMonth: string;
  count: number;
  sourceKey?: string;
}
export interface PlanningConfiguration {
  age?: number;
  pmrMonths: 12 | 20;
  /** Annual investment return after inflation, taxes, and fees, expressed as a percentage. */
  annualNetReturnPercent?: number;
  updatedAt: string;
}
export interface PlanOrder {
  ids: string[];
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
  /** Retained for backup compatibility; the reserve outlook uses PMS automatically. */
  reserveGoalCents: number;
  horizonMonths: number;
  googleClientId: string;
  updatedAt: string;
}
export interface Category {
  id: string;
  name: string;
  updatedAt: string;
  archivedAt?: string;
  aliases?: string[];
}
export interface ReportingConfiguration {
  startMonth: string;
  resetId: string;
  updatedAt: string;
}
export interface WorkConfiguration {
  label: string;
  expenseCategories: string[];
  updatedAt: string;
}
export interface FinanceData {
  version: 1;
  categories: Category[];
  transactions: Transaction[];
  planItems: PlanItem[];
  imports: ImportBatch[];
  settings: Settings;
  reporting?: ReportingConfiguration;
  work?: WorkConfiguration;
  planning?: PlanningConfiguration;
  planOrder?: PlanOrder;
  updatedAt: string;
}
export interface ImportResult {
  source: TransactionSource;
  transactions: Transaction[];
  warnings: string[];
  summary?: string;
}
export interface ImportOptions { cardMonth?: string }
export interface MonthSummary { month: string; incomeCents: number; expenseCents: number; netCents: number; categories: Record<string, number>; count: number; workInCents: number; workOutCents: number; workNetCents: number }
export interface PlanningIndicator { targetCents: number | null; progressPercent: number | null }
export interface ProjectionMonth {
  month: string;
  openingCents: number;
  incomeCents: number;
  expenseCents: number;
  contributionCents: number;
  availableCents: number;
  returnCents: number;
  netCents: number;
  closingCents: number;
  indicators: Record<'pms' | 'pmr' | 'pi' | 'pnif', PlanningIndicator>;
}
