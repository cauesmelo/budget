import { describe, expect, it } from 'vitest';
import { addCategory, allCategoryNames, archiveCategory, assertAvailableCategory, availableCategoryNames, listCategories, normalizeCategoryData, renameCategory, restoreCategory } from '../src/lib/categories';
import { applyImport, createEmptyData, mergeFinanceData, summarizeMonth } from '../src/lib/finance';
import { serializeBackup, validateBackup } from '../src/lib/storage';
import type { FinanceData, ImportResult, Transaction } from '../src/lib/types';

const NOW = new Date('2026-10-11T15:00:00.000Z');
const LATER = new Date('2026-10-12T15:00:00.000Z');
const AFTER = new Date('2026-10-13T15:00:00.000Z');
const transaction = (id: string, category = 'Groceries'): Transaction => ({
  id, fingerprint: id, date: '2026-10-10', month: '2026-10', amountCents: -1_000,
  kind: 'expense', source: 'bank', account: 'Account', originalDescription: id, description: id,
  category, updatedAt: NOW.toISOString(),
});
function state(): FinanceData {
  const data = addCategory(createEmptyData(NOW), 'Groceries', NOW);
  data.transactions = [transaction('expense'), transaction('empty', '')];
  data.planItems = [{ id: 'plan', name: 'Monthly purchase', category: 'Groceries', kind: 'expense', defaultAmountCents: 2_000, amounts: {}, startMonth: '2026-10', updatedAt: NOW.toISOString() }];
  return data;
}
const imported = (transactions: Transaction[]): ImportResult => ({ source: 'bank', transactions, warnings: [] });

