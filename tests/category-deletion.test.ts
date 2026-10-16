import { describe, expect, it } from 'vitest';
import { addCategory, allCategoryNames, archiveCategory, assertAvailableCategory, availableCategoryNames, categoryUsage, configureFutureCategories, deleteCategory, listCategories, mergeCategoryCatalog, normalizeCategoryData, renameCategory, resolveCategoryName, restoreCategory } from '../src/lib/categories';
import { createEmptyData, getTransactionScope, summarizeMonth } from '../src/lib/finance';
import type { FinanceData, Transaction } from '../src/lib/types';

const CREATED = new Date('2032-10-01T12:00:00.000Z');
const EDITED = new Date('2032-10-02T12:00:00.000Z');
const DELETED = new Date('2032-10-03T12:00:00.000Z');
const LATER = new Date('2032-10-04T12:00:00.000Z');
const tx = (id: string, category = 'Dining'): Transaction => ({
  id, fingerprint: `fingerprint-${id}`, date: '2032-10-01', month: '2032-10', amountCents: -1_250,
  kind: 'expense', source: 'bank', account: 'Synthetic account', originalDescription: id,
  description: 'Saved note', category, updatedAt: CREATED.toISOString(),
});
function fixture(): FinanceData {
  let data = createEmptyData(CREATED);
  for (const name of ['Dining', 'Leisure', 'Health']) data = addCategory(data, name, CREATED);
  data.transactions = [tx('expense'), tx('refund'), tx('deleted'), tx('unrelated', 'Leisure')];
  data.transactions[1].amountCents = 200;
  data.transactions[2].deletedAt = CREATED.toISOString();
  data.planItems = [{
    id: 'plan', name: 'Saved plan', category: 'Dining', kind: 'expense', behavior: 'monthly',
    defaultAmountCents: 3_000, amounts: { '2032-10': 4_000, '2032-11': 0 },
    startMonth: '2031-01', endMonth: '2033-12', updatedAt: CREATED.toISOString(),
  }, {
    id: 'deleted-plan', name: 'Deleted plan', category: 'Dining', kind: 'expense',
    defaultAmountCents: 5_000, amounts: {}, startMonth: '2032-10',
    updatedAt: CREATED.toISOString(), deletedAt: CREATED.toISOString(),
  }];
  return data;
}
const categoryId = (data: FinanceData, name: string) => data.categories.find(item => item.name === name)!.id;
const financialFields = (data: FinanceData) => ({
  transactions: data.transactions.map(({ category: _category, updatedAt: _updatedAt, scope: _scope, ...item }) => item),
  planItems: data.planItems.map(({ category: _category, updatedAt: _updatedAt, ...item }) => item),
});

