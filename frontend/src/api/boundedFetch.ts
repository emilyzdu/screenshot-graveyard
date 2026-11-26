/**
 * A `fetch` wrapper that gives every request an upper time bound and, optionally,
 * ties it to an outer AbortSignal (for example "this component unmounted").
 *
 * The bound covers the WHOLE exchange: headers and the complete response body.
 * The body is read here, inside the bound, and handed back as an already
 * buffered Response, so a server that sends headers and then stalls the body
 * cannot outlive the deadline or a cancellation. On timeout or outer abort the
 * request is aborted and the body reader is cancelled, so the API helpers in
 * `api/ai.ts` report it as a network failure (`status: 0`). The timer and the
 * outer-signal listener are always removed once the exchange settles.
 *
 * Aborting only stops the browser waiting. It never cancels work the server has
 * already accepted, so callers must treat an aborted POST as an unknown outcome.
 */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function abortError(): DOMException {
  return new DOMException('The request was aborted', 'AbortError');
}

/** Read the full body, cancelling the reader if `signal` aborts first. */
async function readBody(response: Response, signal: AbortSignal): Promise<Uint8Array | null> {
  const stream = response.body;
  if (!stream) return null;
  const reader = stream.getReader();
  const onAbort = () => {
    void reader.cancel(abortError()).catch(() => {});
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      if (signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortError();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function boundedFetch(timeoutMs: number, outer?: AbortSignal): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (outer?.aborted) controller.abort();
    else outer?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Settles as soon as the controller aborts, even if the transport ignores the signal.
    let rejectAborted!: (e: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    aborted.catch(() => {});
    const onAbort = () => rejectAborted(abortError());
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
    const request = fetch(input, { ...init, signal: controller.signal });
    try {
      const response = await Promise.race([request, aborted]);
      const body = await Promise.race([readBody(response, controller.signal), aborted]);
      // Opaque/odd statuses cannot be rebuilt; treat them like a failed request.
      if (response.status < 200 || response.status > 599) throw new TypeError('Unsupported response status');
      return new Response(NULL_BODY_STATUS.has(response.status) ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (e) {
      // Aborted before the headers arrived but the transport resolved anyway:
      // release that late body instead of leaving it open.
      if (controller.signal.aborted) {
        void request.then((r) => r.body?.cancel().catch(() => {}), () => {});
      }
      throw e;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  };
}
/**
 * Batch 6A D2: settle `work` within `timeoutMs` no matter how it is carried out.
 * `boundedFetch` bounds the transport; this also bounds whatever wraps it, so a
 * read that never settles still ends as a rejection the caller can retry. The
 * timer is always cleared once either side settles; a late answer is dropped.
 */
export function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(abortError()), timeoutMs);
  });
  work.catch(() => {}); // a late rejection after the deadline is not unhandled
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
