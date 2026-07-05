import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildAuthorizeUrl,
  clearEndpointsCache,
  exchangeCode,
  generatePkce,
  OAuthGrantError,
  refreshTokens,
  registerClient,
  resolveEndpoints,
} from '../src/connectors/comfy/oauth.js'

const ISSUER = 'https://cloud.example.test'

/** Stub global fetch with a handler over (url, init) → Response. */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: unknown) =>
      handler(String(input), init as RequestInit | undefined),
    ),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearEndpointsCache()
})

describe('resolveEndpoints', () => {
  it('reads endpoints from the discovery document', async () => {
    stubFetch((url) => {
      expect(url).toBe(`${ISSUER}/.well-known/oauth-authorization-server`)
      return Response.json({
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        registration_endpoint: `${ISSUER}/oauth/register`,
      })
    })
    const ep = await resolveEndpoints(ISSUER)
    expect(ep.tokenEndpoint).toBe(`${ISSUER}/oauth/token`)
    expect(ep.registrationEndpoint).toBe(`${ISSUER}/oauth/register`)
  })

  it('falls back to conventional paths when discovery is unreachable', async () => {
    stubFetch(() => {
      throw new Error('network down')
    })
    const ep = await resolveEndpoints(ISSUER)
    expect(ep).toEqual({
      authorizationEndpoint: `${ISSUER}/oauth/authorize`,
      tokenEndpoint: `${ISSUER}/oauth/token`,
      registrationEndpoint: `${ISSUER}/oauth/register`,
    })
  })

  it('caches a successful discovery result', async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({ token_endpoint: `${ISSUER}/oauth/token` }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    await resolveEndpoints(ISSUER)
    await resolveEndpoints(ISSUER)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('registerClient', () => {
  it('registers a native client for a loopback redirect and returns the id', async () => {
    let sentBody: Record<string, unknown> = {}
    stubFetch((url, init) => {
      expect(url).toBe(`${ISSUER}/oauth/register`)
      sentBody = JSON.parse(String(init?.body))
      return Response.json({ client_id: 'comfy-dyn-abc' })
    })
    const clientId = await registerClient({
      registrationEndpoint: `${ISSUER}/oauth/register`,
      redirectUri: 'http://localhost:4000/api/connect/comfy/callback',
      scopes: ['comfy-cloud:jobs:read'],
    })
    expect(clientId).toBe('comfy-dyn-abc')
    expect(sentBody.application_type).toBe('native')
    expect(sentBody.token_endpoint_auth_method).toBe('none')
    expect(sentBody.scope).toBe('comfy-cloud:jobs:read')
  })

  it('registers a web client for an https redirect', async () => {
    let sentBody: Record<string, unknown> = {}
    stubFetch((_url, init) => {
      sentBody = JSON.parse(String(init?.body))
      return Response.json({ client_id: 'comfy-dyn-web' })
    })
    await registerClient({
      registrationEndpoint: `${ISSUER}/oauth/register`,
      redirectUri: 'https://app.example.com/callback',
      scopes: [],
    })
    expect(sentBody.application_type).toBe('web')
  })

  it('surfaces the server error on failure', async () => {
    stubFetch(() => Response.json({ error: 'invalid_client_metadata' }, { status: 400 }))
    await expect(
      registerClient({
        registrationEndpoint: `${ISSUER}/oauth/register`,
        redirectUri: 'http://localhost:4000/cb',
        scopes: [],
      }),
    ).rejects.toThrow(/invalid_client_metadata/)
  })
})

describe('buildAuthorizeUrl', () => {
  it('includes PKCE, resource, and scope', () => {
    const { challenge } = generatePkce()
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: `${ISSUER}/oauth/authorize`,
        clientId: 'comfy-dyn-abc',
        redirectUri: 'http://localhost:4000/cb',
        state: 'state123',
        challenge,
        resource: `${ISSUER}/api`,
        scopes: ['comfy-cloud:jobs:read', 'comfy-cloud:jobs:write'],
      }),
    )
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(challenge)
    expect(url.searchParams.get('resource')).toBe(`${ISSUER}/api`)
    expect(url.searchParams.get('scope')).toBe('comfy-cloud:jobs:read comfy-cloud:jobs:write')
  })
})

describe('generatePkce', () => {
  it('produces a url-safe verifier and a matching S256 challenge', async () => {
    const { verifier, challenge } = generatePkce()
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/)
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/)
    // Distinct from the verifier (it's a hash, not the raw value).
    expect(challenge).not.toBe(verifier)
  })
})

describe('exchangeCode / refreshTokens', () => {
  it('exchanges a code and makes expiry absolute', async () => {
    const before = Date.now()
    stubFetch((url, init) => {
      expect(url).toBe(`${ISSUER}/oauth/token`)
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code_verifier')).toBe('verifier-xyz')
      return Response.json({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: 'comfy-cloud:jobs:read',
      })
    })
    const tokens = await exchangeCode({
      tokenEndpoint: `${ISSUER}/oauth/token`,
      clientId: 'comfy-dyn-abc',
      redirectUri: 'http://localhost:4000/cb',
      code: 'the-code',
      verifier: 'verifier-xyz',
    })
    expect(tokens.accessToken).toBe('access-1')
    expect(tokens.refreshToken).toBe('refresh-1')
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000)
  })

  it('rotates a refresh token', async () => {
    stubFetch((_url, init) => {
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('refresh_token')).toBe('old-refresh')
      return Response.json({ access_token: 'access-2', refresh_token: 'new-refresh', expires_in: 3600 })
    })
    const tokens = await refreshTokens({
      tokenEndpoint: `${ISSUER}/oauth/token`,
      clientId: 'comfy-dyn-abc',
      refreshToken: 'old-refresh',
    })
    expect(tokens.accessToken).toBe('access-2')
    expect(tokens.refreshToken).toBe('new-refresh')
  })

  it('throws OAuthGrantError on invalid_grant (dead grant)', async () => {
    stubFetch(() =>
      Response.json({ error: 'invalid_grant', error_description: 'token reuse' }, { status: 400 }),
    )
    await expect(
      refreshTokens({
        tokenEndpoint: `${ISSUER}/oauth/token`,
        clientId: 'comfy-dyn-abc',
        refreshToken: 'reused',
      }),
    ).rejects.toBeInstanceOf(OAuthGrantError)
  })

  it('throws a plain error on other token failures', async () => {
    stubFetch(() => Response.json({ error: 'server_error' }, { status: 500 }))
    await expect(
      exchangeCode({
        tokenEndpoint: `${ISSUER}/oauth/token`,
        clientId: 'comfy-dyn-abc',
        redirectUri: 'http://localhost:4000/cb',
        code: 'x',
        verifier: 'y',
      }),
    ).rejects.toThrow(/server_error/)
  })
})
