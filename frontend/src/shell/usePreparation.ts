import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApiFailure, ApiResult, Preparation, ProviderMode } from '../api/ai';
import { OPERATION_KIND_BY_ACTION, type PreparationAction } from '../api/preparationKinds';
import { boundedFetch } from '../api/boundedFetch';
import { describeLimitFailure, describeOperationOutcome } from '../ai/messages';
import { pollOperation } from '../ai/pollOperation';
import { DEFAULT_MAX_POLLS, DEFAULT_POLL_INTERVAL_MS } from '../ai/useOperationPolling';

/** Bounds for every request a draft panel makes (headers and body). */
export const DRAFT_READ_TIMEOUT_MS = 10_000;
export const DRAFT_REQUEST_TIMEOUT_MS = 15_000;

/** Whether this screenshot has a saved preparation for the action ('unknown' = the lookup failed). */
export type DraftPresence = 'present' | 'none' | 'unknown';

export type PreparationState =
  | { t: 'checking' }
  | { t: 'none' }
  | { t: 'lookup_error' }
  | { t: 'submitting' }
  | { t: 'preparing'; prep: Preparation }
  | { t: 'unresolved'; operationId: number | null }
  | { t: 'ready'; prep: Preparation }
  | { t: 'failed'; prep: Preparation }
  | { t: 'rejected'; text: string; canRetry: boolean };

type PreparationCall = (screenshotId: number, f: typeof fetch) => Promise<ApiResult<Preparation>>;

/** Errors the prepare route returns before anything is created: definitely not started. */
export function describeRejection(f: ApiFailure): { text: string; canRetry: boolean } | null {
  if (f.status === 403 && f.code === 'consent_required') {
    return { text: 'AI processing is not allowed for this screenshot. Open it and allow AI processing first. Nothing was prepared.', canRetry: true };
  }
  if (f.status === 409 && f.code === 'screenshot_archived') {
    return { text: 'This screenshot is in The Crypt. Resurrect it before preparing a draft. Nothing was prepared.', canRetry: false };
  }
  if (f.status === 409 && f.code === 'provider_not_permitted') {
    return { text: 'Preparing drafts is turned off with a real AI provider until a safety fix ships. Nothing was prepared.', canRetry: false };
  }
  if (f.status === 404) return { text: 'This screenshot could not be found in your workspace. Nothing was prepared.', canRetry: false };
  if (f.status === 429) return { text: describeLimitFailure(f, 'Nothing was prepared.') ?? 'This workspace’s AI request allowance is used up. Nothing was prepared.', canRetry: false };
  if (f.status >= 400 && f.status < 500) return { text: 'The request was not accepted. Nothing was prepared.', canRetry: false };
  if (f.status === 503 && (f.code === 'service_unavailable' || f.code === 'identity_unavailable')) {
    return { text: 'The service is temporarily unavailable. Nothing was prepared; try again shortly.', canRetry: true };
  }
  return null; // network error, timeout, other 5xx or unreadable answer: outcome unknown
}

export function describeFailure(detail: string | null): string {
  if (detail === 'Screenshot archived') {
    return 'The screenshot was archived before the draft was prepared. Nothing was saved.';
  }
  return describeOperationOutcome('failed', detail);
}

/**
 * Where a draft came from, from what the SERVER recorded (the provider in the
 * preparation's durable key and the version's origin), never the current mode.
 */
export function draftProvenance(prep: Preparation, origin: string | null) {
  // An origin the server does not record is not guessed at (Batch 5A).
  if (origin !== null && origin !== 'ai_generate' && origin !== 'ai_redo' && origin !== 'manual_edit') {
    return { badge: 'Source not recorded', tone: 'muted' as const };
  }
  const edited = origin === 'manual_edit';
  if (prep.provider === 'fake') {
    return edited
      ? { badge: 'Edited by you · started from a simulated draft', tone: 'green' as const }
      : { badge: 'Simulated draft · Fake AI', tone: 'peach' as const };
  }
  if (edited) return { badge: 'Edited by you', tone: 'green' as const };
  if (prep.provider) return { badge: 'AI-generated draft · can be wrong', tone: 'violet' as const };
  return { badge: 'Source not recorded', tone: 'muted' as const };
}

interface Options {
  screenshotId: number;
  /** This panel's action; only its own operation kind is ever accepted while polling. */
  action: PreparationAction;
  providerMode: ProviderMode | 'unknown';
  /** True when the user's CURRENT choice for this screenshot is this panel's action. */
  canStart: boolean;
  /** Start (or reuse) the preparation. Must be the server's idempotent POST. */
  request: PreparationCall;
  /** Read the newest preparation (404 when none). */
  lookupLatest: PreparationCall;
  pollIntervalMs?: number;
  maxPolls?: number;
  /** Reports, after each lookup settles, whether a saved preparation exists. */
  onPresence?: (presence: DraftPresence) => void;
}

