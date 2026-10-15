import { describe, expect, it } from 'vitest';
import { addMonths, createEmptyData, getInstallmentSuggestions, mergeFinanceData, planAmountForMonth, projectReserve, sanitizeFinanceData } from '../src/lib/finance';
import { serializeBackup, validateBackup } from '../src/lib/storage';
import type { FinanceData, InstallmentSchedule, PlanItem, Transaction } from '../src/lib/types';

const NOW = '2032-10-10T12:00:00.000Z';
const LATER = '2032-10-11T12:00:00.000Z';
const schedule = (id: string, patch: Partial<InstallmentSchedule> = {}): InstallmentSchedule => ({ id, name: 'Example purchase', amountCents: 4_000, firstMonth: '2032-10', count: 3, ...patch });
const plan = (id: string, patch: Partial<PlanItem> = {}): PlanItem => ({ id, name: 'Example plan', category: '', kind: 'expense', defaultAmountCents: 2_000, amounts: {}, startMonth: '2032-10', updatedAt: NOW, ...patch });
const card = (id: string, patch: Partial<Transaction> = {}): Transaction => ({ id, fingerprint: id, date: '2032-08-15', month: '2032-10', amountCents: -4_000, kind: 'expense', source: 'card', account: 'Example card', originalDescription: 'Example store', description: '', category: '', installment: '3/5', updatedAt: NOW, ...patch });
function fixture(): FinanceData {
  const data = createEmptyData(new Date(NOW));
  data.settings.horizonMonths = 3;
  return data;
}

describe('expense schedules', () => {
  it('keeps older plans fixed by default and monthly plans explicit, including zero overrides', () => {
    const fixed = plan('fixed', { amounts: { '2032-11': 0 } });
    expect(['2032-10', '2032-11', '2032-12'].map(month => planAmountForMonth(fixed, month))).toEqual([2_000, 0, 2_000]);
    const monthly = { ...fixed, behavior: 'monthly' as const, amounts: { '2032-11': 7_000, '2032-12': 0 } };
    expect(['2032-10', '2032-11', '2032-12', '2033-01'].map(month => planAmountForMonth(monthly, month))).toEqual([0, 7_000, 0, 0]);
  });

  it('adds only active installments and stops each schedule after its final payment', () => {
    const item = plan('card-plan', { behavior: 'installments', defaultAmountCents: 99_000, installments: [schedule('first'), schedule('second', { firstMonth: '2032-11', count: 1, amountCents: 1_500 })] });
    expect(['2032-09', '2032-10', '2032-11', '2032-12', '2033-01'].map(month => planAmountForMonth(item, month))).toEqual([0, 4_000, 5_500, 4_000, 0]);
    expect(planAmountForMonth({ ...item, installments: [] }, '2032-10')).toBe(0);
  });

  it('applies plan bounds before overrides and respects explicit installment overrides', () => {
    const item = plan('bounded', { behavior: 'installments', startMonth: '2032-11', endMonth: '2032-12', installments: [schedule('first', { count: 6 })], amounts: { '2032-10': 12_000, '2032-11': 0, '2032-12': 8_000, '2033-01': 12_000 } });
    expect(['2032-10', '2032-11', '2032-12', '2033-01'].map(month => planAmountForMonth(item, month))).toEqual([0, 0, 8_000, 0]);
    expect(planAmountForMonth({ ...item, deletedAt: LATER }, '2032-12')).toBe(0);
  });

  it('does not manufacture actual transactions when projecting fixed and installment expenses', () => {
    const data = fixture();
    data.planItems = [plan('rent', { defaultAmountCents: 10_000 }), plan('card', { behavior: 'installments', installments: [schedule('first')] })];
    data.transactions = [card('actual', { scope: 'work', amountCents: -900_000 })];
    const before = structuredClone(data);
    expect(projectReserve(data).map(row => row.expenseCents)).toEqual([14_000, 14_000, 14_000]);
    expect(data).toEqual(before);
  });

  it('guards installment sums and projection results against unsafe monetary values', () => {
    const item = plan('overflow', { behavior: 'installments', installments: [schedule('first', { amountCents: Number.MAX_SAFE_INTEGER }), schedule('second')] });
    expect(() => planAmountForMonth(item, '2032-10')).toThrow('supported monetary range');
    const data = fixture();
    data.planItems = [plan('large', { defaultAmountCents: Number.MAX_SAFE_INTEGER })];
    expect(() => projectReserve(data)).toThrow('supported monetary range');
    expect(() => planAmountForMonth(item, 'bad-month')).toThrow('Invalid month');
  });
});

