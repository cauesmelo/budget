import { describe, expect, it } from 'vitest';
import { createEmptyData, mergeFinanceData, projectReserve } from '../src/lib/finance';
import { appendPlanItem, getOrderedPlanItems, movePlanItem } from '../src/lib/planOrder';
import { serializeBackup, validateBackup } from '../src/lib/storage';
import type { FinanceData, PlanItem } from '../src/lib/types';

const CREATED = '2032-10-01T12:00:00.000Z';
const MOVED = '2032-10-02T12:00:00.000Z';
const EDITED = '2032-10-03T12:00:00.000Z';

function item(id: string, kind: PlanItem['kind'] = 'expense'): PlanItem {
  return { id, name: id, category: '', kind, defaultAmountCents: 10_000, amounts: {}, startMonth: '2032-10', updatedAt: CREATED };
}

function fixture(): FinanceData {
  const data = createEmptyData(new Date(CREATED));
  data.planItems = [item('rent'), item('food'), item('transport')];
  return data;
}

function ids(data: FinanceData): string[] {
  return getOrderedPlanItems(data).map(row => row.id);
}

describe('plan row ordering', () => {
  it('keeps the existing array order for older data without creating metadata', () => {
    const data = fixture();
    expect(ids(data)).toEqual(['rent', 'food', 'transport']);
    expect(validateBackup(data)).not.toHaveProperty('planOrder');
    expect(getOrderedPlanItems(data)).not.toBe(data.planItems);
  });

  it('moves up and down without changing financial records or projections', () => {
    const data = fixture();
    const moved = movePlanItem(data, 'food', 'up', ids(data), MOVED);
    expect(ids(moved)).toEqual(['food', 'rent', 'transport']);
    expect(moved.planItems).toBe(data.planItems);
    expect(moved.planItems).toEqual(data.planItems);
    expect(moved.planOrder?.updatedAt).toBe(MOVED);
    expect(moved.updatedAt).toBe(MOVED);
    expect(projectReserve(moved)).toEqual(projectReserve(data));
    expect(ids(movePlanItem(moved, 'food', 'down', ids(moved), EDITED))).toEqual(ids(data));
    expect(data).not.toHaveProperty('planOrder');
  });

  it.each([
    ['rent', 'up', ['rent', 'food', 'transport']],
    ['transport', 'down', ['rent', 'food', 'transport']],
    ['missing', 'up', ['rent', 'food', 'transport']],
    ['food', 'up', ['rent', 'transport']],
    ['food', 'up', ['food']],
    ['food', 'down', []],
  ] as const)('ignores unavailable moves for %s %s', (id, direction, visible) => {
    const data = fixture();
    expect(movePlanItem(data, id, direction, [...visible], MOVED)).toBe(data);
  });

  it('only swaps current eligible rows and preserves hidden, deleted, and missing reference positions', () => {
    const data = fixture();
    data.planItems.splice(1, 0, item('hidden'), { ...item('deleted'), deletedAt: MOVED }, item('saving', 'contribution'));
    data.planOrder = { ids: ['rent', 'hidden', 'missing', 'deleted', 'saving', 'food', 'transport'], updatedAt: CREATED };
    const moved = movePlanItem(data, 'food', 'up', ['rent', 'deleted', 'saving', 'food', 'food', 'missing'], MOVED);
    expect(moved.planOrder?.ids).toEqual(['food', 'hidden', 'missing', 'deleted', 'saving', 'rent', 'transport']);
    expect(movePlanItem(moved, 'deleted', 'up', ids(moved), EDITED)).toBe(moved);
    expect(movePlanItem(moved, 'saving', 'down', ids(moved), EDITED)).toBe(moved);
  });

  it('appends new rows and restores deleted rows at their saved position on undo', () => {
    let data = movePlanItem(fixture(), 'food', 'up', ['rent', 'food', 'transport'], MOVED);
    data = { ...data, planItems: [...data.planItems, item('new')] };
    expect(ids(data)).toEqual(['food', 'rent', 'transport', 'new']);
    data = { ...data, planItems: data.planItems.map(row => row.id === 'food' ? { ...row, deletedAt: EDITED } : row) };
    expect(getOrderedPlanItems(data).filter(row => !row.deletedAt).map(row => row.id)).toEqual(['rent', 'transport', 'new']);
    data = movePlanItem(data, 'new', 'up', ['rent', 'transport', 'new'], EDITED);
    data = { ...data, planItems: data.planItems.map(row => row.id === 'food' ? { ...row, deletedAt: undefined } : row) };
    expect(ids(data)).toEqual(['food', 'rent', 'new', 'transport']);
  });

  it('captures additions without changing existing financial values or edit clocks', () => {
    const data = fixture();
    const added = item('new');
    const next = appendPlanItem(data, added, MOVED);
    expect(next.planItems).toEqual([...data.planItems, added]);
    expect(next.planItems[0]).toBe(data.planItems[0]);
    expect(next.planItems.at(-1)).toBe(added);
    expect(next.planOrder).toEqual({ ids: ['rent', 'food', 'transport', 'new'], updatedAt: MOVED });
    expect(next.updatedAt).toBe(MOVED);
    expect(data.planItems).toHaveLength(3);
    expect(data).not.toHaveProperty('planOrder');
    expect(appendPlanItem(next, { ...added, name: 'Duplicate' }, EDITED)).toBe(next);
  });
});

