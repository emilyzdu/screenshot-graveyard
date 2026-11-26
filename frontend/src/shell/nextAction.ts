import { isAIAnalysisOrigin, type ResultProvider } from '../api/analysisOrigin';

/**
 * Next-action vocabulary and the conservative category → action rule for the
 * Live Workspace (Batch 3B).
 *
 * The backend has NO intent, suggestion or action-plan contract. What it does
 * return per screenshot is a classification `category` (one of six fixed
 * values), an `uncertain` flag, and an Epitaph (`text`, `visibleFacts`,
 * optional `inferredIntent`). This module maps ONLY the category, and only when
 * the classification is not marked uncertain, to at most one suggested action.
 *
 * It is a deterministic frontend rule, not a model recommendation, and the UI
 * must label it "rule-based". It never reads the Epitaph or inferred-intent text
 * (that would be re-interpreting free text in the browser) and never re-classifies.
 * Add to Calendar is never suggested: no category identifies an event.
 */
export type LiveActionId = 'make_notes' | 'add_calendar' | 'save_memory' | 'add_wishlist';

export const LIVE_ACTIONS: Record<LiveActionId, { label: string; hint: string }> = {
  make_notes: { label: 'Make Notes', hint: 'Turn it into study notes' },
  add_calendar: { label: 'Add to Calendar', hint: 'Turn it into a calendar event' },
  save_memory: { label: 'Save as Memory', hint: 'Keep it as a memory' },
  add_wishlist: { label: 'Add to Wishlist', hint: 'Keep it on a wishlist' },
};

export const LIVE_ACTION_ORDER: LiveActionId[] = ['make_notes', 'add_calendar', 'save_memory', 'add_wishlist'];

/** The six backend categories (`app/ai/schemas.py` Category). */
export type BackendCategory =
  | 'Study/Knowledge'
  | 'Reference/Document'
  | 'Shopping/Inspiration'
  | 'Memory/Entertainment'
  | 'Unknown/Needs Review'
  | 'Potentially Sensitive';

export type RuleSuggestion =
  | { kind: 'suggest'; action: LiveActionId; reason: string; source?: 'rule' | 'ai' }
  | { kind: 'none'; reason: string };

const RULE: Record<BackendCategory, RuleSuggestion> = {
  'Study/Knowledge': { kind: 'suggest', action: 'make_notes', reason: 'The category is Study/Knowledge.' },
  'Shopping/Inspiration': { kind: 'suggest', action: 'add_wishlist', reason: 'The category is Shopping/Inspiration.' },
  'Memory/Entertainment': { kind: 'suggest', action: 'save_memory', reason: 'The category is Memory/Entertainment.' },
  'Reference/Document': {
    kind: 'none',
    reason: 'Reference/Document does not point to one next step, so nothing is suggested.',
  },
  'Unknown/Needs Review': {
    kind: 'none',
    reason: 'The category is Unknown/Needs Review, so nothing is suggested. Check the screenshot yourself.',
  },
  'Potentially Sensitive': {
    kind: 'none',
    reason: 'It may contain sensitive details, so nothing is suggested. Choose only if you are comfortable.',
  },
};

/**
 * At most one suggestion, from the category alone. An uncertain classification,
 * or a category outside the fixed six, never yields a suggestion.
 */
export function suggestFromCategory(category: string, uncertain: boolean): RuleSuggestion {
  if (uncertain) {
    return { kind: 'none', reason: 'The classification is marked uncertain, so nothing is suggested.' };
  }
  const rule = Object.prototype.hasOwnProperty.call(RULE, category) ? RULE[category as BackendCategory] : undefined;
  return rule ?? { kind: 'none', reason: 'This category is not recognised, so nothing is suggested.' };
}

/**
 * Batch 6A (P2-D): categories that never get a suggested next step, from the
 * AI or the rule. Same policy as the server (`SUGGESTION_BLOCKED_CATEGORIES`):
 * an unknown classification must be checked by the user, and a possibly
 * sensitive one is never pushed toward an action. Applied here too, so an old
 * or malformed API answer cannot surface one.
 */
const SUGGESTION_BLOCKED: ReadonlySet<string> = new Set<BackendCategory>(['Unknown/Needs Review', 'Potentially Sensitive']);
export function aiSuggestionAllowed(category: string): boolean {
  return Object.prototype.hasOwnProperty.call(RULE, category) && !SUGGESTION_BLOCKED.has(category);
}

/**
 * Batch 6A: the real provider may suggest a next step from what it saw (e.g. a
 * visible event date -> Add to Calendar). That suggestion is used only when it
 * belongs to an AI-written classification that is not uncertain; it is labelled
 * as an AI suggestion. Otherwise the fixed category rule above applies.
 */
export function suggestNextStep(c: {
  category: string;
  uncertain: boolean;
  origin: unknown;
  suggestedAction?: 'make_notes' | 'add_calendar' | null;
}): RuleSuggestion {
  if (
    !c.uncertain &&
    isAIAnalysisOrigin(c.origin) &&
    aiSuggestionAllowed(c.category) &&
    (c.suggestedAction === 'make_notes' || c.suggestedAction === 'add_calendar')
  ) {
    return {
      kind: 'suggest',
      action: c.suggestedAction,
      reason: 'The AI suggested this from what it saw in the screenshot.',
      source: 'ai',
    };
  }
  return suggestFromCategory(c.category, c.uncertain);
}

/**
 * The user's choice for one screenshot. Transient UI state for Batch 3B: held by
 * LiveWorkspace for the page's lifetime, never sent to the server, and lost on
 * reload. `basis` records whether the user accepted the rule's suggestion or
 * picked something else, so the UI can say "Chosen by you" truthfully.
 */
export interface ActionChoice {
  action: LiveActionId;
  basis: 'accepted_suggestion' | 'your_choice';
  /** The category the choice was made against, to flag a later re-classification. */
  category: string | null;
}

/**
 * Provenance label for the EPITAPH only, from `analysis.epitaphOrigin` in the
 * GET /api/screenshots list summary. The list carries no category origin, so
 * this label must never be read as describing the category; it is prefixed
 * "Epitaph:" for that reason. Field-level origins come only from GET /analysis.
 */
export function epitaphProvenanceLabel(epitaphOrigin: unknown, provider: ResultProvider): string {
  // Batch 6A (P2-E): the provider recorded on the stored version, never the current mode.
  if (epitaphOrigin === 'manual_edit') return 'Epitaph: edited by you';
  if (!isAIAnalysisOrigin(epitaphOrigin)) return 'Epitaph: source unconfirmed';
  if (provider === 'fake') return 'Epitaph: simulated (Fake AI)';
  if (provider === 'openai') return 'Epitaph: AI result · can be wrong';
  return 'Epitaph: AI result · unknown provider';
}
