import type { Transaction, TransactionScope } from './types';

/** Manual entries use signed, nonzero integer cents instead of a separate type selector. */
export function getManualTransactionKind(amountCents: number): 'expense' | 'income' {
  if (!Number.isSafeInteger(amountCents) || amountCents === 0) {
    throw new Error('Enter a nonzero amount within the supported monetary range.');
  }
  return amountCents < 0 ? 'expense' : 'income';
}

/** Preserve statement classifications while giving exceptional cash flows readable labels. */
export function getTransactionFlowLabel(
  transaction: Pick<Transaction, 'kind' | 'amountCents'>,
  scope: TransactionScope = 'personal',
): string {
  if (transaction.kind === 'transfer') return 'Account movement';
  if (transaction.kind === 'expense' && transaction.amountCents > 0) return 'Refund';
  if (transaction.kind === 'income' && transaction.amountCents < 0) return 'Income reversal';
  if (transaction.kind === 'income') return scope === 'work' ? 'Reimbursement' : 'Income';
  return 'Expense';
}
