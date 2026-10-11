import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyData } from '../src/lib/finance';
import { DATABASE_NAME, LEGACY_DATABASE_NAME } from '../src/lib/identity';
import { loadData, saveData, serializeBackup, validateBackup } from '../src/lib/storage';
import type { FinanceData } from '../src/lib/types';
import { addCategory } from '../src/lib/categories';

const memory = vi.hoisted(() => new Map<string, unknown>());
vi.mock('idb-keyval', () => ({
  createStore: vi.fn((databaseName: string) => ({ databaseName })),
  get: vi.fn(async (key: string, store: { databaseName: string }) => memory.get(`${store.databaseName}/${key}`)),
  set: vi.fn(async (key: string, value: unknown, store: { databaseName: string }) => { memory.set(`${store.databaseName}/${key}`, structuredClone(value)); }),
}));

const NOW = new Date('2026-10-11T15:00:00.000Z');
function fixture(): FinanceData {
  const data = addCategory(createEmptyData(NOW), 'Housing', NOW);
  data.transactions = [{ id: 'purchase', fingerprint: 'purchase-occurrence-1', date: '2026-10-10', month: '2026-10', amountCents: -12_345, kind: 'expense', source: 'card', account: 'Card', originalDescription: 'Store', description: 'Purchase', category: '', sourceRow: 1, updatedAt: NOW.toISOString() }];
  data.planItems = [{ id: 'plan', name: 'Rent', category: 'Housing', kind: 'expense', defaultAmountCents: 200_000, amounts: { '2026-12': 0 }, startMonth: '2026-10', updatedAt: NOW.toISOString() }];
  return data;
}

beforeEach(() => { memory.clear(); vi.stubGlobal('indexedDB', {}); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('backup validation', () => {
  it('accepts valid JSON with refunds and preserves cents and explicit zero', () => {
    const data = fixture();
    data.transactions[0].amountCents = 345;
    expect(validateBackup(JSON.stringify(data))).toEqual(data);
  });

  it('exports financial data only and keeps the original local configuration', () => {
    const data = fixture();
    data.settings.googleClientId = 'local-client-id';
    const withExtra = data as FinanceData & { token: string };
    withExtra.token = 'never-export-this';
    const backup = serializeBackup(withExtra);
    expect(backup).not.toContain('never-export-this');
    expect(backup).not.toContain('local-client-id');
    expect(validateBackup(backup).settings.googleClientId).toBe('');
    expect(data.settings.googleClientId).toBe('local-client-id');
  });

  it.each([
    ['unknown version', (data: any) => { data.version = 2; }],
    ['fractional cents', (data: any) => { data.transactions[0].amountCents = 1.5; }],
    ['NaN cents', (data: any) => { data.transactions[0].amountCents = NaN; }],
    ['unsafe cents', (data: any) => { data.transactions[0].amountCents = Number.MAX_SAFE_INTEGER + 1; }],
    ['invalid day', (data: any) => { data.transactions[0].date = '2026-02-30'; }],
    ['invalid month', (data: any) => { data.transactions[0].month = '2026-13'; }],
    ['invalid timestamp', (data: any) => { data.transactions[0].updatedAt = '2026-02-30T00:00:00.000Z'; }],
    ['infinite rate', (data: any) => { data.settings.monthlyReturnPercent = Infinity; }],
    ['fractional horizon', (data: any) => { data.settings.horizonMonths = 1.5; }],
    ['empty horizon', (data: any) => { data.settings.horizonMonths = 0; }],
    ['invalid recurrence month', (data: any) => { data.planItems[0].amounts = { '2026-99': 100 }; }],
    ['negative plan amount', (data: any) => { data.planItems[0].defaultAmountCents = -1; }],
    ['reversed range', (data: any) => { data.planItems[0].endMonth = '2026-09'; }],
    ['duplicate ID', (data: any) => { data.transactions.push({ ...data.transactions[0] }); }],
    ['object instead of array', (data: any) => { data.transactions = {}; }],
    ['missing description', (data: any) => { delete data.transactions[0].description; }],
    ['invalid source', (data: any) => { data.transactions[0].source = 'other'; }],
    ['invalid row', (data: any) => { data.transactions[0].sourceRow = -1; }],
    ['invalid deletion timestamp', (data: any) => { data.transactions[0].deletedAt = 'yesterday'; }],
  ])('rejects %s before restoring', (_name, modify) => {
    const data = fixture();
    modify(data);
    expect(() => validateBackup(data)).toThrow();
  });

  it.each(['{', 'null', '[]', '"text"'])('rejects structurally invalid JSON: %s', payload => {
    expect(() => validateBackup(payload)).toThrow();
  });

  it('accepts valid leap days and informational contributions', () => {
    const data = fixture();
    data.transactions[0].date = '2024-02-29';
    data.planItems[0].kind = 'contribution';
    expect(validateBackup(data).planItems[0].kind).toBe('contribution');
    data.transactions[0].date = '2025-02-29';
    expect(() => validateBackup(data)).toThrow();
  });
});

describe('local persistence', () => {
  it('migrates the full legacy state without removing the original copy', async () => {
    const data = fixture();
    data.transactions[0].deletedAt = NOW.toISOString();
    data.settings.googleClientId = 'existing-client-id';
    memory.set(`${LEGACY_DATABASE_NAME}/finance-data-v1`, structuredClone(data));
    expect(await loadData()).toEqual(data);
    expect(memory.get(`${DATABASE_NAME}/finance-data-v1`)).toEqual(data);
    expect(memory.get(`${LEGACY_DATABASE_NAME}/finance-data-v1`)).toEqual(data);
  });

  it('prioritizes current data without repeating migration', async () => {
    memory.set(`${LEGACY_DATABASE_NAME}/finance-data-v1`, fixture());
    const current = addCategory(fixture(), 'Updated category', NOW);
    current.transactions[0].category = 'Updated category';
    await saveData(current);
    expect(await loadData()).toEqual(current);
    expect(memory.get(`${DATABASE_NAME}/finance-data-v1`)).toEqual(current);
  });

  it('rejects invalid legacy data before writing to the new database', async () => {
    const invalid = fixture();
    invalid.transactions[0].amountCents = Infinity;
    memory.set(`${LEGACY_DATABASE_NAME}/finance-data-v1`, invalid);
    await expect(loadData()).rejects.toThrow();
    expect(memory.has(`${DATABASE_NAME}/finance-data-v1`)).toBe(false);
    expect(memory.get(`${LEGACY_DATABASE_NAME}/finance-data-v1`)).toEqual(invalid);
  });

  it('loads an empty installation and round-trips the full state including tombstones', async () => {
    expect(await loadData()).toBeNull();
    const data = fixture();
    data.transactions[0].deletedAt = NOW.toISOString();
    await saveData(data);
    expect(await loadData()).toEqual(data);
  });

  it('does not replace valid data when an invalid save fails', async () => {
    const data = fixture();
    await saveData(data);
    const invalid = structuredClone(data);
    invalid.transactions[0].amountCents = Infinity;
    await expect(saveData(invalid)).rejects.toThrow();
    expect(await loadData()).toEqual(data);
  });

  it('explains when the browser does not provide IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(loadData()).rejects.toThrow('Local storage');
  });
});
