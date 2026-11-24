import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analysis, ApiResult, ProviderMode } from '../api/ai';
import type { ListResult, Screenshot, ScreenshotAnalysis } from '../api/client';

// Batch 3B P1: the LATEST started analysis read decides suggestion eligibility.
// While it is pending, or after it fails / returns another screenshot's id, no
// earlier successful payload may authorize a suggestion. API modules mocked.
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
  getStudyNote: vi.fn(),
}));
vi.mock('../api/ai', () => ai);
import LiveWorkspace from './LiveWorkspace';

const listItem = (id: number, name: string, a: ScreenshotAnalysis): Screenshot => ({
  screenshotId: id, state: 'active', mimeType: 'image/png', originalFilename: name,
  isDuplicate: false, duplicateOf: null, byteSize: 9, uploadedAt: '2026-11-19T20:00:00Z', analysis: a,
});
const analysis = (id: number, category: string, epitaph: string): Analysis => ({
  screenshotId: id,
  classification: { category: category as Analysis['classification']['category'], confidence: 0.75, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
  epitaph: { text: epitaph, visibleFacts: 'Synthetic adapter does not interpret image content.', inferredIntent: null, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
});
const fail = (status: number, code = 'x'): ApiResult<never> => ({ ok: false, status, code, message: code });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

const A_STUDY = analysis(1, 'Study/Knowledge', 'Lecture notes');
const B_SHOP = analysis(2, 'Shopping/Inspiration', 'Shoes');
const LIST = [
  listItem(1, 'a.png', { category: 'Study/Knowledge', uncertain: false, epitaph: 'Lecture notes', epitaphOrigin: 'ai_generate' }),
  listItem(2, 'b.png', { category: 'Shopping/Inspiration', uncertain: false, epitaph: 'Shoes', epitaphOrigin: 'ai_generate' }),
];
let server: Record<number, Analysis>;
let queued: Array<{ id: number; promise: Promise<ApiResult<Analysis>> }>;

beforeEach(() => {
  vi.clearAllMocks();
  server = { 1: A_STUDY, 2: B_SHOP };
  queued = [];
  client.getWorkspace.mockResolvedValue({ ok: true, active: true });
  client.listScreenshots.mockResolvedValue({ ok: true, screenshots: LIST });
  ai.getProviderMode.mockResolvedValue({ ok: true, data: 'fake' });
  ai.getConsent.mockResolvedValue({ ok: true, data: true });
  ai.getAnalysis.mockImplementation((id) => {
    const i = queued.findIndex((q) => q.id === id);
    if (i >= 0) return queued.splice(i, 1)[0].promise;
    return Promise.resolve({ ok: true as const, data: server[id] });
  });
});

const A = () => screen.getByTestId('live-assistant');
const card = (n: string) => screen.getByRole('article', { name: n });
const select = async (n: string) => { await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: `Select ${n}` })); }); };
const mutations = () => [ai.classifyScreenshot, ai.setConsent, ai.getOperation, client.archiveScreenshot, client.restoreScreenshot, client.uploadScreenshots]
  .reduce((n, f) => n + f.mock.calls.length, 0);
const noSuggestion = () => {
  expect(card('a.png')).not.toHaveTextContent('Suggested');
  expect(within(A()).queryByText('Suggested · rule-based')).not.toBeInTheDocument();
  expect(within(A()).queryByRole('button', { name: 'Choose Make Notes' })).not.toBeInTheDocument();
};
/** The React onClick closure of a rendered element: survives the element being re-rendered away. */
function capturedOnClick(el: HTMLElement): () => void {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
  const props = key ? (el as unknown as Record<string, { onClick?: () => void }>)[key] : undefined;
  if (!props?.onClick) throw new Error('no React onClick on element');
  return props.onClick;
}
async function makeNotesSuggested() {
  await select('a.png');
  await within(A()).findByText('Suggested · rule-based');
  expect(card('a.png')).toHaveTextContent('Suggested (rule): Make Notes');
  return within(A()).getByRole('button', { name: 'Choose Make Notes' });
}
async function openDrawer(drawerRead?: Promise<ApiResult<Analysis>>) {
  if (drawerRead) queued.push({ id: 1, promise: drawerRead });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open details for a.png' })); });
}
const closeDrawer = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close details' })); }); };

