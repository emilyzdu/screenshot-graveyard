import { describe, expect, it } from 'vitest';
import { aiSuggestionAllowed, suggestNextStep } from './nextAction';

// Batch 6A (P2-D): the same category policy as the server, enforced in the browser.
describe('AI suggestions respect the category policy', () => {
  const ai = (category: string, suggestedAction: unknown, extra: { uncertain?: boolean; origin?: string } = {}) =>
    suggestNextStep({
      category, uncertain: extra.uncertain ?? false, origin: extra.origin ?? 'ai_generate',
      suggestedAction: suggestedAction as 'make_notes' | 'add_calendar' | null,
    });

  it.each([
    ['Potentially Sensitive', 'add_calendar'],
    ['Potentially Sensitive', 'make_notes'],
    ['Unknown/Needs Review', 'add_calendar'],
    ['Unknown/Needs Review', 'make_notes'],
  ])('%s + %s: no actionable suggestion', (category, action) => {
    const s = ai(category, action);
    expect(s.kind).toBe('none');
  });

  it.each([
    ['Reference/Document', 'add_calendar'],
    ['Study/Knowledge', 'make_notes'],
    ['Study/Knowledge', 'add_calendar'],
  ])('%s + %s: allowed, labelled as AI', (category, action) => {
    expect(ai(category, action)).toMatchObject({ kind: 'suggest', action, source: 'ai' });
  });

  it.each([
    ['an unknown action', 'Reference/Document', 'buy_it'],
    ['a made-up category', 'Calendar/Event', 'add_calendar'],
    ['a non-string action', 'Reference/Document', 5],
  ])('a malformed result (%s) never yields an AI suggestion', (_n, category, action) => {
    const s = ai(category, action);
    expect(s.kind === 'suggest' && s.source === 'ai').toBe(false);
  });

  it('a corrected (manual) category or an uncertain result ignores the stored AI suggestion', () => {
    expect(ai('Reference/Document', 'add_calendar', { origin: 'manual_edit' })).toMatchObject({ kind: 'none' });
    expect(ai('Reference/Document', 'add_calendar', { uncertain: true })).toMatchObject({ kind: 'none' });
  });

  it('the blocked set matches the server', () => {
    expect(aiSuggestionAllowed('Potentially Sensitive')).toBe(false);
    expect(aiSuggestionAllowed('Unknown/Needs Review')).toBe(false);
    expect(aiSuggestionAllowed('Shopping/Inspiration')).toBe(true);
    expect(aiSuggestionAllowed('anything else')).toBe(false);
  });
});
