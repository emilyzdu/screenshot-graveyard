import { STAGE } from '../model/locations';
/** Fractional fit (2 decimals) so the stage fills the viewport; pixel art stays crisp via image-rendering. */
export function stageScale(availW: number, availH: number): number {
  const fit = Math.min(availW / STAGE.w, availH / STAGE.h);
  return Math.max(0.25, Math.floor(fit * 100) / 100);
}
