// Fit a transparent source PNG into a 3x master box: alpha cleanup, tight crop,
// uniform area-averaged downscale (no stretching), bottom-center with transparent padding.
// Usage: node scripts/art/fit-sprite.mjs <src.png> <out.png> <width> <height>
import { decode, encode } from './png.mjs';
import { writeFileSync } from 'node:fs';
const [src, out] = process.argv.slice(2, 4); const TW = Number(process.argv[4]), TH = Number(process.argv[5]);
if (!src || !out || !TW || !TH) throw new Error('usage: fit-sprite.mjs <src> <out> <w> <h>');
const { w, h, px } = decode(src);
// 1. clean alpha: near-opaque body -> opaque; drop faint near-white halo specks
for (let i = 0; i < px.length; i += 4) {
  if (px[i + 3] >= 240) px[i + 3] = 255;
  else if (px[i + 3] < 128 && px[i] > 220 && px[i + 1] > 220 && px[i + 2] > 220) px[i + 3] = 0;
  else if (px[i + 3] <= 8) px[i + 3] = 0;
}
// 2. tight bbox
let x0 = w, y0 = h, x1 = -1, y1 = -1;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
// 3. uniform scale to fit (no stretching)
const s = Math.min(TW / bw, TH / bh); const ow = Math.round(bw * s), oh = Math.round(bh * s);
const sx = bw / ow, sy = bh / oh; // exact per-axis source footprint (differs from 1/s by rounding only)
const outPx = Buffer.alloc(TW * TH * 4);
const ox = Math.floor((TW - ow) / 2), oy = TH - oh; // bottom-center
for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
  const fx0 = x0 + x * sx, fx1 = fx0 + sx, fy0 = y0 + y * sy, fy1 = fy0 + sy;
  let r = 0, g = 0, b = 0, a = 0, wsum = 0;
  for (let yy = Math.floor(fy0); yy < Math.ceil(fy1); yy++) { const wy = Math.min(fy1, yy + 1) - Math.max(fy0, yy);
    for (let xx = Math.floor(fx0); xx < Math.ceil(fx1); xx++) { const wx = Math.min(fx1, xx + 1) - Math.max(fx0, xx); const k = wx * wy; const i = (yy * w + xx) * 4; const al = px[i + 3] / 255;
      r += px[i] * al * k; g += px[i + 1] * al * k; b += px[i + 2] * al * k; a += al * k; wsum += k; } }
  const o = ((oy + y) * TW + ox + x) * 4; const A = a / wsum;
  if (A > 0.004) { outPx[o] = Math.round(r / a); outPx[o + 1] = Math.round(g / a); outPx[o + 2] = Math.round(b / a); outPx[o + 3] = Math.round(A * 255); }
}
writeFileSync(out, encode(TW, TH, outPx));
console.log(JSON.stringify({ srcBBox: [x0, y0, bw, bh], srcRatio: +(bw / bh).toFixed(4), scale: +s.toFixed(4), content: [ow, oh], contentRatio: +(ow / oh).toFixed(4), offset: [ox, oy], canvas: [TW, TH], logicalContent: [+(ow / 3).toFixed(1), +(oh / 3).toFixed(1)] }));
