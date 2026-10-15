import type { FinanceData, ImportResult, MonthSummary, PlanItem, ProjectionMonth, Transaction, TransactionScope } from './types';
import { categoryNameKey, mergeCategoryCatalog, normalizeCategoryData } from './categories';

const MONEY_FORMAT = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const MONTH_FORMAT = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Amounts use integer cents; transaction signs follow cash flow. */
export function formatMoney(cents: number): string {
  return MONEY_FORMAT.format(cents / 100);
}

export function isValidMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) > 0;
}

export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isValidMonth(value.slice(0, 7))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function formatMonth(month: string): string {
  if (!isValidMonth(month)) throw new Error('Invalid month. Use YYYY-MM.');
  return MONTH_FORMAT.format(new Date(`${month}-01T12:00:00.000Z`));
}

export function addMonths(month: string, count: number): string {
  if (!isValidMonth(month) || !Number.isInteger(count)) throw new Error('Invalid month or interval.');
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1 + count;
  const year = Math.floor(index / 12);
  const monthNumber = ((index % 12) + 12) % 12 + 1;
  if (year < 1 || year > 9999) throw new Error('Month is outside the supported range.');
  return `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`;
}

export function createEmptyData(now = new Date()): FinanceData {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid date.');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const month = `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}`;
  const updatedAt = now.toISOString();
  return {
    version: 1, categories: [], transactions: [], planItems: [], imports: [],
    settings: {
      initialReserveCents: 0, reserveStartMonth: month, monthlyReturnPercent: 0,
      reserveGoalCents: 0, horizonMonths: 24, googleClientId: '', updatedAt,
    },
    updatedAt,
  };
}

/** Accepts spreadsheet numbers and Brazilian currency text, including credits and refunds. */
export function parseMoneyToCents(value: unknown): number {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid monetary amount.');
    // Explicit decimal conversion avoids binary rounding of 1.005 * 100.
    return decimalToCents(value.toFixed(10), false);
  }
  if (typeof value !== 'string') throw new Error('Invalid monetary amount.');
  let text = value.trim();
  if (!text || /^[-–—]$/.test(text)) return 0;
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1).trim(); }
  const direction = text.match(/\s*(D|C|DR|CR)\s*$/i);
  if (direction) {
    negative = negative || /^(D|DR)$/i.test(direction[1]);
    text = text.slice(0, direction.index).trim();
  }
  text = text.replace(/(?:R\$|BRL)/gi, '').replace(/[\s\u00a0\u202f']/g, '');
  if (text.endsWith('-')) { negative = true; text = text.slice(0, -1); }
  if (text.startsWith('-')) { negative = true; text = text.slice(1); }
  else if (text.startsWith('+')) text = text.slice(1);
  if (!/^\d+(?:[.,]\d+)*$/.test(text)) throw new Error(`Invalid monetary amount: ${value}`);

  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimalMark = comma > dot ? ',' : '.';
    const groupMark = decimalMark === ',' ? '.' : ',';
    const [whole, fraction, ...extra] = text.split(decimalMark);
    if (extra.length || !validGroupedInteger(whole, groupMark)) throw new Error(`Invalid monetary amount: ${value}`);
    text = `${whole.split(groupMark).join('')}.${fraction}`;
  } else if (comma >= 0) {
    const groups = text.split(',');
    if (groups.length > 2) {
      if (!validGroupedInteger(text, ',')) throw new Error(`Invalid monetary amount: ${value}`);
      text = groups.join('');
    } else text = text.replace(',', '.');
  } else if (dot >= 0) {
    const groups = text.split('.');
    const isThousands = groups.length > 2 || (groups[0].length <= 3 && groups[1].length === 3);
    if (isThousands) {
      if (!validGroupedInteger(text, '.')) throw new Error(`Invalid monetary amount: ${value}`);
      text = groups.join('');
    }
  }
  return decimalToCents(text, negative);
}