describe('Cerbasi planning indicators and reserve allocations', () => {
  it('uses the opening reserve for each target percentage and reports targets independently', () => {
    const data = fixture();
    data.settings = { ...data.settings, initialReserveCents: 120_000, monthlyReturnPercent: 1 };
    data.planning = { age: 30, pmrMonths: 12, annualNetReturnPercent: 6, updatedAt: NOW };
    data.planItems = [plan('income', { kind: 'income', defaultAmountCents: 30_000 }), plan('spending', { defaultAmountCents: 20_000 }), plan('allocation', { kind: 'contribution', defaultAmountCents: 5_000 })];
    const [first, second] = projectReserve(data);
    expect(first).toMatchObject({ openingCents: 120_000, expenseCents: 20_000, incomeCents: 30_000, contributionCents: 5_000, netCents: 10_000, availableCents: 5_000, returnCents: 1_200, closingCents: 131_200 });
    expect(first.indicators).toEqual({
      pms: { targetCents: 120_000, progressPercent: 100 },
      pmr: { targetCents: 240_000, progressPercent: 50 },
      pi: { targetCents: 720_000, progressPercent: 120_000 / 720_000 * 100 },
      pnif: { targetCents: 4_000_000, progressPercent: 3 },
    });
    expect(second.openingCents).toBe(first.closingCents);
    expect(second.indicators.pms.progressPercent).toBe(131_200 / 120_000 * 100);
    expect(first.indicators.pms.progressPercent).not.toBe(first.closingCents / 120_000 * 100);
  });

  it('allows a twenty-month PMR target and advances the first-month age once per plan year', () => {
    const data = fixture();
    data.settings.horizonMonths = 25;
    data.planning = { age: 25, pmrMonths: 20, updatedAt: NOW };
    data.planItems = [plan('spending', { defaultAmountCents: 1_000 })];
    const rows = projectReserve(data);
    expect(rows[0].indicators.pmr.targetCents).toBe(20_000);
    expect(rows[11].indicators.pi.targetCents).toBe(30_000);
    expect(rows[12].indicators.pi.targetCents).toBe(31_200);
    expect(rows[24].indicators.pi.targetCents).toBe(32_400);
  });

  it('uses each month’s spending rather than a fixed first-month target', () => {
    const data = fixture();
    data.planItems = [plan('changing', { behavior: 'monthly', amounts: { '2032-10': 1_000, '2032-11': 2_000 } })];
    expect(projectReserve(data).map(row => row.indicators.pms.targetCents)).toEqual([6_000, 12_000, 0]);
  });

  it('keeps missing inputs and zero-spending percentages undefined and preserves signed deficits', () => {
    const data = fixture();
    data.settings.initialReserveCents = -1_000;
    let [row] = projectReserve(data);
    expect(row.indicators).toEqual({ pms: { targetCents: 0, progressPercent: null }, pmr: { targetCents: 0, progressPercent: null }, pi: { targetCents: null, progressPercent: null }, pnif: { targetCents: null, progressPercent: null } });
    data.planItems = [plan('spending', { defaultAmountCents: 1_000 })];
    data.planning = { pmrMonths: 12, annualNetReturnPercent: 0, updatedAt: NOW };
    [row] = projectReserve(data);
    expect(row.indicators.pms.progressPercent).toBe(-1_000 / 6_000 * 100);
    expect(row.indicators.pi.targetCents).toBeNull();
    expect(row.indicators.pnif.targetCents).toBeNull();
  });

  it('does not cap progress at one hundred percent or deduct reserve contributions twice', () => {
    const data = fixture();
    data.settings.initialReserveCents = 100_000;
    data.planItems = [plan('income', { kind: 'income', defaultAmountCents: 10_000 }), plan('cost', { defaultAmountCents: 1_000 }), plan('target', { kind: 'contribution', defaultAmountCents: 12_000 })];
    const [row] = projectReserve(data);
    expect(row.indicators.pms.progressPercent).toBeGreaterThan(100);
    expect(row.availableCents).toBe(-3_000);
    expect(row.netCents).toBe(9_000);
    expect(row.closingCents).toBe(109_000);
  });

  it('keeps tiny positive return assumptions renderable when the PNIF target is unrepresentable', () => {
    const data = fixture();
    data.planning = { age: 30, pmrMonths: 12, annualNetReturnPercent: Number.MIN_VALUE, updatedAt: NOW };
    data.planItems = [plan('cost', { defaultAmountCents: 1_000 })];
    const saved = validateBackup(data);
    const [row] = projectReserve(saved);
    expect(row.indicators.pnif).toEqual({ targetCents: null, progressPercent: null });
    expect(row.indicators.pms.targetCents).toBe(6_000);
    expect(row.closingCents).toBe(-1_000);
  });

  it('marks unrepresentable targets unavailable while retaining valid financial totals', () => {
    const data = fixture();
    data.settings.horizonMonths = 1;
    data.settings.initialReserveCents = Number.MAX_SAFE_INTEGER;
    data.planning = { age: 30, pmrMonths: 20, annualNetReturnPercent: 0.000001, updatedAt: NOW };
    data.planItems = [plan('large-cost', { defaultAmountCents: Number.MAX_SAFE_INTEGER })];
    const [row] = projectReserve(validateBackup(data));
    expect(row.closingCents).toBe(0);
    expect(row.expenseCents).toBe(Number.MAX_SAFE_INTEGER);
    expect(Object.values(row.indicators)).toEqual(Array.from({ length: 4 }, () => ({ targetCents: null, progressPercent: null })));
  });
});

