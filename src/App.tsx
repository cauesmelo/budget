import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, ChevronLeft, ChevronRight, Cloud, Download, FileSpreadsheet, FolderUp, LayoutDashboard, Leaf, ListFilter, LoaderCircle, Plus, RefreshCw, Search, Settings2, ShieldCheck, Trash2, TrendingUp, Upload, Wallet, X, Tag } from 'lucide-react';
import type { FinanceData, PlanItem, Transaction } from './lib/types';
import { addMonths, applyImport, createEmptyData, formatMoney, formatMonth, getTransactionScope, isReportableTransaction, mergeFinanceData, parseMoneyToCents, planAmountForMonth, previewDuplicateCount, projectReserve, summarizeMonth } from './lib/finance';
import { loadData, saveData, serializeBackup, validateBackup } from './lib/storage';
import { APP_ID } from './lib/identity';
import { allCategoryNames, assertAvailableCategory, availableCategoryNames, categoryNameKey, listCategories } from './lib/categories';
import { CategorySelect } from './components/CategorySelect';
import { CategoryManager } from './components/CategoryManager';
import { CategoryReviewWizard } from './components/CategoryReviewWizard';
import { WorkSettings } from './components/WorkSettings';
import { MoneyInput } from './components/MoneyInput';
import { DecimalInput } from './components/DecimalInput';
import { formatMoneyAmount, formatNumber } from './lib/numbers';
import { PlanGrid, PlanGridRow } from './components/PlanGrid';
import { setPlanMonthAmount, setPlanMonthlyAmount } from './lib/planning';
import { appendPlanItem, getOrderedPlanItems, movePlanItem } from './lib/planOrder';
import { PlanningAssumptions, PlanningMetrics, PlanningIndicatorsTable } from './components/PlanningInsights';
import { BudgetComparisonCard, CategoryBreakdown } from './components/OverviewInsights';
import { ReserveGrowthChart } from './components/ReserveGrowthChart';
import { TransactionModal } from './components/TransactionModal';
import { createLocalSaveQueue } from './lib/localSave';
import { prepareImportReview } from './lib/importReview';
import { excludePreviewTransaction, undoPreviewExclusion, type PendingImport } from './lib/importPreview';
import { getManualTransactionKind, getTransactionFlowLabel } from './lib/transactionFlow';
import { getTransactionReportingMonth } from './lib/transactionMonth';
import { getSimilarUncategorizedExpenses } from './lib/categoryLearning';
import { getPendingCategoryReviews, needsTransactionCategory } from './lib/categoryReview';
import { connectDrive, disconnectDrive, isDriveConnected, syncDrive } from './lib/drive';

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const chartTick = { fontSize: 12, fill: 'var(--muted)' };
const chartTooltipStyle = { borderRadius: 10, borderColor: 'var(--border)', backgroundColor: '#fff', color: 'var(--ink)', fontSize: 12 };
const chartTooltipLabelStyle = { color: 'var(--ink)', fontWeight: 600 };
const chartTooltipItemStyle = { color: 'var(--ink)' };
const moneyAxis = (cents: number) => formatMoney(cents).replace(/R\$\s?/, '');
const sourceNames = { bank: 'Itaú account', card: 'Itaú card', manual: 'Manual' };
function cloudSignature(data: FinanceData) { const safe = JSON.parse(serializeBackup(data)); delete safe.updatedAt; return JSON.stringify(safe); }
const nav = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'transactions', label: 'Transactions', icon: ListFilter },
  { id: 'import', label: 'Import files', icon: FolderUp },
  { id: 'plan', label: 'Medium-term plan', icon: TrendingUp },
  { id: 'settings', label: 'Data and cloud', icon: Settings2 },
];

function Button({ children, onClick, secondary = false, disabled = false, type = 'button' }: { children: ReactNode; onClick?: () => void; secondary?: boolean; disabled?: boolean; type?: 'button' | 'submit' }) {
  return <button type={type} className={`button ${secondary ? 'secondary' : ''}`} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Leaf size={25} /></div><h3>{title}</h3><div>{children}</div></div>;
}

function Metric({ label, value, detail, icon, tint = false }: { label: string; value: string; detail: string; icon: ReactNode; tint?: boolean }) {
  return <div className={`metric ${tint ? 'tint' : ''}`}><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><small>{detail}</small></div>;
}
function WorkMetric({ label, incoming, outgoing, review }: { label: string; incoming: number; outgoing: number; review: () => void }) {
  return <section className="metric work-metric" aria-label={`${label} cash flow`}><div className="metric-top"><span>{label} in / out</span><span className="metric-icon"><RefreshCw size={18} /></span></div><dl className="work-cash-flow"><div><dt><ArrowDownLeft size={13} /> In</dt><dd>{formatMoney(incoming)}</dd></div><div><dt><ArrowUpRight size={13} /> Out</dt><dd>{formatMoney(outgoing)}</dd></div></dl><button className="text-button" onClick={review}>Review {label} transactions <ArrowRight size={13} /></button><small>Excluded from personal income and expenses</small></section>;
}

function TxTable({ transactions, categories, data, update, remove, removeMode = 'delete', applyCategory }: { transactions: Transaction[]; categories: string[]; data: FinanceData; update: (id: string, patch: Partial<Transaction>) => void; remove?: (id: string) => void; removeMode?: 'delete' | 'exclude'; applyCategory?: (id: string) => void }) {
  const workLabel = data.work?.label || 'Work';
  const exclude = removeMode === 'exclude';
  return <div className="table-scroll"><table className="tx-table"><thead><tr><th>Date</th><th>Transaction</th><th>Description</th><th>Category</th><th className="right">Amount</th>{remove && <th className={exclude ? 'preview-row-action' : undefined}>{exclude ? 'Exclude' : ''}</th>}<th scope="col" className="work-column" title={`Check ${workLabel} expenses and reimbursements`}><span>{workLabel}</span></th></tr></thead><tbody>{transactions.map(tx => {
    const scope = getTransactionScope(data, tx);
    const similar = applyCategory ? getSimilarUncategorizedExpenses(data, tx.id) : [];
    const needsCategory = needsTransactionCategory(tx);
    return <tr key={tx.id} data-transaction-id={tx.id} className={needsCategory ? 'needs-category' : undefined}>
      <td className="date-cell">{tx.date.split('-').reverse().join('/')}<small>{sourceNames[tx.source]}</small></td>
      <td className="original"><span title={tx.originalDescription}>{tx.originalDescription}</span>{tx.installment && <small>{tx.installment}</small>}{needsCategory && <small className="category-needed"><Tag size={11} aria-hidden="true" /> Needs category</small>}</td>
      <td><input aria-label={`Description for ${tx.originalDescription}`} placeholder="Add description" value={tx.description} onChange={e => update(tx.id, { description: e.target.value })} /></td>
      <td><CategorySelect label={`Category for ${tx.originalDescription}`} options={categories} value={tx.category} onChange={category => update(tx.id, { category })} />{similar.length > 0 && <button type="button" className="text-button apply-category" onClick={() => applyCategory?.(tx.id)} title={`Apply ${tx.category} to uncategorized expenses from the same merchant, account, and scope`}>Apply to {formatNumber(similar.length)} similar</button>}</td>
      <td className={`right amount ${tx.kind === 'transfer' ? 'muted' : tx.amountCents > 0 ? 'green' : ''}`}>{formatMoney(tx.amountCents)}<small className="transaction-flow-label" title={tx.kind === 'transfer' ? 'Excluded from income and spending. Remove this row if you do not want to keep it.' : undefined}>{getTransactionFlowLabel(tx, scope)}</small></td>
      {remove && <td className={exclude ? 'preview-row-action' : undefined}><button type="button" className="icon-button danger" title={exclude ? 'Exclude from this import' : 'Delete transaction'} aria-label={exclude ? `Exclude ${tx.originalDescription} from import` : `Delete ${tx.originalDescription}`} onClick={event => {
        const row = event.currentTarget.closest('tr');
        const adjacent = row?.nextElementSibling ?? row?.previousElementSibling;
        const preview = event.currentTarget.closest('.preview');
        remove(tx.id);
        if (exclude) requestAnimationFrame(() => {
          const nextButton = adjacent?.isConnected ? adjacent.querySelector<HTMLButtonElement>('.preview-row-action button') : null;
          (nextButton ?? preview?.querySelector<HTMLButtonElement>('[data-undo-exclusion]'))?.focus({ preventScroll: true });
        });
      }}><Trash2 size={16} /></button></td>}
      <td className="work-column"><label className="work-checkbox" title={scope === 'work' ? `${workLabel} expense or reimbursement` : 'Personal transaction'}><input type="checkbox" aria-label={`Mark ${tx.originalDescription} as ${workLabel}`} checked={scope === 'work'} onChange={event => update(tx.id, { scope: event.target.checked ? 'work' : 'personal' })} /></label></td>
    </tr>;
  })}</tbody></table></div>;
}

