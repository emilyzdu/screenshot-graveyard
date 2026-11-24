import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analysis, ApiResult, ProviderMode } from '../api/ai';
import type { ListResult, Screenshot, ScreenshotAnalysis } from '../api/client';

// Batch 3B P1: a newer analysis read by the Revive drawer must invalidate the
// card / assistant suggestion that came from an older read. API modules are
// mocked; nothing touches the network or an AI provider.
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
  getEventDraft: vi.fn(),
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
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

const A_STUDY = analysis(1, 'Study/Knowledge', 'Lecture notes');
const A_SENSITIVE = analysis(1, 'Potentially Sensitive', 'Account details');
const B_SHOP = analysis(2, 'Shopping/Inspiration', 'Shoes');
const LIST = [
  listItem(1, 'a.png', { category: 'Study/Knowledge', uncertain: false, epitaph: 'Lecture notes', epitaphOrigin: 'ai_generate' }),
  listItem(2, 'b.png', { category: 'Shopping/Inspiration', uncertain: false, epitaph: 'Shoes', epitaphOrigin: 'ai_generate' }),
];
/** What the server currently has; tests change it to simulate an edit made elsewhere. */
let server: Record<number, Analysis>;
/** Optional per-call overrides, consumed in order, for holding specific reads. */
let queued: Array<{ id: number; promise: Promise<ApiResult<Analysis>> }>;

