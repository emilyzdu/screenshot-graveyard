import { useCallback, useEffect, useRef, useState } from 'react';
import { getConsent, type ApiResult } from '../api/ai';
import { boundedFetch } from '../api/boundedFetch';

/**
 * checking: a read is in flight (or none has finished yet)
 * granted / not_granted: the server answered 200 with granted true / false
 * lookup_failed: the read itself failed, so consent is unknown (not "revoked")
 */
export type ConsentLookup = 'checking' | 'granted' | 'not_granted' | 'lookup_failed';

/**
 * Screenshots whose consent withdrawal was requested but not confirmed by the
 * server (request in flight, failed, or answer lost). Module-level so the block
 * survives closing and reopening the drawer. While an id is here, a cached or
 * freshly read `granted: true` is NOT treated as authorization for new AI work:
 * the user asked to stop. It is cleared only by a server answer that consent is
 * off, or by a new, explicit grant from the user.
 */
const unconfirmedWithdrawals = new Set<number>();

export function markWithdrawalUnconfirmed(id: number): void {
  unconfirmedWithdrawals.add(id);
}
export function clearWithdrawal(id: number): void {
  unconfirmedWithdrawals.delete(id);
}
export function isWithdrawalUnconfirmed(id: number): boolean {
  return unconfirmedWithdrawals.has(id);
}
/** Test helper: forget every recorded withdrawal. */
export function resetConsentWithdrawals(): void {
  unconfirmedWithdrawals.clear();
}

/**
 * Read-only consent lookups for a set of screenshots. Each screenshot has a
 * monotonically increasing request sequence, so a response that is not the
 * newest request is dropped and cannot overwrite newer state. Re-reads on
 * `refreshToken` change, window focus and tab visibility. Never grants consent.
 */
const TIMED_OUT: ApiResult<boolean> = { ok: false, status: 0, code: 'timeout', message: 'Request timed out' };
const FAILED: ApiResult<boolean> = { ok: false, status: 0, code: 'network', message: 'Network request failed' };

/**
 * One consent read with a deadline around the WHOLE read, not only the network
 * transport: it settles at `timeoutMs` (or when `outer` aborts) even if
 * `getConsent` itself never settles. The transport it is given is aborted at
 * the same moment, so the request and its body read are cancelled too. The
 * timer and the outer-signal listener are always removed.
 */
function readWithin(id: number, timeoutMs: number, outer?: AbortSignal): Promise<ApiResult<boolean>> {
  const controller = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ApiResult<boolean>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
      controller.abort(); // no-op once the read has finished; cancels it otherwise
      resolve(result);
    };
    const onOuterAbort = () => finish(FAILED);
    const timer = setTimeout(() => finish(TIMED_OUT), timeoutMs);
    if (outer?.aborted) {
      finish(FAILED);
      return;
    }
    outer?.addEventListener('abort', onOuterAbort, { once: true });
    getConsent(id, boundedFetch(timeoutMs, controller.signal)).then(finish, () => finish(FAILED));
  });
}

export function useConsent(
  ids: number[],
  refreshToken: number = 0,
  /**
   * timeoutMs: bound every consent read (headers AND body) and cancel reads in
   * flight when the component unmounts. A read that times out reports
   * `lookup_failed`, never a consent value. Omitted: unbounded reads (classic UI).
   */
  opts: { timeoutMs?: number } = {},
) {
  const [status, setStatus] = useState<Record<number, ConsentLookup>>({});
  const seqRef = useRef<Record<number, number>>({});
  const aliveRef = useRef(true);
  const timeoutRef = useRef(opts.timeoutMs);
  timeoutRef.current = opts.timeoutMs;
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    aliveRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    return () => {
      aliveRef.current = false;
      controller.abort();
    };
  }, []);

  /** Re-read consent. Resolves with this request's own answer; state only takes it if still newest. */
  const refresh = useCallback(async (target: number[]): Promise<Record<number, ConsentLookup>> => {
    const mine: Record<number, number> = {};
    for (const id of target) {
      mine[id] = (seqRef.current[id] ?? 0) + 1;
      seqRef.current[id] = mine[id];
    }
    if (aliveRef.current) {
      // Show "checking" only on first load; a re-read keeps the last known answer until the new one arrives.
      setStatus((cur) => {
        const firstLoad = target.filter((id) => cur[id] === undefined);
        if (firstLoad.length === 0) return cur;
        return { ...cur, ...Object.fromEntries(firstLoad.map((id) => [id, 'checking' as const])) };
      });
    }
    const entries = await Promise.all(
      target.map(async (id) => {
        const timeoutMs = timeoutRef.current;
        const res =
          timeoutMs === undefined
            ? await getConsent(id)
            : await readWithin(id, timeoutMs, abortRef.current?.signal);
        const next: ConsentLookup = res.ok ? (res.data ? 'granted' : 'not_granted') : 'lookup_failed';
        if (aliveRef.current && seqRef.current[id] === mine[id]) {
          setStatus((cur) => ({ ...cur, [id]: next }));
        }
        return [id, next] as const;
      }),
    );
    return Object.fromEntries(entries);
  }, []);

  /** Set a known state (for example after a 403 or a grant) and invalidate reads in flight. */
  const set = useCallback((id: number, value: ConsentLookup) => {
    seqRef.current[id] = (seqRef.current[id] ?? 0) + 1;
    if (aliveRef.current) setStatus((cur) => ({ ...cur, [id]: value }));
  }, []);

  const key = ids.join(',');
  useEffect(() => {
    if (key === '') return;
    const list = key.split(',').map(Number);
    void refresh(list);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh(list);
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, refreshToken, refresh]);

  return { status, refresh, set };
}
