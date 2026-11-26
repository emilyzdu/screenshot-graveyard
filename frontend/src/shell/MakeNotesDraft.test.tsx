import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VersionInfo } from '../api/ai';
import type { Analysis, ApiResult, Operation, Preparation, ProviderMode, StudyNoteVersion } from '../api/ai';
import type { ListResult, Screenshot, ScreenshotAnalysis } from '../api/client';

// Batch 4A: the real Make Notes Prepare → Persist → Reopen flow in the Live
// Workspace. API modules are mocked; nothing touches the network or a provider.
const client = vi.hoisted(() => ({
  getWorkspace: vi.fn(), listScreenshots: vi.fn<() => Promise<ListResult>>(), uploadScreenshots: vi.fn(),
  archiveScreenshot: vi.fn(), restoreScreenshot: vi.fn(),
}));
vi.mock('../api/client', () => ({ ...client, imageUrl: (id: number) => `/api/screenshots/${id}/image` }));
const ai = vi.hoisted(() => ({
  getProviderMode: vi.fn<() => Promise<ApiResult<ProviderMode>>>(),
  getConsent: vi.fn(), setConsent: vi.fn(), classifyScreenshot: vi.fn(),
  getOperation: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Operation>>>(),
  getAnalysis: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Analysis>>>(),
  getMakeNotesPreparation: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Preparation>>>(),
  requestMakeNotesDraft: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Preparation>>>(),
  getStudyNote: vi.fn<(artifactId: number, versionId?: number, f?: typeof fetch) => Promise<ApiResult<StudyNoteVersion>>>(),
  // Batch 4B: the calendar panel is mounted alongside; no event draft unless a test says so.
  getEventDraftPreparation: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Preparation>>>(),
  requestEventDraft: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Preparation>>>(),
  // Batch 5A: version history and edits.
  listStudyNoteVersions: vi.fn<(artifactId: number, f?: typeof fetch) => Promise<ApiResult<VersionInfo[]>>>(),
  listEventDraftVersions: vi.fn<(artifactId: number, f?: typeof fetch) => Promise<ApiResult<VersionInfo[]>>>(),
  saveEventDraftEdit: vi.fn(),
  // Batch 5B: approval.
  getApprovalStatus: vi.fn(),
  approveVersion: vi.fn(),
  saveStudyNoteEdit: vi.fn(),
  getEventDraft: vi.fn(),
}));
vi.mock('../api/ai', () => ai);
import LiveWorkspace from './LiveWorkspace';

const sum = (category: string): ScreenshotAnalysis => ({ category, uncertain: false, epitaph: 'Epi', epitaphOrigin: 'ai_generate' });
const shot = (id: number, name: string, category = 'Study/Knowledge'): Screenshot => ({
  screenshotId: id, state: 'active', mimeType: 'image/png', originalFilename: name,
  isDuplicate: false, duplicateOf: null, byteSize: 9, uploadedAt: '2026-11-19T20:00:00Z', analysis: sum(category),
});
const analysis = (id: number, category = 'Study/Knowledge'): Analysis => ({
  screenshotId: id,
  classification: { category: category as Analysis['classification']['category'], confidence: 0.75, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
  epitaph: { text: 'Epi', visibleFacts: 'Synthetic adapter does not interpret image content.', inferredIntent: null, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
});
const prep = (id: number, over: Partial<Preparation> = {}): Preparation => ({
  screenshotId: id, action: 'make_notes', operationId: 70, status: 'pending', artifactId: null,
  errorDetail: null, provider: 'fake', reused: false, ...over,
});
const note = (artifactId: number, sources: number[], origin = 'ai_generate'): StudyNoteVersion => ({
  artifactId, versionId: 1, versionNumber: 1, origin, sourceScreenshotIds: sources,
  content: {
    topic: 'Synthetic study note fixture', main_concepts: ['Deterministic test fixture'], extracted_code: [],
    code_explanations: [], pitfalls: [], uncertain_content: [], references: sources,
  },
});
const op = (status: Operation['status'], artifactId: number | null = null, errorDetail: string | null = null): ApiResult<Operation> =>
  ({ ok: true, data: { operationId: 70, kind: 'study_note', status, errorDetail, artifactId } });
const fail = (status: number, code: string): ApiResult<never> => ({ ok: false, status, code, message: code });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: nothing approved, current version eligible, for whatever draft is open.
  ai.getApprovalStatus.mockImplementation(async (artifactId: number) => ({ ok: true, data: {
    artifactId, kind: 'event_draft', currentVersionId: -1, currentVersionNumber: 1, status: 'never_approved', approvals: [],
    eligibility: { eligible: false, reasons: [{ field: null, code: 'test_default', message: 'Not configured in this test.' }], requiredAcknowledgements: [], aiOriginFields: [] },
  } }));
  ai.listStudyNoteVersions.mockImplementation(async () => ({ ok: true, data: [{ versionId: 1, versionNumber: 1, origin: 'ai_generate', isCurrent: true }] }));
  ai.listEventDraftVersions.mockImplementation(async () => ({ ok: true, data: [{ versionId: 1, versionNumber: 1, origin: 'ai_generate', isCurrent: true }] }));
  client.getWorkspace.mockResolvedValue({ ok: true, active: true });
  client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [shot(1, 'lecture.png'), shot(2, 'shoes.png', 'Shopping/Inspiration')] });
  ai.getProviderMode.mockResolvedValue({ ok: true, data: 'fake' });
  ai.getConsent.mockResolvedValue({ ok: true, data: true });
  ai.getAnalysis.mockImplementation(async (id) => ({ ok: true, data: analysis(id, id === 2 ? 'Shopping/Inspiration' : 'Study/Knowledge') }));
  ai.getMakeNotesPreparation.mockResolvedValue(fail(404, 'no_preparation'));
  ai.getEventDraftPreparation.mockResolvedValue(fail(404, 'no_preparation'));
  ai.getOperation.mockResolvedValue(op('successful', 501));
  ai.getStudyNote.mockImplementation(async (aid) => ({ ok: true, data: note(aid, [1]) }));
});

