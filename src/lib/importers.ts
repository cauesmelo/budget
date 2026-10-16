import * as XLSX from 'xlsx';
import { parseMoneyToCents } from './finance';
import { formatNumber } from './numbers';
import { canonicalAccountIdentity } from './identity';
import type { ImportOptions, ImportResult, Transaction, TransactionKind, TransactionSource } from './types';

type Cell = string | number | boolean | Date | null | undefined;
type Rows = Cell[][];
type InputFile = { name: string; arrayBuffer(): Promise<ArrayBuffer> };
// Portuguese month names, headers, and classifiers below match external workbook formats.
const MONTHS = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const text = (value: Cell): string => String(value ?? '').trim();
const normalize = (value: Cell): string => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');

/** Stable, file-name-independent identity. An occurrence counter preserves real repeated charges. */
function stableHash(value: string): string {
  let hash = 14695981039346656037n;
  for (const char of value) {
    hash ^= BigInt(char.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, '0');
}

function readCents(value: Cell): number | null {
  if (value == null || text(value) === '' || /^[-–—]$/.test(text(value))) return null;
  try { return parseMoneyToCents(value); } catch { return null; }
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 2200 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function readDate(value: Cell): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  if (typeof value === 'number' && value > 1000) {
    const date = XLSX.SSF.parse_date_code(value);
    return date ? isoDate(date.y, date.m, date.d) : null;
  }
  const raw = text(value);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\s|$)/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const br = raw.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
  if (br) return isoDate(Number(br[3]) < 100 ? 2000 + Number(br[3]) : Number(br[3]), Number(br[2]), Number(br[1]));
  return null;
}

const validMonth = (month: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
const emptyResult = (source: TransactionSource): ImportResult => ({ source, transactions: [], warnings: [] });

function getRows(sheet: XLSX.WorkSheet): Rows {
  return XLSX.utils.sheet_to_json<Cell[]>(sheet, { header: 1, defval: null, raw: true, blankrows: true });
}

function headerIndex(rows: Rows, predicate: (headers: string[]) => boolean): number {
  return rows.slice(0, 100).findIndex(row => predicate(row.map(normalize)));
}

function createTransactionFactory(source: TransactionSource, filename: string) {
  const occurrences = new Map<string, number>();
  const updatedAt = new Date().toISOString();
  return (fields: Omit<Transaction, 'id' | 'fingerprint' | 'source' | 'sourceFile' | 'updatedAt'>): Transaction => {
    const key = JSON.stringify([source, canonicalAccountIdentity(fields.account), fields.date, source === 'card' ? fields.month : '', normalize(fields.originalDescription), fields.amountCents, fields.installment ?? '']);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    const fingerprint = `v1-${stableHash(`${key}:${occurrence}`)}`;
    return { ...fields, id: `tx-${fingerprint}`, fingerprint, source, sourceFile: filename, updatedAt };
  };
}

function isTransfer(description: string): boolean {
  const label = normalize(description);
  return /^(pagamento (com saldo|de fatura)|pagamento recebido|pag(?:amento)? (?:cartao|itaucard)|itau(?:card)?\s*(?:visa|master)|fatura (?:paga|cartao|itau))\b/.test(label)
    || /\b(?:aplicacao|resgate|apl|rsc)\b.*\b(?:cdb|rdb|poup|invest|fundo|tesouro|renda|financeir)\b/.test(label)
    || /^(?:aplic|aplicacao|resg?|resgate|apl|rsc)\s+(?:aplic\s+)?aut(?:omatica)?\b/.test(label);
}

function bankAccount(rows: Rows): string {
  let account = '';
  let agency = '';
  for (const row of rows) {
    const label = normalize(row[0]).replace(/:$/, '').trim();
    const value = row.slice(1).map(text).find(Boolean) ?? '';
    if (/^(conta|conta corrente|numero da conta)$/.test(label) && /^[\d.\s-]+$/.test(value)) account = value.replace(/[.\s]/g, '');
    if (/^(agencia|agencia da conta)$/.test(label) && /^[\d.\s-]+$/.test(value)) agency = value.replace(/[.\s]/g, '');
  }
  return `Itaú checking account${account ? ` • ${agency ? `${agency}/` : ''}${account}` : ''}`;
}

function cardAccount(value: Cell, fallback: string): string {
  const digits = text(value).replace(/\D/g, '');
  return `Itaú card${digits.length >= 4 ? ` ****${digits.slice(-4)}` : fallback ? ` ****${fallback}` : ''}`;
}

function parseBank(rows: Rows, filename: string): ImportResult | null {
  const index = headerIndex(rows, headers => headers.includes('data') && headers.some(h => /^(lancamento|historico|descricao)$/.test(h)) && headers.some(h => /^valor|^credito|^debito/.test(h)));
  if (index < 0) return null;
  const result = emptyResult('bank');
  const headers = rows[index].map(normalize);
  const dateCol = headers.indexOf('data');
  const labelCol = headers.findIndex(h => /^(lancamento|historico|descricao)$/.test(h));
  const valueCol = headers.findIndex(h => /^valor/.test(h));
  const creditCol = headers.findIndex(h => /^credito/.test(h));
  const debitCol = headers.findIndex(h => /^debito/.test(h));
  const makeTransaction = createTransactionFactory('bank', filename);
  const account = bankAccount(rows.slice(0, index));
  const exportedAt = rows.slice(0, index).flat().map(value => text(value).match(/^(\d{2}\/\d{2}\/\d{4})\s/)).find(Boolean)?.[1];
  const exportedDate = exportedAt ? readDate(exportedAt) : null;
  let skipped = 0;
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i];
    const date = readDate(row[dateCol]);
    const originalDescription = text(row[labelCol]);
    if (!date || !originalDescription || /^(saldo\b|total\b|lancamentos futuros\b)/.test(normalize(originalDescription))) continue;
    let amountCents = valueCol >= 0 ? readCents(row[valueCol]) : null;
    if (valueCol < 0) {
      const credit = creditCol >= 0 ? readCents(row[creditCol]) : null;
      const debit = debitCol >= 0 ? readCents(row[debitCol]) : null;
      if (credit !== null || debit !== null) amountCents = Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
    }
    if (amountCents === null) { skipped++; continue; }
    const kind: TransactionKind = isTransfer(originalDescription) ? 'transfer' : amountCents < 0 ? 'expense' : 'income';
    result.transactions.push(makeTransaction({ date, month: date.slice(0, 7), amountCents, kind, account, originalDescription, description: '', category: '', sourceRow: i + 1 }));
  }
  if (skipped) result.warnings.push(`${formatNumber(skipped)} row(s) with a date and transaction but no valid amount were skipped.`);
  if (exportedDate && result.transactions.some(t => t.date > exportedDate)) result.warnings.push('The statement contains transactions dated after the file was updated. They were preserved; check whether they are scheduled transactions or bank processing dates.');
  if (result.transactions.some(t => t.kind === 'transfer')) result.warnings.push('Recognized card payments and investment principal appear as account movements, excluded from income and spending. Use Exclude to remove any rows you do not want to import.');
  result.summary = `${formatNumber(result.transactions.length)} checking account transactions. Balances and totals were ignored.`;
  return result;
}

