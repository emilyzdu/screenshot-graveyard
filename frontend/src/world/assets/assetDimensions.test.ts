import { describe, expect, it } from 'vitest';
import { STAGE } from '../model/locations';
import { artScale, GHOST_SHEET, LUMI_SHEET } from '../model/spriteSpec';

// Guards the art pipeline: every PNG must be exactly its per-asset scale (1x, or 3x if listed in HD_ASSETS) x its logical box,
// so a mis-sized (e.g. 2x, or flattened-mockup) export fails before it reaches the scene.
const urls = import.meta.glob('./*.png', { eager: true, query: '?inline', import: 'default' }) as Record<string, string>;
const dims = (name: string) => {
  const url = urls[`./${name}.png`];
  if (!url) throw new Error(`missing asset ${name}.png`);
  const head = atob(url.slice(url.indexOf(',') + 1, url.indexOf(',') + 49)); // PNG signature + IHDR
  const u32 = (o: number) => ((head.charCodeAt(o) << 24) | (head.charCodeAt(o + 1) << 16) | (head.charCodeAt(o + 2) << 8) | head.charCodeAt(o + 3)) >>> 0;
  return { w: u32(16), h: u32(20) };
};
const logical: Record<string, [number, number]> = {
  'bg-sky': [STAGE.w, STAGE.h], 'bg-far': [STAGE.w, 190], ground: [STAGE.w, STAGE.h], foreground: [STAGE.w, STAGE.h],
  moon: [96, 96], 'wisteria-canopy': [200, 90],
  'glow-lamp': [72, 72], 'glow-lumi': [128, 128], 'glow-portal': [120, 120], 'selection-brackets': [32, 36],
  'lumi-sheet': [LUMI_SHEET.frameW * LUMI_SHEET.cols, LUMI_SHEET.frameH * LUMI_SHEET.rows],
  'ghost-sheet': [GHOST_SHEET.frameW * GHOST_SHEET.tints * GHOST_SHEET.framesPerTint, GHOST_SHEET.frameH * GHOST_SHEET.accessories],
};

describe('world art dimensions', () => {
  for (const [name, [w, h]] of Object.entries(logical)) {
    const k = artScale(name);
    it(`${name} is ${w * k}x${h * k} (${k}x of ${w}x${h})`, () => {
      expect(dims(name)).toEqual({ w: w * k, h: h * k });
    });
  }
});
