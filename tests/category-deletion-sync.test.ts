import { describe, expect, it } from 'vitest';
import { addCategory, allCategoryNames, availableCategoryNames, deleteCategory, normalizeCategoryData, renameCategory } from '../src/lib/categories';
import { applyImport, createEmptyData, getTransactionScope, mergeFinanceData, summarizeMonth } from '../src/lib/finance';
import { serializeBackup, validateBackup } from '../src/lib/storage';
import type { Category, FinanceData, Transaction } from '../src/lib/types';

const INITIAL = new Date('2032-10-01T12:00:00.000Z');
const DELETION = new Date('2032-10-02T12:00:00.000Z');
const LATER = new Date('2032-10-03T12:00:00.000Z');
const MONTH = '2032-10';
const transaction = (id: string, category = 'Old category', patch: Partial<Transaction> = {}): Transaction => ({
  id, fingerprint: `${id}-fingerprint`, date: `${MONTH}-01`, month: MONTH, amountCents: -1_000,
  kind: 'expense', source: 'bank', account: 'Example account', originalDescription: 'Example purchase',
  description: 'Saved description', category, updatedAt: INITIAL.toISOString(), ...patch,
});

function fixture(): FinanceData {
  let data = createEmptyData(INITIAL);
  for (const name of ['Old category', 'Replacement', 'Other']) data = addCategory(data, name, INITIAL);
  data.transactions = [transaction('existing'), transaction('deleted', 'Old category', { deletedAt: INITIAL.toISOString() }), transaction('target', 'Replacement', { amountCents: -2_000 })];
  data.planItems = [{ id: 'budget', name: 'Monthly expense', category: 'Old category', kind: 'expense', defaultAmountCents: 12_000, amounts: {}, startMonth: MONTH, updatedAt: INITIAL.toISOString() }];
  return normalizeCategoryData(data, false);
}

function category(data: FinanceData, name: string): Category {
  return data.categories.find(item => item.name === name)!;
}

function deleted(data: FinanceData = fixture()): FinanceData {
  return deleteCategory(data, category(data, 'Old category').id, 'Replacement', DELETION);
}

