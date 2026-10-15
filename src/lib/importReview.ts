import { categoryNameKey } from './categories';
import { getTransactionScope, isReportableTransaction } from './finance';
import { canonicalAccountIdentity } from './identity';
import type { Category, FinanceData, ImportResult, Transaction } from './types';

export interface PossibleImportDuplicate {
  incoming: Transaction;
  existing: Transaction[];
}

export interface PreparedImportReview {
  result: ImportResult;
  /** Number of transactions with at least one field filled from reviewed history. */
  learnedCount: number;
  possibleDuplicates: PossibleImportDuplicate[];
}

const normalize = (value: string): string => value.trim().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');

function merchantKey(transaction: Transaction, data: FinanceData): string | undefined {
  const description = normalize(transaction.originalDescription);
  if (!description || transaction.kind !== 'expense') return undefined;
  return JSON.stringify([
    transaction.source, canonicalAccountIdentity(transaction.account), transaction.kind,
    getTransactionScope(data, transaction), description,
  ]);
}

function duplicateKey(transaction: Transaction): string | undefined {
  const description = normalize(transaction.originalDescription);
  if (!description || !['bank', 'card'].includes(transaction.source)) return undefined;
  return JSON.stringify([
    transaction.source, canonicalAccountIdentity(transaction.account), transaction.date,
    transaction.month, transaction.kind, description,
  ]);
}

function categoryLookup(categories: Category[]): Map<string, Category> {
  const lookup = new Map<string, Category>();
  for (const category of categories) {
    for (const name of [category.name, ...(category.aliases ?? [])]) lookup.set(categoryNameKey(name), category);
  }
  return lookup;
}

/**
 * Suggests only exact, unambiguous expense context. Statement identity, amounts,
 * transaction type, and work scope are never inferred or changed.
 */
export function prepareImportReview(data: FinanceData, result: ImportResult): PreparedImportReview {
  const ids = new Set(data.transactions.map(transaction => transaction.id));
  const fingerprints = new Set(data.transactions.map(transaction => transaction.fingerprint));
  const categories = categoryLookup(data.categories);
  const history = new Map<string, Transaction[]>();
  const duplicateCandidates = new Map<string, Transaction[]>();
  for (const transaction of data.transactions) {
    if (transaction.deletedAt || !isReportableTransaction(data, transaction)) continue;
    const key = merchantKey(transaction, data);
    if (key) {
      const group = history.get(key) ?? [];
      group.push(transaction);
      history.set(key, group);
    }
    const possibleKey = duplicateKey(transaction);
    if (possibleKey) {
      const group = duplicateCandidates.get(possibleKey) ?? [];
      group.push(transaction);
      duplicateCandidates.set(possibleKey, group);
    }
  }

  let learnedCount = 0;
  const possibleDuplicates: PossibleImportDuplicate[] = [];
  const transactions = result.transactions.map(original => {
    if (ids.has(original.id) || fingerprints.has(original.fingerprint)) return original;
    let incoming = original;
    const key = merchantKey(incoming, data);
    const previous = key ? history.get(key) ?? [] : [];
    const reviewed = previous.filter(transaction => transaction.category.trim());
    const resolved = reviewed.map(transaction => categories.get(categoryNameKey(transaction.category)));
    // Archived/unknown or contradictory categories make the merchant context ambiguous.
    const categoryIds = new Set(resolved.flatMap(category => category ? [category.id] : []));
    if (reviewed.length && resolved.every(category => category && !category.archivedAt) && categoryIds.size === 1) {
      const category = resolved[0]!;
      const currentCategory = incoming.category.trim() ? categories.get(categoryNameKey(incoming.category)) : undefined;
      const categoryCompatible = !incoming.category.trim() || currentCategory?.id === category.id;
      const matchingScope = getTransactionScope(data, { ...incoming, category: category.name }) === getTransactionScope(data, incoming);
      if (categoryCompatible && matchingScope) {
        const descriptions = reviewed.filter(transaction => transaction.description.trim());
        const descriptionKeys = new Set(descriptions.map(transaction => normalize(transaction.description)));
        const description = descriptionKeys.size === 1
          ? [...descriptions].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id))[0].description.trim()
          : undefined;
        const nextCategory = incoming.category.trim() ? incoming.category : category.name;
        const nextDescription = incoming.description.trim() ? incoming.description : description ?? incoming.description;
        if (nextCategory !== incoming.category || nextDescription !== incoming.description) {
          incoming = { ...incoming, category: nextCategory, description: nextDescription };
          learnedCount++;
        }
      }
    }
    const possibleKey = duplicateKey(incoming);
    const existing = possibleKey ? (duplicateCandidates.get(possibleKey) ?? []).filter(transaction => transaction.amountCents !== incoming.amountCents) : [];
    if (existing.length) possibleDuplicates.push({ incoming, existing });
    return incoming;
  });
  return { result: { ...result, transactions }, learnedCount, possibleDuplicates };
}
