import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult, AutoProcessState, AutoStage } from '../api/ai';
import type { Screenshot } from '../api/client';

// Batch 6B: the AI-first flow panel. The API is mocked; nothing is sent anywhere.
const ai = vi.hoisted(() => ({
  getAutoProcess: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<AutoProcessState>>>(),
  startAutoProcess: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<AutoProcessState>>>(),
  requestEventDraft: vi.fn(),
  requestMakeNotesDraft: vi.fn(),
}));
vi.mock('../api/ai', async (orig) => ({ ...(await orig<typeof import('../api/ai')>()), ...ai }));
import { AutoPilot } from './AutoPilot';

const shot: Screenshot = {
  screenshotId: 42, state: 'active', mimeType: 'image/png', originalFilename: 'event.png',
  isDuplicate: false, duplicateOf: null, byteSize: 512, uploadedAt: '2026-11-19T20:00:00Z', analysis: null,
};
const ROUTE_CAL = { decision: 'auto' as const, action: 'add_calendar' as const, reasonCode: 'calendar_evidence',
  reason: 'The AI suggested Add to Calendar, and a date is visible in the screenshot.' };
const st = (stage: AutoStage, over: Partial<AutoProcessState> = {}): ApiResult<AutoProcessState> => ({
  ok: true,
  data: { screenshotId: 42, autoPrepare: true, consent: true, stage, route: null, analysis: null, preparation: null, running: false, ...over },
});
const prep = (
  status: 'pending' | 'successful' | 'failed',
  action: 'add_calendar' | 'make_notes' = 'add_calendar',
  trigger: 'auto' | 'manual' | null = 'auto',
) => ({
  operationId: 9, status, artifactId: status === 'successful' ? 3 : null, errorDetail: status === 'failed' ? 'AI provider timed out' : null,
  provider: 'openai', action, trigger,
});
const fail = (status: number, code: string): ApiResult<never> => ({ ok: false, status, code, message: code });