/**
 * The shared draft-preparation state machine (extracted unchanged from the
 * Batch 4A Make Notes panel). On mount it asks the server for the latest
 * preparation, so a reloaded page reopens the same draft; it polls a running
 * one; it never re-sends a request on its own (a lost response is reconciled
 * with a read). `onPrepare` re-checks, at invocation time, that the panel is
 * still mounted, its action is still the current choice and the provider is
 * Fake, so a stale captured handler cannot submit.
 */
export function usePreparation({
  screenshotId: id,
  action,
  providerMode,
  canStart,
  request,
  lookupLatest,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPolls = DEFAULT_MAX_POLLS,
  onPresence,
}: Options) {
  const [state, setState] = useState<PreparationState>({ t: 'checking' });
  const presenceRef = useRef(onPresence);
  useLayoutEffect(() => {
    presenceRef.current = onPresence;
  });
  useEffect(() => {
    if (state.t === 'checking') return;
    presenceRef.current?.(state.t === 'none' ? 'none' : state.t === 'lookup_error' ? 'unknown' : 'present');
  }, [state.t]);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef(new AbortController());
  // What may start a preparation RIGHT NOW. Read at invocation time, so a
  // handler captured in an earlier render (or by an unmounted panel) cannot
  // submit after the action changed. Synced before paint, like choiceAuthority.
  // Batch 6A: a confirmed provider (Fake or real) may start; an unconfirmed one never.
  const available = providerMode === 'fake' || providerMode === 'openai';
  const startAuthority = useRef({ canStart, available });
  useLayoutEffect(() => {
    startAuthority.current = { canStart, available };
  }, [canStart, available]);

  /** Apply a preparation the server reported, polling if it is still running. */
  const apply = useCallback(
    async (prep: Preparation) => {
      const signal = abortRef.current.signal;
      if (prep.status !== 'pending') {
        if (prep.artifactId !== null) setState({ t: 'ready', prep });
        else setState({ t: 'failed', prep });
        return;
      }
      setState({ t: 'preparing', prep });
      const outcome = await pollOperation(prep.operationId, {
        intervalMs: pollIntervalMs,
        maxPolls,
        signal,
        requestTimeoutMs: DRAFT_READ_TIMEOUT_MS,
        expectKind: OPERATION_KIND_BY_ACTION[action],
      });
      if (signal.aborted || outcome.kind === 'cancelled') return;
      if (outcome.kind === 'done') {
        const done = { ...prep, status: outcome.status, artifactId: outcome.artifactId, errorDetail: outcome.errorDetail };
        setState(done.artifactId !== null ? { t: 'ready', prep: done } : { t: 'failed', prep: done });
      } else {
        // Timed out or status unavailable: may still finish. Keep the id; check on request.
        setState({ t: 'unresolved', operationId: prep.operationId });
      }
    },
    [action, maxPolls, pollIntervalMs],
  );

  /** Ask the server for this screenshot's latest preparation. Read-only. */
  const lookup = useCallback(async () => {
    const signal = abortRef.current.signal;
    setState({ t: 'checking' });
    const res = await lookupLatest(id, boundedFetch(DRAFT_READ_TIMEOUT_MS, signal));
    if (signal.aborted) return;
    if (res.ok) await apply(res.data);
    else if (res.status === 404 && res.code === 'no_preparation') setState({ t: 'none' });
    else setState({ t: 'lookup_error' });
  }, [apply, id, lookupLatest]);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    void lookup();
    return () => controller.abort();
  }, [lookup]);

  const guarded = async (fn: () => Promise<void>) => {
    if (busyRef.current) return; // duplicate-click guard (the server is idempotent too)
    const signal = abortRef.current.signal;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };

  /** True only while mounted, this action is the current choice and the provider is Fake. */
  const mayStart = () =>
    !abortRef.current.signal.aborted && startAuthority.current.canStart && startAuthority.current.available;
  const onPrepare = () => {
    if (!mayStart()) return Promise.resolve(); // stale handler: the action or screenshot changed
    return guarded(async () => {
      const signal = abortRef.current.signal;
      setState({ t: 'submitting' });
      const res = await request(id, boundedFetch(DRAFT_REQUEST_TIMEOUT_MS, signal));
      if (signal.aborted) return;
      if (res.ok) {
        await apply(res.data);
        return;
      }
      const rejected = describeRejection(res);
      if (rejected) {
        setState({ t: 'rejected', ...rejected });
        return;
      }
      // No usable answer: the server may have accepted it. Never re-send; ask instead.
      setState({ t: 'unresolved', operationId: null });
      await lookup();
    });
  };

  /** This panel's lifetime signal (aborted on unmount). Capture it BEFORE awaiting. */
  const signal = () => abortRef.current.signal;
  /** A bounded read tied to this panel's lifetime. */
  const read = () => boundedFetch(DRAFT_READ_TIMEOUT_MS, abortRef.current.signal);

  return { state, busy, fake: providerMode === 'fake', available, lookup, onPrepare, read, signal };
}
