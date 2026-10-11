import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, ChevronLeft, ChevronRight, Cloud, Download, FileSpreadsheet, FolderUp, LayoutDashboard, Leaf, ListFilter, LoaderCircle, Plus, RefreshCw, Search, Settings2, ShieldCheck, Trash2, TrendingUp, Upload, Wallet, X, Tag } from 'lucide-react';
import type { FinanceData, ImportResult, PlanItem, ProjectionMonth, Transaction, TransactionKind } from './lib/types';
import { addMonths, applyImport, createEmptyData, formatMoney, formatMonth, mergeFinanceData, parseMoneyToCents, previewDuplicateCount, projectReserve, summarizeMonth } from './lib/finance';
import { loadData, saveData, serializeBackup, validateBackup } from './lib/storage';
import { APP_ID } from './lib/identity';
import { allCategoryNames, assertAvailableCategory, availableCategoryNames, categoryNameKey, listCategories } from './lib/categories';
import { CategorySelect } from './components/CategorySelect';
import { CategoryManager } from './components/CategoryManager';
import { connectDrive, disconnectDrive, isDriveConnected, syncDrive } from './lib/drive';

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const colors = ['#347362', '#94b88e', '#d9ac73', '#7c8baa', '#bc857f', '#93aeb0', '#bdad86'];
const moneyAxis = (cents: number) => Math.abs(cents) >= 100000 ? `${Math.round(cents / 100000)}k` : formatMoney(cents);
const sourceNames = { bank: 'Itaú account', card: 'Itaú card', budget: 'Budget', manual: 'Manual' };
const kindNames = { income: 'Income', expense: 'Expense', transfer: 'Transfer' };
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
function MoneyInput({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  const [draft, setDraft] = useState((value / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, useGrouping: false }));
  useEffect(() => { setDraft((value / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, useGrouping: false })); }, [value]);
  return <input aria-label={label} inputMode="decimal" value={draft} onChange={e => setDraft(e.target.value)} onBlur={() => {
    try { onChange(parseMoneyToCents(draft)); }
    catch { setDraft((value / 100).toFixed(2).replace('.', ',')); }
  }} />;
}
function Metric({ label, value, detail, icon, tint = false }: { label: string; value: string; detail: string; icon: ReactNode; tint?: boolean }) {
  return <div className={`metric ${tint ? 'tint' : ''}`}><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><small>{detail}</small></div>;
}
function PlanningCashChart({ rows }: { rows: ProjectionMonth[] }) {
  return <section className="panel"><div className="panel-header"><div><h2>Planned income and expenses</h2><p>Compare planned spending with income each month.</p></div></div><div className="chart-legend"><span><i style={{ background: '#347362' }} />Income</span><span><i style={{ background: '#d9ac73' }} />Spending</span></div><div className="chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={rows} margin={{ top: 10, right: 15, left: 10, bottom: 5 }}><CartesianGrid strokeDasharray="3 6" vertical={false} stroke="#e5e9e2" /><XAxis dataKey="month" tickFormatter={m => formatMonth(m)} minTickGap={35} axisLine={false} tickLine={false} tick={{ fontSize: 11 }} /><YAxis tickFormatter={moneyAxis} axisLine={false} tickLine={false} width={70} tick={{ fontSize: 11 }} /><Tooltip formatter={v => formatMoney(Number(v))} labelFormatter={m => formatMonth(String(m))} /><Bar dataKey="incomeCents" name="Income" isAnimationActive={false} fill="#347362" radius={[4, 4, 0, 0]} maxBarSize={20} /><Bar dataKey="expenseCents" name="Spending" isAnimationActive={false} fill="#d9ac73" radius={[4, 4, 0, 0]} maxBarSize={20} /></BarChart></ResponsiveContainer></div></section>;
}
function TxTable({ transactions, categories, update, remove }: { transactions: Transaction[]; categories: string[]; update: (id: string, patch: Partial<Transaction>) => void; remove?: (id: string) => void }) {
  return <div className="table-scroll"><table className="tx-table"><thead><tr><th>Date / reporting month</th><th>Transaction</th><th>Description</th><th>Category</th><th>Type</th><th className="right">Amount</th>{remove && <th />}</tr></thead><tbody>{transactions.map(tx => <tr key={tx.id}>
    <td className="date-cell">{tx.date.split('-').reverse().join('/')}<small>{tx.month} · {sourceNames[tx.source]}</small></td>
    <td className="original"><span title={tx.originalDescription}>{tx.originalDescription}</span>{tx.installment && <small>{tx.installment}</small>}</td>
    <td><input aria-label={`Description for ${tx.originalDescription}`} placeholder="Add description" value={tx.description} onChange={e => update(tx.id, { description: e.target.value })} /></td>
    <td><CategorySelect label={`Category for ${tx.originalDescription}`} options={categories} value={tx.category} onChange={category => update(tx.id, { category })} /></td>
    <td><select aria-label={`Type for ${tx.originalDescription}`} value={tx.kind} onChange={e => update(tx.id, { kind: e.target.value as TransactionKind })}>{Object.entries(kindNames).map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}</select></td>
    <td className={`right amount ${tx.kind === 'income' ? 'green' : tx.kind === 'transfer' ? 'muted' : ''}`}>{formatMoney(tx.amountCents)}</td>
    {remove && <td><button className="icon-button danger" title="Delete transaction" aria-label={`Delete ${tx.originalDescription}`} onClick={() => remove(tx.id)}><Trash2 size={16} /></button></td>}
  </tr>)}</tbody></table></div>;
}

