import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AUTO_IN_PROGRESS,
  getAutoProcess,
  requestEventDraft,
  requestMakeNotesDraft,
  startAutoProcess,
  type ApiFailure,
  type AutoProcessState,
  type ProviderMode,
  type SuggestedAction,
} from '../api/ai';
import type { Screenshot } from '../api/client';
import { boundedFetch } from '../api/boundedFetch';
import { Icon } from '../ui/Icon';
import { Badge, Button } from '../ui/primitives';
import { LIVE_ACTIONS } from './nextAction';
import { describeLimitFailure } from '../ai/messages';

export const AUTO_READ_TIMEOUT_MS = 10_000;
export const AUTO_START_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLLS = 120;

type View =
  | { t: 'loading' }
  | { t: 'ready'; s: AutoProcessState }
  | { t: 'error' };

interface Props {
  screenshot: Screenshot;
  providerMode: ProviderMode | 'unknown';
  /** Increments when the user has just granted consent in this drawer: continue automatically. */
  startSignal: number;
  /** Every confirmed state, so the workspace can show the decision in the assistant. */
  onState: (s: AutoProcessState) => void;
  /** Work finished (or stopped) on the server: re-sync the gallery and the panels. */
  onSettled: () => void;
  /** Show this screenshot's draft and next step in the assistant. */
  onReview: (screenshotId: number) => void;
  pollIntervalMs?: number;
  maxPolls?: number;
}

const PREPARING: Record<SuggestedAction, string> = {
  add_calendar: 'Preparing your calendar event…',
  make_notes: 'Preparing your study notes…',
};

function providerBadge(provider: string | null | undefined) {
  if (provider === 'openai') return <Badge tone="violet">Real AI · OpenAI</Badge>;
  if (provider === 'fake') return <Badge tone="peach">Fake AI · simulated</Badge>;
  return null;
}

function startFailureText(f: ApiFailure): string {
  switch (f.code) {
    case 'consent_required': return 'Allow AI processing for this screenshot first. Nothing was sent.';
    case 'automation_off': return 'Automatic processing is turned off for this workspace. Nothing was started.';
    case 'screenshot_archived': return 'Resurrect this screenshot before processing it. Nothing was started.';
    case 'quota_exceeded': return 'This workspace has reached its AI limit. Nothing was started.';
    case 'ai_budget_reached':
    case 'rate_limited':
      return describeLimitFailure(f, 'Nothing was started.') ?? 'This workspace has reached its AI limit. Nothing was started.';
    default: return `The request did not go through (${f.message}). Nothing new was started.`;
  }
}

/**
 * Batch 6B: the AI-first flow for one screenshot in the Gothic drawer.
 *
 * Opening it only READS the server's derived state; it never starts or repeats
 * paid work by itself. Work starts only from an explicit signal: consent just
 * granted (with automation on) or a button the user presses. Polling is bounded
 * and stops when the drawer closes. A lost or timed-out start is reconciled by a
 * read, never by sending the request again.
 */
