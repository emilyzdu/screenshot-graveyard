import { useEffect, useState } from 'react';

export function useReducedMotion(): boolean {
  const q = '(prefers-reduced-motion: reduce)';
  const get = () => typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
  const [reduced, setReduced] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(q); const on = () => setReduced(m.matches);
    m.addEventListener?.('change', on); return () => m.removeEventListener?.('change', on);
  }, []);
  return reduced;
}
