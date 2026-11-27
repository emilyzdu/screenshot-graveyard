// Procedural, original pixel art for the Lantern Graveyard (Pixel World).
//
// Run: `node scripts/generate-world-assets.mjs` from frontend/.
// Writes PNGs and manifest.json into src/world/assets/. Everything is drawn from
// code in the master palette of docs/pixel-world-asset-spec.md section 2. The
// mockups in docs/design/pixel-world are references only and are never sliced.
// All output is flagged production_ready: false (placeholder art for review).
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'world', 'assets');
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- palette
const P = {
  n0: '#120c24', n1: '#1b1433', n2: '#2a1f4d', n3: '#3c3466',
  s0: '#4e4775', s1: '#6e6890', s2: '#9a93b8', s3: '#c9c3e0',
  w0: '#6c4ab0', w1: '#a77be0', w2: '#d8b8ff', w3: '#f6a6c8',
  moon: '#f3ecff', candle: '#ffe4a3', lamp: '#ffc764', lantern: '#f59b3c',
  p0: '#b04fe0', p1: '#e08cff', water: '#8fd3ff',
  g0: '#2f4a3e', g1: '#4d7a5c', g2: '#7fae7a',
  ok: '#62d394', warn: '#f5b73d',
};
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// ---------------------------------------------------------------- canvas + PNG
class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h; this.d = new Uint8Array(w * h * 4);
  }
  set(x, y, hex, a = 255) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const [r, g, b] = rgb(hex); const i = (y * this.w + x) * 4;
    this.d[i] = r; this.d[i + 1] = g; this.d[i + 2] = b; this.d[i + 3] = a;
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.d[(y * this.w + x) * 4 + 3];
  }
  rect(x, y, w, h, hex, a = 255) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, hex, a);
  }
  ellipse(cx, cy, rx, ry, hex, a = 255) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) this.set(x, y, hex, a);
  }
  line(x0, y0, x1, y1, hex) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) this.set(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, hex);
  }
  blit(src, ox, oy) {
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
      const i = (y * src.w + x) * 4;
      if (src.d[i + 3] === 0) continue;
      const tx = ox + x, ty = oy + y;
      if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) continue;
      const j = (ty * this.w + tx) * 4;
      this.d[j] = src.d[i]; this.d[j + 1] = src.d[i + 1]; this.d[j + 2] = src.d[i + 2]; this.d[j + 3] = src.d[i + 3];
    }
  }
  mirror() {
    const c = new Canvas(this.w, this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const s = (y * this.w + x) * 4, t = (y * this.w + (this.w - 1 - x)) * 4;
      for (let k = 0; k < 4; k++) c.d[t + k] = this.d[s + k];
    }
    return c;
  }
  // Dark outline around opaque pixels, written only onto transparent pixels.
  outline(hex) {
    const marks = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.get(x, y)) continue;
      if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) marks.push([x, y]);
    }
    for (const [x, y] of marks) this.set(x, y, hex);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(c) {
  const raw = Buffer.alloc((c.w * 4 + 1) * c.h);
  for (let y = 0; y < c.h; y++) {
    raw[y * (c.w * 4 + 1)] = 0;
    Buffer.from(c.d.buffer, y * c.w * 4, c.w * 4).copy(raw, y * (c.w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0); ihdr.writeUInt32BE(c.h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Deterministic randomness so reruns produce identical files.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const bayer = (x, y) => BAYER[y & 3][x & 3] / 16;

const manifest = [];
function emit(id, file, canvas, meta = {}) {
  writeFileSync(join(OUT, file), encodePng(canvas));
  manifest.push({ id, file, width: canvas.w, height: canvas.h, frames: meta.frames ?? 1, ...(meta.frameSize ? { frameSize: meta.frameSize } : {}), role: meta.role ?? 'scene', source: 'procedural (scripts/generate-world-assets.mjs)', license: 'original, generated in this repository', production_ready: false });
}

// ---------------------------------------------------------------- shared shapes
function brick(c, x, y, w, h, base, mortar, light, seed) {
  const r = rng(seed);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const row = Math.floor(j / 6), off = row % 2 ? 5 : 0;
    const edge = j % 6 === 5 || (i + off) % 10 === 9;
    c.set(x + i, y + j, edge ? mortar : r() < 0.12 ? light : base);
  }
}
function glowWindow(c, x, y, w, h, arch = true) {
  c.rect(x - 1, y - 1, w + 2, h + 2, P.n0);
  c.rect(x, y, w, h, P.lamp);
  c.rect(x + 1, y + 1, w - 2, 2, P.candle);
  if (arch) { c.rect(x, y, 1, 1, P.n0); c.rect(x + w - 1, y, 1, 1, P.n0); }
  c.rect(x + Math.floor(w / 2), y, 1, h, P.lantern);
}
function lanternShape(c, x, y) {
  c.rect(x + 2, y, 2, 1, P.n0); c.rect(x + 1, y + 1, 4, 1, P.n0);
  c.rect(x, y + 2, 6, 7, P.n0);
  c.rect(x + 1, y + 3, 4, 5, P.lamp); c.rect(x + 2, y + 4, 2, 3, P.moon);
  c.rect(x + 1, y + 9, 4, 1, P.n0);
}
function wisteriaClump(c, cx, cy, rx, ry, seed) {
  const r = rng(seed);
  const cols = [P.w0, P.w1, P.w2, P.w3];
  for (let i = 0; i < rx * ry * 0.9; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r());
    const x = cx + Math.cos(a) * rx * d, y = cy + Math.sin(a) * ry * d;
    c.set(x, y, cols[Math.floor(r() * (y < cy ? 2 : 4))]);
  }
}

// ---------------------------------------------------------------- locations (mirrors src/world/model/locations.ts)
const SPR = {
  tower: [24, 40, 64, 112], crypt: [6, 176, 88, 72], well: [292, 132, 56, 56],
  altar: [410, 196, 56, 44], library: [470, 60, 112, 88], portal: [556, 184, 72, 88],
};
const PLAZA = { x: 320, y: 306 };

// ---------------------------------------------------------------- backgrounds
function sky() {
  const c = new Canvas(640, 360);
  const bands = [P.n0, P.n1, P.n2, P.n3];
  for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) {
    const t = Math.min(y / 190, 1) * 3; const lo = Math.min(Math.floor(t), 2);
    c.set(x, y, t - lo > bayer(x, y) ? bands[lo + 1] : bands[lo]);
  }
  const r = rng(7);
  for (let i = 0; i < 150; i++) {
    const x = Math.floor(r() * 640), y = Math.floor(r() * 150), big = r() < 0.12;
    c.set(x, y, r() < 0.5 ? P.moon : P.s3);
    if (big) { c.set(x - 1, y, P.s2); c.set(x + 1, y, P.s2); c.set(x, y - 1, P.s2); c.set(x, y + 1, P.s2); }
  }
  emit('bg-sky', 'bg-sky.png', c, { role: 'background' });
}
function moon() {
  const c = new Canvas(96, 96);
  for (const [rad, a] of [[46, 22], [40, 34], [35, 50]]) c.ellipse(48, 48, rad, rad, P.w2, a);
  c.ellipse(48, 48, 28, 28, P.moon);
  c.ellipse(48, 48, 28, 28, P.s3, 0);
  const r = rng(11);
  for (const [dx, dy, rr] of [[-10, -8, 6], [9, 6, 8], [-4, 14, 4], [12, -14, 3]]) {
    c.ellipse(48 + dx, 48 + dy, rr, rr, P.s3);
    c.ellipse(48 + dx - 1, 48 + dy - 1, rr - 1.5, rr - 1.5, P.moon);
  }
  for (let i = 0; i < 40; i++) { const a = r() * 6.28, d = r() * 26; c.set(48 + Math.cos(a) * d, 48 + Math.sin(a) * d, P.s3); }
  emit('moon', 'moon.png', c, { role: 'background' });
}
function farHills() {
  const c = new Canvas(640, 190);
  const r = rng(21);
  // Rolling hills in two depths.
  for (let x = 0; x < 640; x++) {
    const h1 = 120 + Math.sin(x / 70) * 14 + Math.sin(x / 23) * 4;
    const h2 = 142 + Math.sin(x / 55 + 2) * 10;
    for (let y = Math.floor(h1); y < 190; y++) c.set(x, y, P.n2);
    for (let y = Math.floor(h2); y < 190; y++) c.set(x, y, P.n1);
  }
  // Distant pines and a ruined fence line.
  for (let i = 0; i < 46; i++) {
    const x = Math.floor(r() * 640), base = 148 + Math.floor(r() * 12), h = 16 + Math.floor(r() * 18);
    for (let j = 0; j < h; j++) c.rect(x - Math.floor(j / 4) - 1, base - h + j, Math.floor(j / 2) + 3, 1, j % 5 === 0 ? P.n3 : P.n0);
  }
  for (let x = 0; x < 640; x += 6) { c.rect(x, 150, 2, 12, P.n0); c.set(x, 149, P.n0); }
  c.rect(0, 154, 640, 1, P.n0); c.rect(0, 159, 640, 1, P.n0);
  // Tiny warm windows in far cottages.
  for (const x of [150, 240, 410, 590]) { c.rect(x, 128, 18, 14, P.n0); c.rect(x - 2, 124, 22, 5, P.n0); c.rect(x + 4, 132, 3, 4, P.lantern); c.rect(x + 11, 132, 3, 4, P.lamp); }
  emit('bg-far', 'bg-far.png', c, { role: 'background' });
}

// Cobblestone paths and lawn, on one 640x360 layer (opaque below y=150).
function ground() {
  const c = new Canvas(640, 360);
  const r = rng(33);
  const links = [
    [[56, 154], [56, 175], [120, 230], [PLAZA.x, PLAZA.y - 10]],
    [[50, 250], [90, 280], [PLAZA.x, PLAZA.y]],
    [[320, 190], [320, PLAZA.y]],
    [[525, 150], [525, 190], [440, 244], [PLAZA.x, PLAZA.y - 6]],
    [[438, 242], [480, 270]],
    [[592, 272], [560, 296], [PLAZA.x, PLAZA.y]],
  ];
  const dist = (px, py) => {
    let best = 1e9;
    for (const poly of links) for (let i = 0; i < poly.length - 1; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[i + 1];
      const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(px - ax - dx * t, py - ay - dy * t));
    }
    return best;
  };
  for (let y = 150; y < 360; y++) for (let x = 0; x < 640; x++) {
    const plaza = ((x - PLAZA.x) / 120) ** 2 + ((y - PLAZA.y) / 30) ** 2 <= 1;
    const wellPad = ((x - 320) / 42) ** 2 + ((y - 186) / 14) ** 2 <= 1;
    const altarPad = ((x - 438) / 38) ** 2 + ((y - 236) / 12) ** 2 <= 1;
    const path = dist(x, y) < 10 - ((y < 200) ? 1 : 0) || plaza || wellPad || altarPad;
    if (path) {
      const row = Math.floor(y / 6), off = row % 2 ? 4 : 0;
      const cx = Math.floor((x + off) / 8), edge = y % 6 === 5 || (x + off) % 8 === 7;
      const tone = ((cx * 7 + row * 13) % 5);
      c.set(x, y, edge ? P.s0 : tone === 0 ? P.s2 : tone < 3 ? P.s1 : P.s0);
      if (!edge && y % 6 === 0 && tone > 0) c.set(x, y, P.s2);
    } else {
      const near = dist(x, y) < 14;
      c.set(x, y, near ? (r() < 0.5 ? P.g0 : P.n2) : r() < 0.04 ? P.g1 : r() < 0.35 && bayer(x, y) > 0.6 ? P.n1 : P.g0);
    }
  }
  // Grass tufts and flowers.
  for (let i = 0; i < 420; i++) {
    const x = Math.floor(r() * 640), y = 152 + Math.floor(r() * 205);
    if (dist(x, y) < 14 || ((x - PLAZA.x) / 124) ** 2 + ((y - PLAZA.y) / 34) ** 2 < 1) continue;
    c.set(x, y, P.g1); c.set(x, y - 1, P.g2); c.set(x + 1, y, P.g1);
    if (r() < 0.12) { c.set(x + 2, y - 2, r() < 0.5 ? P.w3 : P.candle); }
  }
  emit('ground', 'ground.png', c, { role: 'background' });
}

