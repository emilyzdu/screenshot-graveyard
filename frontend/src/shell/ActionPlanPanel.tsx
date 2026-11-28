import { useCallback, useEffect, useRef, useState } from 'react';
import { approveVersion, type ProviderMode, type VersionInfo } from '../api/ai';
import {
  executeAction,
  getActionPlan,
  getIntegrations,
  getExecution,
  getLatestActionPlan,
  getPlanOperation,
  listActionPlanVersions,
  requestActionPlan,
  saveActionPlanRevision,
  type ActionPlan,
  type Execution,
  type PlanAction,
} from '../api/tools';

const POLL_MS = 1000;
const MAX_POLLS = 90;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FIELDS: Record<PlanAction['argumentBlock'], { key: string; label: string; long?: boolean }[]> = {
  calendar: [
    { key: 'title', label: 'Title' }, { key: 'start_date', label: 'Start date (YYYY-MM-DD)' },
    { key: 'start_time', label: 'Start time (HH:MM)' }, { key: 'end_date', label: 'End date (YYYY-MM-DD)' },
    { key: 'end_time', label: 'End time (HH:MM)' }, { key: 'time_zone', label: 'Time zone (IANA)' },
    { key: 'location', label: 'Location' }, { key: 'description', label: 'Description', long: true },
  ],
  notion: [
    { key: 'title', label: 'Page title' }, { key: 'parent_id', label: 'Parent Notion page ID (you choose where it goes)' },
    { key: 'markdown', label: 'Page content (Markdown)', long: true },
  ],
  gmail: [
    { key: 'recipient_email', label: 'To (optional)' }, { key: 'subject', label: 'Subject' },
    { key: 'body', label: 'Message', long: true },
  ],
};

const EXEC_TEXT: Record<Execution['status'], string> = {
  reserved: 'Execution pending…',
  executing: 'Running…',
  cancelled: 'Cancelled before sending',
  succeeded: 'Created',
  failed: 'Not sent',
  rejected: 'The app reported an error',
  unknown: 'Outcome unknown',
};
// A lost dispatch response requires reconciliation before this tool is offered again.
const unresolvedDispatches = new Map<string, number>();
export type PlanActivity =
  | { kind: 'plan'; plan: ActionPlan }
  | { kind: 'planning'; pending: boolean }
  | { kind: 'approved' }
  | { kind: 'execution'; execution: Execution }
  | { kind: 'dispatch-unconfirmed' };

const UNRESOLVED = new Set<Execution['status']>(['reserved', 'executing', 'unknown']);

type Draft = { enabled: boolean; args: Record<string, unknown> };

function blank(v: unknown): unknown {
  return v === '' ? null : v;
}

export function ExecutionLine({ e, app, otherPlan }: { e: Execution; app: string; otherPlan: boolean }) {
  return (
    <p role="status" data-testid={`execution-${e.actionIndex}`}>
      {otherPlan && <span className="pw-muted">From an earlier plan: </span>}
      <strong>{EXEC_TEXT[e.status]}</strong>
      {e.status === 'succeeded' && e.receipt && (
        <> in {app}{e.simulated ? ' (simulated, nothing reached a real account)' : ''}. Item id <code>{e.receipt.externalId}</code>
          {e.receipt.verified ? ' (matched to this request)' : ' (not independently matched to this request)'}
          {e.receipt.url && <> · <a href={e.receipt.url} target="_blank" rel="noopener noreferrer">Open</a></>}</>
      )}
      {e.detail && <> {e.detail}</>}
    </p>
  );
}

