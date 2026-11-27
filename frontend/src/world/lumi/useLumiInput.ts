import { useEffect, useRef } from 'react';
import type { LumiInput } from './lumiController';

const KEYS: Record<string, 'l' | 'r' | 'u' | 'd'> = {
  ArrowLeft: 'l', a: 'l', A: 'l', ArrowRight: 'r', d: 'r', D: 'r',
  ArrowUp: 'u', w: 'u', W: 'u', ArrowDown: 'd', s: 'd', S: 'd',
};

/** True when a key event should be left alone (typing, or inside a dialog). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return true;
  return t.closest('[role="dialog"], [data-world-overlay]') !== null;
}

/** Tracks held movement keys. `read()` is cheap and safe to call every frame. */
export function useLumiInput(opts: { enabled: boolean; onInteract: () => void }) {
  const held = useRef(new Set<'l' | 'r' | 'u' | 'd'>());
  const interact = useRef(opts.onInteract); interact.current = opts.onInteract;
  const { enabled } = opts;
  useEffect(() => {
    const h = held.current; h.clear();
    if (!enabled) return;
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const k = KEYS[e.key];
      if (k) { h.add(k); e.preventDefault(); return; }
      if ((e.key === 'e' || e.key === 'E') && !e.repeat) interact.current();
    };
    const up = (e: KeyboardEvent) => { const k = KEYS[e.key]; if (k) h.delete(k); };
    const clear = () => h.clear();
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clear); h.clear(); };
  }, [enabled]);
  return {
    read: (): LumiInput => ({ dx: (held.current.has('r') ? 1 : 0) - (held.current.has('l') ? 1 : 0), dy: (held.current.has('d') ? 1 : 0) - (held.current.has('u') ? 1 : 0) }),
  };
}
