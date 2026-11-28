// Single source of truth for sprite-sheet metrics, in LOGICAL (640x360) pixels.
// Art may be authored at 3x these sizes (masters); the renderer
// always sizes images by these logical boxes, so gameplay coordinates never change.
// Migration is per asset: list a file stem in HD_ASSETS only once its 3x PNG
// is in assets/ (the dimension test then expects exactly 3x its logical box).
// Everything not listed is still 1x pixel art and keeps crisp rendering.
export const HD_ASSETS: ReadonlySet<string> = new Set<string>([
  'building-tower',
]);
export const artScale = (name: string): 1 | 3 => (HD_ASSETS.has(name) ? 3 : 1);
/** CSS class for smooth scaling; empty for crisp 1x pixel art. */
export const artClass = (name: string): string => (HD_ASSETS.has(name) ? ' pw-hd' : '');
/** Lumi sheet: columns = facing (down, up, left, right), rows = animation frame. */
export const LUMI_SHEET = { frameW: 28, frameH: 34, cols: 4, rows: 2, anchorX: 14, anchorY: 32 } as const;
/** Ghost sheet: column = tint * framesPerTint + frame, row = accessory. */
export const GHOST_SHEET = { frameW: 24, frameH: 28, tints: 5, framesPerTint: 2, accessories: 4 } as const;
