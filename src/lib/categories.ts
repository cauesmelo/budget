import type { Category, FinanceData, PlanItem } from './types';
import { getTransactionReportingMonth } from './transactionMonth';

// Categories discovered in older backups must not replace a current edit.
const MIGRATION_CLOCK = '1970-01-01T00:00:00.000Z';
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
  return Math.max(Date.parse(category.updatedAt), category.archivedAt ? Date.parse(category.archivedAt) : -Infinity, category.deletedAt ? Date.parse(category.deletedAt) : -Infinity);
}

function compareCategory(left: Category, right: Category): number {
  // Permanent deletion must survive a later edit from a device with an older catalog.
  if (Boolean(left.deletedAt) !== Boolean(right.deletedAt)) return left.deletedAt ? 1 : -1;
  const difference = clock(left) - clock(right);
  if (difference) return difference;
  // A resolved concurrent deletion cycle must not regain its redirect on the next sync.
  if (left.deletedAt && right.deletedAt && (left.replacementCategory === undefined) !== (right.replacementCategory === undefined)) return left.replacementCategory === undefined ? 1 : -1;
  if (Boolean(left.archivedAt) !== Boolean(right.archivedAt)) return left.archivedAt ? 1 : -1;
  const tieKey = (category: Category): string => JSON.stringify([
    category.name, category.archivedAt ?? '', category.deletedAt ?? '', category.replacementCategory ?? '', category.id,
    category.replacementCategoryId ?? '', [...(category.mergedIds ?? [])].sort(compareText),
    [...(category.nameReclaims ?? [])].map(claim => [claim.name, claim.fromCategoryId]).sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b))),
  ]);
  return compareText(tieKey(left), tieKey(right));
}

function labels(category: Category): string[] {
  return [category.name, ...(category.aliases ?? [])];
}

function identities(category: Category): string[] {
  return [category.id, ...(category.mergedIds ?? [])];
}

function identityLookup(catalog: Category[]): Map<string, Category> {
  return new Map(catalog.flatMap(category => identities(category).map(id => [id, category] as const)));
}

function ownershipAncestry(catalog: Category[], canonicalIds = new Map<string, string>()): (id: string) => Set<string> {
  const canonical = (id: string): string => canonicalIds.get(id) ?? id;
  const parents = new Map<string, Set<string>>();
  for (const category of catalog) {
    const id = canonical(category.id);
    const values = parents.get(id) ?? new Set<string>();
    for (const claim of category.nameReclaims ?? []) values.add(canonical(claim.fromCategoryId));
    parents.set(id, values);
  }
  const ancestors = new Map<string, Set<string>>();
  const visit = (id: string, seen = new Set<string>()): Set<string> => {
    id = canonical(id);
    const known = ancestors.get(id);
    if (known) return known;
    const result = new Set<string>();
    if (seen.has(id)) return result;
    const visited = new Set([...seen, id]);
    for (const previous of parents.get(id) ?? []) {
      if (previous === id) continue;
      result.add(previous);
      for (const ancestor of visit(previous, visited)) if (ancestor !== id) result.add(ancestor);
    }
    ancestors.set(id, result);
    return result;
  };
  return visit;
}

function nameGeneration(category: Category, name: string, byId: Map<string, Category>, ancestry: (id: string) => Set<string>): string {
  if (!category.nameReclaims?.length) return '';
  const key = categoryNameKey(name);
  const direct = category.nameReclaims.find(claim => categoryNameKey(claim.name) === key);
  if (direct) return byId.get(direct.fromCategoryId)?.id ?? direct.fromCategoryId;
  const owners = [...ancestry(category.id)].filter(id => !ancestry(id).has(category.id) && byId.get(id) && labels(byId.get(id)!).some(label => categoryNameKey(label) === key));
  owners.sort((a, b) => ancestry(a).size - ancestry(b).size || compareText(a, b));
  return owners.at(-1) ?? '';
}

/** A reclaimed label belongs to a new generation without reviving its previous identity. */
export function getCategoryNameGeneration(category: Category, name: string, catalog: Category[]): string {
  return nameGeneration(category, name, identityLookup(catalog), ownershipAncestry(catalog));
}