// ---------------------------------------------------------------- buildings
function tower() {
  const [, , w, h] = SPR.tower; const c = new Canvas(w, h);
  brick(c, 14, 30, 36, 82, P.s1, P.s0, P.s2, 3);
  c.rect(14, 30, 3, 82, P.s2, 120); c.rect(47, 30, 3, 82, P.n3, 160);
  // Pointed roof
  for (let y = 0; y < 30; y++) { const hw = Math.floor(2 + y * 0.62); c.rect(32 - hw, y, hw * 2, 1, y % 5 === 4 ? P.w0 : P.n3); c.set(32 - hw, y, P.n1); c.set(31 + hw, y, P.n1); }
  c.rect(31, 0, 2, 4, P.lamp); // finial spark
  c.rect(10, 28, 44, 4, P.s0); c.rect(10, 28, 44, 1, P.s2);
  // Clock face
  c.ellipse(32, 52, 13, 13, P.n0); c.ellipse(32, 52, 11, 11, P.lamp); c.ellipse(32, 52, 9, 9, P.moon);
  for (let i = 0; i < 12; i++) { const a = (i * Math.PI) / 6; c.set(32 + Math.sin(a) * 8, 52 - Math.cos(a) * 8, P.n2); }
  c.line(32, 52, 32, 45, P.n0); c.line(32, 52, 37, 55, P.n0); c.set(32, 52, P.lantern);
  glowWindow(c, 28, 76, 8, 12);
  // Door
  c.rect(24, 96, 16, 16, P.n0); c.rect(26, 94, 12, 3, P.n0); c.rect(28, 100, 8, 12, P.n2); c.rect(31, 100, 2, 12, P.n1);
  c.rect(12, 108, 40, 4, P.s0); // base
  lanternShape(c, 6, 90); lanternShape(c, 52, 90);
  c.outline(P.n0);
  emit('building-tower', 'building-tower.png', c, { role: 'location:tower' });
}
function library() {
  const [, , w, h] = SPR.library; const c = new Canvas(w, h);
  brick(c, 8, 34, 96, 54, P.s1, P.s0, P.s2, 5);
  // Slate roof, sloped
  for (let y = 4; y < 36; y++) { const inset = Math.max(0, 30 - y); c.rect(inset + 2, y, w - 4 - inset * 2, 1, y % 4 === 3 ? P.n1 : (y % 8 < 4 ? P.n3 : P.w0)); }
  c.rect(0, 34, w, 4, P.n1); c.rect(0, 34, w, 1, P.s0);
  c.rect(52, 0, 8, 6, P.n3); c.rect(53, -1, 6, 2, P.n3); // chimney
  // Windows and arched door
  for (const x of [16, 30, 74, 90]) glowWindow(c, x, 46, 7, 16);
  c.rect(46, 52, 20, 36, P.n0); c.rect(48, 50, 16, 3, P.n0); c.rect(48, 56, 16, 32, P.lantern); c.rect(55, 56, 2, 32, P.n0);
  c.rect(49, 60, 6, 26, P.lamp, 255);
  // Hanging sign (book)
  c.rect(70, 36, 1, 8, P.n0); c.rect(66, 44, 14, 10, P.n0); c.rect(67, 45, 12, 8, P.w1); c.rect(68, 46, 4, 6, P.moon); c.rect(73, 46, 4, 6, P.candle);
  c.rect(4, 84, 104, 4, P.s0);
  wisteriaClump(c, 14, 40, 8, 10, 91); wisteriaClump(c, 98, 40, 8, 12, 92);
  c.outline(P.n0);
  emit('building-library', 'building-library.png', c, { role: 'location:library' });
}
function altar() {
  const [, , w, h] = SPR.altar; const c = new Canvas(w, h);
  c.rect(2, 34, 52, 10, P.s0); c.rect(2, 34, 52, 2, P.s2);
  c.rect(8, 28, 40, 8, P.s1); c.rect(8, 28, 40, 2, P.s3);
  c.rect(14, 18, 28, 12, P.s2); c.rect(14, 18, 28, 2, P.moon); c.rect(14, 28, 28, 2, P.s1);
  // Rune ring
  c.ellipse(28, 34, 18, 3, P.p0, 150);
  for (const x of [8, 26, 44]) { c.rect(x, 4, 4, 14, P.moon); c.rect(x + 1, 0, 2, 4, P.lamp); c.set(x + 1, -1, P.candle); c.rect(x, 17, 4, 1, P.s2); c.rect(x + 1, 1, 2, 2, P.candle); }
  // Stamp
  c.rect(24, 12, 8, 6, P.n3); c.rect(26, 8, 4, 5, P.w1);
  c.outline(P.n0);
  emit('building-altar', 'building-altar.png', c, { role: 'location:altar' });
}
function well() {
  const [, , w, h] = SPR.well; const c = new Canvas(w, h);
  c.rect(4, 26, 48, 26, P.s1); brick(c, 4, 28, 48, 22, P.s1, P.s0, P.s2, 8);
  c.ellipse(28, 28, 24, 8, P.s2); c.ellipse(28, 28, 20, 6, P.n0); c.ellipse(28, 29, 18, 5, P.water);
  c.ellipse(24, 28, 6, 2, P.moon, 180); c.ellipse(34, 30, 4, 1, P.p1, 200);
  c.rect(6, 12, 3, 28, P.n3); c.rect(47, 12, 3, 28, P.n3);
  c.rect(4, 8, 48, 5, P.n3); c.rect(4, 8, 48, 1, P.w1); c.rect(8, 4, 40, 4, P.w0); c.rect(14, 1, 28, 3, P.w0);
  c.rect(27, 12, 2, 10, P.n0); c.rect(24, 20, 8, 5, P.lantern); c.rect(26, 21, 4, 3, P.candle);
  // Banners
  c.rect(10, 13, 8, 12, P.w3); c.rect(10, 25, 3, 3, P.w3); c.rect(15, 25, 3, 3, P.w3); c.rect(12, 16, 4, 4, P.moon);
  c.rect(38, 13, 8, 12, P.w1); c.rect(38, 25, 3, 3, P.w1); c.rect(43, 25, 3, 3, P.w1); c.rect(40, 16, 4, 4, P.moon);
  c.rect(2, 50, 52, 4, P.s0);
  c.outline(P.n0);
  emit('building-well', 'building-well.png', c, { role: 'location:well' });
}
function crypt() {
  const [, , w, h] = SPR.crypt; const c = new Canvas(w, h);
  brick(c, 6, 22, 76, 50, P.s1, P.s0, P.s2, 9);
  for (let y = 4; y < 22; y++) { const hw = 40 - Math.floor((22 - y) * 1.6) ; c.rect(44 - hw, y, hw * 2, 1, y < 8 ? P.s3 : P.s2); }
  c.rect(0, 20, 88, 4, P.s2); c.rect(0, 20, 88, 1, P.s3);
  for (const x of [8, 66]) { c.rect(x, 24, 8, 46, P.s2); c.rect(x, 24, 2, 46, P.s3); c.rect(x - 2, 66, 12, 6, P.s0); }
  // Iron door with glow
  c.rect(28, 34, 32, 38, P.n0); c.rect(30, 30, 28, 6, P.n0); c.rect(32, 28, 24, 4, P.n0);
  c.rect(31, 36, 26, 36, P.n2);
  for (let x = 33; x < 56; x += 4) c.rect(x, 36, 1, 36, P.s0);
  c.rect(31, 50, 26, 2, P.s0); c.ellipse(44, 44, 3, 3, P.p1, 200);
  c.rect(34, 8, 20, 8, P.n3); c.rect(36, 10, 16, 4, P.n1); c.rect(38, 11, 12, 2, P.candle); // plaque
  c.rect(0, 70, 88, 2, P.n0);
  lanternShape(c, 18, 48); lanternShape(c, 64, 48);
  c.outline(P.n0);
  emit('building-crypt', 'building-crypt.png', c, { role: 'location:crypt' });
}
function portal() {
  const [, , w, h] = SPR.portal; const c = new Canvas(w, h);
  const cx = 36, cy = 46;
  // Swirl inside the arch
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x - cx) / 22, dy = (y - cy) / 34; const d = Math.hypot(dx, dy);
    if (d > 1) continue;
    const a = Math.atan2(dy, dx); const band = Math.floor(((a + d * 7) / (Math.PI * 2)) * 5 + 20) % 3;
    c.set(x, y, d < 0.15 ? P.moon : band === 0 ? P.p1 : band === 1 ? P.p0 : P.w0);
  }
  // Stone arch ring
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot((x - cx) / 22, (y - cy) / 34);
    if (d > 1 && d <= 1.28 && (y < 72 || Math.abs(x - cx) > 18)) c.set(x, y, ((x + y) % 7 === 0) ? P.s2 : d > 1.2 ? P.s0 : P.s1);
  }
  c.rect(8, 76, 56, 12, P.s0); c.rect(8, 76, 56, 2, P.s2); c.rect(14, 70, 44, 8, P.s1);
  c.rect(30, 0, 12, 8, P.s2); c.rect(32, 2, 8, 4, P.p1);
  c.outline(P.n0);
  emit('building-portal', 'building-portal.png', c, { role: 'location:portal' });
}

