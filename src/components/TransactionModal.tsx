import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface TransactionModalProps {
  children: ReactNode;
  onClose: () => void;
  label?: string;
  suspended?: boolean;
  returnFocusTo?: HTMLElement | null;
}

function visibleControls(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )).filter(element => element.tabIndex >= 0
    && !element.closest('[inert], [aria-hidden="true"]')
    && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden');
}

export function TransactionModal({
  children, onClose, label = 'New transaction', suspended = false, returnFocusTo,
}: TransactionModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(returnFocusTo
    ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const close = useRef(onClose);
  const inactive = useRef(suspended);
  close.current = onClose;
  inactive.current = suspended;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      const target = previousFocus.current;
      requestAnimationFrame(() => {
        if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
      });
    };
  }, []);

  useEffect(() => {
    if (suspended) return;
    const frame = requestAnimationFrame(() => {
      const currentPanel = panel.current;
      if (!currentPanel || inactive.current || currentPanel.contains(document.activeElement)) return;
      const controls = visibleControls(currentPanel);
      const remembered = lastFocused.current;
      const preferred = currentPanel.querySelector<HTMLElement>('[data-autofocus]');
      const firstField = controls.find(element => element.matches('input, select, textarea, [role="combobox"]'));
      const target = remembered && controls.includes(remembered) ? remembered
        : preferred && controls.includes(preferred) ? preferred
          : firstField ?? controls[0] ?? currentPanel;
      target.focus({ preventScroll: true });
    });

    function keys(event: KeyboardEvent) {
      if (inactive.current || (event.target instanceof Element && event.target.closest('.category-popup'))) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      const controls = visibleControls(panel.current);
      if (!controls.length) {
        event.preventDefault();
        panel.current.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!panel.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', keys);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keys);
    };
  }, [suspended]);

  return <div className="modal-backdrop" inert={suspended || undefined} aria-hidden={suspended || undefined} onClick={() => { if (!inactive.current) close.current(); }}>
    <div ref={panel} className="modal panel" role="dialog" aria-modal={!suspended} aria-label={label} tabIndex={-1} onClick={event => event.stopPropagation()} onFocusCapture={event => {
      if (panel.current?.contains(event.target) && event.target instanceof HTMLElement) lastFocused.current = event.target;
    }}>
      <div className="panel-header"><h2>{label}</h2><button type="button" className="icon-button" aria-label="Close" onClick={() => { if (!inactive.current) close.current(); }}><X size={20} /></button></div>
      {children}
    </div>
  </div>;
}
