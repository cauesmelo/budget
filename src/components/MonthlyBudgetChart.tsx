import type { CSSProperties } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { formatMoney } from '../lib/finance';
import type { MonthlyBudgetRow } from '../lib/monthlyBudget';
import './MonthlyBudgetChart.css';

function rowStatus(row: MonthlyBudgetRow): string {
  if (row.kind === 'unassigned-plan') return 'Assign a category to compare';
  if (row.spentCents < 0) return 'Net refund';
  if (row.plannedCents === 0 && row.spentCents > 0) return 'Not budgeted';
  if (row.remainingCents < 0) return `${formatMoney(-row.remainingCents)} over`;
  if (row.remainingCents === 0) return 'Budget used';
  return `${formatMoney(row.remainingCents)} left`;
}

export function MonthlyBudgetChart({ rows, onReview }: {
  rows: MonthlyBudgetRow[];
  onReview: (row: MonthlyBudgetRow) => void;
}) {
  const visibleRows = rows.filter(row => row.plannedCents !== 0 || row.spentCents !== 0);
  if (visibleRows.length === 0) {
    return <div className="monthly-budget-chart-empty">Add a category budget or import spending to see the comparison.</div>;
  }
  const minimum = Math.min(0, ...visibleRows.map(row => row.spentCents));
  const maximum = Math.max(0, ...visibleRows.flatMap(row => [row.plannedCents, row.spentCents]));
  const range = maximum - minimum || 1;
  const zeroPosition = -minimum / range * 100;
  const chartStyle = { '--budget-zero-position': `${zeroPosition}%` } as CSSProperties;
  const barStyle = (value: number): CSSProperties => ({
    left: `${(Math.min(0, value) - minimum) / range * 100}%`,
    width: `${Math.abs(value) / range * 100}%`,
  });

  return <div className="monthly-budget-chart" style={chartStyle}>
    <div className="monthly-budget-chart-key" aria-label="Chart legend">
      <span><i className="monthly-budget-swatch planned" aria-hidden="true" />Planned</span>
      <span><i className="monthly-budget-swatch spent" aria-hidden="true" />Spent</span>
      <span><i className="monthly-budget-swatch over" aria-hidden="true" />Over budget</span>
    </div>
    <p className="monthly-budget-chart-help">Every category uses the same R$ scale. Select a category to review its transactions.{minimum < 0 && ' Net refunds extend left of zero.'}</p>
    <div className="monthly-budget-chart-scale" aria-label={`Shared scale from ${formatMoney(minimum)} to ${formatMoney(maximum)}`}>
      <span>{formatMoney(minimum)}</span><span>{formatMoney(maximum)}</span>
    </div>
    <ul className="monthly-budget-chart-rows" aria-label="Planned and spent by category">
      {visibleRows.map(row => {
        const overBudget = row.kind !== 'unassigned-plan' && row.remainingCents < 0;
        const canReview = row.kind !== 'unassigned-plan' && row.transactionCount > 0;
        const statusClass = row.kind === 'unassigned-plan' ? 'unassigned' : row.spentCents < 0 ? 'refund' : overBudget ? 'over' : 'available';
        return <li key={row.key} className="monthly-budget-chart-row">
          <div className="monthly-budget-chart-row-heading">
            {canReview ? <button className="monthly-budget-chart-category" type="button" onClick={() => onReview(row)} aria-label={`Review transactions for ${row.label}`}>
              <span>{row.label}{row.archived && <small>Archived</small>}</span><ArrowUpRight size={14} aria-hidden="true" />
            </button> : <strong className="monthly-budget-chart-category-name">{row.label}{row.archived && <small>Archived</small>}</strong>}
            <span className={`monthly-budget-chart-status ${statusClass}`}>{rowStatus(row)}</span>
          </div>
          <div className="monthly-budget-chart-lanes">
            <div className="monthly-budget-chart-lane">
              <span className="monthly-budget-chart-lane-label">Planned</span>
              <div className="monthly-budget-chart-track" aria-hidden="true"><span className="monthly-budget-chart-bar planned" style={barStyle(row.plannedCents)} /></div>
              <span className="monthly-budget-chart-value">{formatMoney(row.plannedCents)}</span>
            </div>
            <div className="monthly-budget-chart-lane">
              <span className="monthly-budget-chart-lane-label">{row.spentCents < 0 ? 'Refund' : 'Spent'}</span>
              <div className="monthly-budget-chart-track" aria-hidden="true"><span className={`monthly-budget-chart-bar ${row.spentCents < 0 ? 'refund' : overBudget ? 'over' : 'spent'}`} style={barStyle(row.spentCents)} /></div>
              <span className={`monthly-budget-chart-value ${statusClass}`}>{formatMoney(row.spentCents)}</span>
            </div>
          </div>
        </li>;
      })}
    </ul>
  </div>;
}
