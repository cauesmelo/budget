import { getTransactionScope, isReportableTransaction, isValidMonth, projectReserve } from './finance';
import type { FinanceData, ProjectionMonth } from './types';

export interface ReserveInsights {
  openingCents: number;
  closingCents: number;
  growthCents: number;
  goal: {
    amountCents: number;
    status: 'unset' | 'already-reached' | 'projected' | 'outside-horizon';
    month: string | null;
    timing: 'start' | 'end' | null;
    progressPercent: number | null;
    remainingCents: number;
    laterBelowMonth: string | null;
  };
  firstShortfall: { month: string; amountCents: number; timing: 'start' | 'end' } | null;
}

export interface PmsReserveInsights extends ReserveInsights {
  targetStatus: 'available' | 'no-spending' | 'unavailable';
  hasUnavailableTargets: boolean;
  laterBelowTiming: 'start' | 'end' | null;
}

export interface BudgetComparison {
  month: string;
  plannedIncomeCents: number;
  plannedExpenseCents: number;
  recordedIncomeCents: number;
  recordedExpenseCents: number;
  remainingCents: number;
  transactionCount: number;
  hasRecordedIncome: boolean;
  hasRecordedExpenses: boolean;
}

export interface CategorySpending {
  positive: { name: string; amountCents: number; sharePercent: number }[];
  refunds: { name: string; amountCents: number }[];
  positiveCents: number;
  refundCents: number;
  netCents: number;
}

function cents(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('The insight exceeds the supported monetary range.');
  return value;
}

/** Goal dates refer to opening balances, except a goal reached at the final month's end. */
export function getReserveInsights(rows: ProjectionMonth[], goalCents: number): ReserveInsights {
  cents(goalCents);
  if (goalCents < 0) throw new Error('The reserve goal cannot be negative.');
  const openingCents = cents(rows[0]?.openingCents ?? 0);
  const closingCents = cents(rows.at(-1)?.closingCents ?? openingCents);
  const goal: ReserveInsights['goal'] = {
    amountCents: goalCents,
    status: goalCents > 0 ? 'outside-horizon' : 'unset',
    month: null,
    timing: null,
    progressPercent: goalCents > 0 ? openingCents / goalCents * 100 : null,
    remainingCents: goalCents > 0 ? Math.max(0, cents(goalCents - openingCents)) : 0,
    laterBelowMonth: null,
  };
  for (const row of rows) {
    if (!isValidMonth(row.month)) throw new Error('Invalid projection month.');
    cents(row.openingCents); cents(row.closingCents);
  }
  if (goalCents > 0 && rows.length) {
    const reachIndex = rows.findIndex(row => row.openingCents >= goalCents);
    if (reachIndex >= 0) {
      goal.status = reachIndex === 0 ? 'already-reached' : 'projected';
      goal.month = rows[reachIndex].month;
      goal.timing = 'start';
      goal.laterBelowMonth = rows.slice(reachIndex).find(row => row.closingCents < goalCents)?.month ?? null;
    } else if (closingCents >= goalCents) {
      goal.status = 'projected';
      goal.month = rows.at(-1)!.month;
      goal.timing = 'end';
    }
  }
  const firstNegativeClosing = rows.find(row => row.closingCents < 0);
  const firstShortfall: ReserveInsights['firstShortfall'] = openingCents < 0 && rows.length
    ? { month: rows[0].month, amountCents: -openingCents, timing: 'start' }
    : firstNegativeClosing
      ? { month: firstNegativeClosing.month, amountCents: -firstNegativeClosing.closingCents, timing: 'end' }
      : null;
  return { openingCents, closingCents, growthCents: cents(closingCents - openingCents), goal, firstShortfall };
}

