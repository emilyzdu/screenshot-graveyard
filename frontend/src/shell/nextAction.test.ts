import { describe, expect, it } from 'vitest';
import { LIVE_ACTION_ORDER, suggestFromCategory } from './nextAction';

describe('suggestFromCategory (conservative, rule-based)', () => {
  it.each([
    ['Study/Knowledge', 'make_notes'],
    ['Shopping/Inspiration', 'add_wishlist'],
    ['Memory/Entertainment', 'save_memory'],
  ])('%s → %s', (category, action) => {
    expect(suggestFromCategory(category, false)).toMatchObject({ kind: 'suggest', action });
  });

  it.each(['Reference/Document', 'Unknown/Needs Review', 'Potentially Sensitive'])('%s → no suggestion', (category) => {
    expect(suggestFromCategory(category, false).kind).toBe('none');
  });

  it('never suggests anything for an uncertain classification', () => {
    for (const c of ['Study/Knowledge', 'Shopping/Inspiration', 'Memory/Entertainment']) {
      expect(suggestFromCategory(c, true)).toMatchObject({ kind: 'none', reason: expect.stringMatching(/uncertain/) });
    }
  });

  it('never suggests for an unrecognised category and never suggests Add to Calendar', () => {
    expect(suggestFromCategory('Event/Poster', false).kind).toBe('none');
    const all = ['Study/Knowledge', 'Reference/Document', 'Shopping/Inspiration', 'Memory/Entertainment', 'Unknown/Needs Review', 'Potentially Sensitive'];
    for (const c of all) {
      const r = suggestFromCategory(c, false);
      if (r.kind === 'suggest') expect(r.action).not.toBe('add_calendar');
    }
    expect(LIVE_ACTION_ORDER).toContain('add_calendar'); // still choosable by the user
  });
});
