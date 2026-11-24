import { useState } from 'react';
import {
  getMakeNotesPreparation,
  getStudyNote,
  requestMakeNotesDraft,
  type Preparation,
  type ProviderMode,
  type StudyNoteVersion,
} from '../api/ai';
import type { Screenshot } from '../api/client';
import { DEFAULT_MAX_POLLS, DEFAULT_POLL_INTERVAL_MS } from '../ai/useOperationPolling';
import { Icon } from '../ui/Icon';
import { Badge, Button } from '../ui/primitives';
import { describeFailure, draftProvenance, usePreparation, type DraftPresence } from './usePreparation';

type DraftView = { t: 'closed' } | { t: 'loading' } | { t: 'error' } | { t: 'open'; note: StudyNoteVersion };

interface Props {
  screenshot: Screenshot;
  providerMode: ProviderMode | 'unknown';
  /** True when the user's current choice for this screenshot is Make Notes. */
  canStart: boolean;
  pollIntervalMs?: number;
  maxPolls?: number;
  /**
   * Read-only view (an archived screenshot): never offers Prepare, Retry or
   * Try again, and can never submit, whatever the current choice.
   */
  readOnly?: boolean;
  onPresence?: (presence: DraftPresence) => void;
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
  canStart: chosen,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPolls = DEFAULT_MAX_POLLS,
  readOnly = false,
  onPresence,
}: Props) {
  const canStart = chosen && !readOnly;
  const id = screenshot.screenshotId;
  const { state, busy, fake, lookup, onPrepare, read, signal } = usePreparation({
    screenshotId: id,
    action: 'make_notes',
    providerMode,
    canStart,
    request: requestMakeNotesDraft,
    lookupLatest: getMakeNotesPreparation,
    pollIntervalMs,
    maxPolls,
    onPresence,
  });
  const [view, setView] = useState<DraftView>({ t: 'closed' });

  const onOpenDraft = async (artifactId: number) => {
    const lifetime = signal();
    setView({ t: 'loading' });
    const res = await getStudyNote(artifactId, undefined, read());
    if (lifetime.aborted) return;
    // Only show a draft that belongs to this screenshot.
    if (res.ok && res.data.artifactId === artifactId && res.data.sourceScreenshotIds.includes(id)) {
      setView({ t: 'open', note: res.data });
    } else {
      setView({ t: 'error' });
    }
  };

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
            <span className="sg-muted">
              {readOnly ? 'Resurrect this screenshot to prepare a new draft.' : 'Choose Make Notes to try again.'}
            </span>
          )}
        </div>
      )}

      {state.t === 'ready' && (
        <div className="sg-draft__ready" role="status">
          <p>
            <Badge tone="green">Draft ready</Badge>{' '}
            <Badge tone={draftProvenance(state.prep, view.t === 'open' ? view.note.origin : null).tone}>
              {draftProvenance(state.prep, view.t === 'open' ? view.note.origin : null).badge}
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