describe('P1: suggestions follow the latest started analysis read', () => {
  it('1. a newer drawer GET pending → no card or assistant suggestion', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    await makeNotesSuggested();
    const held = deferred<ApiResult<Analysis>>();
    await openDrawer(held.promise);
    noSuggestion(); // pending: the earlier success no longer authorizes anything
    await closeDrawer(); // closing cancels the read; it must not bring the old state back
    noSuggestion();
    expect(mutations()).toBe(0);
  });

  it('2. a captured Choose handler invoked while the drawer GET is pending is rejected', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    const staleClick = capturedOnClick(await makeNotesSuggested());
    await openDrawer(deferred<ApiResult<Analysis>>().promise);
    await act(async () => { staleClick(); });
    await closeDrawer();
    expect(screen.queryByText('Chosen by you')).not.toBeInTheDocument();
    expect(card('a.png')).not.toHaveTextContent('Chosen by you');
    expect(mutations()).toBe(0);
  });

  it.each([
    ['3. 404', fail(404, 'not_found')],
    ['4. 503', fail(503, 'service_unavailable')],
  ])('%s from the newer drawer GET → the old suggestion cannot return', async (_n, result) => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    const staleClick = capturedOnClick(await makeNotesSuggested());
    await openDrawer(Promise.resolve(result));
    await closeDrawer();
    noSuggestion();
    await act(async () => { staleClick(); });
    expect(screen.queryByText('Chosen by you')).not.toBeInTheDocument();
    expect(mutations()).toBe(0);
  });

  it('5. a newer drawer GET answering with another screenshot\'s id is rejected as invalid', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    const staleClick = capturedOnClick(await makeNotesSuggested());
    await openDrawer(Promise.resolve({ ok: true as const, data: analysis(2, 'Memory/Entertainment', 'Not A') }));
    await closeDrawer();
    noSuggestion();
    expect(card('a.png')).not.toHaveTextContent('Memory/Entertainment');
    expect(within(A()).queryByText('Memory/Entertainment')).not.toBeInTheDocument();
    expect(within(A()).queryByText('Save as Memory')).not.toBeInTheDocument();
    await act(async () => { staleClick(); });
    expect(screen.queryByText('Chosen by you')).not.toBeInTheDocument();
  });

  it('6. an older assistant GET resolving after the newer drawer request failed cannot restore Make Notes', async () => {
    const olderAssistantRead = deferred<ApiResult<Analysis>>();
    queued.push({ id: 1, promise: olderAssistantRead.promise });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    await select('a.png'); // assistant read started first, held
    await openDrawer(Promise.resolve(fail(503, 'service_unavailable'))); // newer read, fails
    await closeDrawer();
    await act(async () => { olderAssistantRead.resolve({ ok: true, data: A_STUDY }); });
    noSuggestion();
    expect(mutations()).toBe(0);
  });

  it('extra: a newer successful read with the SAME category but marked uncertain is not eligible, at render or click time', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    const staleClick = capturedOnClick(await makeNotesSuggested());
    const uncertainStudy: Analysis = { ...A_STUDY, classification: { ...A_STUDY.classification, uncertain: true } };
    await openDrawer(Promise.resolve({ ok: true as const, data: uncertainStudy }));
    await closeDrawer();
    noSuggestion();
    await act(async () => { staleClick(); });
    expect(screen.queryByText('Chosen by you')).not.toBeInTheDocument();
    expect(mutations()).toBe(0);
  });

  it('7. an explicit, successful retry restores an eligible suggestion; reads only', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    await makeNotesSuggested();
    await openDrawer(Promise.resolve(fail(503, 'service_unavailable')));
    await closeDrawer();
    noSuggestion();
    const reads = ai.getAnalysis.mock.calls.length;
    await act(async () => { fireEvent.click(within(A()).getByRole('button', { name: /^Retry$|Refresh analysis/ })); });
    await within(A()).findByText('Suggested · rule-based');
    expect(within(A()).getByRole('button', { name: 'Choose Make Notes' })).toBeInTheDocument();
    expect(card('a.png')).toHaveTextContent('Suggested (rule): Make Notes');
    expect(ai.getAnalysis.mock.calls.length).toBe(reads + 1);
    await act(async () => { fireEvent.click(within(A()).getByRole('button', { name: 'Choose Make Notes' })); });
    expect(within(A()).getByText('Chosen by you')).toBeInTheDocument();
    expect(mutations()).toBe(0);
  });
});
