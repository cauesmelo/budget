import { formatMoney, formatMonth } from '../lib/finance';
import { getReserveCoverage, getReserveInsights, type ReserveInsights } from '../lib/insights';
import type { ProjectionMonth } from '../lib/types';
import { MoneyInput } from './MoneyInput';
import { formatNumber } from '../lib/numbers';

interface ReserveOutlookProps {
  rows: ProjectionMonth[];
  goalCents: number;
  onGoalChange: (amount: number) => boolean;
}

export function ReserveOutlook({ rows, goalCents, onGoalChange }: ReserveOutlookProps) {
  const goalInput = <label className="field reserve-outlook-goal"><span>Reserve goal (R$) · optional</span><MoneyInput label="Reserve goal" value={goalCents} onChange={amount => onGoalChange(Math.max(0, amount))} /><small>Use zero to clear the goal.</small></label>;
  let insights: ReserveInsights;
  try { insights = getReserveInsights(rows, goalCents); }
  catch { return <div className="reserve-outlook">{goalInput}<p className="alert warning">The reserve outlook exceeds the supported monetary range. Review your goal and starting reserve.</p></div>; }
  const { goal, firstShortfall } = insights;
  const coverage = rows.length ? getReserveCoverage(insights.openingCents, rows[0].expenseCents) : null;
  const progress = Math.max(0, Math.min(100, goal.progressPercent ?? 0));
  const progressText = goal.progressPercent === null ? '' : `${formatNumber(goal.progressPercent, 1)}%`;
  const goalStatus = goal.status === 'unset'
    ? 'Add a goal to see when your plan reaches it.'
    : goal.status === 'already-reached'
      ? 'Your starting reserve already meets this goal.'
      : goal.status === 'projected'
        ? `Projected to reach your goal at the ${goal.timing} of ${formatMonth(goal.month!)}.`
        : `This goal is not reached within the ${formatNumber(rows.length)}-month plan.`;

  return <div className="reserve-outlook">
    <div className="reserve-outlook-main">
      {goalInput}
      <div className="reserve-outlook-status">
        <p className="reserve-outlook-goal-status" role="status">{goalStatus}</p>
        {goal.progressPercent !== null && <>
          <div className="planning-progress reserve-outlook-progress" role="progressbar" aria-label="Reserve goal progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${progressText} of goal from starting reserve`}><span style={{ width: `${progress}%` }} /></div>
          <small>{progressText} of goal, based on your starting reserve.</small>
        </>}
        {coverage !== null && <p className="reserve-outlook-coverage">Starting reserve covers {formatNumber(coverage, 1)} months of planned spending.</p>}
      </div>
    </div>
    {(firstShortfall || goal.laterBelowMonth) && <div className="reserve-outlook-warnings">
      {firstShortfall && <p className="alert warning">Projected reserve shortfall: <strong>{formatMoney(firstShortfall.amountCents)}</strong> at the {firstShortfall.timing} of {formatMonth(firstShortfall.month)}.</p>}
      {goal.laterBelowMonth && <p className="alert warning">Your plan drops below this goal again by the end of {formatMonth(goal.laterBelowMonth)}.</p>}
    </div>}
    <p className="reserve-outlook-assumption">Forecast assumes planned income arrives and the monthly surplus stays saved.</p>
  </div>;
}
