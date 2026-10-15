import { describe, expect, it } from 'vitest';
import { createEmptyData, isLegacyMonth, legacyIncomeForMonth, mergeFinanceData, projectReserve, resolveMonthMode, summarizeMonth } from '../src/lib/finance';
import { normalizeCategoryData } from '../src/lib/categories';
import { serializeBackup, validateBackup } from '../src/lib/storage';
import type { FinanceData, TrackingConfiguration, Transaction } from '../src/lib/types';

const NOW = new Date('2032-08-15T12:00:00.000Z');
const LATER = '2032-08-16T12:00:00.000Z';
const configuration = (patch: Partial<TrackingConfiguration> = {}): TrackingConfiguration => ({
  startMonth: '2032-08',
  legacyIncomePeriods: [
    { endMonth: '2032-03', incomeCents: 120_000 },
    { startMonth: '2032-04', endMonth: '2032-07', incomeCents: 180_000 },
  ],
  updatedAt: NOW.toISOString(),
  ...patch,
});
function fixture(): FinanceData {
  return { ...createEmptyData(NOW), tracking: configuration() };
}
function transaction(id: string, month: string, amountCents: number, patch: Partial<Transaction> = {}): Transaction {
  return {
    id, fingerprint: `fingerprint-${id}`, date: `${month}-10`, month, amountCents,
    kind: amountCents > 0 ? 'income' : 'expense', source: 'budget', account: 'Example account',
    originalDescription: 'Imported description', description: 'Edited description', category: 'Example category',
    updatedAt: NOW.toISOString(), ...patch,
  };
}
function snapshot(data: FinanceData, month = '2032-07'): void {
  data.snapshots.push({ id: `snapshot-${month}`, month, incomeCents: 90_000, expenseCents: 20_000, categories: { 'Example category': 20_000 }, updatedAt: NOW.toISOString() });
}

describe('legacy tracking boundaries and source selection', () => {
  it('marks every earlier month as legacy and resolves inclusive income periods', () => {
    const data = fixture();
    expect(isLegacyMonth(data, '2032-07')).toBe(true);
    expect(isLegacyMonth(data, '2032-08')).toBe(false);
    expect(isLegacyMonth(data, '2033-01')).toBe(false);
    expect(legacyIncomeForMonth(data, '0001-01')).toBe(120_000);
    expect(legacyIncomeForMonth(data, '2032-03')).toBe(120_000);
    expect(legacyIncomeForMonth(data, '2032-04')).toBe(180_000);
    expect(legacyIncomeForMonth(data, '2032-07')).toBe(180_000);
    expect(legacyIncomeForMonth(data, '2032-08')).toBeUndefined();
  });

  it('automatically selects legacy history and actual tracking independently for each month', () => {
    const data = fixture();
    for (const month of ['2032-07', '2032-08']) data.transactions.push(
      transaction(`${month}-budget`, month, -20_000),
      transaction(`${month}-bank`, month, -30_000, { source: 'bank' }),
      transaction(`${month}-salary`, month, 250_000, { source: 'bank' }),
    );
    expect(['2032-07', '2032-08'].map(month => summarizeMonth(data, month))).toMatchObject([
      { incomeCents: 180_000, expenseCents: 20_000, netCents: 160_000 },
      { incomeCents: 250_000, expenseCents: 30_000, netCents: 220_000 },
    ]);
    expect(resolveMonthMode(data, '2032-07')).toBe('budget');
    expect(resolveMonthMode(data, '2032-08')).toBe('transactions');
    expect(resolveMonthMode(data, '2032-07', 'transactions')).toBe('transactions');
    expect(resolveMonthMode(data, '2032-08', 'budget')).toBe('budget');
    expect(summarizeMonth(data, '2032-08', 'budget').incomeCents).toBe(0);
  });

  it('uses bank or manual records when a legacy month has no workbook history', () => {
    const data = fixture();
    data.transactions = [transaction('manual', '2032-07', -7_500, { source: 'manual' })];
    expect(resolveMonthMode(data, '2032-07')).toBe('transactions');
    expect(summarizeMonth(data, '2032-07')).toMatchObject({ incomeCents: 180_000, expenseCents: 7_500 });
    snapshot(data);
    expect(resolveMonthMode(data, '2032-07')).toBe('budget');
  });

  it('keeps unconfigured backups automatic while preserving explicit source selection', () => {
    const data = createEmptyData(NOW);
    snapshot(data);
    expect(isLegacyMonth(data, '2032-07')).toBe(false);
    expect(legacyIncomeForMonth(data, '2032-07')).toBeUndefined();
    expect(resolveMonthMode(data, '2032-07')).toBe('budget');
    expect(summarizeMonth(data, '2032-07')).toMatchObject({ incomeCents: 90_000, expenseCents: 20_000 });
    data.transactions = [transaction('deleted-bank', '2032-07', -3_000, { source: 'bank', deletedAt: NOW.toISOString() })];
    expect(resolveMonthMode(data, '2032-07')).toBe('transactions');
    expect(summarizeMonth(data, '2032-07').expenseCents).toBe(0);
    expect(summarizeMonth(data, '2032-07', 'budget').expenseCents).toBe(20_000);
    data.transactions = [transaction('budget', '2032-07', -8_000)];
    expect(resolveMonthMode(data, '2032-07')).toBe('budget');
    expect(summarizeMonth(data, '2032-07', 'transactions').expenseCents).toBe(0);
  });

  it('honors historical deletions instead of reviving an older snapshot or bank copy', () => {
    const data = fixture();
    snapshot(data);
    data.transactions = [
      transaction('deleted-budget', '2032-07', -20_000, { deletedAt: NOW.toISOString() }),
      transaction('bank-copy', '2032-07', -20_000, { source: 'bank' }),
    ];
    expect(summarizeMonth(data, '2032-07')).toMatchObject({ incomeCents: 180_000, expenseCents: 0, categories: {}, count: 0 });
  });

  it.each(['2032-00', '2032-13', '0000-01', 'July 2032'])('rejects invalid helper months: %s', month => {
    const data = fixture();
    expect(() => isLegacyMonth(data, month)).toThrow('Invalid month');
    expect(() => resolveMonthMode(data, month, 'budget')).toThrow('Invalid month');
    expect(() => legacyIncomeForMonth(data, month)).toThrow('Invalid month');
  });
});

