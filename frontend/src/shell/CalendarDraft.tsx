import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  getEventDraft,
  getEventDraftPreparation,
  listEventDraftVersions,
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
import { ApprovalSection } from './ApprovalSection';
import { useApprovalAttempts } from './approvalAttempts';
import { EarlierVersionBanner, FieldHistoryNotice, FieldOriginTag, SourceLink, VersionHistory } from './DraftReviewParts';
import { describeSaved, originLabel, useDraftHistory, type SaveOutcomeText } from './draftHistory';
import { EventDraftEditor } from './EventDraftEditor';
import { DRAFT_REQUEST_TIMEOUT_MS, describeFailure, draftProvenance, usePreparation, type DraftPresence } from './usePreparation';
import { boundedFetch } from '../api/boundedFetch';

const loadEventVersion = (artifactId: number, versionId: number | undefined, f: typeof fetch) =>
  versionId === undefined ? getEventDraft(artifactId, f) : getEventDraft(artifactId, f, versionId);
const hasMissing = (d: EventDraftVersion) => d.content.missingFields.length > 0;

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
  const history = useDraftHistory<EventDraftVersion>({
    screenshotId: id,
    loadVersion: loadEventVersion,
    listVersions: listEventDraftVersions,
    read,
    signal,
  });
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<SaveOutcomeText | null>(null);
  const request = () => boundedFetch(DRAFT_REQUEST_TIMEOUT_MS, signal());

  // Once a draft is ready, read its CURRENT version (GETs only) so the summary
  // reflects saved edits, not just the original preparation. The body stays
  // hidden until the user opens it.
  const readyArtifact = state.t === 'ready' ? state.prep.artifactId : null;
  const openRef = useRef(history.open);
  // Approval attempts outlive the approval section (Hide draft, edit, new version).
  const approvalAttempts = useApprovalAttempts();
  useLayoutEffect(() => {
    openRef.current = history.open;
  });
  useEffect(() => {
    if (readyArtifact !== null) void openRef.current(readyArtifact);
  }, [readyArtifact]);

  const onOpenDraft = (artifactId: number) => {
    setExpanded(true);
    if (history.state.t !== 'open') void history.open(artifactId);
  };
  const h = history.state;
  const loaded = h.t === 'open' ? h : null;
  // "Needs details" = information is missing. Uncertain values are named separately.
  const needsDetails = loaded ? hasMissing(loaded.current) : state.t === 'ready' && state.prep.status === 'uncertain';
  const hasUncertain = loaded !== null && loaded.current.content.uncertainFields.length > 0;

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
            {needsDetails && <Badge tone="peach">Needs details</Badge>}{' '}
            <Badge tone={draftProvenance(state.prep, loaded ? loaded.current.origin : null).tone}>
              {draftProvenance(state.prep, loaded ? loaded.current.origin : null).badge}
            </Badge>
          </p>
          <p className="sg-muted">
            Saved in your workspace as draft #{state.prep.artifactId}
            {loaded && `, version ${loaded.current.versionNumber}`}. Not added to Google Calendar or any other
            calendar, and not sent anywhere.
            {needsDetails && (loaded ? ' Some details are missing.' : ' Some details are missing or uncertain.')}
            {hasUncertain && ' Some values are marked uncertain; check them before relying on this draft.'}
          </p>
          {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
          {expanded && loaded ? (
            <Button size="sm" disabled={editing} onClick={() => { history.resetToCurrent(); setExpanded(false); }}>Hide draft</Button>
          ) : (
            <Button size="sm" disabled={expanded && h.t === 'loading'} onClick={() => onOpenDraft(state.prep.artifactId!)}>
              {expanded && h.t === 'loading' ? 'Opening…' : 'Open draft'}
            </Button>
          )}
          {expanded && h.t === 'error' && <p role="alert">The draft could not be loaded. Try opening it again.</p>}
          {expanded && loaded && (
            <div className="sg-review">
              {loaded.shown.versionId !== loaded.current.versionId && (
                <EarlierVersionBanner versionNumber={loaded.shown.versionNumber} onBack={() => void history.show(loaded.current.versionId)} />
              )}
              {editing && loaded.shown.versionId === loaded.current.versionId ? (
                <EventDraftEditor
                  checkLatest={() => history.peekCurrent(loaded.current.artifactId)}
                  provider={state.prep.provider}
                  draft={loaded.current}
                  request={request}
                  onCancel={() => setEditing(false)}
                  onSaved={(saved) => {
                    setEditing(false);
                    setNotice(describeSaved(saved.editResult, saved.versionNumber));
                    void history.adopt(saved);
                  }}
                  onLoadLatest={() => {
                    setEditing(false);
                    setNotice({ kind: 'info', text: 'Loaded the latest version. Your unsaved changes were discarded.' });
                    void history.open(loaded.current.artifactId);
                  }}
                />
              ) : (
                <>
                  <EventDraftBody draft={loaded.shown} prep={state.prep} screenshotId={id} />
                  {!readOnly && loaded.shown.versionId === loaded.current.versionId && (
                    <Button size="sm" onClick={() => { history.cancelPending(); setNotice(null); setEditing(true); }}>Edit draft</Button>
                  )}
                </>
              )}
              <VersionHistory
                versions={loaded.versions}
                shownId={loaded.shown.versionId}
                provider={state.prep.provider}
                disabled={editing}
                onShow={(versionId) => void history.show(versionId)}
              />
              {!editing && (
                <ApprovalSection
                  key={`approval-${loaded.current.versionId}`}
                  artifactId={loaded.current.artifactId}
                  shown={loaded.shown}
                  current={loaded.current}
                  provider={state.prep.provider}
                  readOnly={readOnly}
                  request={request}
                  onLoadLatest={() => void history.open(loaded.current.artifactId)}
                  attempts={approvalAttempts}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A value exactly as the server stored it, or an explicit Missing / Not set
 * marker; never a guess. Its origin tag says whether you entered it or the AI
 * did (an AI value is never shown as checked by you).
 */
function Field({ draft, field, value, provider }: { draft: EventDraftVersion; field: EventDraftField; value: string | null; provider: string | null }) {
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
      )}{' '}
      <FieldOriginTag origins={draft.fieldOrigins} field={field} provider={provider} />
    </>
  );
}

function EventDraftBody({ draft, prep, screenshotId }: { draft: EventDraftVersion; prep: Preparation; screenshotId: number }) {
  const c = draft.content;
  const provider = prep.provider;
  // Any field the Fake AI wrote and you have not changed is still simulated.
  const simulatedFields = provider === 'fake' && Object.values(draft.fieldOrigins ?? {}).some((o) => o.origin === 'ai_generate' || o.origin === 'ai_redo');
  const aiVersion = draft.origin === 'ai_generate' || draft.origin === 'ai_redo';
  const simulated = provider === 'fake' && (aiVersion || simulatedFields);
  const allDay = c.allDay === null ? null : c.allDay ? 'Yes' : 'No';
  const rows: [string, EventDraftField, string | null][] = [
    ['Title', 'title', c.title],
    ['Start date', 'start_date', c.startDate],
    ['Start time', 'start_time', c.startTime],
    ['End date', 'end_date', c.endDate],
    ['End time', 'end_time', c.endTime],
    ['All day', 'all_day', allDay],
    ['Time zone', 'time_zone', c.timeZone],
    ['Location', 'location', c.location],
    ['Description', 'description', c.description],
  ];
  return (
    <article className="sg-draft__body" aria-label={`Event draft: ${c.title ?? 'untitled'}`}>
      {simulated && (
        <p className="sg-draft__simulated" role="note">
          {!aiVersion
            ? 'Simulated draft: values marked "Fake AI" were written by the Fake AI without reading your screenshot. Only values marked "edited by you" came from you.'
            : 'Simulated draft: the Fake AI did not read your screenshot. No date, time, time zone or location was extracted from the image.'}
        </p>
      )}
      <FieldHistoryNotice origins={draft.fieldOrigins} />
      <dl className="sg-facts">
        {rows.map(([label, field, value]) => (
          <div key={field} className="sg-facts__pair">
            <dt>{label}</dt>
            <dd><Field draft={draft} field={field} value={value} provider={provider} /></dd>
          </div>
        ))}
        <dt>Source</dt>
        <dd>Screenshot #{screenshotId} <SourceLink screenshotId={screenshotId} /></dd>
        <dt>Version</dt>
        <dd>
          Version {draft.versionNumber}, {originLabel(draft.origin, provider)}.
        </dd>
      </dl>
      <p className="sg-muted">
        Times are shown exactly as saved, in the listed time zone. Approval status is shown below. Nothing has been
        added to a calendar.
      </p>
    </article>
  );
}
