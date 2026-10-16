import { describe, expect, it } from 'vitest';
import { getPendingCategoryReviews, getRankedReviewCategories, needsTransactionCategory } from '../src/lib/categoryReview';
import { createEmptyData } from '../src/lib/finance';
import type { FinanceData, Transaction } from '../src/lib/types';

const STAMP = '2032-10-15T12:00:00.000Z';

function transaction(id: string, patch: Partial<Transaction> = {}): Transaction {
  return {
    id, fingerprint: `example-${id}`, source: 'card', account: 'Example card',
    date: '2032-10-14', month: '2032-11', amountCents: -2_000, kind: 'expense',
    originalDescription: 'Example merchant', description: '', category: '', updatedAt: STAMP,
    ...patch,
  };
}

function fixture(): FinanceData {
  const data = createEmptyData(new Date(STAMP));
  data.reporting = { startMonth: '2032-10', resetId: 'example-reset', updatedAt: STAMP };
  data.categories = [
    { id: 'travel', name: 'Travel', updatedAt: STAMP },
    { id: 'food', name: 'Food', aliases: ['Meals'], updatedAt: STAMP },
    { id: 'bills', name: 'Bills', updatedAt: STAMP },
    { id: 'archived', name: 'Retired', aliases: ['Previous label'], updatedAt: STAMP, archivedAt: STAMP },
  ];
  return data;
}

describe('transactions needing a category', () => {
  it.each([
    { kind: 'income', category: '', expected: true },
    { kind: 'income', category: '  \t ', expected: true },
    { kind: 'expense', category: '', expected: true },
    { kind: 'expense', category: '  \t ', expected: true },
    { kind: 'income', category: 'Salary', expected: false },
    { kind: 'expense', category: 'Food', expected: false },
    { kind: 'transfer', category: '', expected: false },
    { kind: 'transfer', category: '  ', expected: false },
  ] as const)('identifies $kind with category "$category" as pending: $expected', ({ kind, category, expected }) => {
    expect(needsTransactionCategory({ kind, category })).toBe(expected);
  });
});

describe('pending category reviews', () => {
  it('includes expenses, refunds and work entries from all tracked months', () => {
    const data = fixture();
    data.transactions = [
      transaction('october', { description: 'Keep my optional note', scope: 'personal' }),
      transaction('november', { date: '2032-11-02', month: '2032-12', scope: 'work' }),
      transaction('refund', { date: '2032-10-15', amountCents: 500, category: '  ' }),
    ];
    const before = structuredClone(data);
    const queue = getPendingCategoryReviews(data);
    expect(queue.map(item => item.id)).toEqual(['november', 'refund', 'october']);
    expect(queue.find(item => item.id === 'october')).toEqual(data.transactions[0]);
    expect(data).toEqual(before);
  });

  it('includes positive income and negative income reversals without changing their kind or amount', () => {
    const data = fixture();
    data.transactions = [
      transaction('income', { kind: 'income', amountCents: 2_000, date: '2032-10-15' }),
      transaction('income-reversal', { kind: 'income', amountCents: -500, category: ' \t ' }),
    ];
    const before = structuredClone(data);
    expect(getPendingCategoryReviews(data)).toEqual(data.transactions);
    expect(data).toEqual(before);
  });

  it('excludes categorized, deleted, transfer and pre-start purchase entries', () => {
    const data = fixture();
    data.transactions = [
      transaction('pending'), transaction('reviewed', { category: 'Food' }),
      transaction('archived-assignment', { category: 'Retired' }),
      transaction('deleted', { deletedAt: STAMP }),
      transaction('categorized-income', { kind: 'income', amountCents: 2_000, category: 'Salary' }),
      transaction('deleted-income', { kind: 'income', amountCents: 2_000, deletedAt: STAMP }),
      transaction('older-income', { kind: 'income', date: '2032-09-30', month: '2032-11' }),
      transaction('transfer', { kind: 'transfer' }),
      transaction('older-purchase', { date: '2032-09-30', month: '2032-11' }),
    ];
    expect(getPendingCategoryReviews(data).map(item => item.id)).toEqual(['pending']);
  });

  it('orders same-day entries by merchant and identity independently of import order', () => {
    const data = fixture();
    data.transactions = [
      transaction('z', { originalDescription: 'Alpha' }),
      transaction('b', { originalDescription: 'Beta' }),
      transaction('a', { originalDescription: 'Alpha' }),
      transaction('newest', { date: '2032-10-15' }),
    ];
    const expected = ['newest', 'a', 'z', 'b'];
    expect(getPendingCategoryReviews(data).map(item => item.id)).toEqual(expected);
    data.transactions.reverse();
    expect(getPendingCategoryReviews(data).map(item => item.id)).toEqual(expected);
  });

  it('uses purchase dates for cards and the stored reporting month for other sources', () => {
    const data = fixture();
    data.transactions = [
      transaction('card-with-older-metadata', { date: '2032-10-01', month: '2032-09' }),
      transaction('bank-outside-period', { source: 'bank', month: '2032-09' }),
      transaction('manual-current-period', { source: 'manual', month: '2032-10' }),
    ];
    expect(getPendingCategoryReviews(data).map(item => item.id)).toEqual(['manual-current-period', 'card-with-older-metadata']);
  });

  it('supports an empty queue and data without a configured reporting boundary', () => {
    const data = fixture();
    expect(getPendingCategoryReviews(data)).toEqual([]);
    delete data.reporting;
    data.transactions = [transaction('older', { date: '2032-09-01', month: '2032-09' })];
    expect(getPendingCategoryReviews(data).map(item => item.id)).toEqual(['older']);
  });
});

