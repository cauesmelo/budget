import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, Pencil, Plus, X } from 'lucide-react';
import { availableCategoryNames, resolveCategoryName } from '../lib/categories';
import { formatMoney, formatMonth, planAmountForMonth } from '../lib/finance';
import { getMonthlyBudgetReview, type MonthlyBudgetRow } from '../lib/monthlyBudget';
import { formatNumber } from '../lib/numbers';
import { getOrderedPlanItems } from '../lib/planOrder';
import type { FinanceData } from '../lib/types';
import { CategorySelect } from './CategorySelect';
import { MoneyInput } from './MoneyInput';
import { MonthlyBudgetChart } from './MonthlyBudgetChart';
import './MonthlyBudgetReview.css';

interface MonthlyBudgetReviewProps {
  data: FinanceData;
  month: string;
  onAmount: (id: string, month: string, amountCents: number) => boolean;
  onCategory: (id: string, category: string) => boolean;
  onAdd: (category: string, month: string, amountCents: number) => boolean;
  onReview: (row: MonthlyBudgetRow) => void;
  onPlan: () => void;
  onCategories: () => void;
}

function BudgetResult({ planned, spent, remaining, unassigned = false }: { planned: number; spent: number; remaining: number; unassigned?: boolean }) {
  if (unassigned) return <span className="monthly-budget-unassigned-result">Assign a category</span>;
  const state = remaining < 0 ? 'over' : remaining > 0 ? 'left' : 'even';
  return <span className={`monthly-budget-result ${state}`}>
    <strong>{formatMoney(Math.abs(remaining))}</strong>
    <small>{planned === 0 && spent > 0 ? 'Over · not budgeted' : state === 'over' ? 'Over budget' : state === 'left' ? 'Left to spend' : planned > 0 ? 'Fully spent' : 'No budget or spending'}</small>
  </span>;
}

