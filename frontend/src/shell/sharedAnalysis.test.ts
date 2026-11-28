import { describe, expect, it, vi } from 'vitest';
import type { Analysis, ApiResult } from '../api/ai';
import type { Screenshot } from '../api/client';
import { createAnalysisAuthority, currentSuggestionRule, summarize, summaryKey } from './sharedAnalysis';

const a = (id: number, category: string, uncertain = false): Analysis => ({
  screenshotId: id,
  classification: { category: category as Analysis['classification']['category'], confidence: 0.5, uncertain, versionNumber: 1, origin: 'ai_generate' },
  epitaph: { text: 't', visibleFacts: '', inferredIntent: null, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
});
const ok = (x: Analysis): ApiResult<Analysis> => ({ ok: true, data: x });
const fail = (status: number): ApiResult<Analysis> => ({ ok: false, status, code: 'x', message: 'x' });
const shot = (id: number, category: string, state: 'active' | 'archived' = 'active', uncertain = false): Screenshot => ({
  screenshotId: id, state, mimeType: 'image/png', originalFilename: `${id}.png`, isDuplicate: false, duplicateOf: null,
  byteSize: 1, uploadedAt: '2026-01-01T00:00:00Z', analysis: { category, uncertain, epitaph: 't', epitaphOrigin: 'ai_generate' },
});

describe('AnalysisAuthority: latest started request', () => {
  it('begin() makes the new request latest and pending at once, dropping the earlier payload', () => {
    const auth = createAnalysisAuthority();
    const t1 = auth.begin(1, 'k');
    auth.resolve(1, t1, ok(a(1, 'Study/Knowledge')));
    expect(auth.get(1)?.status).toBe('success');
    auth.begin(1, 'k');
    expect(auth.get(1)).toMatchObject({ status: 'pending' });
    expect(auth.get(1)?.analysis).toBeUndefined();
  });

  it('only the latest started request can settle; an older response is ignored in any order', () => {
    const auth = createAnalysisAuthority();
    const older = auth.begin(1, 'k');
    const newer = auth.begin(1, 'k');
    expect(auth.resolve(1, older, ok(a(1, 'Study/Knowledge')))).toBe(false);
    expect(auth.get(1)?.status).toBe('pending');
    expect(auth.resolve(1, newer, fail(503))).toBe(true);
    expect(auth.resolve(1, older, ok(a(1, 'Study/Knowledge')))).toBe(false); // cannot restore after a newer failure
    expect(auth.get(1)).toMatchObject({ status: 'failed', missing: false });
    expect(auth.get(1)?.analysis).toBeUndefined();
  });

  it('classifies 404 as missing, other errors as failed, and a wrong id as invalid', () => {
    const auth = createAnalysisAuthority();
    auth.resolve(1, auth.begin(1, 'k'), fail(404));
    expect(auth.get(1)).toMatchObject({ status: 'failed', missing: true });
    auth.resolve(1, auth.begin(1, 'k'), fail(0));
    expect(auth.get(1)).toMatchObject({ status: 'failed', missing: false });
    auth.resolve(1, auth.begin(1, 'k'), ok(a(2, 'Study/Knowledge')));
    expect(auth.get(1)?.status).toBe('invalid');
    expect(auth.get(1)?.analysis).toBeUndefined();
    expect(auth.get(2)).toBeUndefined();
  });

  it('keeps screenshots and workspace stores independent, and notifies on begin and resolve', () => {
    const auth = createAnalysisAuthority();
    const other = createAnalysisAuthority();
    const listener = vi.fn();
    auth.subscribe(listener);
    const t2 = auth.begin(2, 'k2');
    const t1 = auth.begin(1, 'k1');
    auth.resolve(2, t2, ok(a(2, 'Shopping/Inspiration')));
    auth.resolve(1, t1, ok(a(1, 'Study/Knowledge')));
    expect(auth.get(1)?.analysis?.classification.category).toBe('Study/Knowledge');
    expect(auth.get(2)?.analysis?.classification.category).toBe('Shopping/Inspiration');
    expect(listener).toHaveBeenCalledTimes(4);
    expect(other.get(1)).toBeUndefined();
  });
});

describe('currentSuggestionRule (shared by render and click time)', () => {
  const settled = (id: number, x: Analysis | ApiResult<Analysis>) => {
    const auth = createAnalysisAuthority();
    auth.resolve(id, auth.begin(id, 'k'), 'ok' in x ? x : ok(x));
    return auth;
  };
  it('suggests only for a successful, consistent, active, certain, non-sensitive latest read', () => {
    expect(currentSuggestionRule(settled(1, a(1, 'Study/Knowledge')), shot(1, 'Study/Knowledge'))).toMatchObject({ kind: 'suggest', action: 'make_notes' });
  });
  it.each([
    ['pending', () => { const x = createAnalysisAuthority(); x.begin(1, 'k'); return x; }, shot(1, 'Study/Knowledge')],
    ['failed', () => settled(1, fail(503)), shot(1, 'Study/Knowledge')],
    ['invalid id', () => settled(1, ok(a(2, 'Study/Knowledge'))), shot(1, 'Study/Knowledge')],
    ['conflicts with gallery', () => settled(1, a(1, 'Study/Knowledge')), shot(1, 'Shopping/Inspiration')],
    ['archived', () => settled(1, a(1, 'Study/Knowledge')), shot(1, 'Study/Knowledge', 'archived')],
    ['sensitive', () => settled(1, a(1, 'Potentially Sensitive')), shot(1, 'Potentially Sensitive')],
    ['unknown', () => settled(1, a(1, 'Unknown/Needs Review')), shot(1, 'Unknown/Needs Review')],
    ['uncertain', () => settled(1, a(1, 'Study/Knowledge', true)), shot(1, 'Study/Knowledge', 'active', true)],
    ['no read at all', () => createAnalysisAuthority(), shot(1, 'Study/Knowledge')],
  ])('no suggestion when %s', (_n, make, s) => {
    expect(currentSuggestionRule(make(), s).kind).toBe('none');
  });
  it('summaryKey/summarize agree with the list-summary shape', () => {
    expect(summaryKey(summarize(a(1, 'Study/Knowledge')))).toBe(JSON.stringify(['Study/Knowledge', false, 't', 'ai_generate']));
  });
});
