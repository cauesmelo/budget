import { describe, expect, it } from 'vitest';
import { addMonths, applyImport, createEmptyData, formatMoney, formatMonth, mergeFinanceData, parseMoneyToCents, planAmountForMonth, previewDuplicateCount, projectReserve, summarizeMonth } from '../src/lib/finance';
import type { FinanceData, ImportResult, PlanItem, Transaction } from '../src/lib/types';

const NOW = new Date('2026-10-11T15:00:00.000Z');
const transaction = (id: string, amountCents: number, patch: Partial<Transaction> = {}): Transaction => ({
  id, fingerprint: `fingerprint-${id}`, date: '2026-10-10', month: '2026-10', amountCents,
  kind: amountCents > 0 ? 'income' : 'expense', source: 'bank', account: 'Conta',
  originalDescription: 'Descrição original', description: 'Descrição', category: 'Alimentação',
  updatedAt: NOW.toISOString(), ...patch,
});
const planItem = (id: string, kind: PlanItem['kind'], defaultAmountCents: number, patch: Partial<PlanItem> = {}): PlanItem => ({
  id, kind, name: 'Planejamento', category: '', defaultAmountCents, amounts: {}, startMonth: '2026-10',
  updatedAt: NOW.toISOString(), ...patch,
});
const result = (transactions: Transaction[] = []): ImportResult => ({ source: 'bank', transactions, planItems: [], snapshots: [], warnings: [] });

describe('datas e centavos', () => {
  it('usa o mês de São Paulo mesmo junto à virada UTC', () => {
    expect(createEmptyData(new Date('2026-10-01T00:10:00.000Z')).settings.reserveStartMonth).toBe('2026-09');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(() => addMonths('2026-13', 1)).toThrow();
    expect(formatMonth('2026-10')).toContain('2026');
    expect(formatMoney(123456)).toContain('1.234,56');
  });

  it.each([
    ['R$ 1.234,56', 123456], ['-1.234,56', -123456], ['(R$ 1.234,56)', -123456],
    ['1.234,56 D', -123456], ['1.234,56 C', 123456], ['1.234,56-', -123456],
    ['BRL 1,234.56', 123456], ['1.234.567', 123456700], ['1,234,567', 123456700],
    ['1.234', 123400], ['1234.567', 123457], ['1234,567', 123457],
    [1.005, 101], [-1.005, -101], ['0,005', 1], ['-0,005', -1],
    ['', 0], [null, 0], ['—', 0], [0, 0],
  ])('converte %s para %i centavos', (value, expected) => {
    expect(parseMoneyToCents(value)).toBe(expected);
  });

  it.each(['10/10/2026', 'dez reais', '12.34.567', '1,23,45', NaN, Infinity, 1e20, {}])('recusa valor inválido %s', value => {
    expect(() => parseMoneyToCents(value)).toThrow();
  });
});

