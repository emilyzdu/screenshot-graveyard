import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Accepted, Analysis, ApiResult, Operation, ProviderMode } from '../api/ai';
import type { ListResult, Screenshot, ScreenshotAnalysis } from '../api/client';

// Batch 3B: backend-driven cards and the Live Quiet Assistant. Both API modules
// are mocked; nothing here touches the network or an AI provider.
const client = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  listScreenshots: vi.fn<() => Promise<ListResult>>(),
  uploadScreenshots: vi.fn(),
  archiveScreenshot: vi.fn(),
  restoreScreenshot: vi.fn(),
}));
vi.mock('../api/client', () => ({ ...client, imageUrl: (id: number) => `/api/screenshots/${id}/image` }));
const ai = vi.hoisted(() => ({
  getProviderMode: vi.fn<() => Promise<ApiResult<ProviderMode>>>(),
  getConsent: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<boolean>>>(),
  setConsent: vi.fn(),
  classifyScreenshot: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Accepted>>>(),
  getOperation: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Operation>>>(),
  getAnalysis: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Analysis>>>(),
  // Batch 4A: no Make Notes preparation exists unless a test says otherwise.
  getMakeNotesPreparation: vi.fn<typeof import('../api/ai').getMakeNotesPreparation>(() =>
    Promise.resolve({ ok: false as const, status: 404, code: 'no_preparation', message: 'No preparation yet' })),
  requestMakeNotesDraft: vi.fn(),
  // Batch 4B: no calendar event draft exists unless a test says otherwise.
  getEventDraftPreparation: vi.fn<typeof import('../api/ai').getEventDraftPreparation>(() =>
    Promise.resolve({ ok: false as const, status: 404, code: 'no_preparation', message: 'No preparation yet' })),
  requestEventDraft: vi.fn(),
  // Batch 5A: version history and edits (inert unless a test configures them).
  listStudyNoteVersions: vi.fn(),
  listEventDraftVersions: vi.fn(),
  saveEventDraftEdit: vi.fn(),
  // Batch 5B: approval (inert unless a test configures it).
  getApprovalStatus: vi.fn(),
  approveVersion: vi.fn(),
  saveStudyNoteEdit: vi.fn(),
  getEventDraft: vi.fn(),
  getStudyNote: vi.fn(),
}));
vi.mock('../api/ai', () => ai);
import LiveWorkspace from './LiveWorkspace';

const base = (id: number, name: string, analysis: ScreenshotAnalysis | null = null): Screenshot => ({
  screenshotId: id, state: 'active', mimeType: 'image/png', originalFilename: name,
  isDuplicate: false, duplicateOf: null, byteSize: 512, uploadedAt: '2026-11-19T20:00:00Z', analysis,
});
const summary = (category: string, epitaph: string, extra: Partial<ScreenshotAnalysis> = {}): ScreenshotAnalysis => ({
  category, uncertain: false, epitaph, epitaphOrigin: 'ai_generate', ...extra,
});
const full = (id: number, category: string, epitaph: string, extra: { inferredIntent?: string | null; origin?: string; uncertain?: boolean } = {}): Analysis => ({
  screenshotId: id,
  classification: { category: category as Analysis['classification']['category'], confidence: 0.75, uncertain: extra.uncertain ?? false, versionNumber: 1, origin: extra.origin ?? 'ai_generate' },
  epitaph: { text: epitaph, visibleFacts: 'Synthetic adapter does not interpret image content.', inferredIntent: extra.inferredIntent ?? null, uncertain: false, versionNumber: 1, origin: extra.origin ?? 'ai_generate' },
});
const fail = (status: number, code: string): ApiResult<never> => ({ ok: false, status, code, message: code });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

const study = base(1, 'lecture.png', summary('Study/Knowledge', 'Saved to study later (synthetic).'));
const doc = base(2, 'doc.png', summary('Reference/Document', 'Synthetic reference fixture.'));
const ghost = base(3, 'ghost.png');
const fullFor: Record<number, Analysis> = {
  1: full(1, 'Study/Knowledge', 'Saved to study later (synthetic).', { inferredIntent: 'Maybe for an exam' }),
  2: full(2, 'Reference/Document', 'Synthetic reference fixture.'),
};

beforeEach(() => {
  vi.clearAllMocks();
  client.getWorkspace.mockResolvedValue({ ok: true, active: true });
  client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [study, doc, ghost] });
  ai.getProviderMode.mockResolvedValue({ ok: true, data: 'fake' });
  ai.getConsent.mockResolvedValue({ ok: true, data: false });
  ai.getAnalysis.mockImplementation(async (id) => (fullFor[id] ? { ok: true, data: fullFor[id] } : fail(404, 'not_found')));
});

