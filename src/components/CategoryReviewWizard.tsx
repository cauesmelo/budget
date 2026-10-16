import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Tag } from 'lucide-react';
import { CategorySelect } from './CategorySelect';
import { availableCategoryNames, resolveCategoryName } from '../lib/categories';
import { getRankedReviewCategories } from '../lib/categoryReview';
import { formatMoney, getTransactionScope } from '../lib/finance';
import { formatNumber } from '../lib/numbers';
import { getTransactionFlowLabel } from '../lib/transactionFlow';
import type { FinanceData, Transaction } from '../lib/types';
import './CategoryReviewWizard.css';

interface CategoryReviewWizardProps {
  data: FinanceData;
  transactions: Transaction[];
  onSave: (transaction: Transaction, category: string, description: string) => boolean;
  onClose: () => void;
  onManageCategories: () => void;
  suspended: boolean;
}

const sourceNames = { bank: 'Itaú account', card: 'Itaú card', manual: 'Manual' };
const DESCRIPTION_LIMIT = 20_000;

export function CategoryReviewWizard({ data, transactions, onSave, onClose, onManageCategories, suspended }: CategoryReviewWizardProps) {
  // Keep shortcuts stable while reviewing; newly used categories take priority next session.
  const [initialRanking] = useState(() => getRankedReviewCategories(data));
  const [completed, setCompleted] = useState(0);
  const available = useMemo(() => availableCategoryNames(data), [data.categories]);
  const categories = [...initialRanking.filter(name => available.includes(name)), ...available.filter(name => !initialRanking.includes(name))];
  const total = completed + transactions.length;
  const transaction = transactions[0];

  return <section className="category-wizard" aria-label="Category review">
    <div className="category-wizard-top">
      <button type="button" className="text-button" onClick={onClose}><ArrowLeft size={15} /> Back to transactions</button>
      <span className="category-wizard-count" role="status">{formatNumber(completed)} saved · {formatNumber(transactions.length)} remaining · all months</span>
    </div>
    <progress className="category-wizard-progress" aria-label="Category review progress" max={Math.max(1, total)} value={transaction ? completed : Math.max(1, total)} />
    {transaction ? <TransactionReview key={`${transaction.id}:${transaction.updatedAt}`} transaction={transaction} data={data} categories={categories} suspended={suspended} onManageCategories={onManageCategories} onSave={(category, description) => {
      const accepted = onSave(transaction, category, description);
      if (accepted) setCompleted(count => count + 1);
      return accepted;
    }} /> : <ReviewComplete completed={completed} onClose={onClose} />}
  </section>;
}

