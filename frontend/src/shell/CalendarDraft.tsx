import { useState } from 'react';
import {
  getEventDraft,
  getEventDraftPreparation,
  requestEventDraft,
  type EventDraftField,
  type EventDraftVersion,
  type Preparation,
  type ProviderMode,
} from '../api/ai';
import type { Screenshot } from '../api/client';
import { DEFAULT_MAX_POLLS, DEFAULT_POLL_INTERVAL_MS } from '../ai/useOperationPolling';
import { Icon } from '../ui/Icon';
import { Badge, Button } from '../ui/primitives';
import { describeFailure, draftProvenance, usePreparation, type DraftPresence } from './usePreparation';

type DraftView = { t: 'closed' } | { t: 'loading' } | { t: 'error' } | { t: 'open'; draft: EventDraftVersion };

interface Props {
  screenshot: Screenshot;
  providerMode: ProviderMode | 'unknown';
  /** True when the user's current choice for this screenshot is Add to Calendar. */
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
 * Calendar event draft for ONE screenshot (Batch 4B): explicit Prepare, honest
 * progress, and a read-only view of the persisted draft. Uses the same state
 * machine as Make Notes (`usePreparation`), so reload/reopen, lost-response
 * reconciliation and retry gating behave identically. Stops at "Draft ready":
 * nothing is added to Google Calendar or any other application.
 */
export function CalendarDraft({
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
    action: 'add_calendar',
    providerMode,
    canStart,
    request: requestEventDraft,
    lookupLatest: getEventDraftPreparation,
    pollIntervalMs,
    maxPolls,
    onPresence,
  });
  const [view, setView] = useState<DraftView>({ t: 'closed' });

  const onOpenDraft = async (artifactId: number) => {
    const lifetime = signal();
    setView({ t: 'loading' });
    const res = await getEventDraft(artifactId, read());
    if (lifetime.aborted) return;
    // Only show a draft that belongs to this screenshot.
    if (res.ok && res.data.artifactId === artifactId && res.data.sourceScreenshotIds.includes(id)) {
      setView({ t: 'open', draft: res.data });
    } else {
      setView({ t: 'error' });
    }
  };

  if (state.t === 'checking') {
    return <p className="sg-muted" role="status">Checking for a calendar event draft…</p>;
  }
  if (state.t === 'none' && !canStart) return null;

  return (
    <div className="sg-draft" role="region" aria-label="Calendar event draft">
      {state.t === 'none' && (
        <div className="sg-next__ready">
          <p>
            <Icon name="check" size={15} /> <b>Ready to prepare.</b> Turn it into a calendar event draft.
          </p>
          <Button size="sm" variant="primary" disabled={busy || !fake} onClick={() => void onPrepare()}>
            Prepare event draft
          </Button>
          <p className="sg-muted">
            {fake
              ? 'Creates a simulated event draft with the Fake AI and saves it to your workspace. It does not read dates or times from your screenshot. Nothing is added to Google Calendar or any other app.'
              : providerMode === 'openai'
                ? 'Preparing drafts is turned off with a real AI provider until a safety fix ships.'
                : 'The AI provider could not be confirmed, so preparing is unavailable.'}
          </p>
        </div>
      )}

      {state.t === 'lookup_error' && (
        <div className="sg-uncertain" role="status">
          <p>Could not check whether a calendar event draft exists for this screenshot.</p>
          <Button size="sm" disabled={busy} onClick={() => void lookup()}>Check again</Button>
        </div>
      )}

      {(state.t === 'submitting' || state.t === 'preparing') && (
        <p role="status" className="sg-draft__status">
          <Icon name="loader" size={15} />{' '}
          {state.t === 'submitting' ? 'Sending the Prepare request…' : 'Preparing a simulated event draft on the server…'}
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
              {readOnly ? 'Resurrect this screenshot to prepare a new draft.' : 'Choose Add to Calendar to try again.'}
            </span>
          )}
        </div>
      )}

      {state.t === 'ready' && (
        <div className="sg-draft__ready" role="status">
          <p>
            <Badge tone="green">Draft ready</Badge>{' '}
            {state.prep.status === 'uncertain' && <Badge tone="peach">Needs details</Badge>}{' '}
            <Badge tone={draftProvenance(state.prep, view.t === 'open' ? view.draft.origin : null).tone}>
              {draftProvenance(state.prep, view.t === 'open' ? view.draft.origin : null).badge}
            </Badge>
          </p>
          <p className="sg-muted">
            Saved in your workspace as draft #{state.prep.artifactId}. Not added to Google Calendar or any other
            calendar, and not sent anywhere.
            {state.prep.status === 'uncertain' && ' Some details are missing or uncertain.'}
          </p>
          {view.t === 'open' ? (
            <Button size="sm" onClick={() => setView({ t: 'closed' })}>Hide draft</Button>
          ) : (
            <Button size="sm" disabled={view.t === 'loading'} onClick={() => void onOpenDraft(state.prep.artifactId!)}>
              {view.t === 'loading' ? 'Opening…' : 'Open draft'}
            </Button>
          )}
          {view.t === 'error' && <p role="alert">The draft could not be loaded. Try opening it again.</p>}
          {view.t === 'open' && <EventDraftBody draft={view.draft} prep={state.prep} screenshotId={id} />}
        </div>
      )}
    </div>
  );
}

