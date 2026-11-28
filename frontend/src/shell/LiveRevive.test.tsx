import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analysis, ApiResult, Operation, ProviderMode, Accepted, Disclosure } from '../api/ai';
import type { ListResult, Screenshot } from '../api/client';

// Batch 3A: consent + Revive + classification in the Gothic Live Workspace.
// Both API modules are mocked; nothing here touches the network or an AI provider.

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
  setConsent: vi.fn<(id: number, granted: boolean, f?: typeof fetch) => Promise<ApiResult<boolean>>>(),
  // Batch 6A (P1-A): the server's disclosure (Fake by default; real-mode tests override it).
  getDisclosure: vi.fn<(f?: typeof fetch) => Promise<ApiResult<Disclosure>>>(async () => ({ ok: true as const, data: { provider: 'fake' as const, revision: 'fake-test-rev', text: 'This development build uses the Fake AI adapter. Nothing is sent to an external AI provider, and the result is placeholder text that does not read your screenshot.' } })),
  classifyScreenshot: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Accepted>>>(),
  getOperation: vi.fn<(opId: number, f?: typeof fetch) => Promise<ApiResult<Operation>>>(),
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

const shot: Screenshot = {
  screenshotId: 42, state: 'active', mimeType: 'image/png', originalFilename: 'syn.png',
  isDuplicate: false, duplicateOf: null, byteSize: 512, uploadedAt: '2026-11-19T20:00:00Z', analysis: null,
};
const analysis: Analysis = {
  screenshotId: 42,
  classification: { category: 'Study/Knowledge', confidence: 0.82, uncertain: false, versionNumber: 1, origin: 'ai_generate', provider: 'fake' },
  epitaph: { text: 'Saved to study later (synthetic fixture).', visibleFacts: 'Synthetic adapter does not interpret image content.', inferredIntent: null, uncertain: false, versionNumber: 1, origin: 'ai_generate', provider: 'fake' },
};
const fail = (status: number, code: string): ApiResult<never> => ({ ok: false, status, code, message: code });
const op = (status: Operation['status'], errorDetail: string | null = null): ApiResult<Operation> =>
  ({ ok: true, data: { operationId: 7, kind: 'classify', status, errorDetail, artifactId: null } });
const accepted: ApiResult<Accepted> = {
  ok: true, data: { operationId: 7, kind: 'classify', status: 'pending', errorDetail: null, artifactId: null, warning: null },
};
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  vi.clearAllMocks();
  client.getWorkspace.mockResolvedValue({ ok: true, active: true });
  client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [shot] });
  ai.getProviderMode.mockResolvedValue({ ok: true, data: 'fake' });
  ai.getConsent.mockResolvedValue({ ok: true, data: false });
  ai.getDisclosure.mockResolvedValue(FAKE_DISCLOSURE);
  ai.getAnalysis.mockResolvedValue(fail(404, 'not_found'));
  ai.setConsent.mockImplementation(async (_id, granted) => ({ ok: true, data: granted }));
});

async function openDrawer(name = 'syn.png') {
  const opener = await screen.findByRole('button', { name: `Open details for ${name}` });
  await act(async () => { fireEvent.click(opener); });
  return screen.getByRole('dialog', { name });
}
const revive = () => screen.getByRole('button', { name: /Revive with Fake AI|Starting…|Reviving…/ });
// P1-A: a grant echoes exactly the disclosure the panel showed.
const FAKE_DISCLOSURE = {
  ok: true as const,
  data: {
    provider: 'fake' as const, revision: 'fake-test-rev',
    text: 'This development build uses the Fake AI adapter. Nothing is sent to an external AI provider, and the result is placeholder text that does not read your screenshot.',
  },
};
const SHOWN = expect.objectContaining({ provider: 'fake', revision: 'fake-test-rev' });
const OPENAI_DISCLOSURE = {
  ok: true as const,
  data: {
    provider: 'openai' as const, revision: 'openai-test-rev',
    text: 'Revive sends the original image of this screenshot to OpenAI to analyze it. The app asks OpenAI not to store the response, but OpenAI may keep request data for a limited time for abuse monitoring under its own policies. The result is an AI suggestion and can be wrong.',
  },
};
async function grant() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Allow AI processing' })); });
}

