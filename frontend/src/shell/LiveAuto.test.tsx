import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analysis, ApiResult, AutoProcessState, Disclosure, ProviderMode } from '../api/ai';
import type { ListResult, Screenshot } from '../api/client';

// Batch 6B in the Gothic Live Workspace. Both API modules are mocked; nothing
// here touches the network or an AI provider.
const client = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  listScreenshots: vi.fn<() => Promise<ListResult>>(),
  uploadScreenshots: vi.fn(),
  archiveScreenshot: vi.fn(),
  restoreScreenshot: vi.fn(),
}));
vi.mock('../api/client', () => ({ ...client, imageUrl: (id: number) => `/api/screenshots/${id}/image` }));
const notFound = () => Promise.resolve({ ok: false as const, status: 404, code: 'no_preparation', message: 'No preparation yet' });
const ai = vi.hoisted(() => ({
  getProviderMode: vi.fn<() => Promise<ApiResult<ProviderMode>>>(),
  getConsent: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<boolean>>>(),
  setConsent: vi.fn<(id: number, granted: boolean, f?: typeof fetch) => Promise<ApiResult<boolean>>>(),
  getDisclosure: vi.fn<(f?: typeof fetch) => Promise<ApiResult<Disclosure>>>(),
  classifyScreenshot: vi.fn(),
  getOperation: vi.fn(),
  getAnalysis: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Analysis>>>(),
  getMakeNotesPreparation: vi.fn(),
  requestMakeNotesDraft: vi.fn(),
  getEventDraftPreparation: vi.fn(),
  requestEventDraft: vi.fn(),
  listStudyNoteVersions: vi.fn(),
  listEventDraftVersions: vi.fn(),
  saveEventDraftEdit: vi.fn(),
  getApprovalStatus: vi.fn(),
  approveVersion: vi.fn(),
  saveStudyNoteEdit: vi.fn(),
  getEventDraft: vi.fn(),
  getStudyNote: vi.fn(),
  // Batch 6B
  getAutomation: vi.fn<(f?: typeof fetch) => Promise<ApiResult<boolean>>>(),
  setAutomation: vi.fn<(enabled: boolean, f?: typeof fetch) => Promise<ApiResult<boolean>>>(),
  getAutoProcess: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<AutoProcessState>>>(),
  startAutoProcess: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<AutoProcessState>>>(),
}));
vi.mock('../api/ai', async (orig) => ({ ...(await orig<typeof import('../api/ai')>()), ...ai }));
import LiveWorkspace from './LiveWorkspace';

const shot: Screenshot = {
  screenshotId: 42, state: 'active', mimeType: 'image/png', originalFilename: 'event.png',
  isDuplicate: false, duplicateOf: null, byteSize: 512, uploadedAt: '2026-11-19T20:00:00Z', analysis: null,
};
const OPENAI: ApiResult<Disclosure> = { ok: true, data: { provider: 'openai', revision: 'openai-test-rev', text: 'Revive sends the original image of this screenshot to OpenAI to analyze it.' } };
const ROUTE = { decision: 'auto' as const, action: 'add_calendar' as const, reasonCode: 'calendar_evidence',
  reason: 'The AI suggested Add to Calendar, and a date is visible in the screenshot.' };
const st = (stage: AutoProcessState['stage'], over: Partial<AutoProcessState> = {}): ApiResult<AutoProcessState> => ({
  ok: true,
  data: { screenshotId: 42, autoPrepare: true, consent: false, stage, route: null, analysis: null, preparation: null, running: false, ...over },
});
const READY = st('ready_for_review', {
  consent: true, route: ROUTE,
  preparation: { operationId: 9, status: 'successful', artifactId: 3, errorDetail: null, provider: 'openai', action: 'add_calendar', trigger: 'auto' },
});
const READY_MANUAL = st('ready_for_review', {
  consent: true, route: ROUTE,
  preparation: { operationId: 9, status: 'successful', artifactId: 3, errorDetail: null, provider: 'openai', action: 'add_calendar', trigger: 'manual' },
});