function combineCategoryRecords(group: Category[], canonicalIds: Map<string, string>, catalog: Category[]): Category {
  const winner = [...group].sort(compareCategory).at(-1)!;
  const { aliases: _aliases, mergedIds: _mergedIds, nameReclaims: _nameReclaims, ...current } = winner;
  const ids = [...new Set(group.flatMap(identities))].sort(compareText);
  const names = new Map<string, string>();
  for (const name of group.flatMap(labels).sort(compareText)) {
    if (categoryNameKey(name) !== categoryNameKey(winner.name)) names.set(categoryNameKey(name), name);
  }
  const claims = new Map<string, { name: string; fromCategoryId: string }>();
  const ancestry = ownershipAncestry(catalog, canonicalIds);
  const claimRecords = group.flatMap(record => record.nameReclaims ?? []).map(claim => ({ ...claim, fromCategoryId: canonicalIds.get(claim.fromCategoryId) ?? claim.fromCategoryId }));
  claimRecords.sort((a, b) => ancestry(a.fromCategoryId).size - ancestry(b.fromCategoryId).size || compareText(a.fromCategoryId, b.fromCategoryId) || compareText(a.name, b.name));
  for (const claim of claimRecords) {
    claims.set(categoryNameKey(claim.name), { ...claim, fromCategoryId: canonicalIds.get(claim.fromCategoryId) ?? claim.fromCategoryId });
  }
  return {
    ...current,
    id: ids[0],
    ...(current.replacementCategoryId !== undefined ? { replacementCategoryId: canonicalIds.get(current.replacementCategoryId) ?? current.replacementCategoryId } : {}),
    ...(ids.length > 1 ? { mergedIds: ids.slice(1) } : {}),
    ...(names.size ? { aliases: [...names.values()].sort(compareText) } : {}),
    ...(claims.size ? { nameReclaims: [...claims.values()].sort((left, right) => compareText(categoryNameKey(left.name), categoryNameKey(right.name))) } : {}),
  };
}

/** Merges matching identities and names while keeping explicitly reused names independent. */
export function mergeCategoryCatalog(local: Category[], remote: Category[]): Category[] {
  let groups = [...local, ...remote].map(record => [structuredClone(record)]);
  const joinGroups = (keyFor: (category: Category) => string[], canJoin: (left: Category[], right: Category[]) => boolean = () => true): boolean => {
    const parent = groups.map((_, index) => index);
    const members = groups.map(group => [...group]);
    const root = (index: number): number => parent[index] === index ? index : parent[index] = root(parent[index]);
    const owners = new Map<string, number[]>();
    for (const [index, group] of groups.entries()) for (const category of group) for (const key of keyFor(category)) {
      const previous = owners.get(key) ?? [];
      for (const owner of previous) {
        const currentRoot = root(index);
        const ownerRoot = root(owner);
        if (currentRoot === ownerRoot || !canJoin(members[currentRoot], members[ownerRoot])) continue;
        parent[currentRoot] = ownerRoot;
        members[ownerRoot].push(...members[currentRoot]);
      }
      if (!previous.some(owner => root(owner) === root(index))) previous.push(index);
      owners.set(key, previous);
    }
    const joined = new Map<number, Category[]>();
    groups.forEach((group, index) => joined.set(root(index), [...(joined.get(root(index)) ?? []), ...group]));
    const changed = joined.size !== groups.length;
    groups = [...joined.values()];
    return changed;
  };
  joinGroups(category => identities(category));
  let canonicalIds = new Map<string, string>();
  for (;;) {
    canonicalIds = new Map(groups.flatMap(group => {
      const ids = [...new Set(group.flatMap(identities))].sort(compareText);
      return ids.map(id => [id, ids[0]] as const);
    }));
    const records = groups.flat();
    groups = groups.map(group => [combineCategoryRecords(group, canonicalIds, records)]);
    const byId = identityLookup(groups.flat());
    const ancestry = ownershipAncestry(groups.flat());
    // Resolve older identities first; a stale alias cannot bridge them into a newer owner.
    groups.sort(([left], [right]) => ancestry(left.id).size - ancestry(right.id).size || compareText(left.id, right.id));
    if (!joinGroups(category => labels(category).map(name => {
      return JSON.stringify([categoryNameKey(name), nameGeneration(category, name, byId, ancestry)]);
    }), (left, right) => left.every(a => right.every(b => !ancestry(a.id).has(b.id) && !ancestry(b.id).has(a.id))))) break;
  }
  const records = groups.flat();
  const catalog = groups.map(group => combineCategoryRecords(group, canonicalIds, records)).sort((left, right) => compareText(left.id, right.id));
  const byName = lookup(catalog);
  const byId = identityLookup(catalog);
  for (const category of catalog) {
    if (category.replacementCategory !== undefined && category.replacementCategoryId === undefined) {
      const replacement = byName.get(categoryNameKey(category.replacementCategory));
      if (replacement) category.replacementCategoryId = replacement.id;
    }
  }
  const cycles = new Set<string>();
  for (const category of catalog) {
    const chain: string[] = [];
    let current: Category | undefined = category;
    while (current?.deletedAt && current.replacementCategory !== undefined) {
      const index = chain.indexOf(current.id);
      if (index >= 0) { for (const id of chain.slice(index)) cycles.add(id); break; }
      chain.push(current.id);
      current = current.replacementCategoryId === undefined ? byName.get(categoryNameKey(current.replacementCategory)) : byId.get(current.replacementCategoryId);
    }
  }
  // Concurrent deletion of each other's replacement has no live destination.
  for (const category of catalog) if (cycles.has(category.id)) {
    delete category.replacementCategory;
    delete category.replacementCategoryId;
  }
  return catalog;
}

