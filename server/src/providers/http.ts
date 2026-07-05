/**
 * Resilient HTTP for engine providers.
 *
 * Two failure modes plague long-running cloud calls and neither is handled by
 * a bare `fetch`: a request that hangs forever (no timeout) stalls the whole
 * run and holds its concurrency slot; a momentary network blip or 5xx throws
 * away progress. `resilientFetch` adds a per-request timeout (combined with the
 * caller's cancellation signal) and optional retries on transient failures.
 *
 * The response body is buffered here, inside the armed timeout/abort window:
 * undici's fetch resolves at headers, so a stalled or trickling body would
 * otherwise escape both the timeout and the caller's Cancel (finding #34).
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Transient HTTP statuses worth retrying (rate limit, gateway, overloaded). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/** Statuses whose Response must be constructed with a null body. */
const NO_BODY_STATUS = new Set([204, 205, 304])

export interface ResilientFetchOptions extends Omit<RequestInit, 'signal'> {
  /** Abort after this many ms — bounds headers AND body (combined with any caller signal). */
  timeoutMs?: number
  /** Extra attempts on transient network errors / retryable statuses (0 = none). */
  retries?: number
  /** Base backoff between attempts, in ms (grows exponentially). */
  retryBaseMs?: number
  /** Caller's cancellation signal (e.g. the run abort). */
  signal?: AbortSignal | undefined
}

/**
 * `fetch` with a timeout, caller-cancellation, and bounded retries. Resolves
 * with a fully-buffered Response (body methods never touch the network). A
 * timeout surfaces as a plain (retryable) Error — never an AbortError — so
 * callers and the run-level retry don't mistake it for a user cancellation.
 */
export async function resilientFetch(
  url: string | URL,
  { timeoutMs = 30_000, retries = 0, retryBaseMs = 400, signal, ...init }: ResilientFetchOptions = {},
): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        await sleep(retryBaseMs * 2 ** attempt)
        continue
      }
      // Consume the body before the finally disarms the timer / abort
      // forwarding — the timeout must bound the whole transfer, and Cancel
      // must be able to kill a body read, not just time-to-headers.
      const bytes = await res.arrayBuffer()
      return new Response(NO_BODY_STATUS.has(res.status) ? null : bytes, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    } catch (err) {
      if (signal?.aborted) {
        // Genuine caller cancellation — normalize so callers always see an
        // AbortError (undici reports mid-body aborts inconsistently).
        throw err instanceof Error && err.name === 'AbortError'
          ? err
          : new DOMException('Aborted', 'AbortError')
      }
      // Our own timeout fired (controller aborted, caller didn't) → a clean,
      // retryable timeout rather than an AbortError.
      lastErr = controller.signal.aborted
        ? new Error(`Request to ${url} timed out after ${timeoutMs}ms`)
        : err
      if (attempt < retries) {
        await sleep(retryBaseMs * 2 ** attempt)
        continue
      }
      throw lastErr
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
