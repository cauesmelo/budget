import type { ImportResult, Transaction } from './types';

export interface PendingImport {
  name: string;
  result: ImportResult;
  learnedCount: number;
  excluded?: { transaction: Transaction; index: number }[];
}

/** Excludes one preview row without deleting or changing saved transactions. */
export function excludePreviewTransaction(item: PendingImport, id: string): PendingImport {
  const index = item.result.transactions.findIndex(transaction => transaction.id === id);
  if (index === -1) return item;
  return {
    ...item,
    result: {
      ...item.result,
      transactions: item.result.transactions.filter((_transaction, position) => position !== index),
    },
    excluded: [...(item.excluded ?? []), { transaction: { ...item.result.transactions[index] }, index }],
  };
}

/** Restores the last excluded row, including its reviewed fields and position. */
export function undoPreviewExclusion(item: PendingImport): PendingImport {
  const last = item.excluded?.at(-1);
  if (!last) return item;
  const transactions = [...item.result.transactions];
  transactions.splice(last.index, 0, last.transaction);
  return {
    ...item,
    result: { ...item.result, transactions },
    excluded: item.excluded!.slice(0, -1),
  };
}