function lookup(catalog: Category[]): Map<string, Category> {
  const result = new Map<string, Category>();
  const byId = identityLookup(catalog);
  const ancestry = ownershipAncestry(catalog);
  const depth = (category: Category, key: string): number => {
    const generation = nameGeneration(category, key, byId, ancestry);
    return generation ? 1 + ancestry(generation).size : 0;
  };
  for (const category of catalog) for (const name of labels(category)) {
    const key = categoryNameKey(name);
    const previous = result.get(key);
    if (!previous || depth(category, key) > depth(previous, key) || (depth(category, key) === depth(previous, key) && compareCategory(category, previous) > 0)) result.set(key, category);
  }
  return result;
}

function referencedNames(data: FinanceData): string[] {
  return [...data.transactions.map(item => item.category), ...data.planItems.map(item => item.category)].filter(name => name.trim());
}

function latestTimestamp(...values: (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined).sort((left, right) => Date.parse(left) - Date.parse(right) || compareText(left, right)).at(-1)!;
}

function categoryResolution(category: Category, byName: Map<string, Category>, byId: Map<string, Category>): { name: string; deletedAt?: string } {
  const seen = new Set<string>();
  let current: Category | undefined = category;
  let deletedAt: string | undefined;
  while (current?.deletedAt) {
    deletedAt = latestTimestamp(deletedAt, current.deletedAt, current.updatedAt);
    if (seen.has(current.id)) return { name: '', deletedAt };
    seen.add(current.id);
    current = current.replacementCategory === undefined ? undefined : current.replacementCategoryId === undefined ? byName.get(categoryNameKey(current.replacementCategory)) : byId.get(current.replacementCategoryId);
  }
  return { name: current?.name ?? '', ...(deletedAt !== undefined ? { deletedAt } : {}) };
}

/** Reconciles a pending assignment without registering unknown import labels. */
export function resolveCategoryName(data: Pick<FinanceData, 'categories'>, name: string): string {
  if (!name.trim()) return '';
  const byName = lookup(data.categories);
  const category = byName.get(categoryNameKey(name));
  return category ? categoryResolution(category, byName, identityLookup(data.categories)).name : name;
}

