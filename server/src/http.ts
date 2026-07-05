/**
 * `fetch` with a hard deadline and NO retries — for calls that must never be
 * silently re-sent. Engine providers get retrying transport via
 * `providers/http.ts` (`resilientFetch`); this helper covers the
 * non-idempotent rest: Shopify GraphQL (mutations like productCreateMedia —
 * the publish pipeline's crash-safe resume assumes a single create call),
 * token exchanges, and staged uploads.
 *
 * The body is buffered under the same deadline: undici's fetch resolves at
 * headers, so without buffering a stalled or trickling body would hang the
 * caller's `json()`/`text()` forever. A timeout surfaces as a plain,
 * descriptive Error (never an AbortError/TimeoutError DOMException).
 */

/** Statuses whose Response must be constructed with a null body. */
const NO_BODY_STATUS = new Set([204, 205, 304])

export async function fetchWithTimeout(
  url: string | URL,
  { timeoutMs, ...init }: Omit<RequestInit, 'signal'> & { timeoutMs: number },
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: timeout })
    const bytes = await res.arrayBuffer()
    return new Response(NO_BODY_STATUS.has(res.status) ? null : bytes, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  } catch (err) {
    if (timeout.aborted) {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`)
    }
    throw err
  }
}
