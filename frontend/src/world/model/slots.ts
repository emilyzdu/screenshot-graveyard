import type { GhostLocation, GhostView } from './ghostView';

export const MAX_GHOSTS = 24;

export interface Slot { x: number; y: number }
export interface Placed { ghost: GhostView; slot: Slot }
export interface Crowd { location: GhostLocation; count: number; slot: Slot }
export interface Layout { placed: Placed[]; crowds: Crowd[] }

// Clearings and paths in the illustration, ordered to keep the first ghosts spaced out.
const SLOTS: readonly Slot[] = [
  { x: 275, y: 291 }, { x: 380, y: 254 }, { x: 158, y: 253 }, { x: 420, y: 285 },
  { x: 304, y: 238 }, { x: 489, y: 279 }, { x: 181, y: 207 }, { x: 561, y: 258 },
  { x: 336, y: 315 }, { x: 115, y: 280 }, { x: 398, y: 318 }, { x: 425, y: 189 },
  { x: 219, y: 288 }, { x: 343, y: 264 }, { x: 257, y: 180 }, { x: 527, y: 235 },
  { x: 387, y: 217 }, { x: 137, y: 221 }, { x: 594, y: 259 }, { x: 184, y: 281 },
  { x: 284, y: 214 }, { x: 267, y: 328 }, { x: 465, y: 187 }, { x: 374, y: 343 },
];

export function layoutGhosts(ghosts: readonly GhostView[], activeSlots?: Map<number, number>): Layout {
  const sorted = [...ghosts].sort((a, b) => a.id - b.id);
  const shown = sorted.slice(0, MAX_GHOSTS);
  const slots = activeSlots ?? new Map<number, number>();
  const ids = new Set(shown.map((ghost) => ghost.id));
  for (const id of slots.keys()) if (!ids.has(id)) slots.delete(id);
  const occupied = new Set(slots.values());
  const placed = shown.map((ghost) => {
    let slot = slots.get(ghost.id);
    if (slot === undefined) {
      slot = SLOTS.findIndex((_, index) => !occupied.has(index));
      occupied.add(slot);
      slots.set(ghost.id, slot);
    }
    return { ghost, slot: SLOTS[slot] };
  });
  const remaining = sorted.length - shown.length;
  return {
    placed,
    crowds: remaining > 0 ? [{ location: 'well', count: remaining, slot: { x: 320, y: 344 } }] : [],
  };
}
