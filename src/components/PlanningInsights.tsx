import { useEffect, useId, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, CircleHelp, PiggyBank, TrendingUp, Wallet } from 'lucide-react';
import { formatMoney, formatMonth } from '../lib/finance';
import type { FinanceData, PlanningConfiguration, PlanningIndicator, ProjectionMonth } from '../lib/types';

type IndicatorKey = keyof ProjectionMonth['indicators'];

const indicatorDefinitions: { key: IndicatorKey; acronym: string; name: string; formula: string }[] = [
  { key: 'pms', acronym: 'PMS', name: 'Minimum survival reserve', formula: '6 months of planned spending' },
  { key: 'pmr', acronym: 'PMR', name: 'Recommended minimum reserve', formula: '12 or 20 months of planned spending' },
  { key: 'pi', acronym: 'PI', name: 'Ideal assets', formula: '10% × annual planned spending × age' },
  { key: 'pnif', acronym: 'PNIF', name: 'Financial independence assets', formula: 'Annual planned spending ÷ net annual return' },
];

const formatPercent = (value: number) => `${value.toLocaleString('en-GB', { maximumFractionDigits: 2 })}%`;

function unavailableReason(key: IndicatorKey, row: ProjectionMonth, planning?: PlanningConfiguration) {
  if (row.expenseCents <= 0) return 'Add planned spending to calculate this target.';
  if (key === 'pi' && planning?.age === undefined) return 'Set your age to calculate this target.';
  if (key === 'pnif' && !(planning?.annualNetReturnPercent && planning.annualNetReturnPercent > 0)) return 'Optional: enter an annual investment return after inflation, taxes, and fees to calculate PNIF.';
  return 'This target exceeds the supported currency range. Review your assumptions.';
}

function IndicatorProgress({ indicator, label }: { indicator: PlanningIndicator; label: string }) {
  if (indicator.progressPercent === null) return null;
  const progress = Math.max(0, Math.min(100, indicator.progressPercent));
  return <div className="planning-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${formatPercent(indicator.progressPercent)} of target`}><span style={{ width: `${progress}%` }} /></div>;
}

