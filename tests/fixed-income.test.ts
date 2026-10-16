import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyData, mergeFinanceData, projectReserve, summarizeMonth } from '../src/lib/finance';
import { getBudgetComparison } from '../src/lib/insights';
import { loadData, saveData, serializeBackup, validateBackup } from '../src/lib/storage';
import type { FinanceData, PlanItem, Transaction } from '../src/lib/types';

const memory = vi.hoisted(() => new Map<string, unknown>());
vi.mock('idb-keyval', () => ({
  createStore: vi.fn((databaseName: string) => ({ databaseName })),
  get: vi.fn(async (key: string, store: { databaseName: string }) => memory.get(`${store.databaseName}/${key}`)),
  set: vi.fn(async (key: string, value: unknown, store: { databaseName: string }) => { memory.set(`${store.databaseName}/${key}`, structuredClone(value)); }),
}));

const NOW = '2032-10-10T12:00:00.000Z';
const LATER = '2032-10-15T12:00:00.000Z';
const MONTH = '2032-10';
function transaction(id: string, amountCents: number, patch: Partial<Transaction> = {}): Transaction {
  return {
    id, fingerprint: id, date: `${MONTH}-05`, month: MONTH, amountCents,
    kind: amountCents < 0 ? 'expense' : 'income', source: 'bank', account: 'Example account',
    originalDescription: id, description: '', category: '', updatedAt: NOW, ...patch,
  };
}
function plan(id: string, patch: Partial<PlanItem> = {}): PlanItem {
  return { id, name: id, category: '', kind: 'expense', defaultAmountCents: 10_000, amounts: {}, startMonth: MONTH, updatedAt: NOW, ...patch };
}
function fixture(): FinanceData {
  const data = createEmptyData(new Date(NOW));
  data.reporting = { startMonth: MONTH, resetId: 'example-start', updatedAt: NOW };
  data.settings.horizonMonths = 3;
  return data;
}

