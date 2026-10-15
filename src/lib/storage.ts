import { createStore, get, set } from 'idb-keyval';
import { addMonths, isValidDate, isValidMonth, projectReserve, reconcilePlanSegments, sanitizeFinanceData } from './finance';
import { DATABASE_NAME, LEGACY_DATABASE_NAME } from './identity';
import { categoryNameKey, normalizeCategoryData } from './categories';
import type { Category, FinanceData, ImportBatch, InstallmentSchedule, PlanItem, PlanningConfiguration, Settings, ReportingConfiguration, Transaction, TransactionKind, TransactionScope, TransactionSource, WorkConfiguration } from './types';

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
    source: oneOf<TransactionSource>(source.source, ['bank', 'card', 'manual'], `${path}.source`),
    account: string(source.account, `${path}.account`),
    originalDescription: string(source.originalDescription, `${path}.originalDescription`),
    description: string(source.description, `${path}.description`),
    category: string(source.category, `${path}.category`, true, 500),
    ...(source.scope !== undefined ? { scope: oneOf<TransactionScope>(source.scope, ['personal', 'work'], `${path}.scope`) } : {}),
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
  const kind = oneOf<PlanItem['kind']>(source.kind, ['income', 'expense', 'contribution'], `${path}.kind`);
  const behavior = source.behavior === undefined ? undefined : oneOf<NonNullable<PlanItem['behavior']>>(source.behavior, ['fixed', 'monthly', 'installments'], `${path}.behavior`);
  if (behavior === 'installments' && kind !== 'expense') fail(`${path}.behavior`, 'supports expenses only');
  const installments = source.installments === undefined ? undefined : array(source.installments, `${path}.installments`, installmentSchedule, 1_000);
  const sourceKeys = new Set<string>();
  for (const schedule of installments ?? []) {
    if (!schedule.sourceKey) continue;
    if (sourceKeys.has(schedule.sourceKey)) fail(`${path}.installments`, 'contains duplicate source identities');
    sourceKeys.add(schedule.sourceKey);
  }
  return {
    ...recordBase(source, path), name: string(source.name, `${path}.name`, true, 2_000),
    ...(source.sourcePlanId !== undefined ? { sourcePlanId: string(source.sourcePlanId, `${path}.sourcePlanId`, false, 1_000) } : {}),
    category: string(source.category, `${path}.category`, true, 500),
    kind,
    ...(behavior !== undefined ? { behavior } : {}),
    ...(installments !== undefined ? { installments } : {}),
    defaultAmountCents: integer(source.defaultAmountCents, `${path}.defaultAmountCents`, 0),
    amounts: moneyMap(source.amounts, `${path}.amounts`, true, true),
    startMonth, ...(endMonth !== undefined ? { endMonth } : {}),
  };
}

function installmentSchedule(value: unknown, path: string): InstallmentSchedule {
  const source = object(value, path);
  const firstMonth = month(source.firstMonth, `${path}.firstMonth`);
  const count = integer(source.count, `${path}.count`, 1, 600);
  try { addMonths(firstMonth, count - 1); } catch { fail(path, 'has payments outside the supported date range'); }
  return {
    id: string(source.id, `${path}.id`, false, 1_000),
    name: string(source.name, `${path}.name`, true, 2_000),
    amountCents: integer(source.amountCents, `${path}.amountCents`, 1),
    firstMonth,
    count,
    ...(source.sourceKey !== undefined ? { sourceKey: string(source.sourceKey, `${path}.sourceKey`, false, 4_000) } : {}),
  };
}

function planning(value: unknown): PlanningConfiguration {
  const source = object(value, 'planning');
  const pmrMonths = integer(source.pmrMonths, 'planning.pmrMonths', 12, 20);
  if (pmrMonths !== 12 && pmrMonths !== 20) fail('planning.pmrMonths', 'must be 12 or 20 months');
  const annualNetReturnPercent = source.annualNetReturnPercent;
  if (annualNetReturnPercent !== undefined && (typeof annualNetReturnPercent !== 'number' || !Number.isFinite(annualNetReturnPercent) || annualNetReturnPercent < 0 || annualNetReturnPercent > 100)) fail('planning.annualNetReturnPercent', 'must be a finite rate between 0 and 100');
  return {
    pmrMonths,
    ...(source.age !== undefined ? { age: integer(source.age, 'planning.age', 1, 120) } : {}),
    ...(annualNetReturnPercent !== undefined ? { annualNetReturnPercent: annualNetReturnPercent as number } : {}),
    updatedAt: timestamp(source.updatedAt, 'planning.updatedAt'),
  };
}