export function MonthlyBudgetReview({ data, month, onAmount, onCategory, onAdd, onReview, onPlan, onCategories }: MonthlyBudgetReviewProps) {
  const headingId = useId();
  const editorId = useId();
  const [view, setView] = useState<'table' | 'chart'>('table');
  const [showUnused, setShowUnused] = useState(false);
  const [editor, setEditor] = useState(false);
  const [editorCategory, setEditorCategory] = useState<string | null>(null);
  const [editorItemIds, setEditorItemIds] = useState<string[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [addCategory, setAddCategory] = useState('');
  const [addAmount, setAddAmount] = useState(0);
  const [message, setMessage] = useState('');
  const editorRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const review = getMonthlyBudgetReview(data, month);
  const categories = availableCategoryNames(data);
  const rows = review.rows.filter(row => showUnused || row.plannedCents !== 0 || row.transactionCount > 0 || row.planItemIds.length > 0);
  const unusedCount = review.rows.length - rows.length;
  const activeExpenses = getOrderedPlanItems(data).filter(item => !item.deletedAt && item.kind === 'expense' && item.startMonth <= month && (!item.endMonth || item.endMonth >= month));
  const editorItems = activeExpenses.filter(item => editorItemIds === null || editorItemIds.includes(item.id));
  const addOptions = categories.filter(category => !review.rows.some(row => row.kind === 'category' && row.category === category && row.planItemIds.length > 0));
  const workLabel = data.work?.label || 'Work';

  useEffect(() => { setMessage(''); setAdding(false); setEditorCategory(null); setEditorItemIds(null); }, [month]);
  useEffect(() => {
    if (!addCategory) return;
    const resolved = resolveCategoryName(data, addCategory);
    if (resolved !== addCategory || !addOptions.includes(addCategory)) setAddCategory(addOptions.includes(resolved) ? resolved : '');
  }, [data.categories, data.planItems, addCategory]);

  function editAmount(id: string, amountCents: number) {
    if (amountCents < 0) { setMessage('Enter a budget of zero or more.'); return false; }
    const accepted = onAmount(id, month, amountCents);
    if (accepted) setMessage(`Budget updated for ${formatMonth(month)}. Other months are unchanged.`);
    return accepted;
  }
  function openEditor(category: string | null = null) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditor(true); setEditorCategory(category); setAdding(false);
    setEditorItemIds(category === null ? null : activeExpenses.filter(item => resolveCategoryName(data, item.category) === category).map(item => item.id));
    requestAnimationFrame(() => { editorRef.current?.focus(); editorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  }
  function restoreFocus(fallback: HTMLButtonElement | null) {
    requestAnimationFrame(() => (returnFocus.current?.isConnected ? returnFocus.current : fallback)?.focus({ preventScroll: true }));
  }
  function closeEditor() { setEditor(false); restoreFocus(editButtonRef.current); }
  function openAdd(category = '') {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAdding(true); setEditor(false); setAddCategory(category); setAddAmount(0); setMessage('');
    requestAnimationFrame(() => { addRef.current?.querySelector<HTMLButtonElement>('[role=combobox]')?.focus(); addRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  }
  function saveNewBudget(event: React.FormEvent) {
    event.preventDefault();
    if (!addCategory || !addOptions.includes(addCategory)) { setMessage('Choose a category without an existing budget for this month.'); return; }
    if (addAmount <= 0) { setMessage('Enter an amount greater than zero.'); return; }
    if (onAdd(addCategory, month, addAmount)) {
      setAdding(false); setMessage(`Budget added for ${formatMonth(month)} only. It is also available in your medium-term plan.`);
      requestAnimationFrame(() => {
        const input = [...(sectionRef.current?.querySelectorAll<HTMLInputElement>('input[data-money-input]') ?? [])].find(element => element.getAttribute('aria-label') === `Planned budget for ${addCategory} in ${month}`);
        (input ?? addButtonRef.current)?.focus({ preventScroll: true });
      });
    }
  }

  return <section className="panel monthly-budget-review" aria-labelledby={headingId} ref={sectionRef}>
    <div className="panel-header monthly-budget-heading"><div><h2 id={headingId}>Monthly budget</h2><p>{formatMonth(month)} · compare your plan with personal spending so far.</p></div>
      <div className="monthly-budget-views" role="group" aria-label="Monthly budget view">
        <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>Table</button>
        <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>Chart</button>
      </div>
    </div>
    <dl className="monthly-budget-totals">
      <div><dt>Planned spending</dt><dd>{formatMoney(review.plannedCents)}</dd></div>
      <div><dt>Spent so far</dt><dd>{formatMoney(review.spentCents)}</dd></div>
      <div className={review.remainingCents < 0 ? 'over' : 'left'}><dt>{review.remainingCents < 0 ? 'Over budget' : 'Budget left'}</dt><dd>{formatMoney(Math.abs(review.remainingCents))}</dd></div>
    </dl>
    {review.unassignedPlanItemCount > 0 && <div className="monthly-budget-mapping-note"><span>{formatNumber(review.unassignedPlanItemCount)} planned {review.unassignedPlanItemCount === 1 ? 'expense needs' : 'expenses need'} a category link{review.unassignedPlanCents > 0 ? ` · ${formatMoney(review.unassignedPlanCents)}` : ''}. This amount stays in your total.</span><button type="button" className="text-button" onClick={() => openEditor('')}>Assign categories <ArrowRight size={14} /></button></div>}
    {!review.hasRecordedExpenses && <p className="monthly-budget-no-records">No personal expenses recorded for this month yet. Your plan is shown below.</p>}
    <div className="monthly-budget-toolbar">
      <span>{view === 'table' ? 'Edit a planned amount and press Enter to update this month only.' : 'Planned and spent amounts use the same scale.'}</span>
      <div><button ref={editButtonRef} type="button" className="text-button" aria-expanded={editor} aria-controls={editor ? editorId : undefined} onClick={() => editor && editorCategory === null ? closeEditor() : openEditor()}><Pencil size={13} />Edit budgets</button><button ref={addButtonRef} type="button" className="text-button" onClick={() => openAdd()}><Plus size={14} />Add budget</button></div>
    </div>
    {view === 'table' ? <>
      {rows.length ? <><p className="monthly-budget-swipe">Swipe horizontally to compare all columns.</p><div className="monthly-budget-table-scroll"><table className="monthly-budget-table">
        <caption className="monthly-budget-sr-only">Personal spending versus planned budget for {formatMonth(month)}</caption>
        <thead><tr><th scope="col">Category</th><th scope="col">Spent so far</th><th scope="col">Planned (R$)</th><th scope="col">Left / over</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.key} className={row.kind === 'unassigned-plan' ? 'unassigned' : row.remainingCents < 0 ? 'over-budget' : undefined} data-budget-row={row.key}>
          <th scope="row">{row.kind === 'unassigned-plan' ? <span>{row.label}</span> : row.transactionCount > 0 ? <button type="button" className="monthly-budget-category" onClick={() => onReview(row)} aria-label={`Review ${row.label} spending`}>{row.label}<ArrowRight size={12} /></button> : <span>{row.label}</span>}{row.archived && <small>Archived category</small>}{row.kind === 'uncategorized' && <small>Choose categories to improve this comparison.</small>}</th>
          <td>{row.kind === 'unassigned-plan' ? '—' : <><span>{formatMoney(row.spentCents)}</span>{row.spentCents < 0 && <small>Net refund</small>}</>}</td>
          <td>{row.planItemIds.length === 1 && row.kind === 'category' ? <MoneyInput label={`Planned budget for ${row.label} in ${month}`} value={row.plannedCents} onChange={amount => editAmount(row.planItemIds[0], amount)} /> : row.planItemIds.length > 0 ? <><span>{formatMoney(row.plannedCents)}</span><button type="button" className="text-button" aria-label={`Edit ${row.label} budget`} onClick={() => openEditor(row.kind === 'unassigned-plan' ? '' : row.category)}>{row.kind === 'unassigned-plan' ? 'Assign expenses' : `Edit ${formatNumber(row.planItemIds.length)} expenses`}</button></> : <><span>{formatMoney(0)}</span>{row.kind === 'category' && !row.archived && <button type="button" className="text-button" aria-label={`Set budget for ${row.label}`} onClick={() => openAdd(row.category)}>Set budget</button>}</>}</td>
          <td><BudgetResult planned={row.plannedCents} spent={row.spentCents} remaining={row.remainingCents} unassigned={row.kind === 'unassigned-plan'} /></td>
        </tr>)}</tbody>
        <tfoot><tr><th scope="row">Personal total</th><td>{formatMoney(review.spentCents)}</td><td>{formatMoney(review.plannedCents)}</td><td><BudgetResult planned={review.plannedCents} spent={review.spentCents} remaining={review.remainingCents} /></td></tr></tfoot>
      </table></div></> : <div className="monthly-budget-empty"><h3>Build your monthly budget</h3><p>Add a category budget here or enter expenses in your medium-term plan. Imported spending will appear automatically.</p><button type="button" className="text-button" onClick={() => openAdd()}>Add a budget <ArrowRight size={14} /></button></div>}
      {(unusedCount > 0 || showUnused) && <label className="monthly-budget-unused"><input type="checkbox" checked={showUnused} onChange={event => setShowUnused(event.target.checked)} />Show unused categories</label>}
    </> : <MonthlyBudgetChart rows={review.rows} onReview={onReview} />}
    {adding && <div className="monthly-budget-add" ref={addRef}>
      <div className="monthly-budget-editor-heading"><h3>Add a budget for {formatMonth(month)}</h3><button type="button" className="icon-button" aria-label="Cancel new category budget" onClick={() => { setAdding(false); restoreFocus(addButtonRef.current); }}><X size={16} /></button></div>
      <p>Creates a planned expense for this month only, using your existing medium-term plan.</p>
      {review.unassignedPlanItemCount > 0 && <p className="monthly-budget-existing-plan-note">If this expense is already in your plan, assign its category instead of adding another budget.</p>}
      {addOptions.length ? <form onSubmit={saveNewBudget}><div className="field"><span>Category</span><CategorySelect label="Category for new budget" value={addCategory} options={addOptions} allowUncategorized={false} placeholder="Choose a category" onChange={setAddCategory} /></div><label className="field"><span>Planned amount (R$)</span><MoneyInput label="New category budget amount" value={addAmount} onChange={setAddAmount} /></label><button className="button" type="submit">Add budget for this month</button></form> : <p>{categories.length ? 'Every available category already has an expense in this month. Use Edit budgets to change it, or add another category in Settings.' : 'Create your categories in Settings before adding category budgets.'} <button type="button" className="text-button" onClick={onCategories}>Open Settings <ArrowRight size={13} /></button></p>}
    </div>}
    {editor && <div id={editorId} ref={editorRef} tabIndex={-1} className="monthly-budget-editor">
      <div className="monthly-budget-editor-heading"><h3>{editorCategory === '' ? 'Assign categories to your plan' : editorCategory ? `${editorCategory} · planned expenses` : `Edit budgets for ${formatMonth(month)}`}</h3><button type="button" className="icon-button" aria-label="Close budget editor" onClick={closeEditor}><X size={16} /></button></div>
      <p>Category links apply to every month of an expense. Amount edits change {formatMonth(month)} only; repeating amounts stay unchanged.</p>
      {editorCategory !== null && <button type="button" className="text-button monthly-budget-show-all" onClick={() => { setEditorCategory(null); setEditorItemIds(null); }}>Show all planned expenses <ChevronDown size={13} /></button>}
      {editorItems.length ? <div className="monthly-budget-editor-list">{editorItems.map(item => <div key={item.id} className="monthly-budget-editor-row" data-budget-plan-id={item.id}>
        <span>{item.name || 'Unnamed expense'}</span>
        <div><span className="monthly-budget-editor-label">Category</span><CategorySelect label={`Budget category for ${item.name}`} value={resolveCategoryName(data, item.category)} options={categories} onChange={category => { if (onCategory(item.id, category)) setMessage('Category link saved for this expense.'); }} /></div>
        <label className="monthly-budget-editor-amount"><span>{formatMonth(month)} (R$)</span><MoneyInput label={`Budget for ${item.name} in ${month}`} value={planAmountForMonth(item, month)} onChange={amount => editAmount(item.id, amount)} /></label>
      </div>)}</div> : <p>No expenses in this selection. <button type="button" className="text-button" onClick={() => openAdd()}>Add a category budget</button></p>}
      <button type="button" className="text-button monthly-budget-plan-link" onClick={onPlan}>Open medium-term plan <ArrowRight size={14} /></button>
    </div>}
    <div className="monthly-budget-work"><div><strong>{workLabel} · separate from your budget</strong><span>Out {formatMoney(review.workOutCents)}<span aria-hidden="true"> · </span>In {formatMoney(review.workInCents)}</span></div><small>Work expenses and reimbursements are excluded from personal totals.</small></div>
    <p className="monthly-budget-note">Spending includes imported and manual personal expenses, net of refunds, by transaction date. Budget left is money not yet spent in the records; bills may still arrive.{review.unassignedPlanItemCount > 0 && ' Assign the remaining plan categories before relying on each category’s result.'}</p>
    <span className="monthly-budget-status" role="status" aria-live="polite">{message}</span>
  </section>;
}
