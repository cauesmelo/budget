import * as XLSX from 'xlsx';
import { parseMoneyToCents } from './finance';
import type { BudgetSnapshot, ImportOptions, ImportResult, PlanItem, Transaction, TransactionKind, TransactionSource } from './types';

type Cell = string | number | boolean | Date | null | undefined;
type Rows = Cell[][];
type InputFile = { name: string; arrayBuffer(): Promise<ArrayBuffer> };
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
const emptyResult = (source: TransactionSource): ImportResult => ({ source, transactions: [], planItems: [], snapshots: [], warnings: [] });

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
    const key = JSON.stringify([source, normalize(fields.account), fields.date, source === 'card' ? fields.month : '', normalize(fields.originalDescription), fields.amountCents, fields.installment ?? '']);
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
  return `Conta corrente Itaú${account ? ` • ${agency ? `${agency}/` : ''}${account}` : ''}`;
}

function cardAccount(value: Cell, fallback: string): string {
  const digits = text(value).replace(/\D/g, '');
  return `Cartão Itaú${digits.length >= 4 ? ` ****${digits.slice(-4)}` : fallback ? ` ****${fallback}` : ''}`;
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
  if (skipped) result.warnings.push(`${skipped} linha(s) com data e lançamento sem valor válido foram ignoradas.`);
  if (exportedDate && result.transactions.some(t => t.date > exportedDate)) result.warnings.push('O extrato contém movimentos com data posterior à atualização do arquivo. Eles foram preservados; revise se são lançamentos previstos ou datas de processamento bancário.');
  if (result.transactions.some(t => t.kind === 'transfer')) result.warnings.push('Pagamentos de cartão, aplicações e resgates identificáveis foram marcados como transferência para evitar duplicar gastos ou renda. Revise o tipo desses lançamentos.');
  result.summary = `${result.transactions.length} lançamentos da conta corrente. Saldos e totais foram ignorados.`;
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
  if (!month || !validMonth(month)) throw new Error('Não foi possível identificar o mês da fatura. Escolha a competência (AAAA-MM) antes de importar.');
  if (options.cardMonth && metadata.month && options.cardMonth !== metadata.month) result.warnings.push(`A competência escolhida (${options.cardMonth}) difere da fatura identificada (${metadata.month}).`);
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
  if (metadata.partialCents !== null && Math.abs(positiveCharges - metadata.partialCents) > 1) result.warnings.push('A soma das cobranças importadas difere do total informado na fatura. Confira estornos, pagamentos e lançamentos antes de fechar o mês.');
  if (skipped) result.warnings.push(`${skipped} lançamento(s) com data sem valor válido foram ignorados.`);
  result.warnings.push('A data é a data original da compra; o mês de orçamento é a competência da fatura. Compras antigas parceladas não foram lançadas novamente no mês da compra.');
  if (metadata.open) result.warnings.push('Esta fatura está aberta. Compras recentes e parcelas podem mudar até o fechamento; revise alterações de valor ao importar uma versão atualizada.');
  if (result.transactions.some(t => t.kind === 'transfer')) result.warnings.push('Pagamentos da fatura foram marcados como transferência e não entram em despesas ou receitas.');
  result.summary = `${result.transactions.length} lançamentos de cartão na competência ${month}.`;
  return result;
}

