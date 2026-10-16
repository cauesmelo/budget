import { useId, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatMoney, formatMonth } from '../lib/finance';
import { getReserveInsights, getReserveTargetInsights, type ReserveTargetInsights } from '../lib/insights';
import { formatNumber } from '../lib/numbers';
import { buildReserveChartData, buildReserveProgressData, reserveTargetDefinitions, type ReserveTargetKey } from '../lib/reserveChart';
import type { ProjectionMonth } from '../lib/types';
import './ReserveGrowthChart.css';

const targetStyles: Record<ReserveTargetKey, { color: string; dash: string }> = {
  pms: { color: '#667c28', dash: '7 4' },
  pmr: { color: '#a46922', dash: '3 4' },
  pi: { color: '#526ca8', dash: '10 4 2 4' },
  pnif: { color: '#94618a', dash: '12 5' },
};
const chartTick = { fontSize: 11, fill: 'var(--text-secondary)' };
const percent = (value: number) => `${formatNumber(value, 2)}%`;
const moneyAxis = (cents: number) => formatNumber(cents / 100, 0);

function LineSample({ color, dash }: { color: string; dash?: string }) {
  return <svg width="25" height="12" viewBox="0 0 25 12" aria-hidden="true"><line x1="0" x2="25" y1="6" y2="6" stroke={color} strokeWidth={dash ? 2 : 3} strokeDasharray={dash} /></svg>;
}

function goalInsights(rows: ProjectionMonth[], key: ReserveTargetKey): ReserveTargetInsights | null {
  try { return getReserveTargetInsights(rows, key); }
  catch { return null; }
}

function reachText(insights: ReserveTargetInsights | null, months: number): string {
  if (!insights) return 'Outside the supported monetary range.';
  const { goal } = insights;
  if (goal.status === 'unset') return 'Add spending or review indicator assumptions.';
  if (goal.status === 'already-reached') return 'Met at the start of the plan.';
  if (goal.status === 'projected') return `First reached: ${goal.timing === 'start' ? 'start' : 'end'} of ${formatMonth(goal.month!)}.`;
  return `Not reached in this ${formatNumber(months)}-month plan.`;
}

function ForecastTooltip({ row, view, showPms, showPmr }: { row?: ProjectionMonth; view: 'amount' | 'progress'; showPms: boolean; showPmr: boolean }) {
  if (!row) return null;
  const targets = reserveTargetDefinitions.filter(({ key }) => view === 'progress' || (key === 'pms' && showPms) || (key === 'pmr' && showPmr));
  return <div className="forecast-tooltip">
    <strong>Start of {formatMonth(row.month)}</strong>
    <dl>
      <div className="forecast-tooltip-balance"><dt>Reserve</dt><dd>{formatMoney(row.openingCents)}</dd></div>
      {targets.map(({ key, label }) => {
        const target = row.indicators[key].targetCents;
        return <div key={key}><dt><LineSample color={targetStyles[key].color} dash={targetStyles[key].dash} />{label}</dt><dd>{target !== null && target > 0 ? view === 'progress' ? percent(row.openingCents / target * 100) : formatMoney(target) : 'Not calculated'}</dd></div>;
      })}
    </dl>
    <dl className="forecast-tooltip-flow">
      <div><dt>Planned savings this month</dt><dd>{formatMoney(row.netCents)}</dd></div>
      {row.returnCents !== 0 && <div><dt>Projected investment return</dt><dd>{formatMoney(row.returnCents)}</dd></div>}
      <div><dt>Reserve at month end</dt><dd>{formatMoney(row.closingCents)}</dd></div>
    </dl>
  </div>;
}