/** A value exactly as the server stored it, or an explicit Missing / Not set marker. Never a guess. */
function Field({ draft, field, value }: { draft: EventDraftVersion; field: EventDraftField; value: string | null }) {
  const c = draft.content;
  if (c.missingFields.includes(field)) return <Badge tone="muted">Missing</Badge>;
  if (value === null) return <span className="sg-muted">Not set</span>;
  return (
    <>
      {value}
      {c.uncertainFields.includes(field) && (
        <>
          {' '}
          <Badge tone="peach">Uncertain</Badge>
        </>
      )}
    </>
  );
}

function EventDraftBody({ draft, prep, screenshotId }: { draft: EventDraftVersion; prep: Preparation; screenshotId: number }) {
  const c = draft.content;
  const simulated = prep.provider === 'fake' && draft.origin !== 'manual_edit';
  const origin =
    draft.origin === 'manual_edit' ? 'edited by you' : draft.origin === 'ai_redo' ? 'regenerated by AI' : 'generated by AI';
  const allDay = c.allDay === null ? null : c.allDay ? 'Yes' : 'No';
  return (
    <article className="sg-draft__body" aria-label={`Event draft: ${c.title ?? 'untitled'}`}>
      {simulated && (
        <p className="sg-draft__simulated" role="note">
          Simulated draft: the Fake AI did not read your screenshot. No date, time, time zone or location was
          extracted from the image.
        </p>
      )}
      <dl className="sg-facts">
        <dt>Title</dt>
        <dd><Field draft={draft} field="title" value={c.title} /></dd>
        <dt>Start date</dt>
        <dd><Field draft={draft} field="start_date" value={c.startDate} /></dd>
        <dt>Start time</dt>
        <dd><Field draft={draft} field="start_time" value={c.startTime} /></dd>
        <dt>End date</dt>
        <dd><Field draft={draft} field="end_date" value={c.endDate} /></dd>
        <dt>End time</dt>
        <dd><Field draft={draft} field="end_time" value={c.endTime} /></dd>
        <dt>All day</dt>
        <dd><Field draft={draft} field="all_day" value={allDay} /></dd>
        <dt>Time zone</dt>
        <dd><Field draft={draft} field="time_zone" value={c.timeZone} /></dd>
        <dt>Location</dt>
        <dd><Field draft={draft} field="location" value={c.location} /></dd>
        <dt>Description</dt>
        <dd><Field draft={draft} field="description" value={c.description} /></dd>
        <dt>Source</dt>
        <dd>Screenshot #{screenshotId}</dd>
        <dt>Version</dt>
        <dd>
          Version {draft.versionNumber}, {origin}
          {simulated ? ' (Fake AI, simulated)' : ''}.
        </dd>
      </dl>
      <p className="sg-muted">
        Times are shown exactly as saved, in the listed time zone. Review, editing and approval come in a later
        version. Nothing has been added to a calendar.
      </p>
    </article>
  );
}
