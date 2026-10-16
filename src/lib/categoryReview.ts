import { categoryNameKey, listCategories } from './categories';
import { isReportableTransaction } from './finance';
import type { FinanceData, Transaction } from './types';

function isActiveTransaction(data: FinanceData, transaction: Transaction): boolean {
  return !transaction.deletedAt
    && (transaction.kind === 'expense' || transaction.kind === 'income')
    && isReportableTransaction(data, transaction);
}

/** Income and expenses need a category, regardless of their signed amount or scope. */
export function needsTransactionCategory(transaction: Pick<Transaction, 'kind' | 'category'>): boolean {
  return (transaction.kind === 'expense' || transaction.kind === 'income') && !transaction.category.trim();
}

/** Reviews include income, work expenses and refunds without changing existing edits or identities. */
export function getPendingCategoryReviews(data: FinanceData): Transaction[] {
  return data.transactions
    .filter(transaction => isActiveTransaction(data, transaction) && needsTransactionCategory(transaction))
    .sort((left, right) => right.date.localeCompare(left.date)
      || left.originalDescription.localeCompare(right.originalDescription, 'pt-BR')
      || left.id.localeCompare(right.id));
}

/** Counts reviewed income and expense records, including previous category names, across the tracked period. */
export function getRankedReviewCategories(data: FinanceData): string[] {
  const categories = listCategories(data).filter(category => !category.archivedAt);
  const byName = new Map<string, string>();
  for (const category of categories) {
    for (const label of [category.name, ...(category.aliases ?? [])]) byName.set(categoryNameKey(label), category.name);
  }
  const counts = new Map<string, number>();
  for (const transaction of data.transactions) {
    if (!isActiveTransaction(data, transaction)) continue;
    const name = byName.get(categoryNameKey(transaction.category));
    if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return categories
    .map((category, index) => ({ name: category.name, index, count: counts.get(category.name) ?? 0 }))
    .sort((left, right) => right.count - left.count || left.index - right.index)
    .map(category => category.name);
}