// ---------------------------------------------------------------- props
function tree(file, id, seed) {
  const c = new Canvas(72, 100);
  c.rect(31, 40, 10, 60, P.n2); c.rect(31, 40, 3, 60, P.n3); c.rect(26, 92, 20, 8, P.n2);
  c.line(34, 52, 18, 36, P.n2); c.line(38, 50, 54, 34, P.n2); c.line(35, 60, 20, 48, P.n2);
  wisteriaClump(c, 36, 30, 32, 24, seed);
  const r = rng(seed + 1);
  for (let i = 0; i < 26; i++) { // hanging flower strands
    const x = 8 + Math.floor(r() * 56), top = 30 + Math.floor(r() * 12), len = 6 + Math.floor(r() * 22);
    for (let j = 0; j < len; j++) c.set(x, top + j, j % 5 === 4 ? P.w3 : j > len - 6 ? P.w2 : P.w1);
  }
  c.outline(P.n0);
  emit(id, file, c, { role: 'prop' });
}
function grave(variant) {
  const c = new Canvas(20, 24);
  c.rect(2, 20, 16, 4, P.s0);
  if (variant === 0) { c.rect(4, 6, 12, 15, P.s2); c.ellipse(10, 7, 6, 5, P.s2); c.rect(7, 9, 6, 1, P.s0); c.rect(9, 8, 2, 7, P.s0); }
  if (variant === 1) { c.rect(8, 2, 4, 20, P.s2); c.rect(3, 7, 14, 4, P.s2); c.rect(8, 2, 1, 20, P.s3); }
  if (variant === 2) { c.rect(3, 9, 14, 12, P.s1); c.rect(3, 9, 14, 2, P.s2); c.rect(6, 13, 8, 1, P.s0); c.rect(6, 16, 5, 1, P.s0); }
  c.rect(2, 21, 3, 2, P.g1); c.rect(15, 20, 3, 3, P.g2); c.set(16, 19, P.w3);
  c.outline(P.n0);
  emit(`prop-grave-${variant}`, `prop-grave-${variant}.png`, c, { role: 'prop' });
}
function lampPost() {
  const c = new Canvas(16, 48);
  c.rect(7, 12, 3, 34, P.n2); c.rect(4, 44, 9, 4, P.n3); c.rect(5, 6, 7, 1, P.n0);
  lanternShape(c, 5, 3); c.rect(6, 12, 5, 1, P.n0);
  c.outline(P.n0);
  emit('prop-lamp', 'prop-lamp.png', c, { role: 'prop' });
}
function signpost() {
  const c = new Canvas(32, 44);
  c.rect(14, 8, 4, 36, P.n3); c.rect(14, 8, 1, 36, P.s0);
  c.rect(4, 6, 22, 7, P.s1); c.rect(24, 4, 3, 11, P.s1); c.rect(5, 7, 18, 1, P.s2);
  c.rect(8, 18, 20, 7, P.s0); c.rect(4, 16, 3, 11, P.s0); c.rect(9, 19, 17, 1, P.s1);
  c.rect(12, 9, 8, 1, P.candle); c.rect(12, 21, 8, 1, P.candle);
  c.outline(P.n0);
  emit('prop-signpost', 'prop-signpost.png', c, { role: 'prop' });
}
function pond() {
  const c = new Canvas(80, 44);
  c.ellipse(40, 28, 38, 13, P.s0); c.ellipse(40, 27, 36, 11, P.n2); c.ellipse(40, 27, 33, 9, P.water);
  c.ellipse(30, 25, 10, 3, P.s3, 150); c.ellipse(52, 31, 8, 2, P.moon, 150);
  c.ellipse(26, 29, 4, 1, P.g1); c.ellipse(60, 24, 4, 1, P.g2);
  // Cat sitting on the rim
  c.rect(60, 8, 12, 12, P.n2); c.rect(62, 3, 8, 7, P.n2); c.rect(62, 1, 2, 3, P.n2); c.rect(68, 1, 2, 3, P.n2);
  c.rect(64, 5, 1, 2, P.lamp); c.rect(67, 5, 1, 2, P.lamp); c.rect(70, 14, 5, 2, P.n2); c.rect(72, 10, 2, 5, P.n2);
  c.rect(61, 9, 10, 1, P.n3);
  c.outline(P.n0);
  emit('prop-pond-cat', 'prop-pond-cat.png', c, { role: 'prop' });
}
function foreground() {
  const c = new Canvas(640, 360);
  const r = rng(77);
  // Iron fence along the bottom edge
  c.rect(0, 346, 640, 3, P.n0); c.rect(0, 346, 640, 1, P.n3);
  for (let x = 2; x < 640; x += 10) { c.rect(x, 330, 2, 30, P.n0); c.rect(x, 330, 1, 28, P.n2); c.set(x - 1, 329, P.n0); c.set(x, 328, P.n0); c.set(x + 1, 329, P.n0); c.rect(x, 326, 1, 3, P.n0); }
  c.rect(0, 354, 640, 2, P.n0);
  // Stone fence posts
  for (const x of [0, 160, 320, 480, 632]) { c.rect(x, 322, 8, 38, P.s0); c.rect(x, 322, 8, 3, P.s2); c.rect(x - 1, 320, 10, 3, P.s1); }
  // Foreground bushes with flowers
  for (const bx of [24, 210, 440, 600]) { wisteriaClump(c, bx, 352, 22, 7, bx); for (let i = 0; i < 20; i++) c.set(bx - 20 + r() * 40, 346 + r() * 8, r() < 0.5 ? P.g1 : P.g0); }
  emit('foreground', 'foreground.png', c, { role: 'foreground' });
}
function wisteriaCanopy() {
  const c = new Canvas(200, 90);
  const r = rng(101);
  for (let i = 0; i < 18; i++) wisteriaClump(c, 20 + i * 10, 6, 14, 10, 200 + i);
  for (let i = 0; i < 44; i++) {
    const x = Math.floor(r() * 200), len = 8 + Math.floor(r() * 70) * (1 - x / 260);
    for (let j = 0; j < len; j++) c.set(x, 8 + j, j > len - 5 ? P.w2 : j % 6 === 5 ? P.w3 : j % 3 ? P.w1 : P.w0);
  }
  c.rect(0, 0, 200, 3, P.n2);
  emit('wisteria-canopy', 'wisteria-canopy.png', c, { role: 'foreground' });
}

