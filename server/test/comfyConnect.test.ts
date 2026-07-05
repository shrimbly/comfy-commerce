import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildApp, type BuildAppResult } from '../src/app.js'
import { loadEnv } from '../src/env.js'

const ISSUER = 'https://cloud.test'
const APP_URL = 'http://localhost:4999'
const REDIRECT = `${APP_URL}/api/connect/comfy/callback`

let app: FastifyInstance
let ctx: BuildAppResult['ctx']
let tmpDir: string

const json = (res: { payload: string }) => JSON.parse(res.payload)

/**
 * A complete stub of the Comfy Cloud OAuth + API surface. Preflight (the
 * authorize GET) 302s to a login page for an allowed resource, or back to our
 * callback with ?error= for a denied one — mirroring the real server.
 */
function stubCloud(opts: { denyApiResource?: boolean; apiProbeStatus?: number } = {}) {
  const seen = { registers: 0, tokenGrants: 0, resourcesPreflighted: [] as string[] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          authorization_endpoint: `${ISSUER}/oauth/authorize`,
          token_endpoint: `${ISSUER}/oauth/token`,
          registration_endpoint: `${ISSUER}/oauth/register`,
        })
      }
      if (url === `${ISSUER}/oauth/register`) {
        seen.registers += 1
        return Response.json({ client_id: 'comfy-dyn-test' })
      }
      if (url.startsWith(`${ISSUER}/oauth/authorize`)) {
        const resource = new URL(url).searchParams.get('resource') ?? ''
        seen.resourcesPreflighted.push(resource)
        if (opts.denyApiResource && resource.endsWith('/api')) {
          return new Response(null, {
            status: 302,
            headers: { location: `${REDIRECT}?error=invalid_scope&error_description=nope&state=x` },
          })
        }
        return new Response(null, {
          status: 302,
          headers: { location: `${ISSUER}/cloud/login?oauth_request_id=abc` },
        })
      }
      if (url === `${ISSUER}/oauth/token`) {
        seen.tokenGrants += 1
        return Response.json({
          access_token: 'acc-1',
          refresh_token: 'ref-1',
          expires_in: 3600,
          scope: 'comfy-cloud:jobs:read',
        })
      }
      if (url.startsWith(`${ISSUER}/api/queue`)) {
        return new Response('{}', { status: opts.apiProbeStatus ?? 200 })
      }
      if (url.startsWith(`${ISSUER}/api/customers/me`)) {
        return Response.json({ email: 'user@example.com', subscription_tier: 'PRO' })
      }
      throw new Error(`unexpected fetch in test: ${url}`)
    }),
  )
  return seen
}

