import { describe, expect, it } from 'vitest';
import { addCategory, availableCategoryNames, deleteCategory, normalizeCategoryData, renameCategory, resolveCategoryName } from '../src/lib/categories';
import { createEmptyData, getTransactionScope, mergeFinanceData, summarizeMonth } from '../src/lib/finance';
import { serializeBackup, validateBackup } from '../src/lib/storage';
import type { Category, FinanceData, Transaction } from '../src/lib/types';

const INITIAL = new Date('2034-10-01T12:00:00.000Z');
const DELETED = new Date('2034-10-02T12:00:00.000Z');
const REUSED = new Date('2034-10-03T12:00:00.000Z');
const EDITED = new Date('2034-10-04T12:00:00.000Z');
const OLD = 'One-off shopping';
const OTHER = 'Purchases';
const TARGET = 'Replacement';

function transaction(id: string, category: string, patch: Partial<Transaction> = {}): Transaction {
  return {
    id, fingerprint: `synthetic-${id}`, date: '2034-10-01', month: '2034-10', amountCents: -1_200,
    kind: 'expense', source: 'bank', account: 'Synthetic account', originalDescription: `Original ${id}`,
    description: `Note ${id}`, category, updatedAt: INITIAL.toISOString(), ...patch,
  };
}

function fixture(): FinanceData {
  let data = createEmptyData(INITIAL);
  for (const name of [OLD, OTHER, TARGET, 'Another option']) data = addCategory(data, name, INITIAL);
  data.transactions = [transaction('old', OLD), transaction('existing', OTHER), transaction('target', TARGET)];
  data.planItems = [OLD, OTHER].map((category, index) => ({
    id: `plan-${index}`, name: `Synthetic budget ${index}`, category, kind: 'expense',
    defaultAmountCents: 10_000 + index * 5_000, amounts: { '2034-11': 12_000 }, startMonth: '2034-10', updatedAt: INITIAL.toISOString(),
  }));
  return normalizeCategoryData(data, false);
}

function category(data: FinanceData, name: string): Category {
  return data.categories.find(item => item.name === name && !item.deletedAt)!;
}

function reclaimed(data = fixture()): FinanceData {
  const deleted = deleteCategory(data, category(data, OLD).id, TARGET, DELETED);
  return renameCategory(deleted, category(deleted, OTHER).id, OLD, REUSED);
}

function assertConverges(left: FinanceData, right: FinanceData): FinanceData {
  const merged = mergeFinanceData(left, right);
  expect(mergeFinanceData(right, left)).toEqual(merged);
  expect(mergeFinanceData(merged, right)).toEqual(merged);
  expect(mergeFinanceData(left, merged)).toEqual(merged);
  expect(mergeFinanceData(merged, merged)).toEqual(merged);
  expect(validateBackup(serializeBackup(merged))).toEqual(merged);
  return merged;
}

