import { describe, expect, it } from 'vitest';
import { createEmptyData, summarizeMonth } from '../src/lib/finance';
import { serializeBackup, validateBackup } from '../src/lib/storage';
import { getManualTransactionKind, getTransactionFlowLabel } from '../src/lib/transactionFlow';
import type { Transaction } from '../src/lib/types';

const NOW = new Date('2032-08-15T12:00:00.000Z');
const MONTH = '2032-08';

function transaction(id: string, amountCents: number, patch: Partial<Transaction> = {}): Transaction {
  return {
    id, fingerprint: `example-${id}`, date: `${MONTH}-10`, month: MONTH, amountCents,
    kind: getManualTransactionKind(amountCents), source: 'manual', account: 'Example account',
    originalDescription: 'Example entry', description: '', category: '', updatedAt: NOW.toISOString(), ...patch,
  };
}

describe('signed manual transaction amounts', () => {
  it('derives income or expense from cents, including the supported integer boundaries', () => {
    expect([1, 12_345, Number.MAX_SAFE_INTEGER].map(getManualTransactionKind)).toEqual(['income', 'income', 'income']);
    expect([-1, -12_345, -Number.MAX_SAFE_INTEGER].map(getManualTransactionKind)).toEqual(['expense', 'expense', 'expense']);
  });

  it.each([0, -0, NaN, Infinity, -Infinity, 1.5, -1.5, Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1])(
    'rejects zero or unsupported cents before a manual entry is saved: %s', amountCents => {
      expect(() => getManualTransactionKind(amountCents)).toThrow('Enter a nonzero amount within the supported monetary range.');
    },
  );
});

describe('read-only transaction flow labels', () => {
  it('labels ordinary signed entries without changing the transaction', () => {
    const expense = Object.freeze(transaction('expense', -12_500));
    const income = Object.freeze(transaction('income', 250_000));
    const before = structuredClone([expense, income]);
    expect(getTransactionFlowLabel(expense)).toBe('Expense');
    expect(getTransactionFlowLabel(income)).toBe('Income');
    expect([expense, income]).toEqual(before);
  });

  it('keeps a positive card refund reducing expenses rather than inflating income', () => {
    const data = createEmptyData(NOW);
    const refund = transaction('refund', 2_000, { kind: 'expense', source: 'card' });
    data.transactions = [transaction('purchase', -10_000, { source: 'card' }), refund];
    const before = structuredClone(data);
    expect(getTransactionFlowLabel(refund)).toBe('Refund');
    expect(summarizeMonth(data, MONTH)).toMatchObject({ incomeCents: 0, expenseCents: 8_000, netCents: -8_000 });
    expect(data).toEqual(before);
  });

  it('identifies an income reversal without reclassifying it as new spending', () => {
    const data = createEmptyData(NOW);
    const reversal = transaction('income-reversal', -4_000, { kind: 'income' });
    data.transactions = [transaction('income', 40_000), reversal];
    expect(getTransactionFlowLabel(reversal)).toBe('Income reversal');
    expect(summarizeMonth(data, MONTH)).toMatchObject({ incomeCents: 36_000, expenseCents: 0, netCents: 36_000 });
    expect(reversal.kind).toBe('income');
  });

  it('preserves existing account movements through backup and excludes both signs from totals', () => {
    const data = createEmptyData(NOW);
    data.transactions = [
      transaction('outgoing-movement', -50_000, { kind: 'transfer' }),
      transaction('incoming-movement', 50_000, { kind: 'transfer', scope: 'work' }),
    ];
    const before = structuredClone(data);
    expect(data.transactions.map(item => getTransactionFlowLabel(item, item.scope))).toEqual(['Account movement', 'Account movement']);
    const restored = validateBackup(serializeBackup(data));
    expect(restored.transactions).toEqual(data.transactions);
    expect(summarizeMonth(restored, MONTH)).toMatchObject({
      incomeCents: 0, expenseCents: 0, netCents: 0, count: 0, workInCents: 0, workOutCents: 0, workNetCents: 0,
    });
    expect(data).toEqual(before);
  });

  it('labels work reimbursements and keeps all work cash flow separate from personal totals', () => {
    const data = createEmptyData(NOW);
    const reimbursement = transaction('reimbursement', 20_000, { scope: 'work' });
    const workExpense = transaction('business-expense', -25_000, { scope: 'work' });
    const refund = transaction('business-refund', 3_000, { kind: 'expense', source: 'card', scope: 'work' });
    const reversal = transaction('reimbursement-reversal', -1_000, { kind: 'income', scope: 'work' });
    data.transactions = [transaction('salary', 200_000), workExpense, reimbursement, refund, reversal];
    const before = structuredClone(data);
    expect(getTransactionFlowLabel(reimbursement, 'work')).toBe('Reimbursement');
    expect(getTransactionFlowLabel(workExpense, 'work')).toBe('Expense');
    expect(getTransactionFlowLabel(refund, 'work')).toBe('Refund');
    expect(getTransactionFlowLabel(reversal, 'work')).toBe('Income reversal');
    expect(summarizeMonth(data, MONTH)).toMatchObject({
      incomeCents: 200_000, expenseCents: 0, count: 1, workInCents: 23_000, workOutCents: 26_000, workNetCents: -3_000,
    });
    expect(data).toEqual(before);
  });
});
