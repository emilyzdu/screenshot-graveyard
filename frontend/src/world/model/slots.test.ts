import { describe, expect, it } from 'vitest';
import type { GhostView } from './ghostView';
import { layoutGhosts, MAX_GHOSTS } from './slots';

const ghost = (id: number, location: GhostView['location'] = 'well'): GhostView => ({
  id, filename: `${id}.png`, location, label: '', category: null, epitaph: null, badge: 'none', tint: 0, accessory: 0, isDuplicate: false, uploadedAt: '',
});

describe('layoutGhosts', () => {
  it('is deterministic and independent of input order', () => {
    const a = layoutGhosts([ghost(3), ghost(1), ghost(2)]);
    const b = layoutGhosts([ghost(1), ghost(2), ghost(3)]);
    expect(a).toEqual(b);
  });
  it('never overlaps slots inside a location', () => {
    const l = layoutGhosts(Array.from({ length: 24 }, (_, i) => ghost(i + 1)));
    const keys = new Set(l.placed.map((p) => `${p.slot.x},${p.slot.y}`));
    expect(keys.size).toBe(24);
  });
  it('collapses the 25th ghost and beyond into one crowd marker with the count', () => {
    const l = layoutGhosts(Array.from({ length: 30 }, (_, i) => ghost(i + 1)));
    expect(l.placed).toHaveLength(MAX_GHOSTS);
    expect(l.crowds).toHaveLength(1);
    expect(l.crowds[0]).toMatchObject({ location: 'well', count: 6 });
  });
});