describe('legacy income assumptions', () => {
  it('replaces snapshot income without changing historical categories or stored records', () => {
    const data = fixture();
    snapshot(data);
    const before = structuredClone(data);
    const summary = summarizeMonth(data, '2032-07');
    expect(summary).toEqual({ month: '2032-07', incomeCents: 180_000, expenseCents: 20_000, netCents: 160_000, categories: { 'Example category': 20_000 }, count: 0, workInCents: 0, workOutCents: 0, workNetCents: 0 });
    expect(summarizeMonth(data, '2032-07')).toEqual(summary);
    expect(data).toEqual(before);
  });

  it('replaces all recorded income rather than adding an artificial salary transaction', () => {
    const data = fixture();
    snapshot(data);
    data.transactions = [
      transaction('income', '2032-07', 90_000),
      transaction('expense', '2032-07', -8_000),
      transaction('refund', '2032-07', 2_000, { kind: 'expense' }),
      transaction('transfer', '2032-07', -30_000, { kind: 'transfer' }),
      transaction('bank-income', '2032-07', 95_000, { source: 'bank' }),
    ];
    expect(summarizeMonth(data, '2032-07')).toMatchObject({ incomeCents: 180_000, expenseCents: 6_000, netCents: 174_000, count: 3 });
    expect(summarizeMonth(data, '2032-07', 'transactions').incomeCents).toBe(180_000);
    expect(data.transactions).toHaveLength(5);
    expect(data.transactions[0].amountCents).toBe(90_000);
  });

  it('allows manual legacy corrections and excludes duplicate bank and card imports', () => {
    const data = fixture();
    data.transactions = [
      transaction('budget-expense', '2032-07', -20_000),
      transaction('manual-correction', '2032-07', -3_000, { source: 'manual' }),
      transaction('manual-income', '2032-07', 15_000, { source: 'manual' }),
      transaction('bank-copy', '2032-07', -20_000, { source: 'bank' }),
      transaction('card-copy', '2032-07', -20_000, { source: 'card' }),
    ];
    expect(summarizeMonth(data, '2032-07')).toMatchObject({ incomeCents: 180_000, expenseCents: 23_000, count: 3 });
    delete data.tracking;
    expect(summarizeMonth(data, '2032-07', 'budget')).toMatchObject({ incomeCents: 0, expenseCents: 20_000, count: 1 });
  });

  it('retains snapshot expenses when adding a manual correction to aggregate-only history', () => {
    const data = fixture();
    snapshot(data);
    data.transactions = [transaction('manual-correction', '2032-07', -3_000, { source: 'manual' })];
    expect(summarizeMonth(data, '2032-07')).toMatchObject({ incomeCents: 180_000, expenseCents: 23_000, categories: { 'Example category': 23_000 }, count: 1 });
  });

  it('preserves snapshot income plus manual corrections in a gap between fixed income periods', () => {
    const data = fixture();
    snapshot(data);
    data.transactions = [
      transaction('budget-expense', '2032-07', -20_000),
      transaction('manual-income', '2032-07', 15_000, { source: 'manual' }),
    ];
    data.tracking!.legacyIncomePeriods = [{ endMonth: '2032-03', incomeCents: 120_000 }];
    expect(summarizeMonth(data, '2032-07')).toMatchObject({ incomeCents: 105_000, expenseCents: 20_000, netCents: 85_000, count: 2 });
    data.tracking = configuration();
    expect(summarizeMonth(data, '2032-07')).toMatchObject({ incomeCents: 180_000, expenseCents: 20_000, netCents: 160_000, count: 2 });
  });

  it('preserves explicit zero, period gaps, and future planning values', () => {
    const data = fixture();
    data.tracking!.legacyIncomePeriods = [{ startMonth: '2032-04', endMonth: '2032-04', incomeCents: 0 }];
    data.transactions = [transaction('zero-income', '2032-04', 80_000), transaction('gap-income', '2032-05', 95_000)];
    data.planItems = [{ id: 'planned-income', kind: 'income', name: 'Example income', category: '', defaultAmountCents: 210_000, amounts: {}, startMonth: '2032-04', updatedAt: NOW.toISOString() }];
    data.settings.reserveStartMonth = '2032-04';
    data.settings.horizonMonths = 1;
    expect(summarizeMonth(data, '2032-04').incomeCents).toBe(0);
    expect(legacyIncomeForMonth(data, '2032-03')).toBeUndefined();
    expect(summarizeMonth(data, '2032-05').incomeCents).toBe(95_000);
    expect(projectReserve(data)[0].incomeCents).toBe(210_000);
  });
});

