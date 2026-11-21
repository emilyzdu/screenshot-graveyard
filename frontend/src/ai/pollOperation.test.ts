import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult, Operation } from '../api/ai';

const ai = vi.hoisted(() => ({ getOperation: vi.fn<(id: number, f?: typeof fetch) => Promise<ApiResult<Operation>>>() }));
vi.mock('../api/ai', () => ai);
import { pollOperation } from './pollOperation';

const pending: ApiResult<Operation> = { ok: true, data: { operationId: 1, kind: 'classify', status: 'pending', errorDetail: null, artifactId: null } };

describe('pollOperation cancellation and bounds', () => {
  afterEach(() => {
    vi.useRealTimers();
    ai.getOperation.mockReset();
  });

  it('sends no request when already cancelled', async () => {
    const c = new AbortController();
    c.abort();
    expect(await pollOperation(1, { intervalMs: 1000, maxPolls: 5, signal: c.signal })).toEqual({ kind: 'cancelled' });
    expect(ai.getOperation).not.toHaveBeenCalled();
  });

  it('abort during the wait ends at once, clears the timer and sends nothing more', async () => {
    vi.useFakeTimers();
    ai.getOperation.mockResolvedValue(pending);
    const c = new AbortController();
    const p = pollOperation(1, { intervalMs: 1000, maxPolls: 5, signal: c.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(ai.getOperation).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    c.abort();
    expect(await p).toEqual({ kind: 'cancelled' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ai.getOperation).toHaveBeenCalledTimes(1);
  });

  it('passes a bounded fetch only when asked, keeping the classic call shape otherwise', async () => {
    ai.getOperation.mockResolvedValue({ ...pending, data: { ...pending.data, status: 'successful' } } as ApiResult<Operation>);
    await pollOperation(1, { intervalMs: 0, maxPolls: 1 });
    expect(ai.getOperation).toHaveBeenLastCalledWith(1);
    await pollOperation(1, { intervalMs: 0, maxPolls: 1, requestTimeoutMs: 500 });
    expect(ai.getOperation).toHaveBeenLastCalledWith(1, expect.any(Function));
  });
});
