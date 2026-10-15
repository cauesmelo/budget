import { describe, expect, it } from 'vitest';
import { addCategory, archiveCategory, normalizeCategoryData, renameCategory } from '../src/lib/categories';
import { applyImport, createEmptyData, getTransactionScope, mergeFinanceData, summarizeMonth } from '../src/lib/finance';
import { serializeBackup, validateBackup } from '../src/lib/storage';
import type { FinanceData, ImportResult, Transaction, WorkConfiguration } from '../src/lib/types';

const NOW = new Date('2032-08-15T12:00:00.000Z');
const LATER = new Date('2032-08-16T12:00:00.000Z');
const MONTH = '2032-08';
function configuration(patch: Partial<WorkConfiguration> = {}): WorkConfiguration {
  return { label: 'Example employer', expenseCategories: ['Business travel'], updatedAt: NOW.toISOString(), ...patch };
}
function fixture(): FinanceData {
  return { ...createEmptyData(NOW), work: configuration() };
}
function transaction(id: string, amountCents: number, patch: Partial<Transaction> = {}): Transaction {
  return {
    id, fingerprint: `fingerprint-${id}`, date: `${MONTH}-10`, month: MONTH, amountCents,
    kind: amountCents > 0 ? 'income' : 'expense', source: 'bank', account: 'Example account',
    originalDescription: 'Example description', description: 'Example transaction', category: 'Personal shopping',
    updatedAt: NOW.toISOString(), ...patch,
  };
}
describe('personal and reimbursable work classification', () => {
  it('defaults to personal without a configured expense category or explicit work scope', () => {
    const data = fixture();
    expect(getTransactionScope(data, transaction('personal', -2_000))).toBe('personal');
    delete data.work;
    expect(getTransactionScope(data, transaction('unconfigured', -2_000, { category: 'Business travel' }))).toBe('personal');
    expect(getTransactionScope(data, transaction('explicit', -2_000, { scope: 'work' }))).toBe('work');
  });

  it('matches normalized category names and keeps explicit personal overrides', () => {
    const data = fixture();
    expect(getTransactionScope(data, transaction('business', -2_000, { category: '  BUSINESS   TRAVEL ' }))).toBe('work');
    expect(getTransactionScope(data, transaction('override', -2_000, { category: 'Business travel', scope: 'personal' }))).toBe('personal');
  });

  it('follows renamed and archived categories in either direction through aliases', () => {
    let data = addCategory(fixture(), 'Business travel', NOW);
    const id = data.categories[0].id;
    data = renameCategory(data, id, 'Client visits', LATER);
    data = archiveCategory(data, id, LATER);
    expect(getTransactionScope(data, transaction('current', -2_000, { category: 'Client visits' }))).toBe('work');
    data.work!.expenseCategories = ['Client visits'];
    expect(getTransactionScope(data, transaction('previous', -2_000, { category: 'BUSINESS TRAVEL' }))).toBe('work');
  });

  it('never treats employer salary or income category text as a reimbursement', () => {
    const data = fixture();
    const salary = transaction('salary', 200_000, {
      category: 'Business travel', originalDescription: 'Example employer payroll', description: 'Example employer salary',
    });
    expect(getTransactionScope(data, salary)).toBe('personal');
    expect(getTransactionScope(data, { ...salary, scope: 'work' })).toBe('work');
    expect(getTransactionScope(data, { ...salary, kind: 'transfer' })).toBe('personal');
  });
});

describe('personal monthly totals and separate work cash flow', () => {
  it('excludes work expenses and reimbursements while preserving salary and personal refunds', () => {
    const data = fixture();
    data.transactions = [
      transaction('salary', 200_000, { category: 'Business travel', originalDescription: 'Example employer salary' }),
      transaction('personal', -20_000),
      transaction('personal-refund', 2_000, { kind: 'expense' }),
      transaction('business', -30_000, { category: 'Business travel' }),
      transaction('business-refund', 5_000, { kind: 'expense', category: 'Business travel' }),
      transaction('reimbursement', 15_000, { scope: 'work' }),
      transaction('reimbursement-reversal', -1_000, { kind: 'income', scope: 'work' }),
      transaction('personal-override', -3_000, { category: 'Business travel', scope: 'personal' }),
    ];
    const before = structuredClone(data);
    expect(summarizeMonth(data, MONTH)).toEqual({
      month: MONTH, incomeCents: 200_000, expenseCents: 21_000, netCents: 179_000,
      categories: { 'Personal shopping': 18_000, 'Business travel': 3_000 }, count: 4,
      workInCents: 20_000, workOutCents: 31_000, workNetCents: -11_000,
    });
    expect(data).toEqual(before);
  });

  it('excludes work transfers, deletions and other months', () => {
    const data = fixture();
    data.transactions = [
      transaction('bank-work', -2_000, { scope: 'work' }),
      transaction('card-work', -3_000, { scope: 'work', source: 'card' }),
      transaction('transfer', -4_000, { scope: 'work', kind: 'transfer' }),
      transaction('deleted', 6_000, { scope: 'work', deletedAt: NOW.toISOString() }),
      transaction('other-month', -7_000, { scope: 'work', month: '2032-07', date: '2032-07-10' }),
    ];
    expect(summarizeMonth(data, MONTH)).toMatchObject({ incomeCents: 0, expenseCents: 0, count: 0, workInCents: 0, workOutCents: 5_000, workNetCents: -5_000 });
  });

});

