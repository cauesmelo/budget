import { describe, expect, it } from 'vitest';
import { addCategory } from '../src/lib/categories';
import { applyImport, createEmptyData, mergeFinanceData, previewDuplicateCount, sanitizeFinanceData, summarizeMonth } from '../src/lib/finance';
import { serializeBackup, validateBackup } from '../src/lib/storage';
import type { FinanceData, ImportResult, PlanItem, Transaction } from '../src/lib/types';

const CREATED = '2032-10-10T12:00:00.000Z';
const RESET = '2032-10-15T12:00:00.000Z';
const FUTURE = '2035-01-01T12:00:00.000Z';
function transaction(id: string, patch: Partial<Transaction> = {}): Transaction {
  return { id, fingerprint: id, date: '2032-10-10', month: '2032-10', amountCents: -2_000,
    kind: 'expense', source: 'bank', account: 'Example account', originalDescription: id,
    description: id, category: '', updatedAt: CREATED, ...patch };
}
function plan(id: string): PlanItem {
  return { id, name: 'Example plan', category: '', kind: 'expense', defaultAmountCents: 3_000,
    amounts: {}, startMonth: '2032-10', updatedAt: FUTURE };
}
function fresh(resetId = 'example-reset'): FinanceData {
  const data = createEmptyData(new Date(RESET));
  data.reporting = { startMonth: '2032-10', resetId, updatedAt: RESET };
  return data;
}
function stale(): FinanceData {
  const data = createEmptyData(new Date(CREATED));
  data.transactions = [transaction('old-purchase', { updatedAt: FUTURE }), transaction('old-september', { month: '2032-09', date: '2032-09-10' })];
  data.planItems = [plan('old-plan')];
  data.imports = [{ id: 'old-import', source: 'bank', count: 2, filename: 'example-statement.xlsx', importedAt: CREATED, updatedAt: FUTURE }];
  data.settings = { ...data.settings, initialReserveCents: 50_000, reserveGoalCents: 100_000, monthlyReturnPercent: 1, horizonMonths: 12, updatedAt: FUTURE };
  data.updatedAt = FUTURE;
  return data;
}

describe('fresh reporting epochs', () => {
  it('does not let older backups restore transactions, plans, imports or financial settings in either merge order', () => {
    const current = fresh();
    const old = stale();
    for (const merged of [mergeFinanceData(current, old), mergeFinanceData(old, current)]) {
      expect(merged.reporting).toEqual(current.reporting);
      expect(merged.transactions).toEqual([]);
      expect(merged.planItems).toEqual([]);
      expect(merged.imports).toEqual([]);
      expect(merged.settings).toEqual(current.settings);
      expect(mergeFinanceData(merged, old)).toEqual(merged);
      expect(mergeFinanceData(old, merged)).toEqual(merged);
    }
  });

  it('uses reporting configuration timestamps rather than record or root timestamps to select a reset', () => {
    const current = fresh('new-reset');
    current.transactions = [transaction('new-purchase')];
    const old = stale();
    old.reporting = { startMonth: '2032-08', resetId: 'previous-reset', updatedAt: CREATED };
    const merged = mergeFinanceData(current, old);
    expect(merged.transactions).toEqual(current.transactions);
    expect(merged.settings).toEqual(current.settings);
    expect(merged.reporting?.resetId).toBe('new-reset');
  });

  it('converges deterministically for simultaneous resets and preserves later edits within the winning epoch', () => {
    const left = fresh('reset-a');
    const right = fresh('reset-b');
    left.transactions = [transaction('left')];
    right.transactions = [transaction('right')];
    const merged = mergeFinanceData(left, right);
    expect(mergeFinanceData(right, left)).toEqual(merged);
    expect(merged.reporting?.resetId).toBe('reset-b');
    expect(merged.transactions.map(item => item.id)).toEqual(['right']);
    const otherDevice = structuredClone(merged);
    otherDevice.transactions[0] = { ...otherDevice.transactions[0], scope: 'work', deletedAt: FUTURE, updatedAt: FUTURE };
    otherDevice.transactions.push(transaction('new-record'));
    otherDevice.planItems = [plan('new-plan')];
    otherDevice.settings = { ...otherDevice.settings, reserveGoalCents: 20_000, updatedAt: FUTURE };
    const edited = mergeFinanceData(merged, otherDevice);
    expect(edited.transactions.find(item => item.id === 'right')?.deletedAt).toBe(FUTURE);
    expect(edited.transactions.find(item => item.id === 'right')?.scope).toBe('work');
    expect(edited.transactions).toHaveLength(2);
    expect(edited.planItems).toHaveLength(1);
    expect(edited.settings.reserveGoalCents).toBe(20_000);
    expect(mergeFinanceData(edited, left)).toEqual(edited);
  });

  it('adopts the saved reporting epoch on a fresh browser while preserving local OAuth configuration', () => {
    const browser = createEmptyData(new Date(FUTURE));
    browser.settings.googleClientId = 'this-browser-client';
    const cloud = fresh();
    cloud.transactions = [transaction('cloud-purchase')];
    const result = mergeFinanceData(browser, cloud);
    expect(result.reporting).toEqual(cloud.reporting);
    expect(result.transactions).toEqual(cloud.transactions);
    expect(result.settings).toEqual({ ...cloud.settings, googleClientId: 'this-browser-client' });
  });

  it('keeps category and work setup independent of the financial reset and preserves local credentials', () => {
    let current = addCategory(fresh(), 'Groceries', new Date(RESET));
    current.settings.googleClientId = 'local-client';
    const old = addCategory(stale(), 'Travel', new Date(CREATED));
    old.work = { label: 'Example employer', expenseCategories: ['Travel'], updatedAt: CREATED };
    const merged = mergeFinanceData(current, old);
    expect(merged.categories.map(item => item.name).sort()).toEqual(['Groceries', 'Travel']);
    expect(merged.work).toEqual(old.work);
    expect(merged.settings.googleClientId).toBe('local-client');
    expect(merged.transactions).toEqual([]);
  });
});