describe('installment suggestions from actual card statements', () => {
  it('suggests only personal card purchases with valid installment counts, including the selected month', () => {
    const data = fixture();
    data.work = { label: 'Example employer', expenseCategories: ['Business'], updatedAt: NOW };
    data.transactions = [card('eligible'), card('bank', { source: 'bank' }), card('work', { scope: 'work' }), card('work-rule', { category: 'Business' }), card('refund', { amountCents: 4_000 }), card('income', { kind: 'income' }), card('transfer', { kind: 'transfer' }), card('deleted', { deletedAt: LATER }), card('wrong-month', { month: '2032-11' }), card('zero', { installment: '0/5' }), card('reversed', { installment: '6/5' }), card('too-many', { installment: '1/601' }), card('missing', { installment: undefined }), card('unreadable', { installment: 'third of five' })];
    const before = structuredClone(data);
    const suggestions = getInstallmentSuggestions(data, '2032-10');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ name: 'Example store', amountCents: 4_000, firstMonth: '2032-10', count: 3 });
    expect(suggestions[0].sourceKey).toMatch(/^card-installment-[a-f0-9]{16}$/);
    expect(data).toEqual(before);
  });

  it('keeps a source identity across successive bills and existing translated account labels', () => {
    const data = fixture();
    data.transactions = [card('october', { account: 'Itaú card ****1234', description: 'My purchase' }), card('november', { month: '2032-11', installment: '4/5', account: 'Cartão Itaú ****1234', sourceFile: 'renamed-statement.xlsx' })];
    const [october] = getInstallmentSuggestions(data, '2032-10');
    const [november] = getInstallmentSuggestions(data, '2032-11');
    expect(october.sourceKey).toBe(november.sourceKey);
    expect(october.id).toBe(november.id);
    expect(october.name).toBe('My purchase');
    expect(november).toMatchObject({ firstMonth: '2032-11', count: 2 });
    data.planItems = [plan('planned', { behavior: 'installments', installments: [october] })];
    expect(getInstallmentSuggestions(data, '2032-10')).toEqual([]);
    expect(getInstallmentSuggestions(data, '2032-11')).toEqual([]);
    data.planItems[0].deletedAt = LATER;
    expect(getInstallmentSuggestions(data, '2032-11')).toHaveLength(1);
  });

  it('preserves legitimate identical purchases and their later-bill identities', () => {
    const data = fixture();
    data.transactions = [card('oct-a', { sourceRow: 5 }), card('oct-b', { sourceRow: 6 }), card('nov-b', { sourceRow: 20, month: '2032-11', installment: '4/5' }), card('nov-a', { sourceRow: 19, month: '2032-11', installment: '4/5' })];
    const october = getInstallmentSuggestions(data, '2032-10');
    const november = getInstallmentSuggestions(data, '2032-11');
    expect(october).toHaveLength(2);
    expect(new Set(october.map(item => item.sourceKey)).size).toBe(2);
    expect(november.map(item => item.sourceKey)).toEqual(october.map(item => item.sourceKey));
    data.planItems = [plan('one-planned', { behavior: 'installments', installments: [october[0]] })];
    expect(getInstallmentSuggestions(data, '2032-11').map(item => item.sourceKey)).toEqual([november[1].sourceKey]);
  });

  it('does not shift identical-purchase identities when an earlier row is deleted or marked work', () => {
    const data = fixture();
    data.transactions = [card('first', { sourceRow: 5 }), card('second', { sourceRow: 6 })];
    const original = getInstallmentSuggestions(data, '2032-10');
    data.transactions[0].scope = 'work';
    expect(getInstallmentSuggestions(data, '2032-10')[0].sourceKey).toBe(original[1].sourceKey);
    data.transactions[0].scope = 'personal';
    data.transactions[0].deletedAt = LATER;
    expect(getInstallmentSuggestions(data, '2032-10')[0].sourceKey).toBe(original[1].sourceKey);
  });

  it('uses the reporting month boundary and excludes unsupported schedule dates', () => {
    const data = fixture();
    data.reporting = { startMonth: '2032-10', resetId: 'new-start', updatedAt: NOW };
    data.transactions = [card('old', { month: '2032-09' }), card('eligible', { date: '2032-07-15' })];
    expect(getInstallmentSuggestions(data, '2032-09')).toEqual([]);
    expect(getInstallmentSuggestions(data, '2032-10')).toHaveLength(1);
    data.transactions = [card('underflow', { date: '0001-01-01', month: '0001-01', installment: '2/3' }), card('overflow', { date: '9999-12-01', month: '9999-12', installment: '1/2' })];
    data.reporting = undefined;
    expect(getInstallmentSuggestions(data, '0001-01')).toEqual([]);
    expect(getInstallmentSuggestions(data, '9999-12')).toEqual([]);
  });
});