describe('resumo mensal', () => {
  it('subtrai estorno, ignora transferência/pagamento de fatura e mantém Budget separado', () => {
    const data = createEmptyData(NOW);
    data.transactions = [
      transaction('salary', 300_000), transaction('purchase', -20_000),
      transaction('refund', 5_000, { kind: 'expense' }),
      transaction('card', -10_000, { source: 'card' }),
      transaction('payment', -10_000, { kind: 'transfer' }),
      transaction('deleted', -30_000, { deletedAt: NOW.toISOString() }),
      transaction('legacy', -100_000, { source: 'budget' }),
      transaction('othermonth', -50_000, { month: '2026-09' }),
    ];
    expect(summarizeMonth(data, '2026-10')).toEqual({
      month: '2026-10', incomeCents: 300_000, expenseCents: 25_000, netCents: 275_000,
      categories: { Alimentação: 25_000 }, count: 4,
    });
    expect(summarizeMonth(data, '2026-10', 'budget').expenseCents).toBe(100_000);
    data.snapshots.push({ id: 'snapshot', month: '2026-10', incomeCents: 250_000, expenseCents: 110_000, categories: { Geral: 110_000 }, updatedAt: NOW.toISOString() });
    expect(summarizeMonth(data, '2026-10', 'budget').netCents).toBe(150_000);
    expect(summarizeMonth(data, '2026-10', 'budget').categories).toEqual({ Alimentação: 100_000 });
    expect(summarizeMonth(data, '2026-10').expenseCents).toBe(25_000);
  });

  it('reflete categoria, tipo e exclusão de lançamentos Budget mesmo com snapshot existente', () => {
    const data = createEmptyData(NOW);
    data.snapshots = [{ id: 'budget-snapshot', month: '2026-10', incomeCents: 40_000, expenseCents: 30_000, categories: { Antiga: 30_000 }, updatedAt: NOW.toISOString() }];
    data.transactions = [transaction('budget-1', -10_000, { source: 'budget', category: 'Nova categoria' }), transaction('budget-2', -20_000, { source: 'budget', kind: 'transfer' })];
    expect(summarizeMonth(data, '2026-10', 'budget')).toEqual({ month: '2026-10', incomeCents: 40_000, expenseCents: 10_000, netCents: 30_000, categories: { 'Nova categoria': 10_000 }, count: 1 });
    data.transactions[0].deletedAt = NOW.toISOString();
    expect(summarizeMonth(data, '2026-10', 'budget').expenseCents).toBe(0);
    expect(summarizeMonth(data, '2026-10', 'budget').categories).toEqual({});
    data.transactions[1].kind = 'income';
    data.transactions[1].amountCents = 15_000;
    expect(summarizeMonth(data, '2026-10', 'budget').incomeCents).toBe(15_000);
    data.transactions[1].deletedAt = NOW.toISOString();
    expect(summarizeMonth(data, '2026-10', 'budget').incomeCents).toBe(0);
  });

  it('continua aceitando snapshot histórico quando não há lançamentos Budget no mês', () => {
    const data = createEmptyData(NOW);
    data.snapshots = [{ id: 'snapshot-only', month: '2026-10', incomeCents: 40_000, expenseCents: 30_000, categories: { Histórico: 30_000 }, updatedAt: NOW.toISOString() }];
    data.transactions = [transaction('bank-real', -99_000)];
    expect(summarizeMonth(data, '2026-10', 'budget')).toEqual({ month: '2026-10', incomeCents: 40_000, expenseCents: 30_000, netCents: 10_000, categories: { Histórico: 30_000 }, count: 0 });
  });

  it('preserva categorias vazias e nomes que coincidem com propriedades de objeto', () => {
    const data = createEmptyData(NOW);
    data.transactions = [transaction('blank', -150, { category: '' }), transaction('prototype', -250, { category: '__proto__' })];
    const summary = summarizeMonth(data, '2026-10');
    expect(summary.categories['Sem categoria']).toBe(150);
    expect(summary.categories.__proto__).toBe(250);
    expect(Object.getPrototypeOf(summary.categories)).toBe(Object.prototype);
  });
});

