import { LUMI_FOOT, WALK_BOUNDS, type Rect } from '../model/locations';

export const LUMI_SPEED = 72; // logical px per second
export const IDLE_AFTER_MS = 2000;

export type Facing = 'down' | 'up' | 'left' | 'right';
export interface LumiState { x: number; y: number; facing: Facing; moving: boolean; idleMs: number }
export interface LumiInput { dx: number; dy: number }

export const initialLumi = (x: number, y: number): LumiState => ({ x, y, facing: 'down', moving: false, idleMs: 0 });
export const isIdle = (s: LumiState) => s.idleMs >= IDLE_AFTER_MS;

function hits(x: number, y: number, rects: readonly Rect[]): boolean {
  const l = x - LUMI_FOOT.w / 2, r = x + LUMI_FOOT.w / 2, t = y - LUMI_FOOT.h, b = y;
  return rects.some((c) => l < c.x + c.w && r > c.x && t < c.y + c.h && b > c.y);
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Pure movement step: normalised diagonals, bounds, axis-separated sliding. */
export function step(state: LumiState, input: LumiInput, dtMs: number, colliders: readonly Rect[]): LumiState {
  const dx = Math.sign(input.dx), dy = Math.sign(input.dy);
  if (dx === 0 && dy === 0) return { ...state, moving: false, idleMs: state.idleMs + dtMs };
  const len = Math.hypot(dx, dy); const dist = (LUMI_SPEED * dtMs) / 1000;
  const minX = WALK_BOUNDS.x, maxX = WALK_BOUNDS.x + WALK_BOUNDS.w;
  const minY = WALK_BOUNDS.y, maxY = WALK_BOUNDS.y + WALK_BOUNDS.h;
  let { x, y } = state;
  const nx = clamp(x + (dx / len) * dist, minX, maxX);
  if (!hits(nx, y, colliders)) x = nx;
  const ny = clamp(y + (dy / len) * dist, minY, maxY);
  if (!hits(x, ny, colliders)) y = ny;
  // Facing follows the latest intent; horizontal wins on a pure diagonal.
  const facing: Facing = dx !== 0 ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
  return { x, y, facing, moving: true, idleMs: 0 };
}
