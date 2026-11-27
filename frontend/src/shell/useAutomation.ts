import { useCallback, useEffect, useRef, useState } from 'react';
import { getAutomation, setAutomation, type ApiResult } from '../api/ai';
import { boundedFetch } from '../api/boundedFetch';

/** Same bound as the other workspace reads. */
export const AUTOMATION_TIMEOUT_MS = 10_000;

export type AutomationState =
  | { t: 'loading' }
  | { t: 'ready'; enabled: boolean; saving: boolean; error: string | null }
  | { t: 'error' };

/** Any thrown error is an unconfirmed answer: automation then counts as off. */
async function settle<T>(run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await run();
  } catch {
    return { ok: false, status: 0, code: 'network', message: 'Network request failed' };
  }
}

/**
 * Batch 6B: the workspace's opt-in "prepare automatically" preference, read
 * from and written to the server. Unknown (loading/error) counts as OFF
 * everywhere: nothing automatic happens unless the server confirmed it is on.
 * Latest call wins; a late answer never overwrites a newer one. It is read only
 * once `workspaceReady` is true: before that a first-time visitor has no
 * workspace cookie yet, so the server could not answer for this workspace.
 */
export function useAutomation(workspaceReady = true) {
  const [state, setState] = useState<AutomationState>({ t: 'loading' });
  const ticket = useRef(0);
  const load = useCallback(async () => {
    const mine = ++ticket.current;
    const r = await settle(() => getAutomation(boundedFetch(AUTOMATION_TIMEOUT_MS)));
    if (mine !== ticket.current) return;
    setState(r.ok ? { t: 'ready', enabled: r.data, saving: false, error: null } : { t: 'error' });
  }, []);
  useEffect(() => {
    if (!workspaceReady) return;
    void load();
    const t = ticket;
    return () => {
      t.current += 1;
    };
  }, [load, workspaceReady]);
  const set = useCallback(async (enabled: boolean) => {
    const mine = ++ticket.current;
    setState((s) => (s.t === 'ready' ? { ...s, saving: true, error: null } : s));
    const r = await settle(() => setAutomation(enabled, boundedFetch(AUTOMATION_TIMEOUT_MS)));
    if (mine !== ticket.current) return;
    if (r.ok) {
      setState({ t: 'ready', enabled: r.data, saving: false, error: null });
      return;
    }
    // Unconfirmed: read the server's value instead of assuming either way.
    const now = await settle(() => getAutomation(boundedFetch(AUTOMATION_TIMEOUT_MS)));
    if (mine !== ticket.current) return;
    setState(
      now.ok
        ? { t: 'ready', enabled: now.data, saving: false, error: 'The change could not be confirmed. This is the saved setting.' }
        : { t: 'error' },
    );
  }, []);
  const enabled = state.t === 'ready' && state.enabled;
  return { state, enabled, set, reload: load };
}
