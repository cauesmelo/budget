import { describe, expect, it } from 'vitest';
import { addCategory, allCategoryNames, archiveCategory, assertAvailableCategory, availableCategoryNames, deleteCategory, listCategories, normalizeCategoryData, renameCategory, resolveCategoryName } from '../src/lib/categories';
import { createEmptyData, getTransactionScope, summarizeMonth } from '../src/lib/finance';
import type { Category, FinanceData, Transaction } from '../src/lib/types';

const CREATED = new Date('2034-10-01T12:00:00.000Z');
const RENAMED = new Date('2034-10-02T12:00:00.000Z');
const DELETED = new Date('2034-10-03T12:00:00.000Z');
const REUSED = new Date('2034-10-04T12:00:00.000Z');
const LATER = new Date('2034-10-05T12:00:00.000Z');
const OLD = 'One-off shopping';
const OTHER = 'Purchases';
const TARGET = 'Replacement';

function transaction(id: string, category: string, patch: Partial<Transaction> = {}): Transaction {
  return {
    id, fingerprint: `synthetic-${id}`, date: '2034-10-01', month: '2034-10', amountCents: -2_350,
    kind: 'expense', source: 'bank', account: 'Synthetic account', originalDescription: `Original ${id}`,
    description: `Saved note ${id}`, category, updatedAt: CREATED.toISOString(), ...patch,
  };
}

function fixture(): FinanceData {
  let data = createEmptyData(CREATED);
  for (const name of [OLD, OTHER, TARGET, 'Archived']) data = addCategory(data, name, CREATED);
  data.transactions = [transaction('old', OLD), transaction('existing', OTHER), transaction('target', TARGET), transaction('deleted', OLD, { deletedAt: CREATED.toISOString() })];
  data.planItems = [OLD, OTHER].map((category, index) => ({
    id: `plan-${index}`, name: `Synthetic budget ${index}`, category, kind: 'expense',
    defaultAmountCents: (index + 1) * 10_000, amounts: { '2034-11': 0, '2034-12': 15_000 },
    startMonth: '2034-10', endMonth: '2035-12', updatedAt: CREATED.toISOString(),
  }));
  return normalizeCategoryData(data, false);
}

function category(data: FinanceData, name: string): Category {
  return data.categories.find(item => item.name === name && !item.deletedAt)!;
}

function withoutCategoryEdits(data: FinanceData) {
  return {
    transactions: data.transactions.map(({ category: _category, updatedAt: _updatedAt, scope: _scope, ...item }) => item),
    planItems: data.planItems.map(({ category: _category, updatedAt: _updatedAt, ...item }) => item),
  };
}