describe('deleted category name reuse persistence and synchronization', () => {
  it('round-trips a reclaimed name with its deleted identity and historical replacement intact', () => {
    const original = fixture();
    const oldId = category(original, OLD).id;
    const activeId = category(original, OTHER).id;
    const reused = reclaimed(original);
    const restored = validateBackup(serializeBackup(reused));

    expect(restored).toEqual(reused);
    expect(category(restored, OLD).id).toBe(activeId);
    expect(restored.categories.find(item => item.id === oldId)?.deletedAt).toBe(DELETED.toISOString());
    expect(restored.transactions.map(item => item.category)).toEqual([TARGET, OLD, TARGET]);
    expect(restored.planItems.map(item => item.category)).toEqual([TARGET, OLD]);
    expect(normalizeCategoryData(restored, false)).toEqual(restored);
  });

  it('routes an older backup to the original replacement while retaining new assignments to the reused name', () => {
    const oldBackup = fixture();
    const current = reclaimed(oldBackup);
    current.transactions.push(transaction('current-new', OLD, { updatedAt: EDITED.toISOString(), description: 'Current assignment' }));
    current.updatedAt = EDITED.toISOString();
    const merged = assertConverges(current, validateBackup(serializeBackup(oldBackup)));

    expect(merged.transactions.find(item => item.id === 'old')?.category).toBe(TARGET);
    expect(merged.transactions.find(item => item.id === 'existing')?.category).toBe(OLD);
    expect(merged.transactions.find(item => item.id === 'current-new')).toMatchObject({ category: OLD, description: 'Current assignment', updatedAt: EDITED.toISOString() });
    expect(availableCategoryNames(merged).filter(name => name === OLD)).toHaveLength(1);
  });

  it('uses the stale device category identity even for new or edited records dated after the name was reused', () => {
    const original = fixture();
    const current = reclaimed(original);
    current.transactions.push(transaction('current-new', OLD, { updatedAt: EDITED.toISOString() }));
    current.updatedAt = EDITED.toISOString();
    const stale = structuredClone(original);
    stale.transactions[0] = { ...stale.transactions[0], description: 'Later stale-device note', updatedAt: EDITED.toISOString() };
    stale.transactions.push(transaction('stale-new', OLD, { updatedAt: EDITED.toISOString() }));
    stale.planItems[0] = { ...stale.planItems[0], amounts: { '2034-11': 29_000 }, updatedAt: EDITED.toISOString() };
    stale.planItems.push({ ...stale.planItems[0], id: 'stale-new-plan', name: 'New stale-device plan' });
    stale.updatedAt = EDITED.toISOString();
    const merged = assertConverges(current, stale);

    expect(merged.transactions.find(item => item.id === 'old')).toMatchObject({ category: TARGET, description: 'Later stale-device note', updatedAt: EDITED.toISOString() });
    expect(merged.transactions.find(item => item.id === 'stale-new')).toMatchObject({ category: TARGET, amountCents: -1_200 });
    expect(merged.transactions.find(item => item.id === 'current-new')?.category).toBe(OLD);
    expect(merged.planItems.find(item => item.id === 'plan-0')).toMatchObject({ category: TARGET, amounts: { '2034-11': 29_000 } });
    expect(merged.planItems.find(item => item.id === 'stale-new-plan')?.category).toBe(TARGET);
  });

  it('redirects catalog-free old backups without capturing current assignments to the reused name', () => {
    const original = fixture();
    const current = reclaimed(original);
    current.transactions.push(transaction('current-new', OLD, { updatedAt: EDITED.toISOString() }));
    current.updatedAt = EDITED.toISOString();
    const oldBackup = structuredClone(original) as Omit<FinanceData, 'categories'> & { categories?: Category[] };
    delete oldBackup.categories;
    oldBackup.transactions.push(transaction('legacy-new', OLD));
    const restored = validateBackup(oldBackup);
    const merged = assertConverges(current, restored);

    expect(merged.transactions.find(item => item.id === 'legacy-new')?.category).toBe(TARGET);
    expect(merged.transactions.find(item => item.id === 'current-new')?.category).toBe(OLD);
    expect(merged.transactions.find(item => item.id === 'existing')?.category).toBe(OLD);
  });

  it('keeps a deleted identity and newly added stale alias separate from the current reclaimed name', () => {
    const original = fixture();
    const current = reclaimed(original);
    const stale = renameCategory(original, category(original, OLD).id, 'Stale shopping alias', EDITED);
    stale.transactions.push(transaction('stale-alias', 'Stale shopping alias', { updatedAt: EDITED.toISOString() }));
    const merged = assertConverges(current, stale);

    expect(availableCategoryNames(merged)).toContain(OLD);
    expect(availableCategoryNames(merged)).not.toContain('Stale shopping alias');
    expect(merged.transactions.find(item => item.id === 'old')?.category).toBe(TARGET);
    expect(merged.transactions.find(item => item.id === 'stale-alias')?.category).toBe(TARGET);
    expect(merged.transactions.find(item => item.id === 'existing')?.category).toBe(OLD);
  });

  it('does not bridge a deleted ancestor into its claimant through a stale rename of the claimant previous name', () => {
    let original = createEmptyData(INITIAL);
    for (const name of [OLD, TARGET]) original = addCategory(original, name, INITIAL);
    original.transactions = [transaction('old', OLD)];
    let current = addCategory(original, OTHER, new Date('2034-10-01T15:00:00.000Z'));
    const currentId = category(current, OTHER).id;
    current = deleteCategory(current, category(current, OLD).id, TARGET, DELETED);
    current = renameCategory(current, currentId, OLD, REUSED);
    current.transactions.push(transaction('current', OLD, { updatedAt: REUSED.toISOString() }));
    const stale = renameCategory(original, category(original, OLD).id, OTHER, EDITED);
    stale.transactions.push(transaction('stale', OTHER, { updatedAt: EDITED.toISOString() }));
    const merged = assertConverges(current, stale);

    expect(category(merged, OLD).id).toBe(currentId);
    expect(availableCategoryNames(merged)).toEqual([OLD, TARGET]);
    expect(resolveCategoryName(merged, OTHER)).toBe(OLD);
    expect(merged.transactions.find(item => item.id === 'old')?.category).toBe(TARGET);
    expect(merged.transactions.find(item => item.id === 'stale')?.category).toBe(TARGET);
    expect(merged.transactions.find(item => item.id === 'current')?.category).toBe(OLD);
  });

  it('keeps the deepest ownership generation when the same category is renamed at the same time on two devices', () => {
    const original = fixture();
    const deleted = deleteCategory(original, category(original, OLD).id, TARGET, DELETED);
    const sameTime = new Date('2034-10-05T12:00:00.000Z');
    const left = renameCategory(deleted, category(deleted, OTHER).id, OLD, sameTime);
    let right = addCategory(deleted, OLD, REUSED);
    const intermediateId = category(right, OLD).id;
    right = deleteCategory(right, intermediateId, TARGET, EDITED);
    right = renameCategory(right, category(right, OTHER).id, OLD, sameTime);
    const merged = assertConverges(left, right);

    expect(category(merged, OLD).id).toBe(category(original, OTHER).id);
    expect(category(merged, OLD).nameReclaims).toContainEqual({ name: OLD, fromCategoryId: intermediateId });
    expect(merged.categories.filter(item => item.deletedAt)).toHaveLength(2);
    expect(merged.transactions.find(item => item.id === 'existing')?.category).toBe(OLD);
  });

  it('resolves simultaneous deletion redirects to different generations consistently in both merge orders', () => {
    const original = fixture();
    const sameTime = new Date('2034-10-07T12:00:00.000Z');
    const left = deleteCategory(original, category(original, OTHER).id, OLD, sameTime);
    let right = deleteCategory(original, category(original, OLD).id, TARGET, DELETED);
    right = addCategory(right, OLD, REUSED);
    const newId = category(right, OLD).id;
    right = deleteCategory(right, category(right, OTHER).id, OLD, sameTime);
    const merged = assertConverges(left, right);

    expect(merged.transactions).toHaveLength(original.transactions.length);
    expect(category(merged, OLD).id).toBe(newId);
    expect([category(original, OLD).id, newId]).toContain(merged.categories.find(item => item.id === category(original, OTHER).id)?.replacementCategoryId);
  });

  it('keeps concurrent deletion stronger than losing rename claims against each other', () => {
    const original = fixture();
    let left = deleteCategory(original, category(original, OLD).id, TARGET, DELETED);
    left = renameCategory(left, category(left, OTHER).id, OLD, REUSED);
    let right = deleteCategory(original, category(original, OTHER).id, TARGET, DELETED);
    right = renameCategory(right, category(right, OLD).id, OTHER, REUSED);
    const merged = assertConverges(left, right);

    expect(availableCategoryNames(merged)).toEqual(['Another option', TARGET]);
    expect(merged.transactions.every(item => item.category === TARGET)).toBe(true);
    expect(merged.categories.filter(item => item.deletedAt)).toHaveLength(2);
    const recreated = addCategory(merged, OLD, EDITED);
    expect(validateBackup(serializeBackup(recreated))).toEqual(recreated);
    expect(availableCategoryNames(recreated)).toContain(OLD);
    expect(recreated.transactions.every(item => item.category === TARGET)).toBe(true);
  });

  it('leaves new stale assignments uncategorized when the deleted identity had no replacement', () => {
    const original = fixture();
    const unusedName = 'Another option';
    const deleted = deleteCategory(original, category(original, unusedName).id, undefined, DELETED);
    const current = addCategory(deleted, unusedName, REUSED);
    current.transactions.push(transaction('current-new', unusedName, { updatedAt: EDITED.toISOString() }));
    const stale = structuredClone(original);
    stale.transactions.push(transaction('stale-new', unusedName, { updatedAt: EDITED.toISOString() }));
    stale.updatedAt = EDITED.toISOString();
    const merged = assertConverges(current, stale);

    expect(merged.transactions.find(item => item.id === 'stale-new')?.category).toBe('');
    expect(merged.transactions.find(item => item.id === 'current-new')?.category).toBe(unusedName);
    expect(availableCategoryNames(merged)).toContain(unusedName);
  });

  it('preserves implicit work and personal scopes while resolving stale assignments after reuse', () => {
    const original = fixture();
    original.work = { label: 'Synthetic employer', expenseCategories: [OLD], updatedAt: INITIAL.toISOString() };
    const current = reclaimed(original);
    current.transactions.push(transaction('current-personal', OLD, { updatedAt: EDITED.toISOString() }));
    current.updatedAt = EDITED.toISOString();
    const stale = structuredClone(original);
    stale.transactions.push(transaction('stale-work', OLD, { updatedAt: EDITED.toISOString() }), transaction('stale-personal', TARGET, { updatedAt: EDITED.toISOString() }));
    stale.transactions[0].description = 'Stale work note';
    stale.transactions[0].updatedAt = EDITED.toISOString();
    stale.updatedAt = EDITED.toISOString();
    const merged = assertConverges(current, stale);

    expect(merged.work?.expenseCategories).toEqual([TARGET]);
    for (const id of ['old', 'stale-work']) expect(getTransactionScope(merged, merged.transactions.find(item => item.id === id)!)).toBe('work');
    for (const id of ['existing', 'target', 'current-personal', 'stale-personal']) expect(getTransactionScope(merged, merged.transactions.find(item => item.id === id)!)).toBe('personal');
    expect(summarizeMonth(merged, '2034-10')).toMatchObject({ expenseCents: 4_800, workOutCents: 2_400 });
  });

  it('does not link independent reclaims of a deleted name and alias through an old work rule', () => {
    const original = fixture();
    const renamed = renameCategory(original, category(original, OLD).id, 'Former shopping alias', new Date('2034-10-01T15:00:00.000Z'));
    let current = deleteCategory(renamed, category(renamed, 'Former shopping alias').id, TARGET, DELETED);
    current = renameCategory(current, category(current, OTHER).id, OLD, REUSED);
    current = renameCategory(current, category(current, 'Another option').id, 'Former shopping alias', REUSED);
    current.work = { label: 'Synthetic employer', expenseCategories: [OLD], updatedAt: EDITED.toISOString() };
    current.transactions.push(transaction('current-work', OLD, { updatedAt: EDITED.toISOString() }), transaction('current-personal', 'Former shopping alias', { updatedAt: EDITED.toISOString() }));
    current.updatedAt = EDITED.toISOString();
    const normalized = normalizeCategoryData(current, false);
    expect(getTransactionScope(normalized, normalized.transactions.find(item => item.id === 'current-work')!)).toBe('work');
    expect(getTransactionScope(normalized, normalized.transactions.find(item => item.id === 'current-personal')!)).toBe('personal');
    const merged = assertConverges(current, original);

    expect(merged.work?.expenseCategories).toEqual([OLD]);
    expect(getTransactionScope(merged, merged.transactions.find(item => item.id === 'current-work')!)).toBe('work');
    expect(getTransactionScope(merged, merged.transactions.find(item => item.id === 'current-personal')!)).toBe('personal');
    expect(getTransactionScope(merged, merged.transactions.find(item => item.id === 'old')!)).toBe('personal');
  });

  it('follows identity-based deletion chains even when an intermediate replacement name is reclaimed', () => {
    const original = fixture();
    const once = deleteCategory(original, category(original, OLD).id, OTHER, DELETED);
    let current = deleteCategory(once, category(once, OTHER).id, TARGET, REUSED);
    current = renameCategory(current, category(current, 'Another option').id, OTHER, EDITED);
    current.transactions.push(transaction('new-purchases', OTHER, { updatedAt: EDITED.toISOString() }));
    const stale = structuredClone(original);
    stale.transactions.push(transaction('old-source', OLD, { updatedAt: EDITED.toISOString() }), transaction('old-target', OTHER, { updatedAt: EDITED.toISOString() }));
    stale.updatedAt = EDITED.toISOString();
    const merged = assertConverges(current, stale);

    for (const id of ['old', 'existing', 'old-source', 'old-target']) expect(merged.transactions.find(item => item.id === id)?.category).toBe(TARGET);
    expect(merged.transactions.find(item => item.id === 'new-purchases')?.category).toBe(OTHER);
    expect(availableCategoryNames(merged)).not.toContain(OLD);
  });

  it('keeps a replacement renamed to the deleted name live when old backups are merged', () => {
    const original = fixture();
    let current = deleteCategory(original, category(original, OLD).id, TARGET, DELETED);
    const replacementId = category(current, TARGET).id;
    current = renameCategory(current, replacementId, OLD, REUSED);
    const stale = structuredClone(original);
    stale.transactions.push(transaction('stale', OLD, { updatedAt: EDITED.toISOString() }));
    stale.updatedAt = EDITED.toISOString();
    const merged = assertConverges(current, stale);

    expect(category(merged, OLD).id).toBe(replacementId);
    expect(merged.transactions.filter(item => item.id !== 'existing').every(item => item.category === OLD)).toBe(true);
    expect(merged.planItems.find(item => item.id === 'plan-0')?.category).toBe(OLD);
  });

  it('keeps separate generations on repeat deletion and reuse through old and intermediate backups', () => {
    const original = fixture();
    let second = deleteCategory(original, category(original, OLD).id, TARGET, DELETED);
    second = addCategory(second, OLD, REUSED);
    second.transactions.push(transaction('second-generation', OLD, { updatedAt: REUSED.toISOString() }));
    const secondBackup = structuredClone(second);
    let current = deleteCategory(second, category(second, OLD).id, OTHER, EDITED);
    current = addCategory(current, OLD, new Date('2034-10-05T12:00:00.000Z'));
    current.transactions.push(transaction('third-generation', OLD, { updatedAt: '2034-10-05T12:00:00.000Z' }));
    const merged = assertConverges(assertConverges(current, secondBackup), original);

    expect(merged.transactions.find(item => item.id === 'old')?.category).toBe(TARGET);
    expect(merged.transactions.find(item => item.id === 'second-generation')?.category).toBe(OTHER);
    expect(merged.transactions.find(item => item.id === 'third-generation')?.category).toBe(OLD);
    expect(merged.categories.filter(item => item.deletedAt)).toHaveLength(2);
    expect(availableCategoryNames(merged).filter(name => name === OLD)).toHaveLength(1);
  });

  it('converges concurrent reclaims without losing financial records or reviving the original category', () => {
    const original = fixture();
    const oldId = category(original, OLD).id;
    const deleted = deleteCategory(original, oldId, TARGET, DELETED);
    const left = renameCategory(deleted, category(deleted, OTHER).id, OLD, REUSED);
    const right = renameCategory(deleted, category(deleted, 'Another option').id, OLD, REUSED);
    left.transactions.push(transaction('left-new', OLD, { updatedAt: REUSED.toISOString() }));
    right.transactions.push(transaction('right-new', OLD, { updatedAt: REUSED.toISOString() }));
    const merged = assertConverges(left, right);

    expect(availableCategoryNames(merged).filter(name => name === OLD)).toHaveLength(1);
    expect(category(merged, OLD).id).not.toBe(oldId);
    expect(merged.categories.find(item => item.id === oldId)?.deletedAt).toBe(DELETED.toISOString());
    expect(merged.transactions.find(item => item.id === 'old')?.category).toBe(TARGET);
    for (const id of ['existing', 'left-new', 'right-new']) expect(merged.transactions.find(item => item.id === id)?.category).toBe(OLD);
    expect(merged.transactions).toHaveLength(original.transactions.length + 2);
    expect(summarizeMonth(merged, '2034-10').expenseCents).toBe(6_000);
  });
});

