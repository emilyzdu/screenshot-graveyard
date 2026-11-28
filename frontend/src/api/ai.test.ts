import { describe, it, expect, vi } from 'vitest';
import {
  classifyScreenshot,
  editAnalysis,
  generateStudyNote,
  getAnalysis,
  getEventDraft,
  getApprovalStatus,
  approveVersion,
  getEventDraftPreparation,
  getConsent,
  getProviderMode,
  getOperation,
  requestEventDraft,
  saveStudyNoteEdit,
  setConsent,
  studyNoteExportUrl,
} from './ai';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchOf = (r: () => Response | Promise<Response>) =>
  vi.fn(() => Promise.resolve(r())) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('AI API client', () => {
  it('sends the CSRF header + same-origin credentials on every POST, none on GET', async () => {
    const f = fetchOf(() => json({ granted: true }));
    await setConsent(3, true, f);
    await getConsent(3, f);
    const [, post] = (f as ReturnType<typeof vi.fn>).mock.calls[0];
    const [, get] = (f as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(post.method).toBe('POST');
    expect(post.headers['X-Requested-With']).toBe('fetch');
    expect(post.credentials).toBe('same-origin');
    expect(JSON.parse(post.body)).toEqual({ granted: true });
    expect(get.method).toBe('GET');
    expect(get.headers['X-Requested-With']).toBeUndefined();
  });

  it('never puts a workspace id in a request', async () => {
    const f = fetchOf(() => json({ operationId: 1, kind: 'study_note', status: 'pending', warning: null }, 202));
    await generateStudyNote([5, 2, 9], f);
    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/study-notes');
    expect(JSON.parse(init.body)).toEqual({ screenshotIds: [5, 2, 9] }); // order preserved
    expect(JSON.stringify(init)).not.toMatch(/workspace/i);
  });

  it('keeps status + code for consent (403) and quota (429) failures', async () => {
    const r403 = await classifyScreenshot(1, fetchOf(() => json({ error: { code: 'consent_required', message: 'x' } }, 403)));
    const r429 = await classifyScreenshot(1, fetchOf(() => json({ error: { code: 'quota_exceeded', message: 'y' } }, 429)));
    expect(r403).toMatchObject({ ok: false, status: 403, code: 'consent_required' });
    expect(r429).toMatchObject({ ok: false, status: 429, code: 'quota_exceeded' });
  });

  it('reports a network failure as status 0, never a fake success', async () => {
    const f = vi.fn(() => Promise.reject(new Error('down'))) as unknown as typeof fetch;
    expect(await getOperation(1, f)).toMatchObject({ ok: false, status: 0, code: 'network' });
  });

  it('rejects malformed success bodies instead of trusting them', async () => {
    expect(await getOperation(1, fetchOf(() => json({ operationId: 1, kind: 'classify', status: 'weird' })))).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(await getAnalysis(1, fetchOf(() => json({ screenshotId: 1 })))).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(await getConsent(1, fetchOf(() => json({ granted: 'yes' })))).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('accepts only the public fake/openai provider-mode contract', async () => {
    expect(await getProviderMode(fetchOf(() => json({ mode: 'fake' })))).toMatchObject({ ok: true, data: 'fake' });
    expect(await getProviderMode(fetchOf(() => json({ mode: 'openai', apiKey: 'never exposed' })))).toMatchObject({ ok: true, data: 'openai' });
    expect(await getProviderMode(fetchOf(() => json({ mode: 'other' })))).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('preserves an operation-linked artifact ID only when it is a number', async () => {
    const result = await getOperation(1, fetchOf(() => json({
      operationId: 1, kind: 'study_note', status: 'successful', artifactId: 44,
    })));
    expect(result).toMatchObject({ ok: true, data: { artifactId: 44 } });
  });

  it('parses a persisted analysis including visible facts and uncertainty', async () => {
    const body = {
      screenshotId: 4,
      classification: { category: 'Study/Knowledge', confidence: 0.8, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
      epitaph: { text: 'T', visibleFacts: 'F', inferredIntent: null, uncertain: true, versionNumber: 1, origin: 'ai_generate' },
    };
    const r = await getAnalysis(4, fetchOf(() => json(body)));
    expect(r.ok && r.data.epitaph.visibleFacts).toBe('F');
    expect(r.ok && r.data.epitaph.uncertain).toBe(true);
  });

  it('Batch 6A: parses an AI next-step suggestion and ignores anything unrecognised', async () => {
    const body = (suggestedAction: unknown) => ({
      screenshotId: 4,
      classification: { category: 'Reference/Document', confidence: 0.8, uncertain: false, versionNumber: 1, origin: 'ai_generate', suggestedAction },
      epitaph: { text: 'T', visibleFacts: 'F', inferredIntent: null, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
    });
    for (const [given, expected] of [['add_calendar', 'add_calendar'], ['make_notes', 'make_notes'], [null, null], [undefined, null], ['buy_it', null], [5, null]] as const) {
      const r = await getAnalysis(4, fetchOf(() => json(body(given))));
      expect(r.ok && r.data.classification.suggestedAction).toBe(expected);
    }
  });
  it('sends analysis edits in the wire format the server expects', async () => {
    const f = fetchOf(() => json({}, 400));
    await editAnalysis(2, { category: 'Study/Knowledge', epitaphText: 'mine' }, f);
    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/screenshots/2/analysis/edits');
    expect(JSON.parse(init.body)).toEqual({ category: 'Study/Knowledge', epitaphText: 'mine' });
  });

  it('sends study-note edits as JSON content and builds export URLs', async () => {
    const f = fetchOf(() => json({}, 400));
    const content = { topic: 'T', main_concepts: [], extracted_code: ['a\n\tb'], code_explanations: [], pitfalls: [], uncertain_content: [] };
    await saveStudyNoteEdit(7, content, 31, f);
    expect(JSON.parse((f as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({ baseVersionId: 31, content });
    expect(studyNoteExportUrl(7)).toBe('/api/study-notes/7/export');
    expect(studyNoteExportUrl(7, 12)).toBe('/api/study-notes/7/export?versionId=12');
  });
});

// Batch 4B: calendar event drafts.

const eventBody = (over: Record<string, unknown> = {}, content: Record<string, unknown> = {}) => ({
  artifactId: 8, versionId: 11, versionNumber: 1, origin: 'ai_generate', sourceScreenshotIds: [3],
  content: {
    title: 'Simulated event draft (Fake AI)', start_date: null, start_time: null, end_date: null, end_time: null,
    all_day: null, time_zone: null, location: null, description: 'Placeholder text from the Fake AI.',
    missing_fields: ['start_date', 'start_time', 'end_date', 'end_time', 'all_day', 'time_zone', 'location'],
    uncertain_fields: ['title'], references: [3], ...content,
  },
  ...over,
});

describe('Calendar event draft API client (Batch 4B)', () => {
  it('polls an event_draft operation like any other operation kind', async () => {
    const r = await getOperation(4, fetchOf(() => json({ operationId: 4, kind: 'event_draft', status: 'uncertain', artifactId: 8 })));
    expect(r).toEqual({ ok: true, data: { operationId: 4, kind: 'event_draft', status: 'uncertain', errorDetail: null, artifactId: 8 } });
  });

  it('posts add_calendar to the preparation route and parses the answer for that action only', async () => {
    const body = { screenshotId: 3, action: 'add_calendar', operationId: 4, kind: 'event_draft', status: 'pending', artifactId: null, errorDetail: null, provider: 'fake', reused: false };
    const f = fetchOf(() => json(body, 202));
    const r = await requestEventDraft(3, f);
    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/screenshots/3/preparations');
    expect(JSON.parse(init.body)).toEqual({ action: 'add_calendar' });
    expect(r.ok && r.data.action).toBe('add_calendar');
    // A Make Notes answer is never accepted as a calendar preparation (or for another screenshot).
    expect((await getEventDraftPreparation(3, fetchOf(() => json({ ...body, action: 'make_notes' })))).ok).toBe(false);
    expect((await getEventDraftPreparation(4, fetchOf(() => json(body)))).ok).toBe(false);
    const lookup = fetchOf(() => json(body));
    expect((await getEventDraftPreparation(3, lookup)).ok).toBe(true);
    const [lookupUrl, lookupInit] = (lookup as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(lookupUrl).toBe('/api/screenshots/3/preparations/add_calendar');
    expect(lookupInit.method).toBe('GET');
  });

  it('Batch 6A: parses the other events a screenshot shows, and rejects malformed ones', async () => {
    const ok = await getEventDraft(8, fetchOf(() => json(eventBody({}, { other_events: ['Lab · 2026-12-03'] }))));
    expect(ok.ok && ok.data.content.otherEvents).toEqual(['Lab · 2026-12-03']);
    const absent = await getEventDraft(8, fetchOf(() => json(eventBody())));
    expect(absent.ok && absent.data.content.otherEvents).toEqual([]);
    for (const bad of ['Lab', [1], [''], Array.from({ length: 11 }, () => 'x')]) {
      expect((await getEventDraft(8, fetchOf(() => json(eventBody({}, { other_events: bad }))))).ok).toBe(false);
    }
  });
  it('parses a simulated draft with every unknown field kept empty', async () => {
    const r = await getEventDraft(8, fetchOf(() => json(eventBody())));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.content.startDate).toBeNull();
    expect(r.data.content.missingFields).toContain('time_zone');
    expect(r.data.content.uncertainFields).toEqual(['title']);
  });

  it.each([
    ['a missing field that has a value', {}, { start_date: '2026-12-01' }],
    ['a malformed date', {}, { start_date: '12/01/2026', missing_fields: ['start_time', 'end_date', 'end_time', 'all_day', 'time_zone', 'location'] }],
    ['a malformed time', {}, { start_time: '3pm', missing_fields: ['start_date', 'end_date', 'end_time', 'all_day', 'time_zone', 'location'] }],
    ['an unknown field name', {}, { missing_fields: ['duration'] }],
    ['a non-boolean all_day', {}, { all_day: 'no', missing_fields: ['start_date', 'start_time', 'end_date', 'end_time', 'time_zone', 'location'] }],
    ['missing source ids', { sourceScreenshotIds: 'x' }, {}],
  ])('rejects %s instead of showing it', async (_n, over, content) => {
    expect((await getEventDraft(8, fetchOf(() => json(eventBody(over, content))))).ok).toBe(false);
  });
});

describe('B2: preparation answers must carry the expected operation kind', () => {
  const base = { screenshotId: 3, operationId: 4, status: 'pending', artifactId: null, errorDetail: null, provider: 'fake', reused: false };
  it('rejects a calendar preparation whose operation is a study_note, and vice versa', async () => {
    expect((await getEventDraftPreparation(3, fetchOf(() => json({ ...base, action: 'add_calendar', kind: 'study_note' })))).ok).toBe(false);
    expect((await requestEventDraft(3, fetchOf(() => json({ ...base, action: 'add_calendar', kind: 'event_draft' }, 202)))).ok).toBe(true);
    expect((await requestEventDraft(3, fetchOf(() => json({ ...base, action: 'add_calendar' }, 202)))).ok).toBe(false);
  });
});

describe('Approval API client (Batch 5B)', () => {
  const st = (over: Record<string, unknown> = {}, elig: Record<string, unknown> = {}) => ({
    artifactId: 5, kind: 'event_draft', currentVersionId: 12, currentVersionNumber: 2, status: 'never_approved', approvals: [],
    eligibility: { eligible: true, reasons: [], requiredAcknowledgements: [], aiOriginFields: [], ...elig }, ...over,
  });
  const record = (versionId: number, versionNumber: number) => ({
    approvalId: 1, artifactId: 5, versionId, versionNumber, approvedAt: '2026-11-25T10:00:00+00:00', approvedBy: 'workspace',
    acknowledgedUncertain: [], aiOriginFields: [],
  });
  it('accepts a consistent status and rejects inconsistent ones', async () => {
    expect((await getApprovalStatus(5, fetchOf(() => json(st())))).ok).toBe(true);
    expect((await getApprovalStatus(5, fetchOf(() => json(st({ status: 'current_approved', approvals: [record(12, 2)] }))))).ok).toBe(true);
    for (const bad of [
      st({ status: 'current_approved' }),                                   // claims approved with no record
      st({ status: 'current_approved', approvals: [record(11, 1)] }),       // only an OLDER version approved
      st({ status: 'older_approved', approvals: [record(12, 2)] }),         // the current one IS approved
      st({ status: 'never_approved', approvals: [record(11, 1)] }),
      st({}, { eligible: true, reasons: [{ field: 'title', code: 'missing', message: 'x' }] }),
      st({ artifactId: 6 }),
      st({ approvals: [{ ...record(12, 2), approvedAt: 'yesterday' }], status: 'current_approved' }),
    ]) {
      expect((await getApprovalStatus(5, fetchOf(() => json(bad)))).ok).toBe(false);
    }
  });
  it('posts the explicit confirmation and rejects an answer for another version', async () => {
    const f = fetchOf(() => json({ approval: record(12, 2), approvalResult: 'created' }, 201));
    expect((await approveVersion(5, 12, ['title'], f)).ok).toBe(true);
    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/artifacts/5/approvals');
    expect(JSON.parse(init.body)).toEqual({ versionId: 12, confirmReviewed: true, acknowledgeUncertain: ['title'] });
    expect((await approveVersion(5, 13, [], fetchOf(() => json({ approval: record(12, 2), approvalResult: 'created' }, 201)))).ok).toBe(false);
  });
});
