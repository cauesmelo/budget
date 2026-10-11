import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseImport, parseWorkbook } from '../src/lib/importers';
import { addMonths, applyImport, createEmptyData, isValidDate, projectReserve } from '../src/lib/finance';

// Optional local compatibility checks. Filenames and source values stay outside Git.
const directory = process.env.PRIVATE_IMPORT_DIR;
const files = {
  budget: process.env.PRIVATE_BUDGET_FILE || 'budget.xlsx',
  bank: process.env.PRIVATE_BANK_FILE || 'statement.xls',
  card: process.env.PRIVATE_CARD_FILE || 'invoice.xlsx',
};
async function readImport(filename: string) {
  const bytes = await readFile(join(directory!, filename));
  return parseImport({ name: filename, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
}

describe.skipIf(!directory)('authorized private workbook compatibility', () => {
  it('imports the Budget history and medium-term plan', async () => {
    const result = await readImport(files.budget);
    expect(result.source).toBe('budget');
    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.snapshots.length).toBeGreaterThan(0);
    expect(result.planItems.length).toBeGreaterThan(0);
    expect(result.transactions.every(t => isValidDate(t.date) && Number.isSafeInteger(t.amountCents))).toBe(true);
    expect(result.planItems.every(item => Number.isSafeInteger(item.defaultAmountCents))).toBe(true);
  });

  it('reconciles projected reserves against subsequent opening balances in the source', async () => {
    const source = XLSX.read(await readFile(join(directory!, files.budget)), { cellDates: true });
    const imported = parseWorkbook(source, files.budget);
    const projected = projectReserve(applyImport(createEmptyData(), imported, files.budget));
    const normalize = (value: unknown) => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
    const sheetName = source.SheetNames.find(name => /orcamento.*(?:medio|prazo)/.test(normalize(name)));
    expect(sheetName).toBeDefined();
    const sheet = source.Sheets[sheetName!];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
    const reserveRow = rows.findIndex(row => normalize(row[0]) === 'reserva');
    const headers = rows.find(row => row.filter(cell => cell instanceof Date && cell.getUTCDate() === 1).length >= 2);
    expect(reserveRow).toBeGreaterThanOrEqual(0);
    expect(headers).toBeDefined();
    let compared = 0;
    for (const month of projected) {
      const nextMonth = addMonths(month.month, 1);
      const column = headers!.findIndex(cell => cell instanceof Date && cell.toISOString().slice(0, 7) === nextMonth);
      if (column < 0) continue;
      const nextOpening = sheet[XLSX.utils.encode_cell({ r: reserveRow, c: column })]?.v;
      if (typeof nextOpening !== 'number' || !Number.isFinite(nextOpening)) continue;
      expect(month.closingCents).toBe(Math.round(nextOpening * 100));
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('reads a legacy XLS bank statement without importing running balances', async () => {
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
