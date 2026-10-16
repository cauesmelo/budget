import { categoryNameKey, listCategories, resolveCategoryName } from './categories';
import { getTransactionScope, isReportableTransaction, isValidMonth, planAmountForMonth } from './finance';
import { getOrderedPlanItems } from './planOrder';
import { getTransactionReportingMonth } from './transactionMonth';
import type { FinanceData } from './types';

export interface MonthlyBudgetRow {
  key: string;
  kind: 'category' | 'uncategorized' | 'unassigned-plan';
  category: string;
  label: string;
  plannedCents: number;
  spentCents: number;
  remainingCents: number;
  planItemIds: string[];
  transactionCount: number;
  archived: boolean;
}

export interface MonthlyBudgetReview {
  month: string;
  rows: MonthlyBudgetRow[];
  plannedCents: number;
  spentCents: number;
  remainingCents: number;
  unassignedPlanCents: number;
  unassignedPlanItemCount: number;
  uncategorizedCount: number;
  personalExpenseCount: number;
  hasRecordedExpenses: boolean;
  workInCents: number;
  workOutCents: number;
}

function safeCents(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('The monthly budget exceeds the supported monetary range.');
  return value;
}

function emptyRow(key: string, kind: MonthlyBudgetRow['kind'], label: string, category = '', archived = false): MonthlyBudgetRow {
  return { key, kind, category, label, plannedCents: 0, spentCents: 0, remainingCents: 0, planItemIds: [], transactionCount: 0, archived };
}

/** Compare the same expense plan used by projections with personal spending net of refunds. */
export function getMonthlyBudgetReview(data: FinanceData, month: string): MonthlyBudgetReview {
  if (!isValidMonth(month)) throw new Error('Invalid month.');
  const catalog = listCategories(data);
  const categories = new Map(catalog.map(category => [categoryNameKey(category.name), category]));
  const rows = new Map<string, MonthlyBudgetRow>();
  for (const category of catalog) {
    if (!category.archivedAt) rows.set(categoryNameKey(category.name), emptyRow(`category:${category.id}`, 'category', category.name, category.name));
  }
  const unassigned = emptyRow('unassigned-plan', 'unassigned-plan', 'Plan items without a category');
  const uncategorized = emptyRow('uncategorized', 'uncategorized', 'Uncategorized spending');
  const categoryRow = (name: string): MonthlyBudgetRow | null => {
    const resolved = resolveCategoryName(data, name).trim();
    if (!resolved) return null;
    const normalized = categoryNameKey(resolved);
    let row = rows.get(normalized);
    if (!row) {
      const category = categories.get(normalized);
      row = emptyRow(category ? `category:${category.id}` : `category:unknown:${normalized}`, 'category', category?.name ?? resolved, category?.name ?? resolved, Boolean(category?.archivedAt));
      rows.set(normalized, row);
    }
    return row;
  };

  for (const item of getOrderedPlanItems(data)) {
    if (item.kind !== 'expense' || item.deletedAt || month < item.startMonth || (item.endMonth && month > item.endMonth)) continue;
    const row = categoryRow(item.category) ?? unassigned;
    row.plannedCents = safeCents(row.plannedCents + safeCents(planAmountForMonth(item, month)));
    row.planItemIds.push(item.id);
  }

  let workInCents = 0;
  let workOutCents = 0;
  let personalExpenseCount = 0;
  for (const transaction of data.transactions) {
    if (transaction.deletedAt || transaction.kind === 'transfer' || !isReportableTransaction(data, transaction) || getTransactionReportingMonth(transaction) !== month) continue;
    if (getTransactionScope(data, transaction) === 'work') {
      const amount = safeCents(transaction.amountCents);
      if (amount >= 0) workInCents = safeCents(workInCents + amount);
      else workOutCents = safeCents(workOutCents - amount);
      continue;
    }
    if (transaction.kind !== 'expense') continue;
    const row = categoryRow(transaction.category) ?? uncategorized;
    row.spentCents = safeCents(row.spentCents - safeCents(transaction.amountCents));
    row.transactionCount++;
    personalExpenseCount++;
  }

  const categoryRows = [...rows.values()].filter(row => {
    const category = categories.get(categoryNameKey(row.category));
    return Boolean(category && !category.archivedAt) || row.plannedCents !== 0 || row.transactionCount > 0;
  }).sort((left, right) => left.label.localeCompare(right.label, 'pt-BR') || left.key.localeCompare(right.key));
  const visibleRows = [
    ...categoryRows,
    ...(uncategorized.transactionCount > 0 ? [uncategorized] : []),
    ...(unassigned.planItemIds.length > 0 ? [unassigned] : []),
  ];
  let plannedCents = 0;
  let spentCents = 0;
  for (const row of visibleRows) {
    row.remainingCents = safeCents(row.plannedCents - row.spentCents);
    plannedCents = safeCents(plannedCents + row.plannedCents);
    spentCents = safeCents(spentCents + row.spentCents);
  }
  return {
    month,
    rows: visibleRows,
    plannedCents,
    spentCents,
    remainingCents: safeCents(plannedCents - spentCents),
    unassignedPlanCents: unassigned.plannedCents,
    unassignedPlanItemCount: unassigned.planItemIds.length,
    uncategorizedCount: uncategorized.transactionCount,
    personalExpenseCount,
    hasRecordedExpenses: personalExpenseCount > 0,
    workInCents,
    workOutCents,
  };
}
