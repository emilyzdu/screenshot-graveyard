import type { Analysis, ApiResult } from '../api/ai';
import type { Screenshot, ScreenshotAnalysis } from '../api/client';
import { suggestNextStep, type RuleSuggestion } from './nextAction';

/** Stable identity of a list-summary analysis (the GET /api/screenshots snapshot). */
export const summaryKey = (summary: ScreenshotAnalysis) =>
  JSON.stringify([summary.category, summary.uncertain, summary.epitaph, summary.epitaphOrigin]);

/** The list-summary shape of a full analysis, for comparison and for cards. */
export function summarize(analysis: Analysis): ScreenshotAnalysis {
  return {
    category: analysis.classification.category,
    uncertain: analysis.classification.uncertain,
    epitaph: analysis.epitaph.text,
    epitaphOrigin: analysis.epitaph.origin,
    epitaphProvider: analysis.epitaph.provider ?? null,
  };
}

/**
 * pending: the latest started read has not answered yet
 * success: the latest read answered with an analysis for THIS screenshot
 * failed:  the latest read failed (404 `missing`, or any other error/abort)
 * invalid: the latest read answered 200 with another screenshot's id
 */
export type ReadStatus = 'pending' | 'success' | 'failed' | 'invalid';

export interface AuthorityEntry {
  /** Ticket of the LATEST STARTED read for this screenshot. */
  ticket: number;
  status: ReadStatus;
  /** Present only when the latest read succeeded. Never a leftover from an older read. */
  analysis?: Analysis;
  /** For `failed`: whether the server said 404. */
  missing?: boolean;
  /** The list-summary key the latest read was made against. */
  listKey: string;
}

/**
 * One workspace's shared authority for analysis reads (Batch 3B).
 *
 * Every reader of `GET /api/screenshots/{id}/analysis` (the assistant's
 * validated read and the Revive drawer) calls `begin()` BEFORE sending its
 * request. That immediately makes the new request the latest one for the
 * screenshot, status `pending`, with no payload, so an earlier success stops
 * authorizing suggestions at once. `resolve()` is accepted only from the latest
 * started request: an older response can never set the status or payload, and
 * a failed newer request can never fall back to an older success. A 200 for
 * another screenshot id is `invalid`. One store per LiveWorkspace mount, so
 * nothing crosses workspaces; entries persist across drawer close.
 */
export interface AnalysisAuthority {
  begin(screenshotId: number, listKey: string): number;
  resolve(screenshotId: number, ticket: number, result: ApiResult<Analysis>): boolean;
  get(screenshotId: number): AuthorityEntry | undefined;
  subscribe(listener: () => void): () => void;
  version(): number;
}

export function createAnalysisAuthority(): AnalysisAuthority {
  let counter = 0;
  let version = 0;
  const entries = new Map<number, AuthorityEntry>();
  const listeners = new Set<() => void>();
  const changed = () => {
    version += 1;
    listeners.forEach((l) => l());
  };
  return {
    begin: (screenshotId, listKey) => {
      const ticket = ++counter;
      entries.set(screenshotId, { ticket, status: 'pending', listKey });
      changed();
      return ticket;
    },
    resolve: (screenshotId, ticket, result) => {
      const current = entries.get(screenshotId);
      // Only the latest started request may settle the state.
      if (!current || current.ticket !== ticket) return false;
      let next: AuthorityEntry;
      if (!result.ok) {
        next = { ticket, status: 'failed', missing: result.status === 404, listKey: current.listKey };
      } else if (result.data.screenshotId !== screenshotId) {
        next = { ticket, status: 'invalid', listKey: current.listKey };
      } else {
        next = { ticket, status: 'success', analysis: result.data, listKey: current.listKey };
      }
      entries.set(screenshotId, next);
      changed();
      return true;
    },
    get: (screenshotId) => entries.get(screenshotId),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}

export const CURRENT_ANALYSIS_NEEDED = 'A current, consistent analysis is needed before suggesting a next step.';

/**
 * The ONE eligibility check for an automatic suggestion, used both when
 * rendering and at click time. A suggestion is possible only if the shot is an
 * active screenshot of this workspace's current gallery, the latest read for it
 * succeeded with a matching id, and that analysis agrees with the gallery
 * summary. The category rule then decides (sensitive, unknown and uncertain
 * never suggest). Anything else: no suggestion.
 */
export function currentSuggestionRule(authority: AnalysisAuthority, shot: Screenshot | undefined): RuleSuggestion {
  if (!shot || shot.state !== 'active' || !shot.analysis) return { kind: 'none', reason: CURRENT_ANALYSIS_NEEDED };
  const entry = authority.get(shot.screenshotId);
  const latest = entry?.status === 'success' ? entry.analysis : undefined;
  if (!latest || latest.screenshotId !== shot.screenshotId) return { kind: 'none', reason: CURRENT_ANALYSIS_NEEDED };
  if (summaryKey(summarize(latest)) !== summaryKey(shot.analysis)) return { kind: 'none', reason: CURRENT_ANALYSIS_NEEDED };
  return suggestNextStep(latest.classification);
}
