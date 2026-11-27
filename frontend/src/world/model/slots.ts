import type { GhostLocation, GhostView } from './ghostView';

export const MAX_GHOSTS = 24;
const GRID: Record<GhostLocation, { x0: number; y0: number; dx: number; dy: number; cols: number; rows: number }> = {
  well: { x0: 196, y0: 222, dx: 28, dy: 22, cols: 8, rows: 3 },
  crossroads: { x0: 196, y0: 296, dx: 28, dy: 20, cols: 8, rows: 3 },
};
const COL_ORDER = [3, 4, 2, 5, 1, 6, 0, 7];

export interface Slot { x: number; y: number }
export interface Placed { ghost: GhostView; slot: Slot }
export interface Crowd { location: GhostLocation; count: number; slot: Slot }
export interface Layout { placed: Placed[]; crowds: Crowd[] }

export function slotAt(location: GhostLocation, rank: number): Slot {
  const g = GRID[location]; const perRow = g.cols;
  const row = Math.floor(rank / perRow) % g.rows; const col = COL_ORDER[rank % perRow];
  return { x: g.x0 + col * g.dx, y: g.y0 + row * g.dy };
}

/**
 * Deterministic layout. Rank is the position of the id among ids in the same
 * location, so a ghost keeps its slot until ids appear or disappear below it.
 * Only MAX_GHOSTS ghosts are drawn; the rest of each location becomes a crowd marker.
 */
export function layoutGhosts(ghosts: readonly GhostView[]): Layout {
  const sorted = [...ghosts].sort((a, b) => a.id - b.id);
  const ranks: Record<GhostLocation, number> = { well: 0, crossroads: 0 };
  const placed: Placed[] = []; const overflow: Record<GhostLocation, number> = { well: 0, crossroads: 0 };
  let drawn = 0;
  for (const g of sorted) {
    if (drawn < MAX_GHOSTS) {
      placed.push({ ghost: g, slot: slotAt(g.location, ranks[g.location]++) }); drawn++;
    } else overflow[g.location]++;
  }
  const crowds: Crowd[] = [];
  for (const loc of ['well', 'crossroads'] as const) {
    if (overflow[loc] > 0) {
      const base = GRID[loc];
      crowds.push({ location: loc, count: overflow[loc], slot: { x: base.x0 + 8 * base.dx + 4, y: base.y0 + base.dy } });
    }
  }
  return { placed, crowds };
}