describe('reusing deleted category names', () => {
  it('renames an existing category to a deleted name without restoring or merging the deleted identity', () => {
    const original = fixture();
    const oldId = category(original, OLD).id;
    const otherId = category(original, OTHER).id;
    const deleted = deleteCategory(original, oldId, TARGET, DELETED);
    const snapshot = structuredClone(deleted);
    const reused = renameCategory(deleted, otherId, OLD, REUSED);

    expect(category(reused, OLD).id).toBe(otherId);
    expect(reused.categories.find(item => item.id === oldId)?.deletedAt).toBe(DELETED.toISOString());
    expect(availableCategoryNames(reused).filter(name => name === OLD)).toHaveLength(1);
    expect(reused.transactions.map(item => item.category)).toEqual([TARGET, OLD, TARGET, TARGET]);
    expect(reused.planItems.map(item => item.category)).toEqual([TARGET, OLD]);
    expect(reused.transactions[0].updatedAt).toBe(DELETED.toISOString());
    expect(reused.transactions[1].updatedAt).toBe(REUSED.toISOString());
    expect(reused.transactions[2].updatedAt).toBe(CREATED.toISOString());
    expect(reused.transactions[3].deletedAt).toBe(CREATED.toISOString());
    expect(withoutCategoryEdits(reused)).toEqual(withoutCategoryEdits(original));
    expect(summarizeMonth(reused, '2034-10').expenseCents).toBe(summarizeMonth(original, '2034-10').expenseCents);
    expect(resolveCategoryName(reused, OLD)).toBe(OLD);
    expect(resolveCategoryName(reused, OTHER)).toBe(OLD);
    expect(normalizeCategoryData(reused, false)).toEqual(reused);
    expect(deleted).toEqual(snapshot);
  });

  it('creates a distinct category after deletion and keeps reassigned history at its replacement', () => {
    const original = fixture();
    const oldId = category(original, OLD).id;
    const deleted = deleteCategory(original, oldId, TARGET, DELETED);
    const reused = addCategory(deleted, `  ${OLD.toUpperCase()}  `, REUSED);

    expect(category(reused, OLD.toUpperCase()).id).not.toBe(oldId);
    expect(reused.categories.find(item => item.id === oldId)?.deletedAt).toBe(DELETED.toISOString());
    expect(reused.transactions).toEqual(deleted.transactions);
    expect(reused.planItems).toEqual(deleted.planItems);
    expect(() => assertAvailableCategory(reused, OLD.toUpperCase())).not.toThrow();
    expect(resolveCategoryName(reused, OLD)).toBe(OLD.toUpperCase());
    expect(normalizeCategoryData(reused, false)).toEqual(reused);
  });

  it('allows reusing a deleted category alias without reclaiming its other previous names', () => {
    let data = fixture();
    const oldId = category(data, OLD).id;
    data = renameCategory(data, oldId, 'Temporary shopping', RENAMED);
    data = deleteCategory(data, oldId, TARGET, DELETED);
    data = renameCategory(data, category(data, OTHER).id, OLD, REUSED);

    expect(resolveCategoryName(data, OLD)).toBe(OLD);
    expect(resolveCategoryName(data, 'Temporary shopping')).toBe(TARGET);
    expect(data.transactions.find(item => item.id === 'old')?.category).toBe(TARGET);
    expect(data.transactions.find(item => item.id === 'existing')?.category).toBe(OLD);
    expect(listCategories(data).map(item => item.name)).not.toContain('Temporary shopping');
  });

  it('allows reusing an unused deleted name without adopting records into the new category', () => {
    const original = fixture();
    const id = category(original, 'Archived').id;
    const deleted = deleteCategory(original, id, undefined, DELETED);
    const recreated = addCategory(deleted, 'Archived', REUSED);

    expect(category(recreated, 'Archived').id).not.toBe(id);
    expect(recreated.transactions).toEqual(original.transactions);
    expect(recreated.planItems).toEqual(original.planItems);
    expect(availableCategoryNames(recreated)).toContain('Archived');
    expect(recreated.categories.find(item => item.id === id)?.deletedAt).toBe(DELETED.toISOString());
  });

  it('continues to reject active, archived, and active-alias collisions after a name is reclaimed', () => {
    let data = fixture();
    data = archiveCategory(data, category(data, 'Archived').id, RENAMED);
    data = deleteCategory(data, category(data, OLD).id, TARGET, DELETED);
    data = renameCategory(data, category(data, OTHER).id, OLD, REUSED);
    const snapshot = structuredClone(data);

    for (const name of [OLD.toUpperCase(), OTHER, 'Archived', TARGET]) {
      expect(() => addCategory(data, name, LATER)).toThrow();
      if (name !== TARGET) expect(() => renameCategory(data, category(data, TARGET).id, name, LATER)).toThrow();
    }
    expect(data).toEqual(snapshot);
    expect(availableCategoryNames(data)).not.toContain('Archived');
    expect(allCategoryNames(data)).toContain('Archived');
  });

  it('can rename the actual replacement to the deleted name without creating a replacement cycle', () => {
    const original = fixture();
    const oldId = category(original, OLD).id;
    const targetId = category(original, TARGET).id;
    const deleted = deleteCategory(original, oldId, TARGET, DELETED);
    const renamed = renameCategory(deleted, targetId, OLD, REUSED);

    expect(category(renamed, OLD).id).toBe(targetId);
    expect(renamed.categories.find(item => item.id === oldId)?.deletedAt).toBe(DELETED.toISOString());
    expect(renamed.transactions.map(item => item.category)).toEqual([OLD, OTHER, OLD, OLD]);
    expect(renamed.planItems.map(item => item.category)).toEqual([OLD, OTHER]);
    expect(resolveCategoryName(renamed, TARGET)).toBe(OLD);
    expect(normalizeCategoryData(renamed, false)).toEqual(renamed);
  });

  it('preserves implicit work and personal scopes when the old work category name is reused', () => {
    const original = fixture();
    original.work = { label: 'Synthetic employer', expenseCategories: [OLD], updatedAt: CREATED.toISOString() };
    original.transactions.push(transaction('explicit-personal', OLD, { scope: 'personal' }), transaction('explicit-work', OTHER, { scope: 'work' }));
    const scopes = original.transactions.map(item => getTransactionScope(original, item));
    const before = summarizeMonth(original, '2034-10');
    const deleted = deleteCategory(original, category(original, OLD).id, TARGET, DELETED);
    const renamed = renameCategory(deleted, category(deleted, OTHER).id, OLD, REUSED);

    expect(renamed.work?.expenseCategories).toEqual([TARGET]);
    expect(renamed.transactions.map(item => getTransactionScope(renamed, item))).toEqual(scopes);
    expect(renamed.transactions.find(item => item.id === 'existing')?.category).toBe(OLD);
    expect(getTransactionScope(renamed, renamed.transactions.find(item => item.id === 'existing')!)).toBe('personal');
    const after = summarizeMonth(renamed, '2034-10');
    for (const key of ['expenseCents', 'incomeCents', 'netCents', 'workInCents', 'workOutCents', 'workNetCents'] as const) expect(after[key]).toBe(before[key]);
  });

  it('supports repeated deletion and reuse without reviving previous category generations', () => {
    let data = fixture();
    const originalId = category(data, OLD).id;
    data = deleteCategory(data, originalId, TARGET, DELETED);
    data = addCategory(data, OLD, REUSED);
    const secondId = category(data, OLD).id;
    data.transactions.push(transaction('second-generation', OLD, { updatedAt: REUSED.toISOString() }));
    data = deleteCategory(data, secondId, OTHER, LATER);
    data = addCategory(data, OLD, new Date('2034-10-06T12:00:00.000Z'));
    const thirdId = category(data, OLD).id;

    expect(new Set([originalId, secondId, thirdId]).size).toBe(3);
    expect(data.transactions.find(item => item.id === 'old')?.category).toBe(TARGET);
    expect(data.transactions.find(item => item.id === 'second-generation')?.category).toBe(OTHER);
    expect(data.categories.filter(item => item.deletedAt)).toHaveLength(2);
    expect(availableCategoryNames(data).filter(name => name === OLD)).toHaveLength(1);
    expect(normalizeCategoryData(data, false)).toEqual(data);
  });
});