describe('category name ownership backup validation', () => {
  const mutations: [string, (data: FinanceData) => void][] = [
    ['an unknown previous name owner', data => { category(data, OLD).nameReclaims![0].fromCategoryId = 'missing-category'; }],
    ['a self-referential name claim', data => { const live = category(data, OLD); live.nameReclaims![0].fromCategoryId = live.id; }],
    ['a claim against an active category', data => { category(data, OLD).nameReclaims![0].fromCategoryId = category(data, TARGET).id; }],
    ['a claim for an unowned name', data => { category(data, OLD).nameReclaims![0].name = 'Unrelated name'; }],
    ['duplicate claimed names', data => { const live = category(data, OLD); live.nameReclaims!.push({ ...live.nameReclaims![0], name: OLD.toUpperCase() }); }],
    ['duplicate merged identities', data => { category(data, OLD).mergedIds = [category(data, TARGET).id]; }],
    ['duplicate name generations without an explicit claim', data => { delete category(data, OLD).nameReclaims; }],
    ['an unknown replacement identity', data => { data.categories.find(item => item.deletedAt)!.replacementCategoryId = 'missing-category'; }],
    ['a replacement identity whose label does not match', data => { data.categories.find(item => item.deletedAt)!.replacementCategoryId = category(data, 'Another option').id; }],
    ['a replacement identity on a live category', data => { category(data, OLD).replacementCategoryId = category(data, TARGET).id; }],
  ];

  it.each(mutations)('rejects %s before loading a backup', (_description, mutate) => {
    const data = reclaimed();
    mutate(data);
    expect(() => validateBackup(data)).toThrow('Invalid backup: categories');
  });
});
