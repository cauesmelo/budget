import type { FinanceData, ImportResult, MonthSummary, PlanItem, ProjectionMonth, Transaction } from './types';
import { mergeCategoryCatalog, normalizeCategoryData } from './categories';

const MONEY_FORMAT = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const MONTH_FORMAT = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Centavos são inteiros; os lançamentos têm sinal de fluxo de caixa. */
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
  if (!isValidMonth(month)) throw new Error('Mês inválido. Use AAAA-MM.');
  return MONTH_FORMAT.format(new Date(`${month}-01T12:00:00.000Z`));
}

export function addMonths(month: string, count: number): string {
  if (!isValidMonth(month) || !Number.isInteger(count)) throw new Error('Mês ou intervalo inválido.');
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1 + count;
  const year = Math.floor(index / 12);
  const monthNumber = ((index % 12) + 12) % 12 + 1;
  if (year < 1 || year > 9999) throw new Error('Mês fora do intervalo suportado.');
  return `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`;
}

export function createEmptyData(now = new Date()): FinanceData {
  if (!Number.isFinite(now.getTime())) throw new Error('Data inválida.');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const month = `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}`;
  const updatedAt = now.toISOString();
  return {
    version: 1, categories: [], transactions: [], planItems: [], snapshots: [], imports: [],
    settings: {
      initialReserveCents: 0, reserveStartMonth: month, monthlyReturnPercent: 0,
      reserveGoalCents: 0, horizonMonths: 24, googleClientId: '', updatedAt,
    },
    updatedAt,
  };
}