/** Pull the ?state= the broker embedded in the authorize URL it returned. */
function stateFrom(url: string): string {
  return new URL(url).searchParams.get('state') ?? ''
}

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-comfyconnect-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({
    DATA_DIR: tmpDir,
    PORT: '0',
    APP_URL,
    COMFY_CLOUD_API_URL: ISSUER,
    SHOPIFY_API_KEY: undefined as unknown as string,
    COMFY_LOCAL_URL: 'http://127.0.0.1:1',
    COMFY_CLOUD_API_KEY: undefined as unknown as string,
  })
  ;({ app, ctx } = await buildApp(env))
  await app.ready()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('Comfy Cloud sign-in', () => {
  it('begins the flow: self-registers a client and returns an authorize URL', async () => {
    const seen = stubCloud()
    const res = await app.inject({ method: 'POST', url: '/api/connect/comfy' })
    expect(res.statusCode).toBe(200)
    const url = new URL(json(res).url)
    expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth/authorize`)
    expect(url.searchParams.get('client_id')).toBe('comfy-dyn-test')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT)
    // The /api resource is requested first (it's the one that grants REST access).
    expect(url.searchParams.get('resource')).toBe(`${ISSUER}/api`)
    expect(seen.registers).toBe(1)
  })

  it('completes the callback: stores the grant and reports API access', async () => {
    stubCloud()
    const begin = json(await app.inject({ method: 'POST', url: '/api/connect/comfy' }))
    const state = stateFrom(begin.url)

    const cb = await app.inject({
      method: 'GET',
      url: `/api/connect/comfy/callback?code=the-code&state=${state}`,
    })
    expect(cb.statusCode).toBe(302)
    expect(cb.headers.location).toContain('/connectors?connected=')

    const settings = json(await app.inject({ method: 'GET', url: '/api/settings' }))
    expect(settings.cloudOauth).toEqual({
      connected: true,
      apiAccess: true,
      email: 'user@example.com',
    })
    // The raw token must never leak into the settings view.
    expect(settings.cloudOauth.accessToken).toBeUndefined()
  })

  it('makes the cloud engine available once signed in (no API key)', async () => {
    stubCloud()
    const begin = json(await app.inject({ method: 'POST', url: '/api/connect/comfy' }))
    await app.inject({
      method: 'GET',
      url: `/api/connect/comfy/callback?code=c&state=${stateFrom(begin.url)}`,
    })
    const providers = json(await app.inject({ method: 'GET', url: '/api/providers' }))
    const cloud = providers.providers.find((p: { id: string }) => p.id === 'comfy-cloud')
    expect(cloud.available).toBe(true)
  })

  it('falls back to the MCP resource when /api is not granted to the client', async () => {
    const seen = stubCloud({ denyApiResource: true })
    const begin = json(await app.inject({ method: 'POST', url: '/api/connect/comfy' }))
    expect(seen.resourcesPreflighted).toEqual([`${ISSUER}/api`, `${ISSUER}/mcp`])
    expect(new URL(begin.url).searchParams.get('resource')).toBe(`${ISSUER}/mcp`)
  })

  it('records apiAccess=false when the grant is rejected by the REST API', async () => {
    stubCloud({ apiProbeStatus: 403 })
    const begin = json(await app.inject({ method: 'POST', url: '/api/connect/comfy' }))
    await app.inject({
      method: 'GET',
      url: `/api/connect/comfy/callback?code=c&state=${stateFrom(begin.url)}`,
    })
    const settings = json(await app.inject({ method: 'GET', url: '/api/settings' }))
    expect(settings.cloudOauth.connected).toBe(true)
    expect(settings.cloudOauth.apiAccess).toBe(false)
  })

  it('rejects a callback whose state was never issued', async () => {
    stubCloud()
    await app.inject({ method: 'POST', url: '/api/connect/comfy' })
    const cb = await app.inject({
      method: 'GET',
      url: '/api/connect/comfy/callback?code=c&state=forged',
    })
    expect(cb.statusCode).toBe(302)
    expect(cb.headers.location).toContain('/connectors?error=')
    const settings = json(await app.inject({ method: 'GET', url: '/api/settings' }))
    expect(settings.cloudOauth.connected).toBe(false)
  })

  it('disconnects: forgets the grant', async () => {
    stubCloud()
    const begin = json(await app.inject({ method: 'POST', url: '/api/connect/comfy' }))
    await app.inject({
      method: 'GET',
      url: `/api/connect/comfy/callback?code=c&state=${stateFrom(begin.url)}`,
    })
    expect(json(await app.inject({ method: 'GET', url: '/api/settings' })).cloudOauth.connected).toBe(
      true,
    )

    const del = await app.inject({ method: 'DELETE', url: '/api/connect/comfy' })
    expect(del.statusCode).toBe(200)
    expect(json(await app.inject({ method: 'GET', url: '/api/settings' })).cloudOauth.connected).toBe(
      false,
    )
  })

  it('keeps the OAuth grant usable alongside a saved API key', async () => {
    stubCloud()
    // Save an API key too, so both credentials are present. resolveCloudAuth
    // then prefers the Bearer (grant has API access) while the key remains for
    // API-node billing.
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { cloudApiKey: 'comfyui-fallback-key' },
    })
    const begin = json(await app.inject({ method: 'POST', url: '/api/connect/comfy' }))
    await app.inject({
      method: 'GET',
      url: `/api/connect/comfy/callback?code=c&state=${stateFrom(begin.url)}`,
    })
    const token = await ctx.comfyAuth.getAccessToken()
    expect(token).toMatchObject({ accessToken: 'acc-1', apiAccess: true })
    expect(json(await app.inject({ method: 'GET', url: '/api/settings' })).cloudApiKey.configured).toBe(
      true,
    )
  })
})
