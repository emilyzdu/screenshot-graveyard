import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  getMakeNotesPreparation,
  getStudyNote,
  requestMakeNotesDraft,
  type ApiFailure,
  type Preparation,
  type ProviderMode,
  type StudyNoteVersion,
} from '../api/ai';
import { boundedFetch } from '../api/boundedFetch';
import type { Screenshot } from '../api/client';
import { describeOperationOutcome } from '../ai/messages';
import { pollOperation } from '../ai/pollOperation';
import { DEFAULT_MAX_POLLS, DEFAULT_POLL_INTERVAL_MS } from '../ai/useOperationPolling';
import { Icon } from '../ui/Icon';
import { Badge, Button } from '../ui/primitives';

/** Bounds for every request this panel makes (headers and body). */
export const DRAFT_READ_TIMEOUT_MS = 10_000;
export const DRAFT_REQUEST_TIMEOUT_MS = 15_000;

type State =
  | { t: 'checking' }
  | { t: 'none' }
  | { t: 'lookup_error' }
  | { t: 'submitting' }
  | { t: 'preparing'; prep: Preparation }
  | { t: 'unresolved'; operationId: number | null }
  | { t: 'ready'; prep: Preparation }
  | { t: 'failed'; prep: Preparation }
  | { t: 'rejected'; text: string; canRetry: boolean };

type DraftView = { t: 'closed' } | { t: 'loading' } | { t: 'error' } | { t: 'open'; note: StudyNoteVersion };

/** Errors the prepare route returns before anything is created: definitely not started. */
function describeRejection(f: ApiFailure): { text: string; canRetry: boolean } | null {
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
  if (f.status === 429) return { text: 'This workspace’s AI request allowance is used up. Nothing was prepared.', canRetry: false };
  if (f.status >= 400 && f.status < 500) return { text: 'The request was not accepted. Nothing was prepared.', canRetry: false };
  if (f.status === 503 && (f.code === 'service_unavailable' || f.code === 'identity_unavailable')) {
    return { text: 'The service is temporarily unavailable. Nothing was prepared; try again shortly.', canRetry: true };
  }
  return null; // network error, timeout, other 5xx or unreadable answer: outcome unknown
}

function describeFailure(detail: string | null): string {
  if (detail === 'Screenshot archived') {
    return 'The screenshot was archived before the draft was prepared. Nothing was saved.';
  }
  return describeOperationOutcome('failed', detail);
}

/** Where the draft came from, from what the SERVER recorded (not the current provider mode). */
function provenance(prep: Preparation, note: StudyNoteVersion | null) {
  const edited = note?.origin === 'manual_edit';
  if (prep.provider === 'fake') {
    return edited
      ? { badge: 'Edited by you · started from a simulated draft', tone: 'green' as const }
      : { badge: 'Simulated draft · Fake AI', tone: 'peach' as const };
  }
  if (edited) return { badge: 'Edited by you', tone: 'green' as const };
  if (prep.provider) return { badge: 'AI-generated draft · can be wrong', tone: 'violet' as const };
  return { badge: 'Source not recorded', tone: 'muted' as const };
}

interface Props {
  screenshot: Screenshot;
  providerMode: ProviderMode | 'unknown';
  /** True when the user's current choice for this screenshot is Make Notes. */
  canStart: boolean;
  pollIntervalMs?: number;
  maxPolls?: number;
}

/**
 * Make Notes draft for ONE screenshot (Batch 4A): explicit Prepare, honest
 * progress, and a read-only view of the persisted draft. On every open it asks
 * the server for this screenshot's latest preparation, so a reloaded page
 * reopens the same draft. The server is idempotent per screenshot, so repeated
 * clicks cannot create a second draft; this panel never retries a request on
 * its own. Stops at "Draft ready": nothing is approved, exported or delivered.
 */