/** Aceita números de planilha e texto monetário brasileiro, incluindo crédito/estorno. */
export function parseMoneyToCents(value: unknown): number {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Valor monetário inválido.');
    // Conversão decimal explícita evita o arredondamento binário de 1,005 * 100.
    return decimalToCents(value.toFixed(10), false);
  }
  if (typeof value !== 'string') throw new Error('Valor monetário inválido.');
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
  if (!/^\d+(?:[.,]\d+)*$/.test(text)) throw new Error(`Valor monetário inválido: ${value}`);

  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimalMark = comma > dot ? ',' : '.';
    const groupMark = decimalMark === ',' ? '.' : ',';
    const [whole, fraction, ...extra] = text.split(decimalMark);
    if (extra.length || !validGroupedInteger(whole, groupMark)) throw new Error(`Valor monetário inválido: ${value}`);
    text = `${whole.split(groupMark).join('')}.${fraction}`;
  } else if (comma >= 0) {
    const groups = text.split(',');
    if (groups.length > 2) {
      if (!validGroupedInteger(text, ',')) throw new Error(`Valor monetário inválido: ${value}`);
      text = groups.join('');
    } else text = text.replace(',', '.');
  } else if (dot >= 0) {
    const groups = text.split('.');
    const isThousands = groups.length > 2 || (groups[0].length <= 3 && groups[1].length === 3);
    if (isThousands) {
      if (!validGroupedInteger(text, '.')) throw new Error(`Valor monetário inválido: ${value}`);
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
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Valor monetário fora do intervalo suportado.');
  const [whole, decimal = ''] = text.split('.');
  let cents = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0').slice(0, 2));
  if ((decimal[2] ?? '0') >= '5') cents += 1n;
  if (negative) cents = -cents;
  const result = Number(cents);
  if (!Number.isSafeInteger(result)) throw new Error('Valor monetário fora do intervalo suportado.');
  return result;
}

export function summarizeMonth(data: FinanceData, month: string, mode: 'transactions' | 'budget' = 'transactions'): MonthSummary {
  if (!isValidMonth(month)) throw new Error('Mês inválido.');
  const originals = data.transactions.filter(item => item.month === month &&
    (mode === 'budget' ? item.source === 'budget' : item.source !== 'budget'));
  const transactions = originals.filter(item => !item.deletedAt && item.kind !== 'transfer');
  let snapshotIncomeCents = 0;
  if (mode === 'budget') {
    const snapshot = data.snapshots.filter(item => item.month === month).sort((a, b) => compareRecords(a, b)).at(-1);
    if (snapshot && originals.length === 0) return {
      month, incomeCents: snapshot.incomeCents, expenseCents: snapshot.expenseCents,
      netCents: snapshot.incomeCents - snapshot.expenseCents,
      categories: { ...snapshot.categories }, count: transactions.length,
    };
    // Os lançamentos editáveis prevalecem, inclusive quando todos foram excluídos.
    // Um snapshot antigo pode ter receita agregada sem lançamentos de receita.
    if (snapshot && !originals.some(item => item.kind === 'income')) snapshotIncomeCents = snapshot.incomeCents;
  }
  let incomeCents = snapshotIncomeCents;
  let expenseCents = 0;
  const categories: Record<string, number> = {};
  for (const transaction of transactions) {
    if (transaction.kind === 'income') incomeCents += transaction.amountCents;
    else {
      const amount = -transaction.amountCents;
      expenseCents += amount;
      const category = transaction.category.trim() || 'Sem categoria';
      Object.defineProperty(categories, category, { value: (Object.hasOwn(categories, category) ? categories[category] : 0) + amount, enumerable: true, writable: true, configurable: true });
    }
  }
  return { month, incomeCents, expenseCents, netCents: incomeCents - expenseCents, categories, count: transactions.length };
}

/** Dentro do intervalo ativo, um valor explícito por mês prevalece sobre a recorrência. */
export function planAmountForMonth(item: PlanItem, month: string): number {
  if (item.deletedAt) return 0;
  if (month < item.startMonth || (item.endMonth && month > item.endMonth)) return 0;
  if (Object.hasOwn(item.amounts, month)) return item.amounts[month];
  return item.defaultAmountCents;
}

export function projectReserve(data: FinanceData): ProjectionMonth[] {
  const { reserveStartMonth, horizonMonths, monthlyReturnPercent, initialReserveCents } = data.settings;
  if (!isValidMonth(reserveStartMonth) || !Number.isInteger(horizonMonths) || horizonMonths < 1 || horizonMonths > 600 || !Number.isFinite(monthlyReturnPercent)) throw new Error('Configuração de projeção inválida.');
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
    // Rendimento é aplicado somente ao saldo de abertura; sobra entra no fechamento.
    const returnCents = roundCents(openingCents * monthlyReturnPercent / 100);
    const netCents = incomeCents - expenseCents;
    const closingCents = openingCents + netCents + returnCents;
    if (![incomeCents, expenseCents, returnCents, closingCents].every(Number.isSafeInteger)) throw new Error('A projeção excedeu o intervalo monetário suportado.');
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
  // Uma exclusão empatada prevalece sobre uma cópia ainda ativa.
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

export function mergeFinanceData(local: FinanceData, remote: FinanceData): FinanceData {
  if (local.version !== 1 || remote.version !== 1) throw new Error('Versão de dados não suportada.');
  local = normalizeCategoryData(local);
  remote = normalizeCategoryData(remote);
  const localSettings = { ...local.settings, googleClientId: '' };
  const remoteSettings = { ...remote.settings, googleClientId: '' };
  const pristineLocal = local.categories.length === 0 && local.transactions.length === 0 && local.planItems.length === 0 && local.snapshots.length === 0 && local.imports.length === 0 &&
    local.settings.initialReserveCents === 0 && local.settings.reserveGoalCents === 0 && local.settings.monthlyReturnPercent === 0 && local.settings.horizonMonths === 24;
  // O timestamp de criação em um navegador novo não é uma edição financeira.
  const remoteHasSavedState = remote.categories.length > 0 || remote.transactions.length > 0 || remote.planItems.length > 0 || remote.snapshots.length > 0 || remote.imports.length > 0 ||
    remote.settings.initialReserveCents !== 0 || remote.settings.reserveGoalCents !== 0 || remote.settings.monthlyReturnPercent !== 0 || remote.settings.horizonMonths !== 24 ||
    remote.settings.reserveStartMonth !== local.settings.reserveStartMonth;
  const settings = pristineLocal && remoteHasSavedState ? remote.settings : compareRecords(localSettings, remoteSettings) >= 0 ? local.settings : remote.settings;
  const merged = {
    version: 1 as const,
    categories: mergeCategoryCatalog(local.categories, remote.categories),
    transactions: mergeRecords(local.transactions, remote.transactions),
    planItems: mergeRecords(local.planItems, remote.planItems),
    snapshots: mergeRecords(local.snapshots, remote.snapshots),
    imports: mergeRecords(local.imports, remote.imports),
    settings: { ...settings, googleClientId: local.settings.googleClientId },
    updatedAt: Date.parse(local.updatedAt) >= Date.parse(remote.updatedAt) ? local.updatedAt : remote.updatedAt,
  };
  return normalizeCategoryData(merged, false);
}

function transactionExists(transaction: Transaction, ids: Set<string>, fingerprints: Set<string>): boolean {
  return ids.has(transaction.id) || fingerprints.has(transaction.fingerprint);
}

export function previewDuplicateCount(data: FinanceData, result: ImportResult): number {
  const ids = new Set(data.transactions.map(item => item.id));
  const fingerprints = new Set(data.transactions.map(item => item.fingerprint));
  let duplicates = 0;
  for (const transaction of result.transactions) {
    if (transactionExists(transaction, ids, fingerprints)) duplicates++;
    ids.add(transaction.id);
    fingerprints.add(transaction.fingerprint);
  }
  return duplicates;
}

/** ImportBatch.count registra o total de novos lançamentos, itens de planejamento e snapshots. */
export function applyImport(data: FinanceData, result: ImportResult, filename: string, now = new Date()): FinanceData {
  const next = normalizeCategoryData(data);
  const updatedAt = now.toISOString();
  const importId = crypto.randomUUID();
  const ids = new Set(next.transactions.map(item => item.id));
  const fingerprints = new Set(next.transactions.map(item => item.fingerprint));
  let count = 0;
  for (const transaction of result.transactions) {
    if (transactionExists(transaction, ids, fingerprints)) continue;
    next.transactions.push({ ...structuredClone(transaction), importId, sourceFile: filename, updatedAt });
    ids.add(transaction.id);
    fingerprints.add(transaction.fingerprint);
    count++;
  }
  const seedSettings = next.planItems.length === 0 && next.snapshots.length === 0;
  const planIds = new Set(next.planItems.map(item => item.id));
  for (const item of result.planItems) {
    if (planIds.has(item.id)) continue;
    next.planItems.push({ ...structuredClone(item), updatedAt });
    planIds.add(item.id);
    count++;
  }
  const snapshotIds = new Set(next.snapshots.map(item => item.id));
  for (const snapshot of result.snapshots) {
    if (snapshotIds.has(snapshot.id)) continue;
    next.snapshots.push({ ...structuredClone(snapshot), updatedAt });
    snapshotIds.add(snapshot.id);
    count++;
  }
  if (seedSettings && result.suggestedSettings) {
    const { googleClientId: _clientId, updatedAt: _timestamp, ...suggested } = result.suggestedSettings;
    next.settings = { ...next.settings, ...suggested, updatedAt };
  }
  next.imports.push({ id: importId, filename, source: result.source, count, importedAt: updatedAt, updatedAt });
  next.updatedAt = updatedAt;
  return normalizeCategoryData(next, true, updatedAt);
}

/** Recibo persistido junto com os dados, inclusive nos backups e na nuvem. */
export const INITIAL_IMPORT_ID = 'initial-legacy-budget-v1';

/** Alimenta o histórico legado uma vez, preservando ajustes e exclusões anteriores. */
export function applyInitialImport(data: FinanceData, result: ImportResult, filename: string, now = new Date()): FinanceData {
  if (data.imports.some(batch => batch.id === INITIAL_IMPORT_ID)) return data;
  if (result.source !== 'budget') throw new Error('A carga inicial aceita somente o Budget legado.');
  const updatedAt = now.toISOString();
  // A versão anterior usava o mês da data, mesmo quando a linha pertencia a
  // outra aba mensal. Corrija a competência sem substituir a edição da linha.
  const legacyKey = (item: Transaction) => JSON.stringify([item.date, item.originalDescription, item.account, item.amountCents, item.sourceRow]);
  const incomingByRow = new Map<string, Transaction | null>();
  for (const item of result.transactions) {
    if (item.source !== 'budget' || item.sourceRow === undefined) continue;
    const key = legacyKey(item);
    // A posição da linha se repete entre abas. Uma associação ambígua não é
    // suficiente para corrigir a competência de um registro já existente.
    incomingByRow.set(key, incomingByRow.has(key) ? null : item);
  }
  const current = {
    ...data,
    transactions: data.transactions.map(item => {
      if (item.source !== 'budget' || item.sourceRow === undefined || item.month !== item.date.slice(0, 7)) return item;
      const incoming = incomingByRow.get(legacyKey(item));
      return incoming && incoming.month !== item.month
        ? { ...item, month: incoming.month, updatedAt }
        : item;
    }),
  };
  const keepSettings = data.planItems.length > 0 || data.snapshots.length > 0 ||
    data.settings.initialReserveCents !== 0 || data.settings.reserveGoalCents !== 0 ||
    data.settings.monthlyReturnPercent !== 0 || data.settings.horizonMonths !== 24 ||
    data.settings.reserveStartMonth !== createEmptyData(now).settings.reserveStartMonth;
  const next = applyImport(current, result, filename, now);
  const batch = next.imports.at(-1)!;
  const generatedId = batch.id;
  batch.id = INITIAL_IMPORT_ID;
  for (const item of next.transactions) if (item.importId === generatedId) item.importId = INITIAL_IMPORT_ID;
  if (keepSettings) next.settings = structuredClone(data.settings);
  next.settings.googleClientId = data.settings.googleClientId;
  return next;
}
