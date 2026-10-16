import { describe, expect, it } from 'vitest';
import { createEmptyData, projectReserve } from '../src/lib/finance';
import { getBudgetComparison, getCategorySpending, getPmsReserveInsights, getReserveCoverage, getReserveInsights, getReserveTargetInsights } from '../src/lib/insights';
import type { ReserveTargetKey } from '../src/lib/reserveChart';
import type { FinanceData, PlanItem, ProjectionMonth, Transaction } from '../src/lib/types';

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

describe('PMS reserve milestones', () => {
  function rows(values: { opening: number; closing: number; target: number | null }[]): ProjectionMonth[] {
    return projectReserve(fixture()).slice(0, values.length).map((row, index) => ({
      ...row,
      openingCents: values[index].opening,
      closingCents: values[index].closing,
      indicators: { ...row.indicators, pms: { targetCents: values[index].target, progressPercent: null } },
    }));
  }

  it('uses the existing PMS indicator for the target and initial progress without mutating the projection', () => {
    const projection = rows([
      { opening: 5_000, closing: 10_000, target: 20_000 },
      { opening: 10_000, closing: 20_000, target: 20_000 },
      { opening: 20_000, closing: 30_000, target: 20_000 },
    ]);
    const before = structuredClone(projection);
    expect(getPmsReserveInsights(projection)).toMatchObject({
      openingCents: 5_000, closingCents: 30_000, growthCents: 25_000,
      targetStatus: 'available', hasUnavailableTargets: false,
      goal: { amountCents: 20_000, progressPercent: 25, remainingCents: 15_000, status: 'projected', month: '2032-11', timing: 'end' },
    });
    expect(projection).toEqual(before);
  });

  it('reaches PMS sooner when future planned spending lowers that month’s target', () => {
    expect(getPmsReserveInsights(rows([
      { opening: 10_000, closing: 15_000, target: 30_000 },
      { opening: 15_000, closing: 20_000, target: 12_000 },
      { opening: 20_000, closing: 25_000, target: 12_000 },
    ])).goal).toMatchObject({ amountCents: 30_000, status: 'projected', month: '2032-11', timing: 'start' });
  });

  it('reports an initial closing achievement and a later drop when future spending raises PMS', () => {
    expect(getPmsReserveInsights(rows([
      { opening: 5_000, closing: 15_000, target: 10_000 },
      { opening: 15_000, closing: 25_000, target: 30_000 },
      { opening: 25_000, closing: 35_000, target: 40_000 },
    ]))).toMatchObject({
      goal: { status: 'projected', month: '2032-10', timing: 'end', laterBelowMonth: '2032-11' },
      laterBelowTiming: 'start',
    });
  });

  it('reports already reached and checks later closing balances against their own PMS targets', () => {
    expect(getPmsReserveInsights(rows([
      { opening: 20_000, closing: 25_000, target: 20_000 },
      { opening: 25_000, closing: 30_000, target: 40_000 },
      { opening: 30_000, closing: 35_000, target: 40_000 },
    ])).goal).toMatchObject({ status: 'already-reached', month: '2032-10', timing: 'start', progressPercent: 100, remainingCents: 0, laterBelowMonth: '2032-11' });

    expect(getPmsReserveInsights(rows([
      { opening: 20_000, closing: 25_000, target: 20_000 },
      { opening: 25_000, closing: 15_000, target: 10_000 },
    ])).goal.laterBelowMonth).toBeNull();
  });

  it('warns at a later opening when a higher PMS target is recovered by that month’s closing', () => {
    expect(getPmsReserveInsights(rows([
      { opening: 20_000, closing: 25_000, target: 20_000 },
      { opening: 25_000, closing: 45_000, target: 40_000 },
      { opening: 45_000, closing: 50_000, target: 40_000 },
    ]))).toMatchObject({
      goal: { status: 'already-reached', month: '2032-10', timing: 'start', laterBelowMonth: '2032-11' },
      laterBelowTiming: 'start',
    });
  });

  it('keeps a constant-target closing shortfall at the end of the earliest month', () => {
    expect(getPmsReserveInsights(rows([
      { opening: 20_000, closing: 15_000, target: 20_000 },
      { opening: 15_000, closing: 25_000, target: 20_000 },
    ]))).toMatchObject({ goal: { laterBelowMonth: '2032-10' }, laterBelowTiming: 'end' });
    expect(getPmsReserveInsights(rows([
      { opening: 20_000, closing: 25_000, target: 20_000 },
      { opening: 25_000, closing: 30_000, target: 20_000 },
    ]))).toMatchObject({ goal: { laterBelowMonth: null }, laterBelowTiming: null });
  });

  it('labels a milestone reached only in the final closing balance as end of month', () => {
    expect(getPmsReserveInsights(rows([
      { opening: 0, closing: 5_000, target: 20_000 },
      { opening: 5_000, closing: 10_000, target: 20_000 },
      { opening: 10_000, closing: 15_000, target: 15_000 },
    ])).goal).toMatchObject({ status: 'projected', month: '2032-12', timing: 'end' });
  });

  it('does not treat zero-spending months as successful reserve milestones', () => {
    expect(getPmsReserveInsights(rows([
      { opening: 0, closing: 10_000, target: 0 },
      { opening: 10_000, closing: 20_000, target: 0 },
    ]))).toMatchObject({
      targetStatus: 'no-spending', hasUnavailableTargets: false,
      goal: { amountCents: 0, status: 'unset', month: null, timing: null, progressPercent: null, remainingCents: 0 },
    });
    expect(getPmsReserveInsights(rows([
      { opening: 0, closing: 5_000, target: 10_000 },
      { opening: 5_000, closing: 20_000, target: 0 },
    ])).goal).toMatchObject({ status: 'outside-horizon', month: null, timing: null });
  });

  it('can project a future positive PMS when the initial month has no spending target', () => {
    expect(getPmsReserveInsights(rows([
      { opening: 0, closing: 10_000, target: 0 },
      { opening: 10_000, closing: 15_000, target: 10_000 },
    ]))).toMatchObject({
      targetStatus: 'no-spending', hasUnavailableTargets: false,
      goal: { amountCents: 0, progressPercent: null, status: 'projected', month: '2032-11', timing: 'start' },
    });
  });

  it('distinguishes unavailable initial PMS while still checking later positive targets', () => {
    expect(getPmsReserveInsights(rows([
      { opening: 0, closing: 5_000, target: null },
      { opening: 5_000, closing: 10_000, target: 20_000 },
      { opening: 10_000, closing: 15_000, target: 10_000 },
    ]))).toMatchObject({
      targetStatus: 'unavailable', hasUnavailableTargets: true,
      goal: { amountCents: 0, progressPercent: null, remainingCents: 0, status: 'projected', month: '2032-12', timing: 'start' },
    });
    expect(getPmsReserveInsights(rows([
      { opening: 0, closing: 5_000, target: null },
      { opening: 5_000, closing: 10_000, target: 20_000 },
    ])).goal.status).toBe('outside-horizon');
  });

  it('retains a known reached milestone when later targets are unavailable or zero', () => {
    expect(getPmsReserveInsights(rows([
      { opening: 20_000, closing: 15_000, target: 10_000 },
      { opening: 15_000, closing: 5_000, target: null },
      { opening: 5_000, closing: 0, target: 0 },
    ]))).toMatchObject({
      targetStatus: 'available', hasUnavailableTargets: true,
      goal: { status: 'already-reached', month: '2032-10', timing: 'start', laterBelowMonth: null },
    });
  });

  it('does not use an unavailable final target to claim an end-of-month achievement', () => {
    expect(getPmsReserveInsights(rows([
      { opening: 0, closing: 5_000, target: 10_000 },
      { opening: 5_000, closing: 20_000, target: null },
    ]))).toMatchObject({ hasUnavailableTargets: true, goal: { status: 'outside-horizon', month: null, timing: null } });
    expect(getPmsReserveInsights(rows([{ opening: 20_000, closing: 30_000, target: null }]))).toMatchObject({
      targetStatus: 'unavailable', hasUnavailableTargets: true, goal: { status: 'unset', month: null },
    });
  });

  it('preserves negative opening progress and the existing first-shortfall calculation', () => {
    const projection = rows([
      { opening: -5_000, closing: 5_000, target: 20_000 },
      { opening: 5_000, closing: -10_000, target: 20_000 },
    ]);
    const insights = getPmsReserveInsights(projection);
    expect(insights.goal).toMatchObject({ progressPercent: -25, remainingCents: 25_000 });
    expect(insights.firstShortfall).toEqual({ month: '2032-10', amountCents: 5_000, timing: 'start' });
    projection[0].openingCents = 0;
    expect(getPmsReserveInsights(projection).firstShortfall).toEqual({ month: '2032-11', amountCents: 10_000, timing: 'end' });
  });

  it('keeps an empty projection uncalculated and validates supplied PMS values', () => {
    expect(getPmsReserveInsights([])).toMatchObject({
      targetStatus: 'unavailable', hasUnavailableTargets: false,
      openingCents: 0, closingCents: 0, growthCents: 0,
      goal: { status: 'unset', month: null, timing: null }, firstShortfall: null,
    });
    expect(() => getPmsReserveInsights(rows([{ opening: 0, closing: 0, target: -1 }]))).toThrow('cannot be negative');
    expect(() => getPmsReserveInsights(rows([{ opening: 0, closing: 0, target: 0.5 }]))).toThrow('supported monetary range');
    expect(() => getPmsReserveInsights(rows([{ opening: 0, closing: 0, target: Infinity }]))).toThrow('supported monetary range');
  });
});

