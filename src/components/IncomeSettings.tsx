import { useEffect, useId, useRef, useState } from 'react';
import { Check, Wallet } from 'lucide-react';
import { formatMoney, parseMoneyToCents } from '../lib/finance';
import { formatMoneyAmount } from '../lib/numbers';
import './IncomeSettings.css';

interface IncomeSettingsProps {
  value?: number;
  onSave: (cents: number) => boolean;
}

export function IncomeSettings({ value, onSave }: IncomeSettingsProps) {
  const id = useId();
  const lastSavedValue = useRef<number | undefined>(undefined);
  const [draft, setDraft] = useState(() => value === undefined ? '' : formatMoneyAmount(value));
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    setDraft(value === undefined ? '' : formatMoneyAmount(value));
    setError('');
    if (value !== lastSavedValue.current) setStatus('');
  }, [value]);

  function readAmount(): number {
    if (!draft.trim() || !/\d/.test(draft)) throw new Error('Enter your monthly income. Use 0 if you have no monthly income.');
    const cents = parseMoneyToCents(draft);
    if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Enter a valid monthly income of zero or more, such as 1.234,56.');
    return cents;
  }

  function normalize() {
    if (!draft.trim()) return;
    try {
      setDraft(formatMoneyAmount(readAmount()));
      setError('');
    } catch {
      setError('Enter a valid monthly income of zero or more, such as 1.234,56.');
    }
  }

  function save() {
    setError('');
    setStatus('');
    let cents: number;
    try {
      cents = readAmount();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Enter a valid monthly income.');
      return;
    }
    try {
      if (!onSave(cents)) {
        setError('Could not save your monthly income. Try again.');
        return;
      }
      lastSavedValue.current = cents;
      setDraft(formatMoneyAmount(cents));
      setStatus(`Monthly income saved: ${formatMoney(cents)}.`);
    } catch {
      setError('Could not save your monthly income. Try again.');
    }
  }

  return <section className="panel income-settings" aria-labelledby={`${id}-title`}>
    <div className="panel-header"><div><h2 id={`${id}-title`}>Monthly income</h2><p>Set your monthly take-home income.</p></div><Wallet size={21} /></div>
    <form className="income-settings-form" noValidate onSubmit={event => { event.preventDefault(); save(); }}>
      <label className="field" htmlFor={`${id}-amount`}>
        <span>Current monthly income (R$)</span>
        <input id={`${id}-amount`} inputMode="decimal" autoComplete="off" placeholder="Enter monthly income" value={draft}
          aria-invalid={Boolean(error)} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
          onChange={event => { setDraft(event.target.value); setError(''); setStatus(''); }} onBlur={normalize} />
      </label>
      <button className="button" type="submit">Save income</button>
    </form>
    <p id={`${id}-help`} className="income-settings-help">Used every month in your overview and medium-term plan. Imported credits stay in Transactions and are not added to this amount.</p>
    {error && <div id={`${id}-error`} className="alert error" role="alert">{error}</div>}
    {status && <div className="alert success" role="status"><Check size={16} />{status}</div>}
  </section>;
}