export function PlanningAssumptions({ data, onChange }: { data: FinanceData; onChange: (planning: PlanningConfiguration) => boolean }) {
  const annualReturnHelpId = useId();
  const savedAge = data.planning?.age;
  const savedPmr = data.planning?.pmrMonths ?? 12;
  const savedAnnualReturn = data.planning?.annualNetReturnPercent;
  const [age, setAge] = useState(savedAge === undefined ? '' : String(savedAge));
  const [pmrMonths, setPmrMonths] = useState<12 | 20>(savedPmr);
  const [annualReturn, setAnnualReturn] = useState(savedAnnualReturn === undefined ? '' : String(savedAnnualReturn));
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    setAge(savedAge === undefined ? '' : String(savedAge));
    setPmrMonths(savedPmr);
    setAnnualReturn(savedAnnualReturn === undefined ? '' : String(savedAnnualReturn));
  }, [savedAge, savedPmr, savedAnnualReturn]);

  function changed() { setStatus(''); setError(''); }

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setStatus('');
    const parsedAge = age.trim() ? Number(age) : undefined;
    const parsedReturn = annualReturn.trim() ? Number(annualReturn) : undefined;
    if (parsedAge !== undefined && (!Number.isInteger(parsedAge) || parsedAge < 1 || parsedAge > 120)) { setError('Age must be a whole number between 1 and 120, or left blank.'); return; }
    if (parsedReturn !== undefined && (!Number.isFinite(parsedReturn) || parsedReturn < 0 || parsedReturn > 100)) { setError('Annual investment return must be between 0% and 100%, or left blank.'); return; }
    try {
      if (!onChange({ age: parsedAge, pmrMonths, annualNetReturnPercent: parsedReturn, updatedAt: new Date().toISOString() })) { setError('Could not save the planning assumptions. Check your data and try again.'); return; }
      setStatus('Planning assumptions saved.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save the planning assumptions.'); }
  }

  return <section className="panel planning-assumptions" aria-labelledby="planning-assumptions-title">
    <div className="panel-header"><div><h2 id="planning-assumptions-title">Financial indicator assumptions</h2><p>Use each month’s planned spending as your estimated cost of living.</p></div><CircleHelp size={20} aria-hidden="true" /></div>
    <form className="planning-assumptions-form" onSubmit={save}>
      <label className="field"><span>Age in first planning month</span><input type="number" inputMode="numeric" min="1" max="120" step="1" placeholder="Optional" value={age} onChange={event => { changed(); setAge(event.target.value); }} /><small>Age in {formatMonth(data.settings.reserveStartMonth)}; increases yearly.</small></label>
      <label className="field"><span>PMR coverage</span><select value={pmrMonths} onChange={event => { changed(); setPmrMonths(Number(event.target.value) as 12 | 20); }}><option value="12">12 months of spending</option><option value="20">20 months of spending</option></select><small>Choose the reserve coverage for your situation.</small></label>
      <div>
        <label className="field"><span>Annual investment return for PNIF (%)</span><input aria-label="Annual investment return for PNIF (%)" aria-describedby={annualReturnHelpId} type="number" inputMode="decimal" min="0" max="100" step="any" placeholder="Leave blank if unsure" value={annualReturn} onChange={event => { changed(); setAnnualReturn(event.target.value); }} /><small id={annualReturnHelpId}>Expected yearly return after inflation, taxes, and fees. Leave blank if unsure; your budget and reserve forecast still work.</small></label>
        <details className="planning-formulas"><summary>See an example</summary><p>Example only: at 4% a year after inflation, taxes, and fees, R$100,000 would earn R$4,000 a year in today’s buying power. Enter 4 for 4%, not 0.04.</p><p>A higher assumed return lowers the PNIF target. Use a long-term estimate for your own investments.</p></details>
      </div>
      <button type="submit" className="button">Save assumptions</button>
    </form>
    {error && <div className="alert error" role="alert">{error}</div>}
    {status && <div className="alert success" role="status"><Check size={16} aria-hidden="true" />{status}</div>}
    <p className="planning-assumptions-help">Age and annual investment return are optional. PI needs your age; PNIF needs a positive annual return. The annual return here only sets the financial independence target; reserve growth uses the separate monthly forecast return in Plan settings.</p>
    <p className="planning-source">Indicator framework: <a href="https://www.gustavocerbasi.com.br/livros/4/como-organizar-sua-vida-financeira" target="_blank" rel="noopener noreferrer">Gustavo Cerbasi · How to Organize Your Financial Life</a>.</p>
  </section>;
}

