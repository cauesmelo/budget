import { describe, expect, it } from 'vitest';
import { createEmptyData, projectReserve } from '../src/lib/finance';
import { getBudgetComparison, getCategorySpending, getReserveCoverage, getReserveInsights } from '../src/lib/insights';
import type { FinanceData, PlanItem, Transaction } from '../src/lib/types';

const NOW = '2032-10-10T12:00:00.000Z';
const plan = (id: string, patch: Partial<PlanItem> = {}): PlanItem => ({
  id, name: 'Example expense', category: '', kind: 'expense', defaultAmountCents: 10_000,
  amounts: {}, startMonth: '2032-10', updatedAt: NOW, ...patch,
});
const transaction = (id: string, amountCents: number, patch: Partial<Transaction> = {}): Transaction => ({
  id, fingerprint: id, date: '2032-10-05', month: '2032-10', amountCents,
  kind: amountCents > 0 ? 'income' : 'expense', source: 'bank', account: 'Example account',
  originalDescription: 'Example transaction', description: '', category: 'Food', updatedAt: NOW, ...patch,
});
function fixture(): FinanceData {
  const data = createEmptyData(new Date(NOW));
  data.settings.horizonMonths = 3;
  return data;
}

describe('reserve goals and shortfalls', () => {
  it('keeps an unset goal distinct from a target already reached and reports growth', () => {
    const data = fixture();
    data.settings.initialReserveCents = 50_000;
    data.planItems = [plan('income', { kind: 'income', defaultAmountCents: 10_000 })];
    const insights = getReserveInsights(projectReserve(data), 0);
    expect(insights).toMatchObject({ openingCents: 50_000, closingCents: 80_000, growthCents: 30_000, firstShortfall: null });
    expect(insights.goal).toEqual({ amountCents: 0, status: 'unset', month: null, timing: null, progressPercent: null, remainingCents: 0, laterBelowMonth: null });
    expect(getReserveInsights(projectReserve(data), 25_000).goal).toMatchObject({ status: 'already-reached', month: '2032-10', timing: 'start', progressPercent: 200, remainingCents: 0 });
  });

  it('uses the first month opening at or above the goal instead of shifting it one month early', () => {
    const data = fixture();
    data.planItems = [plan('income', { kind: 'income', defaultAmountCents: 10_000 })];
    expect(getReserveInsights(projectReserve(data), 20_000).goal).toMatchObject({
      status: 'projected', month: '2032-12', timing: 'start', progressPercent: 0, remainingCents: 20_000,
    });
  });

  it('labels a goal reached in the final closing balance as end of month', () => {
    const data = fixture();
    data.planItems = [plan('income', { kind: 'income', defaultAmountCents: 10_000 })];
    expect(getReserveInsights(projectReserve(data), 30_000).goal).toMatchObject({ status: 'projected', month: '2032-12', timing: 'end' });
  });

  it('reports outside the horizon without extrapolating or claiming a goal is impossible', () => {
    const data = fixture();
    data.planItems = [plan('income', { kind: 'income', defaultAmountCents: 10_000 })];
    expect(getReserveInsights(projectReserve(data), 40_000).goal).toMatchObject({ status: 'outside-horizon', month: null, timing: null, remainingCents: 40_000 });
  });

  it('warns when a projected goal is reached then falls below the target again', () => {
    const data = fixture();
    data.planItems = [
      plan('income', { kind: 'income', behavior: 'monthly', amounts: { '2032-10': 20_000 } }),
      plan('one-off', { behavior: 'monthly', amounts: { '2032-11': 5_000 } }),
    ];
    expect(getReserveInsights(projectReserve(data), 20_000).goal).toMatchObject({ status: 'projected', month: '2032-11', timing: 'start', laterBelowMonth: '2032-11' });
  });

  it('checks for a later drop even if the starting reserve already meets the goal', () => {
    const data = fixture();
    data.settings.initialReserveCents = 20_000;
    data.planItems = [plan('spending', { defaultAmountCents: 5_000 })];
    expect(getReserveInsights(projectReserve(data), 20_000).goal).toMatchObject({ status: 'already-reached', laterBelowMonth: '2032-10' });
  });

  it('identifies the first negative closing balance and preserves the shortage as a positive amount', () => {
    const data = fixture();
    data.settings.initialReserveCents = 15_000;
    data.planItems = [plan('spending')];
    expect(getReserveInsights(projectReserve(data), 50_000).firstShortfall).toEqual({ month: '2032-11', amountCents: 5_000, timing: 'end' });
  });

  it('identifies a negative opening reserve even when income resolves it within the first month', () => {
    const data = fixture();
    data.settings.initialReserveCents = -5_000;
    data.planItems = [plan('income', { kind: 'income', defaultAmountCents: 10_000 })];
    const insights = getReserveInsights(projectReserve(data), 20_000);
    expect(insights.firstShortfall).toEqual({ month: '2032-10', amountCents: 5_000, timing: 'start' });
    expect(insights.goal.progressPercent).toBe(-25);
    expect(insights.goal.remainingCents).toBe(25_000);
  });

  it('does not treat zero reserve as a shortfall or an empty projection as an achieved goal', () => {
    expect(getReserveInsights(projectReserve(fixture()), 5_000).firstShortfall).toBeNull();
    expect(getReserveInsights([], 5_000)).toMatchObject({ openingCents: 0, closingCents: 0, growthCents: 0, goal: { status: 'outside-horizon' }, firstShortfall: null });
  });

  it('rejects invalid goal amounts, projection months, and unsafe monetary differences', () => {
    const rows = projectReserve(fixture());
    expect(() => getReserveInsights(rows, -1)).toThrow('cannot be negative');
    expect(() => getReserveInsights(rows, 0.5)).toThrow('supported monetary range');
    expect(() => getReserveInsights([{ ...rows[0], month: 'bad' }], 1)).toThrow('Invalid projection month');
    expect(() => getReserveInsights([{ ...rows[0], openingCents: -Number.MAX_SAFE_INTEGER }], Number.MAX_SAFE_INTEGER)).toThrow('supported monetary range');
  });
});

