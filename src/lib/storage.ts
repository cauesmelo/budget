import { createStore, get, set } from 'idb-keyval';
import { addMonths, isValidDate, isValidMonth } from './finance';
import { DATABASE_NAME, LEGACY_DATABASE_NAME } from './identity';
import type { BudgetSnapshot, FinanceData, ImportBatch, PlanItem, Settings, Transaction, TransactionKind, TransactionSource } from './types';

const DATA_KEY = 'finance-data-v1';
let financeStore: ReturnType<typeof createStore> | undefined;
let legacyFinanceStore: ReturnType<typeof createStore> | undefined;
function store() {
  if (typeof indexedDB === 'undefined') throw new Error('Este navegador não disponibilizou o armazenamento local. Exporte um backup antes de fechar.');
  return financeStore ??= createStore(DATABASE_NAME, 'dados');
}

export async function loadData(): Promise<FinanceData | null> {
  const data = await get<unknown>(DATA_KEY, store());
  if (data !== undefined) return validateBackup(data);
  const legacy = await get<unknown>(DATA_KEY, legacyFinanceStore ??= createStore(LEGACY_DATABASE_NAME, 'dados'));
  if (legacy === undefined) return null;
  const migrated = validateBackup(legacy);
  await set(DATA_KEY, migrated, store());
  return migrated;
}

export async function saveData(data: FinanceData): Promise<void> {
  await set(DATA_KEY, validateBackup(data), store());
}

/** Um backup contém dados financeiros privados. Credenciais/configuração local ficam fora. */
export function serializeBackup(data: FinanceData): string {
  const safe = validateBackup(data);
  safe.settings.googleClientId = '';
  return JSON.stringify(safe, null, 2);
}

export const exportBackup = serializeBackup;
export const loadFinanceData = loadData;
export const saveFinanceData = saveData;

type JsonObject = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`Backup inválido: ${path} ${message}.`);
}

function object(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'deve ser um objeto');
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail(path, 'deve conter somente dados JSON');
  return value as JsonObject;
}

function string(value: unknown, path: string, allowEmpty = true, maxLength = 20_000): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength) fail(path, 'deve ser um texto válido');
  return value as string;
}

function integer(value: unknown, path: string, minimum = -Number.MAX_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(path, 'deve ser um inteiro dentro do intervalo permitido');
  return value as number;
}

function month(value: unknown, path: string): string {
  if (!isValidMonth(value)) fail(path, 'deve ser um mês real no formato AAAA-MM');
  return value;
}

function date(value: unknown, path: string): string {
  if (!isValidDate(value)) fail(path, 'deve ser uma data real no formato AAAA-MM-DD');
  return value;
}

function timestamp(value: unknown, path: string): string {
  const text = string(value, path, false, 40);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(text) || !isValidDate(text.slice(0, 10)) || !Number.isFinite(Date.parse(text))) fail(path, 'deve ser uma data e hora ISO válida');
  return text;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path, `deve ser ${allowed.join(', ')}`);
  return value as T;
}

