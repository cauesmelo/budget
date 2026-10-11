import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyData } from '../src/lib/finance';
import { loadData, saveData, serializeBackup, validateBackup } from '../src/lib/storage';
import type { FinanceData } from '../src/lib/types';

const memory = vi.hoisted(() => new Map<string, unknown>());
vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => ({})),
  get: vi.fn(async (key: string) => memory.get(key)),
  set: vi.fn(async (key: string, value: unknown) => { memory.set(key, structuredClone(value)); }),
}));

const NOW = new Date('2026-10-11T15:00:00.000Z');
function fixture(): FinanceData {
  const data = createEmptyData(NOW);
  data.transactions = [{ id: 'purchase', fingerprint: 'purchase-occurrence-1', date: '2026-10-10', month: '2026-10', amountCents: -12_345, kind: 'expense', source: 'card', account: 'Cartão', originalDescription: 'Loja', description: 'Compra', category: '', sourceRow: 1, updatedAt: NOW.toISOString() }];
  data.planItems = [{ id: 'plan', name: 'Aluguel', category: 'Moradia', kind: 'expense', defaultAmountCents: 200_000, amounts: { '2026-12': 0 }, startMonth: '2026-10', updatedAt: NOW.toISOString() }];
  return data;
}

beforeEach(() => { memory.clear(); vi.stubGlobal('indexedDB', {}); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('validação de backup', () => {
  it('aceita JSON válido com estorno e preserva centavos/zero explícito', () => {
    const data = fixture();
    data.transactions[0].amountCents = 345;
    expect(validateBackup(JSON.stringify(data))).toEqual(data);
  });

  it('exporta somente os dados financeiros e mantém configuração original local', () => {
    const data = fixture();
    data.settings.googleClientId = 'local-client-id';
    const withExtra = data as FinanceData & { token: string };
    withExtra.token = 'never-export-this';
    const backup = serializeBackup(withExtra);
    expect(backup).not.toContain('never-export-this');
    expect(backup).not.toContain('local-client-id');
    expect(validateBackup(backup).settings.googleClientId).toBe('');
    expect(data.settings.googleClientId).toBe('local-client-id');
  });

  it.each([
    ['versão desconhecida', (data: any) => { data.version = 2; }],
    ['centavos fracionários', (data: any) => { data.transactions[0].amountCents = 1.5; }],
    ['centavos NaN', (data: any) => { data.transactions[0].amountCents = NaN; }],
    ['centavos inseguros', (data: any) => { data.transactions[0].amountCents = Number.MAX_SAFE_INTEGER + 1; }],
    ['dia inexistente', (data: any) => { data.transactions[0].date = '2026-02-30'; }],
    ['mês inexistente', (data: any) => { data.transactions[0].month = '2026-13'; }],
    ['timestamp impossível', (data: any) => { data.transactions[0].updatedAt = '2026-02-30T00:00:00.000Z'; }],
    ['taxa infinita', (data: any) => { data.settings.monthlyReturnPercent = Infinity; }],
    ['horizonte fracionário', (data: any) => { data.settings.horizonMonths = 1.5; }],
    ['horizonte vazio', (data: any) => { data.settings.horizonMonths = 0; }],
    ['mês da recorrência inválido', (data: any) => { data.planItems[0].amounts = { '2026-99': 100 }; }],
    ['planejamento negativo', (data: any) => { data.planItems[0].defaultAmountCents = -1; }],
    ['intervalo invertido', (data: any) => { data.planItems[0].endMonth = '2026-09'; }],
    ['id duplicado', (data: any) => { data.transactions.push({ ...data.transactions[0] }); }],
    ['objeto no lugar de lista', (data: any) => { data.transactions = {}; }],
    ['descrição ausente', (data: any) => { delete data.transactions[0].description; }],
    ['fonte inválida', (data: any) => { data.transactions[0].source = 'other'; }],
    ['linha inválida', (data: any) => { data.transactions[0].sourceRow = -1; }],
    ['timestamp exclusão inválido', (data: any) => { data.transactions[0].deletedAt = 'ontem'; }],
  ])('recusa %s antes de restaurar', (_name, modify) => {
    const data = fixture();
    modify(data);
    expect(() => validateBackup(data)).toThrow();
  });

  it.each(['{', 'null', '[]', '"texto"'])('recusa JSON estruturalmente inválido %s', payload => {
    expect(() => validateBackup(payload)).toThrow();
  });

  it('aceita dia bissexto real e contribuição informativa', () => {
    const data = fixture();
    data.transactions[0].date = '2024-02-29';
    data.planItems[0].kind = 'contribution';
    expect(validateBackup(data).planItems[0].kind).toBe('contribution');
    data.transactions[0].date = '2025-02-29';
    expect(() => validateBackup(data)).toThrow();
  });
});

describe('persistência local', () => {
  it('carrega instalação vazia e salva/carrega todo o estado incluindo tombstone', async () => {
    expect(await loadData()).toBeNull();
    const data = fixture();
    data.transactions[0].deletedAt = NOW.toISOString();
    await saveData(data);
    expect(await loadData()).toEqual(data);
  });

  it('não substitui dados bons quando um salvamento inválido falha', async () => {
    const data = fixture();
    await saveData(data);
    const invalid = structuredClone(data);
    invalid.transactions[0].amountCents = Infinity;
    await expect(saveData(invalid)).rejects.toThrow();
    expect(await loadData()).toEqual(data);
  });

  it('explica quando o navegador não oferece IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(loadData()).rejects.toThrow('armazenamento local');
  });
});