beforeEach(() => {
  vi.clearAllMocks();
  client.getWorkspace.mockResolvedValue({ ok: true, active: true });
  client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [shot] });
  ai.getProviderMode.mockResolvedValue({ ok: true, data: 'openai' });
  ai.getDisclosure.mockResolvedValue(OPENAI);
  ai.getConsent.mockResolvedValue({ ok: true, data: false });
  ai.setConsent.mockImplementation(async (_id, granted) => ({ ok: true, data: granted }));
  ai.getAnalysis.mockResolvedValue({ ok: false, status: 404, code: 'not_found', message: 'not_found' });
  ai.getMakeNotesPreparation.mockImplementation(notFound);
  ai.getEventDraftPreparation.mockImplementation(notFound);
  ai.getAutomation.mockResolvedValue({ ok: true, data: true });
  ai.setAutomation.mockImplementation(async (enabled) => ({ ok: true, data: enabled }));
  ai.getAutoProcess.mockResolvedValue(st('awaiting_consent'));
});

async function openDrawer(name = 'event.png') {
  const opener = await screen.findByRole('button', { name: `Open details for ${name}` });
  await act(async () => { fireEvent.click(opener); });
  return screen.getByRole('dialog', { name });
}
const toggle = () => screen.getByRole('checkbox', { name: 'Prepare drafts automatically after I allow AI processing' });

