import { describe, expect, it } from 'vitest';
import { addCategory, allCategoryNames, archiveCategory, assertAvailableCategory, availableCategoryNames, listCategories, normalizeCategoryData, renameCategory, restoreCategory } from '../src/lib/categories';
import { applyImport, createEmptyData, mergeFinanceData, summarizeMonth } from '../src/lib/finance';
import { serializeBackup, validateBackup } from '../src/lib/storage';
import type { FinanceData, ImportResult, Transaction } from '../src/lib/types';

const NOW = new Date('2026-10-11T15:00:00.000Z');
const LATER = new Date('2026-10-12T15:00:00.000Z');
const AFTER = new Date('2026-10-13T15:00:00.000Z');
const transaction = (id: string, category = 'Mercado'): Transaction => ({
  id, fingerprint: id, date: '2026-10-10', month: '2026-10', amountCents: -1_000,
  kind: 'expense', source: 'budget', account: 'Conta', originalDescription: id, description: id,
  category, updatedAt: NOW.toISOString(),
});
function state(): FinanceData {
  const data = addCategory(createEmptyData(NOW), 'Mercado', NOW);
  data.transactions = [transaction('expense'), transaction('empty', '')];
  data.planItems = [{ id: 'plan', name: 'Compra mensal', category: 'Mercado', kind: 'expense', defaultAmountCents: 2_000, amounts: {}, startMonth: '2026-10', updatedAt: NOW.toISOString() }];
  data.snapshots = [{ id: 'snapshot', month: '2026-10', incomeCents: 0, expenseCents: 1_000, categories: { Mercado: 1_000 }, updatedAt: NOW.toISOString() }];
  return data;
}
const imported = (transactions: Transaction[]): ImportResult => ({ source: 'budget', transactions, planItems: [], snapshots: [], warnings: [] });

