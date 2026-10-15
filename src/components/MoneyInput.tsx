import { useEffect, useRef, useState } from 'react';
import { parseMoneyToCents } from '../lib/finance';

export function MoneyInput({ value, onChange, label }: { value: number; onChange: (n: number) => void | boolean; label: string }) {
  const dirty = useRef(false);
  const [draft, setDraft] = useState((value / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, useGrouping: false }));
  useEffect(() => { dirty.current = false; setDraft((value / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, useGrouping: false })); }, [value]);
  return <input aria-label={label} inputMode="decimal" value={draft} onChange={e => { dirty.current = true; setDraft(e.target.value); }} onBlur={() => {
    if (!dirty.current) return;
    dirty.current = false;
    try { if (onChange(parseMoneyToCents(draft)) === false) setDraft((value / 100).toFixed(2).replace('.', ',')); }
    catch { setDraft((value / 100).toFixed(2).replace('.', ',')); }
  }} />;
}
