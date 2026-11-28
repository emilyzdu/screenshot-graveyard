import { describe, expect, it } from 'vitest';
import { LOCATIONS, STAGE } from '../model/locations';
import { platePosition } from './platePosition';

describe('location name plates', () => {
  it.each(LOCATIONS.map((l) => [l.id, l] as const))('%s plate stays inside the stage', (_id, l) => {
    const p = platePosition(l.sprite);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y + 16).toBeLessThanOrEqual(STAGE.h);
    expect(p.x - 44).toBeGreaterThanOrEqual(0);
    expect(p.x + 44).toBeLessThanOrEqual(STAGE.w);
  });
  it('keeps the plate just above sprites that leave room, and clamps the tall Clock Tower', () => {
    expect(platePosition({ x: 292, y: 132, w: 56, h: 56 })).toEqual({ x: 320, y: 120 });
    const tower = LOCATIONS.find((l) => l.id === 'tower')!;
    expect(platePosition(tower.sprite).y).toBeGreaterThanOrEqual(3);
  });
});
