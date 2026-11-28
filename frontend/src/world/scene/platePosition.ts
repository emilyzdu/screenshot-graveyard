import { STAGE, type Rect } from '../model/locations';
/** Name plate geometry (logical px). The plate is centered on x, its top edge at y. */
export const PLATE = { gap: 12, height: 16, margin: 3, halfWidth: 44 } as const;
/** Where a location's name plate sits: just above the sprite, clamped inside the stage. */
export function platePosition(s: Rect): { x: number; y: number } {
  const x = Math.min(STAGE.w - PLATE.margin - PLATE.halfWidth, Math.max(PLATE.margin + PLATE.halfWidth, s.x + s.w / 2));
  const y = Math.min(STAGE.h - PLATE.margin - PLATE.height, Math.max(PLATE.margin, s.y - PLATE.gap));
  return { x, y };
}