describe('budget compared with recorded activity', () => {
  it('compares personal spending net of refunds without counting work, transfers, or deletions', () => {
    const data = fixture();
    data.planItems = [plan('spending'), plan('income', { kind: 'income', defaultAmountCents: 30_000 }), plan('saving', { kind: 'contribution', defaultAmountCents: 3_000 })];
    data.work = { label: 'Work', expenseCategories: ['Business'], updatedAt: NOW };
    data.transactions = [
      transaction('salary', 30_000), transaction('purchase', -8_000),
      transaction('refund', 2_000, { kind: 'expense' }),
      transaction('payment', -10_000, { kind: 'transfer' }),
      transaction('work', -4_000, { scope: 'work' }),
      transaction('work-rule', -5_000, { category: 'Business' }),
      transaction('reimbursement', 9_000, { scope: 'work' }),
      transaction('deleted', -1_000, { deletedAt: NOW }),
      transaction('other-month', -5_000, { month: '2032-11' }),
    ];
    const before = structuredClone(data);
    expect(getBudgetComparison(data, '2032-10')).toEqual({
      month: '2032-10', plannedIncomeCents: 30_000, plannedExpenseCents: 10_000,
      recordedIncomeCents: 30_000, recordedExpenseCents: 6_000, remainingCents: 4_000,
      transactionCount: 3, hasRecordedIncome: true, hasRecordedExpenses: true,
    });
    expect(data).toEqual(before);
  });

  it('keeps missing records explicit instead of treating the comparison as a completed month', () => {
    const data = fixture();
    data.planItems = [plan('spending')];
    expect(getBudgetComparison(data, '2032-10')).toMatchObject({ remainingCents: 10_000, recordedExpenseCents: 0, transactionCount: 0, hasRecordedIncome: false, hasRecordedExpenses: false });
    data.transactions = [transaction('salary', 30_000)];
    expect(getBudgetComparison(data, '2032-10')).toMatchObject({ transactionCount: 1, hasRecordedIncome: true, hasRecordedExpenses: false });
  });

  it('returns no comparison without an applicable expense budget or outside the planning horizon', () => {
    const data = fixture();
    expect(getBudgetComparison(data, '2032-10')).toBeNull();
    data.planItems = [plan('income', { kind: 'income' }), plan('deleted', { deletedAt: NOW }), plan('future', { startMonth: '2032-11' })];
    expect(getBudgetComparison(data, '2032-10')).toBeNull();
    expect(getBudgetComparison(data, '2032-11')).not.toBeNull();
    expect(getBudgetComparison(data, '2033-01')).toBeNull();
    expect(getBudgetComparison(data, '2032-09')).toBeNull();
  });

  it('keeps an explicitly zero budget valid and preserves overspending as a negative remainder', () => {
    const data = fixture();
    data.planItems = [plan('spending', { amounts: { '2032-10': 0 } })];
    data.transactions = [transaction('purchase', -3_000)];
    expect(getBudgetComparison(data, '2032-10')).toMatchObject({ plannedExpenseCents: 0, recordedExpenseCents: 3_000, remainingCents: -3_000 });
  });

  it('preserves a month of net credits and respects reporting eligibility', () => {
    const data = fixture();
    data.planItems = [plan('spending')];
    data.transactions = [transaction('refund', 2_000, { kind: 'expense' })];
    expect(getBudgetComparison(data, '2032-10')).toMatchObject({ recordedExpenseCents: -2_000, remainingCents: 12_000, hasRecordedExpenses: true });
    data.reporting = { startMonth: '2032-11', resetId: 'example-start', updatedAt: NOW };
    expect(getBudgetComparison(data, '2032-10')).toMatchObject({ recordedExpenseCents: 0, transactionCount: 0, hasRecordedExpenses: false });
  });

  it('rejects invalid months and transaction totals outside the safe monetary range', () => {
    const data = fixture();
    data.planItems = [plan('spending')];
    expect(() => getBudgetComparison(data, '2032-13')).toThrow('Invalid month');
    data.transactions = [transaction('large', Number.MAX_SAFE_INTEGER), transaction('small', 1)];
    expect(() => getBudgetComparison(data, '2032-10')).toThrow('supported monetary range');
    data.transactions.push(transaction('reversal', -Number.MAX_SAFE_INTEGER, { kind: 'income' }));
    expect(() => getBudgetComparison(data, '2032-10')).toThrow('supported monetary range');
  });
});

