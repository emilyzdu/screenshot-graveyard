// Pure checks for scripts/capture-world.mjs, kept separate so they can be unit tested.

/**
 * Runtime images the world needs: every manifest entry that is a game asset.
 * Reference mockups and `_source/` originals are never loaded at runtime.
 */
export function requiredRuntimeAssets(manifest) {
  const assets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  return assets
    .filter((a) => a.role !== 'reference-only' && typeof a.file === 'string' && !a.file.includes('/'))
    .map((a) => a.file);
}

/** Required files that are absent on disk (`exists` is injected for testing). */
export function missingRuntimeAssets(manifest, exists) {
  return requiredRuntimeAssets(manifest).filter((file) => !exists(file));
}

/**
 * Throws (so the capture exits non-zero) on any browser page error or any image
 * that did not load. An empty URL means the asset was unresolved at build time.
 */
export function assertCaptureHealthy(pageErrors, missingImages) {
  const failures = [];
  if (pageErrors.length) failures.push(`browser page errors: ${pageErrors.join('; ')}`);
  if (missingImages.length) {
    const names = [...new Set(missingImages.map((u) => u || '(empty image URL: unresolved asset)'))];
    failures.push(`missing runtime images: ${names.join(', ')}`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
}
