// Dev-only visual capture of the Pixel World (not part of any test suite).
// Usage: node scripts/capture-world.mjs [label]   (dev server must be running)
// Env: WORLD_URL (default http://localhost:5250/?view=world&demo=1)
// Exits non-zero if a manifest runtime asset is missing on disk, the page throws,
// or any stage image (including the CSS sprite sheets) fails to load.
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCaptureHealthy, missingRuntimeAssets } from './capture-world-checks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'src', 'world', 'assets');
const URL = process.env.WORLD_URL ?? 'http://localhost:5250/?view=world&demo=1';
const label = process.argv[2] ?? 'current';
const OUT = join(ROOT, '.shots', label);
const SIZES = [[1440, 900], [1280, 720], [390, 844]];

async function main() {
  const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'));
  const absent = missingRuntimeAssets(manifest, (f) => existsSync(join(ASSETS, f)));
  if (absent.length) throw new Error(`missing runtime images on disk: ${absent.join(', ')}`);
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const [w, h] of SIZES) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      const errors = [];
      const imageFailures = new Set();
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('response', (r) => { if (r.request().resourceType() === 'image' && !r.ok()) imageFailures.add(r.url()); });
      page.on('requestfailed', (r) => { if (r.resourceType() === 'image') imageFailures.add(r.url()); });
      await page.goto(URL, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="lumi"]');
      await page.waitForTimeout(400);
      const file = join(OUT, `world-${w}x${h}.png`);
      await page.screenshot({ path: file });
      const scale = await page.getAttribute('.pw-stage', 'data-scale');
      const broken = await page.evaluate(async () => {
        const bad = [];
        for (const img of document.querySelectorAll('.pw-stage img, .pw-portrait img')) {
          const src = img.getAttribute('src') ?? '';
          if (!src || !img.complete || img.naturalWidth === 0) bad.push(img.currentSrc || src);
        }
        // Sprite sheets are CSS backgrounds; load each one to prove it resolves.
        const sheets = [...document.querySelectorAll('.pw-lumi__body, .pw-ghost__body')]
          .map((el) => getComputedStyle(el).backgroundImage);
        for (const bg of new Set(sheets)) {
          const url = /url\("?(.*?)"?\)/.exec(bg)?.[1] ?? '';
          if (!url) { bad.push(''); continue; }
          const ok = await new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth > 0); i.onerror = () => res(false); i.src = url; });
          if (!ok) bad.push(url);
        }
        return bad;
      });
      assertCaptureHealthy(errors, [...imageFailures, ...broken]);
      console.log(`${w}x${h}: stage scale ${scale} -> ${file}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`capture failed:\n${err.message}`);
  process.exitCode = 1;
});
