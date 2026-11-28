import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { approveVersion, getApprovalStatus, type ApprovalRecord, type ApprovalStatus } from '../api/ai';
import { Badge, Button } from '../ui/primitives';
import { attemptKey, nextAttemptId, type ApprovalAttempt, type ApprovalAttempts } from './approvalAttempts';
import { isUnknownOutcome } from './draftHistory';

const FIELD_LABELS: Record<string, string> = {
  title: 'Title', start_date: 'Start date', start_time: 'Start time', end_date: 'End date', end_time: 'End time',
  all_day: 'All day', time_zone: 'Time zone', location: 'Location', description: 'Description',
  topic: 'Topic', main_concepts: 'Main concepts', extracted_code: 'Code', code_explanations: 'Code explanations',
  pitfalls: 'Pitfalls', uncertain_content: 'Uncertain points',
};
const label = (field: string) => FIELD_LABELS[field] ?? field;

type Load = { t: 'loading' } | { t: 'error' } | { t: 'ready'; status: ApprovalStatus };
interface Props {
  artifactId: number;
  /** The version on screen and the panel's current version (from the version history). */
  shown: { versionId: number; versionNumber: number };
  current: { versionId: number; versionNumber: number };
  /** The preparation's recorded provider ('fake' = simulated content). */
  provider: string | null;
  /** True in The Crypt: status is shown, approving is not offered. */
  readOnly?: boolean;
  /** Reload the panel's latest version (used after a version conflict). */
  onLoadLatest: () => void;
  /** Bounded GET/POST fetch tied to the panel's lifetime. */
  request: () => typeof fetch;
  /** Approval attempts, owned by the draft panel; only entries for `artifactId` are used. */
  attempts: ApprovalAttempts;
}

function PendingNotice({ unknown }: { unknown: ApprovalAttempt[] }) {
  if (unknown.length === 0) return null;
  return (
    <div role="alert">
      {unknown.map((p) => (
        <p key={p.versionId}>
          {p.retryRejected
            ? `This retry was rejected, but your earlier approval attempt may still have succeeded. Check approval status for the original version (version ${p.versionNumber}).`
            : `We could not confirm whether the approval was recorded for version ${p.versionNumber}. Check the approval status to see what was saved; approving again never creates a duplicate.`}
        </p>
      ))}
    </div>
  );
}

function InFlight({ attempts }: { attempts: ApprovalAttempt[] }) {
  return (
    <>
      {attempts.map((a) => (
        <p key={a.versionId} className="sg-muted">An approval request for version {a.versionNumber} is still being processed.</p>
      ))}
    </>
  );
}

