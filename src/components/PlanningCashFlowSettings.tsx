import { Plus, Trash2, X } from 'lucide-react';
import { formatMonth, planAmountForMonth } from '../lib/finance';
import type { PlanItem } from '../lib/types';
import { MoneyInput } from './MoneyInput';

interface PlanningCashFlowSettingsProps {
  items: PlanItem[];
  month: string;
  onAdd: (kind: 'income' | 'contribution') => void;
  onPatch: (id: string, patch: Partial<PlanItem>) => boolean;
}

function CashFlowItem({ item, month, onPatch }: {
  item: PlanItem;
  month: string;
  onPatch: PlanningCashFlowSettingsProps['onPatch'];
}) {
  const fixed = !item.behavior || item.behavior === 'fixed';
  const active = month >= item.startMonth && (!item.endMonth || month <= item.endMonth);
  const overridden = Object.hasOwn(item.amounts, month);
  const name = item.name.trim() || 'Unnamed item';

  function removeOverride() {
    const amounts = { ...item.amounts };
    delete amounts[month];
    onPatch(item.id, { amounts });
  }

  return <article className="planning-cashflow-item" aria-label={name}>
    <div className="planning-cashflow-item-heading"><strong>{name}</strong><span>{fixed ? 'Fixed' : 'By month'}</span></div>
    <div className="planning-cashflow-amounts">
      <label className="field"><span>Default amount (R$)</span>{fixed
        ? <MoneyInput value={item.defaultAmountCents} label={`Default amount for ${name}`} onChange={value => onPatch(item.id, { defaultAmountCents: value })} />
        : <span className="planning-cashflow-no-default">Set each month</span>}</label>
      <div className="field"><span>{formatMonth(month)} (R$)</span>{active
        ? <div className={`planning-cashflow-month-amount${overridden ? ' overridden' : ''}`}>
          <MoneyInput value={planAmountForMonth(item, month)} label={`${name} in ${month}`} onChange={value => onPatch(item.id, { amounts: { ...item.amounts, [month]: value } })} />
          {overridden && <button type="button" className="icon-button" aria-label={`Remove override for ${name} in ${month}`} title="Use the calculated amount" onClick={removeOverride}><X size={14} aria-hidden="true" /></button>}
        </div>
        : <span className="planning-cashflow-inactive">Outside this item’s dates</span>}</div>
    </div>
    <details className="planning-cashflow-details">
      <summary>Settings for {name}</summary>
      <div className="planning-cashflow-fields">
        <label className="field"><span>Name</span><input aria-label={`Name for ${name}`} value={item.name} onChange={event => onPatch(item.id, { name: event.target.value })} /></label>
        <label className="field"><span>Amount behavior</span><select aria-label={`Behavior for ${name}`} value={fixed ? 'fixed' : 'monthly'} onChange={event => onPatch(item.id, { behavior: event.target.value as 'fixed' | 'monthly' })}><option value="fixed">Fixed</option><option value="monthly">By month</option></select></label>
        <label className="field"><span>Starts</span><input aria-label={`Start month for ${name}`} type="month" value={item.startMonth} onChange={event => { if (event.target.value) onPatch(item.id, { startMonth: event.target.value }); }} /></label>
        <label className="field"><span>Ends (optional)</span><input aria-label={`End month for ${name}`} type="month" min={item.startMonth} value={item.endMonth ?? ''} onChange={event => onPatch(item.id, { endMonth: event.target.value || undefined })} /></label>
      </div>
      <button type="button" className="text-button planning-cashflow-delete" aria-label={`Delete ${name}`} onClick={() => onPatch(item.id, { deletedAt: new Date().toISOString() })}><Trash2 size={14} aria-hidden="true" />Remove item</button>
    </details>
  </article>;
}

export function PlanningCashFlowSettings({ items, month, onAdd, onPatch }: PlanningCashFlowSettingsProps) {
  const groups = [
    { kind: 'income' as const, title: 'Planned income', action: 'Add income', empty: 'Add your expected income to calculate your monthly surplus.' },
    { kind: 'contribution' as const, title: 'Reserve targets', action: 'Add reserve target', empty: 'Set a savings allocation to see what remains available each month.' },
  ];

  return <section className="panel planning-cashflow" aria-labelledby="planning-cashflow-title">
    <div className="panel-header"><div><h2 id="planning-cashflow-title">Income and reserve targets</h2><p>Keep income and savings allocations separate from your planned expenses.</p></div></div>
    <div className="planning-cashflow-groups">{groups.map(group => {
      const groupItems = items.filter(item => item.kind === group.kind && !item.deletedAt);
      return <section className="planning-cashflow-group" key={group.kind} aria-labelledby={`planning-cashflow-${group.kind}`}>
        <div className="planning-cashflow-group-heading"><h3 id={`planning-cashflow-${group.kind}`}>{group.title}</h3><button type="button" className="text-button" onClick={() => onAdd(group.kind)}><Plus size={15} aria-hidden="true" />{group.action}</button></div>
        {groupItems.length ? <div className="planning-cashflow-items">{groupItems.map(item => <CashFlowItem key={item.id} item={item} month={month} onPatch={onPatch} />)}</div> : <p className="planning-cashflow-empty">{group.empty}</p>}
      </section>;
    })}</div>
    <p className="planning-cashflow-note">Edit a month to override its calculated amount. Reserve targets are internal savings allocations and are excluded from spending.</p>
  </section>;
}
