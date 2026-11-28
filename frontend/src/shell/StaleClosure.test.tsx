import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analysis, ApiResult, ProviderMode } from '../api/ai';
import type { ListResult, Screenshot, ScreenshotAnalysis } from '../api/client';

// Batch 3B P1: a Choose handler captured by an earlier render must be judged
// against the CURRENT committed gallery/selection, not the gallery snapshot in
// its own closure. API modules are mocked; nothing touches the network.
const client = vi.hoisted(() => ({
  getWorkspace: vi.fn(), listScreenshots: vi.fn<() => Promise<ListResult>>(), uploadScreenshots: vi.fn(),
  archiveScreenshot: vi.fn(), restoreScreenshot: vi.fn(),
}));
vi.mock('../api/client', () => ({ ...client, imageUrl: (id: number) => `/api/screenshots/${id}/image` }));
const ai = vi.hoisted(() => ({
  getProviderMode: vi.fn<() => Promise<ApiResult<ProviderMode>>>(),
  getConsent: vi.fn(), setConsent: vi.fn(), classifyScreenshot: vi.fn(), getOperation: vi.fn(),
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

const summary = (category: string, epitaph: string): ScreenshotAnalysis => ({ category, uncertain: false, epitaph, epitaphOrigin: 'ai_generate' });
const item = (id: number, name: string, a: ScreenshotAnalysis, state: 'active' | 'archived' = 'active'): Screenshot => ({
  screenshotId: id, state, mimeType: 'image/png', originalFilename: name,
  isDuplicate: false, duplicateOf: null, byteSize: 9, uploadedAt: '2026-11-19T20:00:00Z', analysis: a,
});
const analysis = (id: number, category: string, epitaph: string): Analysis => ({
  screenshotId: id,
  classification: { category: category as Analysis['classification']['category'], confidence: 0.75, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
  epitaph: { text: epitaph, visibleFacts: 'Synthetic adapter does not interpret image content.', inferredIntent: null, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
});
const A_STUDY = item(1, 'a.png', summary('Study/Knowledge', 'Notes'));
const A_SENSITIVE_LIST = item(1, 'a.png', summary('Potentially Sensitive', 'Notes'));
const B_SHOP = item(2, 'b.png', summary('Shopping/Inspiration', 'Shoes'));
let server: Record<number, Analysis>;

beforeEach(() => {
  vi.clearAllMocks();
  server = { 1: analysis(1, 'Study/Knowledge', 'Notes'), 2: analysis(2, 'Shopping/Inspiration', 'Shoes') };
  client.getWorkspace.mockResolvedValue({ ok: true, active: true });
  client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [A_STUDY, B_SHOP] });
  ai.getProviderMode.mockResolvedValue({ ok: true, data: 'fake' });
  ai.getConsent.mockResolvedValue({ ok: true, data: true });
  ai.getAnalysis.mockImplementation((id) => Promise.resolve({ ok: true as const, data: server[id] }));
});

const A = () => screen.getByTestId('live-assistant');
const card = (n: string) => screen.getByRole('article', { name: n });
const toggle = async (n: string) => { await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: `Select ${n}` })); }); };
const mutations = () => [ai.classifyScreenshot, ai.setConsent, ai.getOperation, client.uploadScreenshots]
  .reduce((n, f) => n + f.mock.calls.length, 0);
/** The React onClick closure of a rendered element, kept after the element re-renders away. */
function capturedOnClick(el: HTMLElement): () => void {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
  const props = key ? (el as unknown as Record<string, { onClick?: () => void }>)[key] : undefined;
  if (!props?.onClick) throw new Error('no React onClick on element');
  return props.onClick;
}
async function captureMakeNotes() {
  await toggle('a.png');
  await within(A()).findByText('Suggested · rule-based');
  return capturedOnClick(within(A()).getByRole('button', { name: 'Choose Make Notes' }));
}
const acceptedAnything = () => screen.queryAllByText(/Chosen by you/).length > 0;

