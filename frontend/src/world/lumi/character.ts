import type { Facing } from './lumiController';

export type LumiActivity = 'analyzing' | 'thinking' | 'delivering';
export type LumiReaction = 'greeting' | 'confused' | 'blessing' | 'celebrating' | 'concerned';
export type CharacterState = LumiActivity | LumiReaction | 'idle' | 'curious' | 'sleeping' | `moving-${Facing}`;
export const SLEEP_AFTER_MS = 35_000;

export function characterState(
  activity: LumiActivity | null, reaction: LumiReaction | null,
  moving: boolean, facing: Facing, idleMs: number, nearGhost: boolean,
): CharacterState {
  if (activity) return activity;
  if (reaction) return reaction;
  if (moving) return `moving-${facing}`;
  if (idleMs >= SLEEP_AFTER_MS) return 'sleeping';
  return nearGhost ? 'curious' : 'idle';
}

export const expressions: Partial<Record<CharacterState, string>> = {
  curious: '?', greeting: '♡', analyzing: '✧', thinking: '…', confused: '?',
  blessing: '✦', delivering: '✷', celebrating: '✦', concerned: '!', sleeping: 'z',
};
