import { useEffect, useRef, useState } from 'react';
import { formatNumber, parseLocalizedNumber } from '../lib/numbers';

export function DecimalInput({ value, onChange, label }: { value: number; onChange: (n: number) => void | boolean; label: string }) {
  const dirty = useRef(false);
  const previousValue = useRef(value);
  const [draft, setDraft] = useState(() => formatNumber(value));
  useEffect(() => {
    if (!dirty.current || previousValue.current !== value) {
      dirty.current = false;
      const formatted = formatNumber(value);
      if (draft !== formatted) setDraft(formatted);
    }
    previousValue.current = value;
  });
  function revert() { dirty.current = false; setDraft(formatNumber(value)); }
  function commit() {
    if (!dirty.current) return;
    dirty.current = false;
    try {
      const parsed = parseLocalizedNumber(draft);
      if (onChange(parsed) === false) revert();
      else setDraft(formatNumber(parsed));
    } catch { revert(); }
  }
  return <input data-number-input aria-label={label} inputMode="decimal" value={draft} onChange={event => { dirty.current = true; setDraft(event.target.value); }} onBlur={commit} onKeyDown={event => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur(); }
    if (event.key === 'Escape') { event.preventDefault(); revert(); event.currentTarget.blur(); }
  }} />;
}
