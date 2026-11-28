import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Real api/ai.ts + boundedFetch + pollOperation: only global fetch is stubbed.
import { classifyScreenshot, getOperation } from './ai';
import { boundedFetch } from './boundedFetch';
import { pollOperation } from '../ai/pollOperation';
import { RevivePanel } from '../shell/RevivePanel';
import type { Screenshot } from './client';

/** Headers arrive at once; the body never produces a byte or closes. */
function stalledResponse(status = 200) {
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, { status, headers: { 'Content-Type': 'application/json' } }), state };
}
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

/** Track whether a promise has settled without awaiting it. */
function track<T>(p: Promise<T>) {
  const t: { settled: boolean; value?: T } = { settled: false };
  void p.then((v) => {
    t.settled = true;
    t.value = v;
  });
  return t;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Codex P2: the time bound covers the response body, not just the headers', () => {
  it('classify POST: a stalled body times out, is cancelled, and is sent once', async () => {
    vi.useFakeTimers();
    const stalled = stalledResponse(202);
    const fetchSpy = vi.fn(() => Promise.resolve(stalled.response));
    vi.stubGlobal('fetch', fetchSpy);
    const result = track(classifyScreenshot(42, boundedFetch(1000)));
    await vi.advanceTimersByTimeAsync(999);
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(result.settled).toBe(true);
    // Reported as no usable answer (status 0), which the panel treats as an unknown outcome.
    expect(result.value).toEqual({ ok: false, status: 0, code: 'network', message: 'Network request failed' });
    expect(stalled.state.cancelled).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('operation GET: aborting the outer signal cancels a stalled body and removes the listener', async () => {
    vi.useFakeTimers();
    const stalled = stalledResponse();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(stalled.response)));
    const outer = new AbortController();
    const remove = vi.spyOn(outer.signal, 'removeEventListener');
    const result = track(getOperation(7, boundedFetch(60_000, outer.signal)));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.settled).toBe(false);
    outer.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.settled).toBe(true);
    expect(result.value).toMatchObject({ ok: false, status: 0 });
    expect(stalled.state.cancelled).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pollOperation: a stalled status body counts as a failed poll within the bound', async () => {
    vi.useFakeTimers();
    const stalled = stalledResponse();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(stalled.response)));
    const outcome = track(pollOperation(7, { intervalMs: 1000, maxPolls: 1, requestTimeoutMs: 500 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(outcome.value).toEqual({ kind: 'unavailable' });
    expect(stalled.state.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a normal body is still delivered intact with its status and headers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ operationId: 7, kind: 'classify', status: 'pending' }, 202))));
    const res = await classifyScreenshot(42, boundedFetch(1000));
    expect(res).toEqual({
      ok: true,
      data: { operationId: 7, kind: 'classify', status: 'pending', errorDetail: null, artifactId: null, warning: null },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closing the drawer cancels a stalled operation-status body and keeps the operation id', async () => {
    const stalled = stalledResponse();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/consent')) return Promise.resolve(json({ screenshotId: 42, granted: true }));
        if (url.endsWith('/analysis')) return Promise.resolve(json({ error: { code: 'not_found', message: 'Not Found' } }, 404));
        if (url.endsWith('/classify')) return Promise.resolve(json({ operationId: 7, kind: 'classify', status: 'pending' }, 202));
        if (url.includes('/api/operations/')) return Promise.resolve(stalled.response);
        return Promise.reject(new Error(`unexpected ${url}`));
      }),
    );
    const shot: Screenshot = {
      screenshotId: 42, state: 'active', mimeType: 'image/png', originalFilename: 'syn.png',
      isDuplicate: false, duplicateOf: null, byteSize: 1, uploadedAt: '2026-11-19T20:00:00Z', analysis: null,
    };
    const view = render(<RevivePanel screenshot={shot} providerMode="fake" providerLoading={false} onAnalysisChanged={() => {}} />);
    const revive = await screen.findByRole('button', { name: 'Revive with Fake AI' });
    await waitFor(() => expect(revive).toBeEnabled());
    await act(async () => { fireEvent.click(revive); });
    await waitFor(() => expect(calls.some((c) => c.includes('/api/operations/7'))).toBe(true));
    expect(stalled.state.cancelled).toBe(false);
    view.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(stalled.state.cancelled).toBe(true);
    const { getReviveEntry } = await import('../ai/reviveCoordinator');
    expect(getReviveEntry(42)).toEqual({ phase: 'unresolved', operationId: 7 });
    expect(calls.filter((c) => c.startsWith('POST') && c.endsWith('/classify'))).toHaveLength(1);
  });
});