describe('plan ordering persistence', () => {
  it('round-trips ordering through backups without credentials or modifying the source', () => {
    const data = movePlanItem(fixture(), 'food', 'up', ['rent', 'food', 'transport'], MOVED);
    data.settings.googleClientId = 'example-local-client';
    const restored = validateBackup(serializeBackup(data));
    expect(restored.planOrder).toEqual(data.planOrder);
    expect(ids(restored)).toEqual(['food', 'rent', 'transport']);
    expect(restored.settings.googleClientId).toBe('');
    expect(data.settings.googleClientId).toBe('example-local-client');
  });

  it('allows absent record references after deletion or merging a partial backup', () => {
    const data = fixture();
    data.planOrder = { ids: ['missing', 'food', 'rent'], updatedAt: MOVED };
    expect(ids(validateBackup(data))).toEqual(['food', 'rent', 'transport']);
  });

  it('keeps moves savable at the reference limit by pruning absent IDs only when necessary', () => {
    const data = fixture();
    data.planOrder = { ids: Array.from({ length: 10_000 }, (_, index) => `missing-${index}`), updatedAt: CREATED };
    const validated = validateBackup(data);
    const moved = movePlanItem(validated, 'food', 'up', ['rent', 'food', 'transport'], MOVED);
    expect(moved.planOrder?.ids).toEqual(['food', 'rent', 'transport']);
    expect(ids(validateBackup(moved))).toEqual(['food', 'rent', 'transport']);
    expect(data.planOrder.ids).toHaveLength(10_000);
  });

  it.each([
    null,
    {},
    { ids: 'rent', updatedAt: MOVED },
    { ids: ['rent', 'rent'], updatedAt: MOVED },
    { ids: [''], updatedAt: MOVED },
    { ids: [' '], updatedAt: MOVED },
    { ids: [42], updatedAt: MOVED },
    { ids: ['x'.repeat(1_001)], updatedAt: MOVED },
    { ids: Array.from({ length: 10_001 }, (_, index) => String(index)), updatedAt: MOVED },
    { ids: ['rent'], updatedAt: 'yesterday' },
    { ids: ['rent'], updatedAt: '2032-02-30T12:00:00.000Z' },
  ])('rejects invalid ordering metadata %#', planOrder => {
    expect(() => validateBackup({ ...fixture(), planOrder })).toThrow('planOrder');
  });
});

describe('plan ordering merges', () => {
  it('preserves new-row addition order through merges in both directions', () => {
    const original = fixture();
    const ordered = movePlanItem(original, 'food', 'up', ids(original), MOVED);
    const first = appendPlanItem(ordered, item('z-new'), MOVED);
    const second = appendPlanItem(first, item('a-new'), EDITED);
    for (const stale of [original, ordered]) {
      for (const [left, right] of [[second, stale], [stale, second]]) {
        expect(ids(mergeFinanceData(left, right))).toEqual(['food', 'rent', 'transport', 'z-new', 'a-new']);
      }
    }
  });

  it('keeps a saved order when an older backup has no ordering, even with a later root timestamp', () => {
    const ordered = movePlanItem(fixture(), 'food', 'up', ['rent', 'food', 'transport'], MOVED);
    const older = fixture();
    older.updatedAt = EDITED;
    for (const [left, right] of [[ordered, older], [older, ordered]]) {
      expect(ids(mergeFinanceData(left, right))).toEqual(['food', 'rent', 'transport']);
    }
  });

  it('merges independent row edits and ordering in both directions without altering either clock', () => {
    const ordered = movePlanItem(fixture(), 'food', 'up', ['rent', 'food', 'transport'], MOVED);
    const edited = fixture();
    edited.planItems[0] = { ...edited.planItems[0], name: 'Updated rent', defaultAmountCents: 20_000, updatedAt: EDITED };
    for (const [left, right] of [[ordered, edited], [edited, ordered]]) {
      const merged = mergeFinanceData(left, right);
      expect(ids(merged)).toEqual(['food', 'rent', 'transport']);
      expect(merged.planOrder?.updatedAt).toBe(MOVED);
      expect(merged.planItems.find(row => row.id === 'rent')).toEqual(edited.planItems[0]);
      expect(projectReserve(merged)).toEqual(projectReserve(edited));
    }
  });

  it('uses the independent ordering clock and deterministically resolves simultaneous reorders', () => {
    const left = movePlanItem(fixture(), 'food', 'up', ['rent', 'food', 'transport'], MOVED);
    const right = movePlanItem(fixture(), 'food', 'down', ['rent', 'food', 'transport'], EDITED);
    left.updatedAt = '2032-11-01T12:00:00.000Z';
    expect(mergeFinanceData(left, right).planOrder).toEqual(right.planOrder);
    expect(mergeFinanceData(right, left).planOrder).toEqual(right.planOrder);
    right.planOrder!.updatedAt = MOVED;
    expect(mergeFinanceData(left, right).planOrder).toEqual(mergeFinanceData(right, left).planOrder);
    expect(mergeFinanceData(left, right).planOrder).toEqual(mergeFinanceData(mergeFinanceData(left, right), left).planOrder);
  });

  it.each([false, true])('preserves only the winning reset epoch ordering (configured: %s)', withOrder => {
    const stale = movePlanItem(fixture(), 'food', 'up', ['rent', 'food', 'transport'], EDITED);
    stale.reporting = { startMonth: '2032-10', resetId: 'old-start', updatedAt: CREATED };
    const fresh = createEmptyData(new Date(MOVED));
    fresh.reporting = { startMonth: '2032-10', resetId: 'new-start', updatedAt: MOVED };
    fresh.planItems = [item('new-first'), item('new-second')];
    if (withOrder) fresh.planOrder = { ids: ['new-second', 'new-first'], updatedAt: MOVED };
    for (const [left, right] of [[stale, fresh], [fresh, stale]]) {
      const merged = mergeFinanceData(left, right);
      expect(merged.planOrder).toEqual(fresh.planOrder);
      expect(ids(merged)).toEqual(withOrder ? ['new-second', 'new-first'] : ['new-first', 'new-second']);
    }
  });
});
