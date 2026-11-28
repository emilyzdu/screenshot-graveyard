import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getAnalysis, type Analysis } from '../api/ai';
import { boundedFetch } from '../api/boundedFetch';
import type { Screenshot } from '../api/client';
import { summarize, summaryKey, type AnalysisAuthority } from './sharedAnalysis';

type Validation =
  | { phase: 'loading' | 'missing' | 'error' }
  | { phase: 'ready'; analysis: Analysis };

/**
 * The assistant's read for the selected screenshot. It only starts and settles
 * a request in the workspace's shared `AnalysisAuthority`; what it shows is
 * always the authority's LATEST started read for that screenshot (which may be
 * the drawer's), so a pending, failed or invalid newer read is never masked by
 * an older success, and an older response here can never change anything.
 */
export function useValidatedAnalysis(selected: Screenshot | undefined, authority: AnalysisAuthority) {
  const id = selected?.analysis ? selected.screenshotId : undefined;
  const key = selected?.analysis ? summaryKey(selected.analysis) : '';
  const [attempt, setAttempt] = useState(0);
  // Request identity changes even when navigating A → B → A or retrying the same summary.
  const request = useMemo(() => ({ id, key, attempt }), [id, key, attempt]);
  // Whether this hook's request for the current identity has started (set in the effect).
  const started = useRef(new WeakSet<object>());
  // Re-render whenever any reader starts or settles a read.
  useSyncExternalStore(authority.subscribe, authority.version);

  useEffect(() => {
    if (request.id === undefined) return;
    const screenshotId = request.id;
    const controller = new AbortController();
    const ticket = authority.begin(screenshotId, request.key); // BEFORE the request is sent
    started.current.add(request);
    // Always settled in the authority; it is ignored there unless still the latest.
    // An aborted read (selection change, unmount) settles as failed, never as success.
    void getAnalysis(screenshotId, boundedFetch(10_000, controller.signal)).then((result) => {
      authority.resolve(screenshotId, ticket, result);
    });
    return () => controller.abort();
  }, [request, authority]);

  const entry = id === undefined ? undefined : authority.get(id);
  let validation: Validation;
  if (id === undefined || !started.current.has(request) || !entry || entry.status === 'pending') {
    validation = { phase: 'loading' };
  } else if (entry.status === 'success' && entry.analysis) {
    validation = { phase: 'ready', analysis: entry.analysis };
  } else {
    validation = { phase: entry.status === 'failed' && entry.missing ? 'missing' : 'error' };
  }
  const conflicts = validation.phase === 'ready' && summaryKey(summarize(validation.analysis)) !== key;
  return {
    validation,
    conflicts,
    retry: () => setAttempt((previous) => previous + 1),
    cardSummary: (shot: Screenshot) => {
      const known = authority.get(shot.screenshotId);
      // Only a successful LATEST read, made against the list snapshot still shown, replaces the summary.
      return shot.analysis && known?.status === 'success' && known.analysis && known.listKey === summaryKey(shot.analysis)
        ? summarize(known.analysis)
        : shot.analysis;
    },
  };
}

export type AnalysisValidation = Validation;
