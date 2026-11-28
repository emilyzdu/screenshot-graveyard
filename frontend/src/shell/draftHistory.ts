import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApiFailure, ApiResult, FieldOrigins, VersionInfo } from '../api/ai';

/** What every persisted draft version has, whatever its kind. */
export interface DraftVersionBase {
  artifactId: number;
  versionId: number;
  versionNumber: number;
  origin: string;
  sourceScreenshotIds: number[];
  fieldOrigins?: FieldOrigins | null;
}

type HistoryState<V> =
  | { t: 'closed' }
  | { t: 'loading' }
  | { t: 'error' }
  | { t: 'open'; shown: V; current: V; versions: VersionInfo[] | null };

interface Options<V> {
  screenshotId: number;
  /** Read one version (`undefined` = current). Must be a GET. */
  loadVersion: (artifactId: number, versionId: number | undefined, f: typeof fetch) => Promise<ApiResult<V>>;
  listVersions: (artifactId: number, f: typeof fetch) => Promise<ApiResult<VersionInfo[]>>;
  read: () => typeof fetch;
  signal: () => AbortSignal;
}

/**
 * Read-only access to a draft's persisted versions (Batch 5A). Opens on the
 * CURRENT version; earlier versions can be shown without changing anything.
 * Every version shown must belong to this screenshot, or it is not shown.
 */
export function useDraftHistory<V extends DraftVersionBase>({ screenshotId, loadVersion, listVersions, read, signal }: Options<V>) {
  const [state, setState] = useState<HistoryState<V>>({ t: 'closed' });
  const ticket = useRef(0);
  const belongs = (v: V, artifactId: number) => v.artifactId === artifactId && v.sourceScreenshotIds.includes(screenshotId);

  /** Load (or reload, after a save) the current version and the version list. Read-only. */
  const open = async (artifactId: number) => {
    const mine = ++ticket.current;
    const lifetime = signal();
    setState({ t: 'loading' });
    let cur: ApiResult<V> | undefined;
    let list: ApiResult<VersionInfo[]> | undefined;
    try {
      [cur, list] = await Promise.all([loadVersion(artifactId, undefined, read()), listVersions(artifactId, read())]);
    } catch {
      cur = undefined; // a read that throws is reported as unreadable, never left loading
    }
    if (lifetime.aborted || mine !== ticket.current) return;
    if (!cur?.ok || !belongs(cur.data, artifactId)) {
      setState({ t: 'error' });
      return;
    }
    // A history that cannot be read does not hide the current version.
    setState({ t: 'open', shown: cur.data, current: cur.data, versions: list?.ok ? list.data : null });
  };

  /**
   * Show the current version and invalidate every read still in flight. Used
   * for "Back to current version" and when the panel is hidden, so a late
   * answer can never pull the view back to an older version (or an error).
   */
  const resetToCurrent = () => {
    ticket.current += 1;
    setState((s) => (s.t === 'open' ? { ...s, shown: s.current } : s));
  };

  /**
   * Show an earlier (or the current) version. Never writes. Each call is the
   * newest navigation intent: only ITS answer may change the view.
   */
  const show = async (versionId: number) => {
    if (state.t !== 'open') return;
    if (versionId === state.current.versionId) {
      resetToCurrent();
      return;
    }
    const mine = ++ticket.current;
    const lifetime = signal();
    let res: ApiResult<V> | undefined;
    try {
      res = await loadVersion(state.current.artifactId, versionId, read());
    } catch {
      res = undefined;
    }
    if (lifetime.aborted || mine !== ticket.current) return;
    if (res?.ok && belongs(res.data, state.current.artifactId) && res.data.versionId === versionId) {
      const shown = res.data;
      setState((s) => (s.t === 'open' ? { ...s, shown } : s));
    } else {
      setState({ t: 'error' });
    }
  };

  /** After a save: show the version the SERVER returned as current, then refresh the list. */
  const adopt = async (saved: V) => {
    if (!belongs(saved, saved.artifactId)) {
      setState({ t: 'error' });
      return;
    }
    const mine = ++ticket.current;
    const lifetime = signal();
    setState((s) => ({ t: 'open', shown: saved, current: saved, versions: s.t === 'open' ? s.versions : null }));
    let list: ApiResult<VersionInfo[]> | undefined;
    try {
      list = await listVersions(saved.artifactId, read());
    } catch {
      list = undefined;
    }
    if (lifetime.aborted || mine !== ticket.current) return;
    setState((s) => (s.t === 'open' ? { ...s, versions: list?.ok ? list.data : null } : s));
  };

  const close = () => {
    ticket.current += 1;
    setState({ t: 'closed' });
  };

  /**
   * Ignore every read still in flight. Called when editing starts, so a
   * history response requested earlier can never replace the active editor.
   */
  const cancelPending = () => {
    ticket.current += 1;
  };

  /**
   * Read the latest saved version WITHOUT changing what is shown (used while
   * an editor is open, so the form is never replaced). Null if unreadable.
   */
  const peekCurrent = async (artifactId: number): Promise<V | null> => {
    try {
      const res = await loadVersion(artifactId, undefined, read());
      return res.ok && belongs(res.data, artifactId) ? res.data : null;
    } catch {
      return null;
    }
  };

  return { state, open, show, adopt, close, cancelPending, resetToCurrent, peekCurrent };
}

/** The only version origins the server records. Anything else is shown as unknown, never guessed. */
export const KNOWN_ORIGINS = ['ai_generate', 'ai_redo', 'manual_edit'] as const;
export const isKnownOrigin = (origin: string): origin is (typeof KNOWN_ORIGINS)[number] =>
  (KNOWN_ORIGINS as readonly string[]).includes(origin);

