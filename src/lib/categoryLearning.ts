import { categoryNameKey } from './categories';
import { getTransactionScope, isReportableTransaction } from './finance';
import { canonicalAccountIdentity } from './identity';
import type { FinanceData, Transaction } from './types';

const merchantName = (value: string): string => value.trim().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');

/** Returns exact uncategorized matches for a user-confirmed category assignment. */
export function getSimilarUncategorizedExpenses(data: FinanceData, sourceTransactionId: string): Transaction[] {
  const source = data.transactions.find(transaction => transaction.id === sourceTransactionId && !transaction.deletedAt);
  if (!source || source.kind !== 'expense' || !source.category.trim() || !isReportableTransaction(data, source)) return [];
  const category = data.categories.find(entry => !entry.archivedAt
    && [entry.name, ...(entry.aliases ?? [])].some(name => categoryNameKey(name) === categoryNameKey(source.category)));
  const merchant = merchantName(source.originalDescription);
  if (!category || !merchant) return [];
  const scope = getTransactionScope(data, source);
  const account = canonicalAccountIdentity(source.account);
  return data.transactions.filter(transaction => !transaction.deletedAt && !transaction.category.trim()
    && transaction.kind === 'expense' && transaction.source === source.source
    && isReportableTransaction(data, transaction)
    && canonicalAccountIdentity(transaction.account) === account
    && merchantName(transaction.originalDescription) === merchant
    && getTransactionScope(data, transaction) === scope
    && getTransactionScope(data, { ...transaction, category: category.name }) === scope);
}