describe('tracking backup compatibility and validation', () => {
  it('round-trips tracking independently of local OAuth credentials and optional old schema', () => {
    const data = fixture();
    data.settings.googleClientId = 'device-client';
    expect(validateBackup(data)).toEqual(data);
    expect(validateBackup(serializeBackup(data))).toEqual({ ...data, settings: { ...data.settings, googleClientId: '' } });
    expect(data.settings.googleClientId).toBe('device-client');
    const old = createEmptyData(NOW);
    expect(validateBackup(old)).toEqual(old);
    expect(Object.hasOwn(validateBackup(old), 'tracking')).toBe(false);
  });

  it.each([
    ['invalid start month', { startMonth: '2032-13' }],
    ['invalid tracking timestamp', { updatedAt: '2032-02-30T00:00:00.000Z' }],
    ['non-list periods', { legacyIncomePeriods: {} }],
    ['negative income', { legacyIncomePeriods: [{ endMonth: '2032-07', incomeCents: -1 }] }],
    ['fractional income cents', { legacyIncomePeriods: [{ endMonth: '2032-07', incomeCents: 1.5 }] }],
    ['unsafe income cents', { legacyIncomePeriods: [{ endMonth: '2032-07', incomeCents: Number.MAX_SAFE_INTEGER + 1 }] }],
    ['nonfinite income', { legacyIncomePeriods: [{ endMonth: '2032-07', incomeCents: Infinity }] }],
    ['string income', { legacyIncomePeriods: [{ endMonth: '2032-07', incomeCents: '100' }] }],
    ['invalid period start', { legacyIncomePeriods: [{ startMonth: '2032-00', endMonth: '2032-07', incomeCents: 100 }] }],
    ['invalid period end', { legacyIncomePeriods: [{ endMonth: '0000-01', incomeCents: 100 }] }],
    ['reversed period', { legacyIncomePeriods: [{ startMonth: '2032-07', endMonth: '2032-06', incomeCents: 100 }] }],
    ['period after tracking starts', { legacyIncomePeriods: [{ endMonth: '2032-08', incomeCents: 100 }] }],
    ['overlapping periods', { legacyIncomePeriods: [{ endMonth: '2032-04', incomeCents: 100 }, { startMonth: '2032-04', endMonth: '2032-07', incomeCents: 200 }] }],
    ['multiple unbounded periods', { legacyIncomePeriods: [{ endMonth: '2032-03', incomeCents: 100 }, { endMonth: '2032-07', incomeCents: 200 }] }],
    ['too many periods', { legacyIncomePeriods: Array.from({ length: 601 }, () => ({ endMonth: '2032-07', incomeCents: 100 })) }],
  ])('rejects %s', (_description, patch) => {
    const data = fixture();
    const payload = { ...data, tracking: { ...data.tracking, ...patch } };
    expect(() => validateBackup(payload)).toThrow('Invalid backup: tracking');
  });

  it('accepts valid unsorted disjoint periods, empty periods, and maximum safe cents', () => {
    const data = fixture();
    data.tracking!.legacyIncomePeriods.reverse();
    data.tracking!.legacyIncomePeriods[0].incomeCents = Number.MAX_SAFE_INTEGER;
    expect(validateBackup(data).tracking).toEqual(data.tracking);
    data.tracking!.legacyIncomePeriods = [];
    expect(validateBackup(data).tracking!.legacyIncomePeriods).toEqual([]);
  });
});

