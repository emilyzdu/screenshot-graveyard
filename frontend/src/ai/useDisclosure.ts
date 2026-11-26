import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { boundedFetch, withDeadline } from '../api/boundedFetch';
import { getDisclosure, type Disclosure, type ProviderMode } from '../api/ai';

/**
 * The server's AI processing disclosure (Batch 6A, P1-A). The panel shows its
 * text verbatim; a consent grant echoes its provider and revision, so the
 * server can refuse a grant for a disclosure that is no longer the one in force.
 */
export type DisclosureState =
  | { t: 'loading' }
  | { t: 'ready'; disclosure: Disclosure }
  | { t: 'error' }
  /** Provider and disclosure kept disagreeing (the server switched while checking). */
  | { t: 'changing' };

/** Re-reads the server's provider mode; `null` = superseded by a newer read. */
export type RefreshProvider = () => Promise<ProviderMode | 'unknown' | null>;
const RECOVER_ROUNDS = 3;

const DISCLOSURE_TIMEOUT_MS = 10_000;

export function useDisclosure(timeoutMs: number = DISCLOSURE_TIMEOUT_MS) {
  const [state, setState] = useState<DisclosureState>({ t: 'loading' });
  const ticket = useRef(0);
  const fetchNow = useCallback(async () => {
    const mine = ++ticket.current;
    let res;
    try {
      res = await withDeadline(getDisclosure(boundedFetch(timeoutMs)), timeoutMs);
    } catch {
      res = undefined;
    }
    if (mine !== ticket.current) return; // only the latest read counts
    setState(res?.ok ? { t: 'ready', disclosure: res.data } : { t: 'error' });
  }, [timeoutMs]);
  const fetchRef = useRef(fetchNow);
  useLayoutEffect(() => {
    fetchRef.current = fetchNow;
  });
  useEffect(() => {
    void fetchRef.current();
    const t = ticket;
    return () => {
      t.current += 1; // a late answer never updates an unmounted panel
    };
  }, []);
  /** Read it again (after the server said it changed, or a failed read). */
  const reload = useCallback(() => {
    setState({ t: 'loading' });
    void fetchNow();
  }, [fetchNow]);
  /**
   * Batch 6A C2: re-read the provider mode AND the disclosure together and
   * accept them only as a coherent pair (same provider). If the server switches
   * again meanwhile, re-read (bounded); if they still disagree, say so with a
   * retry instead of loading forever. Never grants anything.
   */
  const recover = useCallback(async (refreshProvider?: RefreshProvider) => {
    if (!refreshProvider) {
      reload();
      return;
    }
    const mine = ++ticket.current;
    setState({ t: 'loading' });
    for (let round = 0; round < RECOVER_ROUNDS; round++) {
      let mode: ProviderMode | 'unknown' | null;
      let res;
      try {
        // D2: both halves are bounded; a stall in either ends this round as a
        // retryable error, and the ticket check below drops any late answer.
        [mode, res] = await Promise.all([
          withDeadline(refreshProvider(), timeoutMs),
          withDeadline(getDisclosure(boundedFetch(timeoutMs)), timeoutMs),
        ]);
      } catch {
        mode = 'unknown';
        res = undefined;
      }
      if (mine !== ticket.current) return; // a newer recovery or read owns the state
      if (mode === 'unknown' || !res?.ok) {
        setState({ t: 'error' });
        return;
      }
      if (mode !== null && res.data.provider === mode) {
        setState({ t: 'ready', disclosure: res.data });
        return;
      }
      // Superseded provider read or disagreement: the server is changing. Read again.
    }
    if (mine === ticket.current) setState({ t: 'changing' });
  }, [reload, timeoutMs]);
  return { state, reload, recover };
}

/** The disclosure that may be granted against now: loaded AND for the server's current provider. */
export function grantableDisclosure(state: DisclosureState, providerMode: ProviderMode | 'unknown'): Disclosure | null {
  return state.t === 'ready' && state.disclosure.provider === providerMode ? state.disclosure : null;
}

export const DISCLOSURE_CHANGED_TEXT =
  'The AI processing disclosure changed since it was shown, so nothing was recorded. Read the current disclosure and choose again if you agree.';