beforeEach(() => {
  vi.clearAllMocks();
  server = { 1: A_STUDY, 2: B_SHOP };
  queued = [];
  client.getWorkspace.mockResolvedValue({ ok: true, active: true });
  client.listScreenshots.mockResolvedValue({ ok: true, screenshots: LIST }); // the list never sees the change
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
  .map((f) => f.mock.calls.length);
async function openDrawerAndClose(name: string, drawerRead?: Promise<ApiResult<Analysis>>) {
  if (drawerRead) queued.push({ id: 1, promise: drawerRead });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Open details for ${name}` })); });
  return {
    dialog: () => screen.getByRole('dialog', { name }),
    close: async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close details' })); }); },
  };
}
async function suggestedMakeNotes() {
  await select('a.png');
  await within(A()).findByText('Suggested · rule-based');
  expect(within(A()).getByRole('button', { name: 'Choose Make Notes' })).toBeInTheDocument();
  expect(card('a.png')).toHaveTextContent('Suggested (rule): Make Notes');
}

describe('P1: a newer drawer analysis is the authority for suggestions', () => {
  it('Study/Knowledge → backend becomes Potentially Sensitive → drawer reads it → close: Make Notes is no longer suggested', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    await suggestedMakeNotes();
    server[1] = A_SENSITIVE; // edited elsewhere; the list snapshot still says Study/Knowledge
    const drawer = await openDrawerAndClose('a.png');
    expect(await within(drawer.dialog()).findByText('Potentially Sensitive')).toBeInTheDocument();
    await drawer.close();
    expect(card('a.png')).not.toHaveTextContent('Suggested');
    // The card shows the newer validated category, not the stale list snapshot.
    expect(card('a.png')).toHaveTextContent('Potentially Sensitive');
    expect(card('a.png')).not.toHaveTextContent('Study/Knowledge');
    expect(within(A()).queryByText('Suggested · rule-based')).not.toBeInTheDocument();
    expect(within(A()).queryByRole('button', { name: 'Choose Make Notes' })).not.toBeInTheDocument();
    expect(within(A()).queryByText('Study/Knowledge')).not.toBeInTheDocument();
    expect(mutations()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('a handler from the displayed suggestion cannot accept it after the drawer invalidates it', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    await suggestedMakeNotes();
    const stale = within(A()).getByRole('button', { name: 'Choose Make Notes' });
    server[1] = A_SENSITIVE;
    const held = deferred<ApiResult<Analysis>>();
    const drawer = await openDrawerAndClose('a.png', held.promise);
    // The newer read lands and the old button is clicked in the same turn,
    // before React can re-render the assistant without it.
    await act(async () => {
      held.resolve({ ok: true, data: A_SENSITIVE });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
      fireEvent.click(stale);
    });
    await drawer.close();
    expect(screen.queryByText('Chosen by you')).not.toBeInTheDocument();
    expect(card('a.png')).not.toHaveTextContent('Chosen by you');
    expect(mutations()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('an older in-flight assistant read cannot restore the stale suggestion after the drawer\'s newer read', async () => {
    const olderAssistantRead = deferred<ApiResult<Analysis>>();
    queued.push({ id: 1, promise: olderAssistantRead.promise });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    await select('a.png'); // assistant read issued first, and held
    server[1] = A_SENSITIVE;
    const drawer = await openDrawerAndClose('a.png'); // newer read, answers at once
    expect(await within(drawer.dialog()).findByText('Potentially Sensitive')).toBeInTheDocument();
    await drawer.close();
    await act(async () => { olderAssistantRead.resolve({ ok: true, data: A_STUDY }); }); // stale answer arrives last
    await waitFor(() => expect(within(A()).queryByText(/Loading the saved analysis/)).not.toBeInTheDocument());
    expect(within(A()).queryByText('Suggested · rule-based')).not.toBeInTheDocument();
    expect(within(A()).queryByRole('button', { name: 'Choose Make Notes' })).not.toBeInTheDocument();
    expect(card('a.png')).not.toHaveTextContent('Suggested');
    expect(within(A()).queryByText('Study/Knowledge')).not.toBeInTheDocument();
  });

  it('while the assistant\'s own read is still pending, it shows the drawer\'s newer analysis instead of waiting', async () => {
    const heldAssistantRead = deferred<ApiResult<Analysis>>();
    queued.push({ id: 1, promise: heldAssistantRead.promise });
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    await select('a.png');
    expect(within(A()).getByText(/Loading the saved analysis/)).toBeInTheDocument();
    server[1] = A_SENSITIVE;
    const drawer = await openDrawerAndClose('a.png');
    await within(drawer.dialog()).findByText('Potentially Sensitive');
    await drawer.close();
    // The assistant's request is still in flight, yet it already reflects the newer validated read.
    expect(within(A()).queryByText(/Loading the saved analysis/)).not.toBeInTheDocument();
    expect(within(A()).getByText('Potentially Sensitive')).toBeInTheDocument();
    expect(within(A()).queryByText('Suggested · rule-based')).not.toBeInTheDocument();
    await act(async () => { heldAssistantRead.resolve({ ok: true, data: A_STUDY }); });
    expect(within(A()).getByText('Potentially Sensitive')).toBeInTheDocument();
  });

  it('a second screenshot stays independent, and explicit choices stay distinct from suggestions', async () => {
    render(<LiveWorkspace />);
    await screen.findByRole('article', { name: 'a.png' });
    await suggestedMakeNotes();
    server[1] = A_SENSITIVE;
    const drawer = await openDrawerAndClose('a.png');
    await within(drawer.dialog()).findByText('Potentially Sensitive');
    await drawer.close();
    await select('a.png');
    await select('b.png');
    expect(await within(A()).findByText('Suggested · rule-based')).toBeInTheDocument();
    expect(within(A()).getByRole('button', { name: 'Choose Add to Wishlist' })).toBeInTheDocument();
    expect(card('b.png')).toHaveTextContent('Suggested (rule): Add to Wishlist');
    await select('b.png');
    await select('a.png');
    // A: no suggestion, but the user may still choose explicitly; that is "Chosen by you", not a suggestion.
    await waitFor(() => expect(within(A()).queryByText(/Loading the saved analysis/)).not.toBeInTheDocument());
    expect(within(A()).queryByText('Suggested · rule-based')).not.toBeInTheDocument();
    const before = mutations();
    const menu = within(A()).queryByRole('button', { name: /Choose a next step|Something else/ });
    if (menu) {
      fireEvent.click(menu);
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Make Notes' })); });
      expect(within(A()).getByText('Chosen by you')).toBeInTheDocument();
      expect(within(A()).queryByText('(you accepted the suggestion)')).not.toBeInTheDocument();
    }
    expect(mutations()).toEqual(before);
    expect(mutations()).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