function validGroupedInteger(text: string, separator: string): boolean {
  const groups = text.split(separator);
  return /^\d+$/.test(groups[0]) && (groups.length === 1 || (groups[0].length <= 3 && groups.slice(1).every(group => /^\d{3}$/.test(group))));
}

function decimalToCents(text: string, negative: boolean): number {
  if (text.startsWith('-')) { negative = true; text = text.slice(1); }
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Monetary amount is outside the supported range.');
  const [whole, decimal = ''] = text.split('.');
  let cents = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0').slice(0, 2));
  if ((decimal[2] ?? '0') >= '5') cents += 1n;
  if (negative) cents = -cents;
  const result = Number(cents);
  if (!Number.isSafeInteger(result)) throw new Error('Monetary amount is outside the supported range.');
  return result;
}

function workCategoryKeys(data: FinanceData): Set<string> {
  const keys = new Set(data.work?.expenseCategories.map(categoryNameKey) ?? []);
  for (const category of data.categories) {
    const labels = [category.name, ...(category.aliases ?? [])].map(categoryNameKey);
    if (labels.some(label => keys.has(label))) for (const label of labels) keys.add(label);
  }
  return keys;
}

/** Expense rules never classify salary or another income as a reimbursement. */
export function getTransactionScope(data: FinanceData, transaction: Transaction): TransactionScope {
  if (transaction.scope !== undefined) return transaction.scope;
  return transaction.kind === 'expense' && workCategoryKeys(data).has(categoryNameKey(transaction.category)) ? 'work' : 'personal';
}

export function summarizeMonth(data: FinanceData, month: string): MonthSummary {
  if (!isValidMonth(month)) throw new Error('Invalid month.');
  const transactions = data.transactions.filter(item => isReportableTransaction(data, item) && item.month === month && !item.deletedAt && item.kind !== 'transfer');
  const workCategories = workCategoryKeys(data);
  let incomeCents = 0;
  let expenseCents = 0;
  let workInCents = 0;
  let workOutCents = 0;
  let count = 0;
  const categories: Record<string, number> = {};
  for (const transaction of transactions) {
    const scope = transaction.scope ?? (transaction.kind === 'expense' && workCategories.has(categoryNameKey(transaction.category)) ? 'work' : 'personal');
    if (scope === 'work') {
      if (transaction.amountCents >= 0) workInCents += transaction.amountCents;
      else workOutCents -= transaction.amountCents;
      continue;
    }
    count++;
    if (transaction.kind === 'income') incomeCents += transaction.amountCents;
    else {
      const amount = -transaction.amountCents;
      expenseCents += amount;
      const category = transaction.category.trim() || 'Uncategorized';
      Object.defineProperty(categories, category, { value: (Object.hasOwn(categories, category) ? categories[category] : 0) + amount, enumerable: true, writable: true, configurable: true });
    }
  }
  return { month, incomeCents, expenseCents, netCents: incomeCents - expenseCents, categories, count, workInCents, workOutCents, workNetCents: workInCents - workOutCents };
}

/** Statement reporting months determine eligibility, including older card purchases billed later. */
export function isReportableTransaction(data: Pick<FinanceData, 'reporting'>, transaction: Transaction): boolean {
  return ['bank', 'card', 'manual'].includes(transaction.source) && (!data.reporting || transaction.month >= data.reporting.startMonth);
}