describe('Batch 6B: automatic preparation in the Gothic workspace', () => {
  it('is off unless the server says it is on; then the manual Revive stays and nothing automatic runs', async () => {
    ai.getAutomation.mockResolvedValue({ ok: true, data: false });
    render(<LiveWorkspace />);
    await waitFor(() => expect(toggle()).not.toBeChecked());
    const d = await openDrawer();
    expect(within(d).getByRole('button', { name: 'Revive with AI' })).toBeInTheDocument();
    expect(within(d).queryByTestId('auto-pilot')).not.toBeInTheDocument();
    expect(ai.getAutoProcess).not.toHaveBeenCalled();
  });

  it('the setting is read only after the workspace (and its cookie) exists', async () => {
    let started!: () => void;
    client.getWorkspace.mockReturnValue(new Promise((r) => { started = () => r({ ok: true, active: true }); }));
    render(<LiveWorkspace />);
    await act(async () => { await Promise.resolve(); });
    expect(ai.getAutomation).not.toHaveBeenCalled();
    await act(async () => { started(); });
    await waitFor(() => expect(toggle()).toBeChecked());
    expect(ai.getAutomation).toHaveBeenCalledTimes(1);
  });

  it('an unreadable setting counts as off', async () => {
    ai.getAutomation.mockResolvedValue({ ok: false, status: 503, code: 'service_unavailable', message: 'x' });
    render(<LiveWorkspace />);
    expect(await screen.findByText(/could not be loaded, so automatic preparation stays off/)).toBeInTheDocument();
    expect(toggle()).toBeDisabled();
    const d = await openDrawer();
    expect(within(d).queryByTestId('auto-pilot')).not.toBeInTheDocument();
  });

  it('the toggle explains the scope and saves to the server', async () => {
    ai.getAutomation.mockResolvedValue({ ok: true, data: false });
    render(<LiveWorkspace />);
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(screen.getByText(/Each screenshot still needs its own Allow/)).toBeInTheDocument();
    expect(screen.getByText(/each send that screenshot to OpenAI/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(toggle()); });
    expect(ai.setAutomation).toHaveBeenCalledWith(true, expect.any(Function));
    expect(toggle()).toBeChecked();
    expect(ai.setConsent).not.toHaveBeenCalled();
    expect(ai.startAutoProcess).not.toHaveBeenCalled();
  });

  it('Allow is the only click: it continues automatically, once, with no manual Revive', async () => {
    render(<LiveWorkspace />);
    await waitFor(() => expect(toggle()).toBeChecked());
    const d = await openDrawer();
    await within(d).findByTestId('auto-pilot');
    expect(within(d).queryByRole('button', { name: 'Revive with AI' })).not.toBeInTheDocument();
    expect(ai.startAutoProcess).not.toHaveBeenCalled(); // opening only reads
    ai.startAutoProcess.mockResolvedValueOnce(st('analyzing', { consent: true, running: true }));
    ai.getAutoProcess.mockResolvedValue(st('analyzing', { consent: true, running: true }));
    await act(async () => { fireEvent.click(within(d).getByRole('button', { name: 'Allow AI processing' })); });
    await waitFor(() => expect(ai.startAutoProcess).toHaveBeenCalledTimes(1));
    expect(ai.setConsent).toHaveBeenCalledWith(42, true, expect.any(Function), expect.objectContaining({ provider: 'openai', revision: 'openai-test-rev' }));
    expect(await within(d).findByText('Understanding screenshot…')).toBeInTheDocument();
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
  });

  it('declining sends nothing and starts nothing', async () => {
    render(<LiveWorkspace />);
    await waitFor(() => expect(toggle()).toBeChecked());
    const d = await openDrawer();
    await within(d).findByTestId('auto-pilot');
    await act(async () => { fireEvent.click(within(d).getByRole('button', { name: 'Decline' })); });
    expect(ai.startAutoProcess).not.toHaveBeenCalled();
  });

  it('a single upload opens straight to its consent step without sending anything', async () => {
    client.uploadScreenshots.mockResolvedValue({ ok: true, accepted: 1, rejected: 0,
      results: [{ filename: 'event.png', status: 'accepted', screenshotId: 42, isDuplicate: false, error: null }] });
    client.listScreenshots.mockResolvedValueOnce({ ok: true, screenshots: [] }).mockResolvedValue({ ok: true, screenshots: [shot] });
    render(<LiveWorkspace />);
    await waitFor(() => expect(toggle()).toBeChecked());
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File([new Uint8Array([1])], 'event.png', { type: 'image/png' });
    await act(async () => { fireEvent.change(input!, { target: { files: [file] } }); });
    const d = await screen.findByRole('dialog', { name: 'event.png' });
    expect(await within(d).findByText(/Allow AI processing above/)).toBeInTheDocument();
    expect(ai.setConsent).not.toHaveBeenCalled();
    expect(ai.startAutoProcess).not.toHaveBeenCalled();
  });

  it('Finding 5: a manually prepared draft is not shown as chosen automatically in the assistant', async () => {
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [{ ...shot, analysis: {
      category: 'Reference/Document', uncertain: false, epitaph: 'A club event.', epitaphOrigin: 'ai_generate', epitaphProvider: 'openai',
    } }] });
    ai.getAutoProcess.mockResolvedValue(READY_MANUAL);
    render(<LiveWorkspace />);
    await waitFor(() => expect(toggle()).toBeChecked());
    await act(async () => { fireEvent.click(await screen.findByRole('checkbox', { name: 'Select event.png' })); });
    const assistant = screen.getByTestId('live-assistant');
    await waitFor(() => expect(ai.getAutoProcess).toHaveBeenCalledWith(42, expect.any(Function)));
    await act(async () => { await Promise.resolve(); });
    expect(within(assistant).queryByText('Chosen automatically · can be wrong')).not.toBeInTheDocument();
  });

  it('Review draft opens it in the assistant with the AI decision and its reason', async () => {
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [{ ...shot, analysis: {
      category: 'Reference/Document', uncertain: false, epitaph: 'A club event.', epitaphOrigin: 'ai_generate', epitaphProvider: 'openai',
    } }] });
    ai.getConsent.mockResolvedValue({ ok: true, data: true });
    ai.getAutoProcess.mockResolvedValue(READY);
    render(<LiveWorkspace />);
    await waitFor(() => expect(toggle()).toBeChecked());
    const d = await openDrawer();
    expect(await within(d).findByText('Ready for your review.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(d).getByRole('button', { name: 'Review draft' })); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const assistant = screen.getByTestId('live-assistant');
    expect(await within(assistant).findByText('Chosen automatically · can be wrong')).toBeInTheDocument();
    expect(within(assistant).getByText(/a date is visible in the screenshot/)).toBeInTheDocument();
    expect(within(assistant).getByRole('button', { name: 'Something else' })).toBeInTheDocument(); // override stays
    expect(ai.getEventDraftPreparation).toHaveBeenCalledWith(42, expect.any(Function));
    expect(ai.approveVersion).not.toHaveBeenCalled();
    expect(ai.startAutoProcess).not.toHaveBeenCalled();
  });
});