describe('category review popularity', () => {
  it('ranks by transaction count instead of amounts and counts work expenses and refunds', () => {
    const data = fixture();
    data.transactions = [
      transaction('food', { category: 'Food', amountCents: -100 }),
      transaction('food-work', { category: 'Food', scope: 'work', amountCents: -100 }),
      transaction('food-refund', { category: 'Food', amountCents: 100 }),
      transaction('travel', { category: 'Travel', amountCents: -500_000 }),
    ];
    const before = structuredClone(data);
    expect(getRankedReviewCategories(data)).toEqual(['Food', 'Travel', 'Bills']);
    expect(data).toEqual(before);
  });

  it('combines canonical category names and aliases with case and whitespace normalization', () => {
    const data = fixture();
    data.transactions = [
      transaction('canonical', { category: ' food ' }),
      transaction('alias', { category: '  MEALS  ' }),
      transaction('travel', { category: 'Travel' }),
    ];
    expect(getRankedReviewCategories(data)).toEqual(['Food', 'Travel', 'Bills']);
  });

  it('counts positive income and negative income reversals by category without changing transaction semantics', () => {
    const data = fixture();
    data.transactions = [
      transaction('income', { category: 'Bills', kind: 'income', amountCents: 2_000 }),
      transaction('income-reversal', { category: 'Bills', kind: 'income', amountCents: -500 }),
      transaction('travel', { category: 'Travel' }),
      transaction('food', { category: 'Food' }),
    ];
    const before = structuredClone(data);
    expect(getRankedReviewCategories(data)).toEqual(['Bills', 'Food', 'Travel']);
    expect(data).toEqual(before);
  });

  it('ignores inactive records, transfers, unregistered labels and archived choices', () => {
    const data = fixture();
    data.transactions = [
      transaction('travel', { category: 'Travel' }),
      transaction('deleted', { category: 'Food', deletedAt: STAMP }),
      transaction('deleted-income', { category: 'Food', kind: 'income', deletedAt: STAMP }),
      transaction('older-income', { category: 'Food', kind: 'income', date: '2032-09-30' }),
      transaction('transfer', { category: 'Food', kind: 'transfer' }),
      transaction('before-start', { category: 'Food', date: '2032-09-30' }),
      transaction('unknown', { category: 'Unregistered' }),
      transaction('archived', { category: 'Retired' }),
      transaction('archived-alias', { category: 'Previous label' }),
    ];
    expect(getRankedReviewCategories(data)).toEqual(['Travel', 'Bills', 'Food']);
  });

  it('resolves ties using catalog name order regardless of catalog or transaction order', () => {
    const data = fixture();
    expect(getRankedReviewCategories(data)).toEqual(['Bills', 'Food', 'Travel']);
    data.transactions = [transaction('food', { category: 'Food' }), transaction('bills', { category: 'Bills' })];
    expect(getRankedReviewCategories(data)).toEqual(['Bills', 'Food', 'Travel']);
    data.categories.reverse();
    data.transactions.reverse();
    expect(getRankedReviewCategories(data)).toEqual(['Bills', 'Food', 'Travel']);
  });

  it('returns no choices when all categories are archived or absent', () => {
    const data = fixture();
    data.categories = data.categories.filter(item => item.archivedAt);
    expect(getRankedReviewCategories(data)).toEqual([]);
    data.categories = [];
    expect(getRankedReviewCategories(data)).toEqual([]);
  });
});