export function AutoPilot({
  screenshot,
  providerMode,
  startSignal,
  onState,
  onSettled,
  onReview,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPolls = DEFAULT_MAX_POLLS,
}: Props) {
  const id = screenshot.screenshotId;
  const [view, setView] = useState<View>({ t: 'loading' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [stalled, setStalled] = useState(false);
  const ticket = useRef(0);
  const polls = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const controller = useRef<AbortController | null>(null);
  const wasInProgress = useRef(false);
  const callbacks = useRef({ onState, onSettled });
  useEffect(() => {
    callbacks.current = { onState, onSettled };
  });

  const apply = useCallback((s: AutoProcessState) => {
    setView({ t: 'ready', s });
    callbacks.current.onState(s);
    const inProgress = AUTO_IN_PROGRESS.has(s.stage);
    if (wasInProgress.current && !inProgress) callbacks.current.onSettled();
    wasInProgress.current = inProgress;
    return inProgress;
  }, []);

  const read = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current);
    const mine = ++ticket.current;
    const signal = controller.current?.signal;
    const r = await getAutoProcess(id, boundedFetch(AUTO_READ_TIMEOUT_MS, signal));
    if (mine !== ticket.current || signal?.aborted) return;
    if (!r.ok) {
      setView((v) => (v.t === 'ready' ? v : { t: 'error' }));
      setStalled(true);
      return;
    }
    const inProgress = apply(r.data);
    if (!inProgress) {
      polls.current = 0;
      setStalled(false);
      return;
    }
    if (polls.current >= maxPolls) {
      setStalled(true); // bounded: the user checks again explicitly
      return;
    }
    polls.current += 1;
    timer.current = setTimeout(() => void read(), pollIntervalMs);
  }, [id, apply, maxPolls, pollIntervalMs]);

  const watch = useCallback(() => {
    polls.current = 0;
    setStalled(false);
    void read();
  }, [read]);

  useEffect(() => {
    controller.current = new AbortController();
    void read();
    const t = ticket;
    return () => {
      t.current += 1;
      clearTimeout(timer.current);
      controller.current?.abort();
    };
  }, [read]);

  const start = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const signal = controller.current?.signal;
    const r = await startAutoProcess(id, boundedFetch(AUTO_START_TIMEOUT_MS, signal));
    if (signal?.aborted) return;
    setBusy(false);
    if (r.ok) {
      ++ticket.current; // this answer is newer than any read in flight
      if (apply(r.data)) watch();
      return;
    }
    if (r.status === 0) {
      setMessage({ error: true, text: 'We could not confirm whether the request reached the server. Checking its status; nothing will be sent again from here.' });
      watch();
      return;
    }
    setMessage({ error: true, text: startFailureText(r) });
    watch();
  }, [busy, id, apply, watch]);

  const prepare = useCallback(async (action: SuggestedAction) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const signal = controller.current?.signal;
    const f = boundedFetch(AUTO_START_TIMEOUT_MS, signal);
    const r = action === 'add_calendar' ? await requestEventDraft(id, f) : await requestMakeNotesDraft(id, f);
    if (signal?.aborted) return;
    setBusy(false);
    if (!r.ok && r.status !== 0) setMessage({ error: true, text: startFailureText(r) });
    if (!r.ok && r.status === 0) {
      setMessage({ error: true, text: 'We could not confirm whether the request reached the server. Checking its status; nothing will be sent again from here.' });
    }
    wasInProgress.current = true;
    watch();
  }, [busy, id, watch]);

  // Consent was just granted in this drawer: continue without another click.
  const lastSignal = useRef(startSignal);
  useEffect(() => {
    if (startSignal === lastSignal.current) return;
    lastSignal.current = startSignal;
    void start();
  }, [startSignal, start]);

  if (screenshot.state !== 'active') return null;
  const s = view.t === 'ready' ? view.s : null;
  const real = providerMode === 'openai';

  return (
    <section className="sg-auto" aria-labelledby={`sg-auto-h-${id}`} data-testid="auto-pilot">
      <div className="sg-revive__head">
        <h3 id={`sg-auto-h-${id}`}>Automatic preparation</h3>
        {providerBadge(s?.preparation?.provider ?? s?.analysis?.provider ?? (real ? 'openai' : providerMode === 'fake' ? 'fake' : null))}
      </div>
      {view.t === 'loading' && <p role="status" className="sg-muted">Checking this screenshot&apos;s progress…</p>}
      {view.t === 'error' && (
        <div className="sg-revive__row" role="status">
          <span>Its progress could not be loaded. Nothing was started.</span>
          <Button size="sm" onClick={watch}>Check again</Button>
        </div>
      )}
      {s && <Progress s={s} />}
      {s && <StageBody s={s} busy={busy} onStart={() => void start()} onPrepare={(a) => void prepare(a)} onReview={() => onReview(id)} />}
      {stalled && s && AUTO_IN_PROGRESS.has(s.stage) && (
        <div className="sg-uncertain" role="status">
          <p>This is taking longer than expected. It may still finish; nothing new is started while you wait.</p>
          <Button size="sm" onClick={watch}>Check again</Button>
        </div>
      )}
      {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </section>
  );
}

type StepView = 'done' | 'current' | 'todo' | 'skipped';

