import type { Category, FinanceData, PlanItem } from './types';

// Categories discovered in older backups must not replace a current edit.
const LEGACY_CLOCK = '1970-01-01T00:00:00.000Z';
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
export const categoryNameKey = (name: string): string => name.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');

function cleanName(name: string): string {
  const cleaned = name.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > 500) throw new Error('Enter a category name between 1 and 500 characters.');
  return cleaned;
}

function categoryId(name: string): string {
  let hash = 14695981039346656037n;
  for (const character of categoryNameKey(name)) {
    hash ^= BigInt(character.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return `category-${hash.toString(16).padStart(16, '0')}`;
}

function clock(category: Category): number {
  return Math.max(Date.parse(category.updatedAt), category.archivedAt ? Date.parse(category.archivedAt) : -Infinity);
}

function compareCategory(left: Category, right: Category): number {
  const difference = clock(left) - clock(right);
  if (difference) return difference;
  if (Boolean(left.archivedAt) !== Boolean(right.archivedAt)) return left.archivedAt ? 1 : -1;
  return compareText(JSON.stringify([left.name, left.archivedAt ?? '', left.id]), JSON.stringify([right.name, right.archivedAt ?? '', right.id]));
}

function labels(category: Category): string[] {
  return [category.name, ...(category.aliases ?? [])];
}

/** Merges changes by ID and previous names, including identical additions on two devices. */
export function mergeCategoryCatalog(local: Category[], remote: Category[]): Category[] {
  const groups: Category[][] = [];
  for (const record of [...local, ...remote]) {
    const keys = new Set(labels(record).map(categoryNameKey));
    const matching = groups.filter(group => group.some(item => item.id === record.id || labels(item).some(name => keys.has(categoryNameKey(name)))));
    const group = [structuredClone(record), ...matching.flat()];
    for (const previous of matching) groups.splice(groups.indexOf(previous), 1);
    groups.push(group);
  }
  return groups.map(group => {
    const winner = [...group].sort(compareCategory).at(-1)!;
    const { aliases: _aliases, ...current } = winner;
    const names = new Map<string, string>();
    for (const name of group.flatMap(labels).sort(compareText)) {
      if (categoryNameKey(name) !== categoryNameKey(winner.name)) names.set(categoryNameKey(name), name);
    }
    return {
      ...current,
      id: group.map(record => record.id).sort(compareText)[0],
      ...(names.size ? { aliases: [...names.values()].sort(compareText) } : {}),
    };
  }).sort((left, right) => compareText(left.id, right.id));
}

function lookup(catalog: Category[]): Map<string, Category> {
  const result = new Map<string, Category>();
  for (const category of catalog) for (const name of labels(category)) result.set(categoryNameKey(name), category);
  return result;
}

function referencedNames(data: FinanceData): string[] {
  return [...data.transactions.map(item => item.category), ...data.planItems.map(item => item.category), ...data.snapshots.flatMap(item => Object.keys(item.categories))].filter(name => name.trim());
}

/** Migrates legacy labels and keeps every record linked to the current category name. */
export function normalizeCategoryData(data: FinanceData, adoptUnknown = true, importedAt = LEGACY_CLOCK): FinanceData {
  const next = structuredClone(data);
  next.categories = mergeCategoryCatalog(next.categories ?? [], []);
  const byName = lookup(next.categories);
  for (const name of referencedNames(next).sort(compareText)) {
    const key = categoryNameKey(name);
    if (byName.has(key)) continue;
    if (!adoptUnknown) throw new Error(`Unknown category: ${name}. Manage categories before using this name.`);
    const category: Category = { id: categoryId(name), name: cleanName(name), updatedAt: importedAt };
    next.categories.push(category);
    byName.set(key, category);
  }
  next.categories.sort((left, right) => compareText(left.id, right.id));
  for (const item of [...next.transactions, ...next.planItems]) item.category = item.category.trim() ? byName.get(categoryNameKey(item.category))!.name : '';
  for (const snapshot of next.snapshots) {
    const amounts: Record<string, number> = {};
    for (const [name, value] of Object.entries(snapshot.categories)) {
      const currentName = byName.get(categoryNameKey(name))!.name;
      const amount = (Object.hasOwn(amounts, currentName) ? amounts[currentName] : 0) + value;
      if (!Number.isSafeInteger(amount)) throw new Error('The category total exceeds the supported monetary range.');
      Object.defineProperty(amounts, currentName, { value: amount, enumerable: true, writable: true, configurable: true });
    }
    snapshot.categories = amounts;
  }
  return next;
}

export function listCategories(data: FinanceData): Category[] {
  return [...(data.categories ?? normalizeCategoryData(data).categories)].sort((left, right) => left.name.localeCompare(right.name, 'pt-BR') || compareText(left.id, right.id));
}
export const availableCategoryNames = (data: FinanceData): string[] => listCategories(data).filter(category => !category.archivedAt).map(category => category.name);
export const allCategoryNames = (data: FinanceData): string[] => listCategories(data).map(category => category.name);

export function assertAvailableCategory(data: FinanceData, name: string): void {
  if (name === '') return;
  if (!listCategories(data).some(category => category.name === name && !category.archivedAt)) throw new Error('Select an available category or leave it uncategorized.');
}

function editTime(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid date.');
  return now.toISOString();
}

function assertUnique(catalog: Category[], name: string, exceptId?: string): void {
  const existing = catalog.find(category => category.id !== exceptId && labels(category).some(label => categoryNameKey(label) === categoryNameKey(name)));
  if (existing) throw new Error(existing.archivedAt ? 'This category already exists and is archived. Restore it to use it again.' : 'A category already exists with this name or a previous name.');
}

export function addCategory(data: FinanceData, name: string, now = new Date()): FinanceData {
  const next = normalizeCategoryData(data);
  const cleaned = cleanName(name);
  assertUnique(next.categories, cleaned);
  const updatedAt = editTime(now);
  next.categories.push({ id: categoryId(cleaned), name: cleaned, updatedAt });
  next.updatedAt = updatedAt;
  return next;
}

export function renameCategory(data: FinanceData, id: string, newName: string, now = new Date()): FinanceData {
  const next = normalizeCategoryData(data);
  const category = next.categories.find(item => item.id === id);
  if (!category) throw new Error('Category not found.');
  const cleaned = cleanName(newName);
  assertUnique(next.categories, cleaned, id);
  if (category.name === cleaned) return next;
  const updatedAt = editTime(now);
  category.aliases = [...new Set([...(category.aliases ?? []), category.name])].filter(name => categoryNameKey(name) !== categoryNameKey(cleaned));
  category.name = cleaned;
  category.updatedAt = updatedAt;
  const normalized = normalizeCategoryData(next, false);
  for (let index = 0; index < normalized.transactions.length; index++) if (normalized.transactions[index].category !== data.transactions[index].category) normalized.transactions[index].updatedAt = updatedAt;
  for (let index = 0; index < normalized.planItems.length; index++) if (normalized.planItems[index].category !== data.planItems[index].category) normalized.planItems[index].updatedAt = updatedAt;
  for (let index = 0; index < normalized.snapshots.length; index++) if (JSON.stringify(normalized.snapshots[index].categories) !== JSON.stringify(data.snapshots[index].categories)) normalized.snapshots[index].updatedAt = updatedAt;
  normalized.updatedAt = updatedAt;
  return normalized;
}

export function archiveCategory(data: FinanceData, id: string, now = new Date()): FinanceData {
  const next = normalizeCategoryData(data);
  const category = next.categories.find(item => item.id === id);
  if (!category) throw new Error('Category not found.');
  if (category.archivedAt) return next;
  category.updatedAt = category.archivedAt = editTime(now);
  next.updatedAt = category.updatedAt;
  return next;
}

export function restoreCategory(data: FinanceData, id: string, now = new Date()): FinanceData {
  const next = normalizeCategoryData(data);
  const category = next.categories.find(item => item.id === id);
  if (!category) throw new Error('Category not found.');
  if (!category.archivedAt) return next;
  delete category.archivedAt;
  category.updatedAt = editTime(now);
  next.updatedAt = category.updatedAt;
  return next;
}

export interface FutureCategoryConfiguration {
  fromMonth: string;
  activeNames: string[];
  assignments: Record<string, string>;
}

function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5));
  if (number > 1) return `${month.slice(0, 4)}-${String(number - 1).padStart(2, '0')}`;
  if (year === 1) throw new Error('The category boundary is outside the supported range.');
  return `${String(year - 1).padStart(4, '0')}-12`;
}

