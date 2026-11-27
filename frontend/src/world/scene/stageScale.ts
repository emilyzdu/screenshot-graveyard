import { STAGE } from '../model/locations';

/** Integer scale when the stage fits at >=1x, otherwise a fractional fit. */
export function stageScale(availW: number, availH: number): number {
  const fit = Math.min(availW / STAGE.w, availH / STAGE.h);
  return fit >= 1 ? Math.max(1, Math.floor(fit)) : Math.max(0.25, Math.floor(fit * 100) / 100);
}
