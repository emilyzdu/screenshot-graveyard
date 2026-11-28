import { useEffect, useRef, type ReactNode } from 'react';
import { backdrops, roomIllustrations } from '../illustrated/art';
import type { OverlayId } from '../model/locations';
import type { LumiActivity, LumiReaction } from '../lumi/character';
import { LumiSprite } from '../scene/LumiSprite';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
const ROOMS = new Set(['upload', 'calendar', 'notes', 'altar', 'portal', 'crypt']);

export function OverlayHost({ kind, title, label, onClose, onBack, children, expression }: {
  kind: OverlayId | 'card'; title: string; label?: string; onClose: () => void; onBack?: () => void; children: ReactNode;
  expression: LumiActivity | LumiReaction | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const backAction = useRef(onBack ?? onClose);
  backAction.current = onBack ?? onClose;
  const room = ROOMS.has(kind);
  const backdrop = kind === 'portal' || kind === 'crypt' ? backdrops[kind] : null;
  const art = kind === 'upload' || kind === 'calendar' || kind === 'notes' || kind === 'altar' ? roomIllustrations[kind] : null;

  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); backAction.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const trap = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab' || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((item) =>
      !item.closest('[hidden], details:not([open]) :not(summary)'));
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus(); }
  };

  return (
    <div className={`pw-overlay-backdrop${room ? ' pw-overlay-backdrop--room' : ''}`} data-room={kind}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      {backdrop && <img className="pw-room-backdrop" src={backdrop} alt="" />}
      <div ref={ref} className={`pw-overlay pw-overlay--${kind}${room ? ' pw-overlay--room' : ''}`} role="dialog" aria-modal="true"
        aria-label={label ?? title} data-world-overlay="" tabIndex={-1} onKeyDown={trap}>
        <div className="pw-overlay__head">
          <div className="pw-overlay__title">
            {expression && <LumiSprite expression={expression} />}
            <h2>{title}</h2>
          </div>
          <div className="pw-overlay__actions">
            {onBack && <button type="button" className="pw-overlay__close" onClick={onBack}>Back</button>}
            <button type="button" className="pw-overlay__close" onClick={onClose}>{room ? 'Return to Graveyard' : 'Close'}</button>
          </div>
        </div>
        <div className="pw-overlay__body">
          {art && <figure className="pw-room-art"><img src={art} alt="" /></figure>}
          <div className="pw-overlay__content">{children}</div>
        </div>
      </div>
    </div>
  );
}