function futurePlanId(id: string, month: string): string {
  let hash = 14695981039346656037n;
  for (const character of JSON.stringify([id, month])) {
    hash ^= BigInt(character.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return `future-plan-${hash.toString(16).padStart(16, '0')}`;
}

/** Restricts future choices and assignments without renaming historical categories. */
export function configureFutureCategories(data: FinanceData, configuration: FutureCategoryConfiguration, now = new Date()): FinanceData {
  const { fromMonth } = configuration;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(fromMonth) || Number(fromMonth.slice(0, 4)) < 1) throw new Error('Invalid category boundary. Use YYYY-MM.');
  const updatedAt = editTime(now);
  const activeNames = configuration.activeNames.map(cleanName);
  const activeKeys = new Set(activeNames.map(categoryNameKey));
  if (activeKeys.size !== activeNames.length) throw new Error('Future categories must have unique names.');
  const active = new Set(activeNames);
  const catalog = lookup(data.categories);
  for (const name of activeNames) {
    const existing = catalog.get(categoryNameKey(name));
    if (existing && existing.name !== name) throw new Error(`The category ${name} conflicts with an existing name or alias. Renaming it would change history.`);
  }
  const assignments = new Map<string, string>();
  for (const [source, target] of Object.entries(configuration.assignments)) {
    const key = categoryNameKey(cleanName(source));
    if (target !== '' && !active.has(target)) throw new Error('Category assignments must use an exact future category name or an empty value.');
    if (assignments.has(key) && assignments.get(key) !== target) throw new Error('Category assignments contain conflicting source names.');
    assignments.set(key, target);
  }
  const futureName = (name: string): string => active.has(name) ? name : assignments.get(categoryNameKey(name)) ?? '';
  const next = structuredClone(data);
  let changed = false;
  for (const category of next.categories) {
    if (active.has(category.name)) {
      if (category.archivedAt) {
        delete category.archivedAt;
        category.updatedAt = updatedAt;
        changed = true;
      }
    } else if (!category.archivedAt) {
      category.archivedAt = category.updatedAt = updatedAt;
      changed = true;
    }
  }
  for (const name of activeNames) if (!catalog.has(categoryNameKey(name))) {
    next.categories.push({ id: categoryId(name), name, updatedAt });
    changed = true;
  }
  for (const item of next.transactions) {
    if (item.deletedAt || item.month < fromMonth) continue;
    const category = futureName(item.category);
    if (category !== item.category) {
      item.category = category;
      item.updatedAt = updatedAt;
      changed = true;
    }
  }
  const futurePieces: PlanItem[] = [];
  const planIds = new Set(next.planItems.map(item => item.id));
  for (const item of next.planItems) {
    if (item.deletedAt || (item.endMonth && item.endMonth < fromMonth)) continue;
    const category = futureName(item.category);
    if (category === item.category) continue;
    if (item.startMonth >= fromMonth) {
      item.category = category;
      item.updatedAt = updatedAt;
    } else {
      const id = futurePlanId(item.id, fromMonth);
      if (planIds.has(id)) throw new Error('A future planning record with this identity already exists.');
      const futurePiece: PlanItem = { ...item, id, sourcePlanId: item.id, category, startMonth: fromMonth, amounts: {}, updatedAt };
      const historicalAmounts: Record<string, number> = {};
      for (const [month, amount] of Object.entries(item.amounts)) {
        if (month < fromMonth) historicalAmounts[month] = amount;
        else futurePiece.amounts[month] = amount;
      }
      item.amounts = historicalAmounts;
      item.endMonth = previousMonth(fromMonth);
      item.updatedAt = updatedAt;
      futurePieces.push(futurePiece);
      planIds.add(id);
    }
    changed = true;
  }
  next.planItems.push(...futurePieces);
  for (const snapshot of next.snapshots) {
    if (snapshot.month < fromMonth) continue;
    const amounts: Record<string, number> = {};
    for (const [name, value] of Object.entries(snapshot.categories)) {
      const target = futureName(name) || futureName('Uncategorized') || 'Uncategorized';
      if (target === 'Uncategorized' && !next.categories.some(category => category.name === target)) {
        const conflict = catalog.get(categoryNameKey(target));
        if (conflict) throw new Error('The uncategorized snapshot label conflicts with an existing name or alias.');
        next.categories.push({ id: categoryId(target), name: target, updatedAt, archivedAt: updatedAt });
        changed = true;
      }
      const amount = (Object.hasOwn(amounts, target) ? amounts[target] : 0) + value;
      if (!Number.isSafeInteger(amount)) throw new Error('The category total exceeds the supported monetary range.');
      Object.defineProperty(amounts, target, { value: amount, enumerable: true, writable: true, configurable: true });
    }
    const originalEntries = Object.entries(snapshot.categories);
    if (originalEntries.length !== Object.keys(amounts).length || originalEntries.some(([name, value]) => !Object.hasOwn(amounts, name) || amounts[name] !== value)) {
      snapshot.categories = amounts;
      snapshot.updatedAt = updatedAt;
      changed = true;
    }
  }
  if (!changed) return data;
  next.updatedAt = updatedAt;
  return next;
}