beforeEach(() => { memory.clear(); vi.stubGlobal('indexedDB', {}); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('fixed monthly income in reports', () => {
  it('replaces personal receipts without double counting salary, interest, or an income reversal', () => {
    const data = fixture();
    data.settings.monthlyIncomeCents = 250_000;
    data.transactions = [
      transaction('salary', 250_000), transaction('interest', 250),
      transaction('income-reversal', -1_000, { kind: 'income' }),
      transaction('purchase', -15_000, { category: 'Food' }),
      transaction('card-refund', 5_000, { kind: 'expense', source: 'card', month: '2032-11', category: 'Food' }),
      transaction('reimbursement', 7_000, { scope: 'work' }),
      transaction('work-purchase', -9_000, { scope: 'work' }),
      transaction('account-movement', 50_000, { kind: 'transfer' }),
      transaction('deleted', -8_000, { deletedAt: NOW }),
    ];
    const before = structuredClone(data);
    expect(summarizeMonth(data, MONTH)).toEqual({
      month: MONTH, incomeCents: 250_000, expenseCents: 10_000, netCents: 240_000,
      categories: { Food: 10_000 }, count: 5, workInCents: 7_000, workOutCents: 9_000, workNetCents: -2_000,
    });
    expect(data).toEqual(before);
  });

  it('uses configured income with no receipts and never creates transaction records', () => {
    const data = fixture();
    data.settings.monthlyIncomeCents = 250_000;
    expect(summarizeMonth(data, MONTH)).toMatchObject({ incomeCents: 250_000, netCents: 250_000, count: 0 });
    expect(data.transactions).toEqual([]);
  });

  it('keeps explicit zero distinct from unset income and respects the reporting start', () => {
    const data = fixture();
    data.transactions = [transaction('receipt', 25_000)];
    expect(Object.hasOwn(data.settings, 'monthlyIncomeCents')).toBe(false);
    expect(summarizeMonth(data, MONTH).incomeCents).toBe(25_000);
    data.settings.monthlyIncomeCents = 0;
    expect(summarizeMonth(data, MONTH)).toMatchObject({ incomeCents: 0, count: 1 });
    data.settings.monthlyIncomeCents = 250_000;
    expect(summarizeMonth(data, '2032-09')).toMatchObject({ incomeCents: 0, netCents: 0, count: 0 });
    expect(summarizeMonth(data, '2032-11').incomeCents).toBe(250_000);
  });

  it('uses the configured income in budget comparison while retaining receipt evidence flags', () => {
    const data = fixture();
    data.settings.monthlyIncomeCents = 250_000;
    data.planItems = [plan('expenses')];
    data.transactions = [transaction('purchase', -4_000), transaction('work-receipt', 6_000, { scope: 'work' })];
    expect(getBudgetComparison(data, MONTH)).toMatchObject({
      recordedIncomeCents: 250_000, recordedExpenseCents: 4_000, remainingCents: 6_000,
      transactionCount: 1, hasRecordedIncome: false, hasRecordedExpenses: true,
    });
    data.transactions.push(transaction('receipt', 250));
    expect(getBudgetComparison(data, MONTH)).toMatchObject({ recordedIncomeCents: 250_000, transactionCount: 2, hasRecordedIncome: true });
  });
});

describe('fixed monthly income in projections', () => {
  it('takes precedence over existing plan income and overrides without changing saved rows', () => {
    const data = fixture();
    data.settings.monthlyIncomeCents = 250_000;
    data.settings.initialReserveCents = 50_000;
    data.planItems = [
      plan('old-salary', { kind: 'income', defaultAmountCents: 100_000, amounts: { '2032-11': 500_000 } }),
      plan('extra-income', { kind: 'income', behavior: 'monthly', amounts: { '2032-12': 40_000 } }),
      plan('expenses'),
      plan('reserve-allocation', { kind: 'contribution', defaultAmountCents: 5_000 }),
    ];
    const before = structuredClone(data);
    expect(projectReserve(data).map(row => ({ incomeCents: row.incomeCents, netCents: row.netCents, availableCents: row.availableCents, closingCents: row.closingCents }))).toEqual([
      { incomeCents: 250_000, netCents: 240_000, availableCents: 235_000, closingCents: 290_000 },
      { incomeCents: 250_000, netCents: 240_000, availableCents: 235_000, closingCents: 530_000 },
      { incomeCents: 250_000, netCents: 240_000, availableCents: 235_000, closingCents: 770_000 },
    ]);
    expect(getBudgetComparison(data, MONTH)?.plannedIncomeCents).toBe(250_000);
    expect(data).toEqual(before);
  });

  it('preserves old plan income while unset and supports an explicitly zero fixed income', () => {
    const data = fixture();
    data.planItems = [plan('old-income', { kind: 'income', defaultAmountCents: 100_000, amounts: { '2032-11': 150_000 } }), plan('expenses')];
    expect(projectReserve(data).map(row => row.incomeCents)).toEqual([100_000, 150_000, 100_000]);
    data.settings.monthlyIncomeCents = 0;
    expect(projectReserve(data).map(row => ({ income: row.incomeCents, closing: row.closingCents }))).toEqual([
      { income: 0, closing: -10_000 }, { income: 0, closing: -20_000 }, { income: 0, closing: -30_000 },
    ]);
  });
});

describe('fixed income persistence and synchronization', () => {
  it.each([undefined, 0, 250_000])('round-trips %s through local storage and backups without manufacturing an unset value', async monthlyIncomeCents => {
    const data = fixture();
    if (monthlyIncomeCents !== undefined) data.settings.monthlyIncomeCents = monthlyIncomeCents;
    await saveData(data);
    const loaded = (await loadData())!;
    const restored = validateBackup(serializeBackup(loaded));
    expect(loaded).toEqual(data);
    expect(restored).toEqual(data);
    expect(Object.hasOwn(restored.settings, 'monthlyIncomeCents')).toBe(monthlyIncomeCents !== undefined);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '250000'])('rejects invalid configured income %s before saving or restoring', async value => {
    const data = fixture();
    await saveData(data);
    const invalid = structuredClone(data);
    Object.assign(invalid.settings, { monthlyIncomeCents: value });
    expect(() => validateBackup(invalid)).toThrow('settings.monthlyIncomeCents');
    await expect(saveData(invalid)).rejects.toThrow('settings.monthlyIncomeCents');
    expect(await loadData()).toEqual(data);
  });

  it.each([0, 250_000])('adopts settings-only cloud income %s from a newer empty browser', monthlyIncomeCents => {
    const remote = createEmptyData(new Date(NOW));
    remote.settings.monthlyIncomeCents = monthlyIncomeCents;
    const local = createEmptyData(new Date(LATER));
    local.settings.googleClientId = 'this-device-client';
    expect(mergeFinanceData(local, remote).settings).toEqual({ ...remote.settings, googleClientId: 'this-device-client' });
  });

  it('uses settings edit timestamps, preserves zero, and converges across sync order', () => {
    const local = fixture();
    const remote = structuredClone(local);
    local.settings.monthlyIncomeCents = 250_000;
    remote.settings = { ...remote.settings, monthlyIncomeCents: 0, updatedAt: LATER };
    const merged = mergeFinanceData(local, remote);
    expect(merged.settings.monthlyIncomeCents).toBe(0);
    expect(mergeFinanceData(remote, local)).toEqual(merged);
    expect(mergeFinanceData(merged, local)).toEqual(merged);
  });

  it('does not let fixed income from an older reporting epoch return after a reset', () => {
    const old = fixture();
    old.settings = { ...old.settings, monthlyIncomeCents: 250_000, updatedAt: '2035-01-01T12:00:00.000Z' };
    const current = createEmptyData(new Date(LATER));
    current.reporting = { startMonth: MONTH, resetId: 'new-start', updatedAt: LATER };
    for (const merged of [mergeFinanceData(current, old), mergeFinanceData(old, current)]) {
      expect(Object.hasOwn(merged.settings, 'monthlyIncomeCents')).toBe(false);
      expect(summarizeMonth(merged, MONTH).incomeCents).toBe(0);
    }
  });
});
