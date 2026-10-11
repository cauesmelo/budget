import { describe, expect, it } from 'vitest';
import { addCategory, archiveCategory, availableCategoryNames, renameCategory } from '../src/lib/categories';
import { applyImport, applyInitialImport, createEmptyData, INITIAL_IMPORT_ID, mergeFinanceData, planAmountForMonth } from '../src/lib/finance';
import { serializeBackup, validateBackup } from '../src/lib/storage';
import type { ImportResult, Settings, Transaction } from '../src/lib/types';

const NOW = new Date('2026-10-11T15:00:00.000Z');
const LATER = new Date('2026-10-12T15:00:00.000Z');
const AFTER = new Date('2026-10-13T15:00:00.000Z');
const transaction = (id: string, patch: Partial<Transaction> = {}): Transaction => ({
  id, fingerprint: `fingerprint-${id}`, date: '2026-10-05', month: '2026-10',
  amountCents: -1_000, kind: 'expense', source: 'budget', account: 'Budget history',
  originalDescription: 'Example purchase', description: 'Legacy description', category: 'Groceries',
  sourceRow: 7, updatedAt: NOW.toISOString(), ...patch,
});
function legacy(): ImportResult {
  return {
    source: 'budget',
    transactions: [transaction('purchase'), transaction('other', { sourceRow: 8, originalDescription: 'Another example purchase' })],
    planItems: [{ id: 'plan', name: 'Planned expenses', category: 'Groceries', kind: 'expense', defaultAmountCents: 900, amounts: { '2026-10': 500, '2026-11': 0, '2026-12': 900 }, startMonth: '2026-10', endMonth: '2026-12', updatedAt: NOW.toISOString() }],
    snapshots: [{ id: 'snapshot-2026-10', month: '2026-10', incomeCents: 0, expenseCents: 2_000, categories: { Groceries: 2_000 }, updatedAt: NOW.toISOString() }],
    suggestedSettings: { initialReserveCents: 50_000, reserveStartMonth: '2026-10', horizonMonths: 3, googleClientId: 'ignored-client', updatedAt: '2000-01-01T00:00:00.000Z' },
    warnings: [],
  };
}

