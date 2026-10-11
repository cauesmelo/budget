import { useEffect, useId, useRef, useState } from 'react';
import { Archive, Check, Pencil, Plus, RotateCcw, Search, Tag, X } from 'lucide-react';
import type { FinanceData } from '../lib/types';
import { addCategory, archiveCategory, listCategories, renameCategory, restoreCategory } from '../lib/categories';

interface CategoryManagerProps {
  data: FinanceData;
  onEdit: (edit: (current: FinanceData) => FinanceData) => boolean;
  onClose: () => void;
}

export function CategoryManager({ data, onEdit, onClose }: CategoryManagerProps) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [newName, setNewName] = useState('');
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const categories = listCategories(data);
  const activeCount = categories.filter(category => !category.archivedAt).length;
  const visible = categories.filter(category => (showArchived || !category.archivedAt) && category.name.toLocaleLowerCase('pt-BR').includes(query.trim().toLocaleLowerCase('pt-BR')));

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameInput.current?.focus();
    function keys(event: KeyboardEvent) {
      if (event.key === 'Escape' && !(event.target as HTMLElement)?.closest('.category-popup')) { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab' || (event.target as HTMLElement)?.closest('.category-popup')) return;
      const focusable = panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]');
      if (!focusable?.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', keys);
    const oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', keys); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, [onClose]);

  function perform(edit: (current: FinanceData) => FinanceData, message: string) {
    setError(''); setStatus('');
    try {
      if (!onEdit(edit)) { setError('Could not save the category. Check your data and try again.'); return false; }
      setStatus(message); return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Check the category name.'); return false; }
  }

  return <div className="modal-backdrop category-manager-backdrop" onClick={onClose}><div ref={panel} className="modal panel category-manager" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onClick={event => event.stopPropagation()}>
    <div className="panel-header"><div><h2 id={`${id}-title`}>Manage categories</h2><p>{activeCount} available for transactions and planning</p></div><button className="icon-button" aria-label="Close category manager" onClick={onClose}><X size={20} /></button></div>
    <p className="category-manager-intro">Create categories that work for you. Renaming updates existing records; archiving preserves history and removes the category from new transactions.</p>
    <form className="category-create" onSubmit={event => { event.preventDefault(); if (perform(current => addCategory(current, newName), 'Category created.')) { setNewName(''); nameInput.current?.focus(); } }}>
      <label className="field"><span>New category</span><input ref={nameInput} aria-label="New category name" autoComplete="off" placeholder="e.g., Food" value={newName} maxLength={200} onChange={event => setNewName(event.target.value)} /></label>
      <button type="submit" className="button"><Plus size={16} /> Create category</button>
    </form>
    {error && <div role="alert" className="alert error">{error}</div>}
    {status && <div role="status" className="alert success"><Check size={16} />{status}</div>}
    <div className="category-manager-filters"><div className="search"><Search size={16} /><input aria-label="Search existing categories" placeholder="Search categories" value={query} onChange={event => setQuery(event.target.value)} /></div><label className="category-archived-toggle"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} /> Show archived</label></div>
    <div className="managed-category-list">
      {visible.map(category => {
        const names = new Set([category.name, ...(category.aliases || [])]);
        const transactions = data.transactions.filter(tx => !tx.deletedAt && names.has(tx.category)).length;
        const plans = data.planItems.filter(item => !item.deletedAt && names.has(item.category)).length;
        return <div className={`managed-category-row ${category.archivedAt ? 'archived' : ''}`} key={category.id}>
          <div className="managed-category-icon"><Tag size={17} /></div>
          <div className="managed-category-details">
            {editing === category.id ? <form className="category-rename" onSubmit={event => { event.preventDefault(); if (perform(current => renameCategory(current, category.id, draft), 'Category renamed.')) setEditing(null); }}><input aria-label={`New name for ${category.name}`} autoFocus value={draft} maxLength={200} onChange={event => setDraft(event.target.value)} /><button type="submit" className="icon-button" aria-label={`Save name for ${category.name}`} title="Save name"><Check size={17} /></button><button type="button" className="icon-button" aria-label="Cancel renaming" onClick={() => { setEditing(null); setError(''); }}><X size={17} /></button></form> : <strong>{category.name}</strong>}
            <small>{transactions} {transactions === 1 ? 'transaction' : 'transactions'} · {plans} {plans === 1 ? 'plan item' : 'plan items'}{category.archivedAt && <span className="category-archived-badge">Archived</span>}</small>
          </div>
          {editing !== category.id && <div className="managed-category-actions"><button type="button" className="icon-button" aria-label={`Rename ${category.name}`} title="Rename" onClick={() => { setEditing(category.id); setDraft(category.name); setError(''); setStatus(''); }}><Pencil size={16} /></button>{category.archivedAt ? <button type="button" className="icon-button" aria-label={`Restore ${category.name}`} title="Restore" onClick={() => perform(current => restoreCategory(current, category.id), 'Category restored.')}><RotateCcw size={16} /></button> : <button type="button" className="icon-button" aria-label={`Archive ${category.name}`} title="Archive" onClick={() => perform(current => archiveCategory(current, category.id), 'Category archived. Your records were preserved.')}><Archive size={16} /></button>}</div>}
        </div>;
      })}
      {!visible.length && <div className="category-manager-empty"><Tag size={24} /><p>{query ? 'No categories match this filter.' : showArchived ? 'Create your first category above.' : 'No categories available. Create one or show archived categories.'}</p></div>}
    </div>
    <div className="category-manager-footer"><small>Categories are included in backups and sync.</small><button type="button" className="button secondary" onClick={onClose}>Done</button></div>
  </div></div>;
}