export function originLabel(origin: string, provider: string | null): string {
  if (origin === 'manual_edit') return 'edited by you';
  if (origin === 'ai_redo') return provider === 'fake' ? 'regenerated by the Fake AI (simulated)' : 'regenerated by AI';
  if (origin === 'ai_generate') return provider === 'fake' ? 'simulated by the Fake AI' : 'generated by AI';
  return 'origin not recorded';
}

/** `uncertain`: the save may or may not have been stored (never claimed either way). */
export type SaveOutcomeText = { kind: 'info' | 'error'; text: string; uncertain?: boolean };

/**
 * One honest message per save failure. Only answers that prove nothing was
 * written (validation, conflict, archived, not found) say "not saved"; a server
 * error or a lost response may have been saved, so it says the status is
 * unknown. Saving again is the safe check: a save that already went through
 * comes back as "replayed" without a second version.
 */
/**
 * True when a failed save may still have been stored: no answer, a server
 * error, or a successful (2xx) answer whose body could not be read.
 */
export const isUnknownOutcome = (f: ApiFailure) => f.status === 0 || f.status >= 500 || (f.status >= 200 && f.status < 300);

const EARLIER_MAY_BE_SAVED = ' Your earlier save may still be in version history. Your edits are preserved.';

export function describeSaveFailure(f: ApiFailure, earlierUnknown = false): SaveOutcomeText {
  if (isUnknownOutcome(f)) {
    return {
      kind: 'error',
      uncertain: true,
      text: 'We could not confirm whether your changes were saved. Your changes are still here. Save again to check: if the first save went through, it is confirmed without creating a second version.',
    };
  }
  // After an unknown attempt, a rejection only proves THIS retry was not saved.
  if (earlierUnknown) {
    if (f.status === 409 && f.code === 'version_conflict') {
      return { kind: 'error', text: `This retry was rejected because the draft has changed.${EARLIER_MAY_BE_SAVED}` };
    }
    return { kind: 'error', text: `This retry was rejected.${EARLIER_MAY_BE_SAVED}` };
  }
  if (f.status === 409 && f.code === 'version_conflict') {
    return { kind: 'error', text: 'This draft was changed somewhere else (another tab or window) since you started editing. Your changes were not saved.' };
  }
  if (f.status === 409 && f.code === 'screenshot_archived') {
    return { kind: 'error', text: 'This screenshot is in The Crypt, so its drafts are read-only. Nothing was saved.' };
  }
  if (f.status === 400) return { kind: 'error', text: `${f.message} Nothing was saved.` };
  if (f.status === 404) return { kind: 'error', text: 'This draft could not be found in your workspace. Nothing was saved.' };
  return { kind: 'error', text: 'Your changes were not saved.' };
}

export function describeSaved(result: 'created' | 'replayed' | 'unchanged', versionNumber: number): SaveOutcomeText {
  if (result === 'unchanged') return { kind: 'info', text: 'No changes to save. Nothing new was created.' };
  if (result === 'replayed') return { kind: 'info', text: `Already saved as version ${versionNumber}. No duplicate was created.` };
  return { kind: 'info', text: `Saved as version ${versionNumber}. Earlier versions are kept in the history.` };
}

const NOT_CONFIRMED = 'The save status could not be confirmed.';

/**
 * "Check latest saved version" with freshness (shared by both editors).
 *
 * `fingerprint` must change whenever anything in the form that a Save would
 * send (or that could change it) changes. One request token guards every
 * answer: each check takes a new token, and every form change also advances
 * it, so an answer publishes only if it belongs to the newest check AND the
 * form has not changed since that check started. A form change also clears
 * any previous result, so a positive "already contains your edits" can only
 * ever describe the form that is visible now. Nothing publishes after unmount
 * (Cancel, Load latest or switching drafts unmount the editor). Never writes.
 */
export function useLatestCheck<V>(fingerprint: string) {
  const [checking, setChecking] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const ticket = useRef(0);
  const seen = useRef(fingerprint);
  const inFlight = useRef(false);

  // Unmount (Cancel, Load latest, switching drafts) makes every check in flight stale.
  useEffect(() => () => {
    ticket.current += 1;
  }, []);

  useLayoutEffect(() => {
    if (seen.current === fingerprint) return;
    seen.current = fingerprint;
    ticket.current += 1; // the form changed: every check in flight is now stale
    const wasChecking = inFlight.current;
    inFlight.current = false;
    setChecking(false);
    setText(wasChecking ? `${NOT_CONFIRMED} The form changed while checking. Check again.` : null);
  }, [fingerprint]);

  /**
   * `matches` compares the form as it is NOW (this call's snapshot) with the
   * latest saved version; it is only consulted if the form is still unchanged
   * when the answer arrives.
   */
  const check = async (
    read: () => Promise<V | null>,
    matches: (latest: V) => boolean,
    describe: (latest: V) => string,
  ) => {
    const mine = ++ticket.current;
    inFlight.current = true;
    setChecking(true);
    setText(null);
    let latest: V | null = null;
    try {
      latest = await read();
    } catch {
      latest = null;
    }
    if (mine !== ticket.current) return; // stale (newer check, form changed or unmounted): never publish
    inFlight.current = false;
    setChecking(false);
    if (latest === null) {
      setText(`${NOT_CONFIRMED} The latest saved version could not be read. Your edits are still here.`);
      return;
    }
    setText(`${describe(latest)} ${matches(latest) ? 'It already contains your edits.' : 'It does not contain exactly your edits.'}`);
  };

  return { checking, text, check };
}