describe('planejamento da reserva', () => {
  it('calcula desde o mês de referência, juros da abertura e centavos inteiros', () => {
    const data = createEmptyData(NOW);
    data.settings = { ...data.settings, initialReserveCents: 100_005, reserveStartMonth: '2026-12', monthlyReturnPercent: 0.5, horizonMonths: 3 };
    data.planItems = [
      planItem('salary', 'income', 10_000),
      planItem('cost', 'expense', 2_000, { amounts: { '2027-01': 0 } }),
      planItem('temporary', 'expense', 1_000, { endMonth: '2026-12' }),
      planItem('contribution', 'contribution', 50_000),
      planItem('deleted', 'expense', 99_000, { deletedAt: NOW.toISOString() }),
    ];
    expect(projectReserve(data)).toEqual([
      { month: '2026-12', openingCents: 100_005, incomeCents: 10_000, expenseCents: 3_000, returnCents: 500, netCents: 7_000, closingCents: 107_505 },
      { month: '2027-01', openingCents: 107_505, incomeCents: 10_000, expenseCents: 0, returnCents: 538, netCents: 10_000, closingCents: 118_043 },
      { month: '2027-02', openingCents: 118_043, incomeCents: 10_000, expenseCents: 2_000, returnCents: 590, netCents: 8_000, closingCents: 126_633 },
    ]);
  });

  it('respeita os limites ativos antes do override, inclusive zero dentro do intervalo', () => {
    const item = planItem('dated', 'expense', 1_000, { startMonth: '2026-11', endMonth: '2027-01', amounts: { '2026-10': 500, '2026-12': 0, '2027-02': 700 } });
    expect(planAmountForMonth(item, '2026-09')).toBe(0);
    expect(planAmountForMonth(item, '2026-10')).toBe(0);
    expect(planAmountForMonth(item, '2026-11')).toBe(1_000);
    expect(planAmountForMonth(item, '2026-12')).toBe(0);
    expect(planAmountForMonth(item, '2027-02')).toBe(0);
  });

  it('arredonda cada mês, mantém déficit assinado e ignora lançamentos reais na previsão', () => {
    const data = createEmptyData(NOW);
    data.settings = { ...data.settings, initialReserveCents: -101, monthlyReturnPercent: 50, horizonMonths: 2 };
    data.transactions = [transaction('large-real-income', 1_000_000)];
    expect(projectReserve(data).map(item => item.closingCents)).toEqual([-152, -228]);
  });
});

