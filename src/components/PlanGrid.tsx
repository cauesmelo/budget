import type { ReactNode } from 'react';
import { Trash2, X } from 'lucide-react';
import { formatMoney, formatMonth, planAmountForMonth } from '../lib/finance';
import type { PlanItem, ProjectionMonth } from '../lib/types';
import { MoneyInput } from './MoneyInput';

interface PlanGridCallbacks {
  onPatch: (id: string, patch: Partial<PlanItem>) => boolean;
  onMonthly: (id: string, amount: number) => boolean;
  onMonth: (id: string, month: string, amount: number) => boolean;
}

interface PlanGridProps extends PlanGridCallbacks {
  items: PlanItem[];
  months: ProjectionMonth[];
  children?: ReactNode;
}

interface PlanGridRowProps extends PlanGridCallbacks {
  item: PlanItem;
  months: ProjectionMonth[];
  editableName?: boolean;
  editableMonthly?: boolean;
  removable?: boolean;
}

export function PlanGridRow({
  item, months, onPatch, onMonthly, onMonth,
  editableName = true, editableMonthly = true, removable = true,
}: PlanGridRowProps) {
  const monthlyAmount = item.behavior === 'monthly' || item.behavior === 'installments' ? 0 : item.defaultAmountCents;
  return <tr data-plan-id={item.id}>
    <td>{editableName
      ? <input aria-label="Item name" value={item.name} onChange={event => onPatch(item.id, { name: event.target.value })} />
      : <span className="simple-plan-label">{item.name}</span>}</td>
    <td>{editableMonthly
      ? <MoneyInput label={`Monthly amount for ${item.name}`} value={monthlyAmount} onChange={amount => onMonthly(item.id, Math.max(0, amount))} />
      : formatMoney(monthlyAmount)}</td>
    {months.map(({ month }) => {
      const edited = Object.hasOwn(item.amounts, month);
      return <td key={month} className={edited ? 'overridden' : undefined}>
        <div className="override-cell">
          <MoneyInput label={`${item.name} in ${month}`} value={planAmountForMonth(item, month)} onChange={amount => onMonth(item.id, month, Math.max(0, amount))} />
          {edited && <button className="reset-month" title="Remove month edit" aria-label={`Remove month edit for ${item.name} ${month}`} onClick={() => {
            const amounts = { ...item.amounts };
            delete amounts[month];
            onPatch(item.id, { amounts });
          }}><X size={12} /></button>}
        </div>
      </td>;
    })}
    <td>{removable && <button className="icon-button danger" title="Delete item" aria-label={`Delete item ${item.name}`} onClick={() => onPatch(item.id, { deletedAt: new Date().toISOString() })}><Trash2 size={16} /></button>}</td>
  </tr>;
}

export function PlanGrid({ items, months, onPatch, onMonthly, onMonth, children }: PlanGridProps) {
  return <><p className="table-swipe-hint">Swipe horizontally to see the months.</p><div className="table-scroll">
    <table className="plan-table simple-plan-table">
      <thead><tr><th>Item</th><th>Monthly (R$)</th>{months.map(({ month }) => <th key={month}>{formatMonth(month)}</th>)}<th /></tr></thead>
      <tbody>
        {items.map(item => <PlanGridRow key={item.id} item={item} months={months} onPatch={onPatch} onMonthly={onMonthly} onMonth={onMonth} />)}
        {children}
      </tbody>
    </table>
  </div></>;
}
