import { formatMoney } from '../lib/finance';
import { getCategorySpending } from '../lib/insights';
import { formatNumber } from '../lib/numbers';

interface CategoryBreakdownProps {
  categories: Record<string, number>;
  onReview: (category: string) => void;
}

export function CategoryBreakdown({ categories, onReview }: CategoryBreakdownProps) {
  const spending = getCategorySpending(categories);
  const hasCategories = spending.positive.length > 0 || spending.refunds.length > 0;

  const spendingRow = (entry: typeof spending.positive[number]) => <li key={entry.name}>
    <button type="button" className="spending-breakdown-category" onClick={() => onReview(entry.name)} aria-label={`Review ${entry.name} transactions`}>
      <span className="spending-breakdown-row"><span className="spending-breakdown-name">{entry.name}</span><strong>{formatMoney(entry.amountCents)}</strong></span>
      <span className="spending-breakdown-share">{entry.sharePercent < 0.1 ? '<0,1' : formatNumber(entry.sharePercent, 1)}% of spending</span>
      <span className="spending-breakdown-bar" aria-hidden="true"><span style={{ width: `${entry.sharePercent}%` }} /></span>
    </button>
  </li>;

  return <section className="panel spending-breakdown">
    <div className="panel-header"><div><h2>Where your money goes</h2><p>Personal spending by category · recorded so far</p></div></div>
    {hasCategories ? <>
      {spending.positive.length > 0 && <>
        <ul className="spending-breakdown-list">{spending.positive.slice(0, 6).map(spendingRow)}</ul>
        {spending.positive.length > 6 && <details className="spending-breakdown-more"><summary>{formatNumber(spending.positive.length - 6)} more categories</summary><ul className="spending-breakdown-list">{spending.positive.slice(6).map(spendingRow)}</ul></details>}
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