describe('reimportação e sincronização', () => {
  it('reimportar preserva edições/exclusões e não perde duas compras legítimas idênticas', () => {
    const incoming = result([transaction('purchase-1', -1_000), transaction('purchase-2', -1_000)]);
    let data = applyImport(createEmptyData(NOW), incoming, 'extrato.xlsx', NOW);
    data.transactions[0].category = 'Compras';
    data.transactions[0].description = 'Edição manual';
    data.transactions[1].deletedAt = NOW.toISOString();
    expect(previewDuplicateCount(data, incoming)).toBe(2);
    const next = applyImport(data, incoming, 'outra-cópia.xlsx', NOW);
    expect(next.transactions).toHaveLength(2);
    expect(next.transactions[0].description).toBe('Edição manual');
    expect(next.transactions[1].deletedAt).toBe(NOW.toISOString());
    expect(next.imports.at(-1)?.count).toBe(0);
    expect(data.imports).toHaveLength(1);
  });

  it('ignora um fingerprint repetido dentro do arquivo e detecta mesmo lançamento com outro id', () => {
    const data = createEmptyData(NOW);
    data.transactions = [transaction('existing', -500)];
    const imported = result([transaction('new-id', -500, { fingerprint: 'fingerprint-existing' }), transaction('new', -400), transaction('new-copy', -400, { fingerprint: 'fingerprint-new' })]);
    expect(previewDuplicateCount(data, imported)).toBe(2);
    expect(applyImport(data, imported, 'arquivo.xlsx', NOW).transactions).toHaveLength(2);
  });

  it('semeia a configuração do primeiro Budget sem substituir ajustes na reimportação', () => {
    const imported = { ...result(), source: 'budget' as const, planItems: [planItem('income', 'income', 10_000)], suggestedSettings: { initialReserveCents: 80_000, googleClientId: 'remote-client' } };
    let data = createEmptyData(NOW);
    data.settings.googleClientId = 'local-client';
    data = applyImport(data, imported, 'budget.xlsx', NOW);
    expect(data.settings.initialReserveCents).toBe(80_000);
    expect(data.settings.googleClientId).toBe('local-client');
    data.settings.initialReserveCents = 100_000;
    expect(applyImport(data, imported, 'budget.xlsx', NOW).settings.initialReserveCents).toBe(100_000);
  });

  it('faz união por id, preserva exclusão mais recente e mantém o cliente Google local', () => {
    const local = createEmptyData(NOW);
    const remote = createEmptyData(new Date('2026-10-12T15:00:00.000Z'));
    local.transactions = [transaction('common', -1_000), transaction('local-only', -500)];
    remote.transactions = [transaction('common', -1_000, { deletedAt: remote.updatedAt, updatedAt: remote.updatedAt }), transaction('remote-only', -700)];
    local.settings.googleClientId = 'local-client';
    remote.settings = { ...remote.settings, initialReserveCents: 30_000, googleClientId: 'remote-client' };
    const merged = mergeFinanceData(local, remote);
    expect(merged.transactions).toHaveLength(3);
    expect(merged.transactions.find(item => item.id === 'common')?.deletedAt).toBe(remote.updatedAt);
    expect(merged.settings.initialReserveCents).toBe(30_000);
    expect(merged.settings.googleClientId).toBe('local-client');
    expect(summarizeMonth(merged, '2026-10').expenseCents).toBe(1_200);
    expect(local.transactions[0].deletedAt).toBeUndefined();
  });

  it('adota as configurações antigas da nuvem no primeiro acesso em um navegador vazio', () => {
    const local = createEmptyData(new Date('2026-11-01T15:00:00.000Z'));
    local.settings.googleClientId = 'cliente-deste-computador';
    const remote = createEmptyData(NOW);
    remote.settings = { ...remote.settings, initialReserveCents: 150_000, reserveGoalCents: 500_000, monthlyReturnPercent: 0.5, horizonMonths: 36 };
    remote.transactions = [transaction('saved', -1_000)];
    const merged = mergeFinanceData(local, remote);
    expect(merged.settings).toEqual({ ...remote.settings, googleClientId: 'cliente-deste-computador' });
    expect(projectReserve(merged)[0].openingCents).toBe(150_000);
    expect(projectReserve(merged)[0].month).toBe('2026-10');
    expect(merged.transactions).toHaveLength(1);
  });

  it('adota planejamento salvo contendo somente configurações, mantendo configuração local do OAuth', () => {
    const local = createEmptyData(new Date('2026-11-01T15:00:00.000Z'));
    local.settings.googleClientId = 'cliente-local';
    const remote = createEmptyData(NOW);
    remote.settings = { ...remote.settings, initialReserveCents: 250_000, horizonMonths: 12, googleClientId: 'outro-cliente' };
    expect(mergeFinanceData(local, remote).settings).toEqual({ ...remote.settings, googleClientId: 'cliente-local' });
    remote.settings = { ...remote.settings, initialReserveCents: 0, horizonMonths: 24, googleClientId: '' };
    expect(mergeFinanceData(local, remote).settings.reserveStartMonth).toBe('2026-10');
  });

  it('não deixa clientID decidir desempate de configuração financeira entre computadores', () => {
    const local = createEmptyData(NOW);
    const remote = createEmptyData(NOW);
    local.settings = { ...local.settings, horizonMonths: 12, googleClientId: 'zzzz' };
    remote.settings = { ...remote.settings, horizonMonths: 36, googleClientId: 'aaaa' };
    const left = mergeFinanceData(local, remote).settings;
    const right = mergeFinanceData(remote, local).settings;
    expect(left.horizonMonths).toBe(36);
    expect({ ...left, googleClientId: '' }).toEqual({ ...right, googleClientId: '' });
    expect(left.googleClientId).toBe('zzzz');
    expect(right.googleClientId).toBe('aaaa');
  });

  it('resolve empates de maneira estável, convergente e idempotente', () => {
    const local = createEmptyData(NOW);
    const remote = createEmptyData(NOW);
    local.transactions = [transaction('same', -100, { description: 'A' })];
    remote.transactions = [transaction('same', -100, { description: 'B' })];
    const left = mergeFinanceData(local, remote);
    const right = mergeFinanceData(remote, local);
    expect(left).toEqual(right);
    expect(mergeFinanceData(left, left)).toEqual(left);
    remote.transactions[0].deletedAt = NOW.toISOString();
    expect(mergeFinanceData(local, remote).transactions[0].deletedAt).toBe(NOW.toISOString());
  });
});
