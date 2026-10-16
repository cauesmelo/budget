import type { Transaction } from './types';

/** Card spending belongs to its purchase date; the stored statement month remains its import identity. */
export function getTransactionReportingMonth(transaction: Pick<Transaction, 'source' | 'date' | 'month'>): string {
  return transaction.source === 'card' ? transaction.date.slice(0, 7) : transaction.month;
}
