import { getOperation } from '../api/ai';
import type { PollOutcome } from './pollOperation';

/**
 * Module-level registry of Revive (classify) work per screenshot, shared by the
 * Quiet Assistant and the Screenshot Detail panel so the same screenshot is never
 * submitted twice while an earlier submission is unresolved. Different screenshot
 * ids are independent. The registry only guards the browser; the backend still
 * enforces consent, quota and operation checks.
 *
 * Phases:
 * - submitting: classify request sent, no operation id yet
 * - active: accepted and being polled by its owner
 * - unresolved: the owner stopped (timeout, status unavailable, closed). The
 *   operation id is kept and must be reconciled before another submission.
 * - reconciling: a getOperation check for an unresolved entry is in flight
 */
type Phase = 'submitting' | 'active' | 'unresolved' | 'reconciling';

interface Entry {
  phase: Phase;
  operationId: number | null;
}

const entries = new Map<number, Entry>();

/**
 * Revives the server confirmed as `successful` (or that a persisted analysis
 * proved), with the operation id when known. Module-level like `entries`, so it
 * survives any component unmounting: drawer close/reopen, Safe Burial and
 * Resurrection. Keyed by screenshot id, which is a single-column primary key in
 * the backend (globally unique across workspaces), so ids from different
 * workspaces cannot collide. Entries are never removed during the page's
 * lifetime: a later 404 or failed GET /analysis is not evidence that a confirmed
 * operation did not complete.
 */
const succeeded = new Map<number, { operationId: number | null }>();

export type AcquireResult =
  | { ok: true }
  | { ok: false; reason: 'in_flight' | 'unresolved' | 'succeeded'; operationId: number | null };

export type ReconcileResult =
  | { kind: 'terminal'; outcome: Extract<PollOutcome, { kind: 'done' }> }
  | { kind: 'gone' }
  | { kind: 'pending' }
  | { kind: 'unavailable' };

/** Read the registry (for tests and UI hints). */
export function getReviveEntry(screenshotId: number): Readonly<Entry> | undefined {
  return entries.get(screenshotId);
}

/** Test helper: forget everything. */
export function resetReviveCoordinator(): void {
  entries.clear();
  succeeded.clear();
}

/** Record a confirmed successful Revive. Keeps a known operation id; never replaces it with "unknown". */
export function recordReviveSuccess(screenshotId: number, operationId: number | null): void {
  const existing = succeeded.get(screenshotId);
  succeeded.set(screenshotId, { operationId: operationId ?? existing?.operationId ?? null });
}

/** The confirmed success for this screenshot, if any. */
export function getReviveSuccess(screenshotId: number): Readonly<{ operationId: number | null }> | undefined {
  return succeeded.get(screenshotId);
}

/** One getOperation check for a kept operation id. Releases the entry when it is final. */
export async function reconcileRevive(screenshotId: number): Promise<ReconcileResult> {
  const entry = entries.get(screenshotId);
  if (!entry || entry.operationId === null) return { kind: 'unavailable' };
  const opId = entry.operationId;
  const res = await getOperation(opId);
  const cur = entries.get(screenshotId);
  const mine = cur !== undefined && cur.operationId === opId;
  if (res.ok && res.data.status !== 'pending') {
    if (mine) entries.delete(screenshotId);
    // This operation belonged to this screenshot: a `successful` answer is a
    // confirmed success, kept with its id for every later check and entry point.
    if (res.data.status === 'successful') recordReviveSuccess(screenshotId, opId);
    return {
      kind: 'terminal',
      outcome: {
        kind: 'done',
        status: res.data.status,
        errorDetail: res.data.errorDetail,
        artifactId: res.data.artifactId,
      },
    };
  }
  if (!res.ok && res.status === 404) {
    if (mine) entries.delete(screenshotId);
    return { kind: 'gone' };
  }
  if (mine) cur.phase = 'unresolved';
  return res.ok ? { kind: 'pending' } : { kind: 'unavailable' };
}

/**
 * Take the right to submit a classification for this screenshot. If an earlier
 * operation is unresolved it is reconciled first; submission is allowed only when
 * that operation is final.
 */
export async function acquireRevive(screenshotId: number): Promise<AcquireResult> {
  // A confirmed success is final: never submit a second classification for it.
  const done = succeeded.get(screenshotId);
  if (done) return { ok: false, reason: 'succeeded', operationId: done.operationId };
  const entry = entries.get(screenshotId);
  if (!entry) {
    entries.set(screenshotId, { phase: 'submitting', operationId: null });
    return { ok: true };
  }
  if (entry.phase !== 'unresolved') {
    return { ok: false, reason: 'in_flight', operationId: entry.operationId };
  }
  const opId = entry.operationId;
  // Unknown outcome with no id (see markReviveOutcomeUnknown): there is nothing to
  // reconcile here, and the entry must stay `unresolved` for the caller's own check.
  if (opId === null) return { ok: false, reason: 'unresolved', operationId: null };
  entry.phase = 'reconciling';
  const r = await reconcileRevive(screenshotId);
  if (r.kind === 'terminal' && r.outcome.status === 'successful') {
    // The earlier operation already did the work: refuse, keep its identity.
    return { ok: false, reason: 'succeeded', operationId: opId };
  }
  // failed / uncertain (terminal, nothing saved) or gone (404): a new submission is allowed.
  if (r.kind === 'terminal' || r.kind === 'gone') {
    entries.set(screenshotId, { phase: 'submitting', operationId: null });
    return { ok: true };
  }
  return { ok: false, reason: 'unresolved', operationId: opId };
}

/** The server accepted the submission. */
export function markReviveActive(screenshotId: number, operationId: number): void {
  entries.set(screenshotId, { phase: 'active', operationId });
}

/** The owner stopped watching but the operation may still run. Keeps the id. */
export function markReviveUnresolved(screenshotId: number): void {
  const e = entries.get(screenshotId);
  if (e && e.operationId !== null) e.phase = 'unresolved';
  else if (e) entries.delete(screenshotId);
}

/**
 * The classify request got no usable answer (network error, 5xx, malformed
 * body), so the server may or may not have accepted it and there is no
 * operation id to poll. Keep the entry blocked: `acquireRevive` cannot reconcile
 * an entry without an id, so it refuses until `releaseRevive` is called after
 * the caller has seen authoritative evidence (for example a persisted analysis).
 */
export function markReviveOutcomeUnknown(screenshotId: number): void {
  entries.set(screenshotId, { phase: 'unresolved', operationId: null });
}

/** Terminal state reached, or the submission was rejected. */
export function releaseRevive(screenshotId: number): void {
  entries.delete(screenshotId);
}

export const REVIVE_IN_FLIGHT_TEXT =
  'This screenshot is already being revived elsewhere. Wait for that to finish before starting another.';
export const REVIVE_SUCCEEDED_TEXT =
  'Revive already finished for this screenshot, so nothing new was started. Its saved result is loaded instead.';

/**
 * Wording for a refusal that means "wait". Deliberately does NOT accept
 * 'succeeded': every caller must handle an already successful operation itself
 * (load its result) instead of showing it as a problem.
 */
export function reviveWaitText(reason: 'in_flight' | 'unresolved'): string {
  switch (reason) {
    case 'in_flight':
      return REVIVE_IN_FLIGHT_TEXT;
    case 'unresolved':
      return REVIVE_UNRESOLVED_TEXT;
  }
}

export const REVIVE_UNRESOLVED_TEXT =
  'An earlier Revive for this screenshot has not been confirmed as finished yet. Nothing new was started. Try again shortly.';
