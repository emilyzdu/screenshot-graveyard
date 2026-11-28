// Release-build check (P1-4b): the Pixel World's runtime art must be in the
// build context. Run in the image's frontend stage BEFORE `npm run build`:
//   node verify-world-assets.mjs <frontend/src>
// Fails (exit 1) when the world exists but its manifest is missing, when any
// manifest runtime asset is absent or empty, or when source art (_source/)
// reached the build. Vite silently resolves a missing PNG to an empty URL, so
// without this check a broken world would ship. No dependencies.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const src = process.argv[2];
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
if (!src) fail('usage: verify-world-assets.mjs <frontend/src>');

const world = join(src, 'world');
if (!existsSync(world)) {
  console.log('OK: no Pixel World in this build');
  process.exit(0);
}
const assets = join(world, 'assets');
const manifestPath = join(assets, 'manifest.json');
if (!existsSync(manifestPath)) fail('Pixel World present but src/world/assets/manifest.json is missing from the build context');
let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { fail('src/world/assets/manifest.json is not valid JSON'); }
// Runtime assets: game files directly in assets/ (never reference mockups or _source/ originals).
const runtime = (Array.isArray(manifest.assets) ? manifest.assets : [])
  .filter((a) => a && a.role !== 'reference-only' && typeof a.file === 'string' && !a.file.includes('/'))
  .map((a) => a.file);
if (runtime.length === 0) fail('the Pixel World manifest lists no runtime assets');
const missing = runtime.filter((f) => { const p = join(assets, f); return !existsSync(p) || !statSync(p).isFile() || statSync(p).size === 0; });
if (missing.length) fail(`${missing.length} of ${runtime.length} Pixel World runtime assets missing from the build context: ${missing.join(', ')}`);
if (existsSync(join(assets, '_source'))) fail('source art (src/world/assets/_source) reached the build context');
console.log(`OK: ${runtime.length} Pixel World runtime assets present`);
