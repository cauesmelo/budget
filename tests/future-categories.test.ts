import { describe, expect, it } from 'vitest';
import { addCategory, archiveCategory, availableCategoryNames, configureFutureCategories, renameCategory } from '../src/lib/categories';
import { addMonths, createEmptyData, mergeFinanceData, planAmountForMonth, projectReserve } from '../src/lib/finance';
import { serializeBackup, validateBackup } from '../src/lib/storage';
import type { FinanceData, PlanItem, Transaction } from '../src/lib/types';

const NOW = new Date('2026-09-01T15:00:00.000Z');
const LATER = new Date('2026-10-11T15:00:00.000Z');
const AFTER = new Date('2026-10-12T15:00:00.000Z');
const configuration = {
  fromMonth: '2026-10',
  activeNames: ['Fixed costs', 'Subscriptions', 'Groceries', 'Travel'],
  assignments: { Housing: 'Fixed costs', Music: 'Subscriptions' },
};
const transaction = (id: string, month: string, category: string): Transaction => ({
  id, fingerprint: id, date: `${month}-10`, month, amountCents: -1_234,
  kind: 'expense', source: 'manual', account: 'Example account', originalDescription: id,
  description: id, category, updatedAt: NOW.toISOString(),
});
const plan = (id: string, category: string, overrides: Partial<PlanItem> = {}): PlanItem => ({
  id, name: 'Example recurring cost', category, kind: 'expense', defaultAmountCents: 1_000,
  amounts: { '2026-08': 900, '2026-09': 0, '2026-10': 0, '2026-11': 1_500 },
  startMonth: '2026-08', updatedAt: NOW.toISOString(), ...overrides,
});

function state(): FinanceData {
  let data = createEmptyData(NOW);
  for (const name of ['Housing', 'Music', 'Groceries', 'Travel', 'Old purchase']) data = addCategory(data, name, NOW);
  data = archiveCategory(data, data.categories.find(category => category.name === 'Travel')!.id, NOW);
  data.transactions = [
    transaction('past', '2026-09', 'Housing'),
    { ...transaction('future', '2026-10', 'Housing'), date: '2026-09-30' },
    transaction('future-active', '2026-10', 'Groceries'),
    transaction('future-unmapped', '2026-11', 'Old purchase'),
    { ...transaction('deleted', '2026-11', 'Music'), deletedAt: NOW.toISOString() },
    { ...transaction('past-competence', '2026-09', 'Music'), date: '2026-10-01' },
  ];
  data.planItems = [
    plan('spanning', 'Housing', { endMonth: '2026-12' }),
    plan('future', 'Music', { startMonth: '2026-10' }),
    plan('historical', 'Old purchase', { endMonth: '2026-09' }),
    plan('deleted-plan', 'Housing', { deletedAt: NOW.toISOString() }),
    plan('active-plan', 'Groceries'),
    plan('unmapped-plan', 'Old purchase', { kind: 'income', defaultAmountCents: 10_000 }),
  ];
  data.snapshots = [{ id: 'past-snapshot', month: '2026-09', incomeCents: 0, expenseCents: 1_234, categories: { Housing: 1_234 }, updatedAt: NOW.toISOString() }];
  data.imports = [{ id: 'initial-receipt', filename: 'example.xlsx', source: 'budget', importedAt: NOW.toISOString(), updatedAt: NOW.toISOString(), count: 6 }];
  data.settings.googleClientId = 'local-client';
  data.settings.reserveStartMonth = '2026-08';
  data.settings.horizonMonths = 8;
  data.settings.initialReserveCents = 500_000;
  data.settings.monthlyReturnPercent = 0.5;
  return data;
}

