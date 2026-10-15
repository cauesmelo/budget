import { useEffect, useId, useRef, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { FinanceData, InstallmentSchedule, PlanItem } from '../lib/types';
import { addMonths, formatMoney, formatMonth, getInstallmentSuggestions, getTransactionScope, isValidMonth, parseMoneyToCents } from '../lib/finance';

interface InstallmentEditorProps {
  data: FinanceData;
  item: PlanItem;
  onChange: (installments: InstallmentSchedule[]) => boolean;
  onClose: () => void;
}

function scheduleKey(schedule: InstallmentSchedule): string {
  return schedule.sourceKey ?? schedule.id;
}

export function InstallmentEditor({ data, item, onChange, onClose }: InstallmentEditorProps) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const minimumFirstMonth = data.reporting && data.reporting.startMonth > item.startMonth ? data.reporting.startMonth : item.startMonth;
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [firstMonth, setFirstMonth] = useState(minimumFirstMonth);
  const [count, setCount] = useState('1');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [suggestionMonth, setSuggestionMonth] = useState(() => data.transactions
    .filter(tx => !tx.deletedAt && tx.source === 'card' && tx.kind === 'expense' && tx.amountCents < 0 && getTransactionScope(data, tx) === 'personal' && tx.month >= minimumFirstMonth && (!item.endMonth || tx.month <= item.endMonth))
    .map(tx => tx.month).sort().at(-1) ?? minimumFirstMonth);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const installments = item.installments ?? [];
  const existingKeys = new Set(installments.map(scheduleKey));
  const suggestions = isValidMonth(suggestionMonth) ? getInstallmentSuggestions(data, suggestionMonth).filter(schedule => !existingKeys.has(scheduleKey(schedule))) : [];
  const selectedSuggestions = suggestions.filter(schedule => selected.includes(scheduleKey(schedule)));

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameInput.current?.focus();
    function keys(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', keys);
    const oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', keys); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, []);

  function save(next: InstallmentSchedule[], message: string): boolean {
    setError(''); setStatus('');
    try {
      if (!onChange(next)) { setError('Could not save the installments. Check your data and try again.'); return false; }
      setStatus(message); return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the installments.'); return false;
    }
  }

  function validateRange(schedule: InstallmentSchedule) {
    if (!isValidMonth(schedule.firstMonth) || schedule.firstMonth < minimumFirstMonth) throw new Error(`Choose a first billing month from ${formatMonth(minimumFirstMonth)} onward.`);
    if (!Number.isInteger(schedule.count) || schedule.count < 1 || schedule.count > 600) throw new Error('Enter between 1 and 600 remaining payments.');
    const lastMonth = addMonths(schedule.firstMonth, schedule.count - 1);
    if (item.endMonth && lastMonth > item.endMonth) throw new Error(`The final payment must be in or before ${formatMonth(item.endMonth)}. Extend the budget item’s end month first.`);
  }

  function clearForm() {
    setName(''); setAmount(''); setFirstMonth(minimumFirstMonth); setCount('1'); setEditingId(null);
    nameInput.current?.focus();
  }

  function saveManual() {
    setError(''); setStatus('');
    try {
      if (!name.trim()) throw new Error('Enter a name for the installment purchase.');
      const amountCents = parseMoneyToCents(amount);
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('Enter a payment amount greater than zero.');
      const existing = installments.find(schedule => schedule.id === editingId);
      const schedule: InstallmentSchedule = { ...existing, id: existing?.id ?? crypto.randomUUID(), name: name.trim(), amountCents, firstMonth, count: Number(count) };
      validateRange(schedule);
      const next = editingId ? installments.map(current => current.id === editingId ? schedule : current) : [...installments, schedule];
      if (save(next, editingId ? 'Installment schedule updated.' : 'Installment schedule added.')) clearForm();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Check the installment details.'); }
  }

  function addSelected() {
    setError(''); setStatus('');
    try {
      const seenIds = new Set(installments.map(schedule => schedule.id));
      const seenSources = new Set(installments.flatMap(schedule => schedule.sourceKey ? [schedule.sourceKey] : []));
      const additions = selectedSuggestions.filter(schedule => {
        if (seenIds.has(schedule.id) || (schedule.sourceKey && seenSources.has(schedule.sourceKey))) return false;
        seenIds.add(schedule.id);
        if (schedule.sourceKey) seenSources.add(schedule.sourceKey);
        return true;
      });
      if (!additions.length) throw new Error('Select at least one installment that is not already budgeted.');
      additions.forEach(validateRange);
      if (save([...installments, ...additions], `${additions.length} installment ${additions.length === 1 ? 'schedule' : 'schedules'} added.`)) setSelected([]);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Check the selected installments.'); }
  }

  return <div className="modal-backdrop installment-editor-backdrop" onClick={onClose}>
    <div ref={panel} className="modal panel installment-editor" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`} onClick={event => event.stopPropagation()}>
      <div className="panel-header"><div><h2 id={`${id}-title`}>Installments for {item.name}</h2><p>{installments.length} scheduled {installments.length === 1 ? 'purchase' : 'purchases'}</p></div><button type="button" className="icon-button" aria-label="Close installment editor" onClick={onClose}><X size={20} /></button></div>
      <p id={`${id}-intro`} className="installment-editor-intro">Include existing installments only when they are not already covered by another budget row. Each schedule adds its payment to the billing months below; it does not create transactions.</p>
      {error && <div role="alert" className="alert error">{error}</div>}
      {status && <div role="status" className="alert success"><Check size={16} />{status}</div>}

      <section className="installment-editor-section" aria-labelledby={`${id}-manual-title`}>
        <h3 id={`${id}-manual-title`}>{editingId ? 'Edit installment schedule' : 'Add an installment schedule'}</h3>
        <form className="installment-form" onSubmit={event => { event.preventDefault(); saveManual(); }}>
          <label className="field installment-form-name"><span>Purchase name</span><input ref={nameInput} aria-label="Installment purchase name" value={name} maxLength={200} placeholder="e.g., Laptop" autoComplete="off" onChange={event => setName(event.target.value)} /></label>
          <label className="field"><span>Payment per month (R$)</span><input aria-label="Installment payment amount" inputMode="decimal" value={amount} placeholder="0,00" onChange={event => setAmount(event.target.value)} /></label>
          <label className="field"><span>First billing month</span><input aria-label="First installment billing month" type="month" min={minimumFirstMonth} max={item.endMonth ?? '9999-12'} value={firstMonth} onChange={event => setFirstMonth(event.target.value)} /></label>
          <label className="field"><span>Remaining payments</span><input aria-label="Remaining installment payments" type="number" min="1" max="600" step="1" inputMode="numeric" value={count} onChange={event => setCount(event.target.value)} /></label>
          <p className="installment-form-help">Include the first billing month in the number of remaining payments.</p>
          <div className="installment-form-actions"><button type="submit" className="button">{editingId ? <Check size={16} /> : <Plus size={16} />}{editingId ? 'Save schedule' : 'Add schedule'}</button>{editingId && <button type="button" className="button secondary" onClick={() => { clearForm(); setError(''); }}>Cancel edit</button>}</div>
        </form>
      </section>

      <section className="installment-editor-section" aria-labelledby={`${id}-scheduled-title`}>
        <div className="installment-editor-heading"><h3 id={`${id}-scheduled-title`}>Scheduled purchases</h3><small>Payment amount · first to last billing month</small></div>
        {installments.length ? <div className="installment-list">{installments.map(schedule => <div className="installment-row" key={schedule.id}>
          <div className="installment-details"><strong>{schedule.name}</strong><span>{formatMoney(schedule.amountCents)} / month</span><small>{formatMonth(schedule.firstMonth)} – {formatMonth(addMonths(schedule.firstMonth, schedule.count - 1))} · {schedule.count} {schedule.count === 1 ? 'payment' : 'payments'}{schedule.sourceKey && ' · From statement'}</small></div>
          <div className="installment-row-actions"><button type="button" className="icon-button" aria-label={`Edit installment ${schedule.name}`} title="Edit schedule" onClick={() => { setEditingId(schedule.id); setName(schedule.name); setAmount((schedule.amountCents / 100).toFixed(2).replace('.', ',')); setFirstMonth(schedule.firstMonth); setCount(String(schedule.count)); setError(''); setStatus(''); nameInput.current?.focus(); }}><Pencil size={16} /></button><button type="button" className="icon-button danger" aria-label={`Remove installment ${schedule.name}`} title="Remove schedule" onClick={() => { if (save(installments.filter(current => current.id !== schedule.id), 'Installment schedule removed.')) { if (editingId === schedule.id) clearForm(); else nameInput.current?.focus(); } }}><Trash2 size={16} /></button></div>
        </div>)}</div> : <p className="installment-editor-empty">No schedules yet. Add a purchase above or review suggestions from an imported statement.</p>}
      </section>

      <section className="installment-editor-section" aria-labelledby={`${id}-suggestions-title`}>
        <h3 id={`${id}-suggestions-title`}>Review imported card installments</h3>
        <p>Choose the most recent complete billing month. Suggestions include that month’s payment and the remaining payments. Select only purchases not already budgeted elsewhere.</p>
        <label className="field installment-suggestions-month"><span>Statement billing month</span><input aria-label="Installment suggestion billing month" type="month" min={minimumFirstMonth} max={item.endMonth ?? '9999-12'} value={suggestionMonth} onChange={event => { setSuggestionMonth(event.target.value); setSelected([]); setError(''); setStatus(''); }} /></label>
        {suggestions.length ? <><div className="installment-list">{suggestions.map(schedule => <label className="installment-suggestion" key={scheduleKey(schedule)}>
          <input type="checkbox" aria-label={`Include ${schedule.name}, not budgeted elsewhere`} checked={selected.includes(scheduleKey(schedule))} onChange={event => setSelected(current => event.target.checked ? [...current, scheduleKey(schedule)] : current.filter(key => key !== scheduleKey(schedule)))} />
          <span className="installment-suggestion-details"><strong>{schedule.name}</strong><span>{formatMoney(schedule.amountCents)} / month · {schedule.count} remaining {schedule.count === 1 ? 'payment' : 'payments'}</span><small>{formatMonth(schedule.firstMonth)} – {formatMonth(addMonths(schedule.firstMonth, schedule.count - 1))} · Not budgeted elsewhere</small></span>
        </label>)}</div><button type="button" className="button secondary" disabled={!selectedSuggestions.length} onClick={addSelected}><Plus size={16} />Add selected{selectedSuggestions.length ? ` (${selectedSuggestions.length})` : ''}</button></> : <p className="installment-editor-empty">{isValidMonth(suggestionMonth) ? 'No new personal installment purchases found for this billing month. Import a card statement first, choose another month, or add a schedule manually.' : 'Choose a billing month to review imported installments.'}</p>}
      </section>

      <div className="installment-editor-footer"><small>Changes are saved to this budget immediately.</small><button type="button" className="button secondary" onClick={onClose}>Done</button></div>
    </div>
  </div>;
}
