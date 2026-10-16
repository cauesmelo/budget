import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { availableCategoryNames, categoryUsage } from '../lib/categories';
import { formatNumber } from '../lib/numbers';
import type { Category, FinanceData } from '../lib/types';
import { CategorySelect } from './CategorySelect';

export function CategoryDeletion({ data, category, onDelete, onCancel }: {
  data: FinanceData;
  category: Category;
  onDelete: (replacement?: string) => boolean;
  onCancel: () => void;
}) {
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const [replacement, setReplacement] = useState('');
  const [error, setError] = useState('');
  const usage = categoryUsage(data, category.id);
  const options = availableCategoryNames(data).filter(name => name !== category.name);
  const selected = options.includes(replacement) ? replacement : '';
  const assigned = usage.total > 0;
  const references = [
    [usage.transactions, 'transaction record', 'transaction records'],
    [usage.planItems, 'plan item', 'plan items'],
    [usage.workRules, 'work rule', 'work rules'],
  ] as const;
  const counts = references.filter(([count]) => count > 0).map(([count, singular, plural]) => `${formatNumber(count)} ${count === 1 ? singular : plural}`).join(', ');

  useLayoutEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('[role="combobox"], [data-cancel-category-delete]')?.focus();
  }, []);

  return <section ref={panel} className="category-deletion" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Delete {category.name}?</h3>
    <p>{assigned ? `Assigned to ${counts}. Choose the category that will replace it on those items.` : 'This category is not assigned to any items.'}</p>
    <p className="category-deletion-note">{assigned ? 'Historical and deleted records are included. Amounts, descriptions, and personal or work classifications are preserved.' : 'Deleting removes this category from your lists.'}</p>
    <form onSubmit={event => {
      event.preventDefault();
      if (assigned && !selected) { setError('Choose a replacement category before deleting.'); return; }
      setError('');
      if (!onDelete(selected || undefined)) setError('Could not delete this category. Check the message above and try again.');
    }}>
      {assigned && <div className="field"><span>Replacement category</span>{options.length
        ? <CategorySelect label="Replacement category" options={options} value={selected} onChange={name => { setReplacement(name); setError(''); }} allowUncategorized={false} placeholder="Choose replacement" />
        : <p className="category-deletion-empty" role="status">Create or restore another category before deleting this one.</p>}</div>}
      {error && <p className="category-deletion-error" role="alert">{error}</p>}
      <div className="category-deletion-actions"><button type="button" className="button secondary" data-cancel-category-delete onClick={onCancel}>Cancel</button><button type="submit" className="button category-deletion-confirm" disabled={assigned && !selected}><Trash2 size={15} />{assigned ? 'Replace and delete' : 'Delete category'}</button></div>
    </form>
  </section>;
}
