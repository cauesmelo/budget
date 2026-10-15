import { describe, expect, it } from 'vitest';
import { createEmptyData } from '../src/lib/finance';
import { prepareImportReview } from '../src/lib/importReview';
import type { FinanceData, ImportResult, Transaction } from '../src/lib/types';

const STAMP = '2032-10-10T12:00:00.000Z';
const LATER = '2032-10-11T12:00:00.000Z';
function fixture(): FinanceData {
  const data = createEmptyData(new Date(STAMP));
  data.categories = [
    { id: 'groceries', name: 'Groceries', aliases: ['Food shopping'], updatedAt: STAMP },
    { id: 'travel', name: 'Travel', updatedAt: STAMP },
  ];
  return data;
}
function transaction(id: string, patch: Partial<Transaction> = {}): Transaction {
  return {
    id, fingerprint: `fingerprint-${id}`, source: 'card', account: 'Itaú card ****0001',
    originalDescription: 'Example merchant', description: '', category: '', kind: 'expense',
    date: '2032-10-01', month: '2032-10', amountCents: -2_000, updatedAt: STAMP,
    ...patch,
  };
}
function result(transactions: Transaction[]): ImportResult {
  return { source: 'card', transactions, warnings: ['Review this statement.'], summary: 'Example import.' };
}
function reviewed(id = 'old', patch: Partial<Transaction> = {}): Transaction {
  return transaction(id, { category: 'Groceries', description: 'Weekly groceries', date: '2032-09-01', month: '2032-09', ...patch });
}

describe('reviewed expense context', () => {
  it('fills category and description from exact normalized history without changing identity or financial fields', () => {
    const data = fixture();
    data.transactions = [reviewed('old', { originalDescription: '  EXAMPLE   MÉRCHANT ', account: 'Cartão Itaú ****0001' })];
    const incoming = transaction('new');
    const input = result([incoming]);
    const before = structuredClone({ data, input });
    const prepared = prepareImportReview(data, input);
    expect(prepared.learnedCount).toBe(1);
    expect(prepared.result.transactions).toEqual([{ ...incoming, category: 'Groceries', description: 'Weekly groceries' }]);
    expect(prepared.result).toMatchObject({ warnings: input.warnings, summary: input.summary });
    expect({ data, input }).toEqual(before);
  });

  it('resolves an active category previous name to its registered current name', () => {
    const data = fixture();
    data.transactions = [reviewed('old', { category: 'Food shopping' })];
    expect(prepareImportReview(data, result([transaction('new')])).result.transactions[0].category).toBe('Groceries');
  });

  it('preserves filled incoming fields and counts each changed transaction once', () => {
    const data = fixture();
    data.transactions = [reviewed()];
    const incoming = [
      transaction('description', { description: 'My own description' }),
      transaction('category', { category: 'Groceries' }),
      transaction('complete', { category: 'Groceries', description: 'Reviewed already' }),
    ];
    const prepared = prepareImportReview(data, result(incoming));
    expect(prepared.learnedCount).toBe(2);
    expect(prepared.result.transactions.map(row => [row.category, row.description])).toEqual([
      ['Groceries', 'My own description'], ['Groceries', 'Weekly groceries'], ['Groceries', 'Reviewed already'],
    ]);
  });

  it('does not learn context into an incoming category reviewed differently', () => {
    const data = fixture();
    data.transactions = [reviewed()];
    const incoming = transaction('new', { category: 'Travel' });
    expect(prepareImportReview(data, result([incoming]))).toMatchObject({ learnedCount: 0, result: { transactions: [incoming] } });
  });

  it.each([
    ['a different account', { account: 'Itaú card ****0002' }],
    ['a different source', { source: 'bank' as const }],
    ['a different merchant', { originalDescription: 'Another merchant' }],
    ['work expenses', { scope: 'work' as const }],
    ['income', { kind: 'income' as const, amountCents: 2_000 }],
    ['transfers', { kind: 'transfer' as const }],
  ])('does not reuse personal expense history for %s', (_label, patch) => {
    const data = fixture();
    data.transactions = [reviewed()];
    const incoming = transaction('new', patch);
    expect(prepareImportReview(data, result([incoming]))).toMatchObject({ learnedCount: 0, result: { transactions: [incoming] } });
  });

  it('does not infer work scope through an otherwise matching category', () => {
    const data = fixture();
    data.work = { label: 'Example employer', expenseCategories: ['Travel'], updatedAt: STAMP };
    data.transactions = [reviewed('old', { category: 'Travel', scope: 'personal' })];
    const incoming = transaction('new');
    const prepared = prepareImportReview(data, result([incoming]));
    expect(prepared.learnedCount).toBe(0);
    expect(prepared.result.transactions[0]).toEqual(incoming);
    expect(Object.hasOwn(prepared.result.transactions[0], 'scope')).toBe(false);
  });

  it('can reuse work expense context when work scope is explicitly provided', () => {
    const data = fixture();
    data.work = { label: 'Example employer', expenseCategories: ['Travel'], updatedAt: STAMP };
    data.transactions = [reviewed('old', { category: 'Travel', scope: 'work', description: 'Client trip' })];
    expect(prepareImportReview(data, result([transaction('new', { scope: 'work' })]))).toMatchObject({
      learnedCount: 1, result: { transactions: [{ category: 'Travel', description: 'Client trip', scope: 'work' }] },
    });
  });

  it('skips archived, unknown, conflicting, and deleted historical category assignments', () => {
    for (const mode of ['archived', 'unknown', 'conflicting', 'deleted']) {
      const data = fixture();
      data.transactions = [reviewed()];
      if (mode === 'archived') data.categories[0].archivedAt = LATER;
      if (mode === 'unknown') data.transactions[0].category = 'Unregistered category';
      if (mode === 'conflicting') data.transactions.push(reviewed('different', { category: 'Travel' }));
      if (mode === 'deleted') data.transactions[0].deletedAt = LATER;
      expect(prepareImportReview(data, result([transaction('new')])).learnedCount, mode).toBe(0);
    }
  });

  it('does not reuse retired reporting history', () => {
    const data = fixture();
    data.reporting = { startMonth: '2032-10', resetId: 'example-reset', updatedAt: STAMP };
    data.transactions = [reviewed()];
    expect(prepareImportReview(data, result([transaction('new')])).learnedCount).toBe(0);
  });

  it('copies an unambiguous category while leaving conflicting descriptions blank', () => {
    const data = fixture();
    data.transactions = [reviewed(), reviewed('other', { description: 'Something else' })];
    expect(prepareImportReview(data, result([transaction('new')]))).toMatchObject({
      learnedCount: 1, result: { transactions: [{ category: 'Groceries', description: '' }] },
    });
  });

  it('uses a nonempty description only and accepts equivalent normalized descriptions', () => {
    const data = fixture();
    data.transactions = [reviewed(), reviewed('other', { description: '  WEEKLY   groceries ', updatedAt: LATER }), reviewed('empty', { description: '  ' })];
    expect(prepareImportReview(data, result([transaction('new')])).result.transactions[0].description).toBe('WEEKLY   groceries');
  });

  it('leaves exact imported and deleted identities untouched', () => {
    const data = fixture();
    data.transactions = [reviewed(), transaction('same'), transaction('deleted', { deletedAt: LATER })];
    const incoming = [transaction('new-id', { fingerprint: 'fingerprint-same' }), transaction('deleted')];
    const prepared = prepareImportReview(data, result(incoming));
    expect(prepared.learnedCount).toBe(0);
    expect(prepared.result.transactions).toEqual(incoming);
    expect(prepared.possibleDuplicates).toEqual([]);
  });
});

