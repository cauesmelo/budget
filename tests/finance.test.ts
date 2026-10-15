import { describe, expect, it } from 'vitest';
import { addMonths, applyImport, createEmptyData, formatMoney, formatMonth, mergeFinanceData, parseMoneyToCents, planAmountForMonth, previewDuplicateCount, projectReserve, summarizeMonth } from '../src/lib/finance';
import type { FinanceData, ImportResult, PlanItem, Transaction } from '../src/lib/types';

const NOW = new Date('2026-10-11T15:00:00.000Z');
const transaction = (id: string, amountCents: number, patch: Partial<Transaction> = {}): Transaction => ({
  id, fingerprint: `fingerprint-${id}`, date: '2026-10-10', month: '2026-10', amountCents,
  kind: amountCents > 0 ? 'income' : 'expense', source: 'bank', account: 'Account',
  originalDescription: 'Original description', description: 'Description', category: 'Food',
  updatedAt: NOW.toISOString(), ...patch,
});
const planItem = (id: string, kind: PlanItem['kind'], defaultAmountCents: number, patch: Partial<PlanItem> = {}): PlanItem => ({
  id, kind, name: 'Plan', category: '', defaultAmountCents, amounts: {}, startMonth: '2026-10',
  updatedAt: NOW.toISOString(), ...patch,
});
const result = (transactions: Transaction[] = []): ImportResult => ({ source: 'bank', transactions, warnings: [] });

describe('dates and cents', () => {
  it('uses the Sao Paulo month at UTC month boundaries', () => {
    expect(createEmptyData(new Date('2026-10-01T00:10:00.000Z')).settings.reserveStartMonth).toBe('2026-09');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(() => addMonths('2026-13', 1)).toThrow();
    expect(formatMonth('2026-10')).toContain('2026');
    expect(formatMoney(123456)).toContain('1.234,56');
  });

  it.each([0, 1, -1, 123456, -123456, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])('preserves every cent when formatting %s for display and reading it back', cents => {
    expect(parseMoneyToCents(formatMoney(cents))).toBe(cents);
  });

  it.each([
    ['R$ 1.234,56', 123456], ['-1.234,56', -123456], ['(R$ 1.234,56)', -123456],
    ['1.234,56 D', -123456], ['1.234,56 C', 123456], ['1.234,56-', -123456],
    ['BRL 1,234.56', 123456], ['1.234.567', 123456700], ['1,234,567', 123456700],
    ['1.234', 123400], ['1234.567', 123457], ['1234,567', 123457],
    [1.005, 101], [-1.005, -101], ['0,005', 1], ['-0,005', -1],
    ['', 0], [null, 0], ['—', 0], [0, 0],
  ])('converts %s to %i cents', (value, expected) => {
    expect(parseMoneyToCents(value)).toBe(expected);
  });

  it.each(['10/10/2026', 'ten currency units', '12.34.567', '1,23,45', NaN, Infinity, 1e20, {}])('rejects invalid values: %s', value => {
    expect(() => parseMoneyToCents(value)).toThrow();
  });
});

describe('monthly summary', () => {
  it('deducts refunds and excludes transfers, deletions and other months', () => {
    const data = createEmptyData(NOW);
    data.transactions = [
      transaction('salary', 300_000), transaction('purchase', -20_000),
      transaction('refund', 5_000, { kind: 'expense' }),
      transaction('card', -10_000, { source: 'card' }),
      transaction('payment', -10_000, { kind: 'transfer' }),
      transaction('deleted', -30_000, { deletedAt: NOW.toISOString() }),
      transaction('othermonth', -50_000, { month: '2026-09' }),
    ];
    expect(summarizeMonth(data, '2026-10')).toEqual({
      month: '2026-10', incomeCents: 300_000, expenseCents: 25_000, netCents: 275_000,
      categories: { Food: 25_000 }, count: 4, workInCents: 0, workOutCents: 0, workNetCents: 0,
    });
  });

  it('preserves empty categories and names matching object properties', () => {
    const data = createEmptyData(NOW);
    data.transactions = [transaction('blank', -150, { category: '' }), transaction('prototype', -250, { category: '__proto__' })];
    const summary = summarizeMonth(data, '2026-10');
    expect(summary.categories['Uncategorized']).toBe(150);
    expect(summary.categories.__proto__).toBe(250);
    expect(Object.getPrototypeOf(summary.categories)).toBe(Object.prototype);
  });
});

