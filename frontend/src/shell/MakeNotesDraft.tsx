import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  getMakeNotesPreparation,
  getStudyNote,
  listStudyNoteVersions,
  requestMakeNotesDraft,
  type Preparation,
  type ProviderMode,
  type StudyNoteVersion,
} from '../api/ai';
import type { Screenshot } from '../api/client';
import { DEFAULT_MAX_POLLS, DEFAULT_POLL_INTERVAL_MS } from '../ai/useOperationPolling';
import { Icon } from '../ui/Icon';
import { Badge, Button } from '../ui/primitives';
import { boundedFetch } from '../api/boundedFetch';
import { EarlierVersionBanner, FieldHistoryNotice, FieldOriginTag, SourceLink, VersionHistory } from './DraftReviewParts';
import { describeSaved, originLabel, useDraftHistory, type SaveOutcomeText } from './draftHistory';
import { NotesDraftEditor } from './NotesDraftEditor';
import { DRAFT_REQUEST_TIMEOUT_MS, describeFailure, draftProvenance, usePreparation, type DraftPresence } from './usePreparation';

const loadNoteVersion = (artifactId: number, versionId: number | undefined, f: typeof fetch) =>
  getStudyNote(artifactId, versionId, f);


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
  const history = useDraftHistory<StudyNoteVersion>({
    screenshotId: id,
    loadVersion: loadNoteVersion,
    listVersions: listStudyNoteVersions,
    read,
    signal,
  });
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<SaveOutcomeText | null>(null);
  const request = () => boundedFetch(DRAFT_REQUEST_TIMEOUT_MS, signal());

  // Read the CURRENT version once the draft is ready (GETs only), so the
  // summary reflects saved edits; the body stays hidden until it is opened.
  const readyArtifact = state.t === 'ready' ? state.prep.artifactId : null;
  const openRef = useRef(history.open);
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
  const uncertain = loaded
    ? loaded.current.content.uncertain_content.length > 0
    : state.t === 'ready' && state.prep.status === 'uncertain';

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
            <Badge tone={draftProvenance(state.prep, loaded ? loaded.current.origin : null).tone}>
              {draftProvenance(state.prep, loaded ? loaded.current.origin : null).badge}
            </Badge>
          </p>
          <p className="sg-muted">
            Saved in your workspace as draft #{state.prep.artifactId}
            {loaded && `, version ${loaded.current.versionNumber}`}. Not approved, not exported and not sent anywhere.
            {uncertain && ' Parts of it are marked uncertain.'}
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
                <NotesDraftEditor
                  checkLatest={() => history.peekCurrent(loaded.current.artifactId)}
                  provider={state.prep.provider}
                  note={loaded.current}
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
                  <DraftBody note={loaded.shown} prep={state.prep} screenshotId={id} />
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
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  items,
  code = false,
  origin,
}: {
  title: string;
  items: string[];
  code?: boolean;
  origin?: ReactNode;
}) {
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
        {origin}
      </dd>
    </>
  );
}

function DraftBody({ note, prep, screenshotId }: { note: StudyNoteVersion; prep: Preparation; screenshotId: number }) {
  const c = note.content;
  const provider = prep.provider;
  const tag = (field: string) => <FieldOriginTag origins={note.fieldOrigins} field={field} provider={provider} />;
  // Any section the Fake AI wrote and you have not changed is still simulated.
  const simulatedSections = Object.values(note.fieldOrigins ?? {}).some((o) => o.origin === 'ai_generate' || o.origin === 'ai_redo');
  const aiVersion = note.origin === 'ai_generate' || note.origin === 'ai_redo';
  const simulated = provider === 'fake' && (aiVersion || simulatedSections);
  return (
    <article className="sg-draft__body" aria-label={`Notes draft: ${c.topic}`}>
      {simulated && (
        <p className="sg-draft__simulated" role="note">
          {!aiVersion
            ? 'Simulated draft: sections marked "Fake AI" were written by the Fake AI without reading your screenshot. Only sections marked "edited by you" came from you.'
            : 'Simulated draft: the Fake AI wrote placeholder text without reading your screenshot. None of this was extracted from the image.'}
        </p>
      )}
      <FieldHistoryNotice origins={note.fieldOrigins} />
      <h4>{c.topic}</h4>
      <p>{tag('topic')}</p>
      <dl className="sg-facts">
        <Section title="Main concepts" items={c.main_concepts} origin={tag('main_concepts')} />
        <Section title="Code" items={c.extracted_code} code origin={tag('extracted_code')} />
        <Section title="Code explanations" items={c.code_explanations} origin={tag('code_explanations')} />
        <Section title="Pitfalls" items={c.pitfalls} origin={tag('pitfalls')} />
        <Section title="Uncertain" items={c.uncertain_content} origin={tag('uncertain_content')} />
        <dt>Source</dt>
        <dd>
          Screenshot #{screenshotId}
          {note.sourceScreenshotIds.length > 1 && ` and ${note.sourceScreenshotIds.length - 1} more`}{' '}
          <SourceLink screenshotId={screenshotId} />
        </dd>
        <dt>Version</dt>
        <dd>
          Version {note.versionNumber}, {originLabel(note.origin, provider)}.
        </dd>
      </dl>
      <p className="sg-muted">Approval comes in a later version. This draft is not exported and not sent anywhere.</p>
    </article>
  );
}
