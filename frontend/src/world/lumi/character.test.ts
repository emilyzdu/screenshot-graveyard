import { describe, expect, it } from 'vitest';
import { characterState, SLEEP_AFTER_MS } from './character';

describe('Lumi animation priority', () => {
  it('keeps server activity ahead of reactions, motion, and inactivity', () => {
    expect(characterState('delivering', 'greeting', true, 'left', SLEEP_AFTER_MS, true)).toBe('delivering');
    expect(characterState('analyzing', 'confused', false, 'down', SLEEP_AFTER_MS, true)).toBe('analyzing');
    expect(characterState(null, 'blessing', true, 'up', 0, false)).toBe('blessing');
  });

  it('uses directions, proximity, and sleep when there is no active work', () => {
    expect(characterState(null, null, true, 'left', 0, true)).toBe('moving-left');
    expect(characterState(null, null, false, 'left', 0, true)).toBe('curious');
    expect(characterState(null, null, false, 'up', SLEEP_AFTER_MS, true)).toBe('sleeping');
    expect(characterState(null, null, false, 'up', 0, false)).toBe('idle');
  });
});
