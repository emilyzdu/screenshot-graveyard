import { isAIAnalysisOrigin, type ResultProvider } from '../api/analysisOrigin';
import type { ApiFailure, OperationStatus, ProviderMode } from '../api/ai';

/** Plain-language text for a failed AI request (never shows raw server detail). */
/**
 * Deployment foundation: a 429 has three different causes. Each gets its own
 * truthful text (the server's error code decides; the status alone does not).
 * `null` for the per-workspace quota (callers keep their existing wording) and
 * for anything that is not a 429.
 */
export function describeLimitFailure(f: ApiFailure, nothing: string): string | null {
  if (f.status !== 429) return null;
  if (f.code === 'ai_budget_reached') {
    return `The app\u2019s daily AI limit has been reached. ${nothing} Please try again tomorrow, or explore the demo (add ?demo=1 to the address).`;
  }
  if (f.code === 'rate_limited') return `Too many requests in a short time. ${nothing} Please wait a moment and try again.`;
  return null;
}

export function describeRequestFailure(f: ApiFailure): string {
  switch (f.status) {
    case 400:
      return f.code === 'invalid_selection'
        ? f.message
        : 'That request was not valid. Please check it and try again.';
    case 403:
      return 'AI consent is required first. Nothing was processed.';
    case 404:
      return 'That screenshot could not be found in your workspace.';
    case 429:
      return describeLimitFailure(f, 'Nothing was processed.') ??
        'You have used up this workspace\u2019s AI request allowance. Nothing was processed.';
    case 503:
      return 'The service is temporarily unavailable. Please try again shortly.';
    case 0:
      return 'Could not reach the server. Check your connection and try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/** Plain-language text for a finished operation. */
export function describeOperationOutcome(
  status: OperationStatus,
  errorDetail: string | null,
): string {
  if (status === 'successful') return 'Finished.';
  if (status === 'uncertain') {
    return 'The AI was not sure about this one, so no result was saved. Your screenshot is unchanged.';
  }
  if (status === 'pending') return 'Working\u2026';
  switch (errorDetail) {
    case 'AI processing consent required':
      return 'AI consent is missing or was withdrawn, so nothing was saved. If the request had already been sent before the withdrawal, the AI provider may have received it; its result was discarded.';
    case 'AI analysis timed out':
      return 'The AI provider did not answer in time. Nothing was saved and your screenshot is unchanged. The provider may still have received the request.';
    case 'AI provider busy; try again later':
      return 'The AI provider is busy right now. Nothing was saved. Try again in a little while.';
    case 'AI operation quota exceeded':
      return 'This workspace\u2019s AI request allowance is used up.';
    case 'AI output failed validation':
    case 'AI output references invalid':
      return 'The AI returned a result we could not trust, so nothing was saved.';
    case 'Processing interrupted; please retry':
      return 'The work was interrupted before it finished. Please try again.';
    case 'Not found':
      return 'A selected screenshot could not be found.';
    case 'AI input exceeds configured limits':
      return 'The selection is too large for one AI request.';
    case 'AI analysis failed':
    case 'AI processing unavailable':
      return 'The AI analysis did not complete (this includes timeouts). Nothing was saved and your screenshot is unchanged.';
    default:
      return 'The work failed. Nothing was saved and your screenshot is unchanged.';
  }
}

/**
 * Honest provenance wording for a persisted AI/manual value. In fake mode the
 * "AI" output is a deterministic placeholder that never looked at the image, so it
 * must not be presented as genuine understanding (Task 4.1).
 */
export function describeOrigin(origin: unknown, provider: ProviderMode | 'unknown'): string {
  if (origin === 'manual_edit') return 'edited by you';
  if (!isAIAnalysisOrigin(origin)) return 'source unconfirmed';
  const verb = origin === 'ai_redo' ? 'regenerated' : 'generated';
  if (provider === 'fake') return `${verb} by the demo AI (placeholder text, not real image understanding)`;
  if (provider === 'openai') return `${verb} by AI (a suggestion; it can be wrong)`;
  return `${verb} by AI`;
}

/**
 * AI versions write these fields together. A text edit retains the old auxiliary
 * values without recording their original provenance on the new version.
 */
export function describeEpitaphAuxiliaryOrigin(origin: unknown, provider: ProviderMode | 'unknown'): string {
  return isAIAnalysisOrigin(origin) ? describeOrigin(origin, provider) : 'field source unavailable';
}

/** Poll requests failed, so the real state of the operation is not known. */
export const STATUS_UNAVAILABLE_TEXT =
  'Status temporarily unavailable. The analysis may still be running or may have finished. Nothing is assumed either way.';

/** Shown wherever archiving is offered or explained. */
export const CRYPT_GALLERY_NOTE =
  'Archiving in The Crypt does not remove the photo from your phone gallery. It only moves it inside Screenshot Graveyard.';

/**
 * Batch 6A (P2-E): provenance from the provider recorded on the STORED version,
 * never from the current provider mode. `null` = not recorded (an older
 * version), which is said plainly rather than guessed.
 */
export function describeResultOrigin(origin: unknown, provider: ResultProvider): string {
  if (origin === 'manual_edit') return 'edited by you';
  if (!isAIAnalysisOrigin(origin)) return 'source unconfirmed';
  const verb = origin === 'ai_redo' ? 'regenerated' : 'generated';
  if (provider === 'fake') return `${verb} by the demo AI (placeholder text, not real image understanding)`;
  if (provider === 'openai') return `${verb} by AI (a suggestion; it can be wrong)`;
  return `${verb} by AI (unknown provider: not recorded for this version)`;
}

export function describeAuxiliaryResultOrigin(origin: unknown, provider: ResultProvider): string {
  return isAIAnalysisOrigin(origin) ? describeResultOrigin(origin, provider) : 'field source unavailable';
}