export function categoryWorkKeys(data: FinanceData): Set<string> {
  const keys = new Set(data.work?.expenseCategories.map(categoryNameKey) ?? []);
  const byName = lookup(data.categories);
  const owners = new Set([...keys].map(key => byName.get(key)?.id));
  for (const category of data.categories) {
    if (!owners.has(category.id)) continue;
    for (const name of labels(category).map(categoryNameKey)) if (byName.get(name)?.id === category.id) keys.add(name);
  }
  return keys;
}

/** Adopts referenced labels and keeps records linked to the current category name. */
export function normalizeCategoryData(data: FinanceData, adoptUnknown = true, importedAt = MIGRATION_CLOCK): FinanceData {
  const next = structuredClone(data);
  next.categories = mergeCategoryCatalog(next.categories ?? [], []);
  const byName = lookup(next.categories);
  const previousWorkKeys = categoryWorkKeys(next);
  const previousScopes = next.transactions.map(item => item.scope ?? (item.kind === 'expense' && previousWorkKeys.has(categoryNameKey(item.category)) ? 'work' : 'personal'));
  for (const name of referencedNames(next).sort(compareText)) {
    const key = categoryNameKey(name);
    if (byName.has(key)) continue;
    if (!adoptUnknown) throw new Error(`Unknown category: ${name}. Manage categories before using this name.`);
    const category: Category = { id: categoryId(name), name: cleanName(name), updatedAt: importedAt };
    next.categories.push(category);
    byName.set(key, category);
  }
  next.categories.sort((left, right) => compareText(left.id, right.id));
  const byId = identityLookup(next.categories);
  let deletionClock: string | undefined;
  for (const item of [...next.transactions, ...next.planItems]) {
    if (!item.category.trim()) { item.category = ''; continue; }
    const resolved = categoryResolution(byName.get(categoryNameKey(item.category))!, byName, byId);
    if (resolved.name !== item.category && resolved.deletedAt !== undefined) {
      item.updatedAt = latestTimestamp(item.updatedAt, resolved.deletedAt);
      deletionClock = latestTimestamp(deletionClock, resolved.deletedAt);
    }
    item.category = resolved.name;
  }
  if (next.work) {
    const names = new Map<string, string>();
    let workClock: string | undefined;
    for (const name of next.work.expenseCategories) {
      const category = byName.get(categoryNameKey(name));
      const resolved = category ? categoryResolution(category, byName, byId) : { name };
      if (resolved.name !== name && category) workClock = latestTimestamp(workClock, resolved.deletedAt, category.updatedAt);
      if (resolved.name) names.set(categoryNameKey(resolved.name), resolved.name);
    }
    const expenseCategories = [...names.values()];
    if (JSON.stringify(expenseCategories) !== JSON.stringify(next.work.expenseCategories)) {
      next.work.expenseCategories = expenseCategories;
      next.work.updatedAt = latestTimestamp(next.work.updatedAt, workClock);
      deletionClock = latestTimestamp(deletionClock, workClock);
    }
  }
  const currentWorkKeys = categoryWorkKeys(next);
  for (const [index, item] of next.transactions.entries()) {
    if (item.scope !== undefined) continue;
    const scope = item.kind === 'expense' && currentWorkKeys.has(categoryNameKey(item.category)) ? 'work' : 'personal';
    if (scope !== previousScopes[index]) {
      item.scope = previousScopes[index];
      item.updatedAt = latestTimestamp(item.updatedAt, deletionClock);
    }
  }
  if (deletionClock !== undefined) next.updatedAt = latestTimestamp(next.updatedAt, deletionClock);
  return next;
}

