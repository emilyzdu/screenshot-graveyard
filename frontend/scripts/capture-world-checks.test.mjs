import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertCaptureHealthy, missingRuntimeAssets, requiredRuntimeAssets } from './capture-world-checks.mjs';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'world', 'assets');

describe('world capture checks', () => {
  it('accepts a capture with no page or image failures', () => {
    expect(() => assertCaptureHealthy([], [])).not.toThrow();
  });
  it('fails when the browser reports a page error', () => {
    expect(() => assertCaptureHealthy(['TypeError: render failed'], [])).toThrow('browser page errors: TypeError: render failed');
  });
  it('fails when a mandatory runtime image is missing', () => {
    expect(() => assertCaptureHealthy([], ['/assets/building-tower.png'])).toThrow('missing runtime images: /assets/building-tower.png');
  });
  it('fails, and says so, when an image URL is empty (asset unresolved at build time)', () => {
    expect(() => assertCaptureHealthy([], [''])).toThrow('empty image URL: unresolved asset');
  });
  it('requires game assets only, never reference mockups or _source originals', () => {
    const manifest = { assets: [
      { file: 'ground.png', role: 'scene' },
      { file: '../../../../docs/design/pixel-world/m-world.png', role: 'reference-only' },
      { file: '_source/building-tower-source.png', role: 'scene' },
    ] };
    expect(requiredRuntimeAssets(manifest)).toEqual(['ground.png']);
    expect(missingRuntimeAssets(manifest, () => false)).toEqual(['ground.png']);
  });
  it('the real manifest lists 27 runtime assets and all exist on disk', () => {
    const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'));
    expect(requiredRuntimeAssets(manifest)).toHaveLength(27);
    expect(missingRuntimeAssets(manifest, (f) => existsSync(join(ASSETS, f)))).toEqual([]);
  });
});