function importBatch(value: unknown, path: string): ImportBatch {
  const source = object(value, path);
  return {
    id: string(source.id, `${path}.id`, false, 1_000),
    updatedAt: timestamp(source.updatedAt, `${path}.updatedAt`),
    importedAt: timestamp(source.importedAt, `${path}.importedAt`),
    filename: string(source.filename, `${path}.filename`, true, 2_000),
    source: oneOf<TransactionSource>(source.source, ['bank', 'card', 'manual'], `${path}.source`),
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

function reporting(value: unknown): ReportingConfiguration {
  const source = object(value, 'reporting');
  return {
    startMonth: month(source.startMonth, 'reporting.startMonth'),
    resetId: string(source.resetId, 'reporting.resetId', false, 1_000),
    updatedAt: timestamp(source.updatedAt, 'reporting.updatedAt'),
  };
}

function work(value: unknown): WorkConfiguration {
  const source = object(value, 'work');
  const label = string(source.label, 'work.label', false, 120);
  if (label !== label.normalize('NFC').trim().replace(/\s+/g, ' ') || /[\u0000-\u001f\u007f]/.test(label)) fail('work.label', 'must contain a readable name without excess whitespace');
  if (!Array.isArray(source.expenseCategories) || source.expenseCategories.length > 1_000) fail('work.expenseCategories', 'must be a list of up to 1000 category names');
  const keys = new Set<string>();
  const expenseCategories = source.expenseCategories.map((entry, index) => {
    const path = `work.expenseCategories[${index}]`;
    const name = string(entry, path, false, 500);
    if (name !== name.normalize('NFC').trim().replace(/\s+/g, ' ') || /[\u0000-\u001f\u007f]/.test(name)) fail(path, 'must contain a readable category name without excess whitespace');
    const key = categoryNameKey(name);
    if (keys.has(key)) fail('work.expenseCategories', 'contains duplicate category names');
    keys.add(key);
    return name;
  });
  return { label, expenseCategories, updatedAt: timestamp(source.updatedAt, 'work.updatedAt') };
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

/** Retired workbook entries are ignored before validating the supported transaction format. */
function currentRecords(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(path, 'must be a list within the size limit');
  return value.filter(entry => !(entry && typeof entry === 'object' && !Array.isArray(entry) && entry.source === 'budget'));
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
    transactions: array(currentRecords(source.transactions, 'transactions', 200_000), 'transactions', transaction, 200_000),
    planItems: array(source.planItems, 'planItems', planItem, 10_000),
    imports: array(currentRecords(source.imports, 'imports', 20_000), 'imports', importBatch, 20_000),
    settings: settings(source.settings),
    ...(source.reporting !== undefined ? { reporting: reporting(source.reporting) } : {}),
    ...(source.work !== undefined ? { work: work(source.work) } : {}),
    ...(source.planning !== undefined ? { planning: planning(source.planning) } : {}),
    updatedAt: timestamp(source.updatedAt, 'updatedAt'),
  };
  const installmentOwners = new Map<string, string>();
  parsed.planItems.forEach((item, itemIndex) => {
    if (item.deletedAt || item.behavior !== 'installments') return;
    item.installments?.forEach((schedule, scheduleIndex) => {
      if (!schedule.sourceKey) return;
      if (installmentOwners.has(schedule.sourceKey)) fail(`planItems[${itemIndex}].installments[${scheduleIndex}].sourceKey`, 'is already planned in another active installment row');
      installmentOwners.set(schedule.sourceKey, item.id);
    });
  });
  try { parsed.planItems = reconcilePlanSegments(parsed.planItems); }
  catch (error) { fail('planItems', error instanceof Error ? error.message.replace(/\.$/, '') : 'contains an invalid segment'); }
  let normalized: FinanceData;
  try { normalized = normalizeCategoryData(sanitizeFinanceData(parsed), source.categories === undefined); }
  catch (error) { fail('categories', error instanceof Error ? error.message.replace(/\.$/, '') : 'contains an invalid category'); }
  try { projectReserve(normalized); }
  catch (error) { fail('projection', error instanceof Error ? error.message.replace(/\.$/, '') : 'exceeds the supported range'); }
  return normalized;
}
