import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult, Disclosure, ProviderMode } from '../api/ai';

const ai = vi.hoisted(() => ({
  getDisclosure: vi.fn<(f?: typeof fetch) => Promise<ApiResult<Disclosure>>>(),
  getProviderMode: vi.fn<(f?: typeof fetch) => Promise<ApiResult<ProviderMode>>>(),
}));
vi.mock('../api/ai', async (orig) => ({ ...(await orig<typeof import('../api/ai')>()), ...ai }));

import { useDisclosure } from './useDisclosure';
import { useProviderStatus } from './PrivacyNotice';

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const disc = (provider: ProviderMode, revision: string): ApiResult<Disclosure> => ({ ok: true, data: { provider, revision, text: `${provider} ${revision}` } });

beforeEach(() => {
  vi.clearAllMocks();
  ai.getDisclosure.mockResolvedValue(disc('fake', 'f1'));
  ai.getProviderMode.mockResolvedValue({ ok: true, data: 'fake' });
});
afterEach(() => {
  vi.useRealTimers(); // a failed fake-timer test never leaks its clock into the next one
});

describe('Batch 6A C2: stale asynchronous answers never overwrite newer ones', () => {
  it('two overlapping recoveries: the older pair answering last is ignored', async () => {
    const { result } = renderHook(() => useDisclosure());
    await act(async () => {});
    const oldMode = deferred<ProviderMode | 'unknown' | null>();
    const oldDisc = deferred<ApiResult<Disclosure>>();
    ai.getDisclosure.mockImplementationOnce(() => oldDisc.promise).mockResolvedValueOnce(disc('openai', 'o2'));
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = result.current.recover(() => oldMode.promise);
      second = result.current.recover(async () => 'openai');
      await second;
    });
    expect(result.current.state).toMatchObject({ t: 'ready', disclosure: { provider: 'openai', revision: 'o2' } });
    await act(async () => { oldMode.resolve('fake'); oldDisc.resolve(disc('fake', 'f-old')); await first; });
    expect(result.current.state).toMatchObject({ t: 'ready', disclosure: { provider: 'openai', revision: 'o2' } });
  });

  it('provider refreshes are latest-wins, and a superseded read reports null', async () => {
    const { result } = renderHook(() => useProviderStatus());
    await act(async () => {});
    const slow = deferred<ApiResult<ProviderMode>>();
    ai.getProviderMode.mockImplementationOnce(() => slow.promise).mockResolvedValueOnce({ ok: true, data: 'openai' });
    let older!: Promise<ProviderMode | 'unknown' | null>;
    let newer!: ProviderMode | 'unknown' | null;
    await act(async () => {
      older = result.current.refresh();
      newer = await result.current.refresh();
    });
    expect(newer).toBe('openai');
    await act(async () => { slow.resolve({ ok: true, data: 'fake' }); });
    expect(await older).toBeNull();
    expect(result.current.mode).toBe('openai');
  });

  it('a pair that keeps disagreeing ends in "changing", not loading; a failed read ends in "error"', async () => {
    const { result } = renderHook(() => useDisclosure());
    await act(async () => {});
    ai.getDisclosure.mockResolvedValue(disc('openai', 'o1'));
    await act(async () => { await result.current.recover(async () => 'fake'); });
    expect(result.current.state).toEqual({ t: 'changing' });
    expect(ai.getDisclosure.mock.calls.length).toBeLessThanOrEqual(1 + 3); // bounded rounds
    await act(async () => { await result.current.recover(async () => 'unknown'); });
    expect(result.current.state).toEqual({ t: 'error' });
  });

  it('D2: a provider status read that hangs ends in a retryable error, and its late answer is ignored', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => ({ status: useProviderStatus(), disc: useDisclosure() }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const hung = deferred<ApiResult<ProviderMode>>();
      ai.getProviderMode.mockImplementationOnce(() => hung.promise);
      ai.getDisclosure.mockResolvedValueOnce(disc('openai', 'o1'));
      let recovering!: Promise<void>;
      await act(async () => { recovering = result.current.disc.recover(result.current.status.refresh); });
      expect(result.current.disc.state).toEqual({ t: 'loading' });
      await act(async () => { await vi.advanceTimersByTimeAsync(10_001); await recovering; });
      expect(result.current.disc.state).toEqual({ t: 'error' });       // retryable, not loading
      expect(result.current.status.mode).toBe('unknown');               // no stale pair kept
      // Retry: a coherent pair arrives.
      ai.getProviderMode.mockResolvedValueOnce({ ok: true, data: 'openai' });
      ai.getDisclosure.mockResolvedValueOnce(disc('openai', 'o2'));
      await act(async () => { await result.current.disc.recover(result.current.status.refresh); });
      expect(result.current.disc.state).toMatchObject({ t: 'ready', disclosure: { provider: 'openai', revision: 'o2' } });
      expect(result.current.status.mode).toBe('openai');
      // The hung read finally answers "fake": ignored.
      await act(async () => { hung.resolve({ ok: true, data: 'fake' }); await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.status.mode).toBe('openai');
      expect(result.current.disc.state).toMatchObject({ t: 'ready', disclosure: { revision: 'o2' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('D2: a disclosure read that hangs is bounded too', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useDisclosure());
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      ai.getDisclosure.mockImplementationOnce(() => new Promise(() => {}));
      let recovering!: Promise<void>;
      await act(async () => { recovering = result.current.recover(async () => 'fake'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(10_001); await recovering; });
      expect(result.current.state).toEqual({ t: 'error' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('D2: an older recovery that times out after a newer one succeeded cannot overwrite it', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => ({ status: useProviderStatus(), disc: useDisclosure() }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    ai.getProviderMode.mockClear();
    ai.getDisclosure.mockClear();
    ai.getProviderMode.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce({ ok: true, data: 'openai' });
    ai.getDisclosure.mockResolvedValueOnce(disc('fake', 'f-old')).mockResolvedValueOnce(disc('openai', 'o2'));
    let older!: Promise<void>;
    await act(async () => {
      older = result.current.disc.recover(result.current.status.refresh);
      await result.current.disc.recover(result.current.status.refresh);
    });
    expect(result.current.disc.state).toMatchObject({ t: 'ready', disclosure: { provider: 'openai', revision: 'o2' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); await older; });
    expect(result.current.disc.state).toMatchObject({ t: 'ready', disclosure: { provider: 'openai', revision: 'o2' } });
    expect(result.current.status.mode).toBe('openai');
    // One provider read and one disclosure read per recovery; the timeout adds no retry of its own.
    expect(ai.getProviderMode).toHaveBeenCalledTimes(2);
    expect(ai.getDisclosure).toHaveBeenCalledTimes(2);
  });
  it('D2: a provider read that hangs on mount stops loading and reports unknown', async () => {
    vi.useFakeTimers();
    ai.getProviderMode.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useProviderStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(result.current).toMatchObject({ mode: 'unknown', loading: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(result.current).toMatchObject({ mode: 'unknown', loading: false }); // "could not be confirmed", gates closed
    ai.getProviderMode.mockResolvedValueOnce({ ok: true, data: 'openai' });
    await act(async () => { await result.current.refresh(); });
    expect(result.current).toMatchObject({ mode: 'openai', loading: false });
  });
});