describe('planning backup and cloud compatibility', () => {
  it('round-trips schedules, behavior, planning assumptions and explicit zeros without local credentials', () => {
    const data = fixture();
    data.settings.googleClientId = 'local-only-client';
    data.planning = { age: 35, pmrMonths: 20, annualNetReturnPercent: 4.5, updatedAt: NOW };
    data.planItems = [plan('card-plan', { behavior: 'installments', installments: [schedule('first', { sourceKey: 'example-source' })], amounts: { '2032-11': 0 } }), plan('monthly', { behavior: 'monthly' })];
    const expected = { ...data, settings: { ...data.settings, googleClientId: '' } };
    expect(validateBackup(serializeBackup(data))).toEqual(expected);
    expect(sanitizeFinanceData(data)).toEqual(data);
    const cloned = sanitizeFinanceData(data);
    cloned.planItems[0].installments![0].name = 'Edited';
    cloned.planning!.age = 50;
    expect(data.planItems[0].installments![0].name).toBe('Example purchase');
    expect(data.planning.age).toBe(35);
    expect(validateBackup(fixture())).not.toHaveProperty('planning');
  });

  it('merges planning assumptions independently and never erases them with an older-format backup', () => {
    const local = fixture();
    local.planning = { age: 30, pmrMonths: 12, updatedAt: LATER };
    const remote = fixture();
    remote.planning = { age: 20, pmrMonths: 20, updatedAt: NOW };
    expect(mergeFinanceData(local, remote).planning).toEqual(local.planning);
    expect(mergeFinanceData(remote, local).planning).toEqual(local.planning);
    remote.planning = undefined;
    expect(mergeFinanceData(local, remote).planning).toEqual(local.planning);
    expect(mergeFinanceData(remote, local).planning).toEqual(local.planning);
    remote.planning = { age: 40, pmrMonths: 20, updatedAt: LATER };
    expect(mergeFinanceData(local, remote)).toEqual(mergeFinanceData(remote, local));
  });

  it('keeps only the winning reset epoch’s planning assumptions even when stale assumptions have newer timestamps', () => {
    const current = fixture();
    current.reporting = { startMonth: '2032-10', resetId: 'fresh-start', updatedAt: LATER };
    const stale = fixture();
    stale.planning = { age: 50, pmrMonths: 20, annualNetReturnPercent: 8, updatedAt: '2035-01-01T00:00:00.000Z' };
    for (const merged of [mergeFinanceData(current, stale), mergeFinanceData(stale, current)]) expect(merged).not.toHaveProperty('planning');
    current.planning = { age: 30, pmrMonths: 12, updatedAt: NOW };
    for (const merged of [mergeFinanceData(current, stale), mergeFinanceData(stale, current)]) expect(merged.planning).toEqual(current.planning);
  });

  it('adopts settings belonging to a saved assumptions-only plan in a new browser', () => {
    const current = createEmptyData(new Date('2032-11-01T12:00:00.000Z'));
    const saved = fixture();
    saved.settings.horizonMonths = 24;
    saved.planning = { age: 30, pmrMonths: 12, updatedAt: NOW };
    expect(mergeFinanceData(current, saved).settings.reserveStartMonth).toBe('2032-10');
    expect(mergeFinanceData(current, saved).planning).toEqual(saved.planning);
  });

  it('rejects repeated source identities within one row and across active installment rows', () => {
    const data = fixture();
    data.planItems = [plan('first', { behavior: 'installments', installments: [schedule('a', { sourceKey: 'same-purchase' }), schedule('b', { sourceKey: 'same-purchase' })] })];
    expect(() => validateBackup(data)).toThrow('duplicate source identities');
    data.planItems[0].installments!.pop();
    data.planItems.push(plan('second', { behavior: 'installments', installments: [schedule('other-id', { sourceKey: 'same-purchase' })] }));
    expect(() => validateBackup(data)).toThrow('already planned in another active installment row');
    data.planItems[1].deletedAt = LATER;
    expect(validateBackup(data).planItems).toHaveLength(2);
    delete data.planItems[1].deletedAt;
    data.planItems[1].behavior = 'fixed';
    expect(validateBackup(data).planItems).toHaveLength(2);
  });

  it('reconciles concurrent selections into one newest owning row without losing unrelated schedules', () => {
    const local = fixture();
    local.planItems = [plan('older-row', { behavior: 'installments', installments: [schedule('first', { sourceKey: 'same-purchase' }), schedule('unrelated', { amountCents: 1_000 })] })];
    const remote = fixture();
    remote.planItems = [plan('newer-row', { behavior: 'installments', updatedAt: LATER, installments: [schedule('second', { sourceKey: 'same-purchase' })] })];
    const originalLocal = structuredClone(local);
    const originalRemote = structuredClone(remote);
    const left = validateBackup(mergeFinanceData(local, remote));
    const right = validateBackup(mergeFinanceData(remote, local));
    expect(left).toEqual(right);
    expect(left.planItems.find(item => item.id === 'older-row')?.installments?.map(item => item.id)).toEqual(['unrelated']);
    expect(left.planItems.find(item => item.id === 'newer-row')?.installments?.map(item => item.id)).toEqual(['second']);
    expect(projectReserve(left)[0].expenseCents).toBe(5_000);
    expect(mergeFinanceData(left, originalLocal)).toEqual(left);
    expect(mergeFinanceData(originalRemote, left)).toEqual(left);
    expect(local).toEqual(originalLocal);
    expect(remote).toEqual(originalRemote);
  });

  it('resolves simultaneous selections deterministically in either order and preserves manual schedules', () => {
    const local = fixture();
    const remote = fixture();
    local.planItems = [plan('row-a', { behavior: 'installments', installments: [schedule('first', { sourceKey: 'same-purchase' }), schedule('manual-a')] })];
    remote.planItems = [plan('row-b', { behavior: 'installments', installments: [schedule('second', { sourceKey: 'same-purchase' }), schedule('manual-b')] })];
    const merged = validateBackup(mergeFinanceData(local, remote));
    expect(merged).toEqual(mergeFinanceData(remote, local));
    expect(merged.planItems.flatMap(item => item.installments!).filter(item => item.sourceKey === 'same-purchase')).toHaveLength(1);
    expect(merged.planItems.flatMap(item => item.installments!).filter(item => !item.sourceKey)).toHaveLength(2);
    expect(projectReserve(merged)[0].expenseCents).toBe(12_000);
    expect(mergeFinanceData(merged, local)).toEqual(merged);
    expect(mergeFinanceData(merged, remote)).toEqual(merged);
  });

  it('rejects monetary overflow before accepting a backup or restored state', () => {
    const data = fixture();
    data.settings.initialReserveCents = Number.MAX_SAFE_INTEGER;
    data.planItems = [plan('income', { kind: 'income', defaultAmountCents: 1 })];
    expect(() => validateBackup(data)).toThrow('projection');
    expect(() => serializeBackup(data)).toThrow('supported monetary range');
    data.planItems = [];
    data.settings.monthlyReturnPercent = 100;
    expect(() => validateBackup(data)).toThrow('projection');
  });

  it.each([
    ['unknown behavior', (data: any) => { data.planItems[0].behavior = 'other'; }],
    ['income installments', (data: any) => { data.planItems[0].kind = 'income'; }],
    ['zero installment amount', (data: any) => { data.planItems[0].installments[0].amountCents = 0; }],
    ['fractional installment amount', (data: any) => { data.planItems[0].installments[0].amountCents = 1.5; }],
    ['zero payment count', (data: any) => { data.planItems[0].installments[0].count = 0; }],
    ['fractional payment count', (data: any) => { data.planItems[0].installments[0].count = 2.5; }],
    ['excessive payment count', (data: any) => { data.planItems[0].installments[0].count = 601; }],
    ['bad first month', (data: any) => { data.planItems[0].installments[0].firstMonth = '2032-13'; }],
    ['date overflow', (data: any) => { data.planItems[0].installments[0].firstMonth = '9999-12'; }],
    ['duplicate schedule ID', (data: any) => { data.planItems[0].installments.push({ ...data.planItems[0].installments[0] }); }],
    ['empty source identity', (data: any) => { data.planItems[0].installments[0].sourceKey = ''; }],
    ['fractional age', (data: any) => { data.planning.age = 30.5; }],
    ['zero age', (data: any) => { data.planning.age = 0; }],
    ['excessive age', (data: any) => { data.planning.age = 121; }],
    ['unsupported PMR months', (data: any) => { data.planning.pmrMonths = 18; }],
    ['missing PMR months', (data: any) => { delete data.planning.pmrMonths; }],
    ['negative return', (data: any) => { data.planning.annualNetReturnPercent = -1; }],
    ['excessive return', (data: any) => { data.planning.annualNetReturnPercent = 101; }],
    ['nonfinite return', (data: any) => { data.planning.annualNetReturnPercent = Infinity; }],
    ['invalid planning timestamp', (data: any) => { data.planning.updatedAt = 'yesterday'; }],
  ])('rejects %s before changing saved data', (_label, modify) => {
    const data = fixture();
    data.planItems = [plan('card-plan', { behavior: 'installments', installments: [schedule('first')] })];
    data.planning = { age: 30, pmrMonths: 12, updatedAt: NOW };
    modify(data);
    expect(() => validateBackup(data)).toThrow('Invalid backup');
  });

  it('accepts a single payment at the last supported month and a maximum-length bounded schedule', () => {
    const data = fixture();
    data.planItems = [plan('last', { startMonth: '9999-12', behavior: 'installments', installments: [schedule('last', { firstMonth: '9999-12', count: 1 })] }), plan('long', { behavior: 'installments', installments: [schedule('long', { count: 600 })] })];
    expect(validateBackup(data).planItems[0].installments![0].firstMonth).toBe('9999-12');
    expect(planAmountForMonth(data.planItems[1], addMonths('2032-10', 599))).toBe(4_000);
    expect(planAmountForMonth(data.planItems[1], addMonths('2032-10', 600))).toBe(0);
  });
});
