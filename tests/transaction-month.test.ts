import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { addCategory } from '../src/lib/categories';
import { applyImport, createEmptyData, getInstallmentSuggestions, isReportableTransaction, mergeFinanceData, previewDuplicateCount, sanitizeFinanceData, summarizeMonth } from '../src/lib/finance';
import { parseWorkbook } from '../src/lib/importers';
import { getBudgetComparison } from '../src/lib/insights';
import { loadData, saveData, serializeBackup, validateBackup } from '../src/lib/storage';
import { getTransactionReportingMonth } from '../src/lib/transactionMonth';
import type { FinanceData, Transaction } from '../src/lib/types';

const memory = vi.hoisted(() => new Map<string, unknown>());
vi.mock('idb-keyval', () => ({
  createStore: vi.fn((databaseName: string) => ({ databaseName })),
  get: vi.fn(async (key: string, store: { databaseName: string }) => memory.get(`${store.databaseName}/${key}`)),
  set: vi.fn(async (key: string, value: unknown, store: { databaseName: string }) => { memory.set(`${store.databaseName}/${key}`, structuredClone(value)); }),
}));

const CREATED = '2032-10-15T12:00:00.000Z';
const EDITED = '2032-10-16T12:00:00.000Z';
const DELETED = '2032-10-17T12:00:00.000Z';

function transaction(id: string, patch: Partial<Transaction> = {}): Transaction {
  return {
    id, fingerprint: `fingerprint-${id}`, source: 'card', date: '2032-10-14', month: '2032-11',
    kind: 'expense', amountCents: -10_000, account: 'Example card', originalDescription: 'Example merchant',
    description: '', category: '', updatedAt: CREATED, ...patch,
  };
}

function fixture(): FinanceData {
  const data = createEmptyData(new Date(CREATED));
  data.reporting = { startMonth: '2032-10', resetId: 'example-reset', updatedAt: CREATED };
  data.settings.reserveStartMonth = '2032-10';
  return data;
}

function cardStatement() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Fatura Novembro/2032'],
    ['Data', 'Lançamento', 'Parcelamento', 'Valor', 'Número do cartão'],
    ['14/10/2032', 'Example merchant', null, 100, '****0001'],
    ['13/10/2032', 'Example refund', null, -25, '****0001'],
    ['12/10/2032', 'Example deleted purchase', null, 40, '****0001'],
    ['11/10/2032', 'Example work purchase', null, 20, '****0001'],
  ]), 'Fatura');
  return workbook;
}

