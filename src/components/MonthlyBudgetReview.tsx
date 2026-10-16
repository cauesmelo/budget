import { useId, useState } from 'react';
import { ArrowRight, Pencil } from 'lucide-react';
import { formatMoney, formatMonth } from '../lib/finance';
import { getMonthlyBudgetReview, type MonthlyBudgetRow } from '../lib/monthlyBudget';
import { formatNumber } from '../lib/numbers';
import type { FinanceData } from '../lib/types';
import { MonthlyBudgetChart } from './MonthlyBudgetChart';
import './MonthlyBudgetReview.css';

interface MonthlyBudgetReviewProps {
  data: FinanceData;
  month: string;
  onReview: (row: MonthlyBudgetRow) => void;
  onPlan: (linkCategories?: boolean) => void;
}

function BudgetResult({ planned, spent, remaining, unassigned = false }: { planned: number; spent: number; remaining: number; unassigned?: boolean }) {
  if (unassigned) return <span className="monthly-budget-unassigned-result">Link categories in plan</span>;
  const state = remaining < 0 ? 'over' : remaining > 0 ? 'left' : 'even';
  return <span className={`monthly-budget-result ${state}`}>
    <strong>{formatMoney(Math.abs(remaining))}</strong>
    <small>{planned === 0 && spent > 0 ? 'Over · not budgeted' : state === 'over' ? 'Over budget' : state === 'left' ? 'Left to spend' : planned > 0 ? 'Fully spent' : 'No budget or spending'}</small>
  </span>;
}

export function MonthlyBudgetReview({ data, month, onReview, onPlan }: MonthlyBudgetReviewProps) {
  const headingId = useId();
  const [view, setView] = useState<'table' | 'chart'>('table');
  const [showUnused, setShowUnused] = useState(false);
  const review = getMonthlyBudgetReview(data, month);
  const rows = review.rows.filter(row => showUnused || row.plannedCents !== 0 || row.transactionCount > 0 || row.planItemIds.length > 0);
  const unusedCount = review.rows.length - rows.length;
  const workLabel = data.work?.label || 'Work';

  return <section className="panel monthly-budget-review" aria-labelledby={headingId}>
    <div className="panel-header monthly-budget-heading"><div><h2 id={headingId}>Plan vs spending</h2><p>{formatMonth(month)} · your medium-term plan compared with spending so far.</p></div>
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
    {review.unassignedPlanItemCount > 0 && <div className="monthly-budget-mapping-note"><span>{formatNumber(review.unassignedPlanItemCount)} planned {review.unassignedPlanItemCount === 1 ? 'expense needs' : 'expenses need'} a category link{review.unassignedPlanCents > 0 ? ` · ${formatMoney(review.unassignedPlanCents)}` : ''}. Link each expense once in your plan to compare category totals across all months. This amount stays in your total.</span><button type="button" className="text-button" onClick={() => onPlan(true)}>Link categories in plan <ArrowRight size={14} /></button></div>}
    {!review.hasRecordedExpenses && <p className="monthly-budget-no-records">No personal expenses recorded for this month yet. Your plan is shown below.</p>}
    <div className="monthly-budget-toolbar">
      <span>{view === 'table' ? 'Planned amounts come from your medium-term plan.' : 'Planned and spent amounts use the same scale.'}</span>
      <button type="button" className="text-button" onClick={() => onPlan()}><Pencil size={13} />Edit plan for this month</button>
    </div>
    {view === 'table' ? <>
      {rows.length ? <><p className="monthly-budget-swipe">Swipe horizontally to compare all columns.</p><div className="monthly-budget-table-scroll"><table className="monthly-budget-table">
        <caption className="monthly-budget-sr-only">Personal spending versus planned budget for {formatMonth(month)}</caption>
        <thead><tr><th scope="col">Category</th><th scope="col">Spent so far</th><th scope="col">Planned</th><th scope="col">Left / over</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.key} className={row.kind === 'unassigned-plan' ? 'unassigned' : row.remainingCents < 0 ? 'over-budget' : undefined} data-budget-row={row.key}>
          <th scope="row">{row.kind === 'unassigned-plan' ? <span>{row.label}</span> : row.transactionCount > 0 ? <button type="button" className="monthly-budget-category" onClick={() => onReview(row)} aria-label={`Review ${row.label} spending`}>{row.label}<ArrowRight size={12} /></button> : <span>{row.label}</span>}{row.archived && <small>Archived category</small>}{row.kind === 'uncategorized' && <small>Choose categories to improve this comparison.</small>}</th>
          <td>{row.kind === 'unassigned-plan' ? '—' : <><span>{formatMoney(row.spentCents)}</span>{row.spentCents < 0 && <small>Net refund</small>}</>}</td>
          <td><span>{formatMoney(row.plannedCents)}</span>{row.kind === 'unassigned-plan' && <button type="button" className="text-button" onClick={() => onPlan(true)}>Link categories in plan</button>}</td>
          <td><BudgetResult planned={row.plannedCents} spent={row.spentCents} remaining={row.remainingCents} unassigned={row.kind === 'unassigned-plan'} /></td>
        </tr>)}</tbody>
        <tfoot><tr><th scope="row">Personal total</th><td>{formatMoney(review.spentCents)}</td><td>{formatMoney(review.plannedCents)}</td><td><BudgetResult planned={review.plannedCents} spent={review.spentCents} remaining={review.remainingCents} /></td></tr></tfoot>
      </table></div></> : <div className="monthly-budget-empty"><h3>Plan your expenses once</h3><p>Add expenses to your medium-term plan. This review uses that same plan, and imported spending appears automatically.</p><button type="button" className="text-button" onClick={() => onPlan()}>Edit my plan <ArrowRight size={14} /></button></div>}
      {(unusedCount > 0 || showUnused) && <label className="monthly-budget-unused"><input type="checkbox" checked={showUnused} onChange={event => setShowUnused(event.target.checked)} />Show unused categories</label>}
    </> : <MonthlyBudgetChart rows={review.rows} onReview={onReview} />}
    <div className="monthly-budget-work"><div><strong>{workLabel} · separate from your budget</strong><span>Out {formatMoney(review.workOutCents)}<span aria-hidden="true"> · </span>In {formatMoney(review.workInCents)}</span></div><small>Work expenses and reimbursements are excluded from personal totals.</small></div>
    <p className="monthly-budget-note">Spending includes imported and manual personal expenses, net of refunds, by transaction date. Budget left is money not yet spent in the records; bills may still arrive.{review.unassignedPlanItemCount > 0 && ' Link the remaining plan categories before relying on each category’s result.'}</p>
  </section>;
}