function ActionEditor({ action, draft, onChange, disabled }: {
  action: PlanAction; draft: Draft; onChange: (d: Draft) => void; disabled: boolean;
}) {
  const fields = FIELDS[action.argumentBlock];
  const set = (key: string, value: unknown) => onChange({ ...draft, args: { ...draft.args, [key]: value } });
  return (
    <fieldset disabled={disabled} className="sg-plan__edit">
      <legend>Review the details</legend>
      <label><input type="checkbox" checked={draft.enabled} onChange={(e) => onChange({ ...draft, enabled: e.target.checked })} /> Include this action</label>
      {action.argumentBlock === 'calendar' && (
        <label>All day{' '}
          <select value={draft.args.all_day === true ? 'yes' : draft.args.all_day === false ? 'no' : ''}
            onChange={(e) => set('all_day', e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null)}>
            <option value="">Unknown</option><option value="yes">Yes</option><option value="no">No</option>
          </select>
        </label>
      )}
      {fields.map((f) => (
        <label key={f.key} className="sg-plan__field">{f.label}
          {f.long ? (
            <textarea rows={4} value={String(draft.args[f.key] ?? '')} onChange={(e) => set(f.key, blank(e.target.value))} />
          ) : (
            <input value={String(draft.args[f.key] ?? '')} onChange={(e) => set(f.key, blank(e.target.value))} />
          )}
        </label>
      ))}
    </fieldset>
  );
}

function PlanHistory({ artifactId }: { artifactId: number }) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [history, setHistory] = useState<ActionPlan | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const open = async () => {
    setLoading(true);
    setError('');
    const result = await listActionPlanVersions(artifactId);
    setLoading(false);
    if (result.ok) setVersions(result.data);
    else setError('Plan history could not be loaded.');
  };
  const show = async (versionId: number) => {
    setLoading(true);
    setError('');
    setHistory(null);
    const result = await getActionPlan(artifactId, fetch, versionId);
    setLoading(false);
    if (result.ok) setHistory(result.data);
    else setError('That plan version could not be loaded.');
  };
  return (
    <section className="sg-plan__history" aria-label="Plan version history">
      {versions === null ? <button type="button" className="pw-btn" disabled={loading} onClick={() => void open()}>View plan history</button> :
        <>
          {versions.every((version) => version.isCurrent) && <p>No earlier versions.</p>}
          <div className="pw-row">
            {versions.filter((version) => !version.isCurrent).map((version) => <button key={version.versionId} type="button" className="pw-btn"
              disabled={loading} aria-pressed={history?.versionId === version.versionId} onClick={() => void show(version.versionId)}>
              View version {version.versionNumber}
            </button>)}
          </div>
        </>}
      {loading && <p role="status">Loading plan history…</p>}
      {error && <p role="alert">{error}</p>}
      {history && <article className="sg-plan__action" aria-label={`Earlier version ${history.versionNumber}`}>
        <h4>Version {history.versionNumber} · read only</h4>
        <p>{history.rationale}</p>
        {history.actions.map((action) => <details key={action.index}>
          <summary>{action.actionLabel}{action.enabled ? '' : ' · excluded'}</summary>
          <pre>{JSON.stringify(action.toolArguments ?? action.arguments, null, 2)}</pre>
        </details>)}
      </article>}
    </section>
  );
}

/**
 * The AI-generated action plan for one screenshot: what it proposes, why, the
 * exact tool arguments, review and edits, approval of the exact version, and a
 * separate Run per action. Every state shown comes from the server.
 */
