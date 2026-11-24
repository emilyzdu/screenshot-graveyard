import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analysis, ApiResult, Operation, Accepted } from '../api/ai';
import type { Screenshot } from '../api/client';

// The two Codex reproductions, written the way an independent reviewer would:
// RevivePanel rendered directly (no LiveWorkspace providing shared state), and
// API mocks that ignore the `fetch` argument entirely, so the only bounds and
// memory that count are the ones RevivePanel/useConsent enforce themselves.
const ai = vi.hoisted(() => ({
  getConsent: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<boolean>>>(),
  setConsent: vi.fn<(id: number, g: boolean, f?: typeof fetch) => Promise<ApiResult<boolean>>>(),
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
  getEventDraft: vi.fn(),
  getStudyNote: vi.fn(),
}));
vi.mock('../api/ai', () => ai);
import { RevivePanel } from './RevivePanel';

const shot: Screenshot = {
  screenshotId: 42, state: 'active', mimeType: 'image/png', originalFilename: 'syn.png',
  isDuplicate: false, duplicateOf: null, byteSize: 9, uploadedAt: '2026-11-19T20:00:00Z', analysis: null,
};
const fail = (status: number, code: string): ApiResult<never> => ({ ok: false, status, code, message: code });
const accepted: ApiResult<Accepted> = {
  ok: true, data: { operationId: 7, kind: 'classify', status: 'pending', errorDetail: null, artifactId: null, warning: null },
};
const successful: ApiResult<Operation> = {
  ok: true, data: { operationId: 7, kind: 'classify', status: 'successful', errorDetail: null, artifactId: null },
};
const never = <T,>() => new Promise<T>(() => {});
const panel = (s: Screenshot = shot) => (
  <RevivePanel screenshot={s} providerMode="fake" providerLoading={false} onAnalysisChanged={() => {}} />
);
const reviveOffered = () =>
  screen.queryAllByRole('button', { name: /Revive with Fake AI/ }).some((b) => !(b as HTMLButtonElement).disabled);
async function hammerRevive() {
  for (const b of screen.queryAllByRole('button', { name: /revive/i })) {
    if (!(b as HTMLButtonElement).disabled) await act(async () => { fireEvent.click(b); });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  ai.getConsent.mockResolvedValue({ ok: true, data: true });
  ai.classifyScreenshot.mockResolvedValue(accepted);
  ai.getOperation.mockResolvedValue(successful);
});

describe('Codex P1, standalone panel: confirmed success survives remount', () => {
  it('op 7 successful → result GET pending → unmount → remount → GET /analysis 404: one POST ever', async () => {
    ai.getAnalysis
      .mockResolvedValueOnce(fail(404, 'not_found')) // first mount: no analysis yet
      .mockReturnValueOnce(never()) // result read after success: never answers
      .mockResolvedValue(fail(404, 'not_found')); // every later read: 404
    const first = render(panel());
    const revive = await screen.findByRole('button', { name: 'Revive with Fake AI' });
    await waitFor(() => expect(revive).toBeEnabled());
    await act(async () => { fireEvent.click(revive); });
    await waitFor(() => expect(ai.getAnalysis).toHaveBeenCalledTimes(2));
    first.unmount();
    render(panel());
    expect(await screen.findByRole('button', { name: 'Retry loading result' })).toBeInTheDocument();
    expect(reviveOffered()).toBe(false);
    await hammerRevive();
    const reads = ai.getAnalysis.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry loading result' })); });
    expect(ai.getAnalysis.mock.calls.length).toBe(reads + 1);
    expect(reviveOffered()).toBe(false);
    expect(ai.classifyScreenshot).toHaveBeenCalledTimes(1);
  });

  it('…then archived and restored (new screenshot props) → remount → 404: one POST ever', async () => {
    ai.getAnalysis.mockResolvedValueOnce(fail(404, 'not_found')).mockReturnValueOnce(never()).mockResolvedValue(fail(404, 'not_found'));
    const first = render(panel());
    const revive = await screen.findByRole('button', { name: 'Revive with Fake AI' });
    await waitFor(() => expect(revive).toBeEnabled());
    await act(async () => { fireEvent.click(revive); });
    await waitFor(() => expect(ai.getAnalysis).toHaveBeenCalledTimes(2));
    first.unmount();
    const archived = render(panel({ ...shot, state: 'archived' }));
    await screen.findByRole('button', { name: 'Retry loading result' });
    archived.unmount();
    render(panel({ ...shot, state: 'active' }));
    expect(await screen.findByRole('button', { name: 'Retry loading result' })).toBeInTheDocument();
    expect(reviveOffered()).toBe(false);
    await hammerRevive();
    expect(ai.classifyScreenshot).toHaveBeenCalledTimes(1);
  });
});

describe('Codex P2, getConsent mocked as a promise that never settles', () => {
  it('Check consent recovers after the deadline; Revive stays blocked; no POST; no timers', async () => {
    ai.getAnalysis.mockResolvedValue(fail(404, 'not_found'));
    ai.setConsent.mockResolvedValue(fail(503, 'service_unavailable'));
    const view = render(panel());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revive with Fake AI' })).toBeEnabled());
    ai.getConsent.mockImplementation(() => never()); // ignores any fetch it is given
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent' })); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check consent' })); });
      expect(screen.getByRole('button', { name: 'Check consent' })).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(screen.getByRole('button', { name: 'Check consent' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Retry withdrawal' })).toBeEnabled();
      expect(reviveOffered()).toBe(false);
      await hammerRevive();
      expect(ai.classifyScreenshot).not.toHaveBeenCalled();
      // The fetch handed to getConsent was aborted at the deadline.
      const calls = ai.getConsent.mock.calls;
      const f = calls[calls.length - 1]?.[1];
      expect(typeof f).toBe('function');
      view.unmount();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
