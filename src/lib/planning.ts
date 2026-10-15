import { addMonths, isValidMonth, planAmountForMonth } from './finance';
import type { PlanItem } from './types';

function validateAmount(amountCents: number): void {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error('Enter a non-negative monthly amount within the supported monetary range.');
}

function validateMonthCount(amounts: Record<string, number>): void {
  if (Object.keys(amounts).length > 12_000) throw new Error('This item has too many individual monthly amounts.');
}

/** Changes the repeating amount without losing explicit months or saved installment payments. */
export function setPlanMonthlyAmount(item: PlanItem, amountCents: number, stamp: string): PlanItem {
  validateAmount(amountCents);
  const amounts = { ...item.amounts };
  if (item.behavior === 'installments') {
    const scheduledMonths = new Set<string>();
    for (const schedule of item.installments ?? []) {
      for (let offset = 0; offset < schedule.count; offset++) {
        const month = addMonths(schedule.firstMonth, offset);
        if (month >= item.startMonth && (!item.endMonth || month <= item.endMonth)) scheduledMonths.add(month);
      }
    }
    for (const month of scheduledMonths) {
      if (!Object.hasOwn(amounts, month)) amounts[month] = planAmountForMonth(item, month);
    }
  }
  validateMonthCount(amounts);
  return { ...item, behavior: 'fixed', defaultAmountCents: amountCents, amounts, updatedAt: stamp };
}

/** Extends old date limits only for an explicit nonzero edit, preserving every other computed month. */
export function setPlanMonthAmount(item: PlanItem, month: string, amountCents: number, stamp: string): PlanItem {
  if (!isValidMonth(month)) throw new Error('Enter a valid month in YYYY-MM format.');
  validateAmount(amountCents);
  const amounts = { ...item.amounts, [month]: amountCents };
  let startMonth = item.startMonth;
  let endMonth = item.endMonth;
  let firstNewMonth: string | undefined;
  let lastNewMonth: string | undefined;
  if (amountCents > 0 && month < startMonth) {
    firstNewMonth = month;
    lastNewMonth = addMonths(startMonth, -1);
    startMonth = month;
  } else if (amountCents > 0 && endMonth && month > endMonth) {
    firstNewMonth = addMonths(endMonth, 1);
    lastNewMonth = month;
    endMonth = month;
  }
  if (firstNewMonth && lastNewMonth) {
    const monthIndex = (value: string) => Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
    const count = monthIndex(lastNewMonth) - monthIndex(firstNewMonth) + 1;
    if (count > 1_200) throw new Error('This edit would extend the item by more than 100 years.');
    for (let offset = 0; offset < count; offset++) {
      const gapMonth = addMonths(firstNewMonth, offset);
      if (gapMonth !== month) amounts[gapMonth] = planAmountForMonth(item, gapMonth);
    }
  }
  validateMonthCount(amounts);
  return { ...item, amounts, startMonth, ...(endMonth !== undefined ? { endMonth } : {}), updatedAt: stamp };
}