describe('P1: a captured Choose handler is judged against the current committed gallery', () => {
  it('gallery refreshed to Potentially Sensitive while the latest detail says Study/Knowledge: the original handler is rejected', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    const original = await captureMakeNotes();
    // 3. The drawer reads Potentially Sensitive.
    server[1] = analysis(1, 'Potentially Sensitive', 'Notes');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open details for a.png' })); });
    await within(screen.getByRole('dialog')).findByText('Potentially Sensitive');
    // 4. Close, then refresh the gallery (assistant "Refresh analysis": list + analysis re-read).
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close details' })); });
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [A_SENSITIVE_LIST, B_SHOP] }); // 5. gallery: Sensitive
    server[1] = analysis(1, 'Study/Knowledge', 'Notes'); // 6. latest detail: Study/Knowledge
    await act(async () => { fireEvent.click(within(A()).getByRole('button', { name: 'Refresh analysis' })); });
    // 5. The gallery really was refreshed to Potentially Sensitive ...
    await waitFor(() => expect(client.listScreenshots).toHaveBeenCalledTimes(2));
    // 6. ... while the latest detail read says Study/Knowledge, so the two disagree.
    await waitFor(() => expect(within(A()).getByText(/differs from the gallery summary/)).toBeInTheDocument());
    expect(within(A()).getByText('Study/Knowledge')).toBeInTheDocument();
    // 7. The rendered UI suppresses the suggestion.
    expect(card('a.png')).not.toHaveTextContent('Suggested');
    expect(within(A()).queryByText('Suggested · rule-based')).not.toBeInTheDocument();
    expect(within(A()).queryByRole('button', { name: 'Choose Make Notes' })).not.toBeInTheDocument();
    // 8-9. The ORIGINAL handler must not accept Make Notes.
    await act(async () => { original(); });
    expect(card('a.png')).not.toHaveTextContent('Chosen by you: Make Notes');
    expect(acceptedAnything()).toBe(false);
    expect(mutations()).toBe(0);
  });

  it.each([
    ['archived', () => [{ ...A_STUDY, state: 'archived' as const }, B_SHOP]],
    ['removed', () => [B_SHOP]],
  ])('the screenshot was %s after the handler was captured: rejected', async (_name, nextList) => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    const original = await captureMakeNotes();
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: nextList() });
    // Any gallery refresh path; an upload is the simplest that changes nothing else.
    client.uploadScreenshots.mockResolvedValue({ ok: true, accepted: 1, rejected: 0, results: [] });
    await act(async () => { fireEvent.change(screen.getByLabelText('Choose screenshot files'), { target: { files: [new File(['x'], 'x.png')] } }); });
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Select a.png' })).not.toBeInTheDocument());
    await act(async () => { original(); });
    expect(acceptedAnything()).toBe(false);
  });

  it('selection changed from A to B: A\'s original handler is rejected, B\'s current suggestion still works', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    const original = await captureMakeNotes();
    await toggle('a.png');
    await toggle('b.png');
    await within(A()).findByRole('button', { name: 'Choose Add to Wishlist' });
    await act(async () => { original(); });
    expect(acceptedAnything()).toBe(false);
    expect(card('a.png')).not.toHaveTextContent('Chosen by you');
    expect(within(A()).getByText('Suggested · rule-based')).toBeInTheDocument();
    // A new, valid, current suggestion remains actionable.
    await act(async () => { fireEvent.click(within(A()).getByRole('button', { name: 'Choose Add to Wishlist' })); });
    expect(within(A()).getByText('Chosen by you')).toBeInTheDocument();
    expect(card('b.png')).toHaveTextContent('Chosen by you: Add to Wishlist');
    expect(mutations()).toBe(0);
  });

  it('after gallery and detail agree again, the freshly rendered suggestion is actionable and explicit choices are unaffected', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    await captureMakeNotes();
    client.uploadScreenshots.mockResolvedValue({ ok: true, accepted: 1, rejected: 0, results: [] });
    await act(async () => { fireEvent.change(screen.getByLabelText('Choose screenshot files'), { target: { files: [new File(['x'], 'x.png')] } }); });
    await within(A()).findByText('Suggested · rule-based');
    await act(async () => { fireEvent.click(within(A()).getByRole('button', { name: 'Choose Make Notes' })); });
    expect(within(A()).getByText('(you accepted the suggestion)')).toBeInTheDocument();
    fireEvent.click(within(A()).getByRole('button', { name: /Something else/ }));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Add to Calendar' })); });
    expect(within(A()).getByText('Chosen by you')).toBeInTheDocument();
    expect(within(A()).queryByText('(you accepted the suggestion)')).not.toBeInTheDocument();
    expect(mutations()).toBe(1); // the upload used to trigger the refresh, and nothing else
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
  });
});
