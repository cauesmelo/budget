import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, ChevronLeft, ChevronRight, Cloud, Download, FileSpreadsheet, FolderUp, LayoutDashboard, Leaf, ListFilter, LoaderCircle, Plus, RefreshCw, Search, Settings2, ShieldCheck, Trash2, TrendingUp, Upload, Wallet, X } from 'lucide-react';
import type { FinanceData, ImportResult, PlanItem, ProjectionMonth, Transaction, TransactionKind } from './lib/types';
import { addMonths, applyImport, createEmptyData, formatMoney, formatMonth, mergeFinanceData, parseMoneyToCents, previewDuplicateCount, projectReserve, summarizeMonth } from './lib/finance';
import { loadData, saveData, serializeBackup, validateBackup } from './lib/storage';
import { APP_ID } from './lib/identity';
import { connectDrive, disconnectDrive, isDriveConnected, syncDrive } from './lib/drive';

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const colors = ['#347362', '#94b88e', '#d9ac73', '#7c8baa', '#bc857f', '#93aeb0', '#bdad86'];
const moneyAxis = (cents: number) => Math.abs(cents) >= 100000 ? `${Math.round(cents / 100000)} mil` : formatMoney(cents);
const sourceNames = { bank: 'Conta Itaú', card: 'Cartão Itaú', budget: 'Budget', manual: 'Manual' };
const kindNames = { income: 'Receita', expense: 'Despesa', transfer: 'Transferência' };
const nav = [
  { id: 'overview', label: 'Visão geral', icon: LayoutDashboard },
  { id: 'transactions', label: 'Lançamentos', icon: ListFilter },
  { id: 'import', label: 'Importar arquivos', icon: FolderUp },
  { id: 'plan', label: 'Médio prazo', icon: TrendingUp },
  { id: 'settings', label: 'Dados e nuvem', icon: Settings2 },
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
  return <section className="panel"><div className="panel-header"><div><h2>Receitas e despesas previstas</h2><p>Compare o consumo planejado com suas receitas em cada mês.</p></div></div><div className="chart-legend"><span><i style={{ background: '#347362' }} />Receitas</span><span><i style={{ background: '#d9ac73' }} />Despesas de consumo</span></div><div className="chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={rows} margin={{ top: 10, right: 15, left: 10, bottom: 5 }}><CartesianGrid strokeDasharray="3 6" vertical={false} stroke="#e5e9e2" /><XAxis dataKey="month" tickFormatter={m => formatMonth(m)} minTickGap={35} axisLine={false} tickLine={false} tick={{ fontSize: 11 }} /><YAxis tickFormatter={moneyAxis} axisLine={false} tickLine={false} width={70} tick={{ fontSize: 11 }} /><Tooltip formatter={v => formatMoney(Number(v))} labelFormatter={m => formatMonth(String(m))} /><Bar dataKey="incomeCents" name="Receitas" isAnimationActive={false} fill="#347362" radius={[4, 4, 0, 0]} maxBarSize={20} /><Bar dataKey="expenseCents" name="Despesas de consumo" isAnimationActive={false} fill="#d9ac73" radius={[4, 4, 0, 0]} maxBarSize={20} /></BarChart></ResponsiveContainer></div></section>;
}
function TxTable({ transactions, categories, update, remove }: { transactions: Transaction[]; categories: string[]; update: (id: string, patch: Partial<Transaction>) => void; remove?: (id: string) => void }) {
  return <div className="table-scroll"><table className="tx-table"><thead><tr><th>Data / competência</th><th>Lançamento</th><th>Descrição</th><th>Categoria</th><th>Tipo</th><th className="right">Valor</th>{remove && <th />}</tr></thead><tbody>{transactions.map(tx => <tr key={tx.id}>
    <td className="date-cell">{tx.date.split('-').reverse().join('/')}<small>{tx.month} · {sourceNames[tx.source]}</small></td>
    <td className="original"><span title={tx.originalDescription}>{tx.originalDescription}</span>{tx.installment && <small>{tx.installment}</small>}</td>
    <td><input aria-label={`Descrição ${tx.originalDescription}`} placeholder="Adicionar descrição" value={tx.description} onChange={e => update(tx.id, { description: e.target.value })} /></td>
    <td><input aria-label={`Categoria ${tx.originalDescription}`} list="categories" placeholder="Sem categoria" value={tx.category} onChange={e => update(tx.id, { category: e.target.value })} /></td>
    <td><select aria-label={`Tipo ${tx.originalDescription}`} value={tx.kind} onChange={e => update(tx.id, { kind: e.target.value as TransactionKind })}>{Object.entries(kindNames).map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}</select></td>
    <td className={`right amount ${tx.kind === 'income' ? 'green' : tx.kind === 'transfer' ? 'muted' : ''}`}>{formatMoney(tx.amountCents)}</td>
    {remove && <td><button className="icon-button danger" title="Excluir lançamento" aria-label={`Excluir ${tx.originalDescription}`} onClick={() => remove(tx.id)}><Trash2 size={16} /></button></td>}
  </tr>)}</tbody></table><datalist id="categories">{categories.map(c => <option value={c} key={c} />)}</datalist></div>;
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
  const [saveStatus, setSaveStatus] = useState('Salvo neste navegador');
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

  useEffect(() => { loadData().then(saved => { if (saved) setData(saved); setLoaded(true); }).catch(e => { setStorageAvailable(false); setLoaded(true); setError(`Não foi possível abrir os dados locais. Você pode usar uma sessão temporária e exportar um backup: ${e.message}`); setSaveStatus('Sessão temporária · exporte um backup'); }); }, []);
  useEffect(() => {
    if (!loaded || !storageAvailable) return;
    setSaveStatus('Salvando…');
    const timer = setTimeout(() => { saveData(data).then(() => setSaveStatus('Salvo neste navegador')).catch(e => { setSaveStatus('Falha ao salvar'); setError(`Os dados ainda estão na memória. Exporte um backup: ${e.message}`); }); }, 250);
    return () => clearTimeout(timer);
  }, [data, loaded, storageAvailable]);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(`${APP_ID}-data`); channel.current = ch;
    ch.onmessage = e => { try { const remote = validateBackup(e.data); setData(local => mergeFinanceData(local, remote)); } catch { /* Ignore unrelated messages. */ } };
    return () => { ch.close(); channel.current = null; };
  }, []);
  useEffect(() => { setOffset(0); }, [month, query, filterCategory, filterSource, mode]);
  useEffect(() => { setPlanOffset(0); }, [data.settings.horizonMonths, data.settings.reserveStartMonth]);
  useEffect(() => { if (!notification) return; const t = setTimeout(() => setNotification(''), 6000); return () => clearTimeout(t); }, [notification]);

  function change(edit: (current: FinanceData) => FinanceData) {
    try {
      const next = validateBackup({ ...edit(dataRef.current), updatedAt: new Date().toISOString() });
      dataRef.current = next; setData(next);
      channel.current?.postMessage(JSON.parse(serializeBackup(next)));
    } catch (e) { setError(e instanceof Error ? e.message : 'Confira os valores informados.'); }
  }
  function patchSettings(patch: Partial<FinanceData['settings']>) { change(d => ({ ...d, settings: { ...d.settings, ...patch, updatedAt: Object.keys(patch).some(key => key !== 'googleClientId') ? new Date().toISOString() : d.settings.updatedAt } })); }
  function patchTx(id: string, patch: Partial<Transaction>) { change(d => ({ ...d, transactions: d.transactions.map(t => t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t) })); }
  function patchPlan(id: string, patch: Partial<PlanItem>) {
    const existing = dataRef.current.planItems.find(p => p.id === id);
    if (existing) { const next = { ...existing, ...patch }; if (next.endMonth && next.endMonth < next.startMonth) { setError('O mês final precisa ser igual ou posterior ao mês inicial.'); return; } }
    change(d => ({ ...d, planItems: d.planItems.map(p => p.id === id ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p) }));
  }
  const categories = [...new Set([...data.transactions.filter(t => !t.deletedAt).map(t => t.category), ...data.planItems.map(p => p.category)].filter(Boolean))].sort();
  const activeTx = data.transactions.filter(t => !t.deletedAt);
  const monthTx = activeTx.filter(t => t.month === month && (mode === 'budget' ? t.source === 'budget' : t.source !== 'budget'));
  const filtered = monthTx.filter(t => (!filterCategory || (filterCategory === '__empty' ? !t.category : t.category === filterCategory)) && (!filterSource || t.source === filterSource) && `${t.originalDescription} ${t.description} ${t.category}`.toLocaleLowerCase('pt-BR').includes(query.toLocaleLowerCase('pt-BR'))).sort((a, b) => b.date.localeCompare(a.date) || a.originalDescription.localeCompare(b.originalDescription));
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
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível ler este arquivo.'); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  function confirmImports() {
    let next = data; let count = 0;
    for (const item of pending) { const before = next.transactions.length; next = applyImport(next, item.result, item.name); count += next.transactions.length - before; }
    change(() => next);
    if (pending.some(p => p.result.source === 'budget') && !pending.some(p => p.result.source !== 'budget')) {
      setMode('budget'); const latest = next.snapshots.map(s => s.month).sort().at(-1); if (latest) setMonth(latest);
    } else { setMode('transactions'); const latest = next.transactions.filter(t => t.source !== 'budget').map(t => t.month).sort().at(-1); if (latest) setMonth(latest); }
    setPending([]); setNotification(`Importação concluída. ${count} lançamentos novos; repetições foram preservadas sem duplicar.`); setPage('overview');
  }
  function downloadBackup() {
    const url = URL.createObjectURL(new Blob([serializeBackup(data)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${APP_ID}-backup-${today()}.json`; a.click(); URL.revokeObjectURL(url); setNotification('Backup exportado.');
  }
  async function restoreBackup(file: File) {
    try { const restored = validateBackup(await file.text()); change(d => mergeFinanceData(d, restored)); setNotification('Backup validado e reunido com seus dados locais.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Backup inválido.'); }
    finally { if (backupInput.current) backupInput.current.value = ''; }
  }
  async function sync() {
    setBusy(true); setError('');
    try {
      if (!isDriveConnected()) await connectDrive(settingsClientId);
      setConnected(true);
      const result = await syncDrive(data);
      change(current => mergeFinanceData(current, result.data)); setLastSync(result.syncedAt); setNotification('Dados sincronizados com o Google Drive.');
    } catch (e) { setConnected(isDriveConnected()); setError(e instanceof Error ? e.message : 'Não foi possível sincronizar.'); }
    finally { setBusy(false); }
  }
  function submitManual() {
    let cents: number;
    try { cents = parseMoneyToCents(addAmount); }
    catch { setError('Informe um valor válido, como 123,45.'); return; }
    if (!Number.isSafeInteger(cents) || cents <= 0 || !addDescription.trim() || !addDate) { setError('Preencha a data, a descrição e um valor maior que zero.'); return; }
    const id = crypto.randomUUID(); const stamp = new Date().toISOString();
    change(d => ({ ...d, transactions: [...d.transactions, { id, fingerprint: `manual:${id}`, date: addDate, month: addDate.slice(0, 7), amountCents: addKind === 'income' ? cents : -cents, kind: addKind, source: 'manual', account: 'Manual', originalDescription: addDescription.trim(), description: addDescription.trim(), category: addCategory.trim(), updatedAt: stamp }] }));
    setShowAdd(false); setError(''); setMode('transactions'); setMonth(addDate.slice(0, 7)); setAddDescription(''); setAddAmount(''); setNotification('Lançamento adicionado.');
  }
  function addPlan() {
    const now = new Date().toISOString(); change(d => ({ ...d, planItems: [...d.planItems, { id: crypto.randomUUID(), name: 'Novo item', category: '', kind: 'expense', defaultAmountCents: 0, amounts: {}, startMonth: d.settings.reserveStartMonth, updatedAt: now }] }));
  }

  if (!loaded) return <div className="loading-screen"><LoaderCircle className="spin" /> Abrindo suas finanças…{error && <p>{error}</p>}</div>;
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#" onClick={e => { e.preventDefault(); setPage('overview'); }}><div className="brand-mark"><Leaf size={24} /></div>{APP_ID}<span className="brand-dot">.</span></a><p className="nav-caption">SUAS FINANÇAS</p><nav>{nav.map(item => <button key={item.id} onClick={() => setPage(item.id)} className={page === item.id ? 'active' : ''}><item.icon size={19} />{item.label}{item.id === 'import' && <span className="nav-plus">+</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><ShieldCheck size={21} /><p>Seus dados, com você.<small>Salvamento local e nuvem opcional.</small></p></div><div className="profile"><div className="avatar">EU</div><div>Meu orçamento<small>Finanças pessoais</small></div><span className="status-dot" /></div></div>
    </aside>
    <main className="main"><header className="topbar"><span>MEU ESPAÇO <span className="separator">/</span> <strong>{nav.find(n => n.id === page)?.label}</strong></span><div className="save-indicator"><span className={saveStatus.startsWith('Falha') ? 'status-dot red' : 'status-dot'} />{saveStatus}<button className="icon-button" onClick={() => setPage('settings')} title="Dados e nuvem"><Cloud size={18} /></button></div></header>
      <div className="page-content">
      {error && <div role="alert" className="alert error"><span>{error}</span><button className="icon-button" aria-label="Fechar aviso" onClick={() => setError('')}><X size={18} /></button></div>}
      {notification && <div role="status" className="alert success"><Check size={18} />{notification}</div>}
      <div className="page-heading"><div><div className="eyebrow">{page === 'plan' ? 'OLHE MAIS À FRENTE' : page === 'overview' ? 'UM PASSO DE CADA VEZ' : 'SEU ORÇAMENTO, ORGANIZADO'}</div><h1>{page === 'overview' ? 'Clareza para o seu dinheiro.' : page === 'transactions' ? 'Cada gasto no seu lugar.' : page === 'import' ? 'Do extrato para o seu orçamento.' : page === 'plan' ? 'Dê espaço aos seus planos.' : 'Seus dados, onde você estiver.'}</h1><p>{page === 'overview' ? 'Acompanhe o mês e entenda para onde seus recursos estão indo.' : page === 'transactions' ? 'Revise os lançamentos e complete as categorias e descrições.' : page === 'import' ? 'Importe os arquivos do Itaú e aproveite o histórico da sua planilha.' : page === 'plan' ? 'Planeje receitas, despesas e a evolução das suas reservas.' : 'Continue no navegador e sincronize entre computadores quando quiser.'}</p></div>{['overview', 'transactions'].includes(page) && <Button onClick={() => setPage('import')}><Plus size={17} /> Importar extrato</Button>}</div>
      {['overview', 'transactions'].includes(page) && <div className="period-bar"><div className="month-switch"><button className="icon-button" aria-label="Mês anterior" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={18} /></button><input type="month" aria-label="Mês selecionado" value={month} onChange={e => e.target.value && setMonth(e.target.value)} /><button className="icon-button" aria-label="Mês seguinte" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight size={18} /></button></div><div className="segmented"><button className={mode === 'transactions' ? 'selected' : ''} onClick={() => setMode('transactions')}>Extratos e lançamentos</button><button className={mode === 'budget' ? 'selected' : ''} onClick={() => setMode('budget')}>Histórico do Budget</button></div></div>}

      {page === 'overview' && <>
        <div className="metrics"><Metric label="Entradas do mês" value={formatMoney(summary.incomeCents)} detail={`${formatMonth(month)} · receitas registradas`} icon={<ArrowDownLeft size={18} />} /><Metric label="Despesas do mês" value={formatMoney(summary.expenseCents)} detail="Consumo, descontando estornos" icon={<ArrowUpRight size={18} />} /><Metric label="Resultado do mês" value={formatMoney(summary.netCents)} detail={savings === null ? 'Registre suas receitas para ver a taxa de poupança' : `${savings}% das receitas disponíveis`} icon={<Wallet size={18} />} tint /><Metric label="A categorizar" value={String(pendingCount).padStart(2, '0')} detail="Lançamentos aguardando sua revisão" icon={<ListFilter size={18} />} /></div>
        {!activeTx.length && <div className="welcome"><div><span className="pill">VAMOS COMEÇAR</span><h2>Seu orçamento já tem uma história.</h2><p>Importe o Budget para trazer os meses anteriores e seu planejamento. Depois, adicione os extratos da conta e do cartão.</p><Button onClick={() => setPage('import')}>Importar meus arquivos <ArrowRight size={17} /></Button></div><div className="welcome-art"><FileSpreadsheet size={72} strokeWidth={1} /><span className="art-dot" /></div></div>}
        <div className="charts-grid"><section className="panel"><div className="panel-header"><div><h2>Receitas e despesas</h2><p>Seu ritmo nos últimos seis meses</p></div><span className="pill subdued">MENSAL</span></div><div className="chart-legend"><span><i style={{ background: '#347362' }} />Receitas</span><span><i style={{ background: '#d9ac73' }} />Despesas</span></div><div className="chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={monthlyHistory} margin={{ top: 10, right: 5, left: 8, bottom: 0 }}><CartesianGrid strokeDasharray="3 6" vertical={false} stroke="#e5e9e2" /><XAxis dataKey="month" tickFormatter={m => formatMonth(m).split(' ')[0]} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#7c8580' }} dy={8} /><YAxis tickFormatter={moneyAxis} axisLine={false} tickLine={false} width={65} tick={{ fontSize: 11, fill: '#7c8580' }} /><Tooltip formatter={v => formatMoney(Number(v))} labelFormatter={m => formatMonth(String(m))} contentStyle={{ borderRadius: 12, borderColor: '#e5e9e2', fontSize: 12 }} /><Bar isAnimationActive={false} dataKey="incomeCents" name="Receitas" fill="#347362" radius={[5, 5, 0, 0]} maxBarSize={23} /><Bar isAnimationActive={false} dataKey="expenseCents" name="Despesas" fill="#d9ac73" radius={[5, 5, 0, 0]} maxBarSize={23} /></BarChart></ResponsiveContainer></div></section>
        <section className="panel"><div className="panel-header"><div><h2>Para onde vai o dinheiro</h2><p>Despesas por categoria neste mês</p></div></div>{expenseCategories.length ? <><div className="donut"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie isAnimationActive={false} data={expenseCategories.map(([name, value]) => ({ name, value }))} dataKey="value" innerRadius={66} outerRadius={91} paddingAngle={3} stroke="none">{expenseCategories.map(([name], i) => <Cell key={name} fill={colors[i % colors.length]} />)}</Pie><Tooltip formatter={v => formatMoney(Number(v))} /></PieChart></ResponsiveContainer><div className="donut-center"><small>TOTAL</small><strong>{formatMoney(summary.expenseCents)}</strong></div></div><div className="category-list">{expenseCategories.slice(0, 5).map(([name, value], i) => <div key={name}><span><i style={{ background: colors[i % colors.length] }} />{name}</span><strong>{formatMoney(value)}</strong></div>)}</div></> : <Empty title="As categorias aparecem aqui"><p>Categorize suas despesas para entender a distribuição dos gastos.</p></Empty>}</section></div>
        <div className="overview-bottom"><section className="panel reserve-card"><div className="reserve-heading"><span className="reserve-icon"><TrendingUp size={23} /></span><div><h2>O próximo capítulo</h2><p>Suas reservas no médio prazo</p></div></div><div className="reserve-values"><div><small>Reserva na abertura de {formatMonth(data.settings.reserveStartMonth)}</small><strong>{formatMoney(data.settings.initialReserveCents)}</strong></div><ArrowRight size={21} /><div><small>Projeção para {finalProjection ? formatMonth(finalProjection.month) : 'o período'}</small><strong>{formatMoney(finalProjection?.closingCents ?? 0)}</strong></div></div><button className="text-button" onClick={() => setPage('plan')}>Explorar meu planejamento <ArrowRight size={16} /></button></section><section className="panel next-card"><span className="pill subdued">PRÓXIMO PASSO</span><h2>{pendingCount ? 'Complete a visão do seu mês.' : 'Mantenha seu orçamento em dia.'}</h2><p>{pendingCount ? `${pendingCount} lançamentos ainda estão sem categoria. A revisão deixa os gráficos mais úteis.` : 'Importe novos extratos quando precisar. O aplicativo reconhece os lançamentos já importados.'}</p><button className="text-button" onClick={() => setPage(pendingCount ? 'transactions' : 'import')}>{pendingCount ? 'Revisar lançamentos' : 'Adicionar extratos'} <ArrowRight size={16} /></button></section></div>
      </>}

      {page === 'transactions' && <section className="panel"><div className="panel-header"><div><h2>Lançamentos de {formatMonth(month)}</h2><p>{monthTx.length} registros · transferências ficam fora das despesas</p></div><Button secondary onClick={() => setShowAdd(true)}><Plus size={16} /> Lançamento manual</Button></div><div className="filters"><div className="search"><Search size={17} /><input aria-label="Buscar lançamento" placeholder="Buscar lançamento ou descrição" value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label="Filtrar categoria" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}><option value="">Todas as categorias</option><option value="__empty">Sem categoria</option>{categories.map(c => <option key={c}>{c}</option>)}</select><select aria-label="Filtrar origem" value={filterSource} onChange={e => setFilterSource(e.target.value)}><option value="">Todas as origens</option>{Object.entries(sourceNames).map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select></div>{filtered.length ? <><TxTable transactions={filtered.slice(offset, offset + 40)} categories={categories} update={patchTx} remove={id => patchTx(id, { deletedAt: new Date().toISOString() })} /><div className="pagination"><span>{offset + 1}–{Math.min(offset + 40, filtered.length)} de {filtered.length}</span><Button secondary disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 40))}>Anterior</Button><Button secondary disabled={offset + 40 >= filtered.length} onClick={() => setOffset(offset + 40)}>Próximos</Button></div></> : <Empty title="Nenhum lançamento neste filtro"><p>Escolha outro mês ou importe um extrato para começar.</p></Empty>}</section>}

      {page === 'import' && <>
        <div className="import-layout"><section className="panel import-panel"><div className="panel-header"><div><h2>Importar arquivos</h2><p>Leitura feita neste computador</p></div><FileSpreadsheet size={23} /></div><label className="field"><span>Competência da fatura do cartão</span><input type="month" value={cardMonth} onChange={e => e.target.value && setCardMonth(e.target.value)} /><small>Compras e parcelas entram no mês da fatura, mesmo quando a compra ocorreu antes.</small></label><div className="dropzone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) void importFiles(e.dataTransfer.files); }}><div className="upload-icon"><Upload size={27} /></div><h3>Seus arquivos começam aqui.</h3><p>Arraste os arquivos ou escolha no computador.</p><Button onClick={() => fileInput.current?.click()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} Escolher arquivos</Button><small>.xls e .xlsx · conta, cartão e Budget</small><input ref={fileInput} type="file" multiple accept=".xls,.xlsx" className="hidden" onChange={e => e.target.files && void importFiles(e.target.files)} /></div></section><section className="panel import-guide"><span className="pill subdued">COMO FUNCIONA</span><h2>Menos preenchimento.<br />Mais clareza.</h2><div className="guide-step"><span>01</span><div><h3>Exporte no Itaú</h3><p>Baixe o extrato da conta e a fatura do cartão em Excel.</p></div></div><div className="guide-step"><span>02</span><div><h3>Confira antes de importar</h3><p>Data, valor, lançamento e parcelas vêm preenchidos. Pagamentos da fatura e investimentos são separados do consumo.</p></div></div><div className="guide-step"><span>03</span><div><h3>Dê o seu contexto</h3><p>Complete categoria e descrição. Você também pode corrigir o tipo de um lançamento.</p></div></div><div className="guide-foot"><ShieldCheck size={18} /><span>Arquivos repetidos não duplicam os registros. O histórico do Budget tem uma visão própria.</span></div></section></div>
        {pending.map((item, index) => <section className="panel preview" key={`${item.name}-${index}`}><div className="panel-header"><div><h2>{item.name}</h2><p>{item.result.transactions.length} lançamentos · {previewDuplicateCount(data, item.result)} já importados · {item.result.planItems.length} itens de planejamento</p></div><span className="pill subdued">PRÉVIA</span></div>{item.result.summary && <p>{item.result.summary}</p>}{item.result.warnings.map((warning, i) => <div className="alert warning" key={i}>{warning}</div>)}{item.result.transactions.length > 0 && <><TxTable transactions={item.result.transactions.slice(0, 20)} categories={categories} update={(id, patch) => setPending(current => current.map((p, idx) => idx === index ? { ...p, result: { ...p.result, transactions: p.result.transactions.map(t => t.id === id ? { ...t, ...patch } : t) } } : p))} /><p className="footnote">Prévia dos primeiros {Math.min(20, item.result.transactions.length)} registros. Todos poderão ser revisados em Lançamentos.</p></>}</section>)}
        {!!pending.length && <div className="import-actions"><Button secondary onClick={() => setPending([])}>Cancelar</Button><Button onClick={confirmImports}><Check size={17} /> Confirmar importação</Button></div>}
      </>}

      {page === 'plan' && <>
        <section className="panel plan-settings"><div className="panel-header"><div><h2>Ponto de partida</h2><p>A reserva informada é o saldo na abertura do primeiro mês.</p></div><span className="pill subdued">EDITÁVEL</span></div><div className="settings-grid"><label className="field"><span>Primeiro mês</span><input type="month" value={data.settings.reserveStartMonth} onChange={e => e.target.value && patchSettings({ reserveStartMonth: e.target.value })} /></label><label className="field"><span>Reserva inicial (R$)</span><MoneyInput label="Reserva inicial" value={data.settings.initialReserveCents} onChange={n => patchSettings({ initialReserveCents: n })} /></label><label className="field"><span>Horizonte em meses</span><input type="number" min="1" max="120" value={data.settings.horizonMonths} onChange={e => patchSettings({ horizonMonths: Math.min(120, Math.max(1, Number(e.target.value) || 1)) })} /></label><label className="field"><span>Rendimento mensal esperado (%)</span><input type="number" min="-100" max="100" step="0.01" value={data.settings.monthlyReturnPercent} onChange={e => patchSettings({ monthlyReturnPercent: Math.min(100, Math.max(-100, Number(e.target.value))) })} /></label></div></section>
        <div className="plan-summary"><Metric label="Reserva ao final" value={formatMoney(finalProjection?.closingCents ?? 0)} detail={finalProjection ? formatMonth(finalProjection.month) : 'Defina o horizonte'} icon={<Wallet size={18} />} tint /><Metric label="Resultado médio mensal" value={formatMoney(projection.length ? Math.round(projection.reduce((s, m) => s + m.netCents, 0) / projection.length) : 0)} detail="Receitas menos consumo planejado" icon={<TrendingUp size={18} />} /><Metric label="Meses com saldo negativo" value={String(projection.filter(p => p.closingCents < 0).length)} detail="Meses em que a reserva fica abaixo de zero" icon={<ListFilter size={18} />} /></div>
        <section className="panel"><div className="panel-header"><div><h2>Evolução das reservas</h2><p>Saldo inicial + resultado do mês + rendimento sobre o saldo inicial</p></div></div><div className="chart tall"><ResponsiveContainer width="100%" height="100%"><AreaChart data={projection} margin={{ top: 15, right: 15, left: 15, bottom: 5 }}><defs><linearGradient id="reserveGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#347362" stopOpacity={0.25} /><stop offset="100%" stopColor="#347362" stopOpacity={0.02} /></linearGradient></defs><CartesianGrid strokeDasharray="3 6" vertical={false} stroke="#e5e9e2" /><XAxis dataKey="month" tickFormatter={m => formatMonth(m)} minTickGap={45} axisLine={false} tickLine={false} tick={{ fontSize: 11 }} /><YAxis tickFormatter={moneyAxis} width={75} axisLine={false} tickLine={false} tick={{ fontSize: 11 }} /><Tooltip formatter={v => formatMoney(Number(v))} labelFormatter={m => formatMonth(String(m))} /><Area isAnimationActive={false} type="monotone" dataKey="closingCents" name="Reserva ao final" stroke="#347362" strokeWidth={2.5} fill="url(#reserveGradient)" /></AreaChart></ResponsiveContainer></div></section>
        <PlanningCashChart rows={projection} />
        <section className="panel goal-panel"><div><h2>Uma meta para a sua reserva</h2><p>Defina o valor que deseja acumular.</p></div><label className="field"><span>Meta (R$)</span><MoneyInput label="Meta de reserva" value={data.settings.reserveGoalCents} onChange={n => patchSettings({ reserveGoalCents: Math.max(0, n) })} /></label><div className="goal-progress"><div><span style={{ width: `${goalProgress}%` }} /></div><small>{Math.round(goalProgress)}% na reserva inicial{data.settings.reserveGoalCents > 0 && (projection.find(p => p.closingCents >= data.settings.reserveGoalCents) ? ` · meta prevista em ${formatMonth(projection.find(p => p.closingCents >= data.settings.reserveGoalCents)!.month)}` : ' · meta não atingida no horizonte')}</small></div></section>
        <section className="panel plan-table-panel"><div className="panel-header"><div><h2>Seu orçamento de médio prazo</h2><p>O valor mensal se repete. Edite um mês para criar uma exceção, inclusive zero.</p></div><Button secondary onClick={addPlan}><Plus size={16} /> Adicionar item</Button></div><div className="plan-controls"><span>Aportes são metas internas e ficam fora do consumo e do resultado.</span><div><button className="icon-button" disabled={planOffset === 0} onClick={() => setPlanOffset(Math.max(0, planOffset - 6))} aria-label="Meses anteriores no planejamento"><ChevronLeft size={18} /></button><button className="icon-button" disabled={planOffset + 6 >= projection.length} onClick={() => setPlanOffset(planOffset + 6)} aria-label="Próximos meses no planejamento"><ChevronRight size={18} /></button></div></div><div className="table-scroll"><table className="plan-table"><thead><tr><th>Item</th><th>Tipo</th><th>Início / fim</th><th>Mensal (R$)</th>{projection.slice(planOffset, planOffset + 6).map(m => <th key={m.month}>{formatMonth(m.month)}</th>)}<th /></tr></thead><tbody>{data.planItems.filter(p => !p.deletedAt).map(item => <tr key={item.id}><td><input aria-label="Nome do item" value={item.name} onChange={e => patchPlan(item.id, { name: e.target.value })} /></td><td><select aria-label={`Tipo de ${item.name}`} value={item.kind} onChange={e => patchPlan(item.id, { kind: e.target.value as PlanItem['kind'] })}><option value="income">Receita</option><option value="expense">Despesa</option><option value="contribution">Aporte</option></select></td><td className="plan-dates"><input aria-label={`Início de ${item.name}`} type="month" value={item.startMonth} onChange={e => e.target.value && patchPlan(item.id, { startMonth: e.target.value })} /><input aria-label={`Fim de ${item.name}`} type="month" value={item.endMonth || ''} onChange={e => patchPlan(item.id, { endMonth: e.target.value || undefined })} /></td><td><MoneyInput label={`Valor mensal de ${item.name}`} value={item.defaultAmountCents} onChange={n => patchPlan(item.id, { defaultAmountCents: Math.max(0, n) })} /></td>{projection.slice(planOffset, planOffset + 6).map(m => { const active = m.month >= item.startMonth && (!item.endMonth || m.month <= item.endMonth); const override = Object.hasOwn(item.amounts, m.month); return <td key={m.month} className={override ? 'overridden' : ''}>{active ? <div className="override-cell"><MoneyInput label={`${item.name} em ${m.month}`} value={override ? item.amounts[m.month] : item.defaultAmountCents} onChange={n => patchPlan(item.id, { amounts: { ...item.amounts, [m.month]: Math.max(0, n) } })} />{override && <button className="reset-month" title="Usar valor mensal padrão" aria-label={`Remover exceção ${item.name} ${m.month}`} onClick={() => { const amounts = { ...item.amounts }; delete amounts[m.month]; patchPlan(item.id, { amounts }); }}><X size={12} /></button>}</div> : <span className="muted">—</span>}</td>; })}<td><button className="icon-button danger" aria-label={`Excluir item ${item.name}`} onClick={() => patchPlan(item.id, { deletedAt: new Date().toISOString() })}><Trash2 size={16} /></button></td></tr>)}{['incomeCents', 'expenseCents', 'netCents', 'closingCents'].map(key => <tr className={`plan-total ${key === 'closingCents' ? 'final' : ''}`} key={key}><td colSpan={4}>{({ incomeCents: 'Receitas', expenseCents: 'Despesas de consumo', netCents: 'Resultado do mês', closingCents: 'Reserva ao final' } as Record<string, string>)[key]}</td>{projection.slice(planOffset, planOffset + 6).map(m => <td key={m.month}>{formatMoney(m[key as keyof typeof m] as number)}</td>)}<td /></tr>)}</tbody></table></div>{!data.planItems.some(p => !p.deletedAt) && <Empty title="O planejamento começa pelos seus compromissos"><p>Importe o Budget ou adicione receitas e despesas esperadas.</p></Empty>}</section>
      </>}

      {page === 'settings' && <div className="settings-layout"><section className="panel"><div className="panel-header"><div><h2>Google Drive</h2><p>Sincronização na pasta privada deste aplicativo</p></div><Cloud size={24} /></div><div className="cloud-status"><span className={`status-dot ${connected ? '' : 'neutral'}`} />{connected ? 'Conectado nesta sessão' : 'Ainda não conectado'}</div><label className="field"><span>ID do cliente Google OAuth</span><input placeholder="Seu ID termina em .apps.googleusercontent.com" aria-label="ID cliente Google" value={settingsClientId} onChange={e => patchSettings({ googleClientId: e.target.value.trim() })} /><small>Configure uma vez na sua conta Google. Use o mesmo ID em cada computador.</small></label><p className="settings-copy">O aplicativo reúne os dados locais e da nuvem antes de salvar uma nova cópia. Quando usar outro computador, conecte o Drive e sincronize antes de continuar.</p><div className="button-row"><Button disabled={busy || !settingsClientId} onClick={() => void sync()}>{busy ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}{connected ? 'Sincronizar agora' : 'Conectar e sincronizar'}</Button>{connected && <Button secondary onClick={() => { disconnectDrive(); setConnected(false); }}>Desconectar</Button>}</div>{lastSync && <p className="footnote">Última sincronização nesta sessão: {new Date(lastSync).toLocaleString('pt-BR')}</p>}<details className="setup-details"><summary>Como configurar sem um servidor pago</summary><ol><li>Crie um projeto no Google Cloud e habilite a Google Drive API.</li><li>Configure a tela de consentimento e o escopo <code>drive.appdata</code>.</li><li>Crie um cliente OAuth do tipo Aplicativo da Web com a origem <code>http://localhost:5173</code>.</li><li>Em modo de testes, adicione seu e-mail aos usuários de teste.</li><li>Copie o ID do cliente para o campo acima. Os detalhes e as opções estão em <code>docs/NUVEM.md</code>.</li></ol><p>A API tem quotas gratuitas suficientes para uso pessoal. O espaço utiliza o armazenamento disponível na sua conta Google. Tokens expiram e uma nova autorização pode ser necessária.</p></details></section>
      <section className="panel"><div className="panel-header"><div><h2>Uma cópia sempre com você</h2><p>Backup em JSON com lançamentos e planejamento</p></div><Download size={22} /></div><p className="settings-copy">Os dados ficam neste navegador. Exporte uma cópia antes de limpar os dados do navegador ou trocar de computador. O backup pode ser restaurado e reunido com seus dados atuais.</p><div className="button-row"><Button secondary onClick={downloadBackup}><Download size={17} /> Exportar backup</Button><Button secondary onClick={() => backupInput.current?.click()}><Upload size={17} /> Restaurar backup</Button></div><input ref={backupInput} type="file" accept=".json,application/json" className="hidden" onChange={e => e.target.files?.[0] && void restoreBackup(e.target.files[0])} /><div className="data-counts"><div><strong>{activeTx.length}</strong><small>Lançamentos</small></div><div><strong>{data.planItems.filter(p => !p.deletedAt).length}</strong><small>Itens no plano</small></div><div><strong>{data.imports.length}</strong><small>Importações</small></div></div><div className="privacy-note"><ShieldCheck size={19} /><p>Seus extratos são processados localmente. Somente os dados estruturados são enviados ao Drive quando você sincroniza.</p></div></section>
      <section className="panel imports-history"><div className="panel-header"><div><h2>Histórico de importações</h2><p>Arquivos processados por você</p></div></div>{data.imports.length ? data.imports.slice().sort((a, b) => b.importedAt.localeCompare(a.importedAt)).map(batch => <div className="import-history-row" key={batch.id}><FileSpreadsheet size={19} /><div><strong>{batch.filename}</strong><small>{new Date(batch.importedAt).toLocaleString('pt-BR')} · {batch.count} novos registros</small></div></div>) : <p className="muted">Os arquivos importados aparecerão aqui.</p>}</section></div>}
      <footer className="page-footer"><span>{APP_ID}<span className="brand-dot">.</span></span><span>Espaço para cuidar do presente e planejar o futuro.</span></footer>
      </div>
    </main>
    {showAdd && <div className="modal-backdrop" onClick={() => setShowAdd(false)}><div className="modal panel" role="dialog" aria-modal="true" aria-label="Novo lançamento" onClick={e => e.stopPropagation()}><div className="panel-header"><h2>Novo lançamento</h2><button className="icon-button" aria-label="Fechar" onClick={() => setShowAdd(false)}><X size={20} /></button></div><form onSubmit={e => { e.preventDefault(); submitManual(); }}><label className="field"><span>Tipo</span><select value={addKind} onChange={e => setAddKind(e.target.value as TransactionKind)}><option value="expense">Despesa</option><option value="income">Receita</option><option value="transfer">Transferência</option></select></label><label className="field"><span>Data</span><input required type="date" value={addDate} onChange={e => setAddDate(e.target.value)} /></label><label className="field"><span>Descrição</span><input required value={addDescription} onChange={e => setAddDescription(e.target.value)} /></label><label className="field"><span>Categoria</span><input list="categories" value={addCategory} onChange={e => setAddCategory(e.target.value)} /></label><label className="field"><span>Valor (R$)</span><input required inputMode="decimal" placeholder="0,00" value={addAmount} onChange={e => setAddAmount(e.target.value)} /></label>{error && <div role="alert" className="alert error">{error}</div>}<Button type="submit"><Plus size={16} /> Adicionar lançamento</Button></form></div></div>}
  </div>;
}