describe('signed category spending', () => {
  it('separates net-credit categories and uses only positive spending as the share denominator', () => {
    const categories = { Food: 10_000, Travel: 10_000, Returns: -5_000, Zero: 0 };
    expect(getCategorySpending(categories)).toEqual({
      positive: [{ name: 'Food', amountCents: 10_000, sharePercent: 50 }, { name: 'Travel', amountCents: 10_000, sharePercent: 50 }],
      refunds: [{ name: 'Returns', amountCents: 5_000 }], positiveCents: 20_000, refundCents: 5_000, netCents: 15_000,
    });
    expect(categories).toEqual({ Food: 10_000, Travel: 10_000, Returns: -5_000, Zero: 0 });
  });

  it('sorts by amount and retains empty or property-like category labels', () => {
    const categories = JSON.parse('{"__proto__":200,"":500,"Food":300,"Returns":-100,"Other returns":-400}') as Record<string, number>;
    const insights = getCategorySpending(categories);
    expect(insights.positive.map(entry => entry.name)).toEqual(['', 'Food', '__proto__']);
    expect(insights.positive.map(entry => entry.sharePercent)).toEqual([50, 30, 20]);
    expect(insights.refunds.map(entry => entry.amountCents)).toEqual([400, 100]);
  });

  it('handles refund-only and empty months without invalid percentages', () => {
    expect(getCategorySpending({ Refunds: -5_000 })).toEqual({ positive: [], refunds: [{ name: 'Refunds', amountCents: 5_000 }], positiveCents: 0, refundCents: 5_000, netCents: -5_000 });
    expect(getCategorySpending({})).toEqual({ positive: [], refunds: [], positiveCents: 0, refundCents: 0, netCents: 0 });
  });

  it('rejects non-integer values and overflowing category totals', () => {
    expect(() => getCategorySpending({ Invalid: 0.5 })).toThrow('supported monetary range');
    expect(() => getCategorySpending({ Large: Number.MAX_SAFE_INTEGER, Small: 1 })).toThrow('supported monetary range');
    expect(() => getCategorySpending({ Large: -Number.MAX_SAFE_INTEGER, Small: -1 })).toThrow('supported monetary range');
  });
});

describe('reserve spending coverage', () => {
  it('calculates months from positive reserve and spending without setting a personal target', () => {
    expect(getReserveCoverage(25_000, 10_000)).toBe(2.5);
    expect(getReserveCoverage(0, 10_000)).toBe(0);
    expect(getReserveCoverage(-10_000, 10_000)).toBe(0);
  });

  it('leaves coverage undefined for zero or negative spending and rejects unsafe inputs', () => {
    expect(getReserveCoverage(25_000, 0)).toBeNull();
    expect(getReserveCoverage(25_000, -1_000)).toBeNull();
    expect(() => getReserveCoverage(Infinity, 10_000)).toThrow('supported monetary range');
    expect(() => getReserveCoverage(10_000, 0.5)).toThrow('supported monetary range');
  });
});
