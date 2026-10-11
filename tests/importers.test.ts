import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseImport, parseWorkbook } from '../src/lib/importers';

function workbook(sheets: Record<string, unknown[][]>): XLSX.WorkBook {
  const result = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(result, XLSX.utils.aoa_to_sheet(rows), name);
  return result;
}

function cardRows(): unknown[][] {
  return [
    [null, 'Fatura Aberta - Outubro/2026'],
    [null, 'Cartão', null, 'Valor (parcial)', 'Vencimento'],
    [null, 'Cartão teste', null, 300, new Date('2026-10-20T00:00:00Z')],
    [null, 'Data', 'Lançamento', 'Parcelamento', 'Valor', 'Número do cartão'],
    [null, new Date('2026-08-05T00:00:00Z'), 'Loja exemplo', 'Parcela 2 de 3', 100, '****0001'],
    [null, new Date('2026-10-03T00:00:00Z'), 'Mercado exemplo', null, 100, '****0001'],
    [null, new Date('2026-10-03T00:00:00Z'), 'Mercado exemplo', null, 100, '****0001'],
    [null, new Date('2026-10-02T00:00:00Z'), 'Estorno compra', null, -20, '****0001'],
    [null, new Date('2026-09-20T00:00:00Z'), 'Pagamento Com Saldo', null, -500, '****0001'],
    [null, 'Subtotal', null, null, 280],
  ];
}