function moneyMap(value: unknown, path: string, isMonthMap = false, nonnegative = false): Record<string, number> {
  const entries = Object.entries(object(value, path));
  if (entries.length > 12_000) fail(path, 'contém entradas demais');
  const result: Record<string, number> = {};
  for (const [key, amount] of entries) {
    if (isMonthMap) month(key, `${path}.${key}`);
    else string(key, `${path}.categoria`, false, 500);
    Object.defineProperty(result, key, { value: integer(amount, `${path}.${key}`, nonnegative ? 0 : -Number.MAX_SAFE_INTEGER), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function recordBase(source: JsonObject, path: string): { id: string; updatedAt: string; deletedAt?: string } {
  return {
    id: string(source.id, `${path}.id`, false, 1_000),
    updatedAt: timestamp(source.updatedAt, `${path}.updatedAt`),
    ...(source.deletedAt !== undefined ? { deletedAt: timestamp(source.deletedAt, `${path}.deletedAt`) } : {}),
  };
}

function transaction(value: unknown, path: string): Transaction {
  const source = object(value, path);
  const installment = optionalString(source.installment, `${path}.installment`);
  const importId = optionalString(source.importId, `${path}.importId`);
  const sourceFile = optionalString(source.sourceFile, `${path}.sourceFile`);
  return {
    ...recordBase(source, path),
    fingerprint: string(source.fingerprint, `${path}.fingerprint`, false, 4_000),
    date: date(source.date, `${path}.date`),
    month: month(source.month, `${path}.month`),
    amountCents: integer(source.amountCents, `${path}.amountCents`),
    kind: oneOf<TransactionKind>(source.kind, ['income', 'expense', 'transfer'], `${path}.kind`),
    source: oneOf<TransactionSource>(source.source, ['bank', 'card', 'budget', 'manual'], `${path}.source`),
    account: string(source.account, `${path}.account`),
    originalDescription: string(source.originalDescription, `${path}.originalDescription`),
    description: string(source.description, `${path}.description`),
    category: string(source.category, `${path}.category`, true, 500),
    ...(installment !== undefined ? { installment } : {}),
    ...(importId !== undefined ? { importId } : {}),
    ...(sourceFile !== undefined ? { sourceFile } : {}),
    ...(source.sourceRow !== undefined ? { sourceRow: integer(source.sourceRow, `${path}.sourceRow`, 1, 10_000_000) } : {}),
  };
}

function planItem(value: unknown, path: string): PlanItem {
  const source = object(value, path);
  const startMonth = month(source.startMonth, `${path}.startMonth`);
  const endMonth = source.endMonth === undefined ? undefined : month(source.endMonth, `${path}.endMonth`);
  if (endMonth && endMonth < startMonth) fail(path, 'possui fim anterior ao início');
  return {
    ...recordBase(source, path), name: string(source.name, `${path}.name`, true, 2_000),
    category: string(source.category, `${path}.category`, true, 500),
    kind: oneOf<PlanItem['kind']>(source.kind, ['income', 'expense', 'contribution'], `${path}.kind`),
    defaultAmountCents: integer(source.defaultAmountCents, `${path}.defaultAmountCents`, 0),
    amounts: moneyMap(source.amounts, `${path}.amounts`, true, true),
    startMonth, ...(endMonth !== undefined ? { endMonth } : {}),
  };
}

function snapshot(value: unknown, path: string): BudgetSnapshot {
  const source = object(value, path);
  return {
    id: string(source.id, `${path}.id`, false, 1_000),
    updatedAt: timestamp(source.updatedAt, `${path}.updatedAt`),
    month: month(source.month, `${path}.month`),
    incomeCents: integer(source.incomeCents, `${path}.incomeCents`),
    expenseCents: integer(source.expenseCents, `${path}.expenseCents`),
    categories: moneyMap(source.categories, `${path}.categories`),
  };
}

function importBatch(value: unknown, path: string): ImportBatch {
  const source = object(value, path);
  return {
    id: string(source.id, `${path}.id`, false, 1_000),
    updatedAt: timestamp(source.updatedAt, `${path}.updatedAt`),
    importedAt: timestamp(source.importedAt, `${path}.importedAt`),
    filename: string(source.filename, `${path}.filename`, true, 2_000),
    source: oneOf<TransactionSource>(source.source, ['bank', 'card', 'budget', 'manual'], `${path}.source`),
    count: integer(source.count, `${path}.count`, 0, 1_000_000),
  };
}

function settings(value: unknown): Settings {
  const source = object(value, 'settings');
  const reserveStartMonth = month(source.reserveStartMonth, 'settings.reserveStartMonth');
  const horizonMonths = integer(source.horizonMonths, 'settings.horizonMonths', 1, 600);
  try { addMonths(reserveStartMonth, horizonMonths - 1); } catch { fail('settings', 'possui horizonte fora do intervalo suportado'); }
  const monthlyReturnPercent = source.monthlyReturnPercent;
  if (typeof monthlyReturnPercent !== 'number' || !Number.isFinite(monthlyReturnPercent) || monthlyReturnPercent < -100 || monthlyReturnPercent > 100) fail('settings.monthlyReturnPercent', 'deve ser uma taxa finita entre -100 e 100');
  return {
    initialReserveCents: integer(source.initialReserveCents, 'settings.initialReserveCents'),
    reserveStartMonth,
    monthlyReturnPercent,
    reserveGoalCents: integer(source.reserveGoalCents, 'settings.reserveGoalCents', 0),
    horizonMonths,
    googleClientId: string(source.googleClientId, 'settings.googleClientId', true, 2_000),
    updatedAt: timestamp(source.updatedAt, 'settings.updatedAt'),
  };
}

function array<T extends { id: string }>(value: unknown, path: string, parse: (entry: unknown, entryPath: string) => T, maximum: number): T[] {
  if (!Array.isArray(value) || value.length > maximum) fail(path, 'deve ser uma lista dentro do limite de tamanho');
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const record = parse(entry, `${path}[${index}]`);
    if (ids.has(record.id)) fail(`${path}[${index}].id`, 'está duplicado');
    ids.add(record.id);
    return record;
  });
}

/** Valida todo o estado antes de restaurar ou consumir dados vindos da nuvem. */
export function validateBackup(payload: unknown): FinanceData {
  let data = payload;
  if (typeof payload === 'string') {
    if (payload.length > 50 * 1024 * 1024) fail('arquivo', 'excede 50 MB');
    try { data = JSON.parse(payload); } catch { fail('arquivo', 'não contém JSON válido'); }
  }
  const source = object(data, 'arquivo');
  if (source.version !== 1) throw new Error('Versão de backup não suportada. Esta aplicação lê somente a versão 1.');
  return {
    version: 1,
    transactions: array(source.transactions, 'transactions', transaction, 200_000),
    planItems: array(source.planItems, 'planItems', planItem, 10_000),
    snapshots: array(source.snapshots, 'snapshots', snapshot, 12_000),
    imports: array(source.imports, 'imports', importBatch, 20_000),
    settings: settings(source.settings),
    updatedAt: timestamp(source.updatedAt, 'updatedAt'),
  };
}