beforeEach(() => { memory.clear(); vi.stubGlobal('indexedDB', {}); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('purchase-date card reporting', () => {
  it('uses card purchase dates without mutating their stored statement identity', () => {
    const card = transaction('purchase');
    const before = structuredClone(card);
    expect(getTransactionReportingMonth(card)).toBe('2032-10');
    expect(card).toEqual(before);
    expect(getTransactionReportingMonth({ ...card, source: 'bank', month: '2032-09' })).toBe('2032-09');
    expect(getTransactionReportingMonth({ ...card, source: 'manual', month: '2032-08' })).toBe('2032-08');
  });

  it('moves existing card purchases and refunds to October while separating work and ignoring deletions', () => {
    const data = fixture();
    data.transactions = [
      transaction('purchase', { category: 'Shopping', description: 'Edited description', updatedAt: EDITED }),
      transaction('refund', { amountCents: 2_500, category: 'Shopping' }),
      transaction('work', { amountCents: -3_000, scope: 'work' }),
      transaction('reimbursement', { amountCents: 1_000, kind: 'income', scope: 'work' }),
      transaction('deleted', { amountCents: -4_000, deletedAt: DELETED }),
      transaction('payment', { amountCents: 7_500, kind: 'transfer' }),
      transaction('salary', { amountCents: 20_000, kind: 'income', source: 'bank', month: '2032-10' }),
    ];
    const before = structuredClone(data);
    expect(summarizeMonth(data, '2032-10')).toEqual({
      month: '2032-10', incomeCents: 20_000, expenseCents: 7_500, netCents: 12_500,
      categories: { Shopping: 7_500 }, count: 3, workInCents: 1_000, workOutCents: 3_000, workNetCents: -2_000,
    });
    expect(summarizeMonth(data, '2032-11')).toMatchObject({ incomeCents: 0, expenseCents: 0, count: 0, workInCents: 0, workOutCents: 0 });
    expect(data).toEqual(before);
  });

  it('matches budget-versus-recorded insights to the purchase month', () => {
    const data = fixture();
    data.transactions = [transaction('purchase'), transaction('refund', { amountCents: 2_500 })];
    data.planItems = [{ id: 'budget', name: 'Example spending', category: '', kind: 'expense', startMonth: '2032-10', amounts: {}, defaultAmountCents: 20_000, updatedAt: CREATED }];
    expect(getBudgetComparison(data, '2032-10')).toMatchObject({ recordedExpenseCents: 7_500, remainingCents: 12_500, transactionCount: 2 });
    expect(getBudgetComparison(data, '2032-11')).toMatchObject({ recordedExpenseCents: 0, remainingCents: 20_000, transactionCount: 0 });
  });

  it('uses purchase dates at reporting boundaries and across years', () => {
    const data = fixture();
    expect(isReportableTransaction(data, transaction('old', { date: '2032-09-30' }))).toBe(false);
    expect(isReportableTransaction(data, transaction('start', { date: '2032-10-01' }))).toBe(true);
    expect(getTransactionReportingMonth(transaction('new-year', { date: '2032-12-31', month: '2033-01' }))).toBe('2032-12');
    delete data.reporting;
    expect(isReportableTransaction(data, transaction('older', { date: '2032-09-30' }))).toBe(true);
  });

  it('excludes newly imported pre-start purchases while accepting October purchases billed in November', () => {
    const data = fixture();
    const result = { source: 'card' as const, warnings: [], transactions: [transaction('old', { date: '2032-09-30' }), transaction('current')] };
    const imported = applyImport(data, result, 'example-card.xlsx', new Date(CREATED));
    expect(imported.transactions.map(item => item.id)).toEqual(['current']);
    expect(imported.imports[0].count).toBe(1);
    expect(summarizeMonth(imported, '2032-10').expenseCents).toBe(10_000);
    expect(previewDuplicateCount(imported, result)).toBe(1);
  });

  it('does not purge older stored installment identities or tombstones when reporting changes', () => {
    const data = fixture();
    data.transactions = [
      transaction('historical-installment', { date: '2032-08-03', installment: '3/6', importId: 'statement' }),
      transaction('deleted-historical', { date: '2032-08-03', deletedAt: DELETED, updatedAt: EDITED, importId: 'statement' }),
    ];
    data.imports = [{ id: 'statement', filename: 'example-card.xlsx', source: 'card', count: 2, importedAt: CREATED, updatedAt: CREATED }];
    expect(sanitizeFinanceData(data)).toEqual(data);
    expect(validateBackup(serializeBackup(data))).toEqual(data);
    expect(summarizeMonth(data, '2032-10').count).toBe(0);
    expect(summarizeMonth(data, '2032-11').count).toBe(0);
  });

  it('keeps the statement month as the separate remaining-installment planning anchor', () => {
    const data = fixture();
    data.transactions = [transaction('old-installment', { date: '2032-08-03', installment: '3/6' })];
    expect(getInstallmentSuggestions(data, '2032-10')).toEqual([]);
    expect(getInstallmentSuggestions(data, '2032-11')).toMatchObject([{ firstMonth: '2032-11', count: 4, amountCents: 10_000 }]);
  });

  it('keeps October purchases with earlier statement metadata through imports, saves, and backups', async () => {
    const data = fixture();
    const purchase = transaction('purchase-with-earlier-statement', { month: '2032-09' });
    const result = { source: 'card' as const, warnings: [], transactions: [purchase] };
    const imported = applyImport(data, result, 'example-card.xlsx', new Date(CREATED));
    expect(imported.transactions).toHaveLength(1);
    expect(imported.transactions[0]).toMatchObject({ id: purchase.id, fingerprint: purchase.fingerprint, month: '2032-09', date: '2032-10-14' });
    await saveData(imported);
    const loaded = await loadData();
    expect(loaded).toEqual(imported);
    expect(validateBackup(serializeBackup(imported))).toEqual(imported);
    expect(summarizeMonth(loaded!, '2032-10')).toMatchObject({ expenseCents: 10_000, count: 1 });
    expect(previewDuplicateCount(loaded!, result)).toBe(1);
    expect(applyImport(loaded!, result, 'example-copy.xlsx', new Date(EDITED)).transactions).toEqual(imported.transactions);
  });

  it('loads saved card edits and deletions without rewriting identities, dates, or clocks', async () => {
    const data = addCategory(fixture(), 'Shopping', new Date(CREATED));
    data.transactions = [transaction('edited', { description: 'Existing edit', category: 'Shopping', scope: 'work', updatedAt: EDITED }), transaction('deleted', { deletedAt: DELETED })];
    await saveData(data);
    const loaded = await loadData();
    expect(loaded).toEqual(data);
    expect(validateBackup(serializeBackup(loaded!))).toEqual(data);
  });

  it('retains edited and deleted real-parser identities when the same November bill is reimported', () => {
    const parsed = parseWorkbook(cardStatement(), 'example-november.xlsx');
    const data = applyImport(fixture(), parsed, 'example-november.xlsx', new Date(CREATED));
    data.transactions[0] = { ...data.transactions[0], description: 'Existing edit', updatedAt: EDITED };
    data.transactions[2] = { ...data.transactions[2], deletedAt: DELETED };
    data.transactions[3] = { ...data.transactions[3], scope: 'work', updatedAt: EDITED };
    const before = structuredClone(data.transactions);
    const renamed = parseWorkbook(cardStatement(), 'renamed-copy.xlsx');
    expect(previewDuplicateCount(data, renamed)).toBe(4);
    const next = applyImport(data, renamed, 'renamed-copy.xlsx', new Date(DELETED));
    expect(next.transactions).toEqual(before);
    expect(next.imports.at(-1)?.count).toBe(0);
    expect(next.transactions.every(item => item.month === '2032-11')).toBe(true);
    expect(summarizeMonth(next, '2032-10')).toMatchObject({ expenseCents: 7_500, count: 2, workOutCents: 2_000 });
    expect(summarizeMonth(next, '2032-11')).toMatchObject({ expenseCents: 0, count: 0 });
  });

  it('converges across cloud merges without losing newer edits or resurrecting deleted card rows', () => {
    const original = fixture();
    original.transactions = [transaction('edited'), transaction('deleted'), transaction('old', { date: '2032-08-03' })];
    const otherDevice = structuredClone(original);
    otherDevice.transactions[0] = { ...otherDevice.transactions[0], description: 'New description', scope: 'work', updatedAt: EDITED };
    otherDevice.transactions[1] = { ...otherDevice.transactions[1], deletedAt: DELETED };
    for (const merged of [mergeFinanceData(original, otherDevice), mergeFinanceData(otherDevice, original)]) {
      expect(merged.transactions.find(item => item.id === 'edited')).toEqual(otherDevice.transactions[0]);
      expect(merged.transactions.find(item => item.id === 'deleted')).toEqual(otherDevice.transactions[1]);
      expect(merged.transactions.find(item => item.id === 'old')).toEqual(original.transactions[2]);
      expect(merged.transactions.every(item => item.month === '2032-11')).toBe(true);
      expect(summarizeMonth(merged, '2032-10')).toMatchObject({ expenseCents: 0, count: 0, workOutCents: 10_000 });
      expect(mergeFinanceData(merged, original)).toEqual(merged);
    }
  });
});
