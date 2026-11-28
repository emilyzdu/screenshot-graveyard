import { useCallback, useEffect, useRef, useState } from 'react';
import { getWorkspace, listScreenshots, type Screenshot } from '../../api/client';
import { buildDemoScreenshots } from './worldFixtures';

/**
 * live:     real GET /api/screenshots (read-only).
 * demo:     requested with ?demo=1; synthetic ghosts, no API calls.
 * fallback: the API was unreachable on first load; keep the world available without records.
 */
export type GalleryMode = 'live' | 'demo' | 'fallback';
export interface Gallery {
  loading: boolean;
  mode: GalleryMode;
  screenshots: Screenshot[];
  /** Last error from the real API, if any. */
  error: string | null;
  refresh: () => void;
}

export function demoRequested(search = window.location.search): boolean {
  return new URLSearchParams(search).get('demo') === '1';
}
function demoCount(search: string): number {
  const n = Number(new URLSearchParams(search).get('ghosts'));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 80) : 9;
}

export function useWorldGallery(): Gallery {
  const demo = demoRequested();
  const [state, setState] = useState<Omit<Gallery, 'refresh'>>(() =>
    demo
      ? { loading: false, mode: 'demo', screenshots: buildDemoScreenshots(demoCount(window.location.search)), error: null }
      : { loading: true, mode: 'live', screenshots: [], error: null });
  const ticket = useRef(0);
  const hasLive = useRef(false);

  const load = useCallback(async () => {
    if (demo) return;
    const mine = ++ticket.current;
    let failure: string | null = null; let list: Screenshot[] | null = null;
    const ws = await getWorkspace();
    if (!ws.ok) failure = ws.error;
    else {
      const res = await listScreenshots();
      if (res.ok) list = res.screenshots; else failure = res.error;
    }
    if (mine !== ticket.current) return; // latest read wins
    if (list) { hasLive.current = true; setState({ loading: false, mode: 'live', screenshots: list, error: null }); }
    else if (hasLive.current) setState((s) => ({ ...s, loading: false, error: failure })); // keep real data
    else setState({ loading: false, mode: 'fallback', screenshots: [], error: failure });
  }, [demo]);

  useEffect(() => {
    const tk = ticket;
    void load();
    if (demo) return;
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { tk.current++; document.removeEventListener('visibilitychange', onVisible); };
  }, [demo, load]);

  const refresh = useCallback(() => void load(), [load]);
  return { ...state, refresh };
}
