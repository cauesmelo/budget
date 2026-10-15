import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseImport } from '../src/lib/importers';
import { isValidDate } from '../src/lib/finance';

// Optional local compatibility checks. Filenames and source values stay outside Git.
const directory = process.env.PRIVATE_IMPORT_DIR;
const files = {
  bank: process.env.PRIVATE_BANK_FILE || 'statement.xls',
  card: process.env.PRIVATE_CARD_FILE || 'invoice.xlsx',
};
async function readImport(filename: string) {
  const bytes = await readFile(join(directory!, filename));
  return parseImport({ name: filename, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
}

describe.skipIf(!directory)('authorized private workbook compatibility', () => {
  it('reads an XLS bank statement without importing running balances', async () => {
    const result = await readImport(files.bank);
    expect(result.source).toBe('bank');
    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.transactions.some(t => /^saldo/i.test(t.originalDescription))).toBe(false);
    expect(result.transactions.every(t => t.category === '' && t.description === '')).toBe(true);
    expect(result.transactions.every(t => Number.isSafeInteger(t.amountCents))).toBe(true);
  });

  it('reads a card invoice with consistent competence and distinct transaction identities', async () => {
    const result = await readImport(files.card);
    expect(result.source).toBe('card');
    expect(result.transactions.length).toBeGreaterThan(0);
    expect(new Set(result.transactions.map(t => t.month)).size).toBe(1);
    expect(result.transactions.every(t => isValidDate(t.date) && Number.isSafeInteger(t.amountCents))).toBe(true);
    expect(new Set(result.transactions.map(t => t.fingerprint)).size).toBe(result.transactions.length);
  });
});
