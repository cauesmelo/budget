import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseImport, parseWorkbook } from '../src/lib/importers';
import { applyImport, createEmptyData } from '../src/lib/finance';

function workbook(sheets: Record<string, unknown[][]>): XLSX.WorkBook {
  const result = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(result, XLSX.utils.aoa_to_sheet(rows), name);
  return result;
}

// Native Portuguese workbook labels below exercise the bank statement formats.
function cardRows(): unknown[][] {
  return [
    [null, 'Fatura Aberta - Outubro/2026'],
    [null, 'Cartão', null, 'Valor (parcial)', 'Vencimento'],
    [null, 'Example card', null, 300, new Date('2026-10-20T00:00:00Z')],
    [null, 'Data', 'Lançamento', 'Parcelamento', 'Valor', 'Número do cartão'],
    [null, new Date('2026-08-05T00:00:00Z'), 'Example store', 'Parcela 2 de 3', 100, '****0001'],
    [null, new Date('2026-10-03T00:00:00Z'), 'Example grocery store', null, 100, '****0001'],
    [null, new Date('2026-10-03T00:00:00Z'), 'Example grocery store', null, 100, '****0001'],
    [null, new Date('2026-10-02T00:00:00Z'), 'Purchase refund', null, -20, '****0001'],
    [null, new Date('2026-09-20T00:00:00Z'), 'Pagamento Com Saldo', null, -500, '****0001'],
    [null, 'Subtotal', null, null, 280],
  ];
}