describe('Itaú importers', () => {
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
    const result = parseWorkbook(input, 'extrato.xls');
    expect(result.source).toBe('bank');
    expect(result.transactions).toHaveLength(6);
    expect(result.transactions[0]).toMatchObject({ date: '2026-10-02', month: '2026-10', amountCents: -123456, kind: 'expense', description: '', category: '' });
    expect(result.transactions[1]).toMatchObject({ amountCents: 200000, kind: 'income' });
    expect(result.transactions.filter(t => t.kind === 'transfer')).toHaveLength(3);
    expect(result.transactions.at(-1)).toMatchObject({ amountCents: 2, kind: 'income' });
    expect(result.warnings.some(w => w.includes('sem valor'))).toBe(true);
  });

  it('uses credit and debit columns when there is no combined value column', () => {
    const result = parseWorkbook(workbook({ Extrato: [
      ['Data', 'Histórico', 'Débito', 'Crédito', 'Saldo'],
      ['02/10/2026', 'Exemplo', '12,30', null, '50,00'],
      ['03/10/2026', 'Recebimento', null, '20,00', '70,00'],
    ] }), 'extrato.csv');
    expect(result.transactions.map(t => t.amountCents)).toEqual([-1230, 2000]);
  });

  it('distinguishes bank accounts from statement metadata in stable identities', () => {
    const account = (number: string) => workbook({ Extrato: [
      ['Agência:', '0001'], ['Conta:', number],
      ['Data', 'Lançamento', 'Valor'], ['02/10/2026', 'PIX Mercado', -10],
    ] });
    const first = parseWorkbook(account('11111-1'), 'extrato.xls').transactions[0];
    const second = parseWorkbook(account('22222-2'), 'extrato.xls').transactions[0];
    expect(first.account).toContain('0001/11111-1');
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(parseWorkbook(account('11111-1'), 'outro-nome.xls').transactions[0].fingerprint).toBe(first.fingerprint);
  });

  it('rounds numeric half-cent values with the shared decimal money conversion', () => {
    const result = parseWorkbook(workbook({ Extrato: [
      ['Data', 'Lançamento', 'Valor'], ['02/10/2026', 'Ajuste', 1.005],
    ] }), 'extrato.xlsx');
    expect(result.transactions[0].amountCents).toBe(101);
  });

  it('treats automatic investment principal as transfers while keeping actual yield as income', () => {
    const result = parseWorkbook(workbook({ Extrato: [
      ['Data', 'Lançamento', 'Valor'],
      ['02/10/2026', 'APLIC AUT MAIS', -200],
      ['03/10/2026', 'RES APLIC AUT MAIS', 100],
      ['03/10/2026', 'REND PAGO APLIC AUT MAIS', 0.01],
    ] }), 'extrato.xlsx');
    expect(result.transactions.map(t => t.kind)).toEqual(['transfer', 'transfer', 'income']);
  });

  it('places installments in invoice month and handles payment and refund separately', () => {
    const result = parseWorkbook(workbook({ 'Fatura 10-26': cardRows() }), 'cartao.xlsx');
    expect(result.source).toBe('card');
    expect(result.transactions).toHaveLength(5);
    expect(result.transactions[0]).toMatchObject({ date: '2026-08-05', month: '2026-10', amountCents: -10000, installment: '2/3', kind: 'expense' });
    expect(result.transactions[3]).toMatchObject({ amountCents: 2000, kind: 'expense' });
    expect(result.transactions[4]).toMatchObject({ amountCents: 50000, kind: 'transfer' });
    expect(result.transactions.every(t => t.category === '' && t.description === '')).toBe(true);
    expect(result.warnings.some(w => w.includes('difere do total'))).toBe(false);
    expect(result.warnings.some(w => w.includes('está aberta'))).toBe(true);
  });

  it('honors an explicit invoice month and reports mismatch', () => {
    const result = parseWorkbook(workbook({ Fatura: cardRows() }), 'fatura.xlsx', { cardMonth: '2026-11' });
    expect(result.transactions.every(t => t.month === '2026-11')).toBe(true);
    expect(result.warnings.some(w => w.includes('difere da fatura'))).toBe(true);
  });

  it('extracts competence from the textual invoice heading without a due date', () => {
    const rows = cardRows();
    rows.splice(1, 2);
    const result = parseWorkbook(workbook({ Fatura: rows }), 'sem-mes.xlsx');
    expect(result.transactions[0].month).toBe('2026-10');
  });

  it('does not guess an invoice month when unavailable', () => {
    const rows = cardRows().slice(3);
    expect(() => parseWorkbook(workbook({ Compras: rows }), 'compras.xlsx')).toThrow('competência');
    expect(() => parseWorkbook(workbook({ Compras: rows }), 'compras.xlsx', { cardMonth: '2026-13' })).toThrow('inválida');
  });

  it('retains identical legitimate purchases but creates stable identities across renamed files', () => {
    const input = workbook({ Fatura: cardRows() });
    const first = parseWorkbook(input, 'fatura.xlsx');
    const second = parseWorkbook(input, 'copia-renomeada.xlsx');
    expect(first.transactions.map(t => t.fingerprint)).toEqual(second.transactions.map(t => t.fingerprint));
    expect(first.transactions.map(t => t.id)).toEqual(second.transactions.map(t => t.id));
    expect(new Set(first.transactions.map(t => t.fingerprint)).size).toBe(5);
    expect(first.transactions[1].fingerprint).not.toBe(first.transactions[2].fingerprint);
  });

  it('recognizes Número and keeps physical/virtual card identities distinct', () => {
    const result = parseWorkbook(workbook({ Fatura: [
      ['Fatura Outubro/2026'], ['Data', 'Lançamento', 'Parcelamento', 'Valor', 'Número'],
      ['03/10/2026', 'Loja exemplo', null, 100, '****0001'],
      ['03/10/2026', 'Loja exemplo', null, 100, '****0002'],
    ] }), 'cartao.xlsx');
    expect(result.transactions.map(t => t.account)).toEqual(['Cartão Itaú ****0001', 'Cartão Itaú ****0002']);
    expect(result.transactions[0].fingerprint).not.toBe(result.transactions[1].fingerprint);
  });

  it.each(['xlsx', 'xls'] as const)('reads %s bytes through the public file API', async bookType => {
    const buffer = XLSX.write(workbook({ Fatura: cardRows() }), { type: 'array', bookType }) as ArrayBuffer;
    const result = await parseImport({ name: `fatura.${bookType}`, arrayBuffer: async () => buffer });
    expect(result.transactions).toHaveLength(5);
    expect(result.transactions[0].date).toBe('2026-08-05');
  });

  it('rejects an unrelated workbook with an actionable error', () => {
    expect(() => parseWorkbook(workbook({ Outros: [['Texto'], ['Exemplo']] }), 'outros.xlsx')).toThrow('Formato não reconhecido');
  });
});

