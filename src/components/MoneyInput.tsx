import { useEffect, useRef, useState } from 'react';
import { parseMoneyToCents } from '../lib/finance';
import { formatMoneyAmount } from '../lib/numbers';

export function MoneyInput({ value, onChange, label }: { value: number; onChange: (n: number) => void | boolean; label: string }) {
  const dirty = useRef(false);
  const previousValue = useRef(value);
  const [draft, setDraft] = useState(() => formatMoneyAmount(value));
  useEffect(() => {
    if (!dirty.current || previousValue.current !== value) {
      dirty.current = false;
      const formatted = formatMoneyAmount(value);
      if (draft !== formatted) setDraft(formatted);
    }
    previousValue.current = value;
  });
  function revert() { dirty.current = false; setDraft(formatMoneyAmount(value)); }
  function commit() {
    if (!dirty.current) return;
    dirty.current = false;
    try { if (onChange(parseMoneyToCents(draft)) === false) revert(); }
    catch { revert(); }
  }
  return <input data-money-input aria-label={label} inputMode="decimal" value={draft} onChange={event => { dirty.current = true; setDraft(event.target.value); }} onBlur={commit} onKeyDown={event => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur(); }
    if (event.key === 'Escape') { event.preventDefault(); revert(); event.currentTarget.blur(); }
  }} />;
}
