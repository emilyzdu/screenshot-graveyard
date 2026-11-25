import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLatestCheck } from './draftHistory';

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const describeV = (v: { n: number }) => `Version ${v.n}.`;

describe('useLatestCheck', () => {
  it('two checks of the same form answering out of order: only the newest publishes', async () => {
    const { result } = renderHook(() => useLatestCheck<{ n: number }>('form-A'));
    const first = deferred<{ n: number } | null>();
    const second = deferred<{ n: number } | null>();
    let p1!: Promise<void>; let p2!: Promise<void>;
    act(() => { p1 = result.current.check(() => first.promise, () => true, describeV); });
    act(() => { p2 = result.current.check(() => second.promise, () => false, describeV); });
    await act(async () => { second.resolve({ n: 2 }); await p2; });
    expect(result.current.text).toBe('Version 2. It does not contain exactly your edits.');
    await act(async () => { first.resolve({ n: 1 }); await p1; });
    expect(result.current.text).toBe('Version 2. It does not contain exactly your edits.');
  });

  it('a form change while checking makes the answer stale and says so', async () => {
    const { result, rerender } = renderHook(({ fp }) => useLatestCheck<{ n: number }>(fp), { initialProps: { fp: 'form-A' } });
    const held = deferred<{ n: number } | null>();
    let p!: Promise<void>;
    act(() => { p = result.current.check(() => held.promise, () => true, describeV); });
    rerender({ fp: 'form-B' });
    expect(result.current.checking).toBe(false);
    await act(async () => { held.resolve({ n: 1 }); await p; });
    expect(result.current.text).toBe('The save status could not be confirmed. The form changed while checking. Check again.');
  });
});