/** Drops retired workbook data before it can populate reporting or category catalogs. */
export function sanitizeFinanceData(data: FinanceData, startMonth = data.reporting?.startMonth): FinanceData {
  const eligible = (item: Transaction) => ['bank', 'card', 'manual'].includes(item.source) && (startMonth === undefined || item.month >= startMonth);
  const transactions = data.transactions.filter(eligible);
  const removedImportIds = new Set(data.transactions.filter(item => !eligible(item)).map(item => item.importId).filter(Boolean));
  const importCounts = new Map<string, number>();
  for (const item of transactions) if (item.importId) importCounts.set(item.importId, (importCounts.get(item.importId) ?? 0) + 1);
  const imports = data.imports.filter(item => ['bank', 'card', 'manual'].includes(item.source) && (!removedImportIds.has(item.id) || importCounts.has(item.id)))
    .map(item => removedImportIds.has(item.id) ? { ...item, count: importCounts.get(item.id)! } : item);
  return {
    version: 1, categories: structuredClone(data.categories), transactions: structuredClone(transactions),
    planItems: structuredClone(data.planItems), imports: structuredClone(imports), settings: { ...data.settings },
    ...(data.reporting ? { reporting: { ...data.reporting } } : {}),
    ...(data.work ? { work: structuredClone(data.work) } : {}), updatedAt: data.updatedAt,
  };
}

/** Within the active interval, an explicit monthly amount overrides the recurring amount. */
export function planAmountForMonth(item: PlanItem, month: string): number {
  if (item.deletedAt) return 0;
  if (month < item.startMonth || (item.endMonth && month > item.endMonth)) return 0;
  if (Object.hasOwn(item.amounts, month)) return item.amounts[month];
  return item.defaultAmountCents;
}

export function projectReserve(data: FinanceData): ProjectionMonth[] {
  const { reserveStartMonth, horizonMonths, monthlyReturnPercent, initialReserveCents } = data.settings;
  if (!isValidMonth(reserveStartMonth) || !Number.isInteger(horizonMonths) || horizonMonths < 1 || horizonMonths > 600 || !Number.isFinite(monthlyReturnPercent)) throw new Error('Invalid projection settings.');
  const rows: ProjectionMonth[] = [];
  let openingCents = initialReserveCents;
  for (let index = 0; index < horizonMonths; index++) {
    const month = addMonths(reserveStartMonth, index);
    let incomeCents = 0;
    let expenseCents = 0;
    for (const item of data.planItems) {
      const amount = planAmountForMonth(item, month);
      if (item.kind === 'income') incomeCents += amount;
      else if (item.kind === 'expense') expenseCents += amount;
    }
    // Returns apply only to the opening balance; the monthly surplus enters the closing balance.
    const returnCents = roundCents(openingCents * monthlyReturnPercent / 100);
    const netCents = incomeCents - expenseCents;
    const closingCents = openingCents + netCents + returnCents;
    if (![incomeCents, expenseCents, returnCents, closingCents].every(Number.isSafeInteger)) throw new Error('The projection exceeds the supported monetary range.');
    rows.push({ month, openingCents, incomeCents, expenseCents, returnCents, netCents, closingCents });
    openingCents = closingCents;
  }
  return rows;
}

function roundCents(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value) + Number.EPSILON * Math.abs(value));
}