function TransactionReview({ transaction, data, categories, onSave, onManageCategories, suspended }: {
  transaction: Transaction;
  data: FinanceData;
  categories: string[];
  onSave: (category: string, description: string) => boolean;
  onManageCategories: () => void;
  suspended: boolean;
}) {
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState(transaction.description);
  const [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const submitted = useRef(false);
  const focusedOnce = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const shortcuts = categories.slice(0, 9);
  const resolvedCategory = resolveCategoryName(data, category);
  const selected = categories.includes(resolvedCategory) ? resolvedCategory : '';
  const scope = getTransactionScope(data, transaction);

  useLayoutEffect(() => {
    if (suspended) return;
    panel.current?.focus({ preventScroll: true });
    if (!focusedOnce.current && panel.current) {
      const top = panel.current.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight - 160) panel.current.closest('.category-wizard')?.scrollIntoView({ block: 'start' });
      focusedOnce.current = true;
    }
  }, [suspended]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    editor.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [description]);

  function chooseCategory(name: string) {
    setCategory(name); setError('');
    panel.current?.focus({ preventScroll: true });
  }

  function save() {
    if (submitted.current || composing.current || suspended) return;
    if (!selected) {
      setError('Choose a category before continuing.');
      panel.current?.querySelector<HTMLButtonElement>('.category-wizard-choice, .category-trigger')?.focus({ preventScroll: true });
      return;
    }
    submitted.current = true;
    if (!onSave(selected, description)) {
      submitted.current = false;
      setError('This entry could not be saved. Check the message above and try again.');
    }
  }

  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (suspended || event.defaultPrevented || event.nativeEvent.isComposing || composing.current || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.category-popup, [role="dialog"]')) return;
    const editing = target?.matches('input, textarea, select, [contenteditable="true"]');
    if (event.key === 'Dead' || event.key === 'Process') {
      if (!editing) editor.current?.focus();
      return;
    }
    const digit = event.altKey && /^Digit[1-9]$/.test(event.code) ? Number(event.code.slice(-1)) : /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
    if (digit && (!editing || event.altKey) && !event.shiftKey) {
      const choice = shortcuts[digit - 1];
      if (choice) {
        event.preventDefault();
        if (!event.repeat) {
          setCategory(choice); setError('');
          if (!editing) panel.current?.focus({ preventScroll: true });
        }
      }
      return;
    }
    if (event.altKey) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      if (event.repeat) { event.preventDefault(); return; }
      if (target?.closest('button, [role="combobox"]')) return;
      event.preventDefault(); form.current?.requestSubmit();
    } else if (!editing && event.key.length === 1 && !(event.key === ' ' && target?.closest('button, [role="combobox"], a[href]'))) {
      event.preventDefault();
      const value = description.length < DESCRIPTION_LIMIT ? description + event.key : description;
      pendingCaret.current = value.length;
      setDescription(value); editor.current?.focus();
      if (value === description) { editor.current?.setSelectionRange(value.length, value.length); pendingCaret.current = null; }
    }
  }

  return <section ref={panel} className="panel category-wizard-card" tabIndex={-1} aria-label="Transaction to categorize" onKeyDown={handleKeys}>
    <header className="category-wizard-entry">
      <div><span className="pill subdued">{scope === 'work' ? data.work?.label || 'Work' : 'Personal'} · {getTransactionFlowLabel(transaction, scope)}</span><h2>{transaction.originalDescription}</h2><p className="category-wizard-meta">{transaction.date.split('-').reverse().join('/')} · {sourceNames[transaction.source]}{transaction.account && ` · ${transaction.account}`}{transaction.installment && ` · Installment ${transaction.installment}`}</p></div>
      <strong className={`category-wizard-amount${transaction.amountCents > 0 ? ' green' : ''}`}>{formatMoney(transaction.amountCents)}</strong>
    </header>
    <form ref={form} className="category-wizard-form" onSubmit={event => { event.preventDefault(); save(); }}>
      <fieldset className="category-wizard-categories" aria-describedby={error ? 'category-review-error' : undefined}>
        <legend>Category <small>Most used first</small></legend>
        {categories.length ? <>
          <div className="category-wizard-choices">{shortcuts.map((name, index) => <button type="button" className="category-wizard-choice" aria-label={`Category ${index + 1}: ${name}`} aria-pressed={selected === name} aria-keyshortcuts={`${index + 1} Alt+${index + 1}`} key={name} onClick={() => chooseCategory(name)}><kbd>{index + 1}</kbd><span>{name}</span>{selected === name && <Check size={16} aria-hidden="true" />}</button>)}</div>
          <div className="category-wizard-more"><span>All categories</span><CategorySelect label="Review category" options={categories} value={selected} onChange={value => { setCategory(value); setError(''); queueMicrotask(() => panel.current?.focus({ preventScroll: true })); }} /></div>
        </> : <p>Add a category to start reviewing.</p>}
        <button type="button" className="text-button" onClick={onManageCategories}><Tag size={14} /> Manage categories</button>
      </fieldset>
      <label className="field category-wizard-description"><span>Description <small>optional</small></span><textarea ref={editor} aria-label="Review description" rows={2} maxLength={DESCRIPTION_LIMIT} placeholder="Start typing to add a description…" value={description} onChange={event => setDescription(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} /><small>Numbers here stay in your description. Use Alt+1–9 to change category while typing.</small></label>
      {error && <p className="category-wizard-error" id="category-review-error" role="alert">{error}</p>}
      <div className="category-wizard-footer"><button type="submit" className="button" disabled={!categories.length}>Save and next <ArrowRight size={16} /></button><div className="category-wizard-shortcuts"><span><kbd>1–9</kbd> Category</span><span>Type for description</span><span><kbd>Enter</kbd> Save and next</span></div></div>
    </form>
  </section>;
}

function ReviewComplete({ completed, onClose }: { completed: number; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => { panel.current?.focus({ preventScroll: true }); }, []);
  return <section ref={panel} className="panel category-wizard-complete" tabIndex={-1} aria-label="Category review complete">
    <span className="category-wizard-complete-icon"><Check size={28} /></span><h2>All caught up.</h2><p>{completed ? `${formatNumber(completed)} ${completed === 1 ? 'transaction' : 'transactions'} categorized. ` : ''}No transactions are waiting for a category.</p><button type="button" className="button" onClick={onClose}>Back to transactions <ArrowRight size={16} /></button>
  </section>;
}