describe('possible changed statement transactions', () => {
  it.each(['bank', 'card'] as const)('flags changed %s amounts for review without deleting or merging them', source => {
    const data = fixture();
    const old = transaction('old', { source });
    data.transactions = [old];
    const incoming = transaction('new', { source, amountCents: -2_100 });
    const prepared = prepareImportReview(data, result([incoming]));
    expect(prepared.possibleDuplicates).toEqual([{ incoming, existing: [old] }]);
    expect(prepared.result.transactions).toEqual([incoming]);
    expect(data.transactions).toEqual([old]);
  });

  it('preserves legitimate identical occurrences and leaves exact duplicate handling to import application', () => {
    const data = fixture();
    data.transactions = [transaction('old')];
    const incoming = [transaction('new-first'), transaction('new-second'), transaction('old')];
    const prepared = prepareImportReview(data, result(incoming));
    expect(prepared.possibleDuplicates).toEqual([]);
    expect(prepared.result.transactions).toEqual(incoming);
    expect(prepared.result.transactions).toHaveLength(3);
  });

  it.each([
    { source: 'manual' as const }, { date: '2032-10-02' }, { month: '2032-11' },
    { kind: 'income' as const }, { account: 'Other account' }, { originalDescription: 'Other merchant' },
  ])('does not flag transactions with a different physical identity: %j', patch => {
    const data = fixture();
    data.transactions = [transaction('old')];
    const incoming = transaction('new', { amountCents: -2_100, ...patch });
    expect(prepareImportReview(data, result([incoming])).possibleDuplicates).toEqual([]);
  });

  it('ignores deleted candidates and flags all active matching changed amounts', () => {
    const data = fixture();
    data.transactions = [transaction('old'), transaction('other', { amountCents: -2_500 }), transaction('deleted', { deletedAt: LATER })];
    const incoming = transaction('new', { amountCents: -2_100 });
    expect(prepareImportReview(data, result([incoming])).possibleDuplicates).toEqual([{ incoming, existing: data.transactions.slice(0, 2) }]);
  });
});