describe('category deletion persistence and synchronization', () => {
  it('round-trips replacement tombstones without changing record identity, money or deletion status', () => {
    const original = fixture();
    const next = deleted(original);
    const restored = validateBackup(serializeBackup(next));
    expect(restored).toEqual(next);
    expect(category(restored, 'Old category')).toMatchObject({ deletedAt: DELETION.toISOString(), replacementCategory: 'Replacement' });
    expect(allCategoryNames(restored)).not.toContain('Old category');
    expect(restored.transactions.map(item => [item.id, item.fingerprint, item.amountCents, item.deletedAt])).toEqual(original.transactions.map(item => [item.id, item.fingerprint, item.amountCents, item.deletedAt]));
    expect(restored.planItems[0]).toMatchObject({ category: 'Replacement', defaultAmountCents: 12_000 });
    expect(normalizeCategoryData(restored, false)).toEqual(restored);
    expect(validateBackup(fixture())).toEqual(fixture());
  });

  it('redirects newer stale-device assignments and keeps their edited fields in either merge order', () => {
    const original = fixture();
    const local = deleted(original);
    const stale = structuredClone(original);
    stale.transactions[0].description = 'More recent description';
    stale.transactions[0].updatedAt = LATER.toISOString();
    stale.transactions.push(transaction('remote-new', 'Old category', { updatedAt: LATER.toISOString(), scope: 'work' }));
    stale.categories.find(item => item.name === 'Old category')!.updatedAt = LATER.toISOString();
    stale.updatedAt = LATER.toISOString();
    const left = mergeFinanceData(local, stale);
    const right = mergeFinanceData(stale, local);
    expect(left).toEqual(right);
    expect(category(left, 'Old category').deletedAt).toBe(DELETION.toISOString());
    expect(availableCategoryNames(left)).not.toContain('Old category');
    expect(left.transactions.find(item => item.id === 'existing')).toMatchObject({ category: 'Replacement', description: 'More recent description', updatedAt: LATER.toISOString() });
    expect(left.transactions.find(item => item.id === 'remote-new')).toMatchObject({ category: 'Replacement', scope: 'work' });
    expect(left.transactions.find(item => item.id === 'deleted')?.deletedAt).toBe(INITIAL.toISOString());
    expect(mergeFinanceData(left, stale)).toEqual(left);
    expect(validateBackup(serializeBackup(left))).toEqual(left);
  });

  it('follows replacement renames, aliases and later deletions through repeated old imports', () => {
    const original = fixture();
    const once = deleted(original);
    const renamed = renameCategory(once, category(once, 'Replacement').id, 'Current name', LATER);
    const twice = deleteCategory(renamed, category(renamed, 'Current name').id, 'Other', LATER);
    const imported = applyImport(twice, { source: 'bank', warnings: [], transactions: [transaction('existing'), transaction('deleted'), transaction('new-from-old-copy')] }, 'example-statement.xlsx', LATER);
    expect(imported.transactions).toHaveLength(original.transactions.length + 1);
    expect(imported.transactions.find(item => item.id === 'deleted')?.deletedAt).toBe(INITIAL.toISOString());
    expect(imported.transactions.every(item => item.category === 'Other')).toBe(true);
    expect(availableCategoryNames(imported)).toEqual(['Other']);
    expect(validateBackup(serializeBackup(imported))).toEqual(imported);
    const merged = mergeFinanceData(original, imported);
    expect(merged.transactions.every(item => item.category === 'Other')).toBe(true);
    expect(availableCategoryNames(merged)).toEqual(['Other']);
  });

  it('loads saved settings into a fresh device while applying the deleted catalog', () => {
    const saved = deleted();
    saved.settings.monthlyIncomeCents = 500_000;
    saved.settings.initialReserveCents = 200_000;
    const fresh = createEmptyData(LATER);
    fresh.settings.googleClientId = 'device-only-client';
    const merged = mergeFinanceData(fresh, saved);
    expect(merged.settings).toMatchObject({ monthlyIncomeCents: 500_000, initialReserveCents: 200_000, googleClientId: 'device-only-client' });
    expect(availableCategoryNames(merged)).not.toContain('Old category');
    expect(merged.transactions.find(item => item.id === 'existing')?.category).toBe('Replacement');
  });

  it('preserves implicit work scope on new stale-device rows and personal target rows', () => {
    const original = fixture();
    original.work = { label: 'Example employer', expenseCategories: ['Old category'], updatedAt: INITIAL.toISOString() };
    const local = deleted(original);
    const stale = structuredClone(original);
    stale.transactions.push(transaction('new-work', 'Old category', { amountCents: -3_000, updatedAt: LATER.toISOString() }));
    stale.transactions.push(transaction('new-personal', 'Replacement', { amountCents: -4_000, updatedAt: LATER.toISOString() }));
    stale.transactions[0].description = 'Updated work description';
    stale.transactions[0].updatedAt = LATER.toISOString();
    stale.updatedAt = LATER.toISOString();
    const merged = mergeFinanceData(local, stale);
    expect(mergeFinanceData(stale, local)).toEqual(merged);
    expect(merged.work).toMatchObject({ expenseCategories: ['Replacement'], updatedAt: DELETION.toISOString() });
    expect(getTransactionScope(merged, merged.transactions.find(item => item.id === 'new-work')!)).toBe('work');
    expect(getTransactionScope(merged, merged.transactions.find(item => item.id === 'new-personal')!)).toBe('personal');
    expect(getTransactionScope(merged, merged.transactions.find(item => item.id === 'target')!)).toBe('personal');
    expect(merged.transactions.find(item => item.id === 'existing')?.description).toBe('Updated work description');
    expect(summarizeMonth(merged, MONTH)).toMatchObject({ expenseCents: 6_000, workOutCents: 4_000 });
    expect(validateBackup(serializeBackup(merged))).toEqual(merged);
    expect(mergeFinanceData(merged, stale)).toEqual(merged);
  });

  it('keeps a later work configuration edit when older category rules are redirected', () => {
    const original = fixture();
    original.work = { label: 'Example employer', expenseCategories: ['Old category'], updatedAt: INITIAL.toISOString() };
    const local = deleted(original);
    const later = structuredClone(original);
    later.work = { label: 'Updated employer', expenseCategories: ['Other'], updatedAt: LATER.toISOString() };
    later.updatedAt = LATER.toISOString();
    for (const merged of [mergeFinanceData(local, later), mergeFinanceData(later, local)]) {
      expect(merged.work).toEqual(later.work);
      expect(availableCategoryNames(merged)).not.toContain('Old category');
      expect(merged.transactions[0].category).toBe('Replacement');
    }
  });

  it('converges concurrent replacement cycles into deleted categories without resurrecting either one', () => {
    const original = fixture();
    const left = deleted(original);
    const right = deleteCategory(original, category(original, 'Replacement').id, 'Old category', DELETION);
    const merged = mergeFinanceData(left, right);
    expect(mergeFinanceData(right, left)).toEqual(merged);
    expect(availableCategoryNames(merged)).toEqual(['Other']);
    expect(merged.transactions.every(item => item.category === '')).toBe(true);
    expect(merged.planItems[0].category).toBe('');
    expect(mergeFinanceData(merged, original)).toEqual(merged);
    expect(validateBackup(serializeBackup(merged))).toEqual(merged);
  });
});

describe('category deletion backup validation', () => {
  it.each([
    ['invalid deletion timestamp', (data: FinanceData) => { category(data, 'Old category').deletedAt = 'yesterday'; }],
    ['empty replacement', (data: FinanceData) => { category(data, 'Old category').replacementCategory = ''; }],
    ['unknown replacement', (data: FinanceData) => { category(data, 'Old category').replacementCategory = 'Unknown'; }],
    ['replacement on an active category', (data: FinanceData) => { delete category(data, 'Old category').deletedAt; }],
    ['replacement whitespace', (data: FinanceData) => { category(data, 'Old category').replacementCategory = ' Replacement'; }],
    ['self replacement through an alias', (data: FinanceData) => { category(data, 'Old category').aliases = ['Previous name']; category(data, 'Old category').replacementCategory = 'Previous name'; }],
    ['replacement cycle', (data: FinanceData) => { const target = category(data, 'Replacement'); target.deletedAt = DELETION.toISOString(); target.replacementCategory = 'Old category'; }],
  ])('rejects %s before restoring data', (_description, mutate) => {
    const data = deleted();
    mutate(data);
    expect(() => validateBackup(data)).toThrow('Invalid backup: categories');
  });

  it('accepts an unused deletion with no replacement and an archived replacement target', () => {
    const data = fixture();
    const unused = deleteCategory(data, category(data, 'Other').id, undefined, DELETION);
    expect(category(validateBackup(unused), 'Other')).toMatchObject({ deletedAt: DELETION.toISOString() });
    const used = deleted(data);
    category(used, 'Replacement').archivedAt = LATER.toISOString();
    expect(validateBackup(used).transactions[0].category).toBe('Replacement');
  });
});
