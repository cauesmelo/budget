import { useId, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatMoney, formatMonth } from '../lib/finance';
import { buildReserveChartData, reserveTargetDefinitions, type ReserveTargetKey } from '../lib/reserveChart';
import type { ProjectionMonth } from '../lib/types';
import { ReserveOutlook } from './ReserveOutlook';

const targetStyles: Record<ReserveTargetKey, { color: string; dash: string }> = {
  pms: { color: '#667c28', dash: '7 4' },
  pmr: { color: '#a46922', dash: '3 4' },
  pi: { color: '#526ca8', dash: '10 4 2 4' },
  pnif: { color: '#94618a', dash: '12 5' },
};
const chartTick = { fontSize: 11, fill: 'var(--muted)' };
const moneyAxis = (cents: number) => formatMoney(cents).replace(/R\$\s?/, '');

function LineSample({ color, dash }: { color: string; dash?: string }) {
  return <svg width="25" height="12" viewBox="0 0 25 12" aria-hidden="true"><line x1="0" x2="25" y1="6" y2="6" stroke={color} strokeWidth={dash ? 2 : 3} strokeDasharray={dash} /></svg>;
}

export function ReserveGrowthChart({ rows }: { rows: ProjectionMonth[] }) {
  const gradientId = useId();
  const headingId = useId();
  const helpId = useId();
  const [visible, setVisible] = useState<Record<ReserveTargetKey, boolean>>({ pms: true, pmr: true, pi: true, pnif: true });
  const chartData = buildReserveChartData(rows);
  const available = (key: ReserveTargetKey) => chartData.some(row => row[key] !== null);
  const unavailable = reserveTargetDefinitions.filter(target => !available(target.key));

  return <section className="panel reserve-growth-panel" aria-labelledby={headingId}>
    <div className="panel-header"><div><h2 id={headingId}>Reserve growth</h2><p>Your reserve at the start of each month, compared with financial targets.</p></div></div>
    <fieldset className="reserve-chart-legend" aria-describedby={helpId}>
      <legend>Financial targets shown on the chart</legend>
      <div className="reserve-chart-reserve"><LineSample color="var(--green)" /><span><strong>Opening reserve</strong><small>Projected savings</small></span></div>
      {reserveTargetDefinitions.map(({ key, label, name }) => {
        const calculated = available(key);
        return <label className={`reserve-chart-toggle${calculated ? '' : ' unavailable'}`} key={key}>
          <input type="checkbox" aria-label={`Show ${label}: ${name}`} checked={calculated && visible[key]} disabled={!calculated} onChange={event => { const checked = event.target.checked; setVisible(current => ({ ...current, [key]: checked })); }} />
          <LineSample color={targetStyles[key].color} dash={targetStyles[key].dash} />
          <span><strong>{label}</strong><small>{name}{!calculated && ' · Not calculated'}</small></span>
        </label>;
      })}
    </fieldset>
    <p className="reserve-chart-help" id={helpId}>Amounts in R$. Hide a target to focus the chart; the scale adjusts.</p>
    <div className="chart tall reserve-growth-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 15, right: 15, left: 0, bottom: 5 }} accessibilityLayer>
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--green)" stopOpacity={0.2} /><stop offset="100%" stopColor="var(--green)" stopOpacity={0.02} /></linearGradient></defs>
          <CartesianGrid strokeDasharray="3 4" vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="month" tickFormatter={formatMonth} minTickGap={35} axisLine={false} tickLine={false} tick={chartTick} padding={{ left: 8, right: 8 }} />
          <YAxis tickFormatter={moneyAxis} width="auto" axisLine={false} tickLine={false} tick={chartTick} />
          <Tooltip contentStyle={{ borderRadius: 10, borderColor: 'var(--border)', backgroundColor: '#fff', fontSize: 12 }} labelStyle={{ color: 'var(--ink)', fontWeight: 600 }} itemStyle={{ color: 'var(--ink)' }} formatter={value => formatMoney(Number(value))} labelFormatter={value => formatMonth(String(value))} />
          {reserveTargetDefinitions.map(({ key, label }) => <Line
            key={key} dataKey={key} name={`${label} target`}
            hide={!visible[key] || !available(key)} type="stepAfter"
            stroke={targetStyles[key].color} strokeDasharray={targetStyles[key].dash} strokeWidth={2}
            dot={({ cx, cy, index }) => {
              const isolated = chartData[index]?.[key] != null && chartData[index - 1]?.[key] == null && chartData[index + 1]?.[key] == null;
              return isolated ? <circle className="reserve-target-point" cx={cx} cy={cy} r={3} fill={targetStyles[key].color} stroke="var(--surface)" strokeWidth={1} /> : null;
            }}
            activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false}
          />)}
          <Area type="linear" dataKey="openingCents" name="Opening reserve" stroke="var(--green)" strokeWidth={3} fill={`url(#${gradientId})`} dot={chartData.length === 1 ? { r: 3 } : false} activeDot={{ r: 4 }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
    {unavailable.length > 0 && <p className="reserve-chart-unavailable">{unavailable.map(target => target.label).join(', ')}: not calculated. Review planned spending and the assumptions in Financial indicators.</p>}
    <ReserveOutlook rows={rows} />
  </section>;
}