describe('work configuration persistence and synchronization', () => {
  it('round-trips work settings, explicit overrides and deletions while removing credentials', () => {
    const data = normalizeCategoryData(fixture());
    data.transactions = [transaction('work', 4_000, { scope: 'work', category: '' }), transaction('personal', -2_000, { scope: 'personal', category: '', deletedAt: NOW.toISOString() })];
    data.settings.googleClientId = 'local-device-client';
    const restored = validateBackup(serializeBackup(data));
    expect(restored).toEqual({ ...data, settings: { ...data.settings, googleClientId: '' } });
    expect(data.settings.googleClientId).toBe('local-device-client');
    const old = createEmptyData(NOW);
    expect(validateBackup(old)).toEqual(old);
    expect(Object.hasOwn(validateBackup(old), 'work')).toBe(false);
    expect(Object.hasOwn(validateBackup({ ...old, transactions: [transaction('old', -1_000, { category: '' })] }).transactions[0], 'scope')).toBe(false);
  });

  it.each([
    ['empty label', { label: '' }],
    ['non-text label', { label: 1 }],
    ['oversized label', { label: 'x'.repeat(121) }],
    ['whitespace label', { label: ' Example employer' }],
    ['control character label', { label: 'Example\u0000employer' }],
    ['non-list categories', { expenseCategories: {} }],
    ['empty category', { expenseCategories: [''] }],
    ['oversized category', { expenseCategories: ['x'.repeat(501)] }],
    ['whitespace category', { expenseCategories: ['Business  travel'] }],
    ['control character category', { expenseCategories: ['Business\u0000travel'] }],
    ['duplicate category', { expenseCategories: ['Business travel', 'BUSINESS TRAVEL'] }],
    ['too many categories', { expenseCategories: Array.from({ length: 1_001 }, (_, index) => `Category ${index}`) }],
    ['invalid timestamp', { updatedAt: '2032-02-30T00:00:00.000Z' }],
  ])('rejects %s before restoring', (_description, patch) => {
    expect(() => validateBackup({ ...fixture(), work: { ...configuration(), ...patch } })).toThrow('Invalid backup: work');
  });

  it.each([null, 'business', true, 1, {}])('rejects invalid transaction scopes: %s', scope => {
    const data = fixture();
    expect(() => validateBackup({ ...data, transactions: [{ ...transaction('invalid', -1_000, { category: '' }), scope }] })).toThrow('scope');
  });

  it('merges work settings by their own clock without older missing fields erasing the configuration', () => {
    const local = fixture();
    const remote = createEmptyData(LATER);
    remote.updatedAt = LATER.toISOString();
    expect(mergeFinanceData(local, remote).work).toEqual(local.work);
    expect(mergeFinanceData(remote, local).work).toEqual(local.work);
    remote.work = configuration({ label: 'New employer', updatedAt: LATER.toISOString(), expenseCategories: [] });
    local.updatedAt = '2032-08-17T12:00:00.000Z';
    const left = mergeFinanceData(local, remote);
    const right = mergeFinanceData(remote, local);
    expect(left.work).toEqual(remote.work);
    expect(right.work).toEqual(remote.work);
    expect(left.work).not.toBe(remote.work);
    expect(mergeFinanceData(left, left)).toEqual(left);
  });

  it('resolves equal work timestamps deterministically and preserves scope through record synchronization', () => {
    const local = fixture();
    const remote = fixture();
    remote.work = configuration({ label: 'Another employer', expenseCategories: ['Client visits'] });
    local.transactions = [transaction('same', -2_000, { scope: 'work' })];
    remote.transactions = [transaction('same', -2_000, { scope: 'personal', updatedAt: LATER.toISOString() })];
    const left = mergeFinanceData(local, remote);
    const right = mergeFinanceData(remote, local);
    expect(left).toEqual(right);
    expect(left.transactions[0].scope).toBe('personal');
    expect(validateBackup(serializeBackup(left)).work).toEqual(left.work);
  });

  it('preserves explicit work and personal classifications when the same source is imported again', () => {
    const incoming: ImportResult = { source: 'bank', transactions: [transaction('expense', -2_000), transaction('refund', 2_000)], warnings: [] };
    const data = applyImport(fixture(), incoming, 'example-statement.xlsx', NOW);
    data.transactions[0].scope = 'personal';
    data.transactions[1].scope = 'work';
    const next = applyImport(data, incoming, 'example-statement-copy.xlsx', LATER);
    expect(next.transactions).toEqual(data.transactions);
    expect(next.work).toEqual(data.work);
    expect(next.imports.at(-1)?.count).toBe(0);
  });
});