function recordClock(item: { updatedAt: string; deletedAt?: string }): number {
  return Math.max(Date.parse(item.updatedAt), item.deletedAt ? Date.parse(item.deletedAt) : -Infinity);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => lexicalCompare(a, b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRecords<T extends { updatedAt: string; deletedAt?: string }>(a: T, b: T): number {
  const clockDifference = recordClock(a) - recordClock(b);
  if (clockDifference !== 0) return clockDifference;
  // When timestamps tie, a deleted record takes precedence over an active copy.
  if (Boolean(a.deletedAt) !== Boolean(b.deletedAt)) return a.deletedAt ? 1 : -1;
  return lexicalCompare(canonical(a), canonical(b));
}

function mergeRecords<T extends { id: string; updatedAt: string; deletedAt?: string }>(local: T[], remote: T[]): T[] {
  const byId = new Map<string, T>();
  for (const record of [...local, ...remote]) {
    const previous = byId.get(record.id);
    if (!previous || compareRecords(record, previous) > 0) byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) => lexicalCompare(a.id, b.id));
}

/** Segment boundaries survive edits from an older device that still has an unsplit plan. */
export function reconcilePlanSegments(items: PlanItem[]): PlanItem[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const roots = new Map<string, string>();
  for (const item of items) {
    const chain = new Set<string>();
    let current: PlanItem | undefined = item;
    let root = item.id;
    while (current) {
      const knownRoot = roots.get(current.id);
      if (knownRoot !== undefined) { root = knownRoot; break; }
      if (chain.has(current.id)) throw new Error('Planning segments contain a cycle.');
      chain.add(current.id);
      if (current.sourcePlanId === undefined) { root = current.id; break; }
      if (current.sourcePlanId === current.id) throw new Error('A planning segment cannot reference itself.');
      const source = byId.get(current.sourcePlanId);
      if (!source) throw new Error('A planning segment references an unknown source.');
      current = source;
    }
    for (const id of chain) roots.set(id, root);
  }
  const families = new Map<string, PlanItem[]>();
  for (const item of items) {
    if (item.sourcePlanId !== undefined && item.startMonth <= byId.get(item.sourcePlanId)!.startMonth) throw new Error('A future planning segment must start after its source.');
    const root = roots.get(item.id)!;
    const family = families.get(root) ?? [];
    family.push(item);
    families.set(root, family);
  }
  const boundaries = new Map<string, string>();
  for (const family of families.values()) {
    family.sort((left, right) => lexicalCompare(left.startMonth, right.startMonth) || lexicalCompare(left.id, right.id));
    for (let index = 0; index < family.length - 1; index++) {
      if (family[index].startMonth === family[index + 1].startMonth) throw new Error('Planning segments contain conflicting boundaries.');
      boundaries.set(family[index].id, family[index + 1].startMonth);
    }
  }
  return items.map(item => {
    const boundary = boundaries.get(item.id);
    if (!boundary) return item;
    const endMonth = addMonths(boundary, -1);
    if (item.endMonth && item.endMonth <= endMonth) return item;
    // Keep amounts outside the effective interval so a stale edit loses no input values.
    return { ...item, endMonth };
  });
}

function mergePlanItems(local: PlanItem[], remote: PlanItem[]): PlanItem[] {
  const sources = new Map<string, string>();
  for (const item of [...local, ...remote]) {
    if (item.sourcePlanId === undefined) continue;
    const known = sources.get(item.id);
    if (known && known !== item.sourcePlanId) throw new Error('Planning segments contain conflicting source identities.');
    sources.set(item.id, item.sourcePlanId);
  }
  const merged = mergeRecords(local, remote).map(item => {
    const sourcePlanId = sources.get(item.id);
    return sourcePlanId !== undefined && item.sourcePlanId !== sourcePlanId ? { ...item, sourcePlanId } : item;
  });
  return reconcilePlanSegments(merged);
}

export function mergeFinanceData(local: FinanceData, remote: FinanceData): FinanceData {
  if (local.version !== 1 || remote.version !== 1) throw new Error('Unsupported data version.');
  const reporting = local.reporting === undefined ? remote.reporting : remote.reporting === undefined ? local.reporting :
    compareRecords(local.reporting, remote.reporting) >= 0 ? local.reporting : remote.reporting;
  local = normalizeCategoryData(sanitizeFinanceData(local, reporting?.startMonth));
  remote = normalizeCategoryData(sanitizeFinanceData(remote, reporting?.startMonth));
  const sameEpoch = local.reporting?.resetId === remote.reporting?.resetId;
  const epochData = sameEpoch ? undefined : local.reporting?.resetId === reporting?.resetId ? local : remote;
  const localSettings = { ...local.settings, googleClientId: '' };
  const remoteSettings = { ...remote.settings, googleClientId: '' };
  const pristineLocal = local.reporting === undefined && local.work === undefined && local.categories.length === 0 && local.transactions.length === 0 && local.planItems.length === 0 && local.imports.length === 0 &&
    local.settings.initialReserveCents === 0 && local.settings.reserveGoalCents === 0 && local.settings.monthlyReturnPercent === 0 && local.settings.horizonMonths === 24;
  // The creation timestamp in a new browser is not a financial edit.
  const remoteHasSavedState = remote.reporting !== undefined || remote.work !== undefined || remote.categories.length > 0 || remote.transactions.length > 0 || remote.planItems.length > 0 || remote.imports.length > 0 ||
    remote.settings.initialReserveCents !== 0 || remote.settings.reserveGoalCents !== 0 || remote.settings.monthlyReturnPercent !== 0 || remote.settings.horizonMonths !== 24 ||
    remote.settings.reserveStartMonth !== local.settings.reserveStartMonth;
  const settings = epochData?.settings ?? (pristineLocal && remoteHasSavedState ? remote.settings : compareRecords(localSettings, remoteSettings) >= 0 ? local.settings : remote.settings);
  const work = local.work === undefined ? remote.work : remote.work === undefined ? local.work :
    compareRecords(local.work, remote.work) >= 0 ? local.work : remote.work;
  const merged: FinanceData = {
    version: 1,
    categories: mergeCategoryCatalog(local.categories, remote.categories),
    transactions: epochData ? structuredClone(epochData.transactions) : mergeRecords(local.transactions, remote.transactions),
    planItems: epochData ? structuredClone(epochData.planItems) : mergePlanItems(local.planItems, remote.planItems),
    imports: epochData ? structuredClone(epochData.imports) : mergeRecords(local.imports, remote.imports),
    settings: { ...settings, googleClientId: local.settings.googleClientId },
    ...(reporting !== undefined ? { reporting: structuredClone(reporting) } : {}),
    ...(work !== undefined ? { work: structuredClone(work) } : {}),
    updatedAt: Date.parse(local.updatedAt) >= Date.parse(remote.updatedAt) ? local.updatedAt : remote.updatedAt,
  };
  return normalizeCategoryData(sanitizeFinanceData(merged), false);
}

function transactionExists(transaction: Transaction, ids: Set<string>, fingerprints: Set<string>): boolean {
  return ids.has(transaction.id) || fingerprints.has(transaction.fingerprint);
}

export function previewDuplicateCount(data: FinanceData, result: ImportResult): number {
  const transactions = data.transactions.filter(item => isReportableTransaction(data, item));
  const ids = new Set(transactions.map(item => item.id));
  const fingerprints = new Set(transactions.map(item => item.fingerprint));
  let duplicates = 0;
  for (const transaction of result.transactions.filter(item => isReportableTransaction(data, item))) {
    if (transactionExists(transaction, ids, fingerprints)) duplicates++;
    ids.add(transaction.id);
    fingerprints.add(transaction.fingerprint);
  }
  return duplicates;
}

/** Imports eligible statement transactions without replacing edits or deletions. */
export function applyImport(data: FinanceData, result: ImportResult, filename: string, now = new Date()): FinanceData {
  const next = normalizeCategoryData(sanitizeFinanceData(data));
  const eligible = result.transactions.filter(item => isReportableTransaction(next, item));
  if (!['bank', 'card', 'manual'].includes(result.source) || eligible.length === 0) return next;
  const updatedAt = now.toISOString();
  const importId = crypto.randomUUID();
  const ids = new Set(next.transactions.map(item => item.id));
  const fingerprints = new Set(next.transactions.map(item => item.fingerprint));
  let count = 0;
  for (const transaction of eligible) {
    if (transactionExists(transaction, ids, fingerprints)) continue;
    next.transactions.push({ ...structuredClone(transaction), importId, sourceFile: filename, updatedAt });
    ids.add(transaction.id);
    fingerprints.add(transaction.fingerprint);
    count++;
  }
  next.imports.push({ id: importId, filename, source: result.source, count, importedAt: updatedAt, updatedAt });
  next.updatedAt = updatedAt;
  return normalizeCategoryData(next, true, updatedAt);
}
