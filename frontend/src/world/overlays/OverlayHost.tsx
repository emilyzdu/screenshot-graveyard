import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * One overlay at a time. Escape closes it (unless a child already handled the
 * key), Tab stays inside, and the caller returns focus to the opener on close.
 * `data-world-overlay` makes Lumi's key handler ignore everything in here.
 */
export function OverlayHost({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;

  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0]; const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="pw-overlay-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`pw-overlay${wide ? ' pw-overlay--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}
        data-world-overlay="" tabIndex={-1} onKeyDown={trap}>
        <div className="pw-overlay__head">
          <h2>{title}</h2>
          <button type="button" className="pw-overlay__close" onClick={onClose}>Close</button>
        </div>
        <div className="pw-overlay__body">{children}</div>
      </div>
    </div>
  );
}

export function PrototypeTag({ children = 'Prototype' }: { children?: ReactNode }) {
  return <span className="pw-proto">{children}</span>;
}