function monthFromText(value: string): string | null {
  const normalized = normalize(value);
  const numeric = normalized.match(/fatura[\s_-]*(\d{1,2})[/-](\d{2}|\d{4})\b/);
  if (numeric) {
    const year = Number(numeric[2]) < 100 ? 2000 + Number(numeric[2]) : Number(numeric[2]);
    const month = `${year}-${String(Number(numeric[1])).padStart(2, '0')}`;
    if (validMonth(month)) return month;
  }
  for (let i = 0; i < MONTHS.length; i++) {
    const pattern = new RegExp(`${MONTHS[i]}[\\s/_-]*(20\\d{2})`);
    const match = normalized.match(pattern);
    if (match) return `${match[1]}-${String(i + 1).padStart(2, '0')}`;
  }
  return null;
}

function cardMetadata(rows: Rows, sheetName: string, filename: string): { month: string | null; partialCents: number | null; open: boolean } {
  let month: string | null = null;
  let partialCents: number | null = null;
  let open = false;
  for (let i = 0; i < Math.min(rows.length, 100); i++) {
    for (let j = 0; j < rows[i].length; j++) {
      const value = normalize(rows[i][j]);
      if (value.includes('fatura aberta')) open = true;
      month ??= monthFromText(value);
      if (value === 'vencimento') {
        const date = readDate(rows[i + 1]?.[j]);
        if (date) month = date.slice(0, 7);
      }
      if (value === 'valor (parcial)' || value === 'valor parcial' || value === 'valor total') partialCents = readCents(rows[i + 1]?.[j]);
    }
  }
  return { month: month ?? monthFromText(sheetName) ?? monthFromText(filename), partialCents, open };
}

