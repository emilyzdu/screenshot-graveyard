import { useCallback, useEffect, useRef, useState } from 'react';
import {
  classifyScreenshot,
  getAnalysis,
  setConsent,
  type Analysis,
  type ApiFailure,
  type OperationStatus,
  type ProviderMode,
} from '../api/ai';
import { isAIAnalysisOrigin } from '../api/analysisOrigin';
import { boundedFetch } from '../api/boundedFetch';
import type { Screenshot } from '../api/client';
import { describeEpitaphAuxiliaryOrigin, describeOperationOutcome, describeOrigin, describeRequestFailure } from '../ai/messages';
import { pollOperation } from '../ai/pollOperation';
import {
  acquireRevive,
  getReviveEntry,
  getReviveSuccess,
  recordReviveSuccess,
  markReviveActive,
  markReviveOutcomeUnknown,
  markReviveUnresolved,
  releaseRevive,
  REVIVE_SUCCEEDED_TEXT,
  reviveWaitText,
} from '../ai/reviveCoordinator';
import { clearWithdrawal, isWithdrawalUnconfirmed, markWithdrawalUnconfirmed, useConsent } from '../ai/useConsent';
import { DEFAULT_MAX_POLLS, DEFAULT_POLL_INTERVAL_MS } from '../ai/useOperationPolling';
import { summaryKey, type AnalysisAuthority } from './sharedAnalysis';
import { Badge, Button } from '../ui/primitives';

/** Upper bound for the classify POST before its outcome is treated as unknown. */
export const CLASSIFY_TIMEOUT_MS = 15_000;
/** Upper bound for each read (analysis, operation status). */
export const READ_TIMEOUT_MS = 10_000;

type AnalysisState =
  | { phase: 'loading' }
  | { phase: 'none' }
  | { phase: 'ready'; analysis: Analysis }
  | { phase: 'error' };

/**
 * idle        nothing running from this panel
 * submitting  classify POST in flight (no operation id yet)
 * polling     accepted; watching GET /api/operations/{id}
 * done        the operation reached a terminal status
 * unresolved  we stopped without a terminal answer. With an operation id the
 *             status can be re-checked; without one (lost classify response) we
 *             cannot know whether the server accepted the request
 * checking    a "Check status" read is in flight
 */
type Run =
  | { t: 'idle' }
  | { t: 'submitting' }
  | { t: 'polling'; opId: number }
  | { t: 'done'; status: Exclude<OperationStatus, 'pending'>; errorDetail: string | null }
  | { t: 'unresolved'; opId: number | null; why: 'timeout' | 'unavailable' | 'unknown' }
  | { t: 'checking'; opId: number | null };

type Message = { error: boolean; text: string } | null;

/**
 * Set once the server confirms a Revive finished successfully (or a persisted
 * analysis proves it). From then on this panel never offers Revive again;
 * loading the result is tracked separately and can only be retried as a read.
 */
type Confirmed = { opId: number | null; result: 'loading' | 'loaded' | 'failed' };

/** pending: withdrawal POST in flight. unconfirmed: it failed or its answer was lost. */
type Withdrawal = 'pending' | 'unconfirmed' | null;

/** Errors the classify route returns BEFORE any operation is created (definite: nothing started). */
function classifyDefinitelyNotStarted(f: ApiFailure): boolean {
  if (f.status >= 400 && f.status < 500) return true;
  return f.status === 503 && (f.code === 'service_unavailable' || f.code === 'identity_unavailable');
}

interface Props {
  screenshot: Screenshot;
  providerMode: ProviderMode | 'unknown';
  providerLoading: boolean;
  /** Called after the server reports a new persisted analysis, so the gallery can re-sync. */
  onAnalysisChanged: () => void;
  /**
   * The workspace's shared analysis authority. Every validated GET /analysis
   * this panel makes is published to it (ticket taken before the request), so
   * the cards and the assistant never keep a suggestion from an older read.
   */
  analysisAuthority?: Pick<AnalysisAuthority, 'begin' | 'resolve'>;
  pollIntervalMs?: number;
  maxPolls?: number;
}

/**
 * Consent + Revive + classification result for one screenshot in the Gothic
 * drawer. Opening it only READS (consent, analysis, operation status). Nothing is
 * processed until the user grants consent and presses Revive. Revive is only
 * offered while the server reports the Fake AI provider (Batch 3A).
 */
