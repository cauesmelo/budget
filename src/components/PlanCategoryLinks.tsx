import { useState } from 'react';
import { availableCategoryNames, resolveCategoryName } from '../lib/categories';
import { formatNumber } from '../lib/numbers';
import type { FinanceData, PlanItem } from '../lib/types';
import { CategorySelect } from './CategorySelect';
import './PlanCategoryLinks.css';

interface PlanCategoryLinksProps {
  data: FinanceData;
  items: PlanItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCategory: (id: string, category: string) => boolean;
}

export function PlanCategoryLinks({ data, items, open, onOpenChange, onCategory }: PlanCategoryLinksProps) {
  const [message, setMessage] = useState('');
  const categories = availableCategoryNames(data);
  const expenses = items.filter(item => item.kind === 'expense' && !item.deletedAt);
  const linkedCount = expenses.filter(item => resolveCategoryName(data, item.category)).length;

  function updateCategory(item: PlanItem, category: string) {
    setMessage('');
    if (!onCategory(item.id, category)) return;
    const name = item.name || 'Unnamed expense';
    setMessage(category ? `${name} linked to ${category} for all months.` : `Category link removed for ${name} for all months.`);
  }

  return <details className="panel simple-plan-extra plan-category-links" data-plan-category-links open={open} onToggle={event => {
    if (event.currentTarget.open !== open) onOpenChange(event.currentTarget.open);
  }}>
    <summary>Category links <span className="plan-category-links-count">{formatNumber(linkedCount)} of {formatNumber(expenses.length)} linked</span></summary>
    <div className="plan-category-links-body">
      <p>Link each planned expense to a spending category once. These links group your existing plan in the monthly spending review.</p>
      {expenses.length ? <>
        <p className="plan-category-links-note">Category links apply to every month of an expense. Amounts stay in the plan above.</p>
        {!categories.length && <p className="plan-category-links-note">Create categories in Settings to link these expenses.</p>}
        <ul className="plan-category-links-list">
          {expenses.map(item => <li className="plan-category-links-row" data-plan-category-item={item.id} key={item.id}>
            <span className="plan-category-links-name">{item.name || 'Unnamed expense'}</span>
            <CategorySelect label={`Budget category for ${item.name || 'Unnamed expense'}`} value={resolveCategoryName(data, item.category)} options={categories} onChange={category => updateCategory(item, category)} />
          </li>)}
        </ul>
      </> : <p className="plan-category-links-note">Add planned expenses above, then link them to your spending categories here.</p>}
      <span className="plan-category-links-status" role="status" aria-live="polite">{message}</span>
    </div>
  </details>;
}