describe('one-time legacy Budget import', () => {
  it('loads history, plans, and default settings with a persistent receipt', () => {
    const data = createEmptyData(NOW);
    data.settings.googleClientId = 'local-client';
    const result = legacy();
    const original = structuredClone(result);
    const next = applyInitialImport(data, result, 'budget.xlsx', LATER);
    expect(next.imports).toEqual([{ id: INITIAL_IMPORT_ID, filename: 'budget.xlsx', source: 'budget', count: 4, importedAt: LATER.toISOString(), updatedAt: LATER.toISOString() }]);
    expect(next.transactions.every(item => item.importId === INITIAL_IMPORT_ID)).toBe(true);
    expect(next.settings).toMatchObject({ initialReserveCents: 50_000, horizonMonths: 3, googleClientId: 'local-client', updatedAt: LATER.toISOString() });
    expect(next.categories.map(category => category.name)).toEqual(['Groceries']);
    expect(next.planItems[0].amounts['2026-11']).toBe(0);
    expect(planAmountForMonth(next.planItems[0], '2026-11')).toBe(0);
    expect(planAmountForMonth(next.planItems[0], '2027-01')).toBe(0);
    expect(data.transactions).toEqual([]);
    expect(data.settings.initialReserveCents).toBe(0);
    expect(result).toEqual(original);
    expect(validateBackup(next)).toEqual(next);
  });

  it('rejects other sources before changing state', () => {
    const data = createEmptyData(NOW);
    expect(() => applyInitialImport(data, { ...legacy(), source: 'bank' }, 'statement.xls', NOW)).toThrow('legacy Budget');
    expect(data.imports).toEqual([]);
    expect(data.transactions).toEqual([]);
  });

  it.each<{ patch: Partial<Settings> }>([
    { patch: { initialReserveCents: 75_000 } },
    { patch: { reserveGoalCents: 90_000 } },
    { patch: { monthlyReturnPercent: 0.25 } },
    { patch: { horizonMonths: 18 } },
    { patch: { reserveStartMonth: '2026-09' } },
  ])('preserves adjusted financial settings: $patch', ({ patch }) => {
    const data = createEmptyData(NOW);
    data.settings = { ...data.settings, ...patch, googleClientId: 'local-client' };
    const next = applyInitialImport(data, legacy(), 'budget.xlsx', LATER);
    expect(next.settings).toEqual(data.settings);
    expect(next.planItems).toHaveLength(1);
  });

  it.each(['plan', 'snapshot'] as const)('preserves default financial settings when a %s already exists', existing => {
    const data = createEmptyData(NOW);
    const result = legacy();
    if (existing === 'plan') data.planItems = [{ ...result.planItems[0], category: '', deletedAt: LATER.toISOString() }];
    else data.snapshots = [{ ...result.snapshots[0], categories: {} }];
    const next = applyInitialImport(data, result, 'budget.xlsx', AFTER);
    expect(next.settings).toEqual(data.settings);
    expect(next.transactions).toHaveLength(2);
  });

  it('preserves edits, deletions, and previous categories even with a fingerprint under another ID', () => {
    const incoming = legacy();
    const data = addCategory(createEmptyData(NOW), 'My category', NOW);
    const edited = transaction('edited-id', { fingerprint: incoming.transactions[0].fingerprint, category: 'My category', description: 'My edit', updatedAt: LATER.toISOString() });
    const deleted = { ...incoming.transactions[1], category: '', deletedAt: LATER.toISOString(), updatedAt: LATER.toISOString() };
    const plan = { ...incoming.planItems[0], name: 'Edited plan', category: '', amounts: { '2026-11': 0 }, deletedAt: LATER.toISOString(), updatedAt: LATER.toISOString() };
    const snapshot = { ...incoming.snapshots[0], expenseCents: 0, categories: {}, updatedAt: LATER.toISOString() };
    data.transactions = [edited, deleted];
    data.planItems = [plan];
    data.snapshots = [snapshot];
    const next = applyInitialImport(data, incoming, 'budget.xlsx', AFTER);
    expect(next.transactions).toEqual([edited, deleted]);
    expect(next.planItems).toEqual([plan]);
    expect(next.snapshots).toEqual([snapshot]);
    expect(next.settings).toEqual(data.settings);
    expect(next.imports[0].count).toBe(0);
    expect(next.categories.map(category => category.name)).toEqual(['My category']);
  });

  it('uses current category names without restoring archived options', () => {
    let data = addCategory(createEmptyData(NOW), 'Groceries', NOW);
    const categoryId = data.categories[0].id;
    data = renameCategory(data, categoryId, 'Supermarket', LATER);
    data = archiveCategory(data, categoryId, AFTER);
    data = addCategory(data, 'Unused category', AFTER);
    const next = applyInitialImport(data, legacy(), 'budget.xlsx', AFTER);
    expect(next.transactions.every(item => item.category === 'Supermarket')).toBe(true);
    expect(next.planItems[0].category).toBe('Supermarket');
    expect(next.snapshots[0].categories).toEqual({ Supermarket: 2_000 });
    expect(next.categories.find(category => category.id === categoryId)).toEqual(data.categories.find(category => category.id === categoryId));
    expect(availableCategoryNames(next)).toEqual(['Unused category']);
  });

  it('does not repeat the initial import after deleting or removing records', () => {
    const first = applyInitialImport(createEmptyData(NOW), legacy(), 'budget.xlsx', NOW);
    first.transactions[0].description = 'Later edit';
    first.transactions[1].deletedAt = LATER.toISOString();
    const original = structuredClone(first);
    expect(applyInitialImport(first, legacy(), 'another-copy.xlsx', AFTER)).toBe(first);
    expect(first).toEqual(original);
    first.transactions = [];
    first.planItems = [];
    first.snapshots = [];
    expect(applyInitialImport(first, legacy(), 'budget.xlsx', AFTER)).toBe(first);
    expect(first.transactions).toEqual([]);
    expect(first.imports).toHaveLength(1);
  });

  it('includes the receipt in backups and syncs to prevent reseeding another browser', () => {
    const first = applyInitialImport(createEmptyData(NOW), legacy(), 'budget.xlsx', NOW);
    first.transactions[0].deletedAt = LATER.toISOString();
    first.transactions[0].updatedAt = LATER.toISOString();
    const restored = validateBackup(serializeBackup(first));
    expect(restored.imports[0].id).toBe(INITIAL_IMPORT_ID);
    const newBrowser = createEmptyData(AFTER);
    newBrowser.settings.googleClientId = 'other-local-client';
    const merged = mergeFinanceData(newBrowser, restored);
    expect(merged.transactions.find(item => item.id === 'purchase')?.deletedAt).toBe(LATER.toISOString());
    expect(merged.settings.googleClientId).toBe('other-local-client');
    expect(applyInitialImport(merged, legacy(), 'budget.xlsx', AFTER)).toBe(merged);
    expect(mergeFinanceData(restored, first).imports).toHaveLength(1);
  });

  it('corrects legacy competence while preserving IDs, edits, and tombstones', () => {
    const existing = transaction('old-id', { date: '2026-09-29', month: '2026-09', category: '', description: 'My description', deletedAt: LATER.toISOString(), updatedAt: LATER.toISOString() });
    const corrected = transaction('correct-id', { date: '2026-09-29', month: '2026-10', fingerprint: existing.fingerprint });
    const data = createEmptyData(NOW);
    data.transactions = [existing];
    const result = { ...legacy(), transactions: [corrected], planItems: [], snapshots: [], suggestedSettings: undefined };
    const next = applyInitialImport(data, result, 'budget.xlsx', AFTER);
    expect(next.transactions).toEqual([{ ...existing, month: '2026-10', updatedAt: AFTER.toISOString() }]);
    expect(next.imports[0].count).toBe(0);
    expect(data.transactions[0]).toEqual(existing);
    const repeated = applyImport(next, result, 'budget.xlsx', AFTER);
    expect(repeated.transactions).toEqual(next.transactions);
    expect(repeated.imports.at(-1)?.count).toBe(0);
  });

  it('does not guess competence when the same row and content appear in two sheets', () => {
    const existing = transaction('old-id', { date: '2026-09-29', month: '2026-09', category: '', description: 'My edit' });
    const first = transaction('first', { date: existing.date, month: '2026-10', fingerprint: existing.fingerprint });
    const second = transaction('second', { date: existing.date, month: '2026-11', fingerprint: 'second-occurrence' });
    const data = createEmptyData(NOW);
    data.transactions = [existing];
    const next = applyInitialImport(data, { ...legacy(), transactions: [first, second], planItems: [], snapshots: [], suggestedSettings: undefined }, 'budget.xlsx', AFTER);
    expect(next.transactions[0]).toEqual(existing);
    expect(next.transactions[1]).toMatchObject({ id: 'second', month: '2026-11', fingerprint: 'second-occurrence' });
    expect(next.transactions).toHaveLength(2);
    expect(next.imports[0].count).toBe(1);
  });

  it('does not repair similar rows with different accounts, amounts, positions, or edited competence', () => {
    const original = transaction('original', { date: '2026-09-29', month: '2026-09', category: '' });
    const rows = [
      { ...original, id: 'account', fingerprint: 'account', account: 'Another example account' },
      { ...original, id: 'amount', fingerprint: 'amount', amountCents: -2_000 },
      { ...original, id: 'row', fingerprint: 'row', sourceRow: 8 },
      { ...original, id: 'edited-month', fingerprint: 'edited-month', month: '2026-08' },
      { ...original, id: 'missing-row', fingerprint: 'missing-row', sourceRow: undefined },
      { ...original, id: 'bank', fingerprint: 'bank', source: 'bank' as const },
    ];
    const data = createEmptyData(NOW);
    data.transactions = rows;
    const corrected = transaction('corrected', { date: original.date, month: '2026-10', fingerprint: 'corrected' });
    const next = applyInitialImport(data, { ...legacy(), transactions: [corrected], planItems: [], snapshots: [], suggestedSettings: undefined }, 'budget.xlsx', AFTER);
    expect(next.transactions.slice(0, rows.length)).toEqual(rows);
    expect(next.transactions).toHaveLength(rows.length + 1);
    expect(next.transactions.at(-1)?.month).toBe('2026-10');
  });
});
