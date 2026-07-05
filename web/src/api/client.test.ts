import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, ApiError } from './client.js'

// The regression suite for deep-review finding #9: the original client never
// attached the broker bearer token, so setting BROKER_API_TOKEN bricked the
// studio. These tests pin the header contract and the 401 → 'cc-unauthorized'
// broadcast the UnlockGate relies on.

const okBody = { stores: [] }

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const fetchMock = vi.fn()

/** Headers of the first (and only) fetch call. */
function sentHeaders(): Record<string, string> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
  return (init?.headers ?? {}) as Record<string, string>
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(jsonResponse(200, okBody))
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  delete window.comfyDesktop
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('broker token header', () => {
  it('attaches the stored token as a bearer and keeps the web-client header', async () => {
    localStorage.setItem('cc-broker-token', 's3cret')
    await api.get('/api/stores')

    expect(fetchMock).toHaveBeenCalledWith('/api/stores', expect.anything())
    const headers = sentHeaders()
    expect(headers.authorization).toBe('Bearer s3cret')
    expect(headers['x-comfy-commerce-client']).toBe('web')
  })

  it('sends no authorization header when no token is stored (open-broker default unchanged)', async () => {
    await api.get('/api/stores')

    const headers = sentHeaders()
    expect('authorization' in headers).toBe(false)
    expect(headers['x-comfy-commerce-client']).toBe('web')
  })

  it('prefers the desktop-injected token over a conflicting stored one', async () => {
    localStorage.setItem('cc-broker-token', 'stale-browser-token')
    window.comfyDesktop = {
      isDesktop: true,
      electronVersion: '0.0.0',
      platform: 'darwin',
      apiToken: 'desktop-token',
    }
    await api.get('/api/stores')

    expect(sentHeaders().authorization).toBe('Bearer desktop-token')
  })
})

describe('401 handling', () => {
  it('dispatches cc-unauthorized and still rejects with ApiError(401)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized' }))
    const onUnauthorized = vi.fn()
    window.addEventListener('cc-unauthorized', onUnauthorized)
    try {
      const call = api.get('/api/stores')
      await expect(call).rejects.toBeInstanceOf(ApiError)
      await expect(call).rejects.toMatchObject({ status: 401, message: 'Unauthorized' })
      expect(onUnauthorized).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('cc-unauthorized', onUnauthorized)
    }
  })

  it('does not dispatch cc-unauthorized on other errors (500)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Internal error' }))
    const onUnauthorized = vi.fn()
    window.addEventListener('cc-unauthorized', onUnauthorized)
    try {
      await expect(api.get('/api/stores')).rejects.toMatchObject({ status: 500 })
      expect(onUnauthorized).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('cc-unauthorized', onUnauthorized)
    }
  })
})