describe('Itaú importers', () => {
  it.each([
    {
      source: 'bank', sheet: 'Statement', options: {},
      rows: [['Conta', '12345-6'], ['Agência', '1000'], ['Data', 'Lançamento', 'Valor'], ['01/04/2026', 'Compra exemplo', -123.45]],
      oldAccount: 'Conta corrente Itaú • 1000/12345-6', account: 'Itaú checking account • 1000/12345-6', fingerprint: 'v1-4a39a3ef3d823844',
    },
    {
      source: 'card', sheet: 'Fatura outubro2026', options: { cardMonth: '2026-10' },
      rows: [['Data', 'Lançamento', 'Parcelamento', 'Valor', 'Número do cartão'], ['01/04/2026', 'Compra exemplo', '1/2', 123.45, '1234']],
      oldAccount: 'Cartão Itaú ****1234', account: 'Itaú card ****1234', fingerprint: 'v1-3426b5cea16fc8bd',
    },
  ])('preserves the released $source fingerprint when account display labels change', fixture => {
    // These fingerprints were captured from the previous release with synthetic native-format rows.
    const result = parseWorkbook(workbook({ [fixture.sheet]: fixture.rows }), 'source.xlsx', fixture.options);
    const transaction = result.transactions[0];
    expect(transaction).toMatchObject({ account: fixture.account, fingerprint: fixture.fingerprint, id: `tx-${fixture.fingerprint}` });
    const data = createEmptyData(new Date('2026-10-11T15:00:00.000Z'));
    const previous = { ...transaction, account: fixture.oldAccount, category: '', description: 'Existing user edit', deletedAt: data.updatedAt };
    data.transactions = [previous];
    expect(applyImport(data, result, 'renamed.xlsx').transactions).toEqual([previous]);
  });

  it('reads bank debits/credits and skips balance rows and other sheets', () => {
    const input = workbook({
      Lançamentos: [
        ['Logotipo Itaú'],
        ['data', 'lançamento', 'ag./origem', 'valor (R$)', 'saldos (R$)'],
        ['01/10/2026', 'SALDO ANTERIOR', null, null, 500],
        ['02/10/2026', 'PIX QRS MERCADO', null, '-1.234,56', null],
        ['02/10/2026', 'REMUNERACAO/SALARIO', null, '2.000,00', null],
        ['03/10/2026', 'FATURA PAGA Itaú', null, -300, null],
        ['03/10/2026', 'APLICACAO CDB', null, -250, null],
        ['03/10/2026', 'RESGATE CDB', null, 100, null],
        ['03/10/2026', 'REND PAGO APLIC AUT MAIS', null, 0.02, null],
        ['03/10/2026', 'SALDO TOTAL DISPONÍVEL DIA', null, null, 815],
        ['04/10/2026', 'PIX SEM VALOR', null, null, null],
      ],
      'Posição Consolidada': [['Descrição', 'valor'], ['saldo total disponível', 815]],
    });
    const result = parseWorkbook(input, 'statement.xls');
    expect(result.source).toBe('bank');
    expect(result.transactions).toHaveLength(6);
    expect(result.transactions[0]).toMatchObject({ date: '2026-10-02', month: '2026-10', amountCents: -123456, kind: 'expense', description: '', category: '' });
    expect(result.transactions[1]).toMatchObject({ amountCents: 200000, kind: 'income' });
    expect(result.transactions.filter(t => t.kind === 'transfer')).toHaveLength(3);
    expect(result.transactions.at(-1)).toMatchObject({ amountCents: 2, kind: 'income' });
    expect(result.warnings.some(w => w.includes('no valid amount'))).toBe(true);
  });

  it('uses credit and debit columns when there is no combined value column', () => {
    const result = parseWorkbook(workbook({ Extrato: [
      ['Data', 'Histórico', 'Débito', 'Crédito', 'Saldo'],
      ['02/10/2026', 'Example', '12,30', null, '50,00'],
      ['03/10/2026', 'Received payment', null, '20,00', '70,00'],
    ] }), 'statement.xlsx');
    expect(result.transactions.map(t => t.amountCents)).toEqual([-1230, 2000]);
  });

  it('distinguishes bank accounts from statement metadata in stable identities', () => {
    const account = (number: string) => workbook({ Extrato: [
      ['Agência:', '0001'], ['Conta:', number],
      ['Data', 'Lançamento', 'Valor'], ['02/10/2026', 'PIX Grocery store', -10],
    ] });
    const first = parseWorkbook(account('11111-1'), 'statement.xls').transactions[0];
    const second = parseWorkbook(account('22222-2'), 'statement.xls').transactions[0];
    expect(first.account).toContain('0001/11111-1');
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(parseWorkbook(account('11111-1'), 'renamed.xls').transactions[0].fingerprint).toBe(first.fingerprint);
  });

  it('rounds numeric half-cent values with the shared decimal money conversion', () => {
    const result = parseWorkbook(workbook({ Extrato: [
      ['Data', 'Lançamento', 'Valor'], ['02/10/2026', 'Adjustment', 1.005],
    ] }), 'statement.xlsx');
    expect(result.transactions[0].amountCents).toBe(101);
  });

  it('treats automatic investment principal as transfers while keeping actual yield as income', () => {
    const result = parseWorkbook(workbook({ Extrato: [
      ['Data', 'Lançamento', 'Valor'],
      ['02/10/2026', 'APLIC AUT MAIS', -200],
      ['03/10/2026', 'RES APLIC AUT MAIS', 100],
      ['03/10/2026', 'REND PAGO APLIC AUT MAIS', 0.01],
    ] }), 'statement.xlsx');
    expect(result.transactions.map(t => t.kind)).toEqual(['transfer', 'transfer', 'income']);
  });

  it('places installments in invoice month and handles payment and refund separately', () => {
    const result = parseWorkbook(workbook({ 'Fatura 10-26': cardRows() }), 'card.xlsx');
    expect(result.source).toBe('card');
    expect(result.transactions).toHaveLength(5);
    expect(result.transactions[0]).toMatchObject({ date: '2026-08-05', month: '2026-10', amountCents: -10000, installment: '2/3', kind: 'expense' });
    expect(result.transactions[3]).toMatchObject({ amountCents: 2000, kind: 'expense' });
    expect(result.transactions[4]).toMatchObject({ amountCents: 50000, kind: 'transfer' });
    expect(result.transactions.every(t => t.category === '' && t.description === '')).toBe(true);
    expect(result.warnings.some(w => w.includes('differs from the statement total'))).toBe(false);
    expect(result.warnings.some(w => w.includes('still open'))).toBe(true);
  });

  it('honors an explicit invoice month and reports mismatch', () => {
    const result = parseWorkbook(workbook({ Fatura: cardRows() }), 'invoice.xlsx', { cardMonth: '2026-11' });
    expect(result.transactions.every(t => t.month === '2026-11')).toBe(true);
    expect(result.warnings.some(w => w.includes('differs from the detected statement'))).toBe(true);
  });

  it('extracts competence from the textual invoice heading without a due date', () => {
    const rows = cardRows();
    rows.splice(1, 2);
    const result = parseWorkbook(workbook({ Fatura: rows }), 'no-month.xlsx');
    expect(result.transactions[0].month).toBe('2026-10');
  });

  it('does not guess an invoice month when unavailable', () => {
    const rows = cardRows().slice(3);
    expect(() => parseWorkbook(workbook({ Compras: rows }), 'purchases.xlsx')).toThrow('budget month');
    expect(() => parseWorkbook(workbook({ Compras: rows }), 'purchases.xlsx', { cardMonth: '2026-13' })).toThrow('Invalid budget month');
  });

  it('retains identical legitimate purchases but creates stable identities across renamed files', () => {
    const input = workbook({ Fatura: cardRows() });
    const first = parseWorkbook(input, 'invoice.xlsx');
    const second = parseWorkbook(input, 'renamed-copy.xlsx');
    expect(first.transactions.map(t => t.fingerprint)).toEqual(second.transactions.map(t => t.fingerprint));
    expect(first.transactions.map(t => t.id)).toEqual(second.transactions.map(t => t.id));
    expect(new Set(first.transactions.map(t => t.fingerprint)).size).toBe(5);
    expect(first.transactions[1].fingerprint).not.toBe(first.transactions[2].fingerprint);
  });

  it('recognizes the native card-number header and keeps physical and virtual identities distinct', () => {
    const result = parseWorkbook(workbook({ Fatura: [
      ['Fatura Outubro/2026'], ['Data', 'Lançamento', 'Parcelamento', 'Valor', 'Número'],
      ['03/10/2026', 'Example store', null, 100, '****0001'],
      ['03/10/2026', 'Example store', null, 100, '****0002'],
    ] }), 'card.xlsx');
    expect(result.transactions.map(t => t.account)).toEqual(['Itaú card ****0001', 'Itaú card ****0002']);
    expect(result.transactions[0].fingerprint).not.toBe(result.transactions[1].fingerprint);
  });

  it.each(['xlsx', 'xls'] as const)('reads %s bytes through the public file API', async bookType => {
    const buffer = XLSX.write(workbook({ Fatura: cardRows() }), { type: 'array', bookType }) as ArrayBuffer;
    const result = await parseImport({ name: `invoice.${bookType}`, arrayBuffer: async () => buffer });
    expect(result.transactions).toHaveLength(5);
    expect(result.transactions[0].date).toBe('2026-08-05');
  });

  it('rejects unsupported spreadsheet layouts without importing historical data or a plan', () => {
    const source = workbook({
      Abril: [['Data', 'Nome', 'Saída', 'Categoria'], ['01/04/2026', 'Example purchase', 25, 'Groceries']],
      'Orçamento médio prazo': [['Despesas', new Date('2026-10-01T00:00:00Z')], ['Rent', 100]],
    });
    expect(() => parseWorkbook(source, 'old-workbook.xlsx')).toThrow('Itaú checking account or card statement');
  });

  it('rejects file types outside the supported statement formats before reading their contents', async () => {
    let wasRead = false;
    await expect(parseImport({ name: 'statement.csv', arrayBuffer: async () => { wasRead = true; return new ArrayBuffer(0); } })).rejects.toThrow('XLS or XLSX');
    expect(wasRead).toBe(false);
  });

  it('rejects an unrelated workbook with an actionable error', () => {
    expect(() => parseWorkbook(workbook({ Outros: [['Text'], ['Example']] }), 'other.xlsx')).toThrow('Unrecognized format');
  });
});
