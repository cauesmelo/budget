import { describe, expect, it } from 'vitest';
import { getSimilarUncategorizedExpenses } from '../src/lib/categoryLearning';
import { createEmptyData } from '../src/lib/finance';
import type { FinanceData, Transaction } from '../src/lib/types';

const STAMP = '2032-10-10T12:00:00.000Z';
function transaction(id: string, patch: Partial<Transaction> = {}): Transaction {
  return {
    id, fingerprint: `fingerprint-${id}`, source: 'card', account: 'Itaú card ****0001',
    originalDescription: 'Example merchant', description: '', category: '', kind: 'expense',
    date: '2032-10-01', month: '2032-10', amountCents: -2_000, updatedAt: STAMP, ...patch,
  };
}
function fixture(): FinanceData {
  const data = createEmptyData(new Date(STAMP));
  data.categories = [{ id: 'groceries', name: 'Groceries', updatedAt: STAMP, aliases: ['Food shopping'] }];
  data.transactions = [transaction('source', { category: 'Groceries', description: 'Reviewed purchase' }), transaction('target')];
  return data;
}

describe('explicit category application to similar expenses', () => {
  it('returns exact merchant matches across dates and amounts without modifying any records', () => {
    const data = fixture();
    data.transactions.push(transaction('another-month', {
      originalDescription: '  EXAMPLE   MÉRCHANT ', account: 'Cartão Itaú ****0001',
      date: '2032-11-02', month: '2032-11', amountCents: -3_000, description: 'Keep this description',
    }));
    const before = structuredClone(data);
    expect(getSimilarUncategorizedExpenses(data, 'source').map(row => row.id)).toEqual(['target', 'another-month']);
    expect(data).toEqual(before);
  });

  it.each([
    ['a missing source', (data: FinanceData) => { data.transactions = data.transactions.slice(1); }],
    ['a deleted source', (data: FinanceData) => { data.transactions[0].deletedAt = STAMP; }],
    ['an income source', (data: FinanceData) => { data.transactions[0].kind = 'income'; }],
    ['a transfer source', (data: FinanceData) => { data.transactions[0].kind = 'transfer'; }],
    ['an uncategorized source', (data: FinanceData) => { data.transactions[0].category = ''; }],
    ['an unregistered category', (data: FinanceData) => { data.transactions[0].category = 'Unknown'; }],
    ['an archived category', (data: FinanceData) => { data.categories[0].archivedAt = STAMP; }],
    ['an empty merchant', (data: FinanceData) => { data.transactions[0].originalDescription = ' '; }],
  ])('requires a valid reviewed expense for %s', (_label, edit) => {
    const data = fixture();
    edit(data);
    expect(getSimilarUncategorizedExpenses(data, 'source')).toEqual([]);
  });

  it.each([
    ['already categorized', { category: 'Groceries' }], ['deleted', { deletedAt: STAMP }],
    ['another merchant', { originalDescription: 'Example merchant branch' }],
    ['another account', { account: 'Itaú card ****0002' }], ['another source', { source: 'bank' as const }],
    ['income', { kind: 'income' as const, amountCents: 2_000 }], ['transfer', { kind: 'transfer' as const }],
    ['work scope', { scope: 'work' as const }],
  ])('excludes candidates that are %s', (_label, patch) => {
    const data = fixture();
    data.transactions[1] = { ...data.transactions[1], ...patch };
    expect(getSimilarUncategorizedExpenses(data, 'source')).toEqual([]);
  });

  it('does not infer work scope by assigning a category with a work rule', () => {
    const data = fixture();
    data.work = { label: 'Example employer', expenseCategories: ['Groceries'], updatedAt: STAMP };
    data.transactions[0].scope = 'personal';
    expect(getSimilarUncategorizedExpenses(data, 'source')).toEqual([]);
    data.transactions[1].scope = 'personal';
    expect(getSimilarUncategorizedExpenses(data, 'source').map(row => row.id)).toEqual(['target']);
  });

  it('matches explicit work expenses without assigning scope to personal records', () => {
    const data = fixture();
    data.work = { label: 'Example employer', expenseCategories: ['Groceries'], updatedAt: STAMP };
    data.transactions[0].scope = 'work';
    data.transactions[1].scope = 'work';
    data.transactions.push(transaction('personal'));
    expect(getSimilarUncategorizedExpenses(data, 'source').map(row => row.id)).toEqual(['target']);
    expect(Object.hasOwn(data.transactions[2], 'scope')).toBe(false);
  });

  it('accepts a registered category alias and empty category whitespace', () => {
    const data = fixture();
    data.transactions[0].category = 'Food shopping';
    data.transactions[1].category = '  ';
    expect(getSimilarUncategorizedExpenses(data, 'source').map(row => row.id)).toEqual(['target']);
  });

  it('ignores source and candidate records outside the current reporting period', () => {
    const data = fixture();
    data.reporting = { startMonth: '2032-10', resetId: 'example-reset', updatedAt: STAMP };
    data.transactions[1].month = '2032-11';
    data.transactions[1].date = '2032-09-01';
    expect(getSimilarUncategorizedExpenses(data, 'source')).toEqual([]);
    data.transactions[1].date = '2032-10-01';
    data.transactions[0].month = '2032-11';
    data.transactions[0].date = '2032-09-01';
    expect(getSimilarUncategorizedExpenses(data, 'source')).toEqual([]);
  });
});
