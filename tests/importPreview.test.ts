import { describe, expect, it } from 'vitest';
import { applyImport, createEmptyData } from '../src/lib/finance';
import { excludePreviewTransaction, undoPreviewExclusion, type PendingImport } from '../src/lib/importPreview';
import type { Transaction } from '../src/lib/types';

const STAMP = '2032-10-10T12:00:00.000Z';
const IMPORTED_AT = '2032-10-11T12:00:00.000Z';

function transaction(id: string, patch: Partial<Transaction> = {}): Transaction {
  return {
    id, fingerprint: `fingerprint-${id}`, date: '2032-10-01', month: '2032-10',
    amountCents: -2_500, kind: 'expense', source: 'card', account: 'Example card',
    originalDescription: 'Example merchant', description: '', category: '', updatedAt: STAMP,
    ...patch,
  };
}

function pending(transactions: Transaction[]): PendingImport {
  return {
    name: 'example-statement.xlsx', learnedCount: 2,
    result: { source: 'card', transactions, warnings: ['Example warning.'], summary: 'Example summary.' },
  };
}

describe('pending import exclusions', () => {
  it('excludes only the selected occurrence when purchases otherwise look identical', () => {
    const input = pending([transaction('first'), transaction('second'), transaction('third')]);
    const before = structuredClone(input);
    const next = excludePreviewTransaction(input, 'second');

    expect(next.result.transactions.map(row => row.id)).toEqual(['first', 'third']);
    expect(next.excluded).toEqual([{ transaction: input.result.transactions[1], index: 1 }]);
    expect(input).toEqual(before);
    expect(next).not.toBe(input);
    expect(next.result).not.toBe(input.result);
    expect(next.excluded![0].transaction).not.toBe(input.result.transactions[1]);
    expect(next.result).toMatchObject({ source: 'card', warnings: before.result.warnings, summary: before.result.summary });
    expect(next.name).toBe(input.name);
    expect(next.learnedCount).toBe(input.learnedCount);
  });

  it.each(['income', 'transfer'] as const)('allows excluding a %s without reclassifying it', kind => {
    const selected = transaction('selected', { kind, amountCents: 15_000 });
    const input = pending([selected, transaction('kept')]);
    const next = excludePreviewTransaction(input, selected.id);

    expect(next.result.transactions.map(row => row.id)).toEqual(['kept']);
    expect(next.excluded![0].transaction).toEqual(selected);
    expect(undoPreviewExclusion(next).result.transactions).toEqual(input.result.transactions);
  });

  it('restores exclusions in reverse order with their original positions and reviewed fields', () => {
    const input = pending([
      transaction('first'),
      transaction('reviewed', {
        description: 'Reviewed description', category: 'Travel', scope: 'work',
        installment: '03/08', sourceRow: 7, sourceFile: 'example-statement.xlsx',
      }),
      transaction('third'), transaction('fourth'),
    ]);
    const firstExclusion = excludePreviewTransaction(input, 'reviewed');
    const secondExclusion = excludePreviewTransaction(firstExclusion, 'fourth');
    const before = structuredClone(secondExclusion);

    const firstUndo = undoPreviewExclusion(secondExclusion);
    expect(firstUndo.result.transactions.map(row => row.id)).toEqual(['first', 'third', 'fourth']);
    expect(firstUndo.excluded).toEqual(firstExclusion.excluded);
    const secondUndo = undoPreviewExclusion(firstUndo);
    expect(secondUndo.result).toEqual(input.result);
    expect(secondUndo.excluded).toEqual([]);
    expect(secondExclusion).toEqual(before);
  });

  it('keeps reviews made to remaining rows while restoring an excluded row', () => {
    const input = excludePreviewTransaction(pending([transaction('excluded'), transaction('kept')]), 'excluded');
    const edited = {
      ...input,
      result: {
        ...input.result,
        transactions: input.result.transactions.map(row => ({ ...row, description: 'Updated after exclusion', category: 'Groceries' })),
      },
    };
    const restored = undoPreviewExclusion(edited);

    expect(restored.result.transactions[0]).toEqual(transaction('excluded'));
    expect(restored.result.transactions[1]).toMatchObject({ id: 'kept', description: 'Updated after exclusion', category: 'Groceries' });
    expect(restored.result.warnings).toEqual(input.result.warnings);
    expect(restored.result.summary).toBe(input.result.summary);
  });

  it('leaves unknown exclusions and empty undo operations unchanged', () => {
    const input = pending([transaction('existing')]);
    const before = structuredClone(input);

    expect(excludePreviewTransaction(input, 'unknown')).toBe(input);
    expect(undoPreviewExclusion(input)).toBe(input);
    const empty = { ...input, excluded: [] };
    expect(undoPreviewExclusion(empty)).toBe(empty);
    expect(input).toEqual(before);
  });

  it('saves only retained transactions without changing existing financial history', () => {
    const data = createEmptyData(new Date(STAMP));
    data.categories = [{ id: 'travel', name: 'Travel', updatedAt: STAMP }];
    const history = transaction('history', { category: 'Travel', description: 'Previously reviewed', scope: 'work' });
    data.transactions = [history];
    const before = structuredClone(data);
    const input = pending([
      transaction('excluded-expense'),
      transaction('retained', { description: 'Retained expense', category: 'Travel' }),
      transaction('excluded-income', { kind: 'income', amountCents: 25_000 }),
      transaction('excluded-transfer', { kind: 'transfer', amountCents: 10_000 }),
    ]);
    const reviewed = ['excluded-expense', 'excluded-income', 'excluded-transfer']
      .reduce(excludePreviewTransaction, input);
    const imported = applyImport(data, reviewed.result, reviewed.name, new Date(IMPORTED_AT));

    expect(imported.transactions.map(row => row.id)).toEqual(['history', 'retained']);
    expect(imported.transactions[0]).toEqual(history);
    expect(imported.transactions[1]).toMatchObject({ description: 'Retained expense', category: 'Travel' });
    expect(imported.imports).toHaveLength(1);
    expect(imported.imports[0].count).toBe(1);
    expect(data).toEqual(before);
    expect(input.result.transactions).toHaveLength(4);
    expect(reviewed.excluded).toHaveLength(3);
  });

  it('creates no transactions or import batch when every preview row is excluded', () => {
    const data = createEmptyData(new Date(STAMP));
    data.transactions = [transaction('history')];
    const before = structuredClone(data);
    const reviewed = excludePreviewTransaction(pending([transaction('excluded')]), 'excluded');

    const imported = applyImport(data, reviewed.result, reviewed.name, new Date(IMPORTED_AT));
    expect(imported.transactions).toEqual(before.transactions);
    expect(imported.imports).toEqual([]);
    expect(data).toEqual(before);
  });
});
