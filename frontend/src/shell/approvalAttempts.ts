import { useReducer, type Dispatch } from 'react';
import type { ApprovalRecord } from '../api/ai';

/**
 * Approval attempts of one draft panel, keyed by artifact + exact version.
 *
 * Owned by the draft panel (not by ApprovalSection), so the state survives the
 * section unmounting (Hide draft, editing, a new version) and a remounted
 * section renders it immediately. Every change is a reducer transition that
 * reads the CURRENT state, so a late callback can never overwrite a newer fact:
 *
 * 1. `confirmed` is final: no late, unknown or rejected answer downgrades it.
 * 2. Only an exact-version ledger record confirms (a POST answer or a status read).
 * 3. A failed status read changes nothing.
 * 4. A rejected retry never settles an earlier unknown outcome.
 * 5. Entries carry their artifactId; a section only reads its own artifact's.
 */
export type AttemptPhase = 'none' | 'unknown' | 'confirmed';
export type ConfirmedVia = 'created' | 'existing' | 'check' | 'ledger';

export interface ApprovalAttempt {
  artifactId: number;
  versionId: number;
  versionNumber: number;
  /** 'none': no attempt with an unknown outcome; 'unknown': one may have committed. */
  phase: AttemptPhase;
  /** The id of the POST currently out for this version, if any. */
  inFlight: number | null;
  /** A retry was definitely rejected while an earlier attempt is still unknown. */
  retryRejected: boolean;
  /** The exact ledger record, once confirmed. */
  record?: ApprovalRecord;
  confirmedVia?: ConfirmedVia;
  /** A definite rejection of the latest attempt (only while phase is 'none'). */
  rejection?: { text: string; conflict: boolean };
}

export type AttemptState = Readonly<Record<string, ApprovalAttempt>>;

type Target = { artifactId: number; versionId: number };
export type AttemptAction =
  | ({ type: 'start'; versionNumber: number; attemptId: number } & Target)
  | ({ type: 'answered'; attemptId: number; record: ApprovalRecord; result: 'created' | 'existing' } & Target)
  | ({ type: 'unknown'; attemptId: number } & Target)
  | ({ type: 'rejected'; attemptId: number; text: string; conflict: boolean } & Target)
  | { type: 'status'; artifactId: number; approvals: ApprovalRecord[] }
  | ({ type: 'dismiss' } & Target);

export const attemptKey = (artifactId: number, versionId: number) => `${artifactId}:${versionId}`;

let attemptCounter = 0;
export const nextAttemptId = () => ++attemptCounter;

function settle(a: ApprovalAttempt, attemptId: number): ApprovalAttempt {
  return a.inFlight === attemptId ? { ...a, inFlight: null } : a;
}

export function attemptsReducer(state: AttemptState, action: AttemptAction): AttemptState {
  if (action.type === 'status') {
    let next: Record<string, ApprovalAttempt> | null = null;
    for (const [key, a] of Object.entries(state)) {
      if (a.artifactId !== action.artifactId || a.phase === 'confirmed') continue;
      const record = action.approvals.find((r) => r.artifactId === a.artifactId && r.versionId === a.versionId);
      if (!record) continue; // no record yet proves nothing
      next ??= { ...state };
      const via: ConfirmedVia = a.phase === 'unknown' || a.inFlight !== null ? 'check' : 'ledger';
      next[key] = { ...a, phase: 'confirmed', record, confirmedVia: via, retryRejected: false, rejection: undefined };
    }
    return next ?? state;
  }

  const key = attemptKey(action.artifactId, action.versionId);
  const a = state[key];
  switch (action.type) {
    case 'start': {
      if (a?.phase === 'confirmed') return state;
      const base: ApprovalAttempt = a ?? {
        artifactId: action.artifactId, versionId: action.versionId, versionNumber: action.versionNumber,
        phase: 'none', inFlight: null, retryRejected: false,
      };
      return { ...state, [key]: { ...base, inFlight: action.attemptId, rejection: undefined } };
    }
    case 'answered': {
      if (!a) return state;
      const exact = action.record.artifactId === a.artifactId && action.record.versionId === a.versionId;
      if (!exact) {
        // A success for some other version says nothing about this one.
        if (a.phase === 'confirmed') return { ...state, [key]: settle(a, action.attemptId) };
        return { ...state, [key]: { ...settle(a, action.attemptId), phase: 'unknown', retryRejected: false, rejection: undefined } };
      }
      if (a.phase === 'confirmed') return { ...state, [key]: settle(a, action.attemptId) };
      return {
        ...state,
        [key]: {
          ...settle(a, action.attemptId), phase: 'confirmed', record: action.record,
          confirmedVia: action.result, retryRejected: false, rejection: undefined,
        },
      };
    }
    case 'unknown': {
      if (!a) return state;
      if (a.phase === 'confirmed') return { ...state, [key]: settle(a, action.attemptId) };
      return { ...state, [key]: { ...settle(a, action.attemptId), phase: 'unknown', retryRejected: false, rejection: undefined } };
    }
    case 'rejected': {
      if (!a) return state;
      if (a.phase === 'confirmed') return { ...state, [key]: settle(a, action.attemptId) };
      if (a.phase === 'unknown') return { ...state, [key]: { ...settle(a, action.attemptId), retryRejected: true } };
      return { ...state, [key]: { ...settle(a, action.attemptId), rejection: { text: action.text, conflict: action.conflict } } };
    }
    case 'dismiss': {
      if (!a?.rejection) return state;
      return { ...state, [key]: { ...a, rejection: undefined } };
    }
  }
}

export interface ApprovalAttempts {
  state: AttemptState;
  dispatch: Dispatch<AttemptAction>;
}

/** Panel-level owner of approval attempts (CalendarDraft / MakeNotesDraft). */
export function useApprovalAttempts(): ApprovalAttempts {
  const [state, dispatch] = useReducer(attemptsReducer, {});
  return { state, dispatch };
}
