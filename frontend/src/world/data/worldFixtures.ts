/**
 * PROTOTYPE DATA. Synthetic screenshots for previewing the world without a
 * backend. Nothing here is a real user file; filenames are invented and the
 * image URLs are never requested.
 */
import type { Screenshot } from '../../api/client';

const NAMES = [
  'lecture-notes-math33a.png', 'tech-mixer-poster.png', 'new-balance-574.png', 'trip-planning-chat.png',
  'receipt-coffee.png', 'dorm-wifi-settings.png', 'recipe-pasta.png', 'bus-schedule.png',
  'group-dinner-chat.png', 'bio101-diagram.png', 'concert-tickets.png', 'plant-care-tips.png',
];
const CATEGORIES = ['Study/Knowledge', 'Reference/Document', 'Shopping/Inspiration', 'Memory/Entertainment', 'Unknown/Needs Review', 'Potentially Sensitive'];

export function buildDemoScreenshots(count = 9): Screenshot[] {
  const out: Screenshot[] = [];
  for (let i = 0; i < count; i++) {
    const id = 9001 + i;
    const analyzed = i % 3 !== 0;
    out.push({
      screenshotId: id, state: 'active', mimeType: 'image/png',
      originalFilename: i < NAMES.length ? `demo-${NAMES[i]}` : `demo-extra-${i + 1}.png`,
      isDuplicate: i === 5, duplicateOf: i === 5 ? 9001 : null, byteSize: 40_000 + i * 913,
      uploadedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      analysis: analyzed ? { category: CATEGORIES[i % CATEGORIES.length], uncertain: false, epitaph: 'Demo epitaph: a synthetic screenshot, not read by any AI.', epitaphOrigin: 'ai_generate' } : null,
    });
  }
  out.push(
    { screenshotId: 9900, state: 'archived', mimeType: 'image/png', originalFilename: 'demo-old-chat.png', isDuplicate: false, duplicateOf: null, byteSize: 31_000, uploadedAt: '2025-12-01T00:00:00Z', analysis: null },
    { screenshotId: 9901, state: 'archived', mimeType: 'image/png', originalFilename: 'demo-old-lecture.png', isDuplicate: false, duplicateOf: null, byteSize: 33_000, uploadedAt: '2025-11-20T00:00:00Z', analysis: null },
  );
  return out;
}

/** PROTOTYPE DATA: invented approval state for the Approval Altar preview. */
export function demoApproval(id: number): 'approved' | 'ready' | null {
  const r = (((id - 9001) % 3) + 3) % 3;
  return r === 1 ? 'approved' : r === 2 ? 'ready' : null;
}
