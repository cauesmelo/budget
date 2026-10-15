import { describe, expect, it } from 'vitest';
import { planAmountForMonth } from '../src/lib/finance';
import { setPlanMonthAmount, setPlanMonthlyAmount } from '../src/lib/planning';
import type { PlanItem } from '../src/lib/types';

const NOW = '2032-10-10T12:00:00.000Z';
const LATER = '2032-10-11T12:00:00.000Z';
const plan = (patch: Partial<PlanItem> = {}): PlanItem => ({
  id: 'example-plan', name: 'Example expense', category: '', kind: 'expense',
  defaultAmountCents: 2_000, amounts: {}, startMonth: '2032-10', updatedAt: NOW, ...patch,
});

describe('individual month edits without visible date controls', () => {
  it('changes only the selected active month and retains fixed defaults and other overrides', () => {
    const item = plan({ amounts: { '2032-11': 4_000, '2032-12': 0 } });
    const before = structuredClone(item);
    const edited = setPlanMonthAmount(item, '2032-10', 1_000, LATER);
    expect(values(edited, ['2032-09', '2032-10', '2032-11', '2032-12', '2033-01'])).toEqual([0, 1_000, 4_000, 0, 2_000]);
    expect(edited.defaultAmountCents).toBe(2_000);
    expect(edited.updatedAt).toBe(LATER);
    expect(item).toEqual(before);
  });

  it('extends a former end date without repeating the default through previously inactive gap months', () => {
    const item = plan({ endMonth: '2032-11', amounts: { '2032-10': 3_000, '2033-03': 7_000 } });
    const edited = setPlanMonthAmount(item, '2033-02', 5_000, LATER);
    expect(edited.endMonth).toBe('2033-02');
    expect(values(edited, ['2032-10', '2032-11', '2032-12', '2033-01', '2033-02', '2033-03'])).toEqual([3_000, 2_000, 0, 0, 5_000, 0]);
    expect(edited.amounts['2033-03']).toBe(7_000);
  });

  it('extends an earlier start without activating saved values in the newly included gap', () => {
    const item = plan({ startMonth: '2033-01', endMonth: '2033-03', amounts: { '2032-12': 9_000, '2033-02': 0 } });
    const edited = setPlanMonthAmount(item, '2032-10', 5_000, LATER);
    expect(edited.startMonth).toBe('2032-10');
    expect(edited.endMonth).toBe('2033-03');
    expect(values(edited, ['2032-09', '2032-10', '2032-11', '2032-12', '2033-01', '2033-02', '2033-03', '2033-04'])).toEqual([0, 5_000, 0, 0, 2_000, 0, 2_000, 0]);
    expect(item.amounts['2032-12']).toBe(9_000);
  });

  it('keeps monthly-only semantics and retained zero overrides', () => {
    const edited = setPlanMonthAmount(plan({ behavior: 'monthly', amounts: { '2032-11': 0 } }), '2032-12', 1_000, LATER);
    expect(edited.behavior).toBe('monthly');
    expect(values(edited, ['2032-10', '2032-11', '2032-12', '2033-01'])).toEqual([0, 0, 1_000, 0]);
  });

  it('preserves finite installment totals and metadata while making a later month editable', () => {
    const item = plan({ behavior: 'installments', endMonth: '2032-11', installments: [
      { id: 'purchase', name: 'Example purchase', amountCents: 4_000, firstMonth: '2032-10', count: 6, sourceKey: 'example-source' },
    ] });
    const edited = setPlanMonthAmount(item, '2033-02', 1_000, LATER);
    expect(edited.behavior).toBe('installments');
    expect(edited.installments).toEqual(item.installments);
    expect(values(edited, ['2032-10', '2032-11', '2032-12', '2033-01', '2033-02', '2033-03'])).toEqual([4_000, 4_000, 0, 0, 1_000, 0]);
  });

  it('does not extend either limit for zero edits outside the interval', () => {
    const item = plan({ endMonth: '2032-12' });
    const earlier = setPlanMonthAmount(item, '2032-08', 0, LATER);
    const later = setPlanMonthAmount(earlier, '2033-02', 0, LATER);
    expect(later).toMatchObject({ startMonth: '2032-10', endMonth: '2032-12', amounts: { '2032-08': 0, '2033-02': 0 } });
    expect(values(later, ['2032-08', '2032-09', '2032-10', '2032-12', '2033-01', '2033-02'])).toEqual([0, 0, 2_000, 2_000, 0, 0]);
  });

  it('rejects invalid input, excessive extensions, and oversized amount maps without changing the source', () => {
    const item = plan({ endMonth: '2032-12' });
    expect(() => setPlanMonthAmount(item, 'invalid', 100, LATER)).toThrow('valid month');
    expect(() => setPlanMonthAmount(item, '2032-10', -1, LATER)).toThrow('non-negative monthly amount');
    expect(() => setPlanMonthAmount(item, '2032-10', 0.5, LATER)).toThrow('non-negative monthly amount');
    expect(() => setPlanMonthAmount(item, '2133-01', 100, LATER)).toThrow('more than 100 years');
    expect(() => setPlanMonthAmount(item, '1932-09', 100, LATER)).toThrow('more than 100 years');
    expect(item.amounts).toEqual({});
    const full = plan({ amounts: Object.fromEntries(Array.from({ length: 12_000 }, (_, index) => [`${String(1000 + Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`, 0])) });
    expect(() => setPlanMonthAmount(full, '2032-10', 100, LATER)).toThrow('too many individual monthly amounts');
    expect(Object.keys(full.amounts)).toHaveLength(12_000);
  });
});
const values = (item: PlanItem, months: string[]) => months.map(month => planAmountForMonth(item, month));

