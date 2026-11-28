// Dev-only visual capture of the Pixel World (not part of any test suite).
// Usage: node scripts/capture-world.mjs [label]   (dev server must be running)
// Env: WORLD_URL (default http://localhost:5250/?view=world&demo=1)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCaptureHealthy } from './capture-world-checks.mjs';

const URL = process.env.WORLD_URL ?? 'http://localhost:5250/?view=world&demo=1';
const label = process.argv[2] ?? 'current';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '.shots', label);
mkdirSync(OUT, { recursive: true });
const SIZES = [[1440, 900], [1280, 720], [390, 844]];

const browser = await chromium.launch();
try {
  for (const [w, h] of SIZES) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errors = [];
    const imageFailures = new Set();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (response) => {
      if (response.request().resourceType() === 'image' && !response.ok()) imageFailures.add(response.url());
    });
    page.on('requestfailed', (request) => {
      if (request.resourceType() === 'image') imageFailures.add(request.url());
    });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="lumi"]');
    await page.waitForTimeout(400);
    const file = join(OUT, `world-${w}x${h}.png`);
    await page.screenshot({ path: file });
    const scale = await page.getAttribute('.pw-stage', 'data-scale');
    const brokenImages = await page.locator('.pw-stage img').evaluateAll((images) =>
      images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.currentSrc || image.src),
    );
    assertCaptureHealthy(errors, [...imageFailures, ...brokenImages]);
    console.log(`${w}x${h}: stage scale ${scale} -> ${file}`);
    await page.close();
  }
} finally {
  await browser.close();
}