const card = (name: string) => screen.getByRole('article', { name });
const assistant = () => screen.getByTestId('live-assistant');
async function select(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: `Select ${name}` })); });
}
/** Every request-making mock, so "no side effects" can be asserted precisely. */
const sideEffects = () => ({
  classify: ai.classifyScreenshot.mock.calls.length,
  consent: ai.setConsent.mock.calls.length,
  op: ai.getOperation.mock.calls.length,
  archive: client.archiveScreenshot.mock.calls.length,
  restore: client.restoreScreenshot.mock.calls.length,
  upload: client.uploadScreenshots.mock.calls.length,
  analysis: ai.getAnalysis.mock.calls.length,
  list: client.listScreenshots.mock.calls.length,
});

describe('Batch 3B cards: real saved analysis', () => {
  it('shows category, Epitaph, Fake AI provenance and withholds suggestions before detail validation; browsing sends nothing', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await waitFor(() => expect(card('lecture.png')).toHaveTextContent('Epitaph: simulated (Fake AI)'));
    const l = card('lecture.png');
    expect(l).toHaveTextContent('Study/Knowledge');
    expect(l).toHaveTextContent('Saved to study later (synthetic).');
    expect(l).not.toHaveTextContent('Suggested (rule):');
    expect(l).toHaveTextContent('Revived');
    expect(l).not.toHaveTextContent('%');
    const d = card('doc.png');
    expect(d).toHaveTextContent('Reference/Document');
    expect(d).not.toHaveTextContent('Suggested');
    expect(d).toHaveTextContent('No suggestion');
    expect(d.textContent?.match(/Revived/g)).toHaveLength(1);
    expect(card('ghost.png')).toHaveTextContent('Ghost');
    expect(card('ghost.png')).not.toHaveTextContent('Simulated');
    // Displaying cards reads the list only: no analysis read, no classification, no consent change.
    expect(sideEffects()).toMatchObject({ classify: 0, consent: 0, op: 0, analysis: 0 });
  });

  it('labels a manual edit honestly and never suggests for an uncertain classification', async () => {
    client.listScreenshots.mockResolvedValue({
      ok: true,
      screenshots: [
        base(4, 'edited.png', summary('Memory/Entertainment', 'Trip photos', { epitaphOrigin: 'manual_edit' })),
        base(5, 'unsure.png', summary('Study/Knowledge', 'Maybe notes', { uncertain: true })),
      ],
    });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'edited.png' });
    expect(card('edited.png')).toHaveTextContent('Epitaph: edited by you');
    expect(card('edited.png')).not.toHaveTextContent('Suggested (rule):');
    expect(card('unsure.png')).toHaveTextContent('uncertain');
    expect(card('unsure.png')).not.toHaveTextContent('Suggested');
  });

  it('does not show analysis on archived cards in The Crypt', async () => {
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [{ ...study, state: 'archived' }] });
    render(<LiveWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /The Crypt/ }));
    expect(card('lecture.png')).toHaveTextContent('Archived');
    expect(card('lecture.png')).not.toHaveTextContent('Suggested');
    expect(screen.queryByRole('checkbox', { name: 'Select lecture.png' })).not.toBeInTheDocument();
  });
});