describe('reserve milestones for every financial target', () => {
  function rows(key: ReserveTargetKey, values: { opening: number; closing: number; target: number | null }[]): ProjectionMonth[] {
    return projectReserve(fixture()).slice(0, values.length).map((row, index) => ({
      ...row,
      openingCents: values[index].opening,
      closingCents: values[index].closing,
      indicators: {
        pms: { targetCents: null, progressPercent: null },
        pmr: { targetCents: null, progressPercent: null },
        pi: { targetCents: null, progressPercent: null },
        pnif: { targetCents: null, progressPercent: null },
        [key]: { targetCents: values[index].target, progressPercent: null },
      },
    }));
  }

  it.each(['pms', 'pmr', 'pi', 'pnif'] as const)('uses %s targets independently and keeps their current progress separate from the reach date', key => {
    const projection = rows(key, [
      { opening: 5_000, closing: 10_000, target: 20_000 },
      { opening: 10_000, closing: 15_000, target: 15_000 },
      { opening: 15_000, closing: 20_000, target: 10_000 },
    ]);
    const before = structuredClone(projection);
    expect(getReserveTargetInsights(projection, key)).toMatchObject({
      openingCents: 5_000, closingCents: 20_000, growthCents: 15_000,
      targetStatus: 'available', hasUnavailableTargets: false,
      goal: {
        amountCents: 20_000, progressPercent: 25, remainingCents: 15_000,
        status: 'projected', month: '2032-11', timing: 'end', laterBelowMonth: null,
      },
    });
    expect(projection).toEqual(before);
  });

  it.each(['pms', 'pmr', 'pi', 'pnif'] as const)('keeps a %s closing achievement when the next month’s target rises above the reserve', key => {
    expect(getReserveTargetInsights(rows(key, [
      { opening: 0, closing: 10_000, target: 10_000 },
      { opening: 10_000, closing: 11_000, target: 20_000 },
    ]), key)).toMatchObject({
      goal: { status: 'projected', month: '2032-10', timing: 'end', laterBelowMonth: '2032-11' },
      laterBelowTiming: 'start',
    });
  });

  it('does not mark an opening before a closing achievement as a later shortfall', () => {
    expect(getReserveTargetInsights(rows('pmr', [
      { opening: 0, closing: 10_000, target: 10_000 },
      { opening: 10_000, closing: 15_000, target: 10_000 },
    ]), 'pmr')).toMatchObject({
      goal: { status: 'projected', month: '2032-10', timing: 'end', laterBelowMonth: null },
      laterBelowTiming: null,
    });
  });

  it('checks a higher future target against that month’s opening before a recovery at closing', () => {
    expect(getReserveTargetInsights(rows('pmr', [
      { opening: 20_000, closing: 25_000, target: 20_000 },
      { opening: 25_000, closing: 45_000, target: 40_000 },
      { opening: 45_000, closing: 50_000, target: 40_000 },
    ]), 'pmr')).toMatchObject({
      goal: { status: 'already-reached', month: '2032-10', timing: 'start', laterBelowMonth: '2032-11' },
      laterBelowTiming: 'start',
    });
    expect(getReserveTargetInsights(rows('pnif', [
      { opening: 20_000, closing: 15_000, target: 20_000 },
      { opening: 15_000, closing: 25_000, target: 20_000 },
    ]), 'pnif')).toMatchObject({ goal: { laterBelowMonth: '2032-10' }, laterBelowTiming: 'end' });
  });

  it('reports a final closing achievement as end of month without extrapolating missing months', () => {
    const projection = rows('pi', [
      { opening: 0, closing: 5_000, target: 20_000 },
      { opening: 5_000, closing: 10_000, target: 20_000 },
    ]);
    expect(getReserveTargetInsights(projection, 'pi').goal).toMatchObject({ status: 'outside-horizon', month: null, timing: null });
    projection[1].indicators.pi.targetCents = 10_000;
    expect(getReserveTargetInsights(projection, 'pi').goal).toMatchObject({ status: 'projected', month: '2032-11', timing: 'end' });
    projection[1].indicators.pi.targetCents = null;
    expect(getReserveTargetInsights(projection, 'pi')).toMatchObject({
      hasUnavailableTargets: true, goal: { status: 'outside-horizon', month: null, timing: null },
    });
  });

  it('distinguishes missing target assumptions from zero spending and can still reach a later positive target', () => {
    const projection = rows('pnif', [
      { opening: 0, closing: 10_000, target: null },
      { opening: 10_000, closing: 15_000, target: 10_000 },
    ]);
    expect(getReserveTargetInsights(projection, 'pnif')).toMatchObject({
      targetStatus: 'unavailable', hasUnavailableTargets: true,
      goal: { amountCents: 0, progressPercent: null, remainingCents: 0, status: 'projected', month: '2032-11', timing: 'start' },
    });
    projection[0].indicators.pnif.targetCents = 0;
    expect(getReserveTargetInsights(projection, 'pnif')).toMatchObject({ targetStatus: 'no-spending', hasUnavailableTargets: false, goal: { status: 'projected' } });
    projection[1].indicators.pnif.targetCents = 0;
    expect(getReserveTargetInsights(projection, 'pnif').goal).toMatchObject({ status: 'unset', month: null, timing: null });
  });

  it('preserves debt, uncapped initial progress, and the same shortage timing for every target', () => {
    const projection = rows('pmr', [{ opening: -5_000, closing: 5_000, target: 20_000 }]);
    expect(getReserveTargetInsights(projection, 'pmr')).toMatchObject({
      goal: { progressPercent: -25, remainingCents: 25_000 },
      firstShortfall: { month: '2032-10', amountCents: 5_000, timing: 'start' },
    });
    projection[0].openingCents = 40_000;
    projection[0].closingCents = -5_000;
    expect(getReserveTargetInsights(projection, 'pmr')).toMatchObject({
      goal: { progressPercent: 200, remainingCents: 0, laterBelowMonth: '2032-10' },
      laterBelowTiming: 'end', firstShortfall: { month: '2032-10', amountCents: 5_000, timing: 'end' },
    });
  });

  it('retains the PMS API and rejects invalid amounts for any selected target', () => {
    const projection = rows('pms', [{ opening: 5_000, closing: 10_000, target: 20_000 }]);
    expect(getPmsReserveInsights(projection)).toEqual(getReserveTargetInsights(projection, 'pms'));
    for (const key of ['pms', 'pmr', 'pi', 'pnif'] as const) {
      expect(getReserveTargetInsights([], key)).toMatchObject({ targetStatus: 'unavailable', hasUnavailableTargets: false, goal: { status: 'unset' } });
      expect(() => getReserveTargetInsights(rows(key, [{ opening: 0, closing: 0, target: -1 }]), key)).toThrow('cannot be negative');
      expect(() => getReserveTargetInsights(rows(key, [{ opening: 0, closing: 0, target: 0.5 }]), key)).toThrow('supported monetary range');
      expect(() => getReserveTargetInsights(rows(key, [{ opening: 0, closing: 0, target: Infinity }]), key)).toThrow('supported monetary range');
    }
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
