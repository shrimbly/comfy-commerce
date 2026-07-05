/**
 * Broker API client. All requests carry the web-client header so staged items
 * are attributed to the UI (headless callers omit it and read as 'api'). When
 * the broker is token-gated (BROKER_API_TOKEN), requests also carry the bearer
 * token — injected by the desktop shell, or entered once in the unlock screen
 * and kept in localStorage. A 401 broadcasts 'cc-unauthorized' on window so
 * the UnlockGate can (re-)prompt for the token.
 */

const TOKEN_KEY = 'cc-broker-token'

/** Broker bearer token — the desktop shell's injected token wins over the browser-stored one. */
export function getBrokerToken(): string | null {
  return window.comfyDesktop?.apiToken ?? localStorage.getItem(TOKEN_KEY)
}

export function setBrokerToken(token: string | null): void {
  if (token === null) localStorage.removeItem(TOKEN_KEY)
  else localStorage.setItem(TOKEN_KEY, token)
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getBrokerToken()
  const res = await fetch(path, {
    method,
    headers: {
      'x-comfy-commerce-client': 'web',
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const data = (await res.json()) as { error?: string }
      if (data.error) message = data.error
    } catch {
      /* non-JSON error body */
    }
    // The only 401 producers are the broker's token gate (and HMAC routes the
    // UI never calls), so 401 unambiguously means "locked" — tell the gate.
    if (res.status === 401) window.dispatchEvent(new CustomEvent('cc-unauthorized'))
    throw new ApiError(message, res.status)
  }
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}
