// Static scene table. Coordinates are in the 640x360 logical stage. The sprite
// rectangles mirror SPR in scripts/generate-world-assets.mjs.
export type LocationId = 'tower' | 'crypt' | 'well' | 'altar' | 'library' | 'portal';
export type OverlayId = 'upload' | 'calendar' | 'notes' | 'altar' | 'crypt' | 'portal' | 'queue' | 'settings';

export interface Rect { x: number; y: number; w: number; h: number }

export interface WorldLocation {
  id: LocationId;
  label: string;
  overlay: OverlayId;
  asset: string;
  /** Sprite rectangle, also the clickable hotspot. */
  sprite: Rect;
  /** Collision rectangle at the base of the building. */
  footprint: Rect;
}

export const STAGE = { w: 640, h: 360 } as const;
/** Lumi may walk inside this rectangle (feet position). */
export const WALK_BOUNDS: Rect = { x: 12, y: 150, w: 616, h: 188 };
export const LUMI_START = { x: 360, y: 214 };
export const LUMI_FOOT = { w: 10, h: 6 };

const loc = (id: LocationId, label: string, overlay: OverlayId, sprite: Rect, footprint: Rect): WorldLocation => ({
  id, label, overlay, asset: `building-${id}`, sprite, footprint,
});

export const LOCATIONS: readonly WorldLocation[] = [
  loc('tower', 'Clock Tower', 'calendar', { x: 12, y: 8, w: 88, h: 144 }, { x: 30, y: 134, w: 52, h: 18 }),
  loc('library', 'Library', 'notes', { x: 470, y: 60, w: 112, h: 88 }, { x: 476, y: 132, w: 100, h: 16 }),
  loc('well', 'Upload Well', 'upload', { x: 292, y: 132, w: 56, h: 56 }, { x: 298, y: 172, w: 44, h: 16 }),
  loc('altar', 'Approval Altar', 'altar', { x: 410, y: 196, w: 56, h: 44 }, { x: 416, y: 226, w: 44, h: 14 }),
  loc('crypt', 'Crypt', 'crypt', { x: 6, y: 176, w: 88, h: 72 }, { x: 12, y: 232, w: 76, h: 16 }),
  loc('portal', 'Portal', 'portal', { x: 556, y: 184, w: 72, h: 88 }, { x: 562, y: 258, w: 60, h: 14 }),
];

/** Extra solid props (no overlay): pond, signpost, gravestones. */
export const PROPS: readonly { id: string; asset: string; x: number; y: number; w: number; h: number; solid?: Rect }[] = [
  { id: 'tree-a', asset: 'prop-tree-a', x: 150, y: 64, w: 72, h: 100, solid: { x: 176, y: 150, w: 20, h: 12 } },
  { id: 'tree-b', asset: 'prop-tree-b', x: 392, y: 48, w: 72, h: 100, solid: { x: 418, y: 134, w: 20, h: 12 } },
  { id: 'signpost', asset: 'prop-signpost', x: 166, y: 262, w: 32, h: 44, solid: { x: 176, y: 298, w: 12, h: 8 } },
  { id: 'pond', asset: 'prop-pond-cat', x: 500, y: 296, w: 80, h: 44, solid: { x: 508, y: 322, w: 64, h: 14 } },
  { id: 'lamp-l', asset: 'prop-lamp', x: 252, y: 214, w: 16, h: 48, solid: { x: 256, y: 254, w: 8, h: 6 } },
  { id: 'lamp-r', asset: 'prop-lamp', x: 380, y: 140, w: 16, h: 48, solid: { x: 384, y: 180, w: 8, h: 6 } },
  { id: 'grave-0', asset: 'prop-grave-0', x: 110, y: 270, w: 20, h: 24, solid: { x: 112, y: 286, w: 16, h: 8 } },
  { id: 'grave-1', asset: 'prop-grave-1', x: 132, y: 288, w: 20, h: 24, solid: { x: 134, y: 304, w: 16, h: 8 } },
  { id: 'grave-2', asset: 'prop-grave-2', x: 40, y: 292, w: 20, h: 24, solid: { x: 42, y: 308, w: 16, h: 8 } },
  { id: 'grave-3', asset: 'prop-grave-1', x: 590, y: 292, w: 20, h: 24, solid: { x: 592, y: 308, w: 16, h: 8 } },
];

export const COLLIDERS: readonly Rect[] = [
  ...LOCATIONS.map((l) => l.footprint),
  ...PROPS.flatMap((p) => (p.solid ? [p.solid] : [])),
];

/** Hit distance for the "E" interact prompt. */
export const INTERACT_RANGE = 34;

export function nearestLocation(x: number, y: number): WorldLocation | null {
  let best: WorldLocation | null = null; let bestD = INTERACT_RANGE;
  for (const l of LOCATIONS) {
    const f = l.footprint;
    const dx = Math.max(f.x - x, 0, x - (f.x + f.w)); const dy = Math.max(f.y - y, 0, y - (f.y + f.h));
    const d = Math.hypot(dx, dy);
    if (d <= bestD) { best = l; bestD = d; }
  }
  return best;
}
