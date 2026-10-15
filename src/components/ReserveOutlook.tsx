import { formatMoney, formatMonth } from '../lib/finance';
import { getPmsReserveInsights, getReserveCoverage, type PmsReserveInsights } from '../lib/insights';
import type { ProjectionMonth } from '../lib/types';
import { formatNumber } from '../lib/numbers';

export function ReserveOutlook({ rows }: { rows: ProjectionMonth[] }) {
  let insights: PmsReserveInsights;
  try { insights = getPmsReserveInsights(rows); }
  catch { return <div className="reserve-outlook"><p className="alert warning">The reserve outlook exceeds the supported monetary range. Review your planned spending and starting reserve.</p></div>; }
  const { goal, firstShortfall, targetStatus, hasUnavailableTargets } = insights;
  const firstMonth = rows[0]?.month;
  const coverage = rows.length ? getReserveCoverage(insights.openingCents, rows[0].expenseCents) : null;
  const progress = Math.max(0, Math.min(100, goal.progressPercent ?? 0));
  const progressText = goal.progressPercent === null ? '' : `${formatNumber(goal.progressPercent, 2)}%`;
  const goalStatus = goal.status === 'unset'
    ? hasUnavailableTargets ? 'PMS cannot be calculated for this plan.' : 'Add planned spending to calculate PMS and its reach date.'
    : goal.status === 'already-reached'
      ? 'Your starting reserve already meets PMS.'
      : goal.status === 'projected'
        ? `Projected to reach PMS at the ${goal.timing} of ${formatMonth(goal.month!)}.`
        : hasUnavailableTargets
          ? 'PMS is not reached in the months with a calculated target.'
          : `PMS is not reached within the ${formatNumber(rows.length)}-month plan.`;

  return <div className="reserve-outlook">
    <div className="reserve-outlook-main">
      <div className="reserve-outlook-target">
        <span>PMS · minimum survival reserve</span>
        <strong>{targetStatus === 'available' ? formatMoney(goal.amountCents) : 'Not calculated'}</strong>
        <small>{targetStatus === 'available' && firstMonth
          ? `6 months of planned spending in ${formatMonth(firstMonth)}.`
          : targetStatus === 'unavailable' && firstMonth
            ? 'PMS exceeds the supported monetary range.'
            : firstMonth ? `No planned spending in ${formatMonth(firstMonth)}.` : 'Add planned spending to calculate PMS.'}</small>
      </div>
      <div className="reserve-outlook-status">
        <p className="reserve-outlook-goal-status" role="status">{goalStatus}</p>
        {goal.progressPercent !== null && <>
          <div className="planning-progress reserve-outlook-progress" role="progressbar" aria-label="PMS progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progressText} of PMS from starting reserve`}><span style={{ width: `${progress}%` }} /></div>
          <small>{progressText} of PMS, based on your starting reserve.</small>
        </>}
        {coverage !== null && <p className="reserve-outlook-coverage">Starting reserve covers {formatNumber(coverage, 1)} months of planned spending.</p>}
      </div>
    </div>
    {(firstShortfall || goal.laterBelowMonth || hasUnavailableTargets) && <div className="reserve-outlook-warnings">
      {firstShortfall && <p className="alert warning">Projected reserve shortfall: <strong>{formatMoney(firstShortfall.amountCents)}</strong> at the {firstShortfall.timing} of {formatMonth(firstShortfall.month)}.</p>}
      {goal.laterBelowMonth && <p className="alert warning">Your plan drops below PMS again at the {insights.laterBelowTiming} of {formatMonth(goal.laterBelowMonth)}.</p>}
      {hasUnavailableTargets && <p className="alert warning">Some monthly PMS targets exceed the supported monetary range.</p>}
    </div>}
    <p className="reserve-outlook-assumption">PMS updates with each month’s planned spending. Forecast assumes planned income arrives and the monthly surplus stays saved.</p>
  </div>;
}