/** Keeps each device's assignments attached to their original identities before names are reconciled. */
export function rebaseCategoryAssignments(data: FinanceData, catalog: Category[]): FinanceData {
  const original = normalizeCategoryData(data);
  const next = structuredClone(original);
  const ownNames = lookup(original.categories);
  const categories = mergeCategoryCatalog(catalog, []);
  const byName = lookup(categories);
  const byId = identityLookup(categories);
  const originalWorkKeys = categoryWorkKeys(original);
  const scopes = original.transactions.map(item => item.scope ?? (item.kind === 'expense' && originalWorkKeys.has(categoryNameKey(item.category)) ? 'work' : 'personal'));
  const resolve = (name: string): { name: string; deletedAt?: string } => {
    const source = ownNames.get(categoryNameKey(name));
    const target = source && identities(source).map(id => byId.get(id)).find(Boolean);
    return target ? categoryResolution(target, byName, byId) : { name };
  };
  let deletionClock: string | undefined;
  for (const item of [...next.transactions, ...next.planItems]) {
    const resolved = resolve(item.category);
    if (resolved.name !== item.category && resolved.deletedAt !== undefined) {
      item.updatedAt = latestTimestamp(item.updatedAt, resolved.deletedAt);
      deletionClock = latestTimestamp(deletionClock, resolved.deletedAt);
    }
    item.category = resolved.name;
  }
  if (next.work) {
    const names = new Map<string, string>();
    let workClock: string | undefined;
    for (const name of next.work.expenseCategories) {
      const resolved = resolve(name);
      if (resolved.name !== name) workClock = latestTimestamp(workClock, resolved.deletedAt);
      if (resolved.name) names.set(categoryNameKey(resolved.name), resolved.name);
    }
    if (JSON.stringify(next.work.expenseCategories) !== JSON.stringify([...names.values()])) {
      next.work.expenseCategories = [...names.values()];
      next.work.updatedAt = latestTimestamp(next.work.updatedAt, workClock);
      deletionClock = latestTimestamp(deletionClock, workClock);
    }
  }
  next.categories = categories;
  const nextWorkKeys = categoryWorkKeys(next);
  for (const [index, item] of next.transactions.entries()) {
    const scope = item.scope ?? (item.kind === 'expense' && nextWorkKeys.has(categoryNameKey(item.category)) ? 'work' : 'personal');
    if (item.scope === undefined && scope !== scopes[index]) {
      item.scope = scopes[index];
      item.updatedAt = latestTimestamp(item.updatedAt, deletionClock);
    }
  }
  if (deletionClock !== undefined) next.updatedAt = latestTimestamp(next.updatedAt, deletionClock);
  return normalizeCategoryData(next, false);
}

export function listCategories(data: FinanceData): Category[] {
  return [...(data.categories ?? normalizeCategoryData(data).categories)].filter(category => !category.deletedAt).sort((left, right) => left.name.localeCompare(right.name, 'pt-BR') || compareText(left.id, right.id));
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
  const existing = catalog.find(category => !category.deletedAt && category.id !== exceptId && labels(category).some(label => categoryNameKey(label) === categoryNameKey(name)));
  if (existing) throw new Error(existing.archivedAt ? 'This category already exists and is archived. Restore it to use it again.' : 'A category already exists with this name or a previous name.');
}

function reclaimName(catalog: Category[], name: string): { name: string; fromCategoryId: string } | undefined {
  const previous = lookup(catalog).get(categoryNameKey(name));
  return previous?.deletedAt ? { name, fromCategoryId: previous.id } : undefined;
}

export function addCategory(data: FinanceData, name: string, now = new Date()): FinanceData {
  const next = normalizeCategoryData(data);
  const cleaned = cleanName(name);
  assertUnique(next.categories, cleaned);
  const updatedAt = editTime(now);
  const claim = reclaimName(next.categories, cleaned);
  next.categories.push({ id: claim ? `category-${crypto.randomUUID()}` : categoryId(cleaned), name: cleaned, updatedAt, ...(claim ? { nameReclaims: [claim] } : {}) });
  next.categories.sort((left, right) => compareText(left.id, right.id));
  next.updatedAt = updatedAt;
  return next;
}