describe('tracking synchronization', () => {
  it('keeps the configuration when synchronizing an older backup or newer financial settings', () => {
    const local = fixture();
    local.settings.googleClientId = 'local-device';
    const remote = createEmptyData(new Date(LATER));
    remote.settings.reserveGoalCents = 500_000;
    remote.settings.googleClientId = 'remote-device';
    const merged = mergeFinanceData(local, remote);
    expect(merged.tracking).toEqual(local.tracking);
    expect(merged.settings.reserveGoalCents).toBe(500_000);
    expect(merged.settings.googleClientId).toBe('local-device');
    expect(mergeFinanceData(remote, local).tracking).toEqual(local.tracking);
    merged.tracking!.legacyIncomePeriods[0].incomeCents = 1;
    expect(local.tracking!.legacyIncomePeriods[0].incomeCents).toBe(120_000);
  });

  it('merges tracking by its own timestamp even when unrelated data is newer', () => {
    const local = fixture();
    local.updatedAt = LATER;
    local.settings.updatedAt = LATER;
    const remote = fixture();
    remote.tracking = configuration({ startMonth: '2032-09', updatedAt: LATER });
    expect(mergeFinanceData(local, remote).tracking).toEqual(remote.tracking);
    expect(mergeFinanceData(remote, local).tracking).toEqual(remote.tracking);
    expect(local.tracking!.startMonth).toBe('2032-08');
  });

  it('resolves conflicting equal clocks deterministically and idempotently', () => {
    const local = fixture();
    const remote = fixture();
    remote.tracking!.legacyIncomePeriods[1].incomeCents = 190_000;
    const merged = mergeFinanceData(local, remote);
    expect(mergeFinanceData(remote, local)).toEqual(merged);
    expect(mergeFinanceData(merged, merged)).toEqual(merged);
    expect(merged.tracking!.legacyIncomePeriods[1].incomeCents).toBe(190_000);
  });

  it('treats a saved tracking configuration as an intentional local state', () => {
    const local = fixture();
    const remote = createEmptyData(new Date('2032-07-15T12:00:00.000Z'));
    remote.settings.initialReserveCents = 300_000;
    const merged = mergeFinanceData(local, remote);
    expect(merged.settings).toEqual(local.settings);
    expect(merged.tracking).toEqual(local.tracking);
    const empty = createEmptyData(new Date(LATER));
    const restored = mergeFinanceData(empty, local);
    expect(restored.tracking).toEqual(local.tracking);
    expect(restored.settings.reserveStartMonth).toBe(local.settings.reserveStartMonth);
  });

  it('preserves all original financial records while normalizing and merging tracking', () => {
    const local = normalizeCategoryData(fixture());
    local.transactions = [transaction('deleted', '2032-07', -5_000, { category: '', deletedAt: NOW.toISOString() })];
    const remote = createEmptyData(new Date(LATER));
    const before = structuredClone(local);
    const merged = mergeFinanceData(local, remote);
    expect(merged.transactions).toEqual(before.transactions);
    expect(local).toEqual(before);
    expect(validateBackup(serializeBackup(merged)).tracking).toEqual(local.tracking);
  });
});
