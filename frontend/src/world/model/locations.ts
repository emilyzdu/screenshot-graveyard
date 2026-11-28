export type LocationId = 'tower' | 'crypt' | 'well' | 'altar' | 'library' | 'portal';
export type OverlayId = 'upload' | 'calendar' | 'notes' | 'altar' | 'crypt' | 'portal' | 'queue' | 'settings';
export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }

export interface WorldLocation {
  id: LocationId;
  label: string;
  overlay: OverlayId;
  sprite: Rect;
  footprint: Rect;
  entrance: Point;
}

export const STAGE = { w: 640, h: 360 } as const;
export const WALK_BOUNDS: Rect = { x: 30, y: 150, w: 580, h: 198 };
export const LUMI_START = { x: 320, y: 303 };
export const LUMI_FOOT = { w: 10, h: 6 };

const loc = (id: LocationId, label: string, overlay: OverlayId, sprite: Rect, footprint: Rect, entrance: Point): WorldLocation =>
  ({ id, label, overlay, sprite, footprint, entrance });

// Logical coordinates sampled against the illustrated backdrop, with entrances at the steps.
export const LOCATIONS: readonly WorldLocation[] = [
  loc('tower', 'Clock Tower', 'calendar', { x: 153, y: 13, w: 109, h: 162 }, { x: 156, y: 121, w: 106, h: 42 }, { x: 211, y: 176 }),
  loc('library', 'Memory Library', 'notes', { x: 428, y: 50, w: 124, h: 132 }, { x: 437, y: 119, w: 108, h: 53 }, { x: 475, y: 185 }),
  loc('well', 'Upload Well', 'upload', { x: 198, y: 181, w: 91, h: 97 }, { x: 207, y: 222, w: 74, h: 47 }, { x: 244, y: 278 }),
  loc('altar', 'Approval Altar', 'altar', { x: 294, y: 99, w: 108, h: 125 }, { x: 294, y: 140, w: 108, h: 72 }, { x: 346, y: 222 }),
  loc('crypt', 'Crypt', 'crypt', { x: 43, y: 122, w: 104, h: 121 }, { x: 43, y: 167, w: 102, h: 65 }, { x: 103, y: 244 }),
  loc('portal', 'Portal Hall', 'portal', { x: 536, y: 97, w: 91, h: 138 }, { x: 546, y: 132, w: 80, h: 93 }, { x: 575, y: 236 }),
];

const OBSTACLES: readonly Rect[] = [
  { x: 0, y: 300, w: 241, h: 60 }, // left foreground fence and gravestones
  { x: 0, y: 256, w: 93, h: 47 },
  { x: 0, y: 150, w: 40, h: 105 },
  { x: 143, y: 169, w: 43, h: 24 },
  { x: 435, y: 216, w: 91, h: 49 }, // keeper's cottage
  { x: 445, y: 288, w: 195, h: 72 }, // pond and right foreground fence
  { x: 479, y: 277, w: 142, h: 22 },
  { x: 615, y: 227, w: 25, h: 61 },
  { x: 411, y: 325, w: 45, h: 35 },
];

export const COLLIDERS: readonly Rect[] = [...LOCATIONS.map((location) => location.footprint), ...OBSTACLES];
export const INTERACT_RANGE = 31;
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function nearestLocation(x: number, y: number): WorldLocation | null {
  let best: WorldLocation | null = null;
  let bestDistance = INTERACT_RANGE;
  for (const location of LOCATIONS) {
    const current = distance({ x, y }, location.entrance);
    if (current <= bestDistance) {
      best = location;
      bestDistance = current;
    }
  }
  return best;
}
