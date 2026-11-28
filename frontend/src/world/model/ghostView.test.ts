import { describe, expect, it } from 'vitest';
import type { Screenshot } from '../../api/client';
import { deriveGhostViewM1, deriveGhostViews, hash, TINT_COUNT } from './ghostView';

const shot = (id: number, over: Partial<Screenshot> = {}): Screenshot => ({
  screenshotId: id, state: 'active', mimeType: 'image/png', originalFilename: `s${id}.png`, isDuplicate: false,
  duplicateOf: null, byteSize: 1, uploadedAt: '2026-01-01T00:00:00Z', analysis: null, ...over,
});
const analysis = (category: string) => ({ category, uncertain: false, epitaph: 'e', epitaphOrigin: 'ai_generate' });

describe('ghostView', () => {
  it('maps each active screenshot to one view and drops archived ones', () => {
    const views = deriveGhostViews([shot(1), shot(2, { state: 'archived' }), shot(3)]);
    expect(views.map((v) => v.id)).toEqual([1, 3]);
  });
  it('places unanalyzed ghosts at the well and analyzed ones at the crossroads', () => {
    expect(deriveGhostViewM1(shot(1))).toMatchObject({ location: 'well', label: 'Not analyzed yet', badge: 'none' });
    expect(deriveGhostViewM1(shot(2, { analysis: analysis('Study/Knowledge') }))).toMatchObject({ location: 'crossroads', label: 'Analyzed', badge: 'book' });
    expect(deriveGhostViewM1(shot(3, { analysis: analysis('Potentially Sensitive') }))?.badge).toBe('lock');
    expect(deriveGhostViewM1(shot(4, { analysis: analysis('Unknown/Needs Review') }))?.badge).toBe('question');
    expect(deriveGhostViewM1(shot(5, { analysis: analysis('Shopping/Inspiration') }))?.badge).toBe('image');
  });
  it('keeps tint and accessory stable and uses all tints for ids 1..500', () => {
    expect(deriveGhostViewM1(shot(7))).toEqual(deriveGhostViewM1(shot(7)));
    expect(hash(7)).toBe(hash(7));
    const tints = new Set<number>();
    for (let i = 1; i <= 500; i++) tints.add(deriveGhostViewM1(shot(i))!.tint);
    expect(tints.size).toBe(TINT_COUNT);
  });
  it('gives a duplicate its own marked view', () => {
    const v = deriveGhostViews([shot(1), shot(2, { isDuplicate: true, duplicateOf: 1 })]);
    expect(v).toHaveLength(2);
    expect(v[1].isDuplicate).toBe(true);
  });
});
