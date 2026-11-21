import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedFetch } from './boundedFetch';

const hanging = () =>
  vi.fn((_u: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));

describe('boundedFetch', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('aborts a request that exceeds its bound and clears its timer', async () => {
    vi.useFakeTimers();
    const f = hanging();
    vi.stubGlobal('fetch', f);
    const p = boundedFetch(1000)('/x');
    const settled = expect(p).rejects.toThrow('aborted');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts when the outer signal aborts and removes its listener', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hanging());
    const outer = new AbortController();
    const remove = vi.spyOn(outer.signal, 'removeEventListener');
    const p = boundedFetch(60_000, outer.signal)('/x');
    const settled = expect(p).rejects.toThrow('aborted');
    outer.abort();
    await settled;
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('passes a successful response through and cleans up', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}'))));
    const res = await boundedFetch(1000)('/x', { method: 'POST', headers: { 'X-Requested-With': 'fetch' } });
    expect(res.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('X-Requested-With')).toBe('fetch');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