export default function App() {
  const [data, setData] = useState<FinanceData>(() => createEmptyData());
  const [loaded, setLoaded] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [page, setPage] = useState('overview');
  const [month, setMonth] = useState(today().slice(0, 7));
  const [mode, setMode] = useState<'transactions' | 'budget'>('transactions');
  const [notification, setNotification] = useState('');
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState('Saved in this browser');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(isDriveConnected());
  const [lastSync, setLastSync] = useState('');
  const [pending, setPending] = useState<{ name: string; result: ImportResult }[]>([]);
  const [cardMonth, setCardMonth] = useState(today().slice(0, 7));
  const [query, setQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [offset, setOffset] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  const closeCategoryManager = useCallback(() => setShowCategoryManager(false), []);
  const [addKind, setAddKind] = useState<TransactionKind>('expense');
  const [addDate, setAddDate] = useState(today());
  const [addDescription, setAddDescription] = useState('');
  const [addCategory, setAddCategory] = useState('');
  const [addAmount, setAddAmount] = useState('');
  const [planOffset, setPlanOffset] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    loadData().then(saved => {
      if (saved) {
        setData(saved);
        if (!saved.transactions.some(item => !item.deletedAt && item.source !== 'budget')) {
          const latest = [...saved.snapshots.map(item => item.month), ...saved.transactions.filter(item => !item.deletedAt && item.source === 'budget').map(item => item.month)].sort().at(-1);
          if (latest) { setMode('budget'); setMonth(latest); }
        }
      }
      setLoaded(true);
    }).catch(e => { setStorageAvailable(false); setLoaded(true); setError(`Could not open local data. You can use a temporary session and export a backup: ${e.message}`); setSaveStatus('Temporary session · export a backup'); });
  }, []);
  useEffect(() => {
    if (!loaded || !storageAvailable) return;
    setSaveStatus('Saving…');
    const timer = setTimeout(() => { saveData(data).then(() => setSaveStatus('Saved in this browser')).catch(e => { setSaveStatus('Save failed'); setError(`Your data is still in memory. Export a backup: ${e.message}`); }); }, 250);
    return () => clearTimeout(timer);
  }, [data, loaded, storageAvailable]);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(`${APP_ID}-data`); channel.current = ch;
    ch.onmessage = e => { try { const remote = validateBackup(e.data); setData(local => mergeFinanceData(local, remote)); } catch { /* Ignore unrelated messages. */ } };
    return () => { ch.close(); channel.current = null; };
  }, []);
  useEffect(() => { setOffset(0); }, [month, query, filterCategory, filterSource, mode]);
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
      dataRef.current = next; setData(next);
      channel.current?.postMessage(JSON.parse(serializeBackup(next)));
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : 'Check the values you entered.'); return false; }
  }
  function patchSettings(patch: Partial<FinanceData['settings']>) { change(d => ({ ...d, settings: { ...d.settings, ...patch, updatedAt: Object.keys(patch).some(key => key !== 'googleClientId') ? new Date().toISOString() : d.settings.updatedAt } })); }
  function patchTx(id: string, patch: Partial<Transaction>) { change(d => {
    if (patch.category !== undefined) assertAvailableCategory(d, patch.category);
    return { ...d, transactions: d.transactions.map(t => t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t) };
  }); }
  function patchPlan(id: string, patch: Partial<PlanItem>) {
    const existing = dataRef.current.planItems.find(p => p.id === id);
    if (existing) { const next = { ...existing, ...patch }; if (next.endMonth && next.endMonth < next.startMonth) { setError('The end month must be the same as or later than the start month.'); return; } }
    change(d => {
      if (patch.category !== undefined) assertAvailableCategory(d, patch.category);
      return { ...d, planItems: d.planItems.map(p => p.id === id ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p) };
    });
  }
  const categories = availableCategoryNames(data);
  const filterCategories = allCategoryNames(data);
  function manageCategories(edit: (current: FinanceData) => FinanceData) {
    const next = edit(dataRef.current);
    return change(() => next);
  }
  const activeTx = data.transactions.filter(t => !t.deletedAt);
  const monthTx = activeTx.filter(t => t.month === month && (mode === 'budget' ? t.source === 'budget' : t.source !== 'budget'));
  const filtered = monthTx.filter(t => (!filterCategory || (filterCategory === '__empty' ? !t.category : t.category === filterCategory.slice(9))) && (!filterSource || t.source === filterSource) && `${t.originalDescription} ${t.description} ${t.category}`.toLocaleLowerCase('pt-BR').includes(query.toLocaleLowerCase('pt-BR'))).sort((a, b) => b.date.localeCompare(a.date) || a.originalDescription.localeCompare(b.originalDescription));
  const summary = summarizeMonth(data, month, mode);
  const projection = projectReserve(data);
  const expenseCategories = Object.entries(summary.categories).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
  const monthlyHistory = Array.from({ length: 6 }, (_, i) => summarizeMonth(data, addMonths(month, i - 5), mode));
  const savings = summary.incomeCents > 0 ? Math.round(summary.netCents / summary.incomeCents * 100) : null;
  const pendingCount = monthTx.filter(t => t.kind !== 'transfer' && !t.category).length;
  const finalProjection = projection.at(-1);
  const goalProgress = data.settings.reserveGoalCents > 0 ? Math.min(100, Math.max(0, data.settings.initialReserveCents / data.settings.reserveGoalCents * 100)) : 0;
  const settingsClientId = data.settings.googleClientId || import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

  async function importFiles(files: FileList | File[]) {
    setBusy(true); setError('');
    try {
      const { parseImport } = await import('./lib/importers');
      const imports = [];
      for (const file of Array.from(files)) imports.push({ name: file.name, result: await parseImport(file, { cardMonth }) });
      setPending(imports); setPage('import');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read this file.'); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  function confirmImports() {
    let next = data; let count = 0;
    for (const item of pending) { const before = next.transactions.length; next = applyImport(next, item.result, item.name); count += next.transactions.length - before; }
    change(() => next);
    if (pending.some(p => p.result.source === 'budget') && !pending.some(p => p.result.source !== 'budget')) {
      setMode('budget'); const latest = next.snapshots.map(s => s.month).sort().at(-1); if (latest) setMonth(latest);
    } else { setMode('transactions'); const latest = next.transactions.filter(t => t.source !== 'budget').map(t => t.month).sort().at(-1); if (latest) setMonth(latest); }
    setPending([]); setNotification(`Import complete. ${count} new transactions; existing records were preserved without duplicates.`); setPage('overview');
  }
  function downloadBackup() {
    const url = URL.createObjectURL(new Blob([serializeBackup(data)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${APP_ID}-backup-${today()}.json`; a.click(); URL.revokeObjectURL(url); setNotification('Backup exported.');
  }
  async function restoreBackup(file: File) {
    try { const restored = validateBackup(await file.text()); change(d => mergeFinanceData(d, restored)); setNotification('Backup validated and merged with your local data.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Invalid backup.'); }
    finally { if (backupInput.current) backupInput.current.value = ''; }
  }
  async function sync() {
    setBusy(true); setError('');
    try {
      if (!isDriveConnected()) await connectDrive(settingsClientId);
      setConnected(true);
      const result = await syncDrive(data);
      change(current => mergeFinanceData(current, result.data)); setLastSync(result.syncedAt); setNotification('Data synced with Google Drive.');
    } catch (e) { setConnected(isDriveConnected()); setError(e instanceof Error ? e.message : 'Could not sync data.'); }
    finally { setBusy(false); }
  }
  function submitManual() {
    let cents: number;
    try { assertAvailableCategory(dataRef.current, addCategory); }
    catch (e) { setError(e instanceof Error ? e.message : 'Choose an available category.'); return; }
    try { cents = parseMoneyToCents(addAmount); }
    catch { setError('Enter a valid amount, such as 123,45.'); return; }
    if (!Number.isSafeInteger(cents) || cents <= 0 || !addDescription.trim() || !addDate) { setError('Enter a date, a description, and an amount greater than zero.'); return; }
    const id = crypto.randomUUID(); const stamp = new Date().toISOString();
    const added = change(d => ({ ...d, transactions: [...d.transactions, { id, fingerprint: `manual:${id}`, date: addDate, month: addDate.slice(0, 7), amountCents: addKind === 'income' ? cents : -cents, kind: addKind, source: 'manual', account: 'Manual', originalDescription: addDescription.trim(), description: addDescription.trim(), category: addCategory, updatedAt: stamp }] }));
    if (!added) return;
    setShowAdd(false); setError(''); setMode('transactions'); setMonth(addDate.slice(0, 7)); setAddDescription(''); setAddAmount(''); setNotification('Transaction added.');
  }
  function addPlan() {
    const now = new Date().toISOString(); change(d => ({ ...d, planItems: [...d.planItems, { id: crypto.randomUUID(), name: 'New item', category: '', kind: 'expense', defaultAmountCents: 0, amounts: {}, startMonth: d.settings.reserveStartMonth, updatedAt: now }] }));
  }

  if (!loaded) return <div className="loading-screen"><LoaderCircle className="spin" /> Loading your finances…{error && <p>{error}</p>}</div>;
  return <div className="app-shell">
    <aside className="sidebar" inert={showCategoryManager || undefined}><a className="brand" href="#" aria-label="Budget · home" onClick={e => { e.preventDefault(); setPage('overview'); }}><img className="brand-lockup" src={`${import.meta.env.BASE_URL}brand/budget-app.svg`} alt="" aria-hidden="true" /><img className="brand-symbol" src={`${import.meta.env.BASE_URL}brand/budget-leaf.svg`} alt="" aria-hidden="true" /></a><p className="nav-caption">YOUR FINANCES</p><nav>{nav.map(item => <button key={item.id} onClick={() => setPage(item.id)} className={page === item.id ? 'active' : ''}><item.icon size={19} />{item.label}{item.id === 'import' && <span className="nav-plus">+</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><ShieldCheck size={21} /><p>Your data, with you.<small>Local storage and optional cloud sync.</small></p></div><div className="profile"><div className="avatar">ME</div><div>My budget<small>Personal finances</small></div><span className="status-dot" /></div></div>
    </aside>
    <main className="main" inert={showCategoryManager || undefined}><header className="topbar"><span>MY SPACE <span className="separator">/</span> <strong>{nav.find(n => n.id === page)?.label}</strong></span><div className="save-indicator"><span className={saveStatus.startsWith('Save failed') ? 'status-dot red' : 'status-dot'} />{saveStatus}<button className="icon-button" onClick={() => setPage('settings')} title="Data and cloud"><Cloud size={18} /></button></div></header>
      <div className="page-content">
      {error && <div role="alert" className="alert error"><span>{error}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setError('')}><X size={18} /></button></div>}
      {notification && <div role="status" className="alert success"><Check size={18} />{notification}</div>}
      <div className="page-heading"><div><div className="eyebrow">{page === 'plan' ? 'LOOK AHEAD' : page === 'overview' ? 'ONE STEP AT A TIME' : 'YOUR BUDGET, ORGANIZED'}</div><h1>{page === 'overview' ? 'Clarity for your money.' : page === 'transactions' ? 'Every expense in its place.' : page === 'import' ? 'From your statement to your budget.' : page === 'plan' ? 'Make room for your plans.' : 'Your data, wherever you are.'}</h1><p>{page === 'overview' ? 'Track your month and see where your money goes.' : page === 'transactions' ? 'Review transactions and add categories and descriptions.' : page === 'import' ? 'Import your Itaú files and bring in your spreadsheet history.' : page === 'plan' ? 'Plan income, expenses, and how your reserves will grow.' : 'Work in your browser and sync across computers whenever you need.'}</p></div>{['overview', 'transactions'].includes(page) && <Button onClick={() => setPage('import')}><Plus size={17} /> Import statement</Button>}</div>
      {['overview', 'transactions'].includes(page) && <div className="period-bar"><div className="month-switch"><button className="icon-button" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={18} /></button><input type="month" aria-label="Selected month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} /><button className="icon-button" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight size={18} /></button></div><div className="segmented"><button className={mode === 'transactions' ? 'selected' : ''} onClick={() => setMode('transactions')}>Statements and transactions</button><button className={mode === 'budget' ? 'selected' : ''} onClick={() => setMode('budget')}>Budget history</button></div></div>}

      {page === 'overview' && <>
        <div className="metrics"><Metric label="Monthly income" value={formatMoney(summary.incomeCents)} detail={`${formatMonth(month)} · recorded income`} icon={<ArrowDownLeft size={18} />} /><Metric label="Monthly expenses" value={formatMoney(summary.expenseCents)} detail="Spending, net of refunds" icon={<ArrowUpRight size={18} />} /><Metric label="Monthly net income" value={formatMoney(summary.netCents)} detail={savings === null ? 'Record income to see your savings rate' : `${savings}% of income remaining`} icon={<Wallet size={18} />} tint /><Metric label="Needs a category" value={String(pendingCount).padStart(2, '0')} detail="Transactions awaiting your review" icon={<ListFilter size={18} />} /></div>
        {!activeTx.length && <div className="welcome"><div><span className="pill">LET’S GET STARTED</span><h2>Your budget already has a story.</h2><p>Import your Budget workbook to bring in past months and your plan. Then add your account and card statements.</p><Button onClick={() => setPage('import')}>Import my files <ArrowRight size={17} /></Button></div><div className="welcome-art"><FileSpreadsheet size={72} strokeWidth={1} /><span className="art-dot" /></div></div>}
        <div className="charts-grid"><section className="panel"><div className="panel-header"><div><h2>Income and expenses</h2><p>Your activity over the past six months</p></div><span className="pill subdued">MONTHLY</span></div><div className="chart-legend"><span><i style={{ background: '#347362' }} />Income</span><span><i style={{ background: '#d9ac73' }} />Expenses</span></div><div className="chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={monthlyHistory} margin={{ top: 10, right: 5, left: 8, bottom: 0 }}><CartesianGrid strokeDasharray="3 6" vertical={false} stroke="#e5e9e2" /><XAxis dataKey="month" tickFormatter={m => formatMonth(m).split(' ')[0]} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#7c8580' }} dy={8} /><YAxis tickFormatter={moneyAxis} axisLine={false} tickLine={false} width={65} tick={{ fontSize: 11, fill: '#7c8580' }} /><Tooltip formatter={v => formatMoney(Number(v))} labelFormatter={m => formatMonth(String(m))} contentStyle={{ borderRadius: 12, borderColor: '#e5e9e2', fontSize: 12 }} /><Bar isAnimationActive={false} dataKey="incomeCents" name="Income" fill="#347362" radius={[5, 5, 0, 0]} maxBarSize={23} /><Bar isAnimationActive={false} dataKey="expenseCents" name="Expenses" fill="#d9ac73" radius={[5, 5, 0, 0]} maxBarSize={23} /></BarChart></ResponsiveContainer></div></section>
        <section className="panel"><div className="panel-header"><div><h2>Where your money goes</h2><p>Expenses by category this month</p></div></div>{expenseCategories.length ? <><div className="donut"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie isAnimationActive={false} data={expenseCategories.map(([name, value]) => ({ name, value }))} dataKey="value" innerRadius={66} outerRadius={91} paddingAngle={3} stroke="none">{expenseCategories.map(([name], i) => <Cell key={name} fill={colors[i % colors.length]} />)}</Pie><Tooltip formatter={v => formatMoney(Number(v))} /></PieChart></ResponsiveContainer><div className="donut-center"><small>TOTAL</small><strong>{formatMoney(summary.expenseCents)}</strong></div></div><div className="category-list">{expenseCategories.slice(0, 5).map(([name, value], i) => <div key={name}><span><i style={{ background: colors[i % colors.length] }} />{name}</span><strong>{formatMoney(value)}</strong></div>)}</div></> : <Empty title="Your categories appear here"><p>Categorize expenses to see how your spending is distributed.</p></Empty>}</section></div>
        <div className="overview-bottom"><section className="panel reserve-card"><div className="reserve-heading"><span className="reserve-icon"><TrendingUp size={23} /></span><div><h2>The next chapter</h2><p>Your medium-term reserves</p></div></div><div className="reserve-values"><div><small>Opening reserve in {formatMonth(data.settings.reserveStartMonth)}</small><strong>{formatMoney(data.settings.initialReserveCents)}</strong></div><ArrowRight size={21} /><div><small>Projection for {finalProjection ? formatMonth(finalProjection.month) : 'the period'}</small><strong>{formatMoney(finalProjection?.closingCents ?? 0)}</strong></div></div><button className="text-button" onClick={() => setPage('plan')}>Explore my plan <ArrowRight size={16} /></button></section><section className="panel next-card"><span className="pill subdued">NEXT STEP</span><h2>{pendingCount ? 'Complete your monthly picture.' : 'Keep your budget up to date.'}</h2><p>{pendingCount ? `${pendingCount} transactions still need a category. Reviewing them makes your charts more useful.` : 'Import new statements whenever you need. The app recognizes previously imported transactions.'}</p><button className="text-button" onClick={() => setPage(pendingCount ? 'transactions' : 'import')}>{pendingCount ? 'Review transactions' : 'Add statements'} <ArrowRight size={16} /></button></section></div>
      </>}

      {page === 'transactions' && <section className="panel"><div className="panel-header"><div><h2>Transactions for {formatMonth(month)}</h2><p>{monthTx.length} records · transfers are excluded from expenses</p></div><Button secondary onClick={() => setShowAdd(true)}><Plus size={16} /> Manual transaction</Button></div><div className="filters"><div className="search"><Search size={17} /><input aria-label="Search transactions" placeholder="Search transactions or descriptions" value={query} onChange={e => setQuery(e.target.value)} /></div><CategorySelect label="Filter category" options={filterCategories} value={filterCategory} onChange={setFilterCategory} filter /><select aria-label="Filter source" value={filterSource} onChange={e => setFilterSource(e.target.value)}><option value="">All sources</option>{Object.entries(sourceNames).map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select><Button secondary onClick={() => setShowCategoryManager(true)}><Tag size={15} /> Manage categories</Button></div>{filtered.length ? <><TxTable transactions={filtered.slice(offset, offset + 40)} categories={categories} update={patchTx} remove={id => patchTx(id, { deletedAt: new Date().toISOString() })} /><div className="pagination"><span>{offset + 1}–{Math.min(offset + 40, filtered.length)} of {filtered.length}</span><Button secondary disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 40))}>Previous</Button><Button secondary disabled={offset + 40 >= filtered.length} onClick={() => setOffset(offset + 40)}>Next</Button></div></> : <Empty title="No transactions match this filter"><p>Choose another month or import a statement to get started.</p></Empty>}</section>}

      {page === 'import' && <>
        <div className="import-layout"><section className="panel import-panel"><div className="panel-header"><div><h2>Import files</h2><p>Files are read on this computer</p></div><FileSpreadsheet size={23} /></div><label className="field"><span>Card billing month</span><input type="month" value={cardMonth} onChange={e => e.target.value && setCardMonth(e.target.value)} /><small>Purchases and installments are assigned to the billing month, even if the purchase happened earlier.</small></label><div className="dropzone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) void importFiles(e.dataTransfer.files); }}><div className="upload-icon"><Upload size={27} /></div><h3>Start with your files.</h3><p>Drag files here or choose them from your computer.</p><Button onClick={() => fileInput.current?.click()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} Choose files</Button><small>.xls and .xlsx · account, card, and Budget</small><input ref={fileInput} type="file" multiple accept=".xls,.xlsx" className="hidden" onChange={e => e.target.files && void importFiles(e.target.files)} /></div></section><section className="panel import-guide"><span className="pill subdued">HOW IT WORKS</span><h2>Less typing.<br />More clarity.</h2><div className="guide-step"><span>01</span><div><h3>Export from Itaú</h3><p>Download your account and card statements as Excel files.</p></div></div><div className="guide-step"><span>02</span><div><h3>Review before importing</h3><p>Dates, amounts, transaction details, and installments are filled in. Card payments and investment transfers are separated from spending.</p></div></div><div className="guide-step"><span>03</span><div><h3>Add your context</h3><p>Add a category and description. You can also correct a transaction’s type.</p></div></div><div className="guide-foot"><ShieldCheck size={18} /><span>Repeated files do not create duplicate records. Budget history has its own view.</span></div></section></div>
        {pending.map((item, index) => <section className="panel preview" key={`${item.name}-${index}`}><div className="panel-header"><div><h2>{item.name}</h2><p>{item.result.transactions.length} transactions · {previewDuplicateCount(data, item.result)} already imported · {item.result.planItems.length} plan items</p></div><span className="pill subdued">PREVIEW</span></div>{item.result.summary && <p>{item.result.summary}</p>}{item.result.warnings.map((warning, i) => <div className="alert warning" key={i}>{warning}</div>)}{item.result.transactions.length > 0 && <><TxTable transactions={item.result.transactions.slice(0, 20)} categories={categories} update={(id, patch) => setPending(current => current.map((p, idx) => idx === index ? { ...p, result: { ...p.result, transactions: p.result.transactions.map(t => t.id === id ? { ...t, ...patch } : t) } } : p))} /><p className="footnote">Preview of the first {Math.min(20, item.result.transactions.length)} records. You can review every record in Transactions.</p></>}</section>)}
        {!!pending.length && <div className="import-actions"><Button secondary onClick={() => setPending([])}>Cancel</Button><Button onClick={confirmImports}><Check size={17} /> Confirm import</Button></div>}
      </>}

      {page === 'plan' && <>
        <section className="panel plan-settings"><div className="panel-header"><div><h2>Starting point</h2><p>The reserve is your balance at the start of the first month.</p></div><span className="pill subdued">EDITABLE</span></div><div className="settings-grid"><label className="field"><span>First month</span><input type="month" value={data.settings.reserveStartMonth} onChange={e => e.target.value && patchSettings({ reserveStartMonth: e.target.value })} /></label><label className="field"><span>Initial reserve (R$)</span><MoneyInput label="Initial reserve" value={data.settings.initialReserveCents} onChange={n => patchSettings({ initialReserveCents: n })} /></label><label className="field"><span>Planning horizon in months</span><input type="number" min="1" max="120" value={data.settings.horizonMonths} onChange={e => patchSettings({ horizonMonths: Math.min(120, Math.max(1, Number(e.target.value) || 1)) })} /></label><label className="field"><span>Expected monthly return (%)</span><input type="number" min="-100" max="100" step="0.01" value={data.settings.monthlyReturnPercent} onChange={e => patchSettings({ monthlyReturnPercent: Math.min(100, Math.max(-100, Number(e.target.value))) })} /></label></div></section>
        <div className="plan-summary"><Metric label="Closing reserve" value={formatMoney(finalProjection?.closingCents ?? 0)} detail={finalProjection ? formatMonth(finalProjection.month) : 'Set a planning horizon'} icon={<Wallet size={18} />} tint /><Metric label="Average monthly net income" value={formatMoney(projection.length ? Math.round(projection.reduce((s, m) => s + m.netCents, 0) / projection.length) : 0)} detail="Income minus planned spending" icon={<TrendingUp size={18} />} /><Metric label="Months with a negative balance" value={String(projection.filter(p => p.closingCents < 0).length)} detail="Months when your reserve falls below zero" icon={<ListFilter size={18} />} /></div>
        <section className="panel"><div className="panel-header"><div><h2>Reserve forecast</h2><p>Opening balance + monthly net income + return on the opening balance</p></div></div><div className="chart tall"><ResponsiveContainer width="100%" height="100%"><AreaChart data={projection} margin={{ top: 15, right: 15, left: 15, bottom: 5 }}><defs><linearGradient id="reserveGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#347362" stopOpacity={0.25} /><stop offset="100%" stopColor="#347362" stopOpacity={0.02} /></linearGradient></defs><CartesianGrid strokeDasharray="3 6" vertical={false} stroke="#e5e9e2" /><XAxis dataKey="month" tickFormatter={m => formatMonth(m)} minTickGap={45} axisLine={false} tickLine={false} tick={{ fontSize: 11 }} /><YAxis tickFormatter={moneyAxis} width={75} axisLine={false} tickLine={false} tick={{ fontSize: 11 }} /><Tooltip formatter={v => formatMoney(Number(v))} labelFormatter={m => formatMonth(String(m))} /><Area isAnimationActive={false} type="monotone" dataKey="closingCents" name="Closing reserve" stroke="#347362" strokeWidth={2.5} fill="url(#reserveGradient)" /></AreaChart></ResponsiveContainer></div></section>
        <PlanningCashChart rows={projection} />
        <section className="panel goal-panel"><div><h2>A goal for your reserve</h2><p>Set the amount you want to save.</p></div><label className="field"><span>Goal (R$)</span><MoneyInput label="Reserve goal" value={data.settings.reserveGoalCents} onChange={n => patchSettings({ reserveGoalCents: Math.max(0, n) })} /></label><div className="goal-progress"><div><span style={{ width: `${goalProgress}%` }} /></div><small>{Math.round(goalProgress)}% covered by your initial reserve{data.settings.reserveGoalCents > 0 && (projection.find(p => p.closingCents >= data.settings.reserveGoalCents) ? ` · goal projected for ${formatMonth(projection.find(p => p.closingCents >= data.settings.reserveGoalCents)!.month)}` : ' · goal not reached within the horizon')}</small></div></section>
        <section className="panel plan-table-panel"><div className="panel-header"><div><h2>Your medium-term budget</h2><p>The monthly amount repeats. Edit a month to override it, including with zero.</p></div><Button secondary onClick={addPlan}><Plus size={16} /> Add item</Button></div><div className="plan-category-actions"><Button secondary onClick={() => setShowCategoryManager(true)}><Tag size={15} /> Manage categories</Button></div><div className="plan-controls"><span>Contributions are internal goals and are excluded from spending and net income.</span><div><button className="icon-button" disabled={planOffset === 0} onClick={() => setPlanOffset(Math.max(0, planOffset - 6))} aria-label="Previous planning months"><ChevronLeft size={18} /></button><button className="icon-button" disabled={planOffset + 6 >= projection.length} onClick={() => setPlanOffset(planOffset + 6)} aria-label="Next planning months"><ChevronRight size={18} /></button></div></div><div className="table-scroll"><table className="plan-table"><thead><tr><th>Item</th><th>Category</th><th>Type</th><th>Start / end</th><th>Monthly (R$)</th>{projection.slice(planOffset, planOffset + 6).map(m => <th key={m.month}>{formatMonth(m.month)}</th>)}<th /></tr></thead><tbody>{data.planItems.filter(p => !p.deletedAt).map(item => <tr key={item.id}><td><input aria-label="Item name" value={item.name} onChange={e => patchPlan(item.id, { name: e.target.value })} /></td><td><CategorySelect label={`Category for ${item.name}`} options={categories} value={item.category} onChange={category => patchPlan(item.id, { category })} /></td><td><select aria-label={`Type for ${item.name}`} value={item.kind} onChange={e => patchPlan(item.id, { kind: e.target.value as PlanItem['kind'] })}><option value="income">Income</option><option value="expense">Expense</option><option value="contribution">Contribution</option></select></td><td className="plan-dates"><input aria-label={`Start of ${item.name}`} type="month" value={item.startMonth} onChange={e => e.target.value && patchPlan(item.id, { startMonth: e.target.value })} /><input aria-label={`End of ${item.name}`} type="month" value={item.endMonth || ''} onChange={e => patchPlan(item.id, { endMonth: e.target.value || undefined })} /></td><td><MoneyInput label={`Monthly amount for ${item.name}`} value={item.defaultAmountCents} onChange={n => patchPlan(item.id, { defaultAmountCents: Math.max(0, n) })} /></td>{projection.slice(planOffset, planOffset + 6).map(m => { const active = m.month >= item.startMonth && (!item.endMonth || m.month <= item.endMonth); const override = Object.hasOwn(item.amounts, m.month); return <td key={m.month} className={override ? 'overridden' : ''}>{active ? <div className="override-cell"><MoneyInput label={`${item.name} in ${m.month}`} value={override ? item.amounts[m.month] : item.defaultAmountCents} onChange={n => patchPlan(item.id, { amounts: { ...item.amounts, [m.month]: Math.max(0, n) } })} />{override && <button className="reset-month" title="Use the default monthly amount" aria-label={`Remove override for ${item.name} ${m.month}`} onClick={() => { const amounts = { ...item.amounts }; delete amounts[m.month]; patchPlan(item.id, { amounts }); }}><X size={12} /></button>}</div> : <span className="muted">—</span>}</td>; })}<td><button className="icon-button danger" aria-label={`Delete item ${item.name}`} onClick={() => patchPlan(item.id, { deletedAt: new Date().toISOString() })}><Trash2 size={16} /></button></td></tr>)}{['incomeCents', 'expenseCents', 'netCents', 'closingCents'].map(key => <tr className={`plan-total ${key === 'closingCents' ? 'final' : ''}`} key={key}><td colSpan={5}>{({ incomeCents: 'Income', expenseCents: 'Spending', netCents: 'Monthly net income', closingCents: 'Closing reserve' } as Record<string, string>)[key]}</td>{projection.slice(planOffset, planOffset + 6).map(m => <td key={m.month}>{formatMoney(m[key as keyof typeof m] as number)}</td>)}<td /></tr>)}</tbody></table></div>{!data.planItems.some(p => !p.deletedAt) && <Empty title="Start your plan with your commitments"><p>Import your Budget workbook or add expected income and expenses.</p></Empty>}</section>
      </>}

      {page === 'settings' && <div className="settings-layout"><section className="panel category-settings-panel"><div><h2>Your categories</h2><p>{categories.length} available · organize transaction and plan categories.</p></div><Button secondary onClick={() => setShowCategoryManager(true)}><Tag size={16} /> Manage categories</Button></section><section className="panel"><div className="panel-header"><div><h2>Google Drive</h2><p>Sync in this app’s private folder</p></div><Cloud size={24} /></div><div className="cloud-status"><span className={`status-dot ${connected ? '' : 'neutral'}`} />{connected ? 'Connected for this session' : 'Not connected yet'}</div><label className="field"><span>Google OAuth client ID</span><input placeholder="Your ID ends with .apps.googleusercontent.com" aria-label="Google client ID" value={settingsClientId} onChange={e => patchSettings({ googleClientId: e.target.value.trim() })} /><small>Set this up once in your Google account. Use the same ID on each computer.</small></label><p className="settings-copy">The app merges local and cloud data before saving a new copy. On another computer, connect Drive and sync before continuing.</p><div className="button-row"><Button disabled={busy || !settingsClientId} onClick={() => void sync()}>{busy ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}{connected ? 'Sync now' : 'Connect and sync'}</Button>{connected && <Button secondary onClick={() => { disconnectDrive(); setConnected(false); }}>Disconnect</Button>}</div>{lastSync && <p className="footnote">Last sync in this session: {new Date(lastSync).toLocaleString('pt-BR')}</p>}<details className="setup-details"><summary>Set up without a paid server</summary><ol><li>Create a Google Cloud project and enable the Google Drive API.</li><li>Configure the consent screen and the <code>drive.appdata</code> scope.</li><li>Create a Web application OAuth client with the origin <code>http://localhost:5173</code>.</li><li>In testing mode, add your email as a test user.</li><li>Copy the client ID into the field above. See the details and options in <code>docs/CLOUD.md</code>.</li></ol><p>The API’s free quotas are sufficient for personal use. Files use the storage available in your Google account. Tokens expire, and you may need to authorize again.</p></details></section>
      <section className="panel"><div className="panel-header"><div><h2>Keep a copy with you</h2><p>JSON backup of transactions and your plan</p></div><Download size={22} /></div><p className="settings-copy">Your data is stored in this browser. Export a copy before clearing browser data or changing computers. You can restore a backup and merge it with your current data.</p><div className="button-row"><Button secondary onClick={downloadBackup}><Download size={17} /> Export backup</Button><Button secondary onClick={() => backupInput.current?.click()}><Upload size={17} /> Restore backup</Button></div><input ref={backupInput} type="file" accept=".json,application/json" className="hidden" onChange={e => e.target.files?.[0] && void restoreBackup(e.target.files[0])} /><div className="data-counts"><div><strong>{activeTx.length}</strong><small>Transactions</small></div><div><strong>{data.planItems.filter(p => !p.deletedAt).length}</strong><small>Plan items</small></div><div><strong>{data.imports.length}</strong><small>Imports</small></div></div><div className="privacy-note"><ShieldCheck size={19} /><p>Your statements are processed locally. Only structured data is sent to Drive when you sync.</p></div></section>
      <section className="panel imports-history"><div className="panel-header"><div><h2>Import history</h2><p>Files you have processed</p></div></div>{data.imports.length ? data.imports.slice().sort((a, b) => b.importedAt.localeCompare(a.importedAt)).map(batch => <div className="import-history-row" key={batch.id}><FileSpreadsheet size={19} /><div><strong>{batch.filename}</strong><small>{new Date(batch.importedAt).toLocaleString('pt-BR')} · {batch.count} new records</small></div></div>) : <p className="muted">Imported files will appear here.</p>}</section></div>}
      <footer className="page-footer"><span>{APP_ID}<span className="brand-dot">.</span></span><span>A place to manage today and plan for tomorrow.</span></footer>
      </div>
    </main>
    {showAdd && <div className="modal-backdrop" inert={showCategoryManager || undefined} aria-hidden={showCategoryManager || undefined} onClick={() => setShowAdd(false)}><div className="modal panel" role="dialog" aria-modal={!showCategoryManager} aria-label="New transaction" onClick={e => e.stopPropagation()}><div className="panel-header"><h2>New transaction</h2><button className="icon-button" aria-label="Close" onClick={() => setShowAdd(false)}><X size={20} /></button></div><form onSubmit={e => { e.preventDefault(); submitManual(); }}><label className="field"><span>Type</span><select value={addKind} onChange={e => setAddKind(e.target.value as TransactionKind)}><option value="expense">Expense</option><option value="income">Income</option><option value="transfer">Transfer</option></select></label><label className="field"><span>Date</span><input required type="date" value={addDate} onChange={e => setAddDate(e.target.value)} /></label><label className="field"><span>Description</span><input required value={addDescription} onChange={e => setAddDescription(e.target.value)} /></label><div className="field"><span>Category</span><CategorySelect label="Category for the new transaction" options={categories} value={addCategory} onChange={setAddCategory} /><button type="button" className="text-button" onClick={() => setShowCategoryManager(true)}><Tag size={14} /> Manage categories</button></div><label className="field"><span>Amount (R$)</span><input required inputMode="decimal" placeholder="0,00" value={addAmount} onChange={e => setAddAmount(e.target.value)} /></label>{error && <div role="alert" className="alert error">{error}</div>}<Button type="submit"><Plus size={16} /> Add transaction</Button></form></div></div>}
    {showCategoryManager && <CategoryManager data={data} onEdit={manageCategories} onClose={closeCategoryManager} />}
  </div>;
}