describe('permanent category deletion', () => {
  it('requires a replacement when any current or historical item references the category', () => {
    const data = fixture();
    const id = categoryId(data, 'Dining');
    expect(categoryUsage(data, id)).toEqual({ transactions: 3, planItems: 2, workRules: 0, total: 5 });
    expect(() => deleteCategory(data, id, undefined, DELETED)).toThrow('replacement category');
    data.transactions = data.transactions.filter(item => item.deletedAt);
    data.planItems = data.planItems.filter(item => item.deletedAt);
    expect(categoryUsage(data, id).total).toBe(2);
    expect(() => deleteCategory(data, id, undefined, DELETED)).toThrow('replacement category');
  });

  it('reassigns every reference while preserving amounts, identities, dates, notes, and deletion tombstones', () => {
    const original = fixture();
    const snapshot = structuredClone(original);
    const next = deleteCategory(original, categoryId(original, 'Dining'), 'Leisure', DELETED);
    expect(next.categories.find(item => item.name === 'Dining')).toMatchObject({ deletedAt: DELETED.toISOString(), replacementCategory: 'Leisure' });
    expect(next.transactions.map(item => item.category)).toEqual(['Leisure', 'Leisure', 'Leisure', 'Leisure']);
    expect(next.planItems.map(item => item.category)).toEqual(['Leisure', 'Leisure']);
    expect(next.transactions.slice(0, 3).every(item => item.updatedAt === DELETED.toISOString())).toBe(true);
    expect(next.transactions[3].updatedAt).toBe(CREATED.toISOString());
    expect(financialFields(next)).toEqual(financialFields(original));
    expect(summarizeMonth(next, '2032-10').expenseCents).toBe(summarizeMonth(original, '2032-10').expenseCents);
    expect(original).toEqual(snapshot);
    expect(next.updatedAt).toBe(DELETED.toISOString());
  });

  it('removes deleted categories from all selectors and management lists while retaining a durable hidden tombstone', () => {
    const original = fixture();
    const next = deleteCategory(original, categoryId(original, 'Dining'), 'Leisure', DELETED);
    expect(next.categories).toHaveLength(original.categories.length);
    expect(listCategories(next).map(item => item.name)).toEqual(['Health', 'Leisure']);
    expect(allCategoryNames(next)).toEqual(['Health', 'Leisure']);
    expect(availableCategoryNames(next)).toEqual(['Health', 'Leisure']);
    expect(() => assertAvailableCategory(next, 'Dining')).toThrow('available category');
    expect(() => addCategory(next, 'dining', LATER)).toThrow('deleted category');
    expect(() => renameCategory(next, categoryId(next, 'Health'), 'Dining', LATER)).toThrow('deleted category');
    expect(() => renameCategory(next, categoryId(next, 'Dining'), 'Renamed', LATER)).toThrow('Category not found');
    expect(() => archiveCategory(next, categoryId(next, 'Dining'), LATER)).toThrow('Category not found');
    expect(() => restoreCategory(next, categoryId(next, 'Dining'), LATER)).toThrow('Category not found');
    expect(() => configureFutureCategories(next, { fromMonth: '2032-11', activeNames: ['Dining'], assignments: {} }, LATER)).toThrow('was deleted');
  });

  it('allows deleting an unused category without a replacement and keeps unknown stale assignments uncategorized', () => {
    const original = fixture();
    const id = categoryId(original, 'Health');
    expect(categoryUsage(original, id).total).toBe(0);
    const next = deleteCategory(original, id, undefined, DELETED);
    expect(next.transactions).toEqual(original.transactions);
    expect(next.planItems).toEqual(original.planItems);
    expect(next.categories.find(item => item.id === id)?.replacementCategory).toBeUndefined();
    next.transactions.push(tx('stale-assignment', 'Health'));
    const normalized = normalizeCategoryData(next, false);
    expect(normalized.transactions.at(-1)).toMatchObject({ category: '', amountCents: -1_250, description: 'Saved note', updatedAt: DELETED.toISOString() });
    expect(allCategoryNames(normalized)).not.toContain('Health');
    expect(normalizeCategoryData(normalized, false)).toEqual(normalized);
  });

  it('requires an exact, different, active replacement and leaves the original state intact after an invalid choice', () => {
    const data = archiveCategory(fixture(), categoryId(fixture(), 'Health'), EDITED);
    const snapshot = structuredClone(data);
    const id = categoryId(data, 'Dining');
    for (const replacement of ['', 'Dining', 'dining', 'Leisure ', 'Unknown', 'Health']) {
      expect(() => deleteCategory(data, id, replacement, DELETED)).toThrow('different available category');
    }
    const deleted = deleteCategory(data, categoryId(data, 'Health'), undefined, DELETED);
    expect(() => deleteCategory(deleted, id, 'Health', LATER)).toThrow('different available category');
    expect(() => deleteCategory(data, 'unknown', 'Leisure', DELETED)).toThrow('Category not found');
    expect(() => deleteCategory(data, id, 'Leisure', new Date('invalid'))).toThrow('Invalid date');
    expect(data).toEqual(snapshot);
  });

  it('can delete an archived category with existing assignments', () => {
    const original = fixture();
    const id = categoryId(original, 'Dining');
    const archived = archiveCategory(original, id, EDITED);
    expect(deleteCategory(archived, id, 'Leisure', DELETED).transactions[0].category).toBe('Leisure');
  });

  it('resolves every previous name and follows subsequent target renames and deletion chains', () => {
    let data = fixture();
    const sourceId = categoryId(data, 'Dining');
    data = renameCategory(data, sourceId, 'Meals', EDITED);
    data.transactions.push(tx('old-alias', 'Dining'));
    expect(categoryUsage(data, sourceId).transactions).toBe(4);
    data = deleteCategory(data, sourceId, 'Leisure', DELETED);
    data = renameCategory(data, categoryId(data, 'Leisure'), 'Entertainment', LATER);
    data = deleteCategory(data, categoryId(data, 'Entertainment'), 'Health', new Date('2032-10-05T12:00:00.000Z'));
    data.transactions.push(tx('another-stale', 'Dining'), tx('target-stale', 'Leisure'));
    const normalized = normalizeCategoryData(data, false);
    expect(allCategoryNames(normalized)).toEqual(['Health']);
    expect(normalized.transactions.every(item => item.category === 'Health')).toBe(true);
    expect(normalized.planItems.every(item => item.category === 'Health')).toBe(true);
    expect(normalizeCategoryData(normalized, false)).toEqual(normalized);
    expect(() => addCategory(normalized, 'Meals', LATER)).toThrow('deleted category');
  });

  it('reconciles pending category choices through aliases and deletion redirects without adopting unknown labels', () => {
    let data = fixture();
    data = renameCategory(data, categoryId(data, 'Dining'), 'Meals', EDITED);
    data = deleteCategory(data, categoryId(data, 'Meals'), 'Leisure', DELETED);
    data = deleteCategory(data, categoryId(data, 'Health'), undefined, DELETED);
    const snapshot = structuredClone(data);
    expect(resolveCategoryName(data, 'Dining')).toBe('Leisure');
    expect(resolveCategoryName(data, 'Meals')).toBe('Leisure');
    expect(resolveCategoryName(data, 'leisure')).toBe('Leisure');
    expect(resolveCategoryName(data, 'Health')).toBe('');
    expect(resolveCategoryName(data, '')).toBe('');
    expect(resolveCategoryName(data, 'Unknown import label')).toBe('Unknown import label');
    expect(data).toEqual(snapshot);
  });

  it('requires replacement for a work rule even without transactions', () => {
    const data = fixture();
    data.work = { label: 'Employer', expenseCategories: ['Health'], updatedAt: CREATED.toISOString() };
    const id = categoryId(data, 'Health');
    expect(categoryUsage(data, id)).toEqual({ transactions: 0, planItems: 0, workRules: 1, total: 1 });
    expect(() => deleteCategory(data, id, undefined, DELETED)).toThrow('replacement category');
    const next = deleteCategory(data, id, 'Leisure', DELETED);
    expect(next.work).toEqual({ label: 'Employer', expenseCategories: ['Leisure'], updatedAt: DELETED.toISOString() });
  });

  it('redirects and deduplicates work rules without changing any existing effective scope', () => {
    const data = fixture();
    data.work = { label: 'Employer', expenseCategories: ['Dining', 'Health'], updatedAt: CREATED.toISOString() };
    data.transactions.push(tx('explicit-personal'), { ...tx('explicit-work', 'Leisure'), scope: 'work' });
    data.transactions[4].scope = 'personal';
    const scopes = data.transactions.map(item => getTransactionScope(data, item));
    const before = summarizeMonth(data, '2032-10');
    const next = deleteCategory(data, categoryId(data, 'Dining'), 'Leisure', DELETED);
    expect(next.work?.expenseCategories).toEqual(['Leisure', 'Health']);
    expect(next.work?.updatedAt).toBe(DELETED.toISOString());
    expect(next.transactions.map(item => getTransactionScope(next, item))).toEqual(scopes);
    expect(next.transactions.find(item => item.id === 'unrelated')?.scope).toBe('personal');
    expect(next.transactions.find(item => item.id === 'explicit-personal')?.scope).toBe('personal');
    expect(next.transactions.find(item => item.id === 'explicit-work')?.scope).toBe('work');
    const after = summarizeMonth(next, '2032-10');
    for (const field of ['incomeCents', 'expenseCents', 'netCents', 'workInCents', 'workOutCents', 'workNetCents'] as const) expect(after[field]).toBe(before[field]);
    const deduplicated = deleteCategory(next, categoryId(next, 'Leisure'), 'Health', LATER);
    expect(deduplicated.work?.expenseCategories).toEqual(['Health']);
    expect(deduplicated.transactions.map(item => getTransactionScope(deduplicated, item))).toEqual(scopes);
  });

  it('preserves a later saved clock and explicit personal scope during stale assignment normalization', () => {
    let data = deleteCategory(fixture(), categoryId(fixture(), 'Dining'), 'Leisure', DELETED);
    data.transactions[0] = { ...data.transactions[0], category: 'Dining', description: 'Later note', scope: 'personal', updatedAt: LATER.toISOString() };
    data = normalizeCategoryData(data, false);
    expect(data.transactions[0]).toMatchObject({ category: 'Leisure', description: 'Later note', scope: 'personal', updatedAt: LATER.toISOString() });
  });

  it('keeps deletion stronger than a later stale rename and normalizes that newly added alias', () => {
    const initial = fixture();
    const deleted = deleteCategory(initial, categoryId(initial, 'Dining'), 'Leisure', DELETED);
    const renamed = renameCategory(initial, categoryId(initial, 'Dining'), 'Meals', LATER);
    const categories = mergeCategoryCatalog(deleted.categories, renamed.categories);
    const reversed = mergeCategoryCatalog(renamed.categories, deleted.categories);
    expect(reversed).toEqual(categories);
    expect(categories.find(item => item.name === 'Dining')).toMatchObject({ deletedAt: DELETED.toISOString(), replacementCategory: 'Leisure', aliases: ['Meals'] });
    const next = normalizeCategoryData({ ...renamed, categories }, false);
    expect(next.transactions.filter(item => item.category === 'Meals')).toHaveLength(0);
    expect(next.transactions.every(item => item.category === 'Leisure')).toBe(true);
    expect(mergeCategoryCatalog(categories, categories)).toEqual(categories);
  });

  it('resolves concurrent deletion cycles without losing items or restoring either option on repeated merges', () => {
    const initial = fixture();
    const left = deleteCategory(initial, categoryId(initial, 'Dining'), 'Leisure', DELETED);
    const right = deleteCategory(initial, categoryId(initial, 'Leisure'), 'Dining', DELETED);
    const categories = mergeCategoryCatalog(left.categories, right.categories);
    expect(mergeCategoryCatalog(right.categories, left.categories)).toEqual(categories);
    expect(mergeCategoryCatalog(categories, left.categories)).toEqual(categories);
    expect(mergeCategoryCatalog(categories, right.categories)).toEqual(categories);
    expect(categories.filter(item => item.deletedAt).every(item => item.replacementCategory === undefined)).toBe(true);
    const next = normalizeCategoryData({ ...initial, categories }, false);
    expect(allCategoryNames(next)).toEqual(['Health']);
    expect(next.transactions.every(item => item.category === '')).toBe(true);
    expect(financialFields(next)).toEqual(financialFields(initial));
  });
});