export function PlanningMetrics({ rows, month, planning, onMonthChange }: { rows: ProjectionMonth[]; month: string; planning?: PlanningConfiguration; onMonthChange: (month: string) => void }) {
  const row = rows.find(entry => entry.month === month) ?? rows[0];
  if (!row) return null;
  const metrics = [
    { label: 'Planned income', amount: row.incomeCents, detail: 'Expected personal income for this month', icon: ArrowDownLeft },
    { label: 'Planned spending', amount: row.expenseCents, detail: 'Fixed, variable, and installment expenses', icon: ArrowUpRight },
    { label: 'Monthly surplus', amount: row.netCents, detail: 'Income minus spending, before reserve returns', icon: TrendingUp },
    { label: 'Available after reserve target', amount: row.availableCents, detail: `Reserve allocation target: ${formatMoney(row.contributionCents)}`, icon: PiggyBank },
    { label: 'Opening reserve', amount: row.openingCents, detail: 'Money saved at the beginning of this month', icon: Wallet },
    { label: 'Closing reserve', amount: row.closingCents, detail: `Opening + surplus + ${formatMoney(row.returnCents)} in projected returns`, icon: Wallet },
  ];
  return <section className="planning-metrics" aria-labelledby="planning-metrics-title">
    <div className="planning-metrics-header"><div><h2 id="planning-metrics-title">Your month at a glance</h2><p>The forecast and indicators update as you edit your plan.</p></div><label className="field planning-month-select"><span>Planning month</span><select aria-label="Planning month" value={row.month} onChange={event => onMonthChange(event.target.value)}>{rows.map(entry => <option key={entry.month} value={entry.month}>{formatMonth(entry.month)}</option>)}</select></label></div>
    <div className="planning-money-grid">{metrics.map(({ label, amount, detail, icon: Icon }) => <div className={`metric planning-money-card${label === 'Opening reserve' ? ' tint' : ''}`} key={label}><div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon size={18} aria-hidden="true" /></span></div><strong className={amount < 0 ? 'planning-negative' : undefined}>{formatMoney(amount)}</strong><small>{detail}</small></div>)}</div>
    <div className="planning-indicator-grid">{indicatorDefinitions.map(definition => {
      const indicator = row.indicators[definition.key];
      return <article className="panel planning-indicator-card" key={definition.key} aria-label={`${definition.acronym}: ${definition.name}`}>
        <div className="planning-indicator-heading"><strong>{definition.acronym}</strong><span>{definition.name}</span></div>
        <div className="planning-indicator-value">{indicator.progressPercent === null ? <span className="planning-unavailable">Not calculated</span> : <strong>{formatPercent(indicator.progressPercent)}</strong>}</div>
        <IndicatorProgress indicator={indicator} label={`${definition.acronym} progress`} />
        <p className="planning-indicator-target">{indicator.targetCents === null ? unavailableReason(definition.key, row, planning) : <>Target <strong>{formatMoney(indicator.targetCents)}</strong></>}</p>
        <small>{definition.formula}</small>
      </article>;
    })}</div>
    <p className="planning-indicators-note">Indicators compare your opening reserve with each target. Reserve allocations are savings goals; they are excluded from spending and do not add extra money to your reserve.</p>
  </section>;
}

export function PlanningIndicatorsTable({ rows, planning }: { rows: ProjectionMonth[]; planning?: PlanningConfiguration }) {
  return <section className="panel planning-indicators-panel" aria-labelledby="planning-indicators-title">
    <div className="panel-header"><div><h2 id="planning-indicators-title">Financial indicators by month</h2><p>Opening reserve as a percentage of each month’s target.</p></div></div>
    <div className="table-scroll"><table className="planning-indicators-table"><thead><tr><th scope="col">Indicator</th>{rows.map(row => <th scope="col" key={row.month}>{formatMonth(row.month)}</th>)}</tr></thead><tbody>{indicatorDefinitions.map(definition => <tr key={definition.key}><th scope="row"><strong>{definition.acronym}</strong><small>{definition.name}</small></th>{rows.map(row => {
      const indicator = row.indicators[definition.key];
      return <td className="planning-indicator-cell" key={row.month}>{indicator.progressPercent === null ? <span className="planning-unavailable" title={unavailableReason(definition.key, row, planning)}>Not calculated</span> : <><strong>{formatPercent(indicator.progressPercent)}</strong><small>Target {formatMoney(indicator.targetCents!)}</small></>}</td>;
    })}</tr>)}</tbody></table></div>
    <details className="planning-formulas"><summary>How these indicators are calculated</summary><dl>{indicatorDefinitions.map(definition => <div key={definition.key}><dt>{definition.acronym}</dt><dd>{definition.formula}.</dd></div>)}</dl><p>Each percentage is opening reserve ÷ target × 100. Targets overlap and are not added together. Targets use the selected month’s planned spending; PI uses age advanced yearly from the first planning month. PNIF requires a positive net annual return.</p></details>
  </section>;
}
