import { createStore, get, set } from 'idb-keyval';
import { addMonths, isValidDate, isValidMonth, reconcilePlanSegments } from './finance';
import { DATABASE_NAME, LEGACY_DATABASE_NAME } from './identity';
import { categoryNameKey, normalizeCategoryData } from './categories';
import type { BudgetSnapshot, Category, FinanceData, ImportBatch, PlanItem, Settings, TrackingConfiguration, Transaction, TransactionKind, TransactionSource } from './types';

const DATA_KEY = 'finance-data-v1';
// The original Portuguese store name is required to read existing local data.
const DATA_STORE_NAME = 'dados';
let financeStore: ReturnType<typeof createStore> | undefined;
let legacyFinanceStore: ReturnType<typeof createStore> | undefined;
function store() {
  if (typeof indexedDB === 'undefined') throw new Error('Local storage is unavailable in this browser. Export a backup before closing.');
  return financeStore ??= createStore(DATABASE_NAME, DATA_STORE_NAME);
}

export async function loadData(): Promise<FinanceData | null> {
  const data = await get<unknown>(DATA_KEY, store());
  if (data !== undefined) return validateBackup(data);
  const legacy = await get<unknown>(DATA_KEY, legacyFinanceStore ??= createStore(LEGACY_DATABASE_NAME, DATA_STORE_NAME));
  if (legacy === undefined) return null;
  const migrated = validateBackup(legacy);
  await set(DATA_KEY, migrated, store());
  return migrated;
}

export async function saveData(data: FinanceData): Promise<void> {
  await set(DATA_KEY, validateBackup(data), store());
}

/** Backups contain private financial data. Credentials and local settings are excluded. */
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
  throw new Error(`Invalid backup: ${path} ${message}.`);
}

function object(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail(path, 'must contain only JSON data');
  return value as JsonObject;
}

function string(value: unknown, path: string, allowEmpty = true, maxLength = 20_000): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength) fail(path, 'must be valid text');
  return value as string;
}

function integer(value: unknown, path: string, minimum = -Number.MAX_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(path, 'must be an integer within the allowed range');
  return value as number;
}

function month(value: unknown, path: string): string {
  if (!isValidMonth(value)) fail(path, 'must be a valid month in YYYY-MM format');
  return value;
}

function date(value: unknown, path: string): string {
  if (!isValidDate(value)) fail(path, 'must be a valid date in YYYY-MM-DD format');
  return value;
}

function timestamp(value: unknown, path: string): string {
  const text = string(value, path, false, 40);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(text) || !isValidDate(text.slice(0, 10)) || !Number.isFinite(Date.parse(text))) fail(path, 'must be a valid ISO date and time');
  return text;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path, `must be ${allowed.join(', ')}`);
  return value as T;
}

