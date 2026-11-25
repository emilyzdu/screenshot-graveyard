import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analysis, ApiResult, Operation, ProviderMode, Accepted } from '../api/ai';
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
  classification: { category: 'Study/Knowledge', confidence: 0.82, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
  epitaph: { text: 'Saved to study later (synthetic fixture).', visibleFacts: 'Synthetic adapter does not interpret image content.', inferredIntent: null, uncertain: false, versionNumber: 1, origin: 'ai_generate' },
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
  ai.getAnalysis.mockResolvedValue(fail(404, 'not_found'));
  ai.setConsent.mockImplementation(async (_id, granted) => ({ ok: true, data: granted }));
});

async function openDrawer(name = 'syn.png') {
  const opener = await screen.findByRole('button', { name: `Open details for ${name}` });
  await act(async () => { fireEvent.click(opener); });
  return screen.getByRole('dialog', { name });
}
const revive = () => screen.getByRole('button', { name: /Revive with Fake AI|Starting…|Reviving…/ });
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
    expect(ai.setConsent).toHaveBeenCalledWith(42, true, expect.any(Function));
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
    expect(screen.getByText(/Withdrawing cannot stop an analysis that already started/)).toBeInTheDocument();
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

  it('refuses consent and Revive when a real provider is configured, and while the provider is unknown', async () => {
    ai.getProviderMode.mockResolvedValue({ ok: true, data: 'openai' });
    const first = render(<LiveWorkspace />);
    await openDrawer();
    expect(screen.getByText(/A real AI provider is configured on the server\. Revive is turned off/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow AI processing' })).toBeDisabled();
    expect(revive()).toBeDisabled();
    first.unmount();
    // Even with consent already granted on the server, a real provider keeps Revive off.
    ai.getConsent.mockResolvedValue({ ok: true, data: true });
    const second = render(<LiveWorkspace />);
    await openDrawer();
    expect(screen.getByText('Consent: granted for this screenshot.')).toBeInTheDocument();
    expect(revive()).toBeDisabled();
    second.unmount();
    ai.getConsent.mockResolvedValue({ ok: true, data: false });
    ai.getProviderMode.mockResolvedValue(fail(503, 'service_unavailable'));
    render(<LiveWorkspace />);
    await openDrawer();
    expect(screen.getByText(/AI provider could not be confirmed, so Revive is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow AI processing' })).toBeDisabled();
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
    { status: 'failed' as const, detail: 'AI processing consent required', text: /consent is missing or was withdrawn before the work started/ },
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
    expect(ai.setConsent).toHaveBeenLastCalledWith(42, true, expect.any(Function));
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