describe('future category configuration', () => {
  it('limits available choices without renaming history, receipts, credentials, or the source object', () => {
    const original = state();
    const unchanged = structuredClone(original);
    const next = configureFutureCategories(original, configuration, LATER);
    expect(original).toEqual(unchanged);
    expect(availableCategoryNames(next).sort()).toEqual([...configuration.activeNames].sort());
    expect(next.categories.find(category => category.name === 'Housing')).toMatchObject({
      id: original.categories.find(category => category.name === 'Housing')!.id,
      name: 'Housing', archivedAt: LATER.toISOString(), updatedAt: LATER.toISOString(),
    });
    expect(next.categories.find(category => category.name === 'Travel')).not.toHaveProperty('archivedAt');
    expect(next.transactions[0]).toEqual(original.transactions[0]);
    expect(next.snapshots).toEqual(original.snapshots);
    expect(next.settings).toEqual(original.settings);
    expect(next.imports).toEqual(original.imports);
  });

  it('uses the competence month, preserves active assignments, and clears obsolete unmapped future assignments', () => {
    const original = state();
    const next = configureFutureCategories(original, configuration, LATER);
    expect(next.transactions[1]).toEqual({ ...original.transactions[1], category: 'Fixed costs', updatedAt: LATER.toISOString() });
    expect(next.transactions[2]).toEqual(original.transactions[2]);
    expect(next.transactions[3]).toEqual({ ...original.transactions[3], category: '', updatedAt: LATER.toISOString() });
    expect(next.transactions[5]).toEqual(original.transactions[5]);
    expect(next.transactions.map(item => item.amountCents)).toEqual(original.transactions.map(item => item.amountCents));
  });

  it('splits spanning plans at the boundary, preserving identities, intervals, explicit zeros, and every monthly amount', () => {
    const original = state();
    const next = configureFutureCategories(original, configuration, LATER);
    const historical = next.planItems.find(item => item.id === 'spanning')!;
    const future = next.planItems.find(item => item.category === 'Fixed costs' && item.id !== 'deleted-plan')!;
    expect(historical).toEqual({ ...original.planItems[0], endMonth: '2026-09', amounts: { '2026-08': 900, '2026-09': 0 }, updatedAt: LATER.toISOString() });
    expect(future).toMatchObject({ name: original.planItems[0].name, kind: 'expense', startMonth: '2026-10', endMonth: '2026-12', defaultAmountCents: 1_000, amounts: { '2026-10': 0, '2026-11': 1_500 }, updatedAt: LATER.toISOString() });
    expect(future.id).not.toBe(historical.id);
    expect(future.sourcePlanId).toBe(historical.id);
    expect(next.planItems.find(item => item.id === 'future')).toEqual({ ...original.planItems[1], category: 'Subscriptions', updatedAt: LATER.toISOString() });
    const cleared = next.planItems.find(item => item.kind === 'income' && item.startMonth === '2026-10')!;
    expect(cleared.category).toBe('');
    expect(cleared.endMonth).toBeUndefined();
    for (let index = 0; index < 18; index++) {
      const month = addMonths('2026-01', index);
      const amount = (data: FinanceData) => data.planItems.reduce((total, item) => total + planAmountForMonth(item, month), 0);
      expect(amount(next), month).toBe(amount(original));
    }
    expect(projectReserve(next)).toEqual(projectReserve(original));
  });

  it('leaves wholly historical plans and deleted records byte-identical', () => {
    const original = state();
    const next = configureFutureCategories(original, configuration, LATER);
    for (const id of ['historical', 'deleted-plan', 'active-plan']) {
      expect(JSON.stringify(next.planItems.find(item => item.id === id))).toBe(JSON.stringify(original.planItems.find(item => item.id === id)));
    }
    expect(JSON.stringify(next.transactions[4])).toBe(JSON.stringify(original.transactions[4]));
  });

  it('is idempotent across reruns and produces the same split identities on another device', () => {
    const original = state();
    const next = configureFutureCategories(original, configuration, LATER);
    const repeated = configureFutureCategories(next, configuration, AFTER);
    expect(repeated).toBe(next);
    expect(next.planItems).toHaveLength(original.planItems.length + 2);
    const otherDevice = configureFutureCategories(original, configuration, AFTER);
    expect(otherDevice.planItems.map(item => item.id)).toEqual(next.planItems.map(item => item.id));
  });

  it('preserves historical catalog aliases instead of changing them globally', () => {
    let original = state();
    const category = original.categories.find(item => item.name === 'Music')!;
    original = renameCategory(original, category.id, 'Streaming', NOW);
    const next = configureFutureCategories(original, { ...configuration, assignments: { ...configuration.assignments, Streaming: 'Subscriptions' } }, LATER);
    expect(next.categories.find(item => item.id === category.id)).toMatchObject({ name: 'Streaming', aliases: ['Music'], archivedAt: LATER.toISOString() });
    expect(next.transactions[5]).toEqual(original.transactions[5]);
  });

  it('rejects canonical labels that conflict with old aliases or capitalization, without changing the source', () => {
    let original = state();
    original = renameCategory(original, original.categories.find(item => item.name === 'Music')!.id, 'Streaming', NOW);
    const unchanged = structuredClone(original);
    for (const name of ['Music', 'groceries']) {
      expect(() => configureFutureCategories(original, { ...configuration, activeNames: [name], assignments: {} }, LATER)).toThrow('change history');
    }
    expect(original).toEqual(unchanged);
  });

  it('rejects invalid boundaries, duplicate choices, and unknown or noncanonical assignment targets', () => {
    const original = state();
    for (const fromMonth of ['2026-13', '0000-01', '2026-1']) {
      expect(() => configureFutureCategories(original, { ...configuration, fromMonth }, LATER)).toThrow('boundary');
    }
    expect(() => configureFutureCategories(original, { ...configuration, activeNames: ['Travel', ' travel '] }, LATER)).toThrow('unique');
    for (const target of ['Unknown', 'fixed costs', ' Fixed costs ']) {
      expect(() => configureFutureCategories(original, { ...configuration, assignments: { Housing: target } }, LATER)).toThrow('exact future category');
    }
    expect(() => configureFutureCategories(original, { ...configuration, assignments: { Housing: 'Fixed costs', HOUSING: '' } }, LATER)).toThrow('conflicting');
    expect(() => configureFutureCategories(original, configuration, new Date('invalid'))).toThrow('Invalid date');
  });

  it('handles a January split and retains an explicit empty assignment', () => {
    const original = state();
    original.planItems = [plan('year-boundary', 'Housing', { startMonth: '2025-12', amounts: { '2025-12': 0, '2026-01': 0 } })];
    const next = configureFutureCategories(original, { ...configuration, fromMonth: '2026-01', assignments: { Housing: '' } }, LATER);
    expect(next.planItems[0].endMonth).toBe('2025-12');
    expect(next.planItems[0].amounts).toEqual({ '2025-12': 0 });
    expect(next.planItems[1]).toMatchObject({ category: '', startMonth: '2026-01', amounts: { '2026-01': 0 } });
  });

  it('retains contribution amounts and an end month exactly on the category boundary', () => {
    const original = state();
    original.planItems = [plan('contribution', 'Housing', { kind: 'contribution', endMonth: '2026-10' })];
    const next = configureFutureCategories(original, configuration, LATER);
    expect(next.planItems[0]).toMatchObject({ id: 'contribution', category: 'Housing', kind: 'contribution', endMonth: '2026-09', defaultAmountCents: 1_000 });
    expect(next.planItems[1]).toMatchObject({ category: 'Fixed costs', kind: 'contribution', startMonth: '2026-10', endMonth: '2026-10', defaultAmountCents: 1_000, amounts: { '2026-10': 0, '2026-11': 1_500 } });
    for (const month of ['2026-08', '2026-09', '2026-10', '2026-11']) {
      expect(next.planItems.reduce((total, item) => total + planAmountForMonth(item, month), 0)).toBe(planAmountForMonth(original.planItems[0], month));
    }
  });

  it('aggregates future snapshots without changing income, expenses, historical snapshots, or catalog choices', () => {
    const original = state();
    original.snapshots.push({ id: 'future-snapshot', month: '2026-10', incomeCents: 7_000, expenseCents: 3_000, categories: { Housing: 1_000, Music: 500, 'Old purchase': 1_200, Groceries: 300 }, updatedAt: NOW.toISOString() });
    const next = configureFutureCategories(original, configuration, LATER);
    expect(next.snapshots[0]).toEqual(original.snapshots[0]);
    expect(next.snapshots[1]).toEqual({ ...original.snapshots[1], categories: { 'Fixed costs': 1_000, Subscriptions: 500, Uncategorized: 1_200, Groceries: 300 }, updatedAt: LATER.toISOString() });
    expect(next.categories.find(category => category.name === 'Uncategorized')?.archivedAt).toBe(LATER.toISOString());
    expect(availableCategoryNames(next).sort()).toEqual([...configuration.activeNames].sort());
    expect(configureFutureCategories(next, configuration, AFTER)).toBe(next);
  });

  it('uses an explicit uncategorized snapshot assignment consistently on repeated runs', () => {
    const original = state();
    original.snapshots.push({ id: 'unmapped', month: '2026-10', incomeCents: 0, expenseCents: 1_000, categories: { 'Old purchase': 1_000 }, updatedAt: NOW.toISOString() });
    const configured = { ...configuration, assignments: { ...configuration.assignments, Uncategorized: 'Groceries' } };
    const next = configureFutureCategories(original, configured, LATER);
    expect(next.snapshots[1].categories).toEqual({ Groceries: 1_000 });
    expect(configureFutureCategories(next, configured, AFTER)).toBe(next);
  });

  it('supports special snapshot keys and rejects category total overflow', () => {
    let original = state();
    original = addCategory(original, '__proto__', NOW);
    original.snapshots.push({ id: 'special', month: '2026-10', incomeCents: 0, expenseCents: 500, categories: JSON.parse('{"Housing":200,"__proto__":300}'), updatedAt: NOW.toISOString() });
    const special = { ...configuration, activeNames: ['__proto__'], assignments: { Housing: '__proto__' } };
    const next = configureFutureCategories(original, special, LATER);
    expect(Object.hasOwn(next.snapshots[1].categories, '__proto__')).toBe(true);
    expect(next.snapshots[1].categories.__proto__).toBe(500);
    expect(Object.getPrototypeOf(next.snapshots[1].categories)).toBe(Object.prototype);
    original.snapshots[1].categories = { Housing: Number.MAX_SAFE_INTEGER, Music: 1 };
    expect(() => configureFutureCategories(original, { ...special, assignments: { Housing: '__proto__', Music: '__proto__' } }, LATER)).toThrow('monetary range');
  });

  it('survives backup restoration and merging an older device without restoring duplicate future cash flows', () => {
    const original = state();
    const next = configureFutureCategories(original, configuration, LATER);
    const restored = validateBackup(serializeBackup(next));
    expect(restored.settings.googleClientId).toBe('');
    expect(restored.planItems.find(item => item.sourcePlanId === 'spanning')?.sourcePlanId).toBe('spanning');
    expect(restored.categories).toEqual([...next.categories].sort((left, right) => left.id < right.id ? -1 : 1));
    expect(configureFutureCategories(restored, configuration, AFTER)).toBe(restored);
    const merged = mergeFinanceData(next, original);
    expect(availableCategoryNames(merged).sort()).toEqual([...configuration.activeNames].sort());
    expect(merged.transactions.find(item => item.id === 'past')).toEqual(original.transactions[0]);
    expect(merged.transactions.find(item => item.id === 'future')?.category).toBe('Fixed costs');
    expect(merged.planItems).toHaveLength(next.planItems.length);
    expect(merged.imports).toEqual(original.imports);
    expect(projectReserve(merged)).toEqual(projectReserve(original));
    expect(mergeFinanceData(merged, merged)).toEqual(merged);
    expect(configureFutureCategories(merged, configuration, AFTER)).toBe(merged);
  });

  it('caps a later stale parent edit while retaining its edited values and preventing duplicate future cash flows', () => {
    const original = state();
    original.planItems = [plan('spanning', 'Housing')];
    original.settings.reserveStartMonth = '2026-10';
    const next = configureFutureCategories(original, configuration, LATER);
    const stale = structuredClone(original);
    stale.planItems[0].name = 'Updated on an older device';
    stale.planItems[0].defaultAmountCents = 7_000;
    stale.planItems[0].amounts['2026-11'] = 9_000;
    stale.planItems[0].updatedAt = AFTER.toISOString();
    const merged = mergeFinanceData(next, stale);
    expect(merged.planItems.find(item => item.id === 'spanning')).toMatchObject({
      name: 'Updated on an older device', endMonth: '2026-09', defaultAmountCents: 7_000,
      amounts: stale.planItems[0].amounts, updatedAt: AFTER.toISOString(),
    });
    expect(projectReserve(merged)).toEqual(projectReserve(next));
    expect(mergeFinanceData(stale, next)).toEqual(merged);
    expect(mergeFinanceData(merged, stale)).toEqual(merged);
    expect(mergeFinanceData(merged, merged)).toEqual(merged);
  });

  it('retains split linkage when a newer record from an older client omits the metadata', () => {
    const original = state();
    original.planItems = [plan('spanning', 'Housing')];
    const next = configureFutureCategories(original, configuration, LATER);
    const olderClient = structuredClone(next);
    const future = olderClient.planItems.find(item => item.sourcePlanId === 'spanning')!;
    delete future.sourcePlanId;
    future.name = 'Edited future cost';
    future.amounts['2026-10'] = 3_333;
    future.updatedAt = AFTER.toISOString();
    olderClient.planItems[0].endMonth = '2027-06';
    olderClient.planItems[0].updatedAt = AFTER.toISOString();
    const merged = mergeFinanceData(next, olderClient);
    expect(merged.planItems.find(item => item.id === future.id)).toEqual({ ...future, sourcePlanId: 'spanning' });
    expect(merged.planItems.find(item => item.id === 'spanning')?.endMonth).toBe('2026-09');
    expect(merged.planItems.reduce((total, item) => total + planAmountForMonth(item, '2026-10'), 0)).toBe(3_333);
    expect(mergeFinanceData(olderClient, next)).toEqual(merged);
  });

  it('keeps future deletion effective when a stale source still spans the deleted interval', () => {
    const original = state();
    original.planItems = [plan('spanning', 'Housing')];
    const next = configureFutureCategories(original, configuration, LATER);
    const future = next.planItems.find(item => item.sourcePlanId === 'spanning')!;
    future.deletedAt = future.updatedAt = AFTER.toISOString();
    const stale = structuredClone(original);
    stale.planItems[0].updatedAt = AFTER.toISOString();
    const merged = mergeFinanceData(next, stale);
    expect(merged.planItems.find(item => item.id === 'spanning')?.endMonth).toBe('2026-09');
    expect(merged.planItems.find(item => item.id === future.id)?.deletedAt).toBe(AFTER.toISOString());
    expect(merged.planItems.reduce((total, item) => total + planAmountForMonth(item, '2026-11'), 0)).toBe(0);
    expect(validateBackup(serializeBackup(merged)).planItems.find(item => item.id === future.id)?.sourcePlanId).toBe('spanning');
  });

  it('preserves chained cutovers through backup restoration and later stale edits', () => {
    const original = state();
    original.planItems = [plan('spanning', 'Housing')];
    original.settings.horizonMonths = 18;
    const first = configureFutureCategories(original, configuration, LATER);
    const firstFuture = first.planItems.find(item => item.sourcePlanId === 'spanning')!;
    const chained = configureFutureCategories(first, {
      fromMonth: '2027-01', activeNames: ['Groceries'], assignments: { 'Fixed costs': 'Groceries' },
    }, AFTER);
    const secondFuture = chained.planItems.find(item => item.sourcePlanId === firstFuture.id)!;
    expect(secondFuture).toMatchObject({ sourcePlanId: firstFuture.id, category: 'Groceries', startMonth: '2027-01' });
    expect(chained.planItems.find(item => item.id === firstFuture.id)?.endMonth).toBe('2026-12');
    const stale = structuredClone(original);
    stale.planItems[0].name = 'New source name';
    stale.planItems[0].updatedAt = '2026-10-13T15:00:00.000Z';
    const restored = validateBackup(serializeBackup(chained));
    const merged = mergeFinanceData(chained, stale);
    expect(merged.planItems.find(item => item.id === 'spanning')?.endMonth).toBe('2026-09');
    expect(merged.planItems.find(item => item.id === firstFuture.id)?.endMonth).toBe('2026-12');
    expect(merged.planItems.find(item => item.id === secondFuture.id)?.sourcePlanId).toBe(firstFuture.id);
    expect(projectReserve(merged)).toEqual(projectReserve(original));
    expect(projectReserve(restored)).toEqual(projectReserve(original));
    expect(mergeFinanceData(merged, restored)).toEqual(merged);
  });

  it('reconciles concurrent cutovers with different boundaries without overlapping sibling segments', () => {
    const original = state();
    original.planItems = [plan('spanning', 'Housing')];
    original.settings.horizonMonths = 18;
    const october = configureFutureCategories(original, configuration, LATER);
    const january = configureFutureCategories(original, { ...configuration, fromMonth: '2027-01' }, AFTER);
    const merged = mergeFinanceData(october, january);
    expect(merged.planItems.find(item => item.id === 'spanning')?.endMonth).toBe('2026-09');
    expect(merged.planItems.find(item => item.sourcePlanId === 'spanning' && item.startMonth === '2026-10')?.endMonth).toBe('2026-12');
    expect(merged.planItems.find(item => item.sourcePlanId === 'spanning' && item.startMonth === '2027-01')?.endMonth).toBeUndefined();
    expect(projectReserve(merged)).toEqual(projectReserve(original));
    expect(mergeFinanceData(january, october)).toEqual(merged);
    expect(mergeFinanceData(merged, october)).toEqual(merged);
    expect(validateBackup(serializeBackup(merged)).planItems).toEqual(merged.planItems);
  });

  it('rejects self-links, missing sources, cycles, invalid segment boundaries, and conflicting merge metadata', () => {
    const original = state();
    original.planItems = [plan('source', 'Housing'), plan('child', 'Groceries', { startMonth: '2026-10', sourcePlanId: 'source' })];
    const invalid = (sourcePlanId: string) => {
      const data = structuredClone(original);
      data.planItems[1].sourcePlanId = sourcePlanId;
      return data;
    };
    expect(() => validateBackup(invalid('child'))).toThrow('reference itself');
    expect(() => validateBackup(invalid('missing'))).toThrow('unknown source');
    expect(() => validateBackup(invalid(''))).toThrow('valid text');
    const cycle = structuredClone(original);
    cycle.planItems[0].sourcePlanId = 'child';
    expect(() => validateBackup(cycle)).toThrow('cycle');
    const overlap = structuredClone(original);
    overlap.planItems[1].startMonth = overlap.planItems[0].startMonth;
    expect(() => validateBackup(overlap)).toThrow('start after its source');
    const remote = structuredClone(original);
    remote.planItems.push(plan('other-source', 'Music'));
    remote.planItems[1].sourcePlanId = 'other-source';
    expect(() => mergeFinanceData(original, remote)).toThrow('conflicting source');
    const duplicateBoundary = structuredClone(original);
    duplicateBoundary.planItems.push({ ...original.planItems[1], id: 'conflicting-child' });
    expect(() => validateBackup(duplicateBoundary)).toThrow('conflicting boundaries');
  });
});