// ---------------------------------------------------------------- glows (additive layers)
function glow(file, id, size, color, steps = 6) {
  const c = new Canvas(size, size); const m = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - m + 0.5, y - m + 0.5) / m; if (d >= 1) continue;
    const step = Math.floor((1 - d) * steps); if (step <= 0) continue;
    if (step === 1 && bayer(x, y) < 0.5) continue; // dither the outer band
    c.set(x, y, color, Math.floor((step / steps) * 120));
  }
  emit(id, file, c, { role: 'glow' });
}

// ---------------------------------------------------------------- characters
const GHOST_TINTS = [[P.w2, P.w1], [P.w3, P.w1], [P.water, P.s1], [P.candle, P.lamp], [P.s3, P.s2]];
function drawGhost(c, ox, oy, tint, accessory, frame) {
  const [light, shade] = GHOST_TINTS[tint]; const g = new Canvas(24, 28);
  for (let y = 3; y < 26; y++) for (let x = 0; x < 24; x++) {
    const dx = x - 11.5; let hw;
    if (y < 11) hw = Math.sqrt(Math.max(0, 64 - (11 - y) ** 2));
    else hw = 8;
    if (Math.abs(dx) > hw) continue;
    const bottom = 22 + (Math.floor((x + frame * 2) / 3) % 2 === 0 ? 3 : 0);
    if (y > bottom) continue;
    g.set(x, y, Math.abs(dx) > hw - 2.2 && dx > 0 ? shade : light);
  }
  g.rect(6, 7, 3, 2, P.moon); g.rect(5, 9, 2, 3, P.moon);
  g.rect(8, 11, 2, 4, P.n0); g.rect(14, 11, 2, 4, P.n0); g.set(8, 11, P.moon); g.set(14, 11, P.moon);
  g.rect(6, 15, 2, 1, P.w3); g.rect(16, 15, 2, 1, P.w3); g.rect(11, 15, 2, 1, P.n2);
  if (accessory === 1) { g.rect(15, 3, 7, 5, P.w3); g.rect(17, 4, 3, 3, P.n2); g.set(18, 5, P.w3); }
  if (accessory === 2) { g.rect(10, 0, 4, 4, P.g2); g.rect(11, 1, 2, 2, P.g1); g.rect(12, 3, 1, 2, P.g0); }
  if (accessory === 3) { g.rect(3, 17, 18, 3, P.w0); g.rect(3, 17, 18, 1, P.w1); g.rect(16, 20, 4, 5, P.w0); g.rect(17, 24, 2, 1, P.w1); }
  g.outline(P.n0);
  c.blit(g, ox, oy);
}
function ghostSheet() {
  const c = new Canvas(24 * 10, 28 * 4); // 5 tints x 2 frames per row, one row per accessory
  for (let acc = 0; acc < 4; acc++) for (let t = 0; t < 5; t++) for (let f = 0; f < 2; f++) drawGhost(c, (t * 2 + f) * 24, acc * 28, t, acc, f);
  emit('ghost-sheet', 'ghost-sheet.png', c, { role: 'actor', frames: 40, frameSize: [24, 28] });
}
// Lumi: ghost in a purple wizard hat and orange scarf, carrying a lantern.
function drawLumi(c, ox, oy, facing, frame) {
  const g = new Canvas(28, 34); const bob = frame ? 1 : 0;
  const side = facing === 'left' || facing === 'right';
  for (let y = 11; y < 29; y++) for (let x = 0; x < 28; x++) {
    const dx = x - 13.5; const hw = y < 17 ? Math.sqrt(Math.max(0, 49 - (17 - y) ** 2)) : (side ? 6.5 : 7);
    if (Math.abs(dx) > hw) continue;
    const bottom = 25 + (Math.floor((x + frame * 2) / 3) % 2 === 0 ? 3 : 0);
    if (y > bottom) continue;
    g.set(x, y + bob, dx > hw - 2 ? P.s3 : P.moon);
  }
  // Hat
  for (let y = 1; y < 11; y++) { const hw = Math.floor(1 + (y - 1) * 0.55); const bend = y > 3 ? 0 : Math.floor((4 - y) / 2); g.rect(13 - hw + bend, y + bob, hw * 2, 1, y % 4 === 0 ? P.w1 : P.w0); }
  g.rect(14, 0 + bob, 3, 2, P.w0); g.rect(16, 0 + bob, 2, 1, P.w0);
  g.rect(3, 10 + bob, 21, 3, P.n3); g.rect(3, 10 + bob, 21, 1, P.w1);
  g.rect(12, 6 + bob, 2, 2, P.candle); // star
  // Face
  if (facing === 'down') { g.rect(10, 16 + bob, 2, 4, P.n0); g.rect(16, 16 + bob, 2, 4, P.n0); g.rect(10, 20 + bob, 1, 1, P.w3); g.rect(17, 20 + bob, 1, 1, P.w3); g.rect(13, 21 + bob, 2, 1, P.n2); }
  if (facing === 'left' || facing === 'right') { g.rect(7, 16 + bob, 2, 4, P.n0); g.rect(12, 16 + bob, 2, 4, P.n0); g.rect(6, 21 + bob, 2, 1, P.w3); }
  if (facing === 'up') { g.rect(9, 17 + bob, 10, 1, P.s2); }
  // Scarf
  g.rect(6, 22 + bob, 16, 3, P.lantern); g.rect(6, 22 + bob, 16, 1, P.lamp);
  g.rect(facing === 'left' ? 17 : 5, 24 + bob, 4, 5, P.lantern);
  g.outline(P.n0);
  // Lantern, drawn after the outline so the glass stays warm.
  if (facing !== 'up') {
    const lx = facing === 'left' ? 0 : facing === 'right' ? 22 : 21, ly = 19 + (frame ? 0 : 1);
    g.rect(lx + 2, ly - 4, 1, 4, P.n0); lanternShape(g, lx, ly);
  } else { lanternShape(g, 22, 20); }
  c.blit(g, ox, oy);
}
function lumiSheet() {
  const c = new Canvas(28 * 4, 34 * 2); // columns: down, up, left, right; rows: frame 0/1
  const L = new Canvas(1, 1); void L;
  ['down', 'up', 'left'].forEach((f, i) => { for (let fr = 0; fr < 2; fr++) { const t = new Canvas(28, 34); drawLumi(t, 0, 0, f, fr); c.blit(t, i * 28, fr * 34); } });
  for (let fr = 0; fr < 2; fr++) { const t = new Canvas(28, 34); drawLumi(t, 0, 0, 'right', fr); c.blit(t, 3 * 28, fr * 34); }
  emit('lumi-sheet', 'lumi-sheet.png', c, { role: 'actor', frames: 8, frameSize: [28, 34] });
}

