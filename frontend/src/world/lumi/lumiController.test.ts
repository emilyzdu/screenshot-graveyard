import { describe, expect, it } from 'vitest';
import { LUMI_SPEED, initialLumi, isIdle, step, type LumiState } from './lumiController';

const run = (s: LumiState, input: { dx: number; dy: number }, ms: number, colliders = [] as { x: number; y: number; w: number; h: number }[]) => {
  for (let t = 0; t < ms; t += 20) s = step(s, input, 20, colliders);
  return s;
};

describe('lumiController', () => {
  it('moves 72px in one second', () => {
    const s = run(initialLumi(100, 200), { dx: 1, dy: 0 }, 1000);
    expect(s.x - 100).toBeCloseTo(LUMI_SPEED, 0);
    expect(s.facing).toBe('right');
  });
  it('normalises diagonals', () => {
    const s = run(initialLumi(100, 200), { dx: 1, dy: 1 }, 1000);
    expect(Math.hypot(s.x - 100, s.y - 200)).toBeGreaterThan(71);
    expect(Math.hypot(s.x - 100, s.y - 200)).toBeLessThan(73);
  });
  it('never enters a collider and slides along it', () => {
    const wall = { x: 150, y: 150, w: 20, h: 200 };
    const s = run(initialLumi(120, 200), { dx: 1, dy: 1 }, 1500, [wall]);
    expect(s.x + 5).toBeLessThanOrEqual(150);
    expect(s.y).toBeGreaterThan(200);
  });
  it('stays inside the bounds', () => {
    const s = run(initialLumi(100, 200), { dx: -1, dy: -1 }, 5000);
    expect(s.x).toBeGreaterThanOrEqual(12);
    expect(s.y).toBeGreaterThanOrEqual(150);
  });
  it('follows the last intent for facing and idles after 2000 ms without input', () => {
    let s = run(initialLumi(300, 200), { dx: 0, dy: -1 }, 100);
    expect(s.facing).toBe('up');
    s = run(s, { dx: 0, dy: 0 }, 1900);
    expect(isIdle(s)).toBe(false);
    s = run(s, { dx: 0, dy: 0 }, 200);
    expect(isIdle(s)).toBe(true);
    expect(s.facing).toBe('up');
  });
});
