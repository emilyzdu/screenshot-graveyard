import { getOperation, type OperationKind, type OperationStatus } from '../api/ai';
import { boundedFetch } from '../api/boundedFetch';

/** Stop after this many poll requests in a row failed (network, 5xx, ...). */
export const MAX_CONSECUTIVE_POLL_FAILURES = 3;

export type PollOutcome =
  | {
      kind: 'done';
      status: Exclude<OperationStatus, 'pending'>;
      errorDetail: string | null;
      artifactId: number | null;
    }
  /** The bound was reached while the server still said pending. */
  | { kind: 'timeout' }
  /** Poll requests kept failing, so the real status is unknown. */
  | { kind: 'unavailable' }
  /** 404: the server has no such operation. Final. */
  | { kind: 'not_found' }
  | { kind: 'cancelled' };

/** Resolves after `ms`, or immediately when `signal` aborts. The timer is always cleared. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * Bounded polling of `GET /api/operations/{id}`. Poll request failures are
 * counted and reported as `unavailable`; they are never treated as "pending".
 */
export async function pollOperation(
  operationId: number,
  opts: {
    intervalMs: number;
    maxPolls: number;
    isCancelled?: () => boolean;
    /** Aborting stops the loop at once: it cancels the pending wait and the in-flight request. */
    signal?: AbortSignal;
    /** Upper bound for each status request; a request that exceeds it counts as a failed poll. */
    requestTimeoutMs?: number;
    /**
     * The kind the operation must have. An answer for another operation id or
     * another kind is not this operation's status: it counts as a failed
     * (unreadable) poll, so it can never be reported as done.
     */
    expectKind?: OperationKind;
  },
): Promise<PollOutcome> {
  let failures = 0;
  const cancelled = () => Boolean(opts.signal?.aborted) || Boolean(opts.isCancelled?.());
  const f =
    opts.requestTimeoutMs !== undefined || opts.signal
      ? boundedFetch(opts.requestTimeoutMs ?? 2 ** 31 - 1, opts.signal)
      : undefined;
  for (let i = 0; i < opts.maxPolls; i += 1) {
    // Checked before each request too, so a cancelled loop sends nothing more.
    if (cancelled()) return { kind: 'cancelled' };
    const res = f ? await getOperation(operationId, f) : await getOperation(operationId);
    if (cancelled()) return { kind: 'cancelled' };
    const foreign =
      res.ok && (res.data.operationId !== operationId || (opts.expectKind !== undefined && res.data.kind !== opts.expectKind));
    if (res.ok && !foreign) {
      failures = 0;
      if (res.data.status !== 'pending') {
        return {
          kind: 'done',
          status: res.data.status,
          errorDetail: res.data.errorDetail,
          artifactId: res.data.artifactId,
        };
      }
    } else if (!res.ok && res.status === 404) {
      return { kind: 'not_found' };
    } else {
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) return { kind: 'unavailable' };
    }
    if (i < opts.maxPolls - 1) await sleep(opts.intervalMs, opts.signal);
  }
  return failures > 0 ? { kind: 'unavailable' } : { kind: 'timeout' };
}