describe('reserve planning', () => {
  it('projects from the reference month using opening-balance interest and integer cents', () => {
    const data = createEmptyData(NOW);
    data.settings = { ...data.settings, initialReserveCents: 100_005, reserveStartMonth: '2026-12', monthlyReturnPercent: 0.5, horizonMonths: 3 };
    data.planItems = [
      planItem('salary', 'income', 10_000),
      planItem('cost', 'expense', 2_000, { amounts: { '2027-01': 0 } }),
      planItem('temporary', 'expense', 1_000, { endMonth: '2026-12' }),
      planItem('contribution', 'contribution', 50_000),
      planItem('deleted', 'expense', 99_000, { deletedAt: NOW.toISOString() }),
    ];
    expect(projectReserve(data).map(({ indicators: _indicators, ...row }) => row)).toEqual([
      { month: '2026-12', openingCents: 100_005, incomeCents: 10_000, expenseCents: 3_000, contributionCents: 50_000, availableCents: -43_000, returnCents: 500, netCents: 7_000, closingCents: 107_505 },
      { month: '2027-01', openingCents: 107_505, incomeCents: 10_000, expenseCents: 0, contributionCents: 50_000, availableCents: -40_000, returnCents: 538, netCents: 10_000, closingCents: 118_043 },
      { month: '2027-02', openingCents: 118_043, incomeCents: 10_000, expenseCents: 2_000, contributionCents: 50_000, availableCents: -42_000, returnCents: 590, netCents: 8_000, closingCents: 126_633 },
    ]);
  });

  it('checks active dates before overrides, including explicit zero within the range', () => {
    const item = planItem('dated', 'expense', 1_000, { startMonth: '2026-11', endMonth: '2027-01', amounts: { '2026-10': 500, '2026-12': 0, '2027-02': 700 } });
    expect(planAmountForMonth(item, '2026-09')).toBe(0);
    expect(planAmountForMonth(item, '2026-10')).toBe(0);
    expect(planAmountForMonth(item, '2026-11')).toBe(1_000);
    expect(planAmountForMonth(item, '2026-12')).toBe(0);
    expect(planAmountForMonth(item, '2027-02')).toBe(0);
  });

  it('preserves reserve shortfalls without applying an investment return to debt or actual transactions', () => {
    const data = createEmptyData(NOW);
    data.settings = { ...data.settings, initialReserveCents: -101, monthlyReturnPercent: 50, horizonMonths: 2 };
    data.transactions = [transaction('large-real-income', 1_000_000)];
    expect(projectReserve(data).map(item => ({ returnCents: item.returnCents, closingCents: item.closingCents }))).toEqual([
      { returnCents: 0, closingCents: -101 }, { returnCents: 0, closingCents: -101 },
    ]);
    data.settings.monthlyReturnPercent = -50;
    expect(projectReserve(data).map(item => item.closingCents)).toEqual([-101, -101]);
  });

  it('resumes investment returns after the planned reserve becomes positive', () => {
    const data = createEmptyData(NOW);
    data.settings = { ...data.settings, initialReserveCents: -100, monthlyReturnPercent: 10, horizonMonths: 3 };
    data.planItems = [planItem('income', 'income', 200)];
    expect(projectReserve(data).map(item => ({ openingCents: item.openingCents, returnCents: item.returnCents, closingCents: item.closingCents }))).toEqual([
      { openingCents: -100, returnCents: 0, closingCents: 100 },
      { openingCents: 100, returnCents: 10, closingCents: 310 },
      { openingCents: 310, returnCents: 31, closingCents: 541 },
    ]);
  });
});

