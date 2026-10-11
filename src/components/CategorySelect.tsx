import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';

interface CategorySelectProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  label: string;
  filter?: boolean;
}

const searchKey = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR');

/** Search text only narrows the catalog. Values are committed by choosing an option. */
export function CategorySelect({ value, options, onChange, label, filter = false }: CategorySelectProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number }>({ left: 0, top: 0, width: 240, maxHeight: 300 });
  const choices = [
    ...(filter ? [{ value: '', label: 'All categories' }, { value: '__empty', label: 'Uncategorized' }] : [{ value: '', label: 'Uncategorized' }]),
    ...options.map(name => ({ value: filter ? `category:${name}` : name, label: name })),
  ];
  const visible = choices.filter(option => searchKey(option.label).includes(searchKey(query.trim())));
  const display = choices.find(option => option.value === value)?.label || value || 'Uncategorized';

  function close(restoreFocus = false) {
    setOpen(false); setQuery('');
    if (restoreFocus) trigger.current?.focus();
  }
  function choose(index: number) {
    const option = visible[index];
    if (!option) return;
    onChange(option.value); close(true);
  }
  function show() { setQuery(''); setActive(Math.max(0, choices.findIndex(option => option.value === value))); setOpen(true); }
  function navigate(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setActive(current => Math.max(0, Math.min(visible.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Enter') { event.preventDefault(); choose(active); }
    else if (event.key === 'Tab') close(true);
  }

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const box = trigger.current?.getBoundingClientRect();
      if (!box) return;
      const width = Math.min(Math.max(box.width, 240), window.innerWidth - 24);
      const below = window.innerHeight - box.bottom - 12;
      const above = box.top - 12;
      const upwards = below < 240 && above > below;
      const maxHeight = Math.min(340, Math.max(140, upwards ? above - 6 : below - 6));
      setPosition({ left: Math.max(12, Math.min(box.left, window.innerWidth - width - 12)), ...(upwards ? { bottom: window.innerHeight - box.top + 6 } : { top: box.bottom + 6 }), width, maxHeight });
    }
    place(); search.current?.focus();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!trigger.current?.contains(node) && !popup.current?.contains(node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { popup.current?.querySelector(`[data-option-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active, open, query]);

  return <div className="category-select">
    <button ref={trigger} type="button" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} className={`category-trigger ${!value ? 'unassigned' : ''}`} title={display} onClick={() => open ? close() : show()} onKeyDown={event => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); if (!open) show(); }
    }}><span>{display}</span><ChevronDown size={14} /></button>
    {open && createPortal(<div ref={popup} className="category-popup" style={position} onKeyDown={navigate}>
      <div className="category-popup-search"><Search size={16} /><input ref={search} aria-label="Search categories" aria-controls={`${id}-list`} aria-activedescendant={visible[active] ? `${id}-option-${active}` : undefined} autoComplete="off" placeholder="Search categories…" value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} /></div>
      <div id={`${id}-list`} role="listbox" aria-label={label} className="category-options">
        {visible.map((option, index) => <button type="button" tabIndex={-1} role="option" id={`${id}-option-${index}`} aria-selected={option.value === value} data-option-index={index} key={option.value} className={`category-option ${active === index ? 'highlighted' : ''}`} onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}><span>{option.label}</span>{option.value === value && <Check size={14} />}</button>)}
        {!visible.length && <p className="category-no-options">No categories found.</p>}
      </div>
      <small className="category-popup-hint">Choose a category from the list.</small>
    </div>, document.body)}
  </div>;
}