describe('category catalog', () => {
  it('adopts referenced categories when restoring an older catalog-free backup', () => {
    const previous: any = state();
    delete previous.categories;
    previous.planItems[0].category = 'Housing';
    previous.transactions.push(transaction('health', 'Health'));
    const restored = validateBackup(JSON.stringify(previous));
    expect(allCategoryNames(restored)).toEqual(['Groceries', 'Health', 'Housing']);
    expect(restored.transactions[1].category).toBe('');
    expect(listCategories(restored)).toEqual(listCategories(validateBackup(previous)));
    expect(createEmptyData(NOW).categories).toEqual([]);
    expect(availableCategoryNames(restored)).not.toContain('Uncategorized');
  });

  it('normalizes whitespace, registers unused categories, and rejects empty or duplicate names', () => {
    const original = createEmptyData(NOW);
    const next = addCategory(original, '  Travel   and leisure  ', NOW);
    expect(allCategoryNames(next)).toEqual(['Travel and leisure']);
    expect(original.categories).toEqual([]);
    expect(() => addCategory(next, 'TRAVEL AND LEISURE', LATER)).toThrow('already exists');
    expect(() => addCategory(next, '   ', LATER)).toThrow('category name');
    expect(() => addCategory(next, 'x'.repeat(501), LATER)).toThrow();
    expect(validateBackup(serializeBackup(next)).categories).toEqual(next.categories);
  });

  it('renames transaction and plan categories without changing cents or tombstones', () => {
    const original = state();
    original.transactions[0].deletedAt = NOW.toISOString();
    const renamed = renameCategory(original, original.categories[0].id, 'Supermarket', LATER);
    expect(renamed.categories[0]).toMatchObject({ id: original.categories[0].id, name: 'Supermarket', aliases: ['Groceries'], updatedAt: LATER.toISOString() });
    expect(renamed.transactions[0]).toMatchObject({ category: 'Supermarket', amountCents: -1_000, deletedAt: NOW.toISOString(), updatedAt: LATER.toISOString() });
    expect(renamed.planItems[0]).toMatchObject({ category: 'Supermarket', defaultAmountCents: 2_000 });
    expect(renamed.transactions[1].category).toBe('');
    expect(original.transactions[0].category).toBe('Groceries');
    expect(() => addCategory(renamed, 'Groceries', AFTER)).toThrow();
    const conflicting = addCategory(renamed, 'Housing', AFTER);
    expect(() => renameCategory(conflicting, original.categories[0].id, 'HOUSING', AFTER)).toThrow();
  });

  it('normalizes aliases containing special property names without prototype pollution', () => {
    let data = state();
    data = renameCategory(data, data.categories[0].id, '__proto__', LATER);
    data.transactions.push(transaction('previous-label'));
    const normalized = normalizeCategoryData(data, false);
    expect(normalized.transactions.filter(item => item.category).every(item => item.category === '__proto__')).toBe(true);
    expect(normalized.planItems[0].category).toBe('__proto__');
    const categories = summarizeMonth(normalized, '2026-10').categories;
    expect(Object.getPrototypeOf(categories)).toBe(Object.prototype);
    expect(Object.hasOwn(categories, '__proto__')).toBe(true);
    expect(categories.__proto__).toBe(2_000);
  });

  it('archives options, preserves history, and restores them for new assignments', () => {
    const original = state();
    const archived = archiveCategory(original, original.categories[0].id, LATER);
    expect(availableCategoryNames(archived)).toEqual([]);
    expect(allCategoryNames(archived)).toEqual(['Groceries']);
    expect(archived.transactions).toEqual(original.transactions);
    expect(archived.planItems).toEqual(original.planItems);
    expect(summarizeMonth(archived, '2026-10').categories.Groceries).toBe(1_000);
    expect(() => addCategory(archived, 'groceries', AFTER)).toThrow('archived');
    expect(() => assertAvailableCategory(archived, 'Groceries')).toThrow('available category');
    const restored = restoreCategory(archived, original.categories[0].id, AFTER);
    expect(availableCategoryNames(restored)).toEqual(['Groceries']);
    expect(restored.categories[0].archivedAt).toBeUndefined();
    expect(restored.categories[0].updatedAt).toBe(AFTER.toISOString());
    expect(() => assertAvailableCategory(restored, 'Groceries')).not.toThrow();
  });

  it('only allows exact registered options or an empty category', () => {
    const data = state();
    expect(() => assertAvailableCategory(data, '')).not.toThrow();
    expect(() => assertAvailableCategory(data, 'Groceries')).not.toThrow();
    for (const name of ['New category', 'groceries', ' Groceries ', '   ']) expect(() => assertAvailableCategory(data, name)).toThrow();
  });

  it('validates the catalog and category assignments before saving current backups', () => {
    const data: any = state();
    data.categories.push({ ...data.categories[0], id: 'other', name: 'GROCERIES' });
    expect(() => validateBackup(data)).toThrow('duplicate names');
    data.categories.pop();
    data.transactions[0].category = 'Invented';
    expect(() => validateBackup(data)).toThrow('Unknown category');
    data.transactions[0].category = 'Groceries';
    data.categories[0].archivedAt = 'yesterday';
    expect(() => validateBackup(data)).toThrow();
    data.categories[0].archivedAt = LATER.toISOString();
    expect(validateBackup(data).transactions[0].category).toBe('Groceries');
  });

  it('reimports previous labels through aliases without restoring archived categories', () => {
    let data = state();
    data = renameCategory(data, data.categories[0].id, 'Supermarket', LATER);
    data = archiveCategory(data, data.categories[0].id, AFTER);
    const next = applyImport(data, imported([transaction('expense'), transaction('new')]), 'statement.xlsx', AFTER);
    expect(next.categories).toHaveLength(1);
    expect(next.categories[0].archivedAt).toBe(AFTER.toISOString());
    expect(next.transactions.find(item => item.id === 'new')?.category).toBe('Supermarket');
    expect(next.imports[0].count).toBe(1);
    expect(availableCategoryNames(next)).toEqual([]);
    const additional = applyImport(next, imported([transaction('health', 'Health')]), 'new.xlsx', AFTER);
    expect(availableCategoryNames(additional)).toEqual(['Health']);
    expect(additional.categories.find(category => category.name === 'Health')?.updatedAt).toBe(AFTER.toISOString());
  });

  it('merges additions, renames, and archives without losing the catalog or restoring old copies', () => {
    const initial = state();
    let local = renameCategory(initial, initial.categories[0].id, 'Supermarket', LATER);
    local = archiveCategory(local, local.categories[0].id, AFTER);
    local = addCategory(local, 'Health', AFTER);
    const previous: any = state();
    delete previous.categories;
    previous.updatedAt = '2026-10-30T00:00:00.000Z';
    previous.transactions.push({ ...transaction('previous-new'), updatedAt: previous.updatedAt });
    const remote = addCategory(validateBackup(previous), 'Housing', AFTER);
    const merged = mergeFinanceData(local, remote);
    expect(allCategoryNames(merged)).toEqual(['Health', 'Housing', 'Supermarket']);
    expect(availableCategoryNames(merged)).toEqual(['Health', 'Housing']);
    expect(merged.transactions.filter(item => item.category)).toHaveLength(2);
    expect(merged.transactions.filter(item => item.category).every(item => item.category === 'Supermarket')).toBe(true);
    expect(mergeFinanceData(merged, merged)).toEqual(merged);
    expect(mergeFinanceData(remote, local)).toEqual({ ...merged, settings: { ...merged.settings, googleClientId: remote.settings.googleClientId } });
    expect(validateBackup(serializeBackup(merged)).categories).toEqual(merged.categories);
  });

  it('converges concurrent renames while preserving both names as aliases', () => {
    const initial = state();
    const left = renameCategory(initial, initial.categories[0].id, 'Shopping', LATER);
    const right = renameCategory(initial, initial.categories[0].id, 'Supermarket', LATER);
    const merged = mergeFinanceData(left, right);
    expect(merged.categories).toHaveLength(1);
    expect(merged.categories[0].name).toBe('Supermarket');
    expect(merged.categories[0].aliases).toEqual(['Groceries', 'Shopping']);
    expect(mergeFinanceData(right, left)).toEqual(merged);
    expect(mergeFinanceData(merged, left)).toEqual(merged);
  });

  it('archiving wins timestamp ties and a later restoration takes precedence', () => {
    const data = state();
    const archived = archiveCategory(data, data.categories[0].id, LATER);
    const active = structuredClone(data);
    active.categories[0].updatedAt = LATER.toISOString();
    expect(mergeFinanceData(active, archived).categories[0].archivedAt).toBe(LATER.toISOString());
    const restored = restoreCategory(archived, data.categories[0].id, AFTER);
    expect(mergeFinanceData(archived, restored).categories[0].archivedAt).toBeUndefined();
  });
});