export function ActionPlanPanel({ screenshotId, providerMode, onActivity, emphasizeReview = false, canPlan = true, showHistory = false }: {
  screenshotId: number; providerMode: ProviderMode | 'unknown'; onActivity?: (activity: PlanActivity) => void; emphasizeReview?: boolean; canPlan?: boolean; showHistory?: boolean;
}) {
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [reviewed, setReviewed] = useState(false);
  const [acks, setAcks] = useState<string[]>([]);
  const [confirmRun, setConfirmRun] = useState<Record<number, boolean>>({});
  const [enabled, setEnabled] = useState(false);
  const [connectionsError, setConnectionsError] = useState(false);
  const [connectionCheck, setConnectionCheck] = useState(0);
  const [execution, setExecution] = useState<Execution | null>(null);
  const alive = useRef(true);
  const notify = useRef(onActivity);
  notify.current = onActivity;
  useEffect(() => {
    alive.current = true; // React StrictMode re-runs effects: re-arm after the simulated unmount
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    // Shown only when the server says external apps are enabled.
    void getIntegrations().then((result) => {
      if (!alive.current) return;
      setEnabled(result.ok && result.data.enabled);
      setConnectionsError(!result.ok);
    });
  }, [connectionCheck]);

  const showPlan = useCallback((p: ActionPlan) => {
    setPlan(p);
    setExecution(null);
    notify.current?.({ kind: 'plan', plan: p });
    setDrafts(Object.fromEntries(p.actions.map((a) => [a.index, { enabled: a.enabled, args: { ...a.arguments } }])));
    setReviewed(false);
    setAcks([]);
    setConfirmRun({});
  }, []);

  const loadPlan = useCallback(async (artifactId: number) => {
    const r = await getActionPlan(artifactId);
    if (!alive.current) return;
    if (r.ok) showPlan(r.data);
    else setStatus('The plan could not be loaded.');
  }, [showPlan]);

  const follow = useCallback(async (operationId: number) => {
    for (let i = 0; i < MAX_POLLS && alive.current; i++) {
      const r = await getPlanOperation(operationId);
      if (!alive.current) return;
      if (!r.ok) { setStatus('Could not check the plan. Try reloading.'); return; }
      if (r.data.status !== 'pending') {
        notify.current?.({ kind: 'planning', pending: false });
        if (r.data.artifactId) { setStatus(null); await loadPlan(r.data.artifactId); }
        else setStatus(r.data.errorDetail ?? 'Planning failed. Nothing was saved.');
        return;
      }
      notify.current?.({ kind: 'planning', pending: true });
      setStatus('The AI is planning…');
      await sleep(POLL_MS);
    }
  }, [loadPlan]);

  useEffect(() => {
    if (!enabled) return;
    void (async () => {
      const r = await getLatestActionPlan(screenshotId);
      if (!alive.current) return;
      if (!r.ok) {
        if (r.status !== 404) setStatus('The current plan could not be checked. Reopen the card to try again.');
        return;
      }
      if (r.data.status === 'pending') void follow(r.data.operationId);
      else if (r.data.artifactId) void loadPlan(r.data.artifactId);
    })();
  }, [enabled, screenshotId, follow, loadPlan]);

  const start = async (replan: boolean) => {
    setBusy(true);
    setStatus(null);
    const r = await requestActionPlan(screenshotId, replan);
    if (!r.ok) setStatus(r.code === 'consent_required' ? 'Allow AI processing for this screenshot first (above).' : r.message);
    else {
      if (r.data.status === 'pending') notify.current?.({ kind: 'planning', pending: true });
      await follow(r.data.operationId);
    }
    setBusy(false);
  };

  const save = async () => {
    if (!plan) return;
    setBusy(true);
    const r = await saveActionPlanRevision(plan, plan.actions.map((a) => ({
      index: a.index, enabled: drafts[a.index].enabled, block: a.argumentBlock, args: drafts[a.index].args,
    })));
    setBusy(false);
    if (!r.ok) { setStatus(r.message); return; }
    setStatus(r.data.versionNumber === plan.versionNumber ? 'Nothing changed.' : `Saved as version ${r.data.versionNumber}. Review and approve it.`);
    await loadPlan(plan.artifactId);
  };

  const approve = async () => {
    if (!plan) return;
    setBusy(true);
    const r = await approveVersion(plan.artifactId, plan.versionId, acks);
    setBusy(false);
    if (r.ok) notify.current?.({ kind: 'approved' });
    setStatus(r.ok ? `Version ${plan.versionNumber} approved. Nothing has run yet.` : r.message);
    await loadPlan(plan.artifactId);
  };

  const run = async (index: number) => {
    if (!plan) return;
    setBusy(true);
    setStatus(null);
    const r = await executeAction(plan, index);
    if (!r.ok) {
      if (r.status === 0 || r.status >= 500 || r.code === 'bad_shape') {
        const action = plan.actions.find((candidate) => candidate.index === index);
        if (action) unresolvedDispatches.set(`${screenshotId}:${action.tool}`, Math.max(0, ...action.deliveryHistory.map((entry) => entry.executionId)));
        notify.current?.({ kind: 'dispatch-unconfirmed' });
        setStatus('Outcome unknown. Check the execution record before attempting any further action.');
      } else setStatus(r.message);
      setBusy(false);
      await loadPlan(plan.artifactId);
      return;
    }
    let e = r.data;
    const report = () => {
      if (alive.current) setExecution(e);
      notify.current?.({ kind: 'execution', execution: e });
    };
    report();
    for (let i = 0; i < MAX_POLLS && (e.status === 'reserved' || e.status === 'executing') && alive.current; i++) {
      await sleep(POLL_MS);
      const g = await getExecution(e.executionId);
      if (!g.ok) break; // still unknown to us; the server keeps the truth
      e = g.data;
      report();
    }
    setBusy(false);
    await loadPlan(plan.artifactId);
  };

  if (connectionsError) return <p role="alert">Connected apps could not be checked.{' '}
    <button className="pw-btn" type="button" onClick={() => setConnectionCheck((n) => n + 1)}>Check again</button>
  </p>;
  if (!enabled) return null;
  const dirty = plan?.actions.some((a) => JSON.stringify(drafts[a.index]) !== JSON.stringify({ enabled: a.enabled, args: a.arguments }));

  return (
    <section className="sg-plan" aria-label="AI action plan" data-testid="action-plan">
      <h3>AI action plan</h3>
      {!plan && (
        <>
          <p className="pw-muted">
            The AI looks at this screenshot and proposes what to do with your connected apps, or nothing.{' '}
            {providerMode === 'openai' ? 'This sends the screenshot to OpenAI.' : providerMode === 'fake' ? 'Fake AI: the plan is simulated and does not read your screenshot.' : ''}{' '}
            Nothing runs until you approve it and press Run.
          </p>
          {!canPlan && <p>Complete Revive to plan actions for this screenshot.</p>}
          <button type="button" className="pw-btn" disabled={busy || !canPlan} onClick={() => void start(false)}>Plan actions</button>
        </>
      )}
      {plan && (
        <>
          <p>
            <span className="pw-badge-text">{plan.decision === 'act' ? 'Proposed' : plan.decision === 'no_action' ? 'No action needed' : 'Needs your input'}</span>
            {plan.simulated && <span className="pw-badge-text"> Simulated apps</span>}
            {' '}<span className="pw-muted">Version {plan.versionNumber} · {plan.origin === 'manual_edit' ? 'edited by you' : `from ${plan.plannerProvider === 'openai' ? 'the AI' : 'the Fake AI'}`}</span>
          </p>
          <p data-testid="plan-rationale">{plan.rationale}</p>
          {plan.clarificationQuestion && <p role="note"><strong>Question:</strong> {plan.clarificationQuestion}</p>}
          {plan.actions.map((a) => {
            const execs = execution?.tool === a.tool
              ? [...a.deliveryHistory.filter((e) => e.executionId !== execution.executionId), execution]
              : a.deliveryHistory;
            const mine = execs.filter((e) => e.actionIndex === a.index && plan.executions.some((x) => x.executionId === e.executionId));
            const last = mine[mine.length - 1];
            // The server decides; this only hides Run where it would certainly refuse.
            const beforeDispatch = unresolvedDispatches.get(`${screenshotId}:${a.tool}`);
            const dispatchUnconfirmed = beforeDispatch !== undefined && !execs.some((entry) => entry.executionId > beforeDispatch);
            const blocked = dispatchUnconfirmed || execs.some((e) => UNRESOLVED.has(e.status)) || (last && last.status !== 'failed' && last.status !== 'cancelled');
            return (
              <article key={a.index} className="sg-plan__action" data-testid={`plan-action-${a.index}`}>
                <h4>{a.actionLabel}</h4>
                <p><em>Why:</em> {a.rationale} <span className="pw-muted">(confidence {Math.round(a.confidence * 100)}%)</span></p>
                <p className="pw-muted">Tool <code>{a.tool}</code> · version <code>{a.toolkitVersion}</code> · {a.destination ? `account connected${a.destination.simulated ? ' (simulated)' : ''}` : `${a.appLabel} not connected`}</p>
                {a.problems.length > 0 && <ul className="sg-plan__problems">{a.problems.map((p) => <li key={p.field}>{p.message}</li>)}</ul>}
                <ActionEditor action={a} draft={drafts[a.index]} disabled={busy || !plan.isCurrent}
                  onChange={(d) => setDrafts({ ...drafts, [a.index]: d })} />
                {a.toolArguments && (
                  <details open={emphasizeReview || undefined}><summary>{dirty ? 'Exact data from the saved version' : 'Exact data that would be sent'}</summary><pre>{JSON.stringify(a.toolArguments, null, 2)}</pre></details>
                )}
                {execs.map((e) => (
                  <ExecutionLine key={e.executionId} e={e} app={a.appLabel}
                    otherPlan={!plan.executions.some((x) => x.executionId === e.executionId)} />
                ))}
                {dispatchUnconfirmed && <div className="pw-row">
                  <p role="status">Outcome unknown. Run is unavailable until this dispatch can be reconciled.</p>
                  <button className="pw-btn" type="button" disabled={busy} onClick={() => void loadPlan(plan.artifactId)}>Check execution record</button>
                </div>}
                {plan.isCurrent && plan.approval.state === 'approved' && a.enabled && !blocked && !dirty && (
                  <div className="pw-row">
                    <label><input type="checkbox" checked={!!confirmRun[a.index]} onChange={(e) => setConfirmRun({ ...confirmRun, [a.index]: e.target.checked })} />
                      {' '}Create this in {a.appLabel} now{plan.simulated ? ' (simulated)' : ''}</label>
                    <button type="button" className="pw-btn" disabled={busy || !confirmRun[a.index]} onClick={() => void run(a.index)}>Run</button>
                  </div>
                )}
              </article>
            );
          })}
          {plan.decision === 'act' && (
            <div className="pw-row">
              <button type="button" className="pw-btn" disabled={busy || !dirty} onClick={() => void save()}>Save changes as a new version</button>
            </div>
          )}
          {plan.decision === 'act' && plan.approval.state !== 'approved' && !dirty && (
            <div className="sg-plan__approve">
              {plan.approvalReadiness.reasons.length > 0 && (
                <ul>{plan.approvalReadiness.reasons.map((r, i) => <li key={i}>{r.message}</li>)}</ul>
              )}
              {plan.approvalReadiness.requiredAcknowledgements.map((f) => (
                <label key={f}><input type="checkbox" checked={acks.includes(f)}
                  onChange={(e) => setAcks(e.target.checked ? [...acks, f] : acks.filter((x) => x !== f))} /> I checked the uncertain value {f}</label>
              ))}
              <label><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> I reviewed version {plan.versionNumber}</label>
              <button type="button" className="pw-btn" disabled={busy || !reviewed || !plan.approvalReadiness.eligible
                || acks.length !== plan.approvalReadiness.requiredAcknowledgements.length} onClick={() => void approve()}>Approve this version</button>
              <p className="pw-muted">Approving runs nothing. Each action then has its own Run button.</p>
            </div>
          )}
          {showHistory && <PlanHistory key={plan.versionId} artifactId={plan.artifactId} />}
          <p><button type="button" className="sg-link" disabled={busy || !canPlan} onClick={() => void start(true)}>Plan again</button></p>
        </>
      )}
      {status && <p role="status">{status}</p>}
    </section>
  );
}