export function MakeNotesDraft({
  screenshot,
  providerMode,
  canStart,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPolls = DEFAULT_MAX_POLLS,
}: Props) {
  const id = screenshot.screenshotId;
  const [state, setState] = useState<State>({ t: 'checking' });
  const [view, setView] = useState<DraftView>({ t: 'closed' });
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef(new AbortController());
  // What may start a preparation RIGHT NOW. Read at invocation time, so a
  // handler captured in an earlier render (or by an unmounted panel) cannot
  // submit after the action changed. Synced before paint, like choiceAuthority.
  const startAuthority = useRef({ canStart, fake: providerMode === 'fake' });
  useLayoutEffect(() => {
    startAuthority.current = { canStart, fake: providerMode === 'fake' };
  }, [canStart, providerMode]);
  const read = () => boundedFetch(DRAFT_READ_TIMEOUT_MS, abortRef.current.signal);

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
    [maxPolls, pollIntervalMs],
  );

  /** Ask the server for this screenshot's latest preparation. Read-only. */
  const lookup = useCallback(async () => {
    const signal = abortRef.current.signal;
    setState({ t: 'checking' });
    const res = await getMakeNotesPreparation(id, boundedFetch(DRAFT_READ_TIMEOUT_MS, signal));
    if (signal.aborted) return;
    if (res.ok) await apply(res.data);
    else if (res.status === 404) setState({ t: 'none' });
    else setState({ t: 'lookup_error' });
  }, [apply, id]);

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

  /** True only while this panel is mounted, Make Notes is the current choice and the provider is Fake. */
  const mayStart = () =>
    !abortRef.current.signal.aborted && startAuthority.current.canStart && startAuthority.current.fake;
  const onPrepare = () => {
    if (!mayStart()) return Promise.resolve(); // stale handler: the action or screenshot changed
    return guarded(async () => {
      const signal = abortRef.current.signal;
      setState({ t: 'submitting' });
      const res = await requestMakeNotesDraft(id, boundedFetch(DRAFT_REQUEST_TIMEOUT_MS, signal));
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

  const onOpenDraft = async (artifactId: number) => {
    const signal = abortRef.current.signal;
    setView({ t: 'loading' });
    const res = await getStudyNote(artifactId, undefined, read());
    if (signal.aborted) return;
    // Only show a draft that belongs to this screenshot.
    if (res.ok && res.data.artifactId === artifactId && res.data.sourceScreenshotIds.includes(id)) {
      setView({ t: 'open', note: res.data });
    } else {
      setView({ t: 'error' });
    }
  };

  const fake = providerMode === 'fake';

  if (state.t === 'checking') {
    return <p className="sg-muted" role="status">Checking for a Make Notes draft…</p>;
  }
  if (state.t === 'none' && !canStart) return null;

  return (
    <div className="sg-draft" role="region" aria-label="Make Notes draft">
      {state.t === 'none' && (
        <div className="sg-next__ready">
          <p>
            <Icon name="check" size={15} /> <b>Ready to prepare.</b> Turn it into study notes.
          </p>
          <Button size="sm" variant="primary" disabled={busy || !fake} onClick={() => void onPrepare()}>
            Prepare draft
          </Button>
          <p className="sg-muted">
            {fake
              ? 'Creates a simulated notes draft with the Fake AI and saves it to your workspace. Nothing is approved, exported or sent to another app.'
              : providerMode === 'openai'
                ? 'Preparing drafts is turned off with a real AI provider until a safety fix ships.'
                : 'The AI provider could not be confirmed, so preparing is unavailable.'}
          </p>
        </div>
      )}

      {state.t === 'lookup_error' && (
        <div className="sg-uncertain" role="status">
          <p>Could not check whether a Make Notes draft exists for this screenshot.</p>
          <Button size="sm" disabled={busy} onClick={() => void lookup()}>Check again</Button>
        </div>
      )}

      {(state.t === 'submitting' || state.t === 'preparing') && (
        <p role="status" className="sg-draft__status">
          <Icon name="loader" size={15} />{' '}
          {state.t === 'submitting' ? 'Sending the Prepare request…' : 'Preparing a simulated notes draft on the server…'}
        </p>
      )}

      {state.t === 'unresolved' && (
        <div className="sg-uncertain" role="status">
          <p>
            {state.operationId !== null
              ? 'Preparing is taking longer than expected, or its status could not be read. It may still finish.'
              : 'We could not confirm whether the Prepare request reached the server.'}{' '}
            Nothing new will be started from here until you check.
          </p>
          <Button size="sm" disabled={busy} onClick={() => void lookup()}>Check status</Button>
        </div>
      )}

      {state.t === 'rejected' && (
        <div className="sg-revive__row" role="alert">
          <span>{state.text}</span>
          {state.canRetry && canStart && (
            <Button size="sm" disabled={busy || !fake} onClick={() => void onPrepare()}>Try again</Button>
          )}
        </div>
      )}

      {state.t === 'failed' && (
        <div className="sg-revive__row" role="alert">
          <span>Preparation failed. {describeFailure(state.prep.errorDetail)}</span>
          {canStart ? (
            <Button size="sm" disabled={busy || !fake} onClick={() => void onPrepare()}>Retry preparation</Button>
          ) : (
            <span className="sg-muted">Choose Make Notes to try again.</span>
          )}
        </div>
      )}

      {state.t === 'ready' && (
        <div className="sg-draft__ready" role="status">
          <p>
            <Badge tone="green">Draft ready</Badge>{' '}
            <Badge tone={provenance(state.prep, view.t === 'open' ? view.note : null).tone}>
              {provenance(state.prep, view.t === 'open' ? view.note : null).badge}
            </Badge>
          </p>
          <p className="sg-muted">
            Saved in your workspace as draft #{state.prep.artifactId}. Not approved, not exported and not sent anywhere.
            {state.prep.status === 'uncertain' && ' Parts of it are marked uncertain.'}
          </p>
          {view.t === 'open' ? (
            <Button size="sm" onClick={() => setView({ t: 'closed' })}>Hide draft</Button>
          ) : (
            <Button size="sm" disabled={view.t === 'loading'} onClick={() => void onOpenDraft(state.prep.artifactId!)}>
              {view.t === 'loading' ? 'Opening…' : 'Open draft'}
            </Button>
          )}
          {view.t === 'error' && <p role="alert">The draft could not be loaded. Try opening it again.</p>}
          {view.t === 'open' && <DraftBody note={view.note} prep={state.prep} screenshotId={id} />}
        </div>
      )}
    </div>
  );
}

function Section({ title, items, code = false }: { title: string; items: string[]; code?: boolean }) {
  if (items.length === 0) return null;
  return (
    <>
      <dt>{title}</dt>
      <dd>
        {code ? (
          items.map((c, i) => <pre key={i} className="sg-draft__code">{c}</pre>)
        ) : (
          <ul>{items.map((c, i) => <li key={i}>{c}</li>)}</ul>
        )}
      </dd>
    </>
  );
}

function DraftBody({ note, prep, screenshotId }: { note: StudyNoteVersion; prep: Preparation; screenshotId: number }) {
  const c = note.content;
  const origin =
    note.origin === 'manual_edit' ? 'edited by you' : note.origin === 'ai_redo' ? 'regenerated by AI' : 'generated by AI';
  return (
    <article className="sg-draft__body" aria-label={`Notes draft: ${c.topic}`}>
      {prep.provider === 'fake' && note.origin !== 'manual_edit' && (
        <p className="sg-draft__simulated" role="note">
          Simulated draft: the Fake AI wrote placeholder text without reading your screenshot. None of this was
          extracted from the image.
        </p>
      )}
      <h4>{c.topic}</h4>
      <dl className="sg-facts">
        <Section title="Main concepts" items={c.main_concepts} />
        <Section title="Code" items={c.extracted_code} code />
        <Section title="Code explanations" items={c.code_explanations} />
        <Section title="Pitfalls" items={c.pitfalls} />
        <Section title="Uncertain" items={c.uncertain_content} />
        <dt>Source</dt>
        <dd>
          Screenshot #{screenshotId}
          {note.sourceScreenshotIds.length > 1 && ` and ${note.sourceScreenshotIds.length - 1} more`}
        </dd>
        <dt>Version</dt>
        <dd>
          Version {note.versionNumber}, {origin}
          {prep.provider === 'fake' && note.origin !== 'manual_edit' ? ' (Fake AI, simulated)' : ''}.
        </dd>
      </dl>
      <p className="sg-muted">Editing, review and approval come in a later version; the classic workspace can edit study notes.</p>
    </article>
  );
}