export function RevivePanel({
  screenshot,
  providerMode,
  providerLoading,
  onAnalysisChanged,
  analysisAuthority,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPolls = DEFAULT_MAX_POLLS,
}: Props) {
  const id = screenshot.screenshotId;
  const archived = screenshot.state === 'archived';
  // Consent reads are bounded and cancelled when this panel unmounts.
  const { status: consentMap, set: setConsentLookup, refresh: refreshConsent } = useConsent([id], 0, {
    timeoutMs: READ_TIMEOUT_MS,
  });
  const consent = consentMap[id] ?? 'checking';
  const [analysis, setAnalysis] = useState<AnalysisState>({ phase: 'loading' });
  const [run, setRun] = useState<Run>({ t: 'idle' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // A success confirmed earlier (in a previous mount of this drawer) is known
  // from the first render, before any result read answers.
  const [initialConfirmed] = useState<Confirmed | null>(() => {
    const known = getReviveSuccess(id);
    return known ? { opId: known.operationId, result: 'loading' } : null;
  });
  const [confirmed, setConfirmedState] = useState<Confirmed | null>(initialConfirmed);
  const confirmedRef = useRef<Confirmed | null>(initialConfirmed);
  const setConfirmed = (next: Confirmed | null) => {
    confirmedRef.current = next;
    setConfirmedState(next);
  };
  const [withdrawal, setWithdrawal] = useState<Withdrawal>(() => (isWithdrawalUnconfirmed(id) ? 'unconfirmed' : null));

  // Per-mount lifetime. Each mount gets its own AbortController; an async step
  // captures that mount's signal and applies results only while it is not
  // aborted, so a continuation from an earlier mount (React StrictMode, or a
  // closed and reopened drawer) can never update a later one. Aborting also
  // stops polling and pending reads. A classify POST is never aborted on
  // unmount (that would not cancel the server's work); its continuation only
  // records the operation id in the shared registry.
  const abortRef = useRef<AbortController>(new AbortController());
  const captureAlive = () => {
    const signal = abortRef.current.signal;
    return () => !signal.aborted;
  };
  const runSeq = useRef(0);
  const watchingRef = useRef(false);
  const changedRef = useRef(onAnalysisChanged);
  useEffect(() => {
    changedRef.current = onAnalysisChanged;
  });

  const read = useCallback(() => boundedFetch(READ_TIMEOUT_MS, abortRef.current.signal), []);
  // Latest props for the publish path, without making the read callbacks (and
  // the mount effect that depends on them) change on every gallery refresh.
  const publishRef = useRef({ authority: analysisAuthority, listKey: '' });
  publishRef.current = {
    authority: analysisAuthority,
    listKey: screenshot.analysis ? summaryKey(screenshot.analysis) : '',
  };

  /** Read the persisted analysis. Returns what the server said, applied only while mounted. */
  const loadAnalysis = useCallback(async (): Promise<AnalysisState> => {
    const signal = abortRef.current.signal;
    const { authority, listKey } = publishRef.current;
    // Starting this read makes it the latest for the screenshot at once: an
    // earlier success stops authorizing suggestions while it is pending.
    const ticket = authority?.begin(id, listKey);
    const res = await getAnalysis(id, read());
    // Every outcome is settled (success, failure, abort, wrong id), even if this
    // panel has since closed; the authority ignores it unless still the latest.
    if (authority && ticket !== undefined) authority.resolve(id, ticket, res);
    const valid = res.ok && res.data.screenshotId === id; // never show another screenshot's analysis
    const next: AnalysisState = valid
      ? { phase: 'ready', analysis: res.data }
      : !res.ok && res.status === 404
        ? { phase: 'none' }
        : { phase: 'error' };
    if (!signal.aborted) setAnalysis(next);
    return next;
  }, [id, read]);

  /**
   * Read the persisted result of a confirmed-successful Revive. GET only: it
   * never sends classify. Any non-200 (including a 404 that contradicts the
   * confirmed success) leaves "Retry loading result" as the only action.
   */
  const loadResult = useCallback(
    async (opId: number | null) => {
      const signal = abortRef.current.signal;
      const next = await loadAnalysis();
      if (signal.aborted) return;
      setConfirmed({ opId, result: next.phase === 'ready' ? 'loaded' : 'failed' });
    },
    [loadAnalysis],
  );

  /** Bounded polling of a known operation. Stops quietly on unmount and keeps the id for later. */
  const watch = useCallback(
    async (opId: number) => {
      const signal = abortRef.current.signal;
      const alive = () => !signal.aborted;
      const mine = (runSeq.current += 1);
      markReviveActive(id, opId);
      watchingRef.current = true;
      setRun({ t: 'polling', opId });
      const outcome = await pollOperation(opId, {
        intervalMs: pollIntervalMs,
        maxPolls,
        signal,
        requestTimeoutMs: READ_TIMEOUT_MS,
        isCancelled: () => runSeq.current !== mine,
      });
      // Unmounted: cleanup already returned the entry to `unresolved` with its id.
      if (!alive()) return;
      watchingRef.current = false;
      if (outcome.kind === 'cancelled') return;
      if (outcome.kind === 'done') {
        releaseRevive(id);
        setRun({ t: 'done', status: outcome.status, errorDetail: outcome.errorDetail });
        if (outcome.status === 'successful') {
          // Confirmed in the same step as the terminal status: no window in which
          // a pending or failed result read could make Revive eligible again.
          // Recorded in the shared coordinator so it outlives this panel.
          recordReviveSuccess(id, opId);
          setConfirmed({ opId, result: 'loading' });
          await loadResult(opId);
          if (alive()) changedRef.current();
        }
      } else if (outcome.kind === 'not_found') {
        releaseRevive(id);
        setRun({ t: 'idle' });
        setMessage({ error: true, text: 'The server has no record of that Revive. Nothing is assumed; you can Revive again.' });
      } else {
        markReviveUnresolved(id);
        setRun({ t: 'unresolved', opId, why: outcome.kind });
      }
    },
    [id, loadResult, maxPolls, pollIntervalMs],
  );

  // Open: read the current analysis (consent is read by useConsent). If an
  // earlier Revive for this screenshot was left unresolved (drawer closed, poll
  // timed out, lost response), pick it up instead of offering a new one.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    const known = getReviveSuccess(id);
    if (known) {
      // Success is already confirmed: only the saved result is fetched. A 404 or
      // failure here leaves "Retry loading result"; it never re-enables Revive.
      void loadResult(known.operationId);
    } else {
      void loadAnalysis();
    }
    const entry = known ? undefined : getReviveEntry(id);
    if (entry?.phase === 'unresolved') {
      if (entry.operationId !== null) void watch(entry.operationId);
      else setRun({ t: 'unresolved', opId: null, why: 'unknown' });
    } else if (entry) {
      // An earlier request from a closed panel is still being sent or checked.
      setRun({ t: 'unresolved', opId: entry.operationId, why: 'unavailable' });
    }
    return () => {
      controller.abort();
      // Synchronously hand a watched operation back to the registry, id kept,
      // so a remount (or StrictMode's second mount) can resume watching it.
      if (watchingRef.current) {
        watchingRef.current = false;
        markReviveUnresolved(id);
      }
    };
  }, [id, loadAnalysis, loadResult, watch]);

  // The server says consent is off: the withdrawal is done (or was never needed).
  useEffect(() => {
    if (withdrawal === 'unconfirmed' && consent === 'not_granted') {
      clearWithdrawal(id);
      setWithdrawal(null);
    }
  }, [withdrawal, consent, id]);

  const guarded = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    const alive = captureAlive();
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      if (alive()) setBusy(false);
    }
  };

  const recordConsent = (granted: boolean, declined: boolean) =>
    guarded(async () => {
      const alive = captureAlive();
      setMessage(null);
      if (!granted) {
        // From the moment the user asks to stop, consent is unverified: a cached
        // or later-read `granted: true` no longer authorizes new AI work.
        markWithdrawalUnconfirmed(id);
        setWithdrawal('pending');
        setConsentLookup(id, 'checking');
      }
      const res = await setConsent(id, granted, read());
      // Registry updates happen even if the drawer closed meanwhile.
      if (res.ok && res.data === granted) clearWithdrawal(id);
      if (!alive()) return;
      if (res.ok && res.data !== granted) {
        // The server answered with the opposite of what was asked: do not trust it either way.
        setWithdrawal(isWithdrawalUnconfirmed(id) ? 'unconfirmed' : null);
        setMessage({ error: true, text: 'The server did not confirm that change. Nothing is assumed.' });
        void refreshConsent([id]);
        return;
      }
      if (res.ok) {
        setWithdrawal(null);
        setConsentLookup(id, res.data ? 'granted' : 'not_granted');
        setMessage({
          error: false,
          text: res.data
            ? 'AI consent granted for this screenshot. It stays in place until you withdraw it; closing this panel does not withdraw it.'
            : declined
              ? 'You declined AI processing. Nothing will be analyzed. Storing, archiving and restoring still work.'
              : 'AI consent withdrawn. Future AI use is blocked. Withdrawing cannot stop an analysis that already started.',
        });
        return;
      }
      if (!granted) setWithdrawal('unconfirmed');
      setMessage({ error: true, text: describeRequestFailure(res) });
      // The answer may have been lost after the server saved it: show the server's view.
      void refreshConsent([id]);
    });

  /** Re-read consent. Clears an unconfirmed withdrawal only if the server says consent is off. */
  const onCheckConsent = () =>
    guarded(async () => {
      const alive = captureAlive();
      setMessage(null);
      const answer = await refreshConsent([id]);
      if (!alive()) return;
      if (answer[id] === 'lookup_failed') {
        setMessage({
          error: true,
          text: 'Consent could not be checked (the request failed or timed out). Revive stays blocked; you can check again or retry the withdrawal.',
        });
      }
    });

  const onRevive = () =>
    guarded(async () => {
      // Checked at click time, not only through the rendered disabled state.
      if (confirmedRef.current !== null || getReviveSuccess(id) || isWithdrawalUnconfirmed(id)) return;
      const alive = captureAlive();
      setMessage(null);
      const lock = await acquireRevive(id);
      if (!alive()) {
        if (lock.ok) releaseRevive(id);
        return;
      }
      if (!lock.ok) {
        if (lock.reason === 'succeeded') {
          // Confirmed elsewhere (e.g. by reconciliation): enter the confirmed
          // state; only the saved result is read, with "Retry loading result".
          setMessage({ error: false, text: REVIVE_SUCCEEDED_TEXT });
          setConfirmed({ opId: lock.operationId, result: 'loading' });
          await loadResult(lock.operationId);
          return;
        }
        setMessage({ error: true, text: reviveWaitText(lock.reason) });
        return;
      }
      setRun({ t: 'submitting' });
      // Not tied to unmount: aborting would not cancel the server's work.
      const res = await classifyScreenshot(id, boundedFetch(CLASSIFY_TIMEOUT_MS));
      if (res.ok) {
        if (!alive()) {
          markReviveActive(id, res.data.operationId);
          markReviveUnresolved(id); // nobody is polling; keep the id for the next open
          return;
        }
        void watch(res.data.operationId);
        return;
      }
      if (classifyDefinitelyNotStarted(res)) {
        releaseRevive(id);
        if (!alive()) return;
        if (res.status === 403) setConsentLookup(id, 'not_granted');
        setRun({ t: 'idle' });
        setMessage({ error: true, text: describeRequestFailure(res) });
        return;
      }
      // No usable answer: the server may have accepted it. Block a second submission.
      markReviveOutcomeUnknown(id);
      if (!alive()) return;
      setRun({ t: 'unresolved', opId: null, why: 'unknown' });
      await checkUnknown();
    });

  /** For a lost classify response: only a persisted analysis proves it ran. */
  const checkUnknown = async () => {
    const alive = captureAlive();
    setRun({ t: 'checking', opId: null });
    const next = await loadAnalysis();
    if (!alive()) return;
    if (next.phase === 'ready') {
      releaseRevive(id);
      recordReviveSuccess(id, null);
      setConfirmed({ opId: null, result: 'loaded' });
      setRun({ t: 'done', status: 'successful', errorDetail: null });
      changedRef.current();
      return;
    }
    setRun({ t: 'unresolved', opId: null, why: 'unknown' });
  };

  const onCheckStatus = () =>
    guarded(async () => {
      if (run.t !== 'unresolved') return;
      // Prefer the registry: a request from a closed panel may have recorded its id since.
      const entry = getReviveEntry(id);
      if (entry?.phase === 'submitting' || entry?.phase === 'active' || entry?.phase === 'reconciling') {
        setMessage({ error: false, text: reviveWaitText('in_flight') });
        return;
      }
      const opId = entry?.operationId ?? run.opId;
      if (opId !== null) {
        await watch(opId);
        return;
      }
      await checkUnknown();
    });

  /** Read-only retry for the saved result of a confirmed Revive. Never classifies. */
  const onRetryResult = () =>
    guarded(async () => {
      const current = confirmedRef.current;
      if (current === null || current.result === 'loaded') return;
      setConfirmed({ ...current, result: 'loading' });
      await loadResult(current.opId);
    });

  const ready = analysis.phase === 'ready' ? analysis.analysis : null;
  const working = run.t === 'submitting' || run.t === 'polling' || run.t === 'checking';
  const unresolved = run.t === 'unresolved' || run.t === 'checking';
  const fake = providerMode === 'fake';
  const consentBlocked = withdrawal !== null || isWithdrawalUnconfirmed(id);
  const canRevive =
    fake &&
    !archived &&
    consent === 'granted' &&
    !consentBlocked &&
    confirmed === null &&
    getReviveSuccess(id) === undefined &&
    analysis.phase === 'none' &&
    !busy &&
    !working &&
    !unresolved;

  return (
    <section className="sg-revive" aria-labelledby="sg-revive-h">
      <div className="sg-revive__head">
        <h3 id="sg-revive-h">Revive</h3>
        {fake && <Badge tone="peach">Fake AI · development</Badge>}
      </div>

      <div className="sg-revive__privacy" role="note" aria-label="AI processing">
        {providerMode === 'fake' && (
          <p>
            This development build uses the Fake AI adapter. Nothing is sent to an external AI provider, and the
            result is placeholder text that does not read your screenshot.
          </p>
        )}
        {providerMode === 'openai' && (
          <p>
            A real AI provider is configured on the server. Revive is turned off in this build until the
            consent-dispatch safety fix is in place.
          </p>
        )}
        {providerMode === 'unknown' && (
          <p>{providerLoading ? 'Checking the AI provider…' : 'The AI provider could not be confirmed, so Revive is unavailable.'}</p>
        )}
        <p className="sg-muted">
          AI processing needs your explicit consent for this screenshot. Withdrawing consent stops future AI use; it
          cannot stop an analysis that already started.
        </p>
      </div>

      <div className="sg-revive__consent">
        {withdrawal === 'pending' && <p role="status">Withdrawing consent… Revive is blocked.</p>}
        {withdrawal === 'unconfirmed' && (
          <div className="sg-uncertain" role="status">
            <p>
              {consent === 'granted'
                ? 'Your consent withdrawal could not be confirmed, and the server still has consent recorded. Revive stays blocked: withdraw again, or allow AI processing if you want to keep using it.'
                : consent === 'checking'
                  ? 'Your consent withdrawal could not be confirmed. Checking with the server… Revive is blocked.'
                  : 'Your consent withdrawal could not be confirmed. Revive is blocked until this is resolved.'}
            </p>
            <div className="sg-revive__row">
              <Button size="sm" disabled={busy} onClick={() => void recordConsent(false, false)}>
                Retry withdrawal
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onCheckConsent()}>
                Check consent
              </Button>
              {consent === 'granted' && (
                <Button size="sm" variant="ghost" disabled={busy || providerMode !== 'fake'} onClick={() => void recordConsent(true, false)}>
                  Allow AI processing
                </Button>
              )}
            </div>
          </div>
        )}
        {withdrawal === null && (
          <p role="status">
            {consent === 'checking' && 'Checking consent…'}
            {consent === 'granted' && 'Consent: granted for this screenshot.'}
            {consent === 'not_granted' && 'Consent: not granted. Nothing will be analyzed.'}
            {consent === 'lookup_failed' && 'Consent could not be read. The server still requires it before any analysis.'}
          </p>
        )}
        {withdrawal !== null ? null : consent === 'granted' ? (
          <Button size="sm" disabled={busy} onClick={() => void recordConsent(false, false)}>
            Withdraw consent
          </Button>
        ) : (
          <div className="sg-revive__row">
            <Button
              size="sm"
              disabled={busy || consent === 'checking' || providerMode !== 'fake'}
              onClick={() => void recordConsent(true, false)}
            >
              Allow AI processing
            </Button>
            <Button size="sm" variant="ghost" disabled={busy || consent === 'checking'} onClick={() => void recordConsent(false, true)}>
              Decline
            </Button>
          </div>
        )}
      </div>

      {analysis.phase === 'none' && !archived && confirmed === null && (
        <div className="sg-revive__row">
          <Button variant="primary" icon="sparkles" disabled={!canRevive} aria-busy={working} onClick={() => void onRevive()}>
            {run.t === 'submitting' ? 'Starting…' : run.t === 'polling' ? 'Reviving…' : 'Revive with Fake AI'}
          </Button>
          {consent !== 'granted' && fake && <span className="sg-muted">Allow AI processing first.</span>}
        </div>
      )}
      {analysis.phase === 'none' && archived && confirmed === null && (
        <p className="sg-muted">Resurrect this screenshot to Revive it.</p>
      )}
      {analysis.phase === 'loading' && <p className="sg-muted">Loading the current analysis…</p>}
      {analysis.phase === 'error' && confirmed === null && (
        <div className="sg-revive__row">
          <p role="alert">The current analysis could not be loaded.</p>
          <Button size="sm" onClick={() => void loadAnalysis()}>Try again</Button>
        </div>
      )}

      {(run.t === 'submitting' || run.t === 'polling') && (
        <p role="status">{run.t === 'submitting' ? 'Sending the Revive request…' : 'Revive is running on the server…'}</p>
      )}
      {run.t === 'done' && run.status !== 'successful' && (
        <p role="alert">{describeOperationOutcome(run.status, run.errorDetail)}</p>
      )}
      {confirmed?.result === 'loading' && (
        <p role="status">Revive finished on the server. Loading the result…</p>
      )}
      {confirmed?.result === 'failed' && (
        <div className="sg-uncertain" role="status">
          <p>
            Revive finished on the server, but the result could not be loaded. Nothing new will be started; retrying
            only reads the saved result.
          </p>
          <Button size="sm" disabled={busy} onClick={() => void onRetryResult()}>
            Retry loading result
          </Button>
        </div>
      )}
      {unresolved && (
        <div className="sg-uncertain" role="status">
          <p>
            {run.t === 'checking'
              ? 'Checking whether Revive completed…'
              : run.opId !== null
                ? run.why === 'timeout'
                  ? 'Revive is taking longer than expected. It may still finish.'
                  : 'Revive status is temporarily unavailable. The analysis may still be running or may have finished.'
                : 'We could not confirm whether the Revive request reached the server. Nothing new will be started from here until a result appears. If nothing appears, reloading the page lets you try again, which may start a second analysis if the first one did arrive.'}
          </p>
          <Button size="sm" disabled={run.t === 'checking' || busy} onClick={() => void onCheckStatus()}>
            Check status
          </Button>
        </div>
      )}
      {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}

      {ready && (
        <div className="sg-result" aria-label="Classification result">
          <div className="sg-result__head">
            <span className="sg-result__category">{ready.classification.category}</span>
            {ready.classification.uncertain && <Badge tone="muted">Uncertain</Badge>}
            {fake && isAIAnalysisOrigin(ready.classification.origin) && isAIAnalysisOrigin(ready.epitaph.origin) &&
              <Badge tone="peach">Simulated result</Badge>}
          </div>
          <dl className="sg-facts">
            <dt>Confidence</dt>
            <dd>
              {/* A number is shown ONLY when it is a real model-reported value: a
                  confirmed real provider and an AI-chosen category. A manual
                  category edit keeps the old number, which is not the model's
                  confidence in the user's category. */}
              {ready.classification.origin === 'manual_edit'
                ? 'Not shown: this category was edited by you, so there is no model confidence for it.'
                : !isAIAnalysisOrigin(ready.classification.origin)
                  ? 'Not shown: the category source could not be confirmed.'
                  : providerMode === 'openai'
                    ? `${Math.round(ready.classification.confidence * 100)}% as reported by the model (not a calibrated probability)`
                    : fake
                      ? 'Not meaningful: the Fake AI returns a fixed placeholder value.'
                      : 'Not shown: the AI provider could not be confirmed.'}
            </dd>
            <dt>Epitaph</dt>
            <dd>{ready.epitaph.text}</dd>
            <dt>Visible facts</dt>
            <dd>
              {ready.epitaph.visibleFacts || 'None recorded.'}
              {ready.epitaph.visibleFacts && <small className="sg-muted"> ({describeEpitaphAuxiliaryOrigin(ready.epitaph.origin, providerMode)})</small>}
            </dd>
            {ready.epitaph.inferredIntent !== null && (
              <>
                <dt>Guessed purpose</dt>
                <dd>
                  {ready.epitaph.inferredIntent}
                  <small className="sg-muted"> ({describeEpitaphAuxiliaryOrigin(ready.epitaph.origin, providerMode)})</small>
                </dd>
              </>
            )}
            <dt>Source</dt>
            <dd>
              Category {describeOrigin(ready.classification.origin, providerMode)} (version{' '}
              {ready.classification.versionNumber}). Epitaph {describeOrigin(ready.epitaph.origin, providerMode)} (version{' '}
              {ready.epitaph.versionNumber}).
            </dd>
          </dl>
        </div>
      )}
    </section>
  );
}
