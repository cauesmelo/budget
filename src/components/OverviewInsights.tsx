import { ArrowRight } from 'lucide-react';
import { formatMoney, formatMonth } from '../lib/finance';
import { getBudgetComparison, getCategorySpending } from '../lib/insights';
import type { FinanceData } from '../lib/types';

interface BudgetComparisonCardProps {
  data: FinanceData;
  month: string;
  onPlan: () => void;
  onImport: () => void;
}

export function BudgetComparisonCard({ data, month, onPlan, onImport }: BudgetComparisonCardProps) {
  const comparison = getBudgetComparison(data, month);
  const hasSpending = comparison?.hasRecordedExpenses ?? false;
  const overPlan = !!comparison && comparison.remainingCents < 0;

  return <section className="panel budget-comparison-card">
    <div className="panel-header"><div>
      <h2>Spending vs plan</h2>
      <p>{formatMonth(month)} · recorded so far</p>
    </div></div>
    {!comparison ? <>
      <p className="budget-comparison-empty">No spending plan for this month.</p>
      <button type="button" className="text-button" onClick={onPlan}>Edit my plan <ArrowRight size={15} /></button>
    </> : <>
      <dl className="budget-comparison-values">
        <div><dt>Planned spending</dt><dd>{formatMoney(comparison.plannedExpenseCents)}</dd></div>
        {hasSpending && <div><dt>Recorded spending</dt><dd>{formatMoney(comparison.recordedExpenseCents)}</dd></div>}
      </dl>
      {hasSpending ? <>
        <div className={`budget-comparison-result${overPlan ? ' over-plan' : ''}`}>
          <strong>{formatMoney(Math.abs(comparison.remainingCents))}</strong>
          <span>{overPlan ? 'over plan' : 'remaining vs plan'}</span>
        </div>
        <p className="budget-comparison-note">Based on imported and manual records so far, net of refunds.</p>
        <button type="button" className="text-button" onClick={onPlan}>Review my plan <ArrowRight size={15} /></button>
      </> : <>
        <p className="budget-comparison-empty">No personal spending recorded yet.</p>
        <button type="button" className="text-button" onClick={onImport}>Import a statement <ArrowRight size={15} /></button>
      </>}
    </>}
  </section>;
}

interface CategoryBreakdownProps {
  categories: Record<string, number>;
  onReview: (category: string) => void;
}

const shareFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

export function CategoryBreakdown({ categories, onReview }: CategoryBreakdownProps) {
  const spending = getCategorySpending(categories);
  const hasCategories = spending.positive.length > 0 || spending.refunds.length > 0;

  const spendingRow = (entry: typeof spending.positive[number]) => <li key={entry.name}>
    <button type="button" className="spending-breakdown-category" onClick={() => onReview(entry.name)} aria-label={`Review ${entry.name} transactions`}>
      <span className="spending-breakdown-row"><span className="spending-breakdown-name">{entry.name}</span><strong>{formatMoney(entry.amountCents)}</strong></span>
      <span className="spending-breakdown-share">{entry.sharePercent < 0.1 ? '<0.1' : shareFormatter.format(entry.sharePercent)}% of spending</span>
      <span className="spending-breakdown-bar" aria-hidden="true"><span style={{ width: `${entry.sharePercent}%` }} /></span>
    </button>
  </li>;

  return <section className="panel spending-breakdown">
    <div className="panel-header"><div><h2>Where your money goes</h2><p>Personal spending by category · recorded so far</p></div></div>
    {hasCategories ? <>
      {spending.positive.length > 0 && <>
        <ul className="spending-breakdown-list">{spending.positive.slice(0, 6).map(spendingRow)}</ul>
        {spending.positive.length > 6 && <details className="spending-breakdown-more"><summary>{spending.positive.length - 6} more categories</summary><ul className="spending-breakdown-list">{spending.positive.slice(6).map(spendingRow)}</ul></details>}
      </>}
      {spending.refunds.length > 0 && <div className="spending-breakdown-refunds">
        <h3>Refunds and credits</h3>
        <ul className="spending-breakdown-list">{spending.refunds.map(entry => <li key={entry.name}>
          <button type="button" className="spending-breakdown-category" onClick={() => onReview(entry.name)} aria-label={`Review ${entry.name} transactions`}>
            <span className="spending-breakdown-row"><span className="spending-breakdown-name">{entry.name}</span><strong>{formatMoney(-entry.amountCents)}</strong></span>
          </button>
        </li>)}</ul>
      </div>}
      <dl className="spending-breakdown-totals">
        {spending.refunds.length > 0 && <>
          <div><dt>Spending</dt><dd>{formatMoney(spending.positiveCents)}</dd></div>
          <div><dt>Refunds and credits</dt><dd>{formatMoney(-spending.refundCents)}</dd></div>
        </>}
        <div className="spending-breakdown-net"><dt>Net spending</dt><dd>{formatMoney(spending.netCents)}</dd></div>
      </dl>
      <p className="spending-breakdown-note">Category totals are net of refunds. Shares exclude categories with net refunds.</p>
    </> : <div className="spending-breakdown-empty"><h3>{Object.keys(categories).length ? 'Recorded spending nets to zero' : 'No personal spending recorded'}</h3><p>{Object.keys(categories).length ? 'Purchases and refunds cancel out in this month’s records.' : 'Imported and manual expenses will appear here.'}</p></div>}
  </section>;
}