function Progress({ s }: { s: AutoProcessState }) {
  const order = ['understand', 'choose', 'prepare', 'review'] as const;
  const at: Record<string, number> = {
    awaiting_consent: -1, not_started: -1, analyzing: 0, analysis_failed: 0, routing: 1,
    ready_to_prepare: 1, recommended: 1, needs_choice: 1, reference: 1,
    preparing: 2, preparation_failed: 2, ready_for_review: 3, archived: -1,
  };
  const current = at[s.stage] ?? -1;
  if (current < 0) return null;
  const labels = { understand: 'Understand', choose: 'Choose a step', prepare: 'Prepare draft', review: 'Your review' };
  const state = (i: number): StepView => {
    if (s.stage === 'reference' && i >= 2) return 'skipped';
    if (i < current || (i === current && s.stage === 'ready_for_review')) return i === 3 ? 'current' : 'done';
    return i === current ? 'current' : 'todo';
  };
  return (
    <ol className="ui-stepper sg-auto__steps" aria-label="Automatic preparation progress">
      {order.map((k, i) => {
        const st = state(i);
        return (
          <li key={k} className={`ui-stepper__step ui-stepper__step--${st === 'skipped' ? 'todo' : st}`} aria-current={st === 'current' ? 'step' : undefined}>
            <span className="ui-stepper__dot" aria-hidden="true">
              {st === 'done' && <Icon name="check" size={12} strokeWidth={3} />}
            </span>
            <span>{labels[k]}{st === 'skipped' ? ' (not needed)' : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}

function StageBody({
  s,
  busy,
  onStart,
  onPrepare,
  onReview,
}: {
  s: AutoProcessState;
  busy: boolean;
  onStart: () => void;
  onPrepare: (a: SuggestedAction) => void;
  onReview: () => void;
}) {
  const route = s.route;
  const prep = s.preparation;
  // Provenance is what the server recorded, never inferred from the router.
  const trigger = prep?.trigger ?? null;
  const auto = trigger === 'auto';
  const reason = route && <p className="sg-muted">{route.reason}</p>;
  switch (s.stage) {
    case 'awaiting_consent':
      return (
        <p className="sg-muted" role="status">
          Allow AI processing above. It is then understood, a next step is chosen and a draft is prepared, without
          more clicks. Nothing is approved or sent anywhere.
        </p>
      );
    case 'not_started':
      return (
        <div className="sg-revive__row">
          <span>Consent is in place. Nothing has been analyzed yet.</span>
          <Button size="sm" variant="primary" icon="sparkles" disabled={busy} onClick={onStart}>Continue automatically</Button>
        </div>
      );
    case 'analyzing':
      return <p role="status">Understanding screenshot…</p>;
    case 'routing':
      return <p role="status">Choosing the best next step…</p>;
    case 'preparing':
      return (
        <>
          <p role="status">{prep?.action ? PREPARING[prep.action] : 'Preparing your draft…'}</p>
          {reason}
        </>
      );
    case 'ready_for_review':
      return (
        <div className="sg-next__ready" role="status">
          <p>
            <Icon name="check" size={15} /> <b>Ready for your review.</b>{' '}
            {prep?.action && LIVE_ACTIONS[prep.action].label}{' '}
            {trigger === 'auto' && <Badge tone="violet">Chosen automatically · can be wrong</Badge>}
            {trigger === 'manual' && <Badge tone="green">Chosen by you</Badge>}
            {trigger === null && <Badge tone="muted">Draft prepared</Badge>}
          </p>
          {auto && reason}
          <p className="sg-muted">Nothing is approved or sent until you approve a version yourself.</p>
          <Button size="sm" variant="primary" icon="expand" onClick={onReview}>Review draft</Button>
        </div>
      );
    case 'ready_to_prepare':
    case 'recommended':
      return (
        <div role="status">
          <p>
            {s.stage === 'recommended' ? 'Recommended' : 'Next step'}: <b>{route?.action ? LIVE_ACTIONS[route.action].label : ''}</b>
          </p>
          {reason}
          <div className="sg-revive__row">
            {route?.action && (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => onPrepare(route.action as SuggestedAction)}>
                Prepare {LIVE_ACTIONS[route.action].label}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onReview}>Choose something else</Button>
          </div>
        </div>
      );
    case 'reference':
      return (
        <div role="status">
          <p><b>Kept as a reference.</b> No draft was prepared.</p>
          {reason}
          <Button size="sm" variant="ghost" onClick={onReview}>Choose a step anyway</Button>
        </div>
      );
    case 'needs_choice':
      return (
        <div role="status">
          <p><b>Your choice.</b> No step was chosen automatically.</p>
          {reason}
          <Button size="sm" variant="ghost" onClick={onReview}>Choose a next step</Button>
        </div>
      );
    case 'analysis_failed':
      return (
        <div className="sg-uncertain" role="status">
          <p>
            {s.analysis?.status === 'uncertain'
              ? 'The AI could not tell what this screenshot shows. Nothing was saved.'
              : `The analysis did not finish (${s.analysis?.errorDetail ?? 'unknown error'}). Nothing was saved. If it timed out, the provider may still have processed it.`}{' '}
            Nothing is retried automatically. Trying again sends the screenshot again.
          </p>
          <Button size="sm" disabled={busy} onClick={onStart}>Try again</Button>
        </div>
      );
    case 'preparation_failed':
      return (
        <div className="sg-uncertain" role="status">
          <p>
            The {prep?.action ? LIVE_ACTIONS[prep.action].label : ''} draft did not finish ({prep?.errorDetail ?? 'unknown error'}).
            Nothing was saved. Nothing is retried automatically; trying again sends the screenshot again.
          </p>
          {prep?.action && (
            <Button size="sm" disabled={busy} onClick={() => onPrepare(prep.action as SuggestedAction)}>Try preparing again</Button>
          )}
          <Button size="sm" variant="ghost" onClick={onReview}>Choose something else</Button>
        </div>
      );
    default:
      return null;
  }
}