export function ReserveGrowthChart({ rows }: { rows: ProjectionMonth[] }) {
  const gradientId = useId();
  const headingId = useId();
  const helpId = useId();
  const [view, setView] = useState<'amount' | 'progress'>('amount');
  const [showPms, setShowPms] = useState(true);
  const [showPmr, setShowPmr] = useState(false);
  const chartData = buildReserveChartData(rows);
  const progressData = buildReserveProgressData(rows);
  const first = rows[0];
  const last = rows.at(-1);
  const available = (key: ReserveTargetKey) => chartData.some(row => row[key] !== null);
  const unavailable = reserveTargetDefinitions.filter(target => !available(target.key));
  let reserveInsights;
  try { reserveInsights = getReserveInsights(rows, 0); }
  catch { /* Keep the plot available if a monetary difference cannot be represented. */ }
  const openingGrowth = first && last ? last.openingCents - first.openingCents : 0;
  const milestones = reserveTargetDefinitions.map(target => ({ ...target, insights: goalInsights(rows, target.key) }));

  return <section className="panel reserve-growth-panel" aria-labelledby={headingId}>
    <div className="panel-header forecast-heading"><div><h2 id={headingId}>Reserve growth</h2><p>See how your budget builds your reserve and when you reach each goal.</p></div>
      <div className="forecast-views" role="group" aria-label="Reserve chart view">
        <button type="button" aria-pressed={view === 'amount'} onClick={() => setView('amount')}>Reserve in R$</button>
        <button type="button" aria-pressed={view === 'progress'} onClick={() => setView('progress')}>Goal progress</button>
      </div>
    </div>
    {!first || !last ? <p className="forecast-empty">Add a planning period to see your reserve forecast.</p> : <>
      <dl className="forecast-summary">
        <div><dt>Starting reserve</dt><dd>{formatMoney(first.openingCents)}</dd><small>Start of {formatMonth(first.month)}</small></div>
        <div><dt>Projected reserve</dt><dd className={last.openingCents < 0 ? 'planning-negative' : ''}>{formatMoney(last.openingCents)}</dd><small>Start of {formatMonth(last.month)}</small></div>
        <div><dt>Projected change</dt><dd className={openingGrowth < 0 ? 'planning-negative' : ''}>{Number.isSafeInteger(openingGrowth) ? `${openingGrowth > 0 ? '+' : ''}${formatMoney(openingGrowth)}` : 'Outside supported range'}</dd><small>Between these opening balances</small></div>
      </dl>
      <div className="forecast-chart-key">
        {view === 'amount' ? <>
          <span><LineSample color="var(--green)" /><strong>Reserve</strong></span>
          {(['pms', 'pmr'] as const).map(key => <label key={key}>
            <input type="checkbox" aria-label={`Show ${key.toUpperCase()} target`} checked={available(key) && (key === 'pms' ? showPms : showPmr)} disabled={!available(key)} onChange={event => (key === 'pms' ? setShowPms : setShowPmr)(event.target.checked)} />
            <LineSample color={targetStyles[key].color} dash={targetStyles[key].dash} />{key.toUpperCase()} target
          </label>)}
        </> : reserveTargetDefinitions.map(({ key, label }) => <span key={key} className={!available(key) ? 'forecast-unavailable' : ''}><LineSample color={targetStyles[key].color} dash={targetStyles[key].dash} /><strong>{label}</strong>{!available(key) && ' · Not calculated'}</span>)}
      </div>
      <p className="forecast-chart-help" id={helpId}>{view === 'amount'
        ? 'Opening balances in R$. Compare all four goals in Goal progress.'
        : 'Opening reserve as a percentage of each month’s target. 100% means the goal is met.'}</p>
      <div className="chart tall forecast-plot" role="group" aria-label={view === 'amount' ? 'Projected opening reserve with optional PMS and PMR targets' : 'Projected progress toward PMS, PMR, PI, and PNIF'} aria-describedby={helpId}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart key={view} data={view === 'amount' ? chartData : progressData} margin={{ top: 20, right: 14, left: 0, bottom: 5 }} accessibilityLayer>
            <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--green)" stopOpacity={0.2} /><stop offset="100%" stopColor="var(--green)" stopOpacity={0.02} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 4" vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="month" tickFormatter={formatMonth} minTickGap={40} axisLine={false} tickLine={false} tick={chartTick} padding={{ left: 8, right: 8 }} />
            <YAxis tickFormatter={view === 'amount' ? moneyAxis : value => `${formatNumber(value, 1)}%`} width="auto" domain={['auto', 'auto']} axisLine={false} tickLine={false} tick={chartTick} />
            <Tooltip content={({ active, label }) => active ? <ForecastTooltip row={rows.find(row => row.month === String(label))} view={view} showPms={showPms} showPmr={showPmr} /> : null} />
            <ReferenceLine y={0} ifOverflow="extendDomain" stroke="var(--border)" />
            {view === 'progress' && <ReferenceLine y={100} ifOverflow="extendDomain" stroke="var(--text-secondary)" strokeDasharray="4 4" label={{ value: 'Goal met · 100%', position: 'insideTopRight', fill: 'var(--text-secondary)', fontSize: 11 }} />}
            {reserveTargetDefinitions.map(({ key, label }) => <Line
              key={key} dataKey={key} name={view === 'amount' ? `${label} target` : label}
              hide={!available(key) || (view === 'amount' && !(key === 'pms' && showPms) && !(key === 'pmr' && showPmr))}
              type={view === 'amount' ? 'stepAfter' : 'linear'}
              stroke={targetStyles[key].color} strokeDasharray={targetStyles[key].dash} strokeWidth={2}
              dot={({ cx, cy, index }) => {
                const isolated = chartData[index]?.[key] != null && chartData[index - 1]?.[key] == null && chartData[index + 1]?.[key] == null;
                return isolated ? <circle cx={cx} cy={cy} r={3} fill={targetStyles[key].color} stroke="var(--surface)" strokeWidth={1} /> : null;
              }}
              activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false}
            />)}
            {view === 'amount' && <Area type="linear" dataKey="openingCents" name="Reserve" stroke="var(--green)" strokeWidth={3} fill={`url(#${gradientId})`} dot={chartData.length === 1 ? { r: 3 } : false} activeDot={{ r: 4 }} isAnimationActive={false} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="forecast-milestone-heading"><h3>Goal outlook</h3><span>Progress at the start of {formatMonth(last.month)}</span></div>
      <div className="forecast-milestones">
        {milestones.map(({ key, label, name, insights }) => {
          const target = last.indicators[key].targetCents;
          const progress = target !== null && target > 0 ? last.openingCents / target * 100 : null;
          const remaining = target !== null && target > 0 ? Math.max(0, target - last.openingCents) : null;
          return <article className="forecast-milestone" aria-label={`${label} outlook`} key={key}>
            <div className="forecast-milestone-title"><strong>{label}</strong><span>{progress === null ? 'Not calculated' : percent(progress)}</span></div>
            <span className="forecast-goal-name">{name}</span>
            {progress !== null && <div className="forecast-progress" role="progressbar" aria-label={`${label} projected progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, progress))} aria-valuetext={`${percent(progress)} at the start of ${formatMonth(last.month)}`}><span style={{ width: `${Math.max(0, Math.min(100, progress))}%`, backgroundColor: targetStyles[key].color }} /></div>}
            <p className="forecast-goal-date">{reachText(insights, rows.length)}</p>
            {remaining !== null && Number.isSafeInteger(remaining) && <small>{remaining > 0 ? `${formatMoney(remaining)} still to go` : 'Target covered'} at the start of {formatMonth(last.month)}.</small>}
            {target !== null && target > 0 && <small>Target then: {formatMoney(target)}</small>}
            {insights?.goal.laterBelowMonth && <small className="forecast-goal-warning">Falls below again at the {insights.laterBelowTiming} of {formatMonth(insights.goal.laterBelowMonth)}.</small>}
          </article>;
        })}
      </div>
      <div className="forecast-notes">
        {reserveInsights?.firstShortfall && <p className="alert warning">Reserve shortfall: {formatMoney(reserveInsights.firstShortfall.amountCents)} at the {reserveInsights.firstShortfall.timing} of {formatMonth(reserveInsights.firstShortfall.month)}.</p>}
        {!reserveInsights && <p className="alert warning">Some forecast differences exceed the supported monetary range.</p>}
        {unavailable.length > 0 && <p>{unavailable.map(target => target.label).join(', ')}: not calculated. Review planned spending and Financial indicator assumptions.</p>}
        {milestones.some(target => target.insights?.hasUnavailableTargets) && <p>Some monthly targets could not be calculated; their chart lines have gaps.</p>}
        <p>Targets follow each month’s planned spending. Forecast assumes planned income arrives and the surplus stays saved. Hover, tap, or use the chart’s arrow keys for monthly details.</p>
      </div>
    </>}
  </section>;
}
