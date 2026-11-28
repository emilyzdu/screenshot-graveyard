export function assertCaptureHealthy(pageErrors, missingImages) {
  const failures = [];
  if (pageErrors.length) failures.push(`browser page errors: ${pageErrors.join('; ')}`);
  if (missingImages.length) failures.push(`missing runtime images: ${[...new Set(missingImages)].join(', ')}`);
  if (failures.length) throw new Error(failures.join('\n'));
}