describe('simple monthly budget edits', () => {
  it('repeats a new default while preserving zero and nonzero month overrides and date bounds', () => {
    const item = plan({ endMonth: '2032-12', amounts: { '2032-11': 0, '2032-12': 5_000 } });
    const before = structuredClone(item);
    const edited = setPlanMonthlyAmount(item, 3_000, LATER);
    expect(values(edited, ['2032-09', '2032-10', '2032-11', '2032-12', '2033-01'])).toEqual([0, 3_000, 0, 5_000, 0]);
    expect(edited).toMatchObject({ behavior: 'fixed', defaultAmountCents: 3_000, startMonth: '2032-10', endMonth: '2032-12', updatedAt: LATER });
    expect(item).toEqual(before);
    expect(edited.amounts).not.toBe(item.amounts);
  });

  it('retains the existing months when explicitly making an old monthly-only row repeat', () => {
    const edited = setPlanMonthlyAmount(plan({ behavior: 'monthly', amounts: { '2032-11': 4_000, '2032-12': 0 } }), 3_000, LATER);
    expect(values(edited, ['2032-10', '2032-11', '2032-12', '2033-01'])).toEqual([3_000, 4_000, 0, 3_000]);
  });

  it('preserves overlapping finite payments and their explicit overrides when editing a saved installment row', () => {
    const item = plan({ behavior: 'installments', installments: [
      { id: 'first', name: 'Example purchase', amountCents: 4_000, firstMonth: '2032-10', count: 3, sourceKey: 'example-source' },
      { id: 'second', name: 'Another purchase', amountCents: 1_000, firstMonth: '2032-11', count: 1 },
    ], amounts: { '2032-12': 0 } });
    const before = structuredClone(item);
    const edited = setPlanMonthlyAmount(item, 2_500, LATER);
    expect(values(edited, ['2032-10', '2032-11', '2032-12', '2033-01'])).toEqual([4_000, 5_000, 0, 2_500]);
    expect(edited.amounts).toEqual({ '2032-10': 4_000, '2032-11': 5_000, '2032-12': 0 });
    expect(edited.installments).toEqual(before.installments);
    expect(item).toEqual(before);
    expect(values(setPlanMonthlyAmount(edited, 1_500, LATER), ['2032-10', '2032-11', '2032-12', '2033-01'])).toEqual([4_000, 5_000, 0, 1_500]);
  });

  it('materializes only scheduled months inside the saved active interval', () => {
    const edited = setPlanMonthlyAmount(plan({ behavior: 'installments', startMonth: '2032-11', endMonth: '2032-12', installments: [
      { id: 'purchase', name: 'Example purchase', amountCents: 4_000, firstMonth: '2032-10', count: 4 },
    ] }), 0, LATER);
    expect(edited.amounts).toEqual({ '2032-11': 4_000, '2032-12': 4_000 });
    expect(values(edited, ['2032-10', '2032-11', '2032-12', '2033-01'])).toEqual([0, 4_000, 4_000, 0]);
  });

  it('does not revive dormant schedules on subsequent edits', () => {
    const edited = setPlanMonthlyAmount(plan({ behavior: 'fixed', installments: [
      { id: 'purchase', name: 'Example purchase', amountCents: 4_000, firstMonth: '2032-10', count: 3 },
    ] }), 3_000, LATER);
    expect(edited.amounts).toEqual({});
    expect(planAmountForMonth(edited, '2032-10')).toBe(3_000);
  });

  it('rejects negative, fractional, and unsafe values before changing an item', () => {
    const item = plan();
    for (const amount of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => setPlanMonthlyAmount(item, amount, LATER)).toThrow('non-negative monthly amount');
    }
    expect(item.defaultAmountCents).toBe(2_000);
    expect(item.updatedAt).toBe(NOW);
  });
});