function moneyMap(value: unknown, path: string, isMonthMap = false, nonnegative = false): Record<string, number> {
  const entries = Object.entries(object(value, path));
  if (entries.length > 12_000) fail(path, 'contains too many entries');
  const result: Record<string, number> = {};
  for (const [key, amount] of entries) {
    if (isMonthMap) month(key, `${path}.${key}`);
    else string(key, `${path}.category`, false, 500);
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
  if (endMonth && endMonth < startMonth) fail(path, 'has an end month before its start month');
  return {
    ...recordBase(source, path), name: string(source.name, `${path}.name`, true, 2_000),
    ...(source.sourcePlanId !== undefined ? { sourcePlanId: string(source.sourcePlanId, `${path}.sourcePlanId`, false, 1_000) } : {}),
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

function category(value: unknown, path: string): Category {
  const source = object(value, path);
  const name = string(source.name, `${path}.name`, false, 500);
  if (name !== name.normalize('NFC').trim().replace(/\s+/g, ' ')) fail(`${path}.name`, 'must not contain excess whitespace');
  let aliases: string[] | undefined;
  if (source.aliases !== undefined) {
    if (!Array.isArray(source.aliases) || source.aliases.length > 1_000) fail(`${path}.aliases`, 'must be a list of up to 1000 previous names');
    aliases = source.aliases.map((entry, index) => string(entry, `${path}.aliases[${index}]`, false, 500));
  }
  return {
    id: string(source.id, `${path}.id`, false, 1_000),
    name,
    updatedAt: timestamp(source.updatedAt, `${path}.updatedAt`),
    ...(source.archivedAt !== undefined ? { archivedAt: timestamp(source.archivedAt, `${path}.archivedAt`) } : {}),
    ...(aliases !== undefined ? { aliases } : {}),
  };
}

function settings(value: unknown): Settings {
  const source = object(value, 'settings');
  const reserveStartMonth = month(source.reserveStartMonth, 'settings.reserveStartMonth');
  const horizonMonths = integer(source.horizonMonths, 'settings.horizonMonths', 1, 600);
  try { addMonths(reserveStartMonth, horizonMonths - 1); } catch { fail('settings', 'has a horizon outside the supported range'); }
  const monthlyReturnPercent = source.monthlyReturnPercent;
  if (typeof monthlyReturnPercent !== 'number' || !Number.isFinite(monthlyReturnPercent) || monthlyReturnPercent < -100 || monthlyReturnPercent > 100) fail('settings.monthlyReturnPercent', 'must be a finite rate between -100 and 100');
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

function tracking(value: unknown): TrackingConfiguration {
  const source = object(value, 'tracking');
  const startMonth = month(source.startMonth, 'tracking.startMonth');
  if (!Array.isArray(source.legacyIncomePeriods) || source.legacyIncomePeriods.length > 600) fail('tracking.legacyIncomePeriods', 'must be a list of up to 600 historical income periods');
  const legacyIncomePeriods = source.legacyIncomePeriods.map((entry, index) => {
    const path = `tracking.legacyIncomePeriods[${index}]`;
    const period = object(entry, path);
    const periodStartMonth = period.startMonth === undefined ? undefined : month(period.startMonth, `${path}.startMonth`);
    const endMonth = month(period.endMonth, `${path}.endMonth`);
    if (periodStartMonth !== undefined && endMonth < periodStartMonth) fail(path, 'has an end month before its start month');
    if (endMonth >= startMonth) fail(path, 'must end before tracking starts');
    return {
      ...(periodStartMonth !== undefined ? { startMonth: periodStartMonth } : {}),
      endMonth,
      incomeCents: integer(period.incomeCents, `${path}.incomeCents`, 0),
    };
  });
  const ordered = [...legacyIncomePeriods].sort((left, right) => (left.startMonth ?? '').localeCompare(right.startMonth ?? ''));
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index].startMonth === undefined || ordered[index - 1].endMonth >= ordered[index].startMonth!) fail('tracking.legacyIncomePeriods', 'contains overlapping periods');
  }
  return { startMonth, legacyIncomePeriods, updatedAt: timestamp(source.updatedAt, 'tracking.updatedAt') };
}

function array<T extends { id: string }>(value: unknown, path: string, parse: (entry: unknown, entryPath: string) => T, maximum: number): T[] {
  if (!Array.isArray(value) || value.length > maximum) fail(path, 'must be a list within the size limit');
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const record = parse(entry, `${path}[${index}]`);
    if (ids.has(record.id)) fail(`${path}[${index}].id`, 'is duplicated');
    ids.add(record.id);
    return record;
  });
}

/** Validates the complete state before restoring or reading data from the cloud. */
export function validateBackup(payload: unknown): FinanceData {
  let data = payload;
  if (typeof payload === 'string') {
    if (payload.length > 50 * 1024 * 1024) fail('file', 'exceeds 50 MB');
    try { data = JSON.parse(payload); } catch { fail('file', 'does not contain valid JSON'); }
  }
  const source = object(data, 'file');
  if (source.version !== 1) throw new Error('Unsupported backup version. This app reads only version 1.');
  const categories = source.categories === undefined ? [] : array(source.categories, 'categories', category, 12_000);
  const categoryLabels = new Map<string, string>();
  for (const record of categories) {
    for (const label of [record.name, ...(record.aliases ?? [])]) {
      const key = categoryNameKey(label);
      const otherId = categoryLabels.get(key);
      if (otherId && otherId !== record.id) fail('categories', 'contains duplicate names');
      categoryLabels.set(key, record.id);
    }
  }
  const parsed: FinanceData = {
    version: 1,
    categories,
    transactions: array(source.transactions, 'transactions', transaction, 200_000),
    planItems: array(source.planItems, 'planItems', planItem, 10_000),
    snapshots: array(source.snapshots, 'snapshots', snapshot, 12_000),
    imports: array(source.imports, 'imports', importBatch, 20_000),
    settings: settings(source.settings),
    ...(source.tracking !== undefined ? { tracking: tracking(source.tracking) } : {}),
    updatedAt: timestamp(source.updatedAt, 'updatedAt'),
  };
  try { parsed.planItems = reconcilePlanSegments(parsed.planItems); }
  catch (error) { fail('planItems', error instanceof Error ? error.message.replace(/\.$/, '') : 'contains an invalid segment'); }
  try { return normalizeCategoryData(parsed, source.categories === undefined); }
  catch (error) { fail('categories', error instanceof Error ? error.message.replace(/\.$/, '') : 'contains an invalid category'); }
}
