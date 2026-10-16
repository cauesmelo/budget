import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Trash2, X } from 'lucide-react';
import { formatMoney, formatMonth, planAmountForMonth } from '../lib/finance';
import type { PlanItem, ProjectionMonth } from '../lib/types';
import { MoneyInput } from './MoneyInput';

interface PlanGridCallbacks {
  onPatch: (id: string, patch: Partial<PlanItem>) => boolean;
  onMonthly: (id: string, amount: number) => boolean;
  onMonth: (id: string, month: string, amount: number) => boolean;
  onMove?: (id: string, direction: 'up' | 'down') => boolean;
}

interface PlanGridProps extends PlanGridCallbacks {
  items: PlanItem[];
  months: ProjectionMonth[];
  selectedMonth?: string;
  children?: ReactNode;
}

interface PlanGridRowProps extends PlanGridCallbacks {
  item: PlanItem;
  months: ProjectionMonth[];
  selectedMonth?: string;
  editableName?: boolean;
  editableMonthly?: boolean;
  removable?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

export function PlanGridRow({
  item, months, selectedMonth, onPatch, onMonthly, onMonth, onMove,
  editableName = true, editableMonthly = true, removable = true,
  canMoveUp = false, canMoveDown = false,
}: PlanGridRowProps) {
  const monthlyAmount = item.behavior === 'monthly' || item.behavior === 'installments' ? 0 : item.defaultAmountCents;
  function move(direction: 'up' | 'down', button: HTMLButtonElement) {
    const row = button.closest('tr');
    if (!onMove?.(item.id, direction)) return;
    requestAnimationFrame(() => {
      if (!row?.isConnected) return;
      const target = button.disabled ? row.querySelector<HTMLButtonElement>('.plan-item-order button:not(:disabled)') : button;
      target?.focus({ preventScroll: true });
    });
  }
  return <tr data-plan-id={item.id}>
    <td><div className={`plan-item-name${onMove ? ' reorderable' : ''}`}>{onMove && <div className="plan-item-order">
      <button type="button" className="icon-button" title="Move up" aria-label={`Move ${item.name} up`} disabled={!canMoveUp} onClick={event => move('up', event.currentTarget)}><ChevronUp size={15} aria-hidden="true" /></button>
      <button type="button" className="icon-button" title="Move down" aria-label={`Move ${item.name} down`} disabled={!canMoveDown} onClick={event => move('down', event.currentTarget)}><ChevronDown size={15} aria-hidden="true" /></button>
    </div>}{editableName
      ? <input aria-label="Item name" value={item.name} onChange={event => onPatch(item.id, { name: event.target.value })} />
      : <span className="simple-plan-label">{item.name}</span>}</div></td>
    <td>{editableMonthly
      ? <MoneyInput label={`Monthly amount for ${item.name}`} value={monthlyAmount} onChange={amount => onMonthly(item.id, Math.max(0, amount))} />
      : formatMoney(monthlyAmount)}</td>
    {months.map(({ month }) => {
      const edited = Object.hasOwn(item.amounts, month);
      return <td key={month} data-plan-month={month} className={[edited ? 'overridden' : '', month === selectedMonth ? 'plan-review-month' : ''].filter(Boolean).join(' ') || undefined}>
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

export function PlanGrid({ items, months, selectedMonth, onPatch, onMonthly, onMonth, onMove, children }: PlanGridProps) {
  const [moveStatus, setMoveStatus] = useState('');
  function move(id: string, direction: 'up' | 'down') {
    if (!onMove?.(id, direction)) return false;
    setMoveStatus(`${items.find(item => item.id === id)?.name || 'Item'} moved ${direction}.`);
    return true;
  }
  return <><span className="plan-reorder-status" role="status" aria-live="polite">{moveStatus}</span><p className="table-swipe-hint">Swipe horizontally to see the months.</p><div className="table-scroll">
    <table className="plan-table simple-plan-table">
      <thead><tr><th>Item</th><th>Monthly (R$)</th>{months.map(({ month }) => <th key={month} className={month === selectedMonth ? 'plan-review-month' : undefined}>{formatMonth(month)}{month === selectedMonth && <small>Review month</small>}</th>)}<th /></tr></thead>
      <tbody>
        {items.map((item, index) => <PlanGridRow key={item.id} item={item} months={months} selectedMonth={selectedMonth} onPatch={onPatch} onMonthly={onMonthly} onMonth={onMonth} onMove={onMove && items.length > 1 ? move : undefined} canMoveUp={index > 0} canMoveDown={index < items.length - 1} />)}
        {children}
      </tbody>
    </table>
  </div></>;
}