/** PMS follows each month's calculated spending target, rather than freezing the first target. */
export function getPmsReserveInsights(rows: ProjectionMonth[]): PmsReserveInsights {
  const targets = rows.map(row => {
    const targetCents = row.indicators.pms.targetCents;
    if (targetCents !== null) {
      cents(targetCents);
      if (targetCents < 0) throw new Error('The PMS target cannot be negative.');
    }
    return targetCents;
  });
  const initialTargetCents = targets[0] ?? null;
  const insights = getReserveInsights(rows, initialTargetCents ?? 0);
  const goal = insights.goal;
  goal.status = targets.some(target => target !== null && target > 0) ? 'outside-horizon' : 'unset';
  goal.month = null;
  goal.timing = null;
  goal.laterBelowMonth = null;
  let laterBelowTiming: PmsReserveInsights['laterBelowTiming'] = null;

  const reachIndex = rows.findIndex((row, index) => {
    const target = targets[index];
    return target !== null && target > 0 && row.openingCents >= target;
  });
  if (reachIndex >= 0) {
    goal.status = reachIndex === 0 ? 'already-reached' : 'projected';
    goal.month = rows[reachIndex].month;
    goal.timing = 'start';
    for (let index = reachIndex; index < rows.length; index++) {
      const row = rows[index];
      const target = targets[index];
      if (target === null || target <= 0) continue;
      if (row.openingCents < target || row.closingCents < target) {
        goal.laterBelowMonth = row.month;
        laterBelowTiming = row.openingCents < target ? 'start' : 'end';
        break;
      }
    }
  } else {
    const last = rows.at(-1);
    const finalTargetCents = targets.at(-1);
    if (last && finalTargetCents !== undefined && finalTargetCents !== null && finalTargetCents > 0 && last.closingCents >= finalTargetCents) {
      goal.status = 'projected';
      goal.month = last.month;
      goal.timing = 'end';
    }
  }

  return {
    ...insights,
    targetStatus: initialTargetCents === null ? 'unavailable' : initialTargetCents > 0 ? 'available' : 'no-spending',
    hasUnavailableTargets: targets.some(target => target === null),
    laterBelowTiming,
  };
}

/** Missing records remain explicit evidence flags; recorded spending is not a completed-month claim. */
export function getBudgetComparison(data: FinanceData, month: string): BudgetComparison | null {
  if (!isValidMonth(month)) throw new Error('Invalid month.');
  const row = projectReserve(data).find(entry => entry.month === month);
  if (!row || !data.planItems.some(item => !item.deletedAt && item.kind === 'expense' && item.startMonth <= month && (!item.endMonth || item.endMonth >= month))) return null;
  const recorded = data.transactions.filter(transaction => !transaction.deletedAt && transaction.month === month && transaction.kind !== 'transfer' && isReportableTransaction(data, transaction) && getTransactionScope(data, transaction) === 'personal');
  let recordedIncomeCents = 0;
  let recordedExpenseCents = 0;
  for (const transaction of recorded) {
    cents(transaction.amountCents);
    if (transaction.kind === 'income') recordedIncomeCents = cents(recordedIncomeCents + transaction.amountCents);
    else recordedExpenseCents = cents(recordedExpenseCents - transaction.amountCents);
  }
  return {
    month,
    plannedIncomeCents: cents(row.incomeCents),
    plannedExpenseCents: cents(row.expenseCents),
    recordedIncomeCents,
    recordedExpenseCents,
    remainingCents: cents(row.expenseCents - recordedExpenseCents),
    transactionCount: recorded.length,
    hasRecordedIncome: recorded.some(transaction => transaction.kind === 'income'),
    hasRecordedExpenses: recorded.some(transaction => transaction.kind === 'expense'),
  };
}

/** Negative category totals are net credits, displayed separately from positive spending shares. */
export function getCategorySpending(categories: Record<string, number>): CategorySpending {
  const positive: CategorySpending['positive'] = [];
  const refunds: CategorySpending['refunds'] = [];
  let positiveCents = 0;
  let refundCents = 0;
  for (const [name, amountCents] of Object.entries(categories)) {
    cents(amountCents);
    if (amountCents > 0) {
      positive.push({ name, amountCents, sharePercent: 0 });
      positiveCents = cents(positiveCents + amountCents);
    } else if (amountCents < 0) {
      refunds.push({ name, amountCents: -amountCents });
      refundCents = cents(refundCents - amountCents);
    }
  }
  const byAmount = (a: { name: string; amountCents: number }, b: { name: string; amountCents: number }) => b.amountCents - a.amountCents || a.name.localeCompare(b.name, 'en');
  positive.sort(byAmount); refunds.sort(byAmount);
  for (const entry of positive) entry.sharePercent = entry.amountCents / positiveCents * 100;
  return { positive, refunds, positiveCents, refundCents, netCents: cents(positiveCents - refundCents) };
}

/** Coverage describes this budget only, without prescribing an emergency-fund target. */
export function getReserveCoverage(openingCents: number, expenseCents: number): number | null {
  cents(openingCents); cents(expenseCents);
  return expenseCents > 0 ? Math.max(0, openingCents) / expenseCents : null;
}