export default function App() {
  const [data, setData] = useState<FinanceData>(() => createEmptyData());
  const [loaded, setLoaded] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [page, setPage] = useState('overview');
  const [month, setMonth] = useState(today().slice(0, 7));
  const [notification, setNotification] = useState('');
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState('Saved in this browser');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(isDriveConnected());
  const [lastSync, setLastSync] = useState('');
  const [lastSyncedSignature, setLastSyncedSignature] = useState('');
  const [editingAmount, setEditingAmount] = useState(false);
  const [undo, setUndo] = useState<{ kind: 'transaction' | 'plan'; id: string; name: string; deletedAt: string } | null>(null);
  const [focusPlanId, setFocusPlanId] = useState('');
  const [pending, setPending] = useState<PendingImport[]>([]);
  const [previewOffsets, setPreviewOffsets] = useState<Record<number, number>>({});
  const [cardMonth, setCardMonth] = useState(today().slice(0, 7));
  const [overrideCardMonth, setOverrideCardMonth] = useState(false);
  const [query, setQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [filterScope, setFilterScope] = useState('');
  const [offset, setOffset] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  const categoryTrigger = useRef<HTMLElement | null>(null);
  const manualTrigger = useRef<HTMLElement | null>(null);
  const closeCategoryManager = useCallback(() => { setShowCategoryManager(false); requestAnimationFrame(() => categoryTrigger.current?.focus()); }, []);
  const closeManual = useCallback(() => setShowAdd(false), []);
  const [addScope, setAddScope] = useState<'personal' | 'work'>('personal');
  const [addDate, setAddDate] = useState(today());
  const [addDescription, setAddDescription] = useState('');
  const [addCategory, setAddCategory] = useState('');
  const [addAmount, setAddAmount] = useState('');
  const [planOffset, setPlanOffset] = useState(0);
  const [planningMonth, setPlanningMonth] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const startMonth = data.reporting?.startMonth;
  const heading = useRef<HTMLHeadingElement>(null);
  const filesToRetry = useRef<File[]>([]);
  const storageReady = useRef(false);
  const persistentStorage = useRef(true);
  const startupMessages = useRef<FinanceData[]>([]);
  const localSave = useRef<ReturnType<typeof createLocalSaveQueue> | null>(null);
  if (!localSave.current) localSave.current = createLocalSaveQueue(saveData);
  const saveRevision = useRef(0);
  const lastQueuedData = useRef<FinanceData | null>(null);
  const queueLocalSave = useCallback((snapshot: FinanceData) => {
    if (!storageReady.current || !persistentStorage.current || lastQueuedData.current === snapshot) return;
    lastQueuedData.current = snapshot;
    const revision = ++saveRevision.current;
    setSaveStatus('Saving in this browser…');
    void localSave.current!.save(snapshot).then(() => {
      if (saveRevision.current !== revision) return;
      setSaveStatus('Saved in this browser');
      setError(current => current.startsWith('Your data is still in memory.') ? '' : current);
    }).catch(error => {
      if (saveRevision.current !== revision) return;
      setSaveStatus('Save failed');
      setError(`Your data is still in memory. Retry saving or export a backup: ${error.message}`);
    });
  }, []);


  useEffect(() => {
    let active = true;
    function initialize(saved: FinanceData | null) {
      let initial = saved ?? dataRef.current;
      const messages = startupMessages.current.splice(0);
      for (const incoming of messages) {
        try { initial = validateBackup(mergeFinanceData(initial, incoming)); }
        catch { /* Retain the last valid state if a combined snapshot is invalid. */ }
      }
      if (saved && !messages.length) lastQueuedData.current = saved;
      dataRef.current = initial;
      storageReady.current = true;
      setData(initial);
      setLoaded(true);
    }
    loadData().then(saved => {
      if (active) initialize(saved);
    }).catch(e => {
      if (!active) return;
      persistentStorage.current = false;
      setStorageAvailable(false);
      initialize(null);
      setError(`Could not open local data. You can use a temporary session and export a backup: ${e.message}`);
      setSaveStatus('Temporary session · export a backup');
    });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (loaded && storageAvailable) queueLocalSave(data); }, [data, loaded, storageAvailable, queueLocalSave]);
  useEffect(() => {
    const flush = () => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); void localSave.current?.flush().catch(() => {}); };
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  useEffect(() => { window.scrollTo(0, 0); setEditingAmount(false); const frame = requestAnimationFrame(() => { if (page !== 'review') heading.current?.focus({ preventScroll: true }); }); return () => cancelAnimationFrame(frame); }, [page]);
  useEffect(() => { if (!undo) return; const timer = setTimeout(() => setUndo(null), 10000); return () => clearTimeout(timer); }, [undo]);
  useEffect(() => {
    if (!focusPlanId) return;
    const frame = requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(`[data-plan-id="${focusPlanId}"] input[aria-label="Item name"]`);
      if (input) { input.focus({ preventScroll: true }); input.select(); input.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      setFocusPlanId('');
    });
    return () => cancelAnimationFrame(frame);
  }, [focusPlanId, data.planItems]);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(`${APP_ID}-data`); channel.current = ch;
    ch.onmessage = e => {
      try {
        const incoming = validateBackup(e.data);
        if (!storageReady.current) { startupMessages.current.push(incoming); return; }
        const next = validateBackup(mergeFinanceData(dataRef.current, incoming));
        dataRef.current = next; setData(next); queueLocalSave(next);
      } catch { /* Ignore invalid or unrelated messages. */ }
    };
    return () => { ch.close(); channel.current = null; };
  }, [queueLocalSave]);
  useEffect(() => { setOffset(0); }, [month, query, filterCategory, filterSource, filterScope]);
  useEffect(() => {
    if (!startMonth) return;
    setMonth(current => current < startMonth ? startMonth : current);
    setCardMonth(current => current < startMonth ? startMonth : current);
    setAddDate(current => current.slice(0, 7) < startMonth ? `${startMonth}-01` : current);
  }, [startMonth]);
  useEffect(() => {
    if (!filterCategory.startsWith('category:')) return;
    const selected = categoryNameKey(filterCategory.slice(9));
    const current = listCategories(data).find(category => [category.name, ...(category.aliases ?? [])].some(name => categoryNameKey(name) === selected));
    const nextFilter = current ? `category:${current.name}` : '';
    if (nextFilter !== filterCategory) setFilterCategory(nextFilter);
  }, [data.categories, filterCategory]);
  useEffect(() => {
    if (!addCategory) return;
    const selected = categoryNameKey(addCategory);
    const current = listCategories(data).find(category => !category.archivedAt && [category.name, ...(category.aliases ?? [])].some(name => categoryNameKey(name) === selected));
    const nextCategory = current?.name ?? '';
    if (nextCategory !== addCategory) setAddCategory(nextCategory);
  }, [data.categories, addCategory]);
  useEffect(() => { setPlanOffset(0); }, [data.settings.horizonMonths, data.settings.reserveStartMonth]);
  useEffect(() => { if (!notification) return; const t = setTimeout(() => setNotification(''), 6000); return () => clearTimeout(t); }, [notification]);

  function change(edit: (current: FinanceData) => FinanceData) {
    try {
      const next = validateBackup({ ...edit(dataRef.current), updatedAt: new Date().toISOString() });
      dataRef.current = next; setData(next); queueLocalSave(next);
      channel.current?.postMessage(JSON.parse(serializeBackup(next)));
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : 'Check the values you entered.'); return false; }
  }
  function patchSettings(patch: Partial<FinanceData['settings']>) {
    if (patch.reserveStartMonth && startMonth && patch.reserveStartMonth < startMonth) { setError(`Choose a planning month from ${formatMonth(startMonth)} onward.`); return false; }
    return change(d => ({ ...d, settings: { ...d.settings, ...patch, updatedAt: Object.keys(patch).some(key => key !== 'googleClientId') ? new Date().toISOString() : d.settings.updatedAt } }));
  }
  function patchTx(id: string, patch: Partial<Transaction>) {
    const existing = dataRef.current.transactions.find(item => item.id === id && !item.deletedAt);
    if (!existing) return false;
    const changed = change(d => {
      if (patch.category !== undefined) assertAvailableCategory(d, patch.category);
      return { ...d, transactions: d.transactions.map(item => item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item) };
    });
    if (changed && patch.deletedAt) setUndo({ kind: 'transaction', id, name: existing.description || existing.originalDescription, deletedAt: patch.deletedAt });
    return changed;
  }
  function applySimilarCategory(id: string) {
    let count = 0;
    const changed = change(current => {
      const source = current.transactions.find(item => item.id === id);
      const targets = getSimilarUncategorizedExpenses(current, id);
      if (!source || !targets.length) return current;
      const category = listCategories(current).find(item => !item.archivedAt && [item.name, ...(item.aliases ?? [])].some(name => categoryNameKey(name) === categoryNameKey(source.category)))!.name;
      const ids = new Set(targets.map(item => item.id));
      count = ids.size;
      const stamp = new Date().toISOString();
      return { ...current, transactions: current.transactions.map(item => ids.has(item.id) ? { ...item, category, updatedAt: stamp } : item) };
    });
    if (changed && count) setNotification(`Category applied to ${formatNumber(count)} similar ${count === 1 ? 'expense' : 'expenses'}.`);
  }
  function saveCategoryReview(transaction: Transaction, category: string, description: string) {
    return change(current => {
      const existing = current.transactions.find(item => item.id === transaction.id);
      if (!existing || existing.deletedAt || !needsTransactionCategory(existing) || existing.updatedAt !== transaction.updatedAt || !isReportableTransaction(current, existing)) throw new Error('This transaction changed elsewhere. Review its latest details before continuing.');
      if (!category) throw new Error('Choose a category before continuing.');
      assertAvailableCategory(current, category);
      return { ...current, transactions: current.transactions.map(item => item.id === existing.id ? { ...item, category, description, updatedAt: new Date().toISOString() } : item) };
    });
  }
  function undoDelete() {
    if (!undo) return;
    const accepted = change(current => {
      const records = undo.kind === 'transaction' ? current.transactions : current.planItems;
      const record = records.find(item => item.id === undo.id);
      if (!record || record.deletedAt !== undo.deletedAt) throw new Error('This item has changed since deletion. Restore a backup if you still need it.');
      const stamp = new Date().toISOString();
      if (undo.kind === 'transaction') return { ...current, transactions: current.transactions.map(item => item.id === undo.id ? { ...item, deletedAt: undefined, updatedAt: stamp } : item) };
      return { ...current, planItems: current.planItems.map(item => item.id === undo.id ? { ...item, deletedAt: undefined, updatedAt: stamp } : item) };
    });
    if (accepted) { setUndo(null); setNotification('Item restored.'); }
  }
  function openCategoryManager() { categoryTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setShowCategoryManager(true); }

  function patchPlan(id: string, patch: Partial<PlanItem>) {
    const existing = dataRef.current.planItems.find(p => p.id === id);
    if (existing) { const next = { ...existing, ...patch }; if (next.endMonth && next.endMonth < next.startMonth) { setError('The end month must be the same as or later than the start month.'); return false; } }
    if (!existing || existing.deletedAt) return false;
    const changed = change(d => {
      if (patch.category !== undefined) assertAvailableCategory(d, patch.category);
      return { ...d, planItems: d.planItems.map(p => p.id === id ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p) };
    });
    if (changed && patch.deletedAt) setUndo({ kind: 'plan', id, name: existing.name, deletedAt: patch.deletedAt });
    return changed;
  }
  function editPlanMonthly(id: string, amountCents: number) {
    return change(current => {
      const stamp = new Date().toISOString();
      if (!id) return { ...current, planItems: [...current.planItems, { id: crypto.randomUUID(), name: 'Planned income', category: '', kind: 'income', behavior: 'fixed', defaultAmountCents: amountCents, amounts: {}, startMonth: current.settings.reserveStartMonth, updatedAt: stamp }] };
      const item = current.planItems.find(row => row.id === id && !row.deletedAt);
      if (!item) throw new Error('This planning item is no longer available.');
      return { ...current, planItems: current.planItems.map(row => row.id === id ? setPlanMonthlyAmount(item, amountCents, stamp) : row) };
    });
  }
  function reorderPlan(id: string, direction: 'up' | 'down') {
    const current = dataRef.current;
    const item = current.planItems.find(row => row.id === id && !row.deletedAt);
    if (!item || item.kind === 'income') return false;
    const firstMonth = current.settings.reserveStartMonth;
    const lastMonth = addMonths(firstMonth, current.settings.horizonMonths - 1);
    const visibleIds = getOrderedPlanItems(current).filter(row => !row.deletedAt && row.kind === item.kind && row.startMonth <= lastMonth && (!row.endMonth || row.endMonth >= firstMonth)).map(row => row.id);
    const next = movePlanItem(current, id, direction, visibleIds, new Date().toISOString());
    return next === current ? false : change(() => next);
  }
  function editPlanMonth(id: string, editedMonth: string, amountCents: number) {
    return change(current => {
      const stamp = new Date().toISOString();
      if (!id) return { ...current, planItems: [...current.planItems, { id: crypto.randomUUID(), name: 'Planned income', category: '', kind: 'income', behavior: 'fixed', defaultAmountCents: 0, amounts: { [editedMonth]: amountCents }, startMonth: current.settings.reserveStartMonth, updatedAt: stamp }] };
      const item = current.planItems.find(row => row.id === id && !row.deletedAt);
      if (!item) throw new Error('This planning item is no longer available.');
      const next = validateBackup({ ...current, planItems: current.planItems.map(row => row.id === id ? setPlanMonthAmount(item, editedMonth, amountCents, stamp) : row) });
      if (planAmountForMonth(next.planItems.find(row => row.id === id)!, editedMonth) !== amountCents) throw new Error('This month is covered by another saved row. Edit that row instead.');
      return next;
    });
  }
  const categories = availableCategoryNames(data);
  const filterCategories = allCategoryNames(data);
  const workLabel = data.work?.label || 'Work';
  function manageCategories(edit: (current: FinanceData) => FinanceData) {
    const next = edit(dataRef.current);
    return change(() => next);
  }
  const activeTx = data.transactions.filter(t => !t.deletedAt && isReportableTransaction(data, t));
  const monthTx = activeTx.filter(t => getTransactionReportingMonth(t) === month);
  const filtered = monthTx.filter(t => (!filterCategory || (filterCategory === '__empty' ? needsTransactionCategory(t) : t.category === filterCategory.slice(9))) && (!filterSource || t.source === filterSource) && (!filterScope || getTransactionScope(data, t) === filterScope) && `${t.originalDescription} ${t.description} ${t.category}`.toLocaleLowerCase('pt-BR').includes(query.toLocaleLowerCase('pt-BR'))).sort((a, b) => b.date.localeCompare(a.date) || a.originalDescription.localeCompare(b.originalDescription));
  const summary = summarizeMonth(data, month);
  const projection = projectReserve(data);
  const visiblePlanOffset = Math.min(planOffset, Math.floor((projection.length - 1) / 6) * 6);
  const visiblePlanningMonths = projection.slice(visiblePlanOffset, visiblePlanOffset + 6);
  const selectedPlanningMonth = projection.some(row => row.month === planningMonth) ? planningMonth : projection[0].month;
  const modalOpen = showCategoryManager || showAdd;
  function selectPlanningMonth(nextMonth: string) {
    setPlanningMonth(nextMonth);
    const index = projection.findIndex(row => row.month === nextMonth);
    if (index >= 0) setPlanOffset(Math.floor(index / 6) * 6);
  }
  const horizonPlanItems = getOrderedPlanItems(data).filter(item => !item.deletedAt && item.startMonth <= projection.at(-1)!.month && (!item.endMonth || item.endMonth >= projection[0].month));
  const expensePlanItems = horizonPlanItems.filter(item => item.kind === 'expense');
  const incomePlanItems = horizonPlanItems.filter(item => item.kind === 'income');
  const targetPlanItems = horizonPlanItems.filter(item => item.kind === 'contribution');
  const incomeRows: PlanItem[] = incomePlanItems.length ? incomePlanItems : [{ id: '', name: 'Planned income', category: '', kind: 'income', defaultAmountCents: 0, amounts: {}, startMonth: data.settings.reserveStartMonth, updatedAt: data.updatedAt }];
  const shownMonth = visiblePlanningMonths[0] ?? projection[0];
  const monthlyHistory = Array.from({ length: 6 }, (_, i) => addMonths(month, i - 5)).filter(item => !startMonth || item >= startMonth).map(item => summarizeMonth(data, item));
  const savings = summary.incomeCents > 0 ? Math.round(summary.netCents / summary.incomeCents * 100) : null;
  const categoryReviewQueue = useMemo(() => getPendingCategoryReviews(data), [data]);
  function reviewTransactions(scope: 'personal' | 'work', uncategorized = false) {
    setPage('transactions'); setFilterScope(scope); setFilterCategory(uncategorized ? '__empty' : ''); setFilterSource(''); setQuery(''); setOffset(0);
  }
  const finalProjection = projection.at(-1);
  const settingsClientId = data.settings.googleClientId || import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
  const currentCloudSignature = useMemo(() => cloudSignature(data), [data]);
  const unsynced = currentCloudSignature !== lastSyncedSignature;
  const importPreviews = useMemo(() => {
    let prior = data;
    return pending.map(item => {
      const duplicates = previewDuplicateCount(prior, item.result);
      const possibleDuplicates = prepareImportReview(prior, item.result).possibleDuplicates;
      prior = applyImport(prior, item.result, item.name);
      return { ...item, duplicates, newCount: item.result.transactions.length - duplicates, possibleDuplicates };
    });
  }, [data, pending]);

  function excludePendingRow(fileIndex: number, id: string) {
    setPending(current => current.map((item, index) => index === fileIndex ? excludePreviewTransaction(item, id) : item));
  }

  function undoPendingRow(fileIndex: number, trigger: HTMLButtonElement) {
    const restoredId = pending[fileIndex]?.excluded?.at(-1)?.transaction.id;
    const preview = trigger.closest('.preview');
    setPending(current => current.map((item, index) => index === fileIndex ? undoPreviewExclusion(item) : item));
    requestAnimationFrame(() => {
      if (trigger.isConnected) return;
      const visibleRows = Array.from(preview?.querySelectorAll<HTMLTableRowElement>('[data-transaction-id]') ?? []);
      const restoredRow = visibleRows.find(row => row.dataset.transactionId === restoredId) ?? visibleRows[0];
      restoredRow?.querySelector<HTMLButtonElement>('.preview-row-action button')?.focus({ preventScroll: true });
    });
  }

  async function importFiles(files: FileList | File[]) {
    setBusy(true); setError(''); filesToRetry.current = Array.from(files);
    try {
      const { parseImport } = await import('./lib/importers');
      const imports = [];
      for (const file of Array.from(files)) {
        const result = await parseImport(file, overrideCardMonth ? { cardMonth } : {});
        const transactions = result.transactions.filter(item => isReportableTransaction(dataRef.current, item));
        const skipped = result.transactions.length - transactions.length;
        const reviewed = prepareImportReview(dataRef.current, { ...result, transactions, warnings: [...result.warnings, ...(skipped ? [`${formatNumber(skipped)} ${skipped === 1 ? 'transaction' : 'transactions'} before ${formatMonth(startMonth!)} ${skipped === 1 ? 'was' : 'were'} excluded.`] : [])] });
        imports.push({ name: file.name, result: reviewed.result, learnedCount: reviewed.learnedCount });
      }
      setPending(imports); setPreviewOffsets({}); setPage('import');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read this file.'); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  function confirmImports() {
    if (!pending.some(item => item.result.transactions.length > 0)) return;
    let next = dataRef.current; let count = 0;
    for (const item of pending) { const before = next.transactions.length; next = applyImport(next, item.result, item.name); count += next.transactions.length - before; }
    if (!change(() => next)) return;
    const latest = next.transactions.filter(t => !t.deletedAt && isReportableTransaction(next, t)).map(getTransactionReportingMonth).sort().at(-1);
    if (latest) setMonth(latest);
    setPending([]); setNotification(`Import complete. ${formatNumber(count)} new transactions; existing records were preserved without duplicates.`); setPage('overview');
  }
  function downloadBackup() {
    const url = URL.createObjectURL(new Blob([serializeBackup(data)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${APP_ID}-backup-${today()}.json`; a.click(); URL.revokeObjectURL(url); setNotification('Backup exported.');
  }
  async function restoreBackup(file: File) {
    try { const restored = validateBackup(await file.text()); if (change(d => mergeFinanceData(d, restored))) setNotification('Backup validated and merged with your local data.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Invalid backup.'); }
    finally { if (backupInput.current) backupInput.current.value = ''; }
  }
  async function sync() {
    setBusy(true); setError('');
    try {
      if (!isDriveConnected()) await connectDrive(settingsClientId);
      setConnected(true);
      const result = await syncDrive(dataRef.current);
      if (change(current => mergeFinanceData(current, result.data))) { setLastSync(result.syncedAt); setLastSyncedSignature(cloudSignature(result.data)); setNotification(cloudSignature(dataRef.current) === cloudSignature(result.data) ? 'Data synced with Google Drive.' : 'Drive synced. Newer local edits still need another sync.'); }
    } catch (e) { setConnected(isDriveConnected()); setError(e instanceof Error ? e.message : 'Could not sync data.'); }
    finally { setBusy(false); }
  }
  function normalizeManualAmount() {
    if (!addAmount.trim()) return;
    try { setAddAmount(formatMoneyAmount(parseMoneyToCents(addAmount))); }
    catch { /* Keep invalid input visible for form validation. */ }
  }
  function submitManual() {
    let cents: number;
    try { assertAvailableCategory(dataRef.current, addCategory); }
    catch (e) { setError(e instanceof Error ? e.message : 'Choose an available category.'); return; }
    try { cents = parseMoneyToCents(addAmount); }
    catch { setError('Enter a valid amount, such as 1.234,56.'); return; }
    if (!Number.isSafeInteger(cents) || cents === 0 || !addDescription.trim() || !addDate) { setError('Enter a date, a description, and a non-zero amount. Use a minus sign for expenses.'); return; }
    if (startMonth && addDate.slice(0, 7) < startMonth) { setError(`Choose a date from ${formatMonth(startMonth)} onward.`); return; }
    const id = crypto.randomUUID(); const stamp = new Date().toISOString();
    const added = change(d => ({ ...d, transactions: [...d.transactions, { id, fingerprint: `manual:${id}`, date: addDate, month: addDate.slice(0, 7), amountCents: cents, kind: getManualTransactionKind(cents), scope: addScope, source: 'manual', account: 'Manual', originalDescription: addDescription.trim(), description: addDescription.trim(), category: addCategory, updatedAt: stamp }] }));
    if (!added) return;
    setShowAdd(false); setError(''); setMonth(addDate.slice(0, 7)); setAddDescription(''); setAddAmount(''); setAddScope('personal'); setNotification('Transaction added.');
  }
  function addPlan(kind: PlanItem['kind'] = 'expense') {
    const names = { expense: 'New expense', income: 'Planned income', contribution: 'Reserve target' };
    const now = new Date().toISOString(), id = crypto.randomUUID();
    if (change(d => appendPlanItem(d, { id, name: names[kind], category: '', kind, defaultAmountCents: 0, amounts: {}, startMonth: d.settings.reserveStartMonth, updatedAt: now }, now))) setFocusPlanId(id);
  }

  let manualFlowLabel = '';
  if (showAdd && addAmount.trim()) {
    try {
      const amountCents = parseMoneyToCents(addAmount);
      manualFlowLabel = getTransactionFlowLabel({ amountCents, kind: getManualTransactionKind(amountCents) }, addScope);
    } catch { /* Keep invalid or incomplete input available for correction. */ }
  }

  if (!loaded) return <div className="loading-screen"><LoaderCircle className="spin" /> Loading your finances…{error && <p>{error}</p>}</div>;
  return <div className="app-shell">
    <aside className="sidebar" inert={modalOpen || undefined}><a className="brand" href="#" aria-label="Budget · home" onClick={e => { e.preventDefault(); setPage('overview'); }}><img className="brand-lockup" src={`${import.meta.env.BASE_URL}brand/budget-app.svg`} alt="" aria-hidden="true" /><img className="brand-symbol" src={`${import.meta.env.BASE_URL}brand/budget-leaf.svg`} alt="" aria-hidden="true" /></a><p className="nav-caption">YOUR FINANCES</p><nav>{nav.map(item => <button key={item.id} onClick={() => setPage(item.id)} aria-current={(page === 'review' ? 'transactions' : page) === item.id ? 'page' : undefined} className={(page === 'review' ? 'transactions' : page) === item.id ? 'active' : ''}><item.icon size={19} />{item.label}{item.id === 'import' && <span className="nav-plus">+</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><ShieldCheck size={21} /><p>Your data, with you.<small>Local storage and optional cloud sync.</small></p></div><div className="profile"><div className="avatar">ME</div><div>My budget<small>Personal finances</small></div><span className="status-dot" /></div></div>
    </aside>
    <main className="main" inert={modalOpen || undefined} onFocusCapture={event => { if ((event.target as HTMLElement).matches('input[data-money-input], input[data-number-input]')) setEditingAmount(true); }} onBlurCapture={event => { if ((event.target as HTMLElement).matches('input[data-money-input], input[data-number-input]')) setEditingAmount(false); }}><header className="topbar"><span>MY SPACE <span className="separator">/</span> <strong>{page === 'review' ? 'Review categories' : nav.find(n => n.id === page)?.label}</strong></span><div className="save-indicator"><span className={saveStatus.startsWith('Save failed') ? 'status-dot red' : 'status-dot'} /><span className="local-save-status" role="status" aria-live="polite" title={editingAmount ? 'Editing amount · press Enter to save' : saveStatus}>{editingAmount ? 'Editing amount · Enter to save' : saveStatus}</span>{saveStatus.startsWith('Save failed') && <button className="text-button" onClick={() => { lastQueuedData.current = null; queueLocalSave(dataRef.current); }}>Retry save</button>}{settingsClientId && <button className="header-sync" disabled={busy} onClick={() => void sync()} aria-label={unsynced ? 'Sync local changes to Drive' : 'Sync Google Drive'} title={lastSync ? unsynced ? 'Local changes are not synced' : 'Synced with Drive' : 'Not synced in this session'}><RefreshCw size={15} className={busy ? 'spin' : undefined} /><span>{unsynced ? 'Sync changes' : 'Synced'}</span></button>}<button className="icon-button" onClick={() => setPage('settings')} title="Data and cloud"><Cloud size={18} /></button></div></header>
      <div className="page-content">
      {error && <div role="alert" className="alert error"><span>{error}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setError('')}><X size={18} /></button></div>}
      {notification && <div role="status" className="alert success"><Check size={18} />{notification}</div>}
      <div className="page-heading"><div><div className="eyebrow">{page === 'plan' ? 'LOOK AHEAD' : page === 'overview' ? 'ONE STEP AT A TIME' : 'YOUR BUDGET, ORGANIZED'}</div><h1 ref={heading} tabIndex={-1}>{page === 'review' ? 'One transaction at a time.' : page === 'overview' ? 'Clarity for your money.' : page === 'transactions' ? 'Every transaction in its place.' : page === 'import' ? 'From your statement to your budget.' : page === 'plan' ? 'Make room for your plans.' : 'Your data, wherever you are.'}</h1><p>{page === 'review' ? 'Choose a category, add an optional description, and press Enter to continue.' : page === 'overview' ? 'Track your month and see where your money goes.' : page === 'transactions' ? 'Review transactions and add categories and descriptions.' : page === 'import' ? 'Import your Itaú account and card statements.' : page === 'plan' ? 'Enter your future budget and see how your reserve grows.' : 'Work in your browser and sync across computers whenever you need.'}</p></div>{['overview', 'transactions'].includes(page) && <Button onClick={() => setPage('import')}><Plus size={17} /> Import statement</Button>}</div>
      {['overview', 'transactions'].includes(page) && <div className="period-bar"><div className="month-switch"><button className="icon-button" aria-label="Previous month" disabled={Boolean(startMonth && month <= startMonth)} onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={18} /></button><input type="month" aria-label="Selected month" min={startMonth} value={month} onChange={e => e.target.value && (!startMonth || e.target.value >= startMonth) && setMonth(e.target.value)} /><button className="icon-button" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight size={18} /></button></div><div className="reporting-period">{startMonth ? `Tracking from ${formatMonth(startMonth)}` : 'Account, card, and manual transactions'}</div></div>}

      {page === 'overview' && <>
        {categoryReviewQueue.length > 0 && <div className="category-review-banner"><span><Tag size={15} />{formatNumber(categoryReviewQueue.length)} {categoryReviewQueue.length === 1 ? 'transaction needs' : 'transactions need'} a category · all months</span><button className="text-button" onClick={() => setPage('review')}>Review categories <ArrowRight size={14} /></button></div>}
        <div className="metrics"><Metric label="Recorded income" value={formatMoney(summary.incomeCents)} detail={`${formatMonth(month)} · imported and manual records`} icon={<ArrowDownLeft size={18} />} /><Metric label="Recorded spending" value={formatMoney(summary.expenseCents)} detail="Personal spending, net of refunds" icon={<ArrowUpRight size={18} />} /><Metric label="Recorded surplus" value={formatMoney(summary.netCents)} detail={savings === null ? 'Recorded income minus spending' : `${formatNumber(savings)}% of recorded income remaining`} icon={<Wallet size={18} />} tint /><WorkMetric label={workLabel} incoming={summary.workInCents} outgoing={summary.workOutCents} review={() => reviewTransactions('work')} /></div>
        {activeTx.length > 0 && summary.count === 0 && <div className="month-data-note">No personal transactions recorded for {formatMonth(month)}. Import statements to build this month’s picture.</div>}
        {!activeTx.length && <div className="welcome"><div><span className="pill">LET’S GET STARTED</span><h2>Start with a clear picture.</h2><p>Import your account and card statements, then add categories and descriptions as you go.</p><Button onClick={() => setPage('import')}>Import my files <ArrowRight size={17} /></Button></div><div className="welcome-art"><FileSpreadsheet size={72} strokeWidth={1} /><span className="art-dot" /></div></div>}
        <div className="charts-grid"><section className="panel"><div className="panel-header"><div><h2>Income and expenses</h2><p>{monthlyHistory.length === 1 ? 'Your personal activity this month' : `Your personal activity over ${formatNumber(monthlyHistory.length)} months`}</p></div><span className="pill subdued">MONTHLY</span></div><div className="chart-legend"><span><i style={{ background: 'var(--green)' }} />Income</span><span><i style={{ background: 'var(--chart-spending)' }} />Expenses</span></div><div className="chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={monthlyHistory} margin={{ top: 10, right: 5, left: 8, bottom: 0 }}><CartesianGrid strokeDasharray="3 4" vertical={false} stroke="var(--chart-grid)" /><XAxis dataKey="month" tickFormatter={m => formatMonth(m).split(' ')[0]} axisLine={false} tickLine={false} tick={chartTick} dy={8} /><YAxis tickFormatter={moneyAxis} axisLine={false} tickLine={false} width="auto" tick={chartTick} /><Tooltip contentStyle={chartTooltipStyle} labelStyle={chartTooltipLabelStyle} itemStyle={chartTooltipItemStyle} formatter={v => formatMoney(Number(v))} labelFormatter={m => formatMonth(String(m))} /><Bar isAnimationActive={false} dataKey="incomeCents" name="Income" fill="var(--green)" radius={[5, 5, 0, 0]} maxBarSize={23} /><Bar isAnimationActive={false} dataKey="expenseCents" name="Expenses" fill="var(--chart-spending)" radius={[5, 5, 0, 0]} maxBarSize={23} /></BarChart></ResponsiveContainer></div></section>
        <CategoryBreakdown categories={summary.categories} onReview={category => { setPage('transactions'); setFilterScope('personal'); setFilterCategory(category === 'Uncategorized' ? '__empty' : `category:${category}`); setFilterSource(''); setQuery(''); }} /></div>
        <div className="overview-bottom"><section className="panel reserve-card"><div className="reserve-heading"><span className="reserve-icon"><TrendingUp size={23} /></span><div><h2>Your reserve forecast</h2><p>Based on your plan, separate from recorded activity</p></div></div><div className="reserve-values"><div><small>Opening reserve in {formatMonth(data.settings.reserveStartMonth)}</small><strong>{formatMoney(data.settings.initialReserveCents)}</strong></div><ArrowRight size={21} /><div><small>Projected at end of {finalProjection ? formatMonth(finalProjection.month) : 'the period'}</small><strong>{formatMoney(finalProjection?.closingCents ?? 0)}</strong></div></div><button className="text-button" onClick={() => setPage('plan')}>Explore my plan <ArrowRight size={16} /></button></section><BudgetComparisonCard data={data} month={month} onPlan={() => setPage('plan')} onImport={() => setPage('import')} /></div>
      </>}

      {page === 'transactions' && <section className="panel"><div className="panel-header"><div><h2>Transactions for {formatMonth(month)}</h2><p>{formatNumber(monthTx.length)} records · {workLabel} cash flow is separate from personal totals</p></div><div className="transaction-actions">{categoryReviewQueue.length > 0 && <Button onClick={() => setPage('review')}><Tag size={16} /> Review categories · {formatNumber(categoryReviewQueue.length)}</Button>}<Button secondary onClick={() => { manualTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setAddScope('personal'); setShowAdd(true); }}><Plus size={16} /> Manual transaction</Button></div></div><div className="filters"><div className="search"><Search size={17} /><input aria-label="Search transactions" placeholder="Search transactions or descriptions" value={query} onChange={e => setQuery(e.target.value)} /></div><CategorySelect label="Filter category" options={filterCategories} value={filterCategory} onChange={setFilterCategory} filter /><select aria-label="Filter scope" value={filterScope} onChange={e => setFilterScope(e.target.value)}><option value="">All scopes</option><option value="personal">Personal</option><option value="work">{workLabel}</option></select><select aria-label="Filter source" value={filterSource} onChange={e => setFilterSource(e.target.value)}><option value="">All sources</option>{Object.entries(sourceNames).map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select><Button secondary onClick={openCategoryManager}><Tag size={15} /> Manage categories</Button></div>{filtered.length ? <><TxTable transactions={filtered.slice(offset, offset + 40)} categories={categories} data={data} update={patchTx} applyCategory={applySimilarCategory} remove={id => patchTx(id, { deletedAt: new Date().toISOString() })} /><div className="pagination"><span>{formatNumber(offset + 1)}–{formatNumber(Math.min(offset + 40, filtered.length))} of {formatNumber(filtered.length)}</span><Button secondary disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 40))}>Previous</Button><Button secondary disabled={offset + 40 >= filtered.length} onClick={() => setOffset(offset + 40)}>Next</Button></div></> : <Empty title="No transactions match this filter"><p>Choose another month or import a statement to get started.</p></Empty>}</section>}

      {page === 'review' && <CategoryReviewWizard data={data} transactions={categoryReviewQueue} onSave={saveCategoryReview} onClose={() => setPage('transactions')} onManageCategories={openCategoryManager} suspended={modalOpen} />}

      {page === 'import' && <>
        <div className="import-layout"><section className="panel import-panel"><div className="panel-header"><div><h2>Import files</h2><p>Files are read on this computer</p></div><FileSpreadsheet size={23} /></div><p className="import-detection-note">Spending follows the transaction date, including card purchases.</p><details className="import-month-options"><summary>Correct a card statement month</summary><label className="import-month-toggle"><input type="checkbox" checked={overrideCardMonth} onChange={event => setOverrideCardMonth(event.target.checked)} />Override the detected statement month</label><label className="field"><span>Card statement month</span><input aria-label="Card statement month override" type="month" disabled={!overrideCardMonth} value={cardMonth} onChange={event => event.target.value && setCardMonth(event.target.value)} /><small>Only correct missing or incorrect statement metadata. Spending still follows each transaction date. This applies to all selected card files.</small></label>{filesToRetry.current.length > 0 && <Button secondary disabled={busy} onClick={() => void importFiles(filesToRetry.current)}>Retry selected files</Button>}</details><div className="dropzone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) void importFiles(e.dataTransfer.files); }}><div className="upload-icon"><Upload size={27} /></div><h3>Start with your files.</h3><p>Drag files here or choose them from your computer.</p><Button onClick={() => fileInput.current?.click()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} Choose files</Button><small>.xls and .xlsx · account and card</small><input ref={fileInput} type="file" multiple accept=".xls,.xlsx" className="hidden" onChange={e => e.target.files && void importFiles(e.target.files)} /></div></section><section className="panel import-guide"><span className="pill subdued">HOW IT WORKS</span><h2>Less typing.<br />More clarity.</h2><div className="guide-step"><span>01</span><div><h3>Export from Itaú</h3><p>Download your account and card statements as Excel files.</p></div></div><div className="guide-step"><span>02</span><div><h3>Review before importing</h3><p>Dates, amounts, transaction details, and installments are filled in. Card payments and investment transfers are separated from spending.</p></div></div><div className="guide-step"><span>03</span><div><h3>Add your context</h3><p>Add a category and description. Mark work expenses and reimbursements with the checkbox.</p></div></div><div className="guide-foot"><ShieldCheck size={18} /><span>Repeated files preserve your edits and do not create duplicate records.</span></div></section></div>
        {importPreviews.map((item, index) => {
          const reportingMonths = [...new Set(item.result.transactions.map(getTransactionReportingMonth))].sort();
          const previewOffset = Math.min(previewOffsets[index] ?? 0, Math.max(0, Math.floor((item.result.transactions.length - 1) / 20) * 20));
          const excludedCount = item.excluded?.length ?? 0;
          return <section className="panel preview" key={`${item.name}-${index}`}>
            <div className="panel-header"><div><h2>{item.name}</h2><p>{formatNumber(item.newCount)} new · {formatNumber(item.duplicates)} already imported</p><p className="import-period">Reporting period: {reportingMonths.length ? reportingMonths.map(value => formatMonth(value)).join(', ') : 'No eligible transactions'}</p></div><span className="pill subdued">PREVIEW</span></div>
            {excludedCount > 0 && <div className="import-exclusion-status" role="status"><span>{formatNumber(excludedCount)} {excludedCount === 1 ? 'row excluded' : 'rows excluded'} from this import.</span><button type="button" className="text-button" data-undo-exclusion onClick={event => undoPendingRow(index, event.currentTarget)}>Undo exclusion</button></div>}
            {item.learnedCount > 0 && <p className="import-learning-note">{excludedCount
              ? 'Categories or descriptions were prefilled from your previous entries. Review the remaining rows before importing.'
              : `Prefilled categories or descriptions for ${formatNumber(item.learnedCount)} ${item.learnedCount === 1 ? 'transaction' : 'transactions'} from your previous entries. Review them before importing.`}</p>}
            {item.result.warnings.map((warning, warningIndex) => <div className="alert warning" key={warningIndex}>{warning}</div>)}
            {item.possibleDuplicates.length > 0 && <div className="possible-duplicates"><h3>Review possible repeats</h3><p>These match recorded transaction details but have different amounts. They may be updated charges or separate purchases; nothing is removed automatically.</p>{item.possibleDuplicates.map(possible => <div className="possible-duplicate-row" key={possible.incoming.id}><div><strong>{possible.incoming.originalDescription}</strong><small>New {formatMoney(possible.incoming.amountCents)} · recorded {possible.existing.map(existing => formatMoney(existing.amountCents)).join(', ')}</small></div><button className="text-button" onClick={() => excludePendingRow(index, possible.incoming.id)}>Skip this entry</button></div>)}</div>}
            {item.result.transactions.length > 0 ? <>
              <TxTable transactions={item.result.transactions.slice(previewOffset, previewOffset + 20)} categories={categories} data={data} update={(id, patch) => setPending(current => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, result: { ...entry.result, transactions: entry.result.transactions.map(transaction => transaction.id === id ? { ...transaction, ...patch } : transaction) } } : entry))} remove={id => excludePendingRow(index, id)} removeMode="exclude" />
              <div className="pagination" role="group" aria-label={`Preview pages for ${item.name}`}><span>{formatNumber(previewOffset + 1)}–{formatNumber(Math.min(previewOffset + 20, item.result.transactions.length))} of {formatNumber(item.result.transactions.length)}</span><button type="button" className="button secondary" aria-label={`Previous preview page for ${item.name}`} disabled={!previewOffset} onClick={() => setPreviewOffsets(current => ({ ...current, [index]: Math.max(0, previewOffset - 20) }))}>Previous</button><button type="button" className="button secondary" aria-label={`Next preview page for ${item.name}`} disabled={previewOffset + 20 >= item.result.transactions.length} onClick={() => setPreviewOffsets(current => ({ ...current, [index]: previewOffset + 20 }))}>Next</button></div>
              <p className="footnote">Review the rows before confirming. Use Exclude to leave a row out of this import.</p>
            </> : <p className="import-preview-empty">{excludedCount ? 'All rows are excluded. Use Undo exclusion to restore the last row.' : 'No eligible transactions in this file.'}</p>}
          </section>;
        })}
        {!!pending.length && <div className="import-actions"><Button secondary onClick={() => setPending([])}>Cancel</Button><Button disabled={!pending.some(item => item.result.transactions.length > 0)} onClick={confirmImports}><Check size={17} /> Confirm import</Button></div>}
      </>}

      {page === 'plan' && <>
        <ReserveGrowthChart rows={projection} />
        <section className="panel plan-table-panel">
          <div className="panel-header"><div><h2>Your planned expenses</h2><p>Set a monthly amount. Edit any month that needs a different budget, including zero.</p></div><Button secondary onClick={() => addPlan()}><Plus size={16} /> Add expense</Button></div>
          <div className="plan-controls"><span>{formatMonth(visiblePlanningMonths[0].month)} – {formatMonth(visiblePlanningMonths.at(-1)!.month)}</span><div><button className="icon-button" disabled={visiblePlanOffset === 0} onClick={() => setPlanOffset(Math.max(0, visiblePlanOffset - 6))} aria-label="Previous planning months"><ChevronLeft size={18} /></button><button className="icon-button" disabled={visiblePlanOffset + 6 >= projection.length} onClick={() => setPlanOffset(visiblePlanOffset + 6)} aria-label="Next planning months"><ChevronRight size={18} /></button></div></div>
          <PlanGrid items={expensePlanItems} months={visiblePlanningMonths} onPatch={patchPlan} onMonthly={editPlanMonthly} onMonth={editPlanMonth} onMove={reorderPlan}>
            <tr className="plan-total"><td colSpan={2}>Planned spending</td>{visiblePlanningMonths.map(row => <td key={row.month}>{formatMoney(row.expenseCents)}</td>)}<td /></tr>
            {incomeRows.map(item => <PlanGridRow key={item.id} item={item} months={visiblePlanningMonths} onPatch={patchPlan} onMonthly={editPlanMonthly} onMonth={editPlanMonth} editableName={false} editableMonthly={false} removable={false} />)}
            {([
              ...(incomeRows.length > 1 ? [['incomeCents', 'Total income'] as const] : []),
              ['netCents', 'Monthly savings'], ['openingCents', 'Reserve at start'], ['closingCents', 'Reserve at end'],
            ] as const).map(([key, label]) => <tr className={`plan-total ${key === 'closingCents' ? 'final' : ''}`} key={key}><td colSpan={2}>{label}</td>{visiblePlanningMonths.map(row => <td key={row.month}>{formatMoney(row[key])}</td>)}<td /></tr>)}
          </PlanGrid>
          {!expensePlanItems.length && <Empty title="Add your planned expenses"><p>Enter what you expect to spend each month.</p></Empty>}
        </section>
        <div className="plan-summary simple-plan-summary">
          <Metric label="Planned spending" value={formatMoney(shownMonth.expenseCents)} detail={formatMonth(shownMonth.month)} icon={<ArrowUpRight size={18} />} />
          <Metric label="Monthly savings" value={formatMoney(shownMonth.netCents)} detail={`${formatMonth(shownMonth.month)} · income minus expenses`} icon={<TrendingUp size={18} />} />
          <Metric label="Projected reserve" value={formatMoney(finalProjection?.closingCents ?? 0)} detail={`At the end of ${formatMonth(finalProjection!.month)}`} icon={<Wallet size={18} />} tint />
        </div>
        <details className="panel simple-plan-extra simple-plan-settings"><summary>Plan settings <span className="plan-settings-hint">Starting reserve, monthly income, and forecast assumptions</span></summary>
          <div className="simple-plan-settings-body">
            <div className="simple-plan-inputs">
              <label className="field"><span>Starting reserve (R$)</span><MoneyInput label="Starting reserve" value={data.settings.initialReserveCents} onChange={amount => patchSettings({ initialReserveCents: amount })} /><small>Balance at the start of your first planning month.</small></label>
              {incomeRows.map(item => <label className="field" key={item.id}><span>{incomeRows.length === 1 ? 'Monthly income (R$)' : `${item.name} per month (R$)`}</span><MoneyInput label={incomeRows.length === 1 ? 'Monthly income' : `Monthly income for ${item.name}`} value={item.behavior === 'monthly' || item.behavior === 'installments' ? 0 : item.defaultAmountCents} onChange={amount => editPlanMonthly(item.id, Math.max(0, amount))} /></label>)}
            </div>
            <div className="settings-grid simple-plan-forecast-inputs">
              <label className="field"><span>First month</span><input aria-label="First planning month" type="month" min={startMonth} value={data.settings.reserveStartMonth} onChange={event => event.target.value && patchSettings({ reserveStartMonth: event.target.value })} /></label>
              <label className="field"><span>Months to plan</span><input aria-label="Planning horizon" type="number" min="1" max="120" value={data.settings.horizonMonths} onChange={event => patchSettings({ horizonMonths: Math.min(120, Math.max(1, Number(event.target.value) || 1)) })} /></label>
              <label className="field"><span>Monthly investment return (%)</span><DecimalInput label="Monthly investment return" value={data.settings.monthlyReturnPercent} onChange={value => patchSettings({ monthlyReturnPercent: Math.min(100, Math.max(-100, value)) })} /></label>
            </div>
          </div>
        </details>
        <details className="panel simple-plan-extra"><summary>Savings targets</summary><p className="simple-plan-extra-copy">Optional allocations within your savings. These are excluded from spending.</p><div className="simple-plan-extra-actions"><Button secondary onClick={() => addPlan('contribution')}><Plus size={16} /> Add savings target</Button></div>
          <PlanGrid items={targetPlanItems} months={visiblePlanningMonths} onPatch={patchPlan} onMonthly={editPlanMonthly} onMonth={editPlanMonth} onMove={reorderPlan}>
            <tr className="plan-total"><td colSpan={2}>Savings target</td>{visiblePlanningMonths.map(row => <td key={row.month}>{formatMoney(row.contributionCents)}</td>)}<td /></tr>
            <tr className="plan-total"><td colSpan={2}>Left after savings target</td>{visiblePlanningMonths.map(row => <td key={row.month}>{formatMoney(row.availableCents)}</td>)}<td /></tr>
          </PlanGrid>
        </details>
        <details className="panel simple-plan-extra"><summary>Financial indicators</summary><div className="simple-plan-indicators">
          <PlanningMetrics rows={projection} planning={data.planning} month={selectedPlanningMonth} onMonthChange={selectPlanningMonth} />
          <PlanningIndicatorsTable rows={visiblePlanningMonths} planning={data.planning} />
          <PlanningAssumptions data={data} onChange={planning => change(current => ({ ...current, planning }))} />
        </div></details>
      </>}

      {page === 'settings' && <div className="settings-layout">{startMonth && <section className="panel"><div className="panel-header"><div><h2>Reporting period</h2><p>Tracking starts in {formatMonth(startMonth)}.</p></div><FileSpreadsheet size={22} /></div><p>Monthly totals use your account, card, and manual transactions. Record income as it arrives and build your plan from your current commitments.</p></section>}<WorkSettings data={data} onEdit={change} /><section className="panel category-settings-panel"><div><h2>Your categories</h2><p>{formatNumber(categories.length)} available · organize transaction categories.</p></div><Button secondary onClick={openCategoryManager}><Tag size={16} /> Manage categories</Button></section><section className="panel"><div className="panel-header"><div><h2>Google Drive</h2><p>Sync in this app’s private folder</p></div><Cloud size={24} /></div><div className="cloud-status"><span className={`status-dot ${connected ? '' : 'neutral'}`} />{connected ? 'Connected for this session' : 'Not connected yet'}</div><label className="field"><span>Google OAuth client ID</span><input placeholder="Your ID ends with .apps.googleusercontent.com" aria-label="Google client ID" value={settingsClientId} onChange={e => patchSettings({ googleClientId: e.target.value.trim() })} /><small>Set this up once in your Google account. Use the same ID on each computer.</small></label><p className="settings-copy">The app merges local and cloud data before saving a new copy. On another computer, connect Drive and sync before continuing.</p><div className="button-row"><Button disabled={busy || !settingsClientId} onClick={() => void sync()}>{busy ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}{connected ? 'Sync now' : 'Connect and sync'}</Button>{connected && <Button secondary onClick={() => { disconnectDrive(); setConnected(false); }}>Disconnect</Button>}</div>{lastSync && <p className="footnote">Last sync in this session: {new Date(lastSync).toLocaleString('pt-BR')}{unsynced ? ' · local changes still need syncing' : ' · current data is synced'}</p>}<details className="setup-details"><summary>Set up without a paid server</summary><ol><li>Create a Google Cloud project and enable the Google Drive API.</li><li>Configure the consent screen and the <code>drive.appdata</code> scope.</li><li>Create a Web application OAuth client with the origin <code>http://localhost:5173</code>.</li><li>In testing mode, add your email as a test user.</li><li>Copy the client ID into the field above. See the details and options in <code>docs/CLOUD.md</code>.</li></ol><p>The API’s free quotas are sufficient for personal use. Files use the storage available in your Google account. Tokens expire, and you may need to authorize again.</p></details></section>
      <section className="panel"><div className="panel-header"><div><h2>Keep a copy with you</h2><p>JSON backup of transactions and your plan</p></div><Download size={22} /></div><p className="settings-copy">Your data is stored in this browser. Export a copy before clearing browser data or changing computers. You can restore a backup and merge it with your current data.</p><div className="button-row"><Button secondary onClick={downloadBackup}><Download size={17} /> Export backup</Button><Button secondary onClick={() => backupInput.current?.click()}><Upload size={17} /> Restore backup</Button></div><input ref={backupInput} type="file" accept=".json,application/json" className="hidden" onChange={e => e.target.files?.[0] && void restoreBackup(e.target.files[0])} /><div className="data-counts"><div><strong>{formatNumber(activeTx.length)}</strong><small>Transactions</small></div><div><strong>{formatNumber(horizonPlanItems.length)}</strong><small>Plan items</small></div><div><strong>{formatNumber(data.imports.length)}</strong><small>Imports</small></div></div><div className="privacy-note"><ShieldCheck size={19} /><p>Your statements are processed locally. Only structured data is sent to Drive when you sync.</p></div></section>
      <section className="panel imports-history"><div className="panel-header"><div><h2>Import history</h2><p>Files you have processed</p></div></div>{data.imports.length ? data.imports.slice().sort((a, b) => b.importedAt.localeCompare(a.importedAt)).map(batch => <div className="import-history-row" key={batch.id}><FileSpreadsheet size={19} /><div><strong>{batch.filename}</strong><small>{new Date(batch.importedAt).toLocaleString('pt-BR')} · {formatNumber(batch.count)} new records</small></div></div>) : <p className="muted">Imported files will appear here.</p>}</section></div>}
      <footer className="page-footer"><span>{APP_ID}<span className="brand-dot">.</span></span><span>A place to manage today and plan for tomorrow.</span></footer>
      </div>
    </main>
    {showAdd && <TransactionModal onClose={closeManual} suspended={showCategoryManager} returnFocusTo={manualTrigger.current}><form onSubmit={e => { e.preventDefault(); submitManual(); }}><div className="field"><label className="manual-work-checkbox"><input type="checkbox" aria-label={`Mark the new transaction as ${workLabel}`} checked={addScope === 'work'} onChange={event => setAddScope(event.target.checked ? 'work' : 'personal')} /><span>{workLabel} expense or reimbursement</span></label><small>Leave unchecked for personal transactions, including salary.</small></div><label className="field"><span>Date</span><input required type="date" min={startMonth ? `${startMonth}-01` : undefined} value={addDate} onChange={e => setAddDate(e.target.value)} /></label><label className="field"><span>Description</span><input data-autofocus required value={addDescription} onChange={e => setAddDescription(e.target.value)} /></label><div className="field"><span>Category</span><CategorySelect label="Category for the new transaction" options={categories} value={addCategory} onChange={setAddCategory} /><button type="button" className="text-button" onClick={openCategoryManager}><Tag size={14} /> Manage categories</button></div><label className="field"><span>Amount (R$)</span><input aria-label="Amount (R$)" required inputMode="text" placeholder="-150,00 or 150,00" value={addAmount} onChange={event => setAddAmount(event.target.value)} onBlur={normalizeManualAmount} /><small>Negative for expenses; positive for income.</small>{manualFlowLabel && <small className="manual-flow-status" role="status">Will be recorded as {manualFlowLabel}.</small>}</label>{error && <div role="alert" className="alert error">{error}</div>}<Button type="submit"><Plus size={16} /> Add transaction</Button></form></TransactionModal>}
    {undo && <div className="undo-toast" role="status" inert={modalOpen || undefined} aria-hidden={modalOpen || undefined}><span>Deleted {undo.name}</span><button className="text-button" onClick={undoDelete}>Undo</button><button className="icon-button" aria-label="Dismiss undo" onClick={() => setUndo(null)}><X size={16} /></button></div>}
    {showCategoryManager && <CategoryManager data={data} onEdit={manageCategories} onClose={closeCategoryManager} />}
  </div>;
}