describe('reimporting and synchronization', () => {
  it('reimporting preserves edits and deletions without losing legitimate identical purchases', () => {
    const incoming = result([transaction('purchase-1', -1_000), transaction('purchase-2', -1_000)]);
    let data = applyImport(createEmptyData(NOW), incoming, 'statement.xlsx', NOW);
    data.transactions[0].category = 'Shopping';
    data.transactions[0].description = 'Manual edit';
    data.transactions[1].deletedAt = NOW.toISOString();
    expect(previewDuplicateCount(data, incoming)).toBe(2);
    const next = applyImport(data, incoming, 'another-copy.xlsx', NOW);
    expect(next.transactions).toHaveLength(2);
    expect(next.transactions[0].description).toBe('Manual edit');
    expect(next.transactions[1].deletedAt).toBe(NOW.toISOString());
    expect(next.imports.at(-1)?.count).toBe(0);
    expect(data.imports).toHaveLength(1);
  });

  it('ignores duplicate fingerprints in a file and recognizes the same transaction under another ID', () => {
    const data = createEmptyData(NOW);
    data.transactions = [transaction('existing', -500)];
    const imported = result([transaction('new-id', -500, { fingerprint: 'fingerprint-existing' }), transaction('new', -400), transaction('new-copy', -400, { fingerprint: 'fingerprint-new' })]);
    expect(previewDuplicateCount(data, imported)).toBe(2);
    expect(applyImport(data, imported, 'file.xlsx', NOW).transactions).toHaveLength(2);
  });

  it('merges by ID, preserves the latest deletion, and keeps the local Google client', () => {
    const local = createEmptyData(NOW);
    const remote = createEmptyData(new Date('2026-10-12T15:00:00.000Z'));
    local.transactions = [transaction('common', -1_000), transaction('local-only', -500)];
    remote.transactions = [transaction('common', -1_000, { deletedAt: remote.updatedAt, updatedAt: remote.updatedAt }), transaction('remote-only', -700)];
    local.settings.googleClientId = 'local-client';
    remote.settings = { ...remote.settings, initialReserveCents: 30_000, googleClientId: 'remote-client' };
    const merged = mergeFinanceData(local, remote);
    expect(merged.transactions).toHaveLength(3);
    expect(merged.transactions.find(item => item.id === 'common')?.deletedAt).toBe(remote.updatedAt);
    expect(merged.settings.initialReserveCents).toBe(30_000);
    expect(merged.settings.googleClientId).toBe('local-client');
    expect(summarizeMonth(merged, '2026-10').expenseCents).toBe(1_200);
    expect(local.transactions[0].deletedAt).toBeUndefined();
  });

  it('adopts existing cloud settings on first access from an empty browser', () => {
    const local = createEmptyData(new Date('2026-11-01T15:00:00.000Z'));
    local.settings.googleClientId = 'this-device-client';
    const remote = createEmptyData(NOW);
    remote.settings = { ...remote.settings, initialReserveCents: 150_000, reserveGoalCents: 500_000, monthlyReturnPercent: 0.5, horizonMonths: 36 };
    remote.transactions = [transaction('saved', -1_000)];
    const merged = mergeFinanceData(local, remote);
    expect(merged.settings).toEqual({ ...remote.settings, googleClientId: 'this-device-client' });
    expect(projectReserve(merged)[0].openingCents).toBe(150_000);
    expect(projectReserve(merged)[0].month).toBe('2026-10');
    expect(merged.transactions).toHaveLength(1);
  });

  it('adopts saved settings-only plans while keeping local OAuth settings', () => {
    const local = createEmptyData(new Date('2026-11-01T15:00:00.000Z'));
    local.settings.googleClientId = 'local-client';
    const remote = createEmptyData(NOW);
    remote.settings = { ...remote.settings, initialReserveCents: 250_000, horizonMonths: 12, googleClientId: 'other-client' };
    expect(mergeFinanceData(local, remote).settings).toEqual({ ...remote.settings, googleClientId: 'local-client' });
    remote.settings = { ...remote.settings, initialReserveCents: 0, horizonMonths: 24, googleClientId: '' };
    expect(mergeFinanceData(local, remote).settings.reserveStartMonth).toBe('2026-10');
  });

  it('does not use client IDs to break financial-settings ties between devices', () => {
    const local = createEmptyData(NOW);
    const remote = createEmptyData(NOW);
    local.settings = { ...local.settings, horizonMonths: 12, googleClientId: 'zzzz' };
    remote.settings = { ...remote.settings, horizonMonths: 36, googleClientId: 'aaaa' };
    const left = mergeFinanceData(local, remote).settings;
    const right = mergeFinanceData(remote, local).settings;
    expect(left.horizonMonths).toBe(36);
    expect({ ...left, googleClientId: '' }).toEqual({ ...right, googleClientId: '' });
    expect(left.googleClientId).toBe('zzzz');
    expect(right.googleClientId).toBe('aaaa');
  });

  it('resolves ties deterministically, convergently, and idempotently', () => {
    const local = createEmptyData(NOW);
    const remote = createEmptyData(NOW);
    local.transactions = [transaction('same', -100, { description: 'A' })];
    remote.transactions = [transaction('same', -100, { description: 'B' })];
    const left = mergeFinanceData(local, remote);
    const right = mergeFinanceData(remote, local);
    expect(left).toEqual(right);
    expect(mergeFinanceData(left, left)).toEqual(left);
    remote.transactions[0].deletedAt = NOW.toISOString();
    expect(mergeFinanceData(local, remote).transactions[0].deletedAt).toBe(NOW.toISOString());
  });
});