describe('Batch 3B Quiet Assistant', () => {
  it('idle until something is selected, and never shows demo drafts or activity in Live mode', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    expect(within(assistant()).getByText(/Tick a screenshot.s box/)).toBeInTheDocument();
    for (const fake of [/Prepared:/, /Recent Activity/, /Review draft/, /Looks like lecture screenshots/, /Added after approval/]) {
      expect(screen.queryByText(fake)).not.toBeInTheDocument();
    }
    expect(ai.getAnalysis).not.toHaveBeenCalled();
  });

  it('reads the saved analysis once (bounded) and shows category, Epitaph, facts, guessed reason and provenance', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    const a = assistant();
    await within(a).findByText('Visible facts');
    expect(ai.getAnalysis).toHaveBeenCalledTimes(1);
    expect(ai.getAnalysis).toHaveBeenCalledWith(1, expect.any(Function));
    expect(within(a).getByText('Study/Knowledge')).toBeInTheDocument();
    expect(within(a).getByText(/Category generated by the demo AI .*; Epitaph generated by the demo AI/)).toBeInTheDocument();
    expect(within(a).getByText('Synthetic adapter does not interpret image content.')).toBeInTheDocument();
    expect(within(a).getByText('Maybe for an exam (a guess, not a fact)')).toBeInTheDocument();
    expect(within(a).getAllByText(/demo AI \(placeholder text, not real image understanding\)/)).not.toHaveLength(0);
    expect(within(a).queryByText(/%/)).not.toBeInTheDocument();
    expect(within(a).getByText('Suggested · rule-based')).toBeInTheDocument();
    expect(within(a).getByText(/not an AI recommendation/)).toBeInTheDocument();
  });

  it('accepting the suggestion is "Chosen by you", reaches only "Ready to prepare", and sends nothing', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    await within(assistant()).findByText('Visible facts');
    const before = sideEffects();
    await act(async () => { fireEvent.click(within(assistant()).getByRole('button', { name: 'Choose Make Notes' })); });
    const a = assistant();
    expect(within(a).getByText('Chosen by you')).toBeInTheDocument();
    expect(within(a).getByText('(you accepted the suggestion)')).toBeInTheDocument();
    expect(within(a).queryByText('Suggested · rule-based')).not.toBeInTheDocument();
    // Batch 4A: Make Notes can now be prepared, but only by an explicit click.
    expect(await within(a).findByText('Ready to prepare.')).toBeInTheDocument();
    expect(within(a).getByRole('button', { name: 'Prepare draft' })).toBeEnabled();
    expect(within(a).getByText(/Nothing is approved, exported or sent to another app/)).toBeInTheDocument();
    expect(card('lecture.png')).toHaveTextContent('Chosen by you: Make Notes');
    expect(sideEffects()).toEqual(before);
    expect(ai.requestMakeNotesDraft).not.toHaveBeenCalled();
  });

  it.each(['Save as Memory', 'Add to Wishlist'])('%s still cannot be prepared, and says so', async (label) => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    await within(assistant()).findByText('Visible facts');
    fireEvent.click(within(assistant()).getByRole('button', { name: /Something else/ }));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: label })); });
    const a = assistant();
    expect(within(a).getByRole('button', { name: 'Prepare draft' })).toBeDisabled();
    expect(within(a).getByText(new RegExp(`Preparing a draft for ${label} is not available yet; only Make Notes and Add`))).toBeInTheDocument();
    expect(within(a).getByText(/Nothing has been created, saved or sent/)).toBeInTheDocument();
    expect(within(a).queryByRole('button', { name: 'Prepare event draft' })).not.toBeInTheDocument();
    expect(ai.requestMakeNotesDraft).not.toHaveBeenCalled();
    expect(ai.requestEventDraft).not.toHaveBeenCalled();
  });

  it('"Something else" overrides with the user\'s own choice, and Clear choice returns to the suggestion', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    await within(assistant()).findByText('Visible facts');
    const before = sideEffects();
    fireEvent.click(within(assistant()).getByRole('button', { name: /Something else/ }));
    const items = screen.getAllByRole('menuitem').map((m) => m.textContent);
    expect(items).toEqual(['Add to Calendar', 'Save as Memory', 'Add to Wishlist']);
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Add to Calendar' })); });
    const a = assistant();
    expect(within(a).getByText('Chosen by you')).toBeInTheDocument();
    expect(within(a).getByText('Add to Calendar')).toBeInTheDocument();
    expect(within(a).queryByText('(you accepted the suggestion)')).not.toBeInTheDocument();
    expect(card('lecture.png')).toHaveTextContent('Chosen by you: Add to Calendar');
    await act(async () => { fireEvent.click(within(a).getByRole('button', { name: 'Clear choice' })); });
    expect(within(assistant()).getByText('Suggested · rule-based')).toBeInTheDocument();
    expect(card('lecture.png')).toHaveTextContent('Suggested (rule): Make Notes');
    expect(sideEffects()).toEqual(before);
  });

  it('provenance follows each saved field origin', async () => {
    fullFor[4] = { ...full(4, 'Memory/Entertainment', 'Trip photos', { origin: 'manual_edit' }) };
    fullFor[5] = full(5, 'Study/Knowledge', 'Notes');
    fullFor[5].classification.origin = 'manual_edit';
    client.listScreenshots.mockResolvedValue({
      ok: true,
      screenshots: [
        base(4, 'edited.png', summary('Memory/Entertainment', 'Trip photos', { epitaphOrigin: 'manual_edit' })),
        base(5, 'partly.png', summary('Study/Knowledge', 'Notes')),
      ],
    });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'edited.png' });
    await select('edited.png');
    expect(await within(assistant()).findByText('Category edited by you; Epitaph edited by you.')).toBeInTheDocument();
    expect(within(assistant()).queryByText(/simulated/)).not.toBeInTheDocument();
    await select('edited.png');
    await select('partly.png');
    expect(await within(assistant()).findByText(/Category edited by you; Epitaph generated by the demo AI/)).toBeInTheDocument();
    delete fullFor[4];
    delete fullFor[5];
  });

  it('with no supported suggestion it says so and still lets the user choose', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'doc.png' });
    await select('doc.png');
    const a = assistant();
    await within(a).findByText('Visible facts');
    expect(within(a).getByText(/No suggestion\. Reference\/Document does not point to one next step/)).toBeInTheDocument();
    expect(within(a).queryByRole('button', { name: /^Choose (Make Notes|Save as Memory|Add to Wishlist|Add to Calendar)$/ })).not.toBeInTheDocument();
    fireEvent.click(within(a).getByRole('button', { name: /Choose a next step/ }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Make Notes' })); });
    expect(within(assistant()).getByText('Chosen by you')).toBeInTheDocument();
  });

  it('404 read: says so and uses the list summary for display only', async () => {
    ai.getAnalysis.mockResolvedValue(fail(404, 'not_found'));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    const a = assistant();
    expect(await within(a).findByText(/did not return a saved analysis/)).toBeInTheDocument();
    expect(within(a).getByText('Saved to study later (synthetic).')).toBeInTheDocument();
    expect(within(a).queryByText('Visible facts')).not.toBeInTheDocument();
    expect(within(a).queryByText('Suggested · rule-based')).not.toBeInTheDocument();
    expect(card('lecture.png')).not.toHaveTextContent('Suggested (rule):');
  });

  it('failed read: shows the summary with Retry, and Retry is a GET only', async () => {
    ai.getAnalysis.mockResolvedValueOnce(fail(503, 'service_unavailable'));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    const a = assistant();
    await within(a).findByText(/full analysis could not be loaded/);
    const before = sideEffects();
    await act(async () => { fireEvent.click(within(a).getByRole('button', { name: 'Retry' })); });
    await within(assistant()).findByText('Visible facts');
    expect(sideEffects()).toEqual({ ...before, analysis: before.analysis + 1 });
  });

  it('a ghost has no suggestion; "Open screenshot" opens the drawer without classifying', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'ghost.png' });
    await select('ghost.png');
    const a = assistant();
    expect(within(a).getByText(/has not been analyzed yet\. Nothing is analyzed until you open it/)).toBeInTheDocument();
    expect(within(a).queryByRole('button', { name: /Something else|Choose a next step/ })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(within(a).getByRole('button', { name: 'Open screenshot' })); });
    expect(screen.getByRole('dialog', { name: 'ghost.png' })).toBeInTheDocument();
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
    expect(ai.getAnalysis).toHaveBeenCalledTimes(1); // the drawer's own read only
  });

  it('several selected: constrained to one, nothing read, Clear selection works', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    await select('doc.png');
    const a = assistant();
    expect(within(a).getByText(/2 screenshots selected\. For now, choosing a next step works on one screenshot at a time/)).toBeInTheDocument();
    expect(within(a).queryByText('Study/Knowledge')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(within(a).getByRole('button', { name: 'Clear selection' })); });
    expect(screen.getByRole('checkbox', { name: 'Select lecture.png' })).not.toBeChecked();
    expect(within(assistant()).getByText(/Tick a screenshot.s box/)).toBeInTheDocument();
  });

  it('switching screenshots shows each one\'s own data and keeps each choice separately', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    await within(assistant()).findByText('Visible facts');
    await act(async () => { fireEvent.click(within(assistant()).getByRole('button', { name: 'Choose Make Notes' })); });
    await select('lecture.png'); // deselect
    await select('doc.png');
    await within(assistant()).findByText('Reference/Document');
    expect(within(assistant()).queryByText('Chosen by you')).not.toBeInTheDocument();
    await select('doc.png');
    await select('lecture.png');
    expect(await within(assistant()).findByText('Chosen by you')).toBeInTheDocument();
    expect(card('lecture.png')).toHaveTextContent('Chosen by you: Make Notes');
    expect(card('doc.png')).not.toHaveTextContent('Chosen by you');
  });

  it('a slow read for an earlier selection never overwrites the current one', async () => {
    const slow = deferred<ApiResult<Analysis>>();
    ai.getAnalysis.mockImplementation((id) => (id === 1 ? slow.promise : Promise.resolve({ ok: true as const, data: fullFor[2] })));
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    await select('lecture.png');
    await select('doc.png');
    await within(assistant()).findByText('Visible facts');
    await act(async () => { slow.resolve({ ok: true, data: fullFor[1] }); });
    expect(within(assistant()).getByText('Reference/Document')).toBeInTheDocument();
    expect(within(assistant()).queryByText('Maybe for an exam (a guess, not a fact)')).not.toBeInTheDocument();
  });

  it('aborts its read when the assistant unmounts', async () => {
    const signals: AbortSignal[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((_u: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_r, reject) => {
      if (init?.signal) { signals.push(init.signal); init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); }
    })) as unknown as typeof fetch;
    ai.getAnalysis.mockImplementation((_id, f) => (f ?? fetch)('/api/screenshots/1/analysis').then(() => fail(500, 'x'), () => fail(0, 'network')));
    try {
      const view = render(<LiveWorkspace />);
      await screen.findByRole('article', { name: 'lecture.png' });
      await select('lecture.png');
      expect(signals).toHaveLength(1);
      view.unmount();
      expect(signals[0].aborted).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('Safe Burial of the selected screenshot clears the selection', async () => {
    client.archiveScreenshot.mockResolvedValue({ ok: true, screenshotId: 1, status: 'successful', state: 'archived' });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    await select('lecture.png');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open details for lecture.png' })); });
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [{ ...study, state: 'archived' }, doc, ghost] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Safe Burial' })); });
    await screen.findByText(/Moved to The Crypt/);
    expect(within(assistant()).getByText(/Tick a screenshot.s box/)).toBeInTheDocument();
  });

  it('Revive in the drawer → close: the assistant and card show the new saved analysis, one classify POST', async () => {
    ai.getConsent.mockResolvedValue({ ok: true, data: true });
    ai.classifyScreenshot.mockResolvedValue({ ok: true, data: { operationId: 7, kind: 'classify', status: 'pending', errorDetail: null, artifactId: null, warning: null } });
    ai.getOperation.mockResolvedValue({ ok: true, data: { operationId: 7, kind: 'classify', status: 'successful', errorDetail: null, artifactId: null } });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'ghost.png' });
    await select('ghost.png');
    await act(async () => { fireEvent.click(within(assistant()).getByRole('button', { name: 'Open screenshot' })); });
    const revived = base(3, 'ghost.png', summary('Memory/Entertainment', 'A synthetic memory.'));
    fullFor[3] = full(3, 'Memory/Entertainment', 'A synthetic memory.');
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [study, doc, revived] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Revive with Fake AI' })); });
    await screen.findByLabelText('Classification result');
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    await waitFor(() => expect(card('ghost.png')).toHaveTextContent('Suggested (rule): Save as Memory'));
    expect(await within(assistant()).findByText('Memory/Entertainment')).toBeInTheDocument();
    expect(ai.classifyScreenshot).toHaveBeenCalledTimes(1);
    delete fullFor[3];
  });

  it('a Revive left pending when the drawer closes is shown as not confirmed, not as analyzed or failed', async () => {
    ai.getConsent.mockResolvedValue({ ok: true, data: true });
    ai.classifyScreenshot.mockResolvedValue({ ok: true, data: { operationId: 7, kind: 'classify', status: 'pending', errorDetail: null, artifactId: null, warning: null } });
    ai.getOperation.mockResolvedValue({ ok: true, data: { operationId: 7, kind: 'classify', status: 'pending', errorDetail: null, artifactId: null } });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'ghost.png' });
    await select('ghost.png');
    await act(async () => { fireEvent.click(within(assistant()).getByRole('button', { name: 'Open screenshot' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Revive with Fake AI' })); });
    await screen.findByText('Revive is running on the server…');
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(await within(assistant()).findByText(/An earlier Revive for ghost\.png is not confirmed as finished yet/)).toBeInTheDocument();
    expect(card('ghost.png')).toHaveTextContent('Ghost');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('collapses and expands', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'lecture.png' });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse assistant' }));
    const expand = screen.getByRole('button', { name: /Quiet Assistant/ });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expand);
    expect(screen.getByTestId('live-assistant')).toBeInTheDocument();
  });
});