describe('Budget migration', () => {
  function budget(): XLSX.WorkBook {
    const input = workbook({
      Abril: [['Data', 'Nome', 'Saída', 'Categoria'], [new Date('2026-04-02T00:00:00Z'), 'Mercado', 50, 'Mercado']],
      Maio: [['Finanças'], ['Dia', 'Nome', 'Saída', 'Categoria'], ['03', 'Almoço', 30, 'Restaurante'], ['05', 'Aporte', 100, 'Investimentos'], ['06', 'Viagem trabalho', 80, 'Trabalho']],
      Setembro: [['Finanças'], ['Dia', 'Lançamento', 'Descrição', 'Saída', 'Categoria'], [4, 'PIX Exemplo', 'Aluguel', 200, 'Despesas fixas']],
      'Orçamento médio prazo': [
        ['Despesas', new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z')],
        ['Aluguel', null, 200, 210],
        ['Itaucard', 0, 100, 0],
        ['Aporte mínimo reserva', null, 50, 50],
        ['Total', 0, 350, 260],
        ['Resultado', new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z')],
        ['Despesas', null, 350, 260],
        ['Receita', null, 1000, 1000],
        ['Reserva', null, 500, 1200],
        ['Resultado Mensal', 0, 650, 740],
        ['Indicadores'],
        ['PMS', null, 0.1, 0.2],
      ],
    });
    input.Sheets['Orçamento médio prazo'].D9.f = 'C9+C10+C4';
    input.Sheets['Orçamento médio prazo'].B9 = { t: 'e', v: 23, f: '#REF!' };
    return input;
  }

  it('migrates all monthly layouts and preserves category/description', () => {
    const result = parseWorkbook(budget(), 'budget-2026.xlsx');
    expect(result.source).toBe('budget');
    expect(result.transactions).toHaveLength(5);
    expect(result.transactions.map(t => t.date)).toEqual(['2026-04-02', '2026-05-03', '2026-05-05', '2026-05-06', '2026-09-04']);
    expect(result.transactions.at(-1)).toMatchObject({ description: 'Aluguel', category: 'Despesas fixas', amountCents: -20000 });
    expect(result.transactions[2].kind).toBe('transfer');
    expect(result.transactions[3].category).toBe('Trabalho');
    expect(result.snapshots.find(s => s.month === '2026-05')?.expenseCents).toBe(11000);
  });

  it('migrates explicit inputs, contribution targets, and initial reserve instead of cached formulas', () => {
    const result = parseWorkbook(budget(), 'budget-2026.xlsx');
    expect(result.planItems).toHaveLength(4);
    expect(result.planItems.find(p => p.name === 'Aluguel')).toMatchObject({ amounts: { '2026-10': 20000, '2026-11': 21000 }, defaultAmountCents: 21000 });
    expect(result.planItems.find(p => p.name === 'Aporte mínimo reserva')?.kind).toBe('contribution');
    expect(result.suggestedSettings).toMatchObject({ initialReserveCents: 50000, reserveStartMonth: '2026-10', horizonMonths: 2 });
    expect(result.warnings.some(w => w.includes('referências quebradas'))).toBe(true);
  });

  it('requires a reference year for day-only history when no year is available', () => {
    const input = workbook({ Maio: [['Dia', 'Nome', 'Saída', 'Categoria'], [3, 'Mercado', 10, 'Mercado']] });
    expect(() => parseWorkbook(input, 'historico.xlsx')).toThrow('ano de referência');
    expect(parseWorkbook(input, 'historico.xlsx', { referenceYear: 2024 }).transactions[0].date).toBe('2024-05-03');
    expect(parseWorkbook(input, 'budget-2026.xlsx').transactions[0].date).toBe('2026-05-03');
  });

  it('preserves the budget sheet competence when the original date falls in another month', () => {
    const source = workbook({ Abril: [
      ['Data', 'Nome', 'Saída', 'Categoria'],
      [new Date('2026-03-31T00:00:00Z'), 'Compra exemplo', 12.34, 'Mercado'],
      [new Date('2026-04-02T00:00:00Z'), 'Outra compra', 10, 'Mercado'],
    ] });
    const result = parseWorkbook(source, 'budget-2026.xlsx');
    expect(result.transactions[0]).toMatchObject({ date: '2026-03-31', month: '2026-04', amountCents: -1234 });
    expect(result.transactions.every(transaction => transaction.month === '2026-04')).toBe(true);
    expect(result.snapshots[0]).toMatchObject({ month: '2026-04', expenseCents: 2234, categories: { Mercado: 2234 } });
  });
});