describe('purchase reporting boundary and retired workbook compatibility', () => {
  it('filters imports before deduplication, counts and category discovery using card purchase dates', () => {
    const data = fresh();
    const incoming: ImportResult = { source: 'card', warnings: [], transactions: [
      transaction('excluded', { source: 'card', month: '2032-09', date: '2032-09-30', category: 'Old category' }),
      transaction('excluded-current-bill', { source: 'card', month: '2032-11', date: '2032-08-20', category: 'Earlier purchase' }),
      transaction('included', { source: 'card', month: '2032-11', date: '2032-10-20', category: 'Shopping' }),
      transaction('income', { amountCents: 5_000, kind: 'income' }),
    ] };
    const imported = applyImport(data, incoming, 'example-card.xlsx', new Date(RESET));
    expect(imported.transactions.map(item => item.id)).toEqual(['included', 'income']);
    expect(imported.imports[0].count).toBe(2);
    expect(imported.categories.map(item => item.name)).toEqual(['Shopping']);
    expect(summarizeMonth(imported, '2032-10')).toMatchObject({ incomeCents: 5_000, expenseCents: 2_000, count: 2 });
    expect(summarizeMonth(imported, '2032-09')).toMatchObject({ incomeCents: 0, expenseCents: 0, count: 0 });
    expect(summarizeMonth(imported, '2032-11')).toMatchObject({ incomeCents: 0, expenseCents: 0, count: 0 });
    expect(previewDuplicateCount(imported, incoming)).toBe(2);
    const onlyOld = { ...incoming, transactions: [incoming.transactions[0]] };
    expect(applyImport(data, onlyOld, 'old-file.xlsx', new Date(RESET))).toEqual(data);
  });

  it('retains saved card identities and edits on restore while hiding pre-start purchases from reports', () => {
    const data = fresh();
    data.transactions = [transaction('old', { month: '2032-09', importId: 'old-import', category: 'Discarded' }),
      transaction('current', { source: 'card', date: '2032-09-10', importId: 'current-import', category: 'Kept', description: 'Saved review', scope: 'work' })];
    data.imports = ['old-import', 'current-import'].map(id => ({ id, source: 'card', count: 1, filename: `${id}.xlsx`, importedAt: CREATED, updatedAt: CREATED }));
    const restored = validateBackup({ ...data, categories: undefined });
    expect(restored.transactions.map(item => item.id)).toEqual(['current']);
    expect(restored.imports.map(item => item.id)).toEqual(['current-import']);
    expect(restored.categories.map(item => item.name)).toEqual(['Kept']);
    expect(restored.transactions[0]).toEqual(data.transactions[1]);
    expect(summarizeMonth(restored, '2032-10')).toMatchObject({ incomeCents: 0, expenseCents: 0, count: 0, workInCents: 0, workOutCents: 0 });
    expect(summarizeMonth(restored, '2032-09')).toMatchObject({ incomeCents: 0, expenseCents: 0, count: 0, workInCents: 0, workOutCents: 0 });
  });

  it('preserves hidden purchase edits and deletion records through backup and same-epoch merges', () => {
    const original = addCategory(fresh(), 'Shopping', new Date(RESET));
    original.transactions = [
      transaction('older-purchase', { source: 'card', month: '2032-11', date: '2032-09-20', description: 'Reviewed before cutoff', category: 'Shopping', scope: 'work' }),
      transaction('removed-purchase', { source: 'card', month: '2032-11', date: '2032-09-21', description: 'Removed before cutoff', deletedAt: RESET, updatedAt: RESET }),
    ];
    const restored = validateBackup(serializeBackup(original));
    const staleDevice = structuredClone(original);
    staleDevice.transactions[1] = { ...staleDevice.transactions[1], updatedAt: CREATED };
    delete staleDevice.transactions[1].deletedAt;
    for (const merged of [mergeFinanceData(restored, staleDevice), mergeFinanceData(staleDevice, restored)]) {
      expect(merged.transactions).toEqual(restored.transactions);
      expect(summarizeMonth(merged, '2032-11')).toMatchObject({ incomeCents: 0, expenseCents: 0, count: 0, workOutCents: 0 });
      const incoming: ImportResult = { source: 'card', warnings: [], transactions: original.transactions.map(item => ({ ...item, description: '', category: '', scope: 'personal' })) };
      expect(applyImport(merged, incoming, 'repeated-statement.xlsx', new Date(FUTURE))).toEqual(merged);
    }
    expect(original.transactions[0].description).toBe('Reviewed before cutoff');
  });

  it('discards retired transactions, imports, snapshots and fixed income without generating categories', () => {
    const payload = { ...createEmptyData(new Date(CREATED)), categories: undefined,
      transactions: [{ ...transaction('retired', { category: 'Discarded history' }), source: 'budget' }, transaction('actual')],
      imports: [{ source: 'budget', id: 'retired-import' }], snapshots: [{ categories: { 'Discarded snapshot': 3_000 }, incomeCents: 99_000 }],
      tracking: { startMonth: '2032-11', legacyIncomePeriods: [{ endMonth: '2032-10', incomeCents: 90_000 }] },
    };
    const restored = validateBackup(payload);
    expect(restored.transactions.map(item => item.id)).toEqual(['actual']);
    expect(restored.imports).toEqual([]);
    expect(restored.categories).toEqual([]);
    expect(restored).not.toHaveProperty('tracking');
    expect(restored).not.toHaveProperty('snapshots');
    expect(summarizeMonth(restored, '2032-10').incomeCents).toBe(0);
    const raw = payload as unknown as FinanceData;
    expect(sanitizeFinanceData(raw)).not.toHaveProperty('tracking');
    expect(sanitizeFinanceData(raw).transactions.map(item => item.id)).toEqual(['actual']);
  });

  it('round-trips the reset marker through backups and removes local credentials', () => {
    const data = fresh();
    data.settings.googleClientId = 'local-client';
    expect(validateBackup(serializeBackup(data))).toEqual({ ...data, settings: { ...data.settings, googleClientId: '' } });
    for (const reporting of [null, {}, { ...data.reporting, startMonth: '2032-99' }, { ...data.reporting, resetId: '' }, { ...data.reporting, updatedAt: 'yesterday' }]) {
      expect(() => validateBackup({ ...data, reporting })).toThrow('reporting');
    }
  });
});