export function renameCategory(data: FinanceData, id: string, newName: string, now = new Date()): FinanceData {
  const next = normalizeCategoryData(data);
  const category = next.categories.find(item => item.id === id);
  if (!category || category.deletedAt) throw new Error('Category not found.');
  const cleaned = cleanName(newName);
  assertUnique(next.categories, cleaned, id);
  if (category.name === cleaned) return next;
  const updatedAt = editTime(now);
  const claim = reclaimName(next.categories, cleaned);
  if (claim) category.nameReclaims = [...(category.nameReclaims ?? []).filter(item => categoryNameKey(item.name) !== categoryNameKey(cleaned)), claim];
  category.aliases = [...new Set([...(category.aliases ?? []), category.name])].filter(name => categoryNameKey(name) !== categoryNameKey(cleaned));
  category.name = cleaned;
  category.updatedAt = updatedAt;
  const normalized = normalizeCategoryData(next, false);
  for (let index = 0; index < normalized.transactions.length; index++) if (normalized.transactions[index].category !== data.transactions[index].category) normalized.transactions[index].updatedAt = updatedAt;
  for (let index = 0; index < normalized.planItems.length; index++) if (normalized.planItems[index].category !== data.planItems[index].category) normalized.planItems[index].updatedAt = updatedAt;
  normalized.updatedAt = updatedAt;
  return normalized;
}

export function archiveCategory(data: FinanceData, id: string, now = new Date()): FinanceData {
  const next = normalizeCategoryData(data);
  const category = next.categories.find(item => item.id === id);
  if (!category || category.deletedAt) throw new Error('Category not found.');
  if (category.archivedAt) return next;
  category.updatedAt = category.archivedAt = editTime(now);
  next.updatedAt = category.updatedAt;
  return next;
}

export function restoreCategory(data: FinanceData, id: string, now = new Date()): FinanceData {
  const next = normalizeCategoryData(data);
  const category = next.categories.find(item => item.id === id);
  if (!category || category.deletedAt) throw new Error('Category not found.');
  if (!category.archivedAt) return next;
  delete category.archivedAt;
  category.updatedAt = editTime(now);
  next.updatedAt = category.updatedAt;
  return next;
}

export interface CategoryUsage {
  transactions: number;
  planItems: number;
  workRules: number;
  total: number;
}

/** Includes historical records and deletion tombstones so their assignments also remain valid. */
export function categoryUsage(data: FinanceData, id: string): CategoryUsage {
  const category = data.categories.find(item => item.id === id && !item.deletedAt);
  if (!category) throw new Error('Category not found.');
  const keys = new Set(labels(category).map(categoryNameKey));
  const transactions = data.transactions.filter(item => keys.has(categoryNameKey(item.category))).length;
  const planItems = data.planItems.filter(item => keys.has(categoryNameKey(item.category))).length;
  const workRules = data.work?.expenseCategories.filter(name => keys.has(categoryNameKey(name))).length ?? 0;
  return { transactions, planItems, workRules, total: transactions + planItems + workRules };
}

/** Permanently removes an option and redirects all of its current and stale assignments. */
export function deleteCategory(data: FinanceData, id: string, replacementName?: string, now = new Date()): FinanceData {
  const next = normalizeCategoryData(data);
  const category = next.categories.find(item => item.id === id && !item.deletedAt);
  if (!category) throw new Error('Category not found.');
  const replacement = replacementName === undefined ? undefined : next.categories.find(item => item.name === replacementName && !item.deletedAt && !item.archivedAt);
  if (replacementName !== undefined && (!replacement || replacement.id === id)) throw new Error('Select a different available category as the replacement.');
  if (categoryUsage(next, id).total && !replacement) throw new Error('Select a replacement category before deleting a category assigned to items.');
  const updatedAt = editTime(now);
  category.deletedAt = category.updatedAt = updatedAt;
  if (replacement) {
    category.replacementCategory = replacement.name;
    category.replacementCategoryId = replacement.id;
  }
  const normalized = normalizeCategoryData(next, false);
  normalized.updatedAt = latestTimestamp(normalized.updatedAt, updatedAt);
  return normalized;
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
    if (existing?.deletedAt) throw new Error(`The category ${name} was deleted. Choose a different name.`);
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
    if (category.deletedAt) continue;
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
    if (item.deletedAt || getTransactionReportingMonth(item) < fromMonth) continue;
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
  if (!changed) return data;
  next.updatedAt = updatedAt;
  return next;
}
