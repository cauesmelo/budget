import { describe, expect, it } from 'vitest';
import { deleteCategory, renameCategory } from '../src/lib/categories';
import { createEmptyData, mergeFinanceData, planAmountForMonth, summarizeMonth } from '../src/lib/finance';
import { addMonthlyBudgetExpense, getMonthlyBudgetReview } from '../src/lib/monthlyBudget';
import { serializeBackup, validateBackup } from '../src/lib/storage';
import type { Category, FinanceData, PlanItem, Transaction } from '../src/lib/types';

const NOW = '2032-10-15T12:00:00.000Z';
const category = (id: string, name: string, patch: Partial<Category> = {}): Category => ({ id, name, updatedAt: NOW, ...patch });
const plan = (id: string, patch: Partial<PlanItem> = {}): PlanItem => ({
  id, name: 'Example planned expense', category: 'Food', kind: 'expense', defaultAmountCents: 10_000,
  amounts: {}, startMonth: '2032-10', updatedAt: NOW, ...patch,
});

describe('adding a monthly category budget', () => {
  it('adds a canonical expense plan for this month only and preserves all existing records', () => {
    const data = renameCategory(fixture(), 'food', 'Dining', new Date(NOW));
    data.planItems = [plan('home', { category: 'Home' })];
    data.planOrder = { ids: ['home'], updatedAt: NOW };
    const before = structuredClone(data);
    const stamp = new Date('2032-10-16T12:00:00.000Z');
    const next = addMonthlyBudgetExpense(data, 'Food', '2032-10', 12_345, stamp);
    const added = next.planItems.find(item => item.id !== 'home')!;
    expect(added).toMatchObject({
      name: 'Dining', category: 'Dining', kind: 'expense', behavior: 'monthly',
      defaultAmountCents: 0, amounts: { '2032-10': 12_345 }, startMonth: '2032-10', updatedAt: stamp.toISOString(),
    });
    expect(added.id).toBeTruthy();
    expect(added.endMonth).toBeUndefined();
    expect(planAmountForMonth(added, '2032-09')).toBe(0);
    expect(planAmountForMonth(added, '2032-10')).toBe(12_345);
    expect(planAmountForMonth(added, '2032-11')).toBe(0);
    expect(next.planOrder?.ids).toEqual(['home', added.id]);
    expect(next.updatedAt).toBe(stamp.toISOString());
    expect(next.planItems[0]).toEqual(data.planItems[0]);
    expect(getMonthlyBudgetReview(next, '2032-10').rows.find(row => row.category === 'Dining')).toMatchObject({ plannedCents: 12_345, planItemIds: [added.id] });
    expect(data).toEqual(before);
  });

  it('rejects an existing active assigned expense even when its budget is explicitly zero', () => {
    const data = renameCategory(fixture(), 'food', 'Dining', new Date(NOW));
    data.planItems = [plan('zero', { category: 'Food', amounts: { '2032-10': 0 } })];
    expect(() => addMonthlyBudgetExpense(data, 'Dining', '2032-10', 1_000)).toThrow('already has planned expenses');
  });

  it('allows adding a budget when matching records are deleted, outside their interval, or another kind', () => {
    const data = fixture();
    data.planItems = [
      plan('deleted', { deletedAt: NOW }), plan('future', { startMonth: '2032-11' }),
      plan('past', { startMonth: '2032-01', endMonth: '2032-09' }),
      plan('income', { kind: 'income' }), plan('saving', { kind: 'contribution' }),
    ];
    const next = addMonthlyBudgetExpense(data, 'Food', '2032-10', 1_000, new Date(NOW));
    expect(getMonthlyBudgetReview(next, '2032-10').plannedCents).toBe(1_000);
    expect(next.planItems).toHaveLength(6);
  });

  it('round-trips the existing plan shape through backups and merges without losing the month amount', () => {
    const data = fixture();
    const next = addMonthlyBudgetExpense(data, 'Food', '2032-10', 12_345, new Date(NOW));
    const restored = validateBackup(serializeBackup(next));
    const merged = mergeFinanceData(restored, data);
    const added = next.planItems[0];
    expect(restored.planItems.find(item => item.id === added.id)).toEqual(added);
    expect(merged.planItems.find(item => item.id === added.id)).toEqual(added);
    expect(getMonthlyBudgetReview(merged, '2032-10').plannedCents).toBe(12_345);
    expect(getMonthlyBudgetReview(merged, '2032-11').plannedCents).toBe(0);
  });

  it('requires a live available category, safe positive amount, valid date, and an eligible month', () => {
    const data = fixture();
    data.categories.push(category('archived', 'Archived', { archivedAt: NOW }), category('deleted', 'Deleted', { deletedAt: NOW }));
    data.reporting = { startMonth: '2032-10', resetId: 'example-reset', updatedAt: NOW };
    for (const name of ['', '   ', 'Unknown', 'Archived', 'Deleted']) expect(() => addMonthlyBudgetExpense(data, name, '2032-10', 1_000)).toThrow('category');
    expect(() => addMonthlyBudgetExpense(data, 'Food', '2032-13', 1_000)).toThrow('Invalid month');
    expect(() => addMonthlyBudgetExpense(data, 'Food', '2032-09', 1_000)).toThrow('reporting period');
    for (const amount of [0, -1]) expect(() => addMonthlyBudgetExpense(data, 'Food', '2032-10', amount)).toThrow('greater than zero');
    for (const amount of [0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => addMonthlyBudgetExpense(data, 'Food', '2032-10', amount)).toThrow('supported monetary range');
    expect(() => addMonthlyBudgetExpense(data, 'Food', '2032-10', 1_000, new Date(NaN))).toThrow('Invalid date');
  });

  it('checks that a new category budget cannot overflow the current month totals or remaining amount', () => {
    const data = fixture();
    data.planItems = [plan('home', { category: 'Home', defaultAmountCents: Number.MAX_SAFE_INTEGER })];
    expect(() => addMonthlyBudgetExpense(data, 'Food', '2032-10', 1)).toThrow('supported monetary range');
    data.planItems = [];
    data.transactions = [transaction('refund', Number.MAX_SAFE_INTEGER, { kind: 'expense' })];
    expect(() => addMonthlyBudgetExpense(data, 'Food', '2032-10', 1)).toThrow('supported monetary range');
  });
});
const transaction = (id: string, amountCents: number, patch: Partial<Transaction> = {}): Transaction => ({
  id, fingerprint: id, date: '2032-10-05', month: '2032-10', amountCents,
  kind: amountCents > 0 ? 'income' : 'expense', source: 'bank', account: 'Example account',
  originalDescription: 'Example transaction', description: '', category: 'Food', updatedAt: NOW, ...patch,
});
function fixture(): FinanceData {
  const data = createEmptyData(new Date(NOW));
  data.categories = [category('food', 'Food'), category('home', 'Home'), category('travel', 'Travel')];
  return data;
}

describe('monthly category budget review', () => {
  it('lists every active category and keeps a month without records explicit', () => {
    const data = fixture();
    const review = getMonthlyBudgetReview(data, '2032-10');
    expect(review).toMatchObject({
      month: '2032-10', plannedCents: 0, spentCents: 0, remainingCents: 0,
      unassignedPlanCents: 0, unassignedPlanItemCount: 0, uncategorizedCount: 0,
      personalExpenseCount: 0, hasRecordedExpenses: false, workInCents: 0, workOutCents: 0,
    });
    expect(review.rows.map(row => row.category)).toEqual(['Food', 'Home', 'Travel']);
    expect(review.rows.every(row => row.kind === 'category' && row.plannedCents === 0 && row.spentCents === 0 && row.transactionCount === 0)).toBe(true);
    expect(getMonthlyBudgetReview(createEmptyData(new Date(NOW)), '2032-10').rows).toEqual([]);
  });

  it('combines plan items within a category and compares personal spending net of expense refunds', () => {
    const data = fixture();
    data.planItems = [plan('groceries'), plan('dining', { defaultAmountCents: 5_000 })];
    data.planOrder = { ids: ['dining', 'groceries'], updatedAt: NOW };
    data.transactions = [transaction('purchase', -18_000), transaction('refund', 2_000, { kind: 'expense' })];
    const before = structuredClone(data);
    const review = getMonthlyBudgetReview(data, '2032-10');
    expect(review.rows.find(row => row.category === 'Food')).toEqual({
      key: 'category:food', kind: 'category', category: 'Food', label: 'Food', plannedCents: 15_000,
      spentCents: 16_000, remainingCents: -1_000, planItemIds: ['dining', 'groceries'], transactionCount: 2, archived: false,
    });
    expect(review).toMatchObject({ plannedCents: 15_000, spentCents: 16_000, remainingCents: -1_000, personalExpenseCount: 2, hasRecordedExpenses: true });
    expect(data).toEqual(before);
  });

  it('never pairs uncategorized spending with unassigned plan amounts or guesses from item names', () => {
    const data = fixture();
    data.planItems = [plan('unmapped', { name: 'Food', category: '', defaultAmountCents: 8_000 })];
    data.transactions = [transaction('unreviewed', -3_000, { category: '' })];
    const review = getMonthlyBudgetReview(data, '2032-10');
    expect(review.rows.find(row => row.category === 'Food')).toMatchObject({ plannedCents: 0, spentCents: 0, planItemIds: [] });
    expect(review.rows.find(row => row.kind === 'uncategorized')).toMatchObject({ key: 'uncategorized', category: '', plannedCents: 0, spentCents: 3_000, remainingCents: -3_000, planItemIds: [], transactionCount: 1 });
    expect(review.rows.find(row => row.kind === 'unassigned-plan')).toMatchObject({ key: 'unassigned-plan', category: '', plannedCents: 8_000, spentCents: 0, remainingCents: 8_000, planItemIds: ['unmapped'], transactionCount: 0 });
    expect(review).toMatchObject({ plannedCents: 8_000, spentCents: 3_000, remainingCents: 5_000, unassignedPlanCents: 8_000, unassignedPlanItemCount: 1, uncategorizedCount: 1 });
  });

  it('includes only expense plans in their active interval and respects overrides including zero', () => {
    const data = fixture();
    data.planItems = [
      plan('zero', { amounts: { '2032-10': 0 } }),
      plan('starts-now', { startMonth: '2032-10', defaultAmountCents: 3_000 }),
      plan('ends-now', { startMonth: '2032-01', endMonth: '2032-10', defaultAmountCents: 2_000 }),
      plan('income', { kind: 'income' }), plan('savings', { kind: 'contribution' }),
      plan('deleted', { deletedAt: NOW }), plan('future', { startMonth: '2032-11' }),
      plan('past', { startMonth: '2032-01', endMonth: '2032-09' }),
    ];
    const review = getMonthlyBudgetReview(data, '2032-10');
    expect(review.rows.find(row => row.category === 'Food')).toMatchObject({ plannedCents: 5_000, planItemIds: ['zero', 'starts-now', 'ends-now'] });
    expect(review.plannedCents).toBe(5_000);
  });

  it('uses by-month and installment amounts through the same calculation as projections', () => {
    const data = fixture();
    data.planItems = [
      plan('variable', { behavior: 'monthly', defaultAmountCents: 50_000, amounts: { '2032-10': 2_000 } }),
      plan('installments', {
        behavior: 'installments', defaultAmountCents: 90_000,
        installments: [{ id: 'schedule', name: 'Example purchase', amountCents: 3_000, firstMonth: '2032-10', count: 2 }],
      }),
    ];
    expect(getMonthlyBudgetReview(data, '2032-10').plannedCents).toBe(5_000);
    expect(getMonthlyBudgetReview(data, '2032-11').plannedCents).toBe(3_000);
    expect(getMonthlyBudgetReview(data, '2032-12').plannedCents).toBe(0);
  });

  it('retains zero-budget plan IDs and unmapped zero items for later editing', () => {
    const data = fixture();
    data.planItems = [plan('zero', { amounts: { '2032-10': 0 } }), plan('unmapped-zero', { category: '', defaultAmountCents: 0 })];
    const review = getMonthlyBudgetReview(data, '2032-10');
    expect(review.rows.find(row => row.category === 'Food')?.planItemIds).toEqual(['zero']);
    expect(review.rows.find(row => row.kind === 'unassigned-plan')).toMatchObject({ plannedCents: 0, planItemIds: ['unmapped-zero'] });
    expect(review.unassignedPlanItemCount).toBe(1);
  });

  it('separates BCG expenses, reimbursements, and credits with the same sign semantics as monthly totals', () => {
    const data = fixture();
    data.work = { label: 'BCG', expenseCategories: ['Business'], updatedAt: NOW };
    data.transactions = [
      transaction('personal', -5_000), transaction('work', -10_000, { scope: 'work' }),
      transaction('rule', -2_000, { category: 'Business' }),
      transaction('refund', 1_000, { kind: 'expense', scope: 'work' }),
      transaction('reimbursement', 8_000, { scope: 'work' }),
      transaction('reimbursement-reversal', -500, { kind: 'income', scope: 'work' }),
      transaction('salary', 90_000),
    ];
    const review = getMonthlyBudgetReview(data, '2032-10');
    const summary = summarizeMonth(data, '2032-10');
    expect(review).toMatchObject({ spentCents: 5_000, workInCents: 9_000, workOutCents: 12_500, personalExpenseCount: 1 });
    expect(review.spentCents).toBe(summary.expenseCents);
    expect(review.workInCents).toBe(summary.workInCents);
    expect(review.workOutCents).toBe(summary.workOutCents);
    expect(review.rows.some(row => row.category === 'Business')).toBe(false);
  });

  it('ignores income, transfers, deleted records, and another month without treating them as missing categories', () => {
    const data = fixture();
    data.transactions = [
      transaction('income', 5_000, { category: '' }),
      transaction('transfer-out', -3_000, { kind: 'transfer', category: '' }),
      transaction('transfer-in', 3_000, { kind: 'transfer', category: '' }),
      transaction('deleted', -8_000, { deletedAt: NOW, category: '' }),
      transaction('other-month', -2_000, { month: '2032-11', category: '' }),
      transaction('deleted-work', -1_000, { deletedAt: NOW, scope: 'work' }),
    ];
    expect(getMonthlyBudgetReview(data, '2032-10')).toMatchObject({ spentCents: 0, personalExpenseCount: 0, uncategorizedCount: 0, hasRecordedExpenses: false, workOutCents: 0 });
  });

  it('counts card spending in the purchase month and honors the reporting start month', () => {
    const data = fixture();
    data.reporting = { startMonth: '2032-10', resetId: 'example-reset', updatedAt: NOW };
    data.transactions = [
      transaction('november-bill', -5_000, { source: 'card', date: '2032-10-12', month: '2032-11' }),
      transaction('september-purchase', -8_000, { source: 'card', date: '2032-09-12', month: '2032-10' }),
      transaction('november-purchase', -9_000, { source: 'card', date: '2032-11-02', month: '2032-10' }),
      transaction('prior-bank-month', -4_000, { date: '2032-09-12', month: '2032-09' }),
    ];
    expect(getMonthlyBudgetReview(data, '2032-10')).toMatchObject({ spentCents: 5_000, personalExpenseCount: 1 });
    expect(getMonthlyBudgetReview(data, '2032-09')).toMatchObject({ spentCents: 0, personalExpenseCount: 0 });
    expect(getMonthlyBudgetReview(data, '2032-11')).toMatchObject({ spentCents: 9_000, personalExpenseCount: 1 });
  });

  it('keeps refund-only months signed and recorded rather than hiding a net credit', () => {
    const data = fixture();
    data.planItems = [plan('budget')];
    data.transactions = [transaction('refund', 2_000, { kind: 'expense' }), transaction('unassigned-refund', 500, { kind: 'expense', category: '' })];
    const review = getMonthlyBudgetReview(data, '2032-10');
    expect(review).toMatchObject({ plannedCents: 10_000, spentCents: -2_500, remainingCents: 12_500, hasRecordedExpenses: true, uncategorizedCount: 1 });
    expect(review.rows.find(row => row.category === 'Food')).toMatchObject({ spentCents: -2_000, remainingCents: 12_000 });
    expect(review.rows.find(row => row.kind === 'uncategorized')).toMatchObject({ spentCents: -500, remainingCents: 500 });
  });

  it('shows archived and unknown categories only when there is budget or recorded spending activity', () => {
    const data = fixture();
    data.categories.push(category('archived-unused', 'Archived unused', { archivedAt: NOW }), category('archived-used', 'Archived used', { archivedAt: NOW }));
    data.planItems = [
      plan('archived-budget', { category: 'Archived used', defaultAmountCents: 2_000 }),
      plan('unknown-zero', { category: 'Unknown zero', defaultAmountCents: 0 }),
      plan('unknown-budget', { category: 'Unknown budget', defaultAmountCents: 1_000 }),
    ];
    data.transactions = [transaction('unknown-credit', 500, { category: 'Unknown credit', kind: 'expense' })];
    const rows = getMonthlyBudgetReview(data, '2032-10').rows;
    expect(rows.some(row => row.category === 'Archived unused' || row.category === 'Unknown zero')).toBe(false);
    expect(rows.find(row => row.category === 'Archived used')).toMatchObject({ plannedCents: 2_000, archived: true });
    expect(rows.find(row => row.category === 'Unknown budget')).toMatchObject({ plannedCents: 1_000, archived: false });
    expect(rows.find(row => row.category === 'Unknown credit')).toMatchObject({ spentCents: -500 });
  });

  it('preserves zero-net spending activity for an archived category', () => {
    const data = fixture();
    data.categories.push(category('archived', 'Archived', { archivedAt: NOW }));
    data.transactions = [transaction('expense', -1_000, { category: 'Archived' }), transaction('refund', 1_000, { category: 'Archived', kind: 'expense' })];
    expect(getMonthlyBudgetReview(data, '2032-10').rows.find(row => row.category === 'Archived')).toMatchObject({ spentCents: 0, transactionCount: 2, archived: true });
  });

  it('resolves renamed categories, case variants, and aliases under the stable catalog ID', () => {
    const data = renameCategory(fixture(), 'food', 'Dining', new Date(NOW));
    data.planItems = [plan('old-label')];
    data.transactions = [transaction('old-label', -1_000), transaction('variant', -2_000, { category: '  DINING  ' })];
    const review = getMonthlyBudgetReview(data, '2032-10');
    expect(review.rows.find(row => row.category === 'Dining')).toMatchObject({ key: 'category:food', plannedCents: 10_000, spentCents: 3_000, transactionCount: 2 });
    expect(review.rows.some(row => row.category === 'Food')).toBe(false);
  });

  it('follows deleted-category replacements for stale assignments and clears a deleted category without replacement', () => {
    const data = fixture();
    data.planItems = [plan('old-plan')];
    data.transactions = [transaction('old-transaction', -2_000)];
    const deleted = deleteCategory(data, 'food', 'Home', new Date(NOW));
    // Simulate assignments from a stale device or import preview before normalization.
    deleted.planItems[0].category = 'Food';
    deleted.transactions[0].category = 'Food';
    expect(getMonthlyBudgetReview(deleted, '2032-10').rows.find(row => row.category === 'Home')).toMatchObject({ plannedCents: 10_000, spentCents: 2_000 });
    deleted.categories.push(category('removed', 'Removed', { deletedAt: NOW }));
    deleted.planItems.push(plan('removed-plan', { category: 'Removed', defaultAmountCents: 500 }));
    deleted.transactions.push(transaction('removed-expense', -200, { category: 'Removed' }));
    const review = getMonthlyBudgetReview(deleted, '2032-10');
    expect(review).toMatchObject({ unassignedPlanCents: 500, unassignedPlanItemCount: 1, uncategorizedCount: 1 });
    expect(review.rows.some(row => row.category === 'Food' || row.category === 'Removed')).toBe(false);
  });

  it('keeps category-name edge cases safe and groups equivalent unknown names without changing source data', () => {
    const data = fixture();
    data.planItems = [plan('prototype', { category: '__proto__', defaultAmountCents: 300 }), plan('unknown', { category: 'New label', defaultAmountCents: 1_000 })];
    data.transactions = [transaction('unknown', -200, { category: ' NEW   LABEL ' }), transaction('prototype', -100, { category: '__proto__' })];
    const before = structuredClone(data);
    const review = getMonthlyBudgetReview(data, '2032-10');
    expect(review.rows.find(row => row.category === '__proto__')).toMatchObject({ plannedCents: 300, spentCents: 100, remainingCents: 200 });
    expect(review.rows.find(row => row.category === 'New label')).toMatchObject({ plannedCents: 1_000, spentCents: 200, remainingCents: 800 });
    expect(data).toEqual(before);
  });

  it('reconciles every displayed row with the personal totals including unmapped plans and uncategorized spending', () => {
    const data = fixture();
    data.planItems = [plan('food'), plan('home', { category: 'Home', defaultAmountCents: 20_000 }), plan('unmapped', { category: '', defaultAmountCents: 3_000 })];
    data.transactions = [transaction('food', -5_000), transaction('home', -30_000, { category: 'Home' }), transaction('refund', 1_000, { kind: 'expense' }), transaction('unreviewed', -2_000, { category: '' })];
    const review = getMonthlyBudgetReview(data, '2032-10');
    expect(review.rows.reduce((total, row) => total + row.plannedCents, 0)).toBe(review.plannedCents);
    expect(review.rows.reduce((total, row) => total + row.spentCents, 0)).toBe(review.spentCents);
    expect(review.rows.reduce((total, row) => total + row.remainingCents, 0)).toBe(review.remainingCents);
    expect(review.rows.reduce((total, row) => total + row.transactionCount, 0)).toBe(review.personalExpenseCount);
    expect(review).toMatchObject({ plannedCents: 33_000, spentCents: 36_000, remainingCents: -3_000 });
  });

  it('reviews an applicable plan beyond the forecast display horizon without truncating budgets', () => {
    const data = fixture();
    data.settings.horizonMonths = 1;
    data.planItems = [plan('ongoing')];
    expect(getMonthlyBudgetReview(data, '2035-04').plannedCents).toBe(10_000);
  });

  it('rejects invalid months and unsafe monetary inputs, category sums, differences, or work cash flow', () => {
    const data = fixture();
    expect(() => getMonthlyBudgetReview(data, '2032-13')).toThrow('Invalid month');
    data.planItems = [plan('invalid', { defaultAmountCents: 0.5 })];
    expect(() => getMonthlyBudgetReview(data, '2032-10')).toThrow('supported monetary range');
    data.planItems = [];
    data.transactions = [transaction('invalid', -0.5)];
    expect(() => getMonthlyBudgetReview(data, '2032-10')).toThrow('supported monetary range');
    data.transactions = [transaction('large', -Number.MAX_SAFE_INTEGER), transaction('small', -1)];
    expect(() => getMonthlyBudgetReview(data, '2032-10')).toThrow('supported monetary range');
    data.transactions = [transaction('large', -Number.MAX_SAFE_INTEGER), transaction('small', -1, { category: 'Home' })];
    expect(() => getMonthlyBudgetReview(data, '2032-10')).toThrow('supported monetary range');
    data.planItems = [plan('large-plan', { defaultAmountCents: Number.MAX_SAFE_INTEGER })];
    data.transactions = [transaction('refund', 1, { kind: 'expense' })];
    expect(() => getMonthlyBudgetReview(data, '2032-10')).toThrow('supported monetary range');
    data.planItems = [];
    data.transactions = [transaction('work-large', -Number.MAX_SAFE_INTEGER, { scope: 'work' }), transaction('work-small', -1, { scope: 'work' })];
    expect(() => getMonthlyBudgetReview(data, '2032-10')).toThrow('supported monetary range');
  });
});