function When({ iso }: { iso: string }) {
  const d = new Date(iso);
  return <time dateTime={iso}>{d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>;
}

/**
 * Approval of ONE saved version (Batch 5B). Everything shown comes from the
 * server's approval ledger (re-read after every attempt); the button is only
 * offered for the current version, and the server re-checks that it is still
 * current, complete and consistent. Approval records a decision only: nothing
 * is changed, exported or sent to another app.
 */
export function ApprovalSection({ artifactId, shown, current, provider, readOnly = false, onLoadLatest, request, attempts }: Props) {
  const [load, setLoad] = useState<Load>({ t: 'loading' });
  const [confirming, setConfirming] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [acks, setAcks] = useState<Set<string>>(new Set());
  const busyRef = useRef(false); // synchronous double-click guard within this mount
  const ticket = useRef(0);
  const { dispatch } = attempts;
  // This artifact's attempts only; the panel's state is the single source.
  const mine = Object.values(attempts.state).filter((a) => a.artifactId === artifactId);
  const unknown = mine.filter((a) => a.phase === 'unknown');
  const inFlight = mine.filter((a) => a.inFlight !== null);
  const currentAttempt = attempts.state[attemptKey(artifactId, current.versionId)];
  const busy = currentAttempt?.inFlight != null;
  const confirmedRecord = (versionId: number) => {
    const a = attempts.state[attemptKey(artifactId, versionId)];
    return a?.phase === 'confirmed' ? a.record : undefined;
  };

  const refresh = async () => {
    const mineTicket = ++ticket.current;
    setLoad((l) => (l.t === 'ready' ? l : { t: 'loading' }));
    let res;
    try {
      res = await getApprovalStatus(artifactId, request());
    } catch {
      res = undefined;
    }
    if (mineTicket !== ticket.current) return; // only the latest read of this mount counts
    setLoad(res?.ok ? { t: 'ready', status: res.data } : { t: 'error' });
    // An exact-version record confirms; a read without one, or a failed read,
    // changes nothing (the reducer never downgrades a confirmation).
    if (res?.ok) dispatch({ type: 'status', artifactId, approvals: res.data.approvals });
  };
  const refreshRef = useRef(refresh);
  useLayoutEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    void refreshRef.current();
    const t = ticket;
    return () => {
      t.current += 1; // a late answer never updates an unmounted section
    };
  }, [artifactId, current.versionId]);

  const confirmedNotices = mine
    .filter((a) => a.phase === 'confirmed' && a.record && (a.confirmedVia === 'check' || a.versionId === current.versionId))
    .map((a) => {
      const r = a.record!;
      let body;
      if (a.confirmedVia === 'created' && load.t === 'ready') body = <>Approved version {r.versionNumber}. Nothing was sent to another app.</>;
      else if (a.confirmedVia === 'existing' && load.t === 'ready') body = <>Version {r.versionNumber} was already approved. Nothing new was recorded.</>;
      else if (a.confirmedVia === 'check') {
        body = <>Approved version {r.versionNumber} on <When iso={r.approvedAt} />. The earlier attempt was recorded. Nothing was sent to another app.</>;
      } else if (load.t !== 'ready') body = <>Approved version {r.versionNumber} on <When iso={r.approvedAt} />.</>;
      else return null;
      return <p key={a.versionId} role="status">{body}</p>;
    });

  const fake = provider === 'fake';
  const attemptState = (
    <>
      {confirmedNotices}
      <InFlight attempts={inFlight} />
      <PendingNotice unknown={unknown} />
    </>
  );
  const canCheck = unknown.length > 0 || inFlight.length > 0;
  if (load.t === 'loading') {
    // A loading read never hides what is already known about this artifact's
    // attempts; no approval status or action is shown until the read answers.
    const checking = <p className="sg-muted" role="status">Checking approval status…</p>;
    if (!canCheck && !confirmedNotices.some(Boolean)) return checking;
    return (
      <section className="sg-approval" aria-label="Approval">
        {checking}
        {attemptState}
        {canCheck && <Button size="sm" onClick={() => void refresh()}>Check approval status</Button>}
      </section>
    );
  }
  if (load.t === 'error') {
    return (
      <section className="sg-approval" aria-label="Approval">
        <p role="status">
          {confirmedRecord(current.versionId)
            ? 'Approval status cannot be re-read right now.'
            : 'Approval status is unavailable right now. It is not shown as approved.'}
        </p>
        {confirmedNotices}
        <InFlight attempts={inFlight} />
        <PendingNotice unknown={unknown} />
        <Button size="sm" onClick={() => void refresh()}>Check approval status</Button>
      </section>
    );
  }
  const s = load.status;
  const recordFor = (versionId: number): ApprovalRecord | undefined => s.approvals.find((a) => a.versionId === versionId);
  // Three separate facts, never mixed: the version on screen, the server's
  // current version (which may be newer than this panel's), and other approvals.
  const viewingCurrent = shown.versionId === current.versionId;
  const shownRecord = recordFor(shown.versionId) ?? confirmedRecord(shown.versionId);
  const stale = s.currentVersionId !== current.versionId; // the server's current version is not this panel's
  const newer = stale && s.currentVersionNumber > current.versionNumber;
  const serverRecord = stale ? recordFor(s.currentVersionId) : undefined;
  const others = s.approvals.filter((a) => a.versionId !== shown.versionId && !(stale && a.versionId === s.currentVersionId));

  const onApprove = async () => {
    if (busyRef.current || busy || currentAttempt?.phase === 'confirmed') return;
    busyRef.current = true;
    const target = { artifactId, versionId: current.versionId };
    const attemptId = nextAttemptId();
    dispatch({ type: 'start', ...target, versionNumber: current.versionNumber, attemptId });
    try {
      let res;
      try {
        res = await approveVersion(artifactId, target.versionId, s.eligibility.requiredAcknowledgements, request());
      } catch {
        res = undefined;
      }
      // Each answer is a transition applied to the panel's CURRENT state: it can
      // never downgrade a confirmation that arrived meanwhile.
      if (res?.ok) {
        setConfirming(false);
        dispatch({ type: 'answered', ...target, attemptId, record: res.data.approval, result: res.data.approvalResult });
      } else if (!res || isUnknownOutcome(res)) {
        dispatch({ type: 'unknown', ...target, attemptId });
      } else {
        const conflict = res.status === 409 && res.code === 'version_conflict';
        if (conflict) setConfirming(false);
        const text = conflict
          ? `A newer version was saved since you reviewed version ${current.versionNumber}. Version ${current.versionNumber} was not approved. Review the latest version first.`
          : res.status === 409 && res.code === 'screenshot_archived'
            ? 'The source screenshot is in The Crypt, so this draft cannot be approved. Nothing was recorded.'
            : res.status === 409
              ? 'This version cannot be approved as it is. Nothing was recorded. See the reasons below.'
              : 'The approval was not recorded.';
        // Shown only if no earlier attempt for this version is unknown (the reducer decides).
        dispatch({ type: 'rejected', ...target, attemptId, text, conflict });
      }
      await refresh(); // what is shown is always what the server has
    } finally {
      busyRef.current = false;
    }
  };

  const startConfirm = () => {
    setReviewed(false);
    setAcks(new Set());
    dispatch({ type: 'dismiss', artifactId, versionId: current.versionId });
    setConfirming(true);
  };
  const allAcked = s.eligibility.requiredAcknowledgements.every((f) => acks.has(f));
  const aiFields = s.eligibility.aiOriginFields;

  return (
    <section className="sg-approval" aria-label="Approval">
      <h5>Approval</h5>
      <p>
        {shownRecord ? (
          <>
            <Badge tone="green">Approved · version {shown.versionNumber}</Badge> Version {shown.versionNumber} was approved
            on <When iso={shownRecord.approvedAt} />. Approval confirms this saved version only. Nothing has been sent to
            another app.
          </>
        ) : (
          <>
            <Badge tone={s.approvals.length ? 'peach' : 'muted'}>Not approved</Badge>{' '}
            {viewingCurrent && !stale ? `The current version ${shown.versionNumber}` : `Version ${shown.versionNumber}`} is
            not approved.{s.approvals.length === 0 && ' No version of this draft has an approval yet.'}
          </>
        )}
      </p>
      {others.map((a) => (
        <p key={a.approvalId}>
          Version {a.versionNumber} was approved on <When iso={a.approvedAt} />.
        </p>
      ))}
      {!viewingCurrent && (
        <p role="status">Approval is only possible for the current version (version {current.versionNumber}).</p>
      )}
      {confirmedNotices}
      {currentAttempt?.rejection && <p role="alert">{currentAttempt.rejection.text}</p>}
      <InFlight attempts={inFlight} />
      <PendingNotice unknown={unknown} />
      {(unknown.length > 0 || inFlight.length > 0) && <Button size="sm" onClick={() => void refresh()}>Check approval status</Button>}
      {stale && !currentAttempt?.rejection?.conflict && (
        <p role="status">
          {newer
            ? serverRecord
              ? `A newer version (version ${s.currentVersionNumber}) has been saved and approved.`
              : `A newer version (version ${s.currentVersionNumber}) has been saved. It is not approved.`
            : 'The approval status does not match the version on screen.'}{' '}
          Load the latest version to review it before approving.
        </p>
      )}
      {(currentAttempt?.rejection?.conflict || stale) && <Button size="sm" onClick={onLoadLatest}>Load latest version</Button>}

      {viewingCurrent && !stale && !shownRecord && !s.eligibility.eligible && (
        <div className="sg-uncertain" role="note" aria-label="Why this version cannot be approved">
          <p>Version {s.currentVersionNumber} cannot be approved yet:</p>
          <ul>
            {s.eligibility.reasons.map((r, i) => (
              <li key={i}>{r.field ? `${label(r.field)}: ` : ''}{r.message}</li>
            ))}
          </ul>
        </div>
      )}

      {viewingCurrent && !stale && !readOnly && !shownRecord && !busy && s.eligibility.eligible && !confirming && (
        <Button size="sm" variant="primary" onClick={startConfirm}>Approve version {s.currentVersionNumber}</Button>
      )}

      {confirming && viewingCurrent && !stale && !readOnly && !shownRecord && (
        <div className="sg-uncertain" role="alertdialog" aria-label={`Approve version ${s.currentVersionNumber}?`}>
          <p>
            <b>Approve version {s.currentVersionNumber}?</b> Approval confirms this saved version only. Nothing will be
            sent to another app, and the version itself is not changed.
          </p>
          {aiFields.length > 0 && (
            <p>
              {fake
                ? 'These values were written by the Fake AI (simulated, not read from your screenshot) and you have not changed them: '
                : 'These values came from AI and you have not changed them: '}
              {aiFields.map(label).join(', ')}.
            </p>
          )}
          <label>
            <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> I reviewed version{' '}
            {s.currentVersionNumber} as it is saved.
          </label>
          {s.eligibility.requiredAcknowledgements.map((f) => (
            <label key={f}>
              <input
                type="checkbox"
                checked={acks.has(f)}
                onChange={(e) =>
                  setAcks((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(f);
                    else next.delete(f);
                    return next;
                  })
                }
              />{' '}
              I understand {label(f)} is marked uncertain and I still approve it.
            </label>
          ))}
          <div className="sg-edit__actions">
            <Button size="sm" variant="primary" disabled={busy || !reviewed || !allAcked} onClick={() => void onApprove()}>
              {busy ? 'Approving…' : `Confirm approval of version ${s.currentVersionNumber}`}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}
