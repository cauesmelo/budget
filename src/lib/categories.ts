import type { Category, FinanceData } from './types';

// Categorias descobertas em backups antigos não podem substituir uma edição atual.
const LEGACY_CLOCK = '1970-01-01T00:00:00.000Z';
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
export const categoryNameKey = (name: string): string => name.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');

function cleanName(name: string): string {
  const cleaned = name.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > 500) throw new Error('Informe um nome de categoria entre 1 e 500 caracteres.');
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

/** Une alterações por id e nomes anteriores, inclusive adições iguais em dois dispositivos. */
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

/** Migra rótulos legados e mantém todos os registros apontando para o nome atual. */
export function normalizeCategoryData(data: FinanceData, adoptUnknown = true, importedAt = LEGACY_CLOCK): FinanceData {
  const next = structuredClone(data);
  next.categories = mergeCategoryCatalog(next.categories ?? [], []);
  const byName = lookup(next.categories);
  for (const name of referencedNames(next).sort(compareText)) {
    const key = categoryNameKey(name);
    if (byName.has(key)) continue;
    if (!adoptUnknown) throw new Error(`Categoria não cadastrada: ${name}. Gerencie as categorias antes de usar esse nome.`);
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
      if (!Number.isSafeInteger(amount)) throw new Error('O total da categoria excedeu o intervalo monetário suportado.');
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
  if (!listCategories(data).some(category => category.name === name && !category.archivedAt)) throw new Error('Selecione uma categoria disponível ou deixe sem categoria.');
}

function editTime(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error('Data inválida.');
  return now.toISOString();
}

function assertUnique(catalog: Category[], name: string, exceptId?: string): void {
  const existing = catalog.find(category => category.id !== exceptId && labels(category).some(label => categoryNameKey(label) === categoryNameKey(name)));
  if (existing) throw new Error(existing.archivedAt ? 'Essa categoria já existe e está arquivada. Restaure-a para usar novamente.' : 'Já existe uma categoria com esse nome ou um nome anterior.');
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
  if (!category) throw new Error('Categoria não encontrada.');
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
  if (!category) throw new Error('Categoria não encontrada.');
  if (category.archivedAt) return next;
  category.updatedAt = category.archivedAt = editTime(now);
  next.updatedAt = category.updatedAt;
  return next;
}

export function restoreCategory(data: FinanceData, id: string, now = new Date()): FinanceData {
  const next = normalizeCategoryData(data);
  const category = next.categories.find(item => item.id === id);
  if (!category) throw new Error('Categoria não encontrada.');
  if (!category.archivedAt) return next;
  delete category.archivedAt;
  category.updatedAt = editTime(now);
  next.updatedAt = category.updatedAt;
  return next;
}