describe('catálogo de categorias', () => {
  it('migra categorias de todas as fontes antigas sem criar opções genéricas', () => {
    const legacy: any = state();
    delete legacy.categories;
    legacy.planItems[0].category = 'Moradia';
    legacy.snapshots[0].categories = { Saúde: 1_000 };
    const restored = validateBackup(JSON.stringify(legacy));
    expect(allCategoryNames(restored)).toEqual(['Mercado', 'Moradia', 'Saúde']);
    expect(restored.transactions[1].category).toBe('');
    expect(listCategories(restored)).toEqual(listCategories(validateBackup(legacy)));
    expect(createEmptyData(NOW).categories).toEqual([]);
    expect(availableCategoryNames(restored)).not.toContain('Sem categoria');
  });

  it('limpa espaços, registra categoria vazia de uso e rejeita nomes vazios/duplicados', () => {
    const original = createEmptyData(NOW);
    const next = addCategory(original, '  Viagens   e lazer  ', NOW);
    expect(allCategoryNames(next)).toEqual(['Viagens e lazer']);
    expect(original.categories).toEqual([]);
    expect(() => addCategory(next, 'VIAGENS E LAZER', LATER)).toThrow('Já existe');
    expect(() => addCategory(next, '   ', LATER)).toThrow('nome de categoria');
    expect(() => addCategory(next, 'x'.repeat(501), LATER)).toThrow();
    expect(validateBackup(serializeBackup(next)).categories).toEqual(next.categories);
  });

  it('renomeia todos os registros e snapshots sem alterar os centavos ou tombstones', () => {
    const original = state();
    original.transactions[0].deletedAt = NOW.toISOString();
    const renamed = renameCategory(original, original.categories[0].id, 'Supermercado', LATER);
    expect(renamed.categories[0]).toMatchObject({ id: original.categories[0].id, name: 'Supermercado', aliases: ['Mercado'], updatedAt: LATER.toISOString() });
    expect(renamed.transactions[0]).toMatchObject({ category: 'Supermercado', amountCents: -1_000, deletedAt: NOW.toISOString(), updatedAt: LATER.toISOString() });
    expect(renamed.planItems[0]).toMatchObject({ category: 'Supermercado', defaultAmountCents: 2_000 });
    expect(renamed.snapshots[0].categories).toEqual({ Supermercado: 1_000 });
    expect(renamed.transactions[1].category).toBe('');
    expect(original.transactions[0].category).toBe('Mercado');
    expect(() => addCategory(renamed, 'Mercado', AFTER)).toThrow();
    const conflicting = addCategory(renamed, 'Moradia', AFTER);
    expect(() => renameCategory(conflicting, original.categories[0].id, 'MORADIA', AFTER)).toThrow();
  });

  it('soma aliases em snapshots com chaves especiais sem poluir objetos', () => {
    let data = state();
    data = renameCategory(data, data.categories[0].id, '__proto__', LATER);
    expect(Object.getPrototypeOf(data.snapshots[0].categories)).toBe(Object.prototype);
    expect(Object.hasOwn(data.snapshots[0].categories, '__proto__')).toBe(true);
    expect(data.snapshots[0].categories.__proto__).toBe(1_000);
    const snapshot = JSON.parse('{"Mercado":700,"__proto__":300}');
    data.snapshots[0].categories = snapshot;
    expect(normalizeCategoryData(data, false).snapshots[0].categories.__proto__).toBe(1_000);
    data.snapshots[0].categories = JSON.parse('{"Mercado":9007199254740991,"__proto__":1}');
    expect(() => normalizeCategoryData(data, false)).toThrow('intervalo monetário');
  });

  it('arquiva a opção, preserva histórico e restaura para novas atribuições', () => {
    const original = state();
    const archived = archiveCategory(original, original.categories[0].id, LATER);
    expect(availableCategoryNames(archived)).toEqual([]);
    expect(allCategoryNames(archived)).toEqual(['Mercado']);
    expect(archived.transactions).toEqual(original.transactions);
    expect(archived.planItems).toEqual(original.planItems);
    expect(archived.snapshots).toEqual(original.snapshots);
    expect(summarizeMonth(archived, '2026-10', 'budget').categories.Mercado).toBe(1_000);
    expect(() => addCategory(archived, 'mercado', AFTER)).toThrow('arquivada');
    expect(() => assertAvailableCategory(archived, 'Mercado')).toThrow('disponível');
    const restored = restoreCategory(archived, original.categories[0].id, AFTER);
    expect(availableCategoryNames(restored)).toEqual(['Mercado']);
    expect(restored.categories[0].archivedAt).toBeUndefined();
    expect(restored.categories[0].updatedAt).toBe(AFTER.toISOString());
    expect(() => assertAvailableCategory(restored, 'Mercado')).not.toThrow();
  });

  it('só permite atribuir uma opção existente exata ou deixar sem categoria', () => {
    const data = state();
    expect(() => assertAvailableCategory(data, '')).not.toThrow();
    expect(() => assertAvailableCategory(data, 'Mercado')).not.toThrow();
    for (const name of ['Nova categoria', 'mercado', ' Mercado ', '   ']) expect(() => assertAvailableCategory(data, name)).toThrow();
  });

  it('valida catálogo e associação dos backups atuais antes de salvar', () => {
    const data: any = state();
    data.categories.push({ ...data.categories[0], id: 'other', name: 'MERCADO' });
    expect(() => validateBackup(data)).toThrow('duplicados');
    data.categories.pop();
    data.transactions[0].category = 'Inventada';
    expect(() => validateBackup(data)).toThrow('não cadastrada');
    data.transactions[0].category = 'Mercado';
    data.categories[0].archivedAt = 'ontem';
    expect(() => validateBackup(data)).toThrow();
    data.categories[0].archivedAt = LATER.toISOString();
    expect(validateBackup(data).transactions[0].category).toBe('Mercado');
  });

  it('reimporta rótulos antigos usando aliases sem reviver categoria arquivada', () => {
    let data = state();
    data = renameCategory(data, data.categories[0].id, 'Supermercado', LATER);
    data = archiveCategory(data, data.categories[0].id, AFTER);
    const next = applyImport(data, imported([transaction('expense'), transaction('new')]), 'budget.xlsx', AFTER);
    expect(next.categories).toHaveLength(1);
    expect(next.categories[0].archivedAt).toBe(AFTER.toISOString());
    expect(next.transactions.find(item => item.id === 'new')?.category).toBe('Supermercado');
    expect(next.imports[0].count).toBe(1);
    expect(availableCategoryNames(next)).toEqual([]);
    const additional = applyImport(next, imported([transaction('health', 'Saúde')]), 'new.xlsx', AFTER);
    expect(availableCategoryNames(additional)).toEqual(['Saúde']);
    expect(additional.categories.find(category => category.name === 'Saúde')?.updatedAt).toBe(AFTER.toISOString());
  });

  it('une adições, renomes e arquivo sem apagar catálogo ou reviver cópia antiga', () => {
    const initial = state();
    let local = renameCategory(initial, initial.categories[0].id, 'Supermercado', LATER);
    local = archiveCategory(local, local.categories[0].id, AFTER);
    local = addCategory(local, 'Saúde', AFTER);
    const legacy: any = state();
    delete legacy.categories;
    legacy.updatedAt = '2026-10-30T00:00:00.000Z';
    legacy.transactions.push({ ...transaction('legacy-new'), updatedAt: legacy.updatedAt });
    const remote = addCategory(validateBackup(legacy), 'Moradia', AFTER);
    const merged = mergeFinanceData(local, remote);
    expect(allCategoryNames(merged)).toEqual(['Moradia', 'Saúde', 'Supermercado']);
    expect(availableCategoryNames(merged)).toEqual(['Moradia', 'Saúde']);
    expect(merged.transactions.filter(item => item.category)).toHaveLength(2);
    expect(merged.transactions.filter(item => item.category).every(item => item.category === 'Supermercado')).toBe(true);
    expect(mergeFinanceData(merged, merged)).toEqual(merged);
    expect(mergeFinanceData(remote, local)).toEqual({ ...merged, settings: { ...merged.settings, googleClientId: remote.settings.googleClientId } });
    expect(validateBackup(serializeBackup(merged)).categories).toEqual(merged.categories);
  });

  it('converge renomes concorrentes preservando ambos os nomes como aliases', () => {
    const initial = state();
    const left = renameCategory(initial, initial.categories[0].id, 'Compras', LATER);
    const right = renameCategory(initial, initial.categories[0].id, 'Supermercado', LATER);
    const merged = mergeFinanceData(left, right);
    expect(merged.categories).toHaveLength(1);
    expect(merged.categories[0].name).toBe('Supermercado');
    expect(merged.categories[0].aliases).toEqual(['Compras', 'Mercado']);
    expect(mergeFinanceData(right, left)).toEqual(merged);
    expect(mergeFinanceData(merged, left)).toEqual(merged);
  });

  it('arquivo vence empate de timestamp e uma restauração posterior prevalece', () => {
    const data = state();
    const archived = archiveCategory(data, data.categories[0].id, LATER);
    const active = structuredClone(data);
    active.categories[0].updatedAt = LATER.toISOString();
    expect(mergeFinanceData(active, archived).categories[0].archivedAt).toBe(LATER.toISOString());
    const restored = restoreCategory(archived, data.categories[0].id, AFTER);
    expect(mergeFinanceData(archived, restored).categories[0].archivedAt).toBeUndefined();
  });
});