function renderPilot(props: Partial<Parameters<typeof AutoPilot>[0]> = {}) {
  const handlers = { onState: vi.fn(), onSettled: vi.fn(), onReview: vi.fn() };
  const utils = render(
    <AutoPilot screenshot={shot} providerMode="openai" startSignal={0} pollIntervalMs={1000} maxPolls={5} {...handlers} {...props} />,
  );
  return { ...utils, ...handlers };
}
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Batch 6B AutoPilot', () => {
  it('opening only reads: no start, no preparation request', async () => {
    ai.getAutoProcess.mockResolvedValue(st('not_started'));
    renderPilot();
    await tick(0);
    expect(screen.getByRole('button', { name: 'Continue automatically' })).toBeEnabled();
    await tick(10_000);
    expect(ai.getAutoProcess).toHaveBeenCalledTimes(1); // not in progress: no polling either
    expect(ai.startAutoProcess).not.toHaveBeenCalled();
    expect(ai.requestEventDraft).not.toHaveBeenCalled();
  });

  it('a consent grant continues automatically and shows each stage until the draft is ready', async () => {
    ai.getAutoProcess.mockResolvedValueOnce(st('awaiting_consent', { consent: false }));
    const { rerender, onSettled, onReview, onState } = renderPilot();
    await tick(0);
    expect(screen.getByText(/Allow AI processing above/)).toBeInTheDocument();
    ai.startAutoProcess.mockResolvedValueOnce(st('analyzing', { running: true }));
    ai.getAutoProcess
      .mockResolvedValueOnce(st('analyzing', { running: true }))
      .mockResolvedValueOnce(st('routing', { running: true, route: ROUTE_CAL }))
      .mockResolvedValueOnce(st('preparing', { running: true, route: ROUTE_CAL, preparation: prep('pending') }))
      .mockResolvedValue(st('ready_for_review', { route: ROUTE_CAL, preparation: prep('successful') }));
    rerender(<AutoPilot screenshot={shot} providerMode="openai" startSignal={1} pollIntervalMs={1000} maxPolls={5}
      onState={onState} onSettled={onSettled} onReview={onReview} />);
    await tick(0);
    expect(ai.startAutoProcess).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Understanding screenshot…')).toBeInTheDocument();
    await tick(1000);
    expect(screen.getByText('Choosing the best next step…')).toBeInTheDocument();
    await tick(1000);
    expect(screen.getByText('Preparing your calendar event…')).toBeInTheDocument();
    await tick(1000);
    expect(screen.getByText('Ready for your review.')).toBeInTheDocument();
    expect(screen.getByText('Chosen automatically · can be wrong')).toBeInTheDocument();
    expect(screen.getByText(ROUTE_CAL.reason)).toBeInTheDocument();
    expect(screen.getByText('Real AI · OpenAI')).toBeInTheDocument();
    expect(onSettled).toHaveBeenCalledTimes(1);
    await tick(10_000);
    const reads = ai.getAutoProcess.mock.calls.length;
    await tick(10_000);
    expect(ai.getAutoProcess).toHaveBeenCalledTimes(reads); // polling stopped
    expect(ai.startAutoProcess).toHaveBeenCalledTimes(1); // never re-sent
    fireEvent.click(screen.getByRole('button', { name: 'Review draft' }));
    expect(onReview).toHaveBeenCalledWith(42);
  });

  it('a lost start is reconciled by reading, never by sending it again', async () => {
    ai.getAutoProcess.mockResolvedValueOnce(st('not_started'));
    renderPilot();
    await tick(0);
    ai.startAutoProcess.mockResolvedValueOnce(fail(0, 'network'));
    ai.getAutoProcess.mockResolvedValue(st('analyzing', { running: true }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue automatically' })); });
    await tick(0);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not confirm whether the request reached the server/);
    expect(screen.getByText('Understanding screenshot…')).toBeInTheDocument();
    await tick(3000);
    expect(ai.startAutoProcess).toHaveBeenCalledTimes(1);
  });

  it('polling is bounded and then waits for an explicit check', async () => {
    ai.getAutoProcess.mockResolvedValue(st('analyzing', { running: true }));
    renderPilot({ maxPolls: 3 });
    await tick(0);
    await tick(10_000);
    expect(ai.getAutoProcess).toHaveBeenCalledTimes(4); // first read + 3 polls
    expect(screen.getByText(/taking longer than expected/)).toBeInTheDocument();
    await tick(60_000);
    expect(ai.getAutoProcess).toHaveBeenCalledTimes(4);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check again' })); });
    expect(ai.getAutoProcess).toHaveBeenCalledTimes(5);
    expect(ai.startAutoProcess).not.toHaveBeenCalled();
  });

  it('closing the drawer stops polling', async () => {
    ai.getAutoProcess.mockResolvedValue(st('preparing', { running: true, route: ROUTE_CAL, preparation: prep('pending') }));
    const { unmount } = renderPilot();
    await tick(0);
    unmount();
    await tick(10_000);
    expect(ai.getAutoProcess).toHaveBeenCalledTimes(1);
  });

  it('a failed analysis is never retried automatically; Try again is explicit', async () => {
    ai.getAutoProcess.mockResolvedValue(st('analysis_failed', {
      analysis: { operationId: 5, status: 'failed', artifactId: null, errorDetail: 'AI provider timed out', provider: 'openai', trigger: 'auto' } }));
    renderPilot();
    await tick(5000);
    expect(screen.getByText(/did not finish \(AI provider timed out\)/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is retried automatically/)).toBeInTheDocument();
    expect(ai.startAutoProcess).not.toHaveBeenCalled();
    ai.startAutoProcess.mockResolvedValueOnce(st('analyzing', { running: true }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(ai.startAutoProcess).toHaveBeenCalledTimes(1);
  });

  it('a recommendation waits for the user; preparing it is an explicit request', async () => {
    const route = { decision: 'recommend' as const, action: 'add_calendar' as const, reasonCode: 'no_date_evidence',
      reason: 'The AI suggested Add to Calendar, but no date was recorded in what it saw.' };
    ai.getAutoProcess.mockResolvedValueOnce(st('recommended', { route }));
    const { onReview } = renderPilot();
    await tick(5000);
    expect(screen.getByText(route.reason)).toBeInTheDocument();
    expect(ai.requestEventDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Choose something else' }));
    expect(onReview).toHaveBeenCalledWith(42);
    ai.requestEventDraft.mockResolvedValueOnce({ ok: true, data: {} });
    ai.getAutoProcess.mockResolvedValue(st('preparing', { route, preparation: prep('pending') }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Prepare Add to Calendar' })); });
    expect(ai.requestEventDraft).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Preparing your calendar event…')).toBeInTheDocument();
  });

  it.each([
    ['needs_choice', 'sensitive', 'It may contain sensitive details, so nothing is prepared automatically.', 'Your choice.'],
    ['reference', 'no_step', 'Nothing to prepare: this looks like something to keep for reference.', 'Kept as a reference.'],
  ] as const)('%s (%s): no draft, no prepare button, the reason is shown', async (stage, code, reason, lead) => {
    ai.getAutoProcess.mockResolvedValueOnce(st(stage, { route: { decision: stage === 'reference' ? 'keep_reference' : 'needs_choice', action: null, reasonCode: code, reason } }));
    renderPilot();
    await tick(0);
    expect(screen.getByText(lead)).toBeInTheDocument();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Prepare / })).not.toBeInTheDocument();
    expect(ai.requestEventDraft).not.toHaveBeenCalled();
    expect(ai.requestMakeNotesDraft).not.toHaveBeenCalled();
  });

  it('notes progress text and a manual choice is labelled as yours', async () => {
    ai.getAutoProcess
      .mockResolvedValueOnce(st('preparing', { running: true, preparation: prep('pending', 'make_notes', 'manual') }))
      .mockResolvedValue(st('ready_for_review', { route: ROUTE_CAL, preparation: prep('successful', 'make_notes', 'manual') }));
    renderPilot();
    await tick(0);
    expect(screen.getByText('Preparing your study notes…')).toBeInTheDocument();
    await tick(1000);
    expect(screen.getByText('Chosen by you')).toBeInTheDocument();
  });

  it('Finding 5: a manual draft that matches the route is never labelled automatic', async () => {
    ai.getAutoProcess.mockResolvedValue(st('ready_for_review', { route: ROUTE_CAL, preparation: prep('successful', 'add_calendar', 'manual') }));
    renderPilot();
    await tick(0);
    expect(screen.getByText('Chosen by you')).toBeInTheDocument();
    expect(screen.queryByText(/Chosen automatically/)).not.toBeInTheDocument();
    expect(screen.queryByText(ROUTE_CAL.reason)).not.toBeInTheDocument(); // no automatic reason either
  });

  it('Finding 5: an unrecorded trigger is shown neutrally', async () => {
    ai.getAutoProcess.mockResolvedValue(st('ready_for_review', { route: ROUTE_CAL, preparation: prep('successful', 'add_calendar', null) }));
    renderPilot();
    await tick(0);
    expect(screen.getByText('Draft prepared')).toBeInTheDocument();
    expect(screen.queryByText(/Chosen automatically|Chosen by you/)).not.toBeInTheDocument();
  });

  it('a start refused by the server says why and starts nothing', async () => {
    ai.getAutoProcess.mockResolvedValue(st('not_started'));
    renderPilot();
    await tick(0);
    ai.startAutoProcess.mockResolvedValueOnce(fail(403, 'consent_required'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue automatically' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Allow AI processing for this screenshot first. Nothing was sent.');
  });
});