describe('Gothic Revive: consent', () => {
  it('only reads on open, explains Fake AI, and keeps Revive off until consent is granted', async () => {
    render(<LiveWorkspace />);
    const dialog = await openDrawer();
    expect(within(dialog).getByText(/uses the Fake AI adapter\. Nothing is sent to an external AI provider/)).toBeInTheDocument();
    expect(within(dialog).getByText('Consent: not granted. Nothing will be analyzed.')).toBeInTheDocument();
    expect(revive()).toBeDisabled();
    expect(ai.getConsent).toHaveBeenCalledWith(42, expect.any(Function));
    expect(ai.getAnalysis).toHaveBeenCalledWith(42, expect.any(Function));
    expect(ai.setConsent).not.toHaveBeenCalled();
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
  });

  it('grants consent through the existing API and enables Revive', async () => {
    render(<LiveWorkspace />);
    await openDrawer();
    await grant();
    expect(ai.setConsent).toHaveBeenCalledWith(42, true, expect.any(Function), SHOWN);
    expect(screen.getByText('Consent: granted for this screenshot.')).toBeInTheDocument();
    expect(screen.getByText(/closing this panel does not withdraw it/)).toBeInTheDocument();
    expect(revive()).toBeEnabled();
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
  });

  it('records a decline, never classifies, and keeps Revive off', async () => {
    render(<LiveWorkspace />);
    await openDrawer();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Decline' })); });
    expect(ai.setConsent).toHaveBeenCalledWith(42, false, expect.any(Function));
    expect(screen.getByText(/You declined AI processing\. Nothing will be analyzed/)).toBeInTheDocument();
    expect(revive()).toBeDisabled();
    fireEvent.click(revive());
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
  });

  it('withdraws consent with honest copy and disables Revive', async () => {
    ai.getConsent.mockResolvedValue({ ok: true, data: true });
    render(<LiveWorkspace />);
    await openDrawer();
    expect(revive()).toBeEnabled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent' })); });
    expect(ai.setConsent).toHaveBeenCalledWith(42, false, expect.any(Function));
    expect(screen.getByText(/^AI consent withdrawn\. Withdrawing consent blocks every new AI request for it\. A request already sent may still complete at the AI provider; its result is not saved\.$/)).toBeInTheDocument();
    expect(revive()).toBeDisabled();
  });

  it('re-reads consent from the server when the consent response is lost', async () => {
    ai.setConsent.mockResolvedValue(fail(0, 'network'));
    render(<LiveWorkspace />);
    await openDrawer();
    ai.getConsent.mockResolvedValue({ ok: true, data: true }); // the server did save it
    await grant();
    await waitFor(() => expect(screen.getByText('Consent: granted for this screenshot.')).toBeInTheDocument());
    expect(ai.getConsent).toHaveBeenCalledTimes(2);
  });

  it('shows the server consent_required answer and does not start anything', async () => {
    ai.getConsent.mockResolvedValue({ ok: true, data: true }); // stale "granted" in the UI
    ai.classifyScreenshot.mockResolvedValue(fail(403, 'consent_required'));
    render(<LiveWorkspace />);
    await openDrawer();
    await act(async () => { fireEvent.click(revive()); });
    expect(screen.getByText('AI consent is required first. Nothing was processed.')).toBeInTheDocument();
    expect(screen.getByText('Consent: not granted. Nothing will be analyzed.')).toBeInTheDocument();
    expect(revive()).toBeDisabled();
    expect(ai.getOperation).not.toHaveBeenCalled();
  });

  it('with a real provider: the disclosure comes first, consent is explicit, then Revive sends one request', async () => {
    ai.getProviderMode.mockResolvedValue({ ok: true, data: 'openai' });
    ai.getDisclosure.mockResolvedValue(OPENAI_DISCLOSURE);
    render(<LiveWorkspace />);
    const d = await openDrawer();
    expect(within(d).getByText('Real AI · OpenAI')).toBeInTheDocument();
    expect(within(d).getByText(/Revive sends the original image of this screenshot to OpenAI to analyze it\./)).toBeInTheDocument();
    expect(within(d).getByText(/OpenAI may keep request data for a limited time for abuse monitoring/)).toBeInTheDocument();
    const realRevive = () => within(d).getByRole('button', { name: /Revive with AI|Starting…|Analyzing your screenshot…/ });
    expect(realRevive()).toBeDisabled(); // no consent yet
    expect(within(d).queryByRole('button', { name: /Revive with Fake AI/ })).not.toBeInTheDocument();
    ai.setConsent.mockResolvedValue({ ok: true, data: true });
    await grant();
    expect(ai.setConsent).toHaveBeenCalledWith(42, true, expect.any(Function), expect.objectContaining({ provider: 'openai', revision: 'openai-test-rev' }));
    expect(realRevive()).toBeEnabled();
    ai.classifyScreenshot.mockResolvedValue(accepted);
    ai.getOperation.mockResolvedValue(op('pending', null));
    await act(async () => { fireEvent.click(realRevive()); });
    expect(ai.classifyScreenshot).toHaveBeenCalledTimes(1);
  });

  it('while the provider is unknown, neither consent nor Revive is offered', async () => {
    ai.getProviderMode.mockResolvedValue(fail(503, 'service_unavailable'));
    render(<LiveWorkspace />);
    await openDrawer();
    expect(screen.getByText(/AI provider could not be confirmed, so Revive is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow AI processing' })).toBeDisabled();
    expect(revive()).toBeDisabled();
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
  });
});

describe('Gothic Revive: operation states', () => {
  beforeEach(() => {
    ai.getConsent.mockResolvedValue({ ok: true, data: true });
  });

  it('runs pending → successful, shows the persisted Fake AI result, re-syncs the gallery, and submits once', async () => {
    const post = deferred<ApiResult<Accepted>>();
    ai.classifyScreenshot.mockReturnValue(post.promise);
    ai.getOperation.mockResolvedValueOnce(op('pending')).mockResolvedValue(op('successful'));
    render(<LiveWorkspace />);
    await openDrawer();
    vi.useFakeTimers();
    try {
      fireEvent.click(revive());
      fireEvent.click(revive());
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(ai.classifyScreenshot).toHaveBeenCalledTimes(1);
      expect(ai.classifyScreenshot).toHaveBeenCalledWith(42, expect.any(Function));
      expect(screen.getByText('Sending the Revive request…')).toBeInTheDocument();
      ai.getAnalysis.mockResolvedValue({ ok: true, data: analysis });
      client.listScreenshots.mockResolvedValue({
        ok: true, screenshots: [{ ...shot, analysis: { category: 'Study/Knowledge', uncertain: false, epitaph: 'x', epitaphOrigin: 'ai_generate' } }],
      });
      await act(async () => { post.resolve(accepted); await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('Revive is running on the server…')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    } finally {
      vi.useRealTimers();
    }
    const result = await screen.findByLabelText('Classification result');
    expect(within(result).getByText('Study/Knowledge')).toBeInTheDocument();
    expect(within(result).getByText('Simulated result')).toBeInTheDocument();
    // Fake AI confidence is a fixed placeholder: never shown as a percentage.
    expect(within(result).queryByText(/82%/)).not.toBeInTheDocument();
    expect(within(result).getByText(/Not meaningful: the Fake AI returns a fixed placeholder value/)).toBeInTheDocument();
    expect(within(result).getAllByText(/demo AI \(placeholder text, not real image understanding\)/)).not.toHaveLength(0);
    expect(ai.getOperation).toHaveBeenCalledTimes(2);
    expect(ai.classifyScreenshot).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('article', { name: 'syn.png' })).toHaveTextContent('Revived'));
    expect(screen.queryByRole('button', { name: /Revive with Fake AI/ })).not.toBeInTheDocument();
  });

  it.each([
    { status: 'failed' as const, detail: 'AI processing consent required', text: /consent is missing or was withdrawn, so nothing was saved/ },
    { status: 'failed' as const, detail: 'AI analysis timed out', text: /did not answer in time\. Nothing was saved/ },
    { status: 'failed' as const, detail: 'AI provider busy; try again later', text: /provider is busy right now\. Nothing was saved/ },
    { status: 'failed' as const, detail: 'AI analysis failed', text: /did not complete \(this includes timeouts\)/ },
    { status: 'uncertain' as const, detail: 'AI result uncertain', text: /not sure about this one, so no result was saved/ },
  ])('reports a terminal $status ($detail) honestly and allows a new Revive', async ({ status, detail, text }) => {
    ai.classifyScreenshot.mockResolvedValue(accepted);
    ai.getOperation.mockResolvedValue(op(status, detail));
    render(<LiveWorkspace />);
    await openDrawer();
    await act(async () => { fireEvent.click(revive()); });
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByLabelText('Classification result')).not.toBeInTheDocument();
    expect(revive()).toBeEnabled();
  });

  it.each([
    { name: 'a lost response', res: fail(0, 'network') },
    { name: 'a malformed 202 body', res: fail(202, 'bad_shape') },
    { name: 'an unexpected 500', res: fail(500, 'http_500') },
  ])('treats $name as unknown: no failure claim, no second submission, resolved only by a persisted result', async ({ res }) => {
    ai.classifyScreenshot.mockResolvedValue(res);
    render(<LiveWorkspace />);
    await openDrawer();
    await act(async () => { fireEvent.click(revive()); });
    expect(await screen.findByText(/could not confirm whether the Revive request reached the server/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(revive()).toBeDisabled();
    // Closing and reopening keeps it blocked.
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    await openDrawer();
    expect(screen.getByText(/could not confirm whether the Revive request reached the server/)).toBeInTheDocument();
    expect(revive()).toBeDisabled();
    // Still nothing on the server: stays unresolved.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check status' })); });
    expect(screen.getByText(/could not confirm whether the Revive request reached the server/)).toBeInTheDocument();
    // The server did run it: the persisted analysis resolves it.
    ai.getAnalysis.mockResolvedValue({ ok: true, data: analysis });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check status' })); });
    expect(screen.getByLabelText('Classification result')).toBeInTheDocument();
    expect(ai.classifyScreenshot).toHaveBeenCalledTimes(1);
  });

  it('treats a 503 from the classify route as definitely not started and allows retry', async () => {
    ai.classifyScreenshot.mockResolvedValueOnce(fail(503, 'service_unavailable'));
    render(<LiveWorkspace />);
    await openDrawer();
    await act(async () => { fireEvent.click(revive()); });
    expect(screen.getByText('The service is temporarily unavailable. Please try again shortly.')).toBeInTheDocument();
    expect(revive()).toBeEnabled();
  });

  it('keeps an unavailable poll unresolved with its operation id and resumes it on Check status', async () => {
    ai.classifyScreenshot.mockResolvedValue(accepted);
    ai.getOperation.mockResolvedValue(fail(503, 'service_unavailable'));
    render(<LiveWorkspace />);
    await openDrawer();
    vi.useFakeTimers();
    try {
      fireEvent.click(revive());
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByText(/Revive status is temporarily unavailable/)).toBeInTheDocument();
    expect(revive()).toBeDisabled();
    ai.getOperation.mockResolvedValue(op('successful'));
    ai.getAnalysis.mockResolvedValue({ ok: true, data: analysis });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check status' })); });
    expect(await screen.findByLabelText('Classification result')).toBeInTheDocument();
    expect(ai.getOperation).toHaveBeenLastCalledWith(7, expect.any(Function));
    expect(ai.classifyScreenshot).toHaveBeenCalledTimes(1);
  });
});

describe('Gothic Revive: drawer close and unmount', () => {
  beforeEach(() => {
    ai.getConsent.mockResolvedValue({ ok: true, data: true });
  });

  it('stops polling when the drawer closes and resumes the same operation on reopen without resubmitting', async () => {
    ai.classifyScreenshot.mockResolvedValue(accepted);
    ai.getOperation.mockResolvedValue(op('pending'));
    render(<LiveWorkspace />);
    await openDrawer();
    let polls = 0;
    vi.useFakeTimers();
    try {
      fireEvent.click(revive());
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      polls = ai.getOperation.mock.calls.length;
      expect(polls).toBeGreaterThan(0);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      // The pending 1 s poll wait is cancelled at once, not left to expire. (Advancing
      // 0 ms only flushes jsdom's own 0 ms timer from restoring focus to the opener.)
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(ai.getOperation).toHaveBeenCalledTimes(polls);
    } finally {
      vi.useRealTimers();
    }
    // Reopen: no analysis exists yet, so a result can only come from resuming operation 7.
    ai.getOperation.mockResolvedValue(op('successful'));
    ai.getAnalysis.mockResolvedValueOnce(fail(404, 'not_found')).mockResolvedValue({ ok: true, data: analysis });
    await openDrawer();
    expect(await screen.findByLabelText('Classification result')).toBeInTheDocument();
    expect(ai.getOperation.mock.calls.length).toBeGreaterThan(polls);
    expect(ai.getOperation).toHaveBeenLastCalledWith(7, expect.any(Function));
    expect(ai.classifyScreenshot).toHaveBeenCalledTimes(1);
  });

  it('keeps the operation id when the drawer closes while the classify POST is still in flight', async () => {
    const post = deferred<ApiResult<Accepted>>();
    ai.classifyScreenshot.mockReturnValue(post.promise);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<LiveWorkspace />);
      await openDrawer();
      fireEvent.click(revive());
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
      await act(async () => { post.resolve(accepted); });
      expect(ai.getOperation).not.toHaveBeenCalled(); // nobody polls a closed drawer
      ai.getOperation.mockResolvedValue(op('successful'));
      ai.getAnalysis.mockResolvedValueOnce(fail(404, 'not_found')).mockResolvedValue({ ok: true, data: analysis });
      await openDrawer();
      expect(await screen.findByLabelText('Classification result')).toBeInTheDocument();
      expect(ai.getOperation).toHaveBeenCalledWith(7, expect.any(Function));
      expect(ai.classifyScreenshot).toHaveBeenCalledTimes(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('sends nothing more and leaves no timers after LiveWorkspace unmounts mid-poll', async () => {
    ai.classifyScreenshot.mockResolvedValue(accepted);
    ai.getOperation.mockResolvedValue(op('pending'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const view = render(<LiveWorkspace />);
      await openDrawer();
      vi.useFakeTimers();
      try {
        fireEvent.click(revive());
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        const polls = ai.getOperation.mock.calls.length;
        const reads = client.listScreenshots.mock.calls.length;
        view.unmount();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(ai.getOperation).toHaveBeenCalledTimes(polls);
        expect(client.listScreenshots).toHaveBeenCalledTimes(reads);
      } finally {
        vi.useRealTimers();
      }
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('does not offer Revive for an archived screenshot', async () => {
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [{ ...shot, state: 'archived' }] });
    render(<LiveWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /The Crypt/ }));
    await openDrawer();
    expect(screen.getByText('Resurrect this screenshot to Revive it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revive with Fake AI/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resurrection' })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Batch 3A remediation regressions (Codex reproductions).

describe('Codex P1: no second Revive once the operation is confirmed successful', () => {
  beforeEach(() => {
    ai.getConsent.mockResolvedValue({ ok: true, data: true });
    ai.classifyScreenshot.mockResolvedValue(accepted);
    ai.getOperation.mockResolvedValue(op('successful'));
  });

  it('keeps Revive unavailable while the result read is still pending', async () => {
    const resultRead = deferred<ApiResult<Analysis>>();
    ai.getAnalysis.mockResolvedValueOnce(fail(404, 'not_found')).mockReturnValueOnce(resultRead.promise);
    render(<LiveWorkspace />);
    await openDrawer();
    await act(async () => { fireEvent.click(revive()); });
    await waitFor(() => expect(ai.getAnalysis).toHaveBeenCalledTimes(2));
    // Codex step 4/5: the result GET is held; Revive must not come back.
    const again = screen.queryByRole('button', { name: /Revive with Fake AI/ });
    if (again) {
      expect(again).toBeDisabled();
      await act(async () => { fireEvent.click(again); });
    }
    expect(ai.classifyScreenshot).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Revive finished on the server\. Loading the result/)).toBeInTheDocument();
    await act(async () => { resultRead.resolve({ ok: true, data: analysis }); });
    expect(screen.getByLabelText('Classification result')).toBeInTheDocument();
    expect(ai.classifyScreenshot).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'fails (503)', res: fail(503, 'service_unavailable') },
    { name: 'times out / is lost (network)', res: fail(0, 'network') },
    { name: 'answers 404 even though the operation succeeded', res: fail(404, 'not_found') },
  ])('offers only "Retry loading result" when the result read $name', async ({ res }) => {
    ai.getAnalysis.mockResolvedValueOnce(fail(404, 'not_found')).mockResolvedValueOnce(res);
    render(<LiveWorkspace />);
    await openDrawer();
    await act(async () => { fireEvent.click(revive()); });
    const retry = await screen.findByRole('button', { name: 'Retry loading result' });
    expect(screen.queryByRole('button', { name: /Revive with Fake AI/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Revive finished on the server, but the result could not be loaded/)).toBeInTheDocument();
    expect(screen.getByText('Consent: granted for this screenshot.')).toBeInTheDocument();
    // Retry fails again: still no Revive, still one POST.
    ai.getAnalysis.mockResolvedValueOnce(fail(503, 'service_unavailable'));
    await act(async () => { fireEvent.click(retry); });
    expect(screen.getByRole('button', { name: 'Retry loading result' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revive with Fake AI/ })).not.toBeInTheDocument();
    // Retry succeeds: GET /analysis only.
    ai.getAnalysis.mockResolvedValue({ ok: true, data: analysis });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry loading result' })); });
    expect(screen.getByLabelText('Classification result')).toBeInTheDocument();
    expect(ai.getAnalysis).toHaveBeenCalledTimes(4);
    expect(ai.classifyScreenshot).toHaveBeenCalledTimes(1);
    expect(ai.getOperation).toHaveBeenCalledTimes(1);
    expect(ai.setConsent).not.toHaveBeenCalled();
  });
});

describe('Codex P1: a failed consent withdrawal never leaves Revive enabled', () => {
  beforeEach(() => {
    ai.getConsent.mockResolvedValue({ ok: true, data: true });
    ai.classifyScreenshot.mockResolvedValue(accepted);
  });

  it('reproduces 503 withdrawal + stalled consent GET: Revive stays blocked', async () => {
    const staleRead = deferred<ApiResult<boolean>>();
    ai.setConsent.mockResolvedValue(fail(503, 'service_unavailable'));
    render(<LiveWorkspace />);
    await openDrawer();
    expect(revive()).toBeEnabled();
    ai.getConsent.mockReturnValueOnce(staleRead.promise); // the follow-up GET stalls
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent' })); });
    expect(ai.setConsent).toHaveBeenCalledWith(42, false, expect.any(Function));
    expect(screen.queryByText('Consent: granted for this screenshot.')).not.toBeInTheDocument();
    expect(screen.getByText(/withdrawal could not be confirmed/i)).toBeInTheDocument();
    // Nothing is claimed from the old cached "granted" while the re-read is pending.
    expect(screen.queryByText(/still has consent recorded/)).not.toBeInTheDocument();
    expect(revive()).toBeDisabled();
    await act(async () => { fireEvent.click(revive()); });
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
    // The stalled GET finally says "granted": that is NOT a new authorization.
    await act(async () => { staleRead.resolve({ ok: true, data: true }); });
    expect(revive()).toBeDisabled();
    await act(async () => { fireEvent.click(revive()); });
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
    expect(screen.getByText(/still has consent recorded/)).toBeInTheDocument();
    // Explicit, current authorization re-enables it.
    ai.setConsent.mockResolvedValue({ ok: true, data: true });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Allow AI processing' })); });
    expect(ai.setConsent).toHaveBeenLastCalledWith(42, true, expect.any(Function), SHOWN);
    expect(revive()).toBeEnabled();
  });

  it('blocks Revive while the withdrawal request itself is in flight', async () => {
    const post = deferred<ApiResult<boolean>>();
    ai.setConsent.mockReturnValue(post.promise);
    render(<LiveWorkspace />);
    await openDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent' }));
    await flush();
    expect(screen.queryByText('Consent: granted for this screenshot.')).not.toBeInTheDocument();
    expect(revive()).toBeDisabled();
    await act(async () => { post.resolve({ ok: true, data: false }); });
    expect(screen.getByText('Consent: not granted. Nothing will be analyzed.')).toBeInTheDocument();
    expect(revive()).toBeDisabled();
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
  });

  it('stays blocked after the drawer is closed and reopened, and Retry withdrawal resolves it', async () => {
    ai.setConsent.mockResolvedValue(fail(0, 'network'));
    render(<LiveWorkspace />);
    await openDrawer();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent' })); });
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    await openDrawer(); // a fresh GET says granted
    expect(screen.getByText(/withdrawal could not be confirmed/i)).toBeInTheDocument();
    expect(revive()).toBeDisabled();
    ai.setConsent.mockResolvedValue({ ok: true, data: false });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry withdrawal' })); });
    expect(ai.setConsent).toHaveBeenLastCalledWith(42, false, expect.any(Function));
    expect(screen.getByText('Consent: not granted. Nothing will be analyzed.')).toBeInTheDocument();
    expect(screen.queryByText(/withdrawal could not be confirmed/i)).not.toBeInTheDocument();
    expect(revive()).toBeDisabled();
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
  });

  it('Check consent clears the block only when the server confirms consent is off', async () => {
    ai.setConsent.mockResolvedValue(fail(503, 'service_unavailable'));
    render(<LiveWorkspace />);
    await openDrawer();
    ai.getConsent.mockResolvedValueOnce({ ok: true, data: true }); // follow-up read after failure
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent' })); });
    ai.getConsent.mockResolvedValue({ ok: true, data: false }); // the withdrawal did land
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check consent' })); });
    expect(screen.getByText('Consent: not granted. Nothing will be analyzed.')).toBeInTheDocument();
    expect(screen.queryByText(/withdrawal could not be confirmed/i)).not.toBeInTheDocument();
    expect(revive()).toBeDisabled();
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Codex re-review blockers (second round).

describe('Codex P1 (round 2): confirmed success survives drawer remount, burial and resurrection', () => {
  beforeEach(() => {
    ai.getConsent.mockResolvedValue({ ok: true, data: true });
    ai.classifyScreenshot.mockResolvedValue(accepted); // operation id 7
    ai.getOperation.mockResolvedValue(op('successful'));
  });
  const classifyPosts = () => ai.classifyScreenshot.mock.calls.length;
  async function hammerRevive() {
    for (const b of screen.queryAllByRole('button', { name: /revive/i })) {
      if (!(b as HTMLButtonElement).disabled) await act(async () => { fireEvent.click(b); });
    }
  }
  const reviveOffered = () =>
    screen.queryAllByRole('button', { name: /Revive with Fake AI/ }).some((b) => !(b as HTMLButtonElement).disabled);

  it('close and reopen after confirmed success, GET /analysis 404: only "Retry loading result", one POST ever', async () => {
    const held = deferred<ApiResult<Analysis>>();
    ai.getAnalysis
      .mockResolvedValueOnce(fail(404, 'not_found')) // 1: open
      .mockReturnValueOnce(held.promise) // 2: result read after success, held
      .mockResolvedValue(fail(404, 'not_found')); // 3+: every later read says 404
    render(<LiveWorkspace />);
    await openDrawer();
    await act(async () => { fireEvent.click(revive()); });
    await waitFor(() => expect(ai.getAnalysis).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    await openDrawer();
    expect(await screen.findByRole('button', { name: 'Retry loading result' })).toBeInTheDocument();
    expect(reviveOffered()).toBe(false);
    await hammerRevive();
    expect(classifyPosts()).toBe(1);
    const reads = ai.getAnalysis.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry loading result' })); });
    expect(ai.getAnalysis.mock.calls.length).toBe(reads + 1);
    expect(screen.getByRole('button', { name: 'Retry loading result' })).toBeInTheDocument();
    expect(reviveOffered()).toBe(false);
    expect(classifyPosts()).toBe(1);
    expect(ai.getOperation).toHaveBeenCalledTimes(1);
  });

  it('Safe Burial → Resurrection → reopen, GET /analysis 404: only "Retry loading result", one POST ever', async () => {
    const held = deferred<ApiResult<Analysis>>();
    ai.getAnalysis
      .mockResolvedValueOnce(fail(404, 'not_found'))
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue(fail(404, 'not_found'));
    client.archiveScreenshot.mockResolvedValue({ ok: true, screenshotId: 42, status: 'successful', state: 'archived' });
    client.restoreScreenshot.mockResolvedValue({ ok: true, screenshotId: 42, status: 'successful', state: 'active' });
    render(<LiveWorkspace />);
    await openDrawer();
    await act(async () => { fireEvent.click(revive()); });
    await waitFor(() => expect(ai.getAnalysis).toHaveBeenCalledTimes(2));
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [{ ...shot, state: 'archived' }] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Safe Burial' })); });
    await screen.findByText(/Moved to The Crypt/);
    fireEvent.click(screen.getByRole('button', { name: /The Crypt/ }));
    client.listScreenshots.mockResolvedValue({ ok: true, screenshots: [shot] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resurrection for syn.png' })); });
    await screen.findByText(/Resurrected\./);
    fireEvent.click(screen.getByRole('button', { name: /Workspace/ }));
    await openDrawer();
    expect(await screen.findByRole('button', { name: 'Retry loading result' })).toBeInTheDocument();
    expect(reviveOffered()).toBe(false);
    await hammerRevive();
    expect(classifyPosts()).toBe(1);
  });
});

describe('Codex P2 (round 2): a stalled manual "Check consent" is bounded and recoverable', () => {
  it('aborts the never-settling GET at the deadline, restores both recovery actions, keeps Revive blocked', async () => {
    ai.getConsent.mockResolvedValue({ ok: true, data: true });
    ai.setConsent.mockResolvedValue(fail(503, 'service_unavailable'));
    render(<LiveWorkspace />);
    await openDrawer();
    expect(revive()).toBeEnabled();
    // From now on every consent GET reaches a transport that never answers
    // unless aborted, as a real stalled request would.
    const signals: AbortSignal[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal) {
          signals.push(init.signal);
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }
      })) as unknown as typeof fetch;
    ai.getConsent.mockImplementation((id: number, f?: typeof fetch) =>
      (f ?? fetch)(`/api/screenshots/${id}/consent`).then(
        () => ({ ok: true as const, data: true }),
        () => fail(0, 'network'),
      ));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent' })); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check consent' })); });
      expect(screen.getByRole('button', { name: 'Check consent' })).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((sig) => sig.aborted)).toBe(true);
      expect(screen.getByRole('button', { name: 'Check consent' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Retry withdrawal' })).toBeEnabled();
      expect(screen.getByText(/withdrawal could not be confirmed/i)).toBeInTheDocument();
      expect(revive()).toBeDisabled();
      await act(async () => { fireEvent.click(revive()); });
      expect(ai.classifyScreenshot).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      globalThis.fetch = realFetch;
      errors.mockRestore();
    }
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
  });

  it('cancels an in-flight consent read when the drawer unmounts', async () => {
    const signals: AbortSignal[] = [];
    ai.getConsent.mockImplementation((_id: number, f?: typeof fetch) => {
      const stub = vi.fn((_u: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_r, reject) => {
          if (init?.signal) {
            signals.push(init.signal);
            init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }
        }));
      const realFetch = globalThis.fetch;
      globalThis.fetch = stub as unknown as typeof fetch;
      try {
        return (f ?? fetch)('/api/screenshots/42/consent').then(() => ({ ok: true as const, data: true }), () => fail(0, 'network'));
      } finally {
        globalThis.fetch = realFetch;
      }
    });
    render(<LiveWorkspace />);
    await openDrawer();
    expect(signals.length).toBe(1);
    expect(signals[0].aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(signals[0].aborted).toBe(true);
  });
});

describe('Batch 6A P1-A: consent is bound to the disclosure the user saw', () => {
  it('a stale disclosure is refused: the current one is shown, nothing is re-sent, a fresh click sends the new revision', async () => {
    render(<LiveWorkspace />);
    const d = await openDrawer();
    expect(within(d).getByText(/uses the Fake AI adapter/)).toBeInTheDocument();
    ai.setConsent.mockResolvedValueOnce(fail(409, 'disclosure_changed'));
    ai.getDisclosure.mockResolvedValue({ ok: true, data: { provider: 'fake', revision: 'fake-rev-2', text: 'A revised Fake AI disclosure.' } });
    await grant();
    expect(ai.setConsent).toHaveBeenCalledTimes(1);
    expect(within(d).getByText(/The AI processing disclosure changed since it was shown, so nothing was recorded/)).toBeInTheDocument();
    expect(await within(d).findByText('A revised Fake AI disclosure.')).toBeInTheDocument();
    expect(within(d).getByText('Consent: not granted. Nothing will be analyzed.')).toBeInTheDocument();
    expect(ai.setConsent).toHaveBeenCalledTimes(1); // never re-submitted on its own
    ai.setConsent.mockResolvedValueOnce({ ok: true, data: true });
    await grant();
    expect(ai.setConsent).toHaveBeenLastCalledWith(42, true, expect.any(Function), expect.objectContaining({ revision: 'fake-rev-2' }));
  });

  it('a disclosure for another provider than the server mode (or none) never allows a grant', async () => {
    ai.getDisclosure.mockResolvedValue(OPENAI_DISCLOSURE); // the mode says fake
    render(<LiveWorkspace />);
    const d = await openDrawer();
    expect(within(d).getByRole('button', { name: 'Allow AI processing' })).toBeDisabled();
    expect(within(d).queryByText(/Revive sends the original image/)).not.toBeInTheDocument();
    // C2: an explicit, retryable state, never an endless "Loading".
    expect(within(d).getByText(/The AI provider changed while this was being checked, so consent cannot be given yet/)).toBeInTheDocument();
    expect(within(d).queryByText('Loading the AI processing disclosure…')).not.toBeInTheDocument();
    await grant();
    expect(ai.setConsent).not.toHaveBeenCalled();
  });

  it('a disclosure that cannot be loaded blocks consent and can be retried', async () => {
    ai.getDisclosure.mockResolvedValue(fail(503, 'service_unavailable'));
    render(<LiveWorkspace />);
    const d = await openDrawer();
    expect(within(d).getByText(/disclosure could not be loaded, so consent cannot be given/)).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Allow AI processing' })).toBeDisabled();
    ai.getDisclosure.mockResolvedValue(FAKE_DISCLOSURE);
    await act(async () => { fireEvent.click(within(d).getByRole('button', { name: 'Load it again' })); });
    expect(within(d).getByRole('button', { name: 'Allow AI processing' })).toBeEnabled();
  });

  it('withdrawing never needs the disclosure', async () => {
    ai.getConsent.mockResolvedValue({ ok: true, data: true });
    ai.getDisclosure.mockResolvedValue(fail(503, 'service_unavailable'));
    ai.setConsent.mockResolvedValue({ ok: true, data: false });
    render(<LiveWorkspace />);
    await openDrawer();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent' })); });
    expect(ai.setConsent).toHaveBeenCalledWith(42, false, expect.any(Function));
  });
});

describe('Batch 6A C2: recovering after the server switched provider', () => {
  const OPENAI_MODE = { ok: true as const, data: 'openai' as const };
  const FAKE_MODE = { ok: true as const, data: 'fake' as const };
  const allow = () => screen.getByRole('button', { name: 'Allow AI processing' });

  async function refusedAfterSwitch(nextMode: ApiResult<ProviderMode>, nextDisclosure: ApiResult<Disclosure>) {
    render(<LiveWorkspace />);
    const d = await openDrawer();
    const mode = deferred<ApiResult<ProviderMode>>();
    const disc = deferred<ApiResult<Disclosure>>();
    ai.getProviderMode.mockImplementationOnce(() => mode.promise);
    ai.getDisclosure.mockImplementationOnce(() => disc.promise);
    ai.setConsent.mockResolvedValueOnce(fail(409, 'disclosure_changed'));
    await grant();
    return { d, mode, disc, finish: async () => {
      await act(async () => { mode.resolve(nextMode); disc.resolve(nextDisclosure); });
    } };
  }

  it('Fake -> OpenAI: the OpenAI disclosure is shown and only a fresh Allow sends its exact revision', async () => {
    const { d, finish } = await refusedAfterSwitch(OPENAI_MODE, OPENAI_DISCLOSURE);
    expect(within(d).getByText(/disclosure changed since it was shown, so nothing was recorded/)).toBeInTheDocument();
    await finish();
    expect(within(d).getByText(/Revive sends the original image of this screenshot to OpenAI/)).toBeInTheDocument();
    expect(within(d).queryByText(/uses the Fake AI adapter/)).not.toBeInTheDocument();
    expect(within(d).queryByText('Loading the AI processing disclosure…')).not.toBeInTheDocument();
    expect(within(d).getByText('Real AI · OpenAI')).toBeInTheDocument();
    expect(ai.setConsent).toHaveBeenCalledTimes(1); // nothing re-sent, nothing granted
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
    expect(allow()).toBeEnabled();
    ai.setConsent.mockResolvedValueOnce({ ok: true, data: true });
    await grant();
    expect(ai.setConsent).toHaveBeenCalledTimes(2);
    expect(ai.setConsent).toHaveBeenLastCalledWith(42, true, expect.any(Function),
      expect.objectContaining({ provider: 'openai', revision: 'openai-test-rev' }));
  });

  it('OpenAI -> Fake: the Fake disclosure is shown and a fresh Allow sends it', async () => {
    ai.getProviderMode.mockResolvedValue(OPENAI_MODE);
    ai.getDisclosure.mockResolvedValue(OPENAI_DISCLOSURE);
    const { d, finish } = await refusedAfterSwitch(FAKE_MODE, FAKE_DISCLOSURE);
    await finish();
    expect(within(d).getByText(/uses the Fake AI adapter/)).toBeInTheDocument();
    expect(within(d).queryByText(/Revive sends the original image/)).not.toBeInTheDocument();
    expect(within(d).getByText('Fake AI · development')).toBeInTheDocument();
    ai.setConsent.mockResolvedValueOnce({ ok: true, data: true });
    await grant();
    expect(ai.setConsent).toHaveBeenLastCalledWith(42, true, expect.any(Function), SHOWN);
  });

  it('a revised disclosure with the same provider is shown and its new revision is sent', async () => {
    const revised = { ok: true as const, data: { provider: 'fake' as const, revision: 'fake-rev-3', text: 'Revised Fake text.' } };
    const { d, finish } = await refusedAfterSwitch(FAKE_MODE, revised);
    await finish();
    expect(within(d).getByText('Revised Fake text.')).toBeInTheDocument();
    ai.setConsent.mockResolvedValueOnce({ ok: true, data: true });
    await grant();
    expect(ai.setConsent).toHaveBeenLastCalledWith(42, true, expect.any(Function), expect.objectContaining({ revision: 'fake-rev-3' }));
  });

  it('the provider keeps changing during recovery: an honest retryable state, never endless loading', async () => {
    render(<LiveWorkspace />);
    const d = await openDrawer();
    ai.setConsent.mockResolvedValueOnce(fail(409, 'disclosure_changed'));
    // Every round: the mode says fake, the disclosure says openai.
    ai.getProviderMode.mockResolvedValue(FAKE_MODE);
    ai.getDisclosure.mockResolvedValue(OPENAI_DISCLOSURE);
    await grant();
    await within(d).findByText(/The AI provider changed while this was being checked/);
    expect(within(d).queryByText('Loading the AI processing disclosure…')).not.toBeInTheDocument();
    expect(allow()).toBeDisabled();
    // Once it settles, "Check again" recovers.
    ai.getProviderMode.mockResolvedValue(OPENAI_MODE);
    await act(async () => { fireEvent.click(within(d).getByRole('button', { name: 'Check again' })); });
    expect(within(d).getByText(/Revive sends the original image of this screenshot to OpenAI/)).toBeInTheDocument();
    expect(allow()).toBeEnabled();
    expect(ai.setConsent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['provider status', () => ai.getProviderMode.mockImplementationOnce(async () => fail(503, 'service_unavailable'))],
    ['disclosure', () => ai.getDisclosure.mockImplementationOnce(async () => fail(503, 'service_unavailable'))],
  ])('a failed %s refresh is an honest, retryable error', async (_n, breakIt) => {
    render(<LiveWorkspace />);
    const d = await openDrawer();
    ai.setConsent.mockResolvedValueOnce(fail(409, 'disclosure_changed'));
    ai.getProviderMode.mockResolvedValue(OPENAI_MODE);
    ai.getDisclosure.mockResolvedValue(OPENAI_DISCLOSURE);
    breakIt();
    await grant();
    await within(d).findByText(/disclosure could not be loaded, so consent cannot be given right now/);
    expect(allow()).toBeDisabled();
    await act(async () => { fireEvent.click(within(d).getByRole('button', { name: 'Load it again' })); });
    expect(within(d).getByText(/Revive sends the original image of this screenshot to OpenAI/)).toBeInTheDocument();
    expect(allow()).toBeEnabled();
    expect(ai.setConsent).toHaveBeenCalledTimes(1);
  });

  it('after a refused grant nothing can be revived until a fresh Allow succeeds', async () => {
    const { d, finish } = await refusedAfterSwitch(OPENAI_MODE, OPENAI_DISCLOSURE);
    await finish();
    const reviveBtn = within(d).getByRole('button', { name: /Revive with AI|Revive with Fake AI/ });
    expect(reviveBtn).toBeDisabled();
    await act(async () => { fireEvent.click(reviveBtn); });
    expect(ai.classifyScreenshot).not.toHaveBeenCalled();
  });

  it('D2: the provider GET stalls after a 409 -> a retryable error; Retry recovers; only a fresh Allow grants', async () => {
    render(<LiveWorkspace />);
    const d = await openDrawer();
    vi.useFakeTimers();
    try {
      const hung = deferred<ApiResult<ProviderMode>>();
      ai.getProviderMode.mockImplementationOnce(() => hung.promise);
      ai.getDisclosure.mockResolvedValueOnce(OPENAI_DISCLOSURE);  // the disclosure answers
      ai.setConsent.mockResolvedValueOnce(fail(409, 'disclosure_changed'));
      await grant();
      expect(within(d).getByText('Loading the AI processing disclosure…')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
      expect(within(d).queryByText('Loading the AI processing disclosure…')).not.toBeInTheDocument();
      expect(within(d).getByText(/disclosure could not be loaded, so consent cannot be given right now/)).toBeInTheDocument();
      expect(allow()).toBeDisabled();
      ai.getProviderMode.mockResolvedValueOnce(OPENAI_MODE);
      ai.getDisclosure.mockResolvedValueOnce(OPENAI_DISCLOSURE);
      await act(async () => { fireEvent.click(within(d).getByRole('button', { name: 'Load it again' })); await vi.advanceTimersByTimeAsync(0); });
      expect(within(d).getByText(/Revive sends the original image of this screenshot to OpenAI/)).toBeInTheDocument();
      await act(async () => { hung.resolve({ ok: true, data: 'fake' }); await vi.advanceTimersByTimeAsync(0); }); // late: ignored
      expect(within(d).getByText('Real AI · OpenAI')).toBeInTheDocument();
      expect(ai.setConsent).toHaveBeenCalledTimes(1);
      expect(ai.classifyScreenshot).not.toHaveBeenCalled();
      expect(allow()).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
    ai.setConsent.mockResolvedValueOnce({ ok: true, data: true });
    await grant();
    expect(ai.setConsent).toHaveBeenLastCalledWith(42, true, expect.any(Function),
      expect.objectContaining({ provider: 'openai', revision: 'openai-test-rev' }));
  });
});