function parseBudget(workbook: XLSX.WorkBook, filename: string, options: ImportOptions): ImportResult | null {
  const planSheetName = workbook.SheetNames.find(name => /orcamento.*(?:medio|prazo)/.test(normalize(name)));
  const monthSheets = workbook.SheetNames.filter(name => MONTHS.includes(normalize(name)));
  if (!planSheetName && !monthSheets.length) return null;
  const result = emptyResult('budget');
  const updatedAt = new Date().toISOString();
  const planRows = planSheetName ? getRows(workbook.Sheets[planSheetName]) : [];
  const yearFromPlan = planRows.flat().map(readDate).find(Boolean)?.slice(0, 4);
  const yearFromHistory = monthSheets.flatMap(name => getRows(workbook.Sheets[name]).slice(0, 30).map(row => readDate(row[0]))).find(Boolean)?.slice(0, 4);
  const inferredYear = options.referenceYear ?? Number(filename.match(/(?:^|\D)(20\d{2})(?:\D|$)/)?.[1] ?? yearFromPlan ?? yearFromHistory ?? 0);
  if (monthSheets.length && (inferredYear < 1900 || inferredYear > 2200)) throw new Error('As abas mensais informam apenas o dia. Informe o ano de referência para importar o histórico.');
  const makeTransaction = createTransactionFactory('budget', filename);
  for (const sheetName of monthSheets) {
    const rows = getRows(workbook.Sheets[sheetName]);
    const index = headerIndex(rows, headers => (headers.includes('dia') || headers.includes('data')) && headers.includes('saida') && headers.includes('categoria'));
    if (index < 0) continue;
    const headers = rows[index].map(normalize);
    const dateCol = headers.findIndex(h => h === 'dia' || h === 'data');
    const labelCol = headers.findIndex(h => h === 'lancamento' || h === 'nome');
    const descriptionCol = headers.indexOf('descricao');
    const valueCol = headers.indexOf('saida');
    const categoryCol = headers.indexOf('categoria');
    const monthNumber = MONTHS.indexOf(normalize(sheetName)) + 1;
    const month = `${inferredYear}-${String(monthNumber).padStart(2, '0')}`;
    const categories: Record<string, number> = {};
    let expenseCents = 0;
    for (let i = index + 1; i < rows.length; i++) {
      const row = rows[i];
      const date = readDate(row[dateCol]) ?? isoDate(inferredYear, monthNumber, Number(row[dateCol]));
      const originalDescription = labelCol >= 0 ? text(row[labelCol]) : '';
      const rawCents = readCents(row[valueCol]);
      if (!date || !originalDescription || rawCents === null) continue;
      const category = text(row[categoryCol]);
      const kind: TransactionKind = normalize(category) === 'investimentos' || isTransfer(originalDescription) ? 'transfer' : 'expense';
      result.transactions.push(makeTransaction({ date, month: date.slice(0, 7), amountCents: -rawCents, kind, account: 'Histórico Budget', originalDescription, description: descriptionCol >= 0 ? text(row[descriptionCol]) : '', category, sourceRow: i + 1 }));
      if (kind === 'expense') {
        expenseCents += rawCents;
        const categoryName = category || 'Sem categoria';
        categories[categoryName] = (categories[categoryName] ?? 0) + rawCents;
      }
    }
    const snapshot: BudgetSnapshot = { id: `snapshot-${month}`, month, incomeCents: 0, expenseCents, categories, updatedAt };
    result.snapshots.push(snapshot);
  }
  if (monthSheets.length) result.warnings.push('Os totais históricos foram reconstruídos das linhas, incluindo todas as categorias de consumo. Investimentos foram marcados como transferência. Os resultados podem diferir de indicadores da planilha que excluam determinadas categorias.');
  if (planSheetName) {
    const monthHeader = planRows.findIndex(row => row.filter(v => readDate(v)?.endsWith('-01')).length >= 2);
    if (monthHeader >= 0) {
      const monthColumns = planRows[monthHeader].flatMap((cell, col) => { const date = readDate(cell); return date ? [{ col, month: date.slice(0, 7) }] : []; });
      let inResult = false;
      for (let i = monthHeader + 1; i < planRows.length; i++) {
        const row = planRows[i];
        const name = text(row[0]);
        const label = normalize(name);
        if (!name) continue;
        if (label === 'resultado') { inResult = true; continue; }
        if (/^(total|despesas|resultado mensal|indicadores|pms|pmr|pi|pnif)$/.test(label)) continue;
        if (label === 'reserva') {
          // Cached roll-forward results are not editable initial assumptions.
          const explicitReserve = monthColumns.find(({ col }) => workbook.Sheets[planSheetName][XLSX.utils.encode_cell({ r: i, c: col })]?.t === 'n' && !workbook.Sheets[planSheetName][XLSX.utils.encode_cell({ r: i, c: col })]?.f);
          if (explicitReserve) {
            const reserveCents = readCents(row[explicitReserve.col]);
            if (reserveCents !== null) result.suggestedSettings = { ...result.suggestedSettings, initialReserveCents: reserveCents, reserveStartMonth: explicitReserve.month, horizonMonths: monthColumns.filter(c => c.month >= explicitReserve.month).length };
          }
          continue;
        }
        if (inResult && label !== 'receita') continue;
        const amounts: Record<string, number> = {};
        for (const { col, month } of monthColumns) { const cents = readCents(row[col]); if (cents !== null) amounts[month] = cents; }
        const months = Object.keys(amounts).sort();
        if (!months.length) continue;
        const kind: PlanItem['kind'] = label === 'receita' ? 'income' : /aporte.*reserva|^investimento/.test(label) ? 'contribution' : 'expense';
        result.planItems.push({ id: `plan-${stableHash(normalize(name))}`, name, category: kind === 'contribution' ? 'Investimentos' : name, kind, defaultAmountCents: amounts[months.at(-1)!], amounts, startMonth: months[0], endMonth: months.at(-1), updatedAt });
      }
      result.warnings.push('O aporte mínimo foi preservado como meta de aporte. Como é uma transferência interna, não é descontado novamente da evolução da reserva; a planilha original já o devolve no cálculo da reserva do mês seguinte.');
      const invalidCells = Object.entries(workbook.Sheets[planSheetName]).filter(([key, cell]) => !key.startsWith('!') && (cell.t === 'e' || cell.f?.includes('#REF!'))).length;
      if (invalidCells) result.warnings.push('A projeção original contém referências quebradas ou divisões por zero. As fórmulas não foram copiadas; foram importados os valores de entrada e a primeira reserva explícita válida.');
    }
  }
  result.summary = `${result.transactions.length} lançamentos históricos, ${result.snapshots.length} meses e ${result.planItems.length} itens de planejamento.`;
  return result;
}

/** Parses source values only; spreadsheet formulas and embedded instructions are never executed. */
export function parseWorkbook(workbook: XLSX.WorkBook, filename: string, options: ImportOptions = {}): ImportResult {
  if (options.cardMonth && !validMonth(options.cardMonth)) throw new Error('Competência inválida. Use o formato AAAA-MM.');
  const budget = parseBudget(workbook, filename, options);
  if (budget) return budget;
  for (const name of workbook.SheetNames) {
    const rows = getRows(workbook.Sheets[name]);
    const card = parseCard(rows, name, filename, options);
    if (card) return card;
    const bank = parseBank(rows, filename);
    if (bank) return bank;
  }
  throw new Error('Formato não reconhecido. Use o Budget ou um extrato Itaú de conta corrente/cartão em XLS, XLSX ou CSV com cabeçalhos.');
}

export async function parseImport(file: File | InputFile, options: ImportOptions = {}): Promise<ImportResult> {
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > 30 * 1024 * 1024) throw new Error('O arquivo excede 30 MB. Exporte um período menor.');
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'array', cellDates: true, raw: true, cellFormula: true });
  } catch {
    throw new Error('Não foi possível ler a planilha. Confira se o arquivo é um XLS, XLSX ou CSV válido e não está protegido por senha.');
  }
  return parseWorkbook(workbook, file.name, options);
}
