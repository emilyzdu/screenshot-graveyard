import type { Screenshot } from '../../api/client';

export type GhostLocation = 'well' | 'crossroads';
export type GhostBadge = 'none' | 'book' | 'image' | 'question' | 'lock';
export const TINT_COUNT = 5;
export const ACCESSORY_COUNT = 4;
export const ACCESSORIES = ['none', 'bow', 'leaf', 'scarf'] as const;

export interface GhostView {
  /** Equals the screenshotId: the ghost identity is the screenshot. */
  id: number;
  filename: string;
  location: GhostLocation;
  /** Short state label: "Not analyzed yet" or "Analyzed". */
  label: string;
  category: string | null;
  epitaph: string | null;
  badge: GhostBadge;
  tint: number;
  accessory: number;
  isDuplicate: boolean;
  uploadedAt: string;
}

/** Cheap integer mix (Knuth multiplicative); stable for a given id. */
export function hash(id: number): number {
  let h = Math.imul(Math.trunc(id) + 1, 2654435761) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  return h >>> 0;
}

export function badgeFor(category: string): GhostBadge {
  if (category.startsWith('Study')) return 'book';
  if (category.startsWith('Potentially Sensitive')) return 'lock';
  if (category.startsWith('Unknown')) return 'question';
  return 'image';
}

export function deriveGhostViewM1(s: Screenshot): GhostView | null {
  if (s.state !== 'active') return null;
  const h = hash(s.screenshotId);
  return {
    id: s.screenshotId,
    filename: s.originalFilename,
    location: s.analysis ? 'crossroads' : 'well',
    label: s.analysis ? 'Analyzed' : 'Not analyzed yet',
    category: s.analysis?.category ?? null,
    epitaph: s.analysis?.epitaph ?? null,
    badge: s.analysis ? badgeFor(s.analysis.category) : 'none',
    tint: h % TINT_COUNT,
    accessory: (h >>> 8) % ACCESSORY_COUNT,
    isDuplicate: s.isDuplicate,
    uploadedAt: s.uploadedAt,
  };
}

export function deriveGhostViews(list: readonly Screenshot[]): GhostView[] {
  const out: GhostView[] = [];
  for (const s of list) { const v = deriveGhostViewM1(s); if (v) out.push(v); }
  return out;
}

export function archivedCount(list: readonly Screenshot[]): number {
  return list.filter((s) => s.state === 'archived').length;
}