// ---------------------------------------------------------------- HUD bits
function selection() {
  const c = new Canvas(32, 36);
  const col = P.lantern;
  for (const [x, y, sx, sy] of [[0, 0, 1, 1], [31, 0, -1, 1], [0, 35, 1, -1], [31, 35, -1, -1]]) {
    for (let i = 0; i < 6; i++) { c.set(x + sx * i, y, col); c.set(x, y + sy * i, col); c.set(x + sx * i, y + sy, P.lamp); }
  }
  emit('selection-brackets', 'selection-brackets.png', c, { role: 'hud' });
}
function portrait() {
  const c = new Canvas(32, 32); c.rect(0, 0, 32, 32, P.n2);
  const t = new Canvas(28, 34); drawLumi(t, 0, 0, 'down', 0);
  c.blit(t, 2, -2); c.rect(0, 0, 32, 1, P.w1); c.rect(0, 31, 32, 1, P.n0);
  emit('lumi-portrait', 'lumi-portrait.png', c, { role: 'hud' });
}

// ---------------------------------------------------------------- run
sky(); moon(); farHills(); ground();
tower(); library(); altar(); well(); crypt(); portal();
tree('prop-tree-a.png', 'prop-tree-a', 301); tree('prop-tree-b.png', 'prop-tree-b', 411);
grave(0); grave(1); grave(2); lampPost(); signpost(); pond(); foreground(); wisteriaCanopy();
glow('glow-lumi.png', 'glow-lumi', 128, P.lamp, 7);
glow('glow-lamp.png', 'glow-lamp', 72, P.lamp, 5);
glow('glow-portal.png', 'glow-portal', 120, P.p1, 6);
ghostSheet(); lumiSheet(); selection(); portrait();

const refs = ['m-world', 'm-card', 'm-approve'].map((n) => ({
  id: `reference-${n}`, file: `../../../../docs/design/pixel-world/${n}.png`, role: 'reference-only',
  source: 'approved mockup, not used as a game asset', license: 'project reference', production_ready: false,
}));
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ palette: P, grid: 16, logicalSize: [640, 360], assets: [...manifest, ...refs] }, null, 2) + '\n');
console.log(`wrote ${manifest.length} assets to ${OUT}`);