function parseCard(rows: Rows, sheetName: string, filename: string, options: ImportOptions): ImportResult | null {
  const index = headerIndex(rows, headers => headers.includes('data') && headers.includes('lancamento') && headers.includes('parcelamento') && headers.some(h => /^valor/.test(h)));
  if (index < 0) return null;
  const result = emptyResult('card');
  const metadata = cardMetadata(rows, sheetName, filename);
  const month = options.cardMonth ?? metadata.month;
  if (!month || !validMonth(month)) throw new Error('Could not identify the statement month. Choose the statement month (YYYY-MM) before importing.');
  if (options.cardMonth && metadata.month && options.cardMonth !== metadata.month) result.warnings.push(`The selected statement month (${options.cardMonth}) differs from the detected statement month (${metadata.month}). Purchases still count in the month of their original date.`);
  const headers = rows[index].map(normalize);
  const dateCol = headers.indexOf('data');
  const labelCol = headers.indexOf('lancamento');
  const installmentCol = headers.indexOf('parcelamento');
  const valueCol = headers.findIndex(h => /^valor/.test(h));
  const accountCol = headers.findIndex(h => h === 'numero do cartao' || h === 'numero' || h === 'cartao');
  const defaultCard = rows.slice(0, index).flat().map(cell => text(cell).match(/(?:final|\*{2,})\s*(\d{4})\b/i)?.[1]).find(Boolean) ?? '';
  const makeTransaction = createTransactionFactory('card', filename);
  let skipped = 0;
  let positiveCharges = 0;
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i];
    const date = readDate(row[dateCol]);
    const originalDescription = text(row[labelCol]);
    if (!date || !originalDescription) continue;
    const rawCents = readCents(row[valueCol]);
    if (rawCents === null) { skipped++; continue; }
    const kind: TransactionKind = isTransfer(originalDescription) ? 'transfer' : 'expense';
    const amountCents = -rawCents;
    if (rawCents > 0 && kind !== 'transfer') positiveCharges += rawCents;
    const rawInstallment = text(row[installmentCol]);
    const installmentMatch = rawInstallment.match(/(?:parcela\s*)?(\d+)\s*(?:de|\/)\s*(\d+)/i);
    const installment = installmentMatch ? `${Number(installmentMatch[1])}/${Number(installmentMatch[2])}` : rawInstallment || undefined;
    result.transactions.push(makeTransaction({ date, month, amountCents, kind, account: cardAccount(accountCol >= 0 ? row[accountCol] : null, defaultCard), originalDescription, description: '', category: '', installment, sourceRow: i + 1 }));
  }
  if (metadata.partialCents !== null && Math.abs(positiveCharges - metadata.partialCents) > 1) result.warnings.push('The sum of imported charges differs from the statement total. Check refunds, payments, and transactions before closing the month.');
  if (skipped) result.warnings.push(`${formatNumber(skipped)} dated transaction(s) without a valid amount were skipped.`);
  result.warnings.push('Card purchases count in the month of their original purchase date, including installment entries. The statement month identifies the imported bill and does not set the spending month.');
  if (metadata.open) result.warnings.push('This statement is still open. Recent purchases and installments may change before closing; review changed amounts when importing an updated version.');
  if (result.transactions.some(t => t.kind === 'transfer')) result.warnings.push('Statement payments appear as account movements, excluded from income and spending. Use Exclude to remove them before importing.');
  result.summary = `${formatNumber(result.transactions.length)} card transactions from statement ${month}, reported by purchase date.`;
  return result;
}

/** Parses source values only; spreadsheet formulas and embedded instructions are never executed. */
export function parseWorkbook(workbook: XLSX.WorkBook, filename: string, options: ImportOptions = {}): ImportResult {
  if (options.cardMonth && !validMonth(options.cardMonth)) throw new Error('Invalid statement month. Use YYYY-MM format.');
  for (const name of workbook.SheetNames) {
    const rows = getRows(workbook.Sheets[name]);
    const card = parseCard(rows, name, filename, options);
    if (card) return card;
    const bank = parseBank(rows, filename);
    if (bank) return bank;
  }
  throw new Error('Unrecognized format. Import an Itaú checking account or card statement in XLS or XLSX format with its original headers.');
}

export async function parseImport(file: File | InputFile, options: ImportOptions = {}): Promise<ImportResult> {
  if (!/\.xlsx?$/i.test(file.name)) throw new Error('Unsupported file type. Import an Itaú checking account or card statement in XLS or XLSX format.');
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > 30 * 1024 * 1024) throw new Error('The file exceeds 30 MB. Export a shorter period.');
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'array', cellDates: true, raw: true, cellFormula: true });
  } catch {
    throw new Error('Could not read the workbook. Check that the file is a valid XLS or XLSX and is not password protected.');
  }
  return parseWorkbook(workbook, file.name, options);
}