const A = () => screen.getByTestId('live-assistant');
const region = () => within(A()).getByRole('region', { name: 'Make Notes draft' });
const select = async (n: string) => { await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: `Select ${n}` })); }); };
const otherMutations = () => [ai.classifyScreenshot, ai.setConsent, client.archiveScreenshot, client.restoreScreenshot, client.uploadScreenshots]
  .reduce((n, f) => n + f.mock.calls.length, 0);
async function chooseMakeNotes() {
  await select('lecture.png');
  await within(A()).findByText('Visible facts');
  await act(async () => { fireEvent.click(within(A()).getByRole('button', { name: 'Choose Make Notes' })); });
  return within(A()).findByRole('button', { name: 'Prepare draft' });
}
const NO_DELIVERY_CLAIM = /(?<!not )(approved|exported|delivered|sent to (onenote|calendar))/i;

describe('Make Notes: prepare, persist, reopen', () => {
  it('explicit Prepare → pending → Draft ready (simulated) → Open draft shows the persisted note', async () => {
    ai.requestMakeNotesDraft.mockResolvedValue({ ok: true, data: prep(1) });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    const prepareBtn = await chooseMakeNotes();
    expect(ai.requestMakeNotesDraft).not.toHaveBeenCalled(); // choosing alone sends nothing
    await act(async () => { fireEvent.click(prepareBtn); });
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledTimes(1);
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledWith(1, expect.any(Function));
    expect(await within(region()).findByText('Draft ready')).toBeInTheDocument();
    expect(ai.getOperation).toHaveBeenCalledWith(70, expect.any(Function));
    expect(within(region()).getByText('Simulated draft · Fake AI')).toBeInTheDocument();
    expect(within(region()).getByText(/Saved in your workspace as draft #501(, version \d+)?\. Not exported and not sent anywhere/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: 'Open draft' })); });
    expect(ai.getStudyNote).toHaveBeenCalledWith(501, undefined, expect.any(Function));
    const body = within(region()).getByRole('article', { name: /Notes draft/ });
    expect(within(body).getByText('Synthetic study note fixture')).toBeInTheDocument();
    expect(within(body).getByText(/the Fake AI wrote placeholder text without reading your screenshot/)).toBeInTheDocument();
    expect(within(body).getByText('Screenshot #1')).toBeInTheDocument();
    expect(within(body).getByText(/Version 1, simulated by the Fake AI\./)).toBeInTheDocument();
    expect(A().textContent ?? '').not.toMatch(NO_DELIVERY_CLAIM);
    expect(otherMutations()).toBe(0);
  });

  it('after a reload the persisted draft reopens without choosing again and without any POST', async () => {
    ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep(1, { status: 'successful', artifactId: 501 }) });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    expect(await within(A()).findByText('Draft ready')).toBeInTheDocument();
    expect(ai.getMakeNotesPreparation).toHaveBeenCalledWith(1, expect.any(Function));
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: 'Open draft' })); });
    expect(within(region()).getByText('Synthetic study note fixture')).toBeInTheDocument();
    expect(ai.requestMakeNotesDraft).not.toHaveBeenCalled();
  });

  it('a preparation still running on reopen is resumed by polling the same operation, not re-sent', async () => {
    ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep(1) });
    ai.getOperation.mockResolvedValueOnce(op('pending')).mockResolvedValue(op('successful', 501));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Select lecture.png' })); await vi.advanceTimersByTimeAsync(0); });
      expect(within(A()).getByText('Preparing a simulated notes draft on the server…')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    } finally {
      vi.useRealTimers();
    }
    expect(await within(A()).findByText('Draft ready')).toBeInTheDocument();
    expect(ai.requestMakeNotesDraft).not.toHaveBeenCalled();
    expect(ai.getOperation.mock.calls.every(([id]) => id === 70)).toBe(true);
  });

  it('rapid repeated clicks send one request; a reused server answer is shown the same way', async () => {
    const post = deferred<ApiResult<Preparation>>();
    ai.requestMakeNotesDraft.mockReturnValue(post.promise);
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    const btn = await chooseMakeNotes();
    // The rendered handler, called repeatedly in one turn (before React can re-render
    // the button away), as a double click or a stale handler would.
    const key = Object.keys(btn).find((k) => k.startsWith('__reactProps'))!;
    const onClick = (btn as unknown as Record<string, { onClick: () => void }>)[key].onClick;
    await act(async () => { onClick(); onClick(); onClick(); });
    fireEvent.click(btn);
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledTimes(1);
    await act(async () => { post.resolve({ ok: true, data: prep(1, { status: 'successful', artifactId: 501, reused: true }) }); });
    expect(within(region()).getByText('Draft ready')).toBeInTheDocument();
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledTimes(1);
  });

  it('a failed preparation says so and Retry is one explicit new request', async () => {
    ai.requestMakeNotesDraft
      .mockResolvedValueOnce({ ok: true, data: prep(1) })
      .mockResolvedValueOnce({ ok: true, data: prep(1, { operationId: 71 }) });
    ai.getOperation.mockResolvedValueOnce(op('failed', null, 'AI analysis failed')).mockResolvedValue({ ok: true, data: { operationId: 71, kind: 'study_note', status: 'successful', errorDetail: null, artifactId: 502 } });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    const prepareBtn = await chooseMakeNotes();
    await act(async () => { fireEvent.click(prepareBtn); });
    expect(await within(region()).findByText(/Preparation failed\. The AI analysis did not complete/)).toBeInTheDocument();
    expect(within(region()).queryByText('Draft ready')).not.toBeInTheDocument();
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledTimes(1); // never retried by itself
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: 'Retry preparation' })); });
    expect(await within(region()).findByText(/draft #502/)).toBeInTheDocument();
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['consent required', fail(403, 'consent_required'), /Open it and allow AI processing first/, true],
    ['archived', fail(409, 'screenshot_archived'), /Resurrect it before preparing a draft/, false],
    ['real provider blocked', fail(409, 'provider_not_permitted'), /turned off with a real AI provider/, false],
    ['not found', fail(404, 'not_found'), /could not be found in your workspace/, false],
  ])('server refusal (%s) is shown, nothing is polled, and nothing is claimed', async (_n, res, text, canRetry) => {
    ai.requestMakeNotesDraft.mockResolvedValue(res as ApiResult<Preparation>);
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    const prepareBtn = await chooseMakeNotes();
    await act(async () => { fireEvent.click(prepareBtn); });
    expect(within(region()).getByText(text)).toBeInTheDocument();
    expect(within(region()).getByText(/Nothing was prepared/)).toBeInTheDocument();
    expect(within(region()).queryByRole('button', { name: 'Try again' }) !== null).toBe(canRetry);
    expect(ai.getOperation).not.toHaveBeenCalled();
    expect(within(region()).queryByText('Draft ready')).not.toBeInTheDocument();
  });

  it('a lost Prepare response is reconciled with a read, never re-sent', async () => {
    ai.requestMakeNotesDraft.mockResolvedValue(fail(0, 'network'));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    const btn = await chooseMakeNotes();
    ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep(1, { status: 'successful', artifactId: 501 }) });
    await act(async () => { fireEvent.click(btn); });
    expect(await within(region()).findByText('Draft ready')).toBeInTheDocument();
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledTimes(1);
    expect(ai.getMakeNotesPreparation).toHaveBeenCalledTimes(2); // open + reconcile
  });

  it('a failed lookup is not treated as "no draft": it offers Check again, not Prepare', async () => {
    ai.getMakeNotesPreparation.mockResolvedValue(fail(503, 'service_unavailable'));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    expect(await within(A()).findByText(/Could not check whether a Make Notes draft exists/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(A()).getByRole('button', { name: 'Choose Make Notes' })); });
    expect(within(A()).queryByRole('button', { name: 'Prepare draft' })).not.toBeInTheDocument();
    ai.getMakeNotesPreparation.mockResolvedValue(fail(404, 'no_preparation'));
    await act(async () => { fireEvent.click(within(A()).getByRole('button', { name: 'Check again' })); });
    expect(await within(A()).findByRole('button', { name: 'Prepare draft' })).toBeEnabled();
  });

  it('a draft that does not belong to this screenshot is not shown', async () => {
    ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep(1, { status: 'successful', artifactId: 501 }) });
    ai.getStudyNote.mockResolvedValue({ ok: true, data: note(501, [2]) });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    await within(A()).findByText('Draft ready');
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: 'Open draft' })); });
    expect(within(region()).getByText('The draft could not be loaded. Try opening it again.')).toBeInTheDocument();
    expect(within(region()).queryByText('Synthetic study note fixture')).not.toBeInTheDocument();
  });

  it('provenance comes from the server record: a Fake draft viewed in openai mode is still "Simulated"; Prepare is disabled', async () => {
    ai.getProviderMode.mockResolvedValue({ ok: true, data: 'openai' });
    ai.getMakeNotesPreparation.mockImplementation(async (id) =>
      id === 1 ? { ok: true, data: prep(1, { status: 'successful', artifactId: 501 }) } : fail(404, 'no_preparation'));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    expect(await within(A()).findByText('Simulated draft · Fake AI')).toBeInTheDocument();
    await select('lecture.png');
    await select('shoes.png');
    await within(A()).findByText('Visible facts');
    fireEvent.click(within(A()).getByRole('button', { name: /Something else/ }));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Make Notes' })); });
    expect(await within(A()).findByRole('button', { name: 'Prepare draft' })).toBeDisabled();
    expect(within(A()).getByText(/turned off with a real AI provider/)).toBeInTheDocument();
  });

  it('an edited draft is labelled as edited by you, not simulated', async () => {
    ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep(1, { status: 'successful', artifactId: 501 }) });
    ai.getStudyNote.mockResolvedValue({ ok: true, data: note(501, [1], 'manual_edit') });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    await within(A()).findByText('Draft ready');
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: 'Open draft' })); });
    expect(within(region()).getByText('Edited by you · started from a simulated draft')).toBeInTheDocument();
    expect(within(region()).queryByText(/wrote placeholder text without reading/)).not.toBeInTheDocument();
  });

  it('switching screenshots while a lookup is pending never shows the earlier screenshot\'s draft', async () => {
    const slow = deferred<ApiResult<Preparation>>();
    ai.getMakeNotesPreparation.mockImplementation((id) => (id === 1 ? slow.promise : Promise.resolve(fail(404, 'no_preparation'))));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    await select('lecture.png');
    await select('shoes.png');
    await within(A()).findByText('Visible facts');
    await act(async () => { slow.resolve({ ok: true, data: prep(1, { status: 'successful', artifactId: 501 }) }); });
    await waitFor(() => expect(within(A()).queryByText(/Checking for a Make Notes draft/)).not.toBeInTheDocument());
    expect(within(A()).queryByText('Draft ready')).not.toBeInTheDocument();
  });

  it('closing the assistant\'s screenshot mid-poll stops polling and leaves no timers', async () => {
    ai.requestMakeNotesDraft.mockResolvedValue({ ok: true, data: prep(1) });
    ai.getOperation.mockResolvedValue(op('pending'));
    const view = render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    const btn = await chooseMakeNotes();
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(btn); await vi.advanceTimersByTimeAsync(0); });
      const polls = ai.getOperation.mock.calls.length;
      expect(polls).toBeGreaterThan(0);
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ai.getOperation).toHaveBeenCalledTimes(polls);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Retry must follow the CURRENT action for the CURRENT screenshot, at click time.
describe('Make Notes: retry follows the current action', () => {
  const capture = (btn: HTMLElement) => {
    const key = Object.keys(btn).find((k) => k.startsWith('__reactProps'))!;
    return (btn as unknown as Record<string, { onClick: () => void }>)[key].onClick;
  };
  const chooseOther = async (label: string) => {
    fireEvent.click(within(A()).getByRole('button', { name: /Something else/ }));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: label })); });
  };
  async function failOnce() {
    ai.requestMakeNotesDraft.mockResolvedValue({ ok: true, data: prep(1) });
    ai.getOperation.mockResolvedValue(op('failed', null, 'AI analysis failed'));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    const prepareBtn = await chooseMakeNotes();
    await act(async () => { fireEvent.click(prepareBtn); });
    await within(region()).findByText(/Preparation failed\./);
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledTimes(1);
  }
  const retryBtn = () => within(region()).queryByRole('button', { name: 'Retry preparation' });

  it('Make Notes selected: Retry is offered and sends one request', async () => {
    await failOnce();
    await act(async () => { fireEvent.click(retryBtn()!); });
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledTimes(2);
    expect(ai.requestMakeNotesDraft).toHaveBeenLastCalledWith(1, expect.any(Function));
  });

  it('Add to Calendar selected: the failure stays readable but no Make Notes retry is offered', async () => {
    await failOnce();
    await chooseOther('Add to Calendar');
    expect(within(region()).getByText(/Preparation failed\. The AI analysis did not complete/)).toBeInTheDocument();
    expect(retryBtn()).not.toBeInTheDocument();
    expect(within(region()).getByText(/Choose Make Notes to try again/)).toBeInTheDocument();
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledTimes(1);
  });

  it('cleared selection: no retry is offered', async () => {
    await failOnce();
    await act(async () => { fireEvent.click(within(A()).getByRole('button', { name: 'Clear choice' })); });
    expect(within(region()).getByText(/Preparation failed\./)).toBeInTheDocument();
    expect(retryBtn()).not.toBeInTheDocument();
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledTimes(1);
  });

  it('a Retry handler captured before switching to Add to Calendar is rejected when invoked', async () => {
    await failOnce();
    const stale = capture(retryBtn()!);
    await chooseOther('Add to Calendar');
    await act(async () => { stale(); });
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledTimes(1);
    expect(within(region()).getByText(/Preparation failed\./)).toBeInTheDocument();
  });

  it('a Retry handler captured before switching screenshots never submits for the earlier screenshot', async () => {
    await failOnce();
    const stale = capture(retryBtn()!);
    await select('lecture.png');
    await select('shoes.png');
    await within(A()).findByText('Visible facts');
    await act(async () => { stale(); });
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledTimes(1);
  });

  it('a saved draft stays readable while another action is selected, without any POST', async () => {
    ai.getMakeNotesPreparation.mockResolvedValue({ ok: true, data: prep(1, { status: 'successful', artifactId: 501 }) });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    await within(A()).findByText('Draft ready');
    await chooseOther('Add to Calendar');
    expect(within(region()).getByText('Draft ready')).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: 'Open draft' })); });
    expect(within(region()).getByText('Synthetic study note fixture')).toBeInTheDocument();
    expect(ai.requestMakeNotesDraft).not.toHaveBeenCalled();
  });
});

describe('B2: Make Notes polling only accepts its own study_note operation', () => {
  it.each([
    ['an event_draft operation', { kind: 'event_draft' as const }],
    ['another operation id', { operationId: 999 }],
  ])('a successful answer for %s is never shown as Draft ready', async (_n, over) => {
    ai.requestMakeNotesDraft.mockResolvedValue({ ok: true, data: prep(1) });
    ai.getOperation.mockResolvedValue({ ok: true, data: { operationId: 70, kind: 'study_note', status: 'successful', errorDetail: null, artifactId: 601, ...over } });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    const btn = await chooseMakeNotes();
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(btn); await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    } finally {
      vi.useRealTimers();
    }
    expect(within(region()).queryByText('Draft ready')).not.toBeInTheDocument();
    expect(within(region()).getByRole('button', { name: 'Check status' })).toBeInTheDocument();
    expect(ai.getStudyNote).not.toHaveBeenCalled();
    expect(ai.requestMakeNotesDraft).toHaveBeenCalledTimes(1);
  });
});
