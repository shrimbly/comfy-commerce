import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { loadEnv } from '../src/env.js'

const json = (res: { payload: string }) => JSON.parse(res.payload)

function baseEnv(tmpDir: string, overrides: Record<string, string | undefined> = {}) {
  process.env.LOG_LEVEL = 'silent'
  return loadEnv({
    DATA_DIR: tmpDir,
    PORT: '0',
    SHOPIFY_API_KEY: undefined as unknown as string,
    COMFY_LOCAL_URL: 'http://127.0.0.1:1',
    COMFY_CLOUD_API_KEY: undefined as unknown as string,
    ...overrides,
  })
}

describe('GET /api/status', () => {
  let app: FastifyInstance
  let tmpDir: string
  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-status-'))
    app = (await buildApp(baseEnv(tmpDir))).app
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports db health, providers, store count, mode, and version', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' })
    expect(res.statusCode).toBe(200)
    const body = json(res)
    expect(body.db.ok).toBe(true)
    expect(Array.isArray(body.providers)).toBe(true)
    expect(typeof body.stores).toBe('number')
    expect(body.shopifyMode).toBe('mock')
    expect(typeof body.version).toBe('string')
    expect(body.version.length).toBeGreaterThan(0)
  })

  it('health reports authRequired: false when no token is configured (open-by-default contract)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(json(res).authRequired).toBe(false)
  })
})

describe('optional API auth (BROKER_API_TOKEN)', () => {
  let app: FastifyInstance
  let tmpDir: string
  const auth = { authorization: 'Bearer s3cret' }
  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-auth-'))
    app = (await buildApp(baseEnv(tmpDir, { BROKER_API_TOKEN: 's3cret' }))).app
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('leaves liveness open and advertises authRequired for the unlock screen', async () => {
    // No Authorization header — the studio must be able to discover the gate pre-auth.
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(json(res).authRequired).toBe(true)
  })

  it('401s a protected route without a token, 200s with it', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url: '/api/status', headers: auth })).statusCode,
    ).toBe(200)
  })

  it('accepts a bearer GET /api/stores — the unlock dialog validates candidates on this route', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/stores' })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url: '/api/stores', headers: auth })).statusCode,
    ).toBe(200)
  })

  it('401s a mutating route without a token, succeeds with it', async () => {
    const noToken = await app.inject({
      method: 'POST',
      url: '/api/connect/shopify',
      payload: { shop: 'demo' },
    })
    expect(noToken.statusCode).toBe(401)
    const withToken = await app.inject({
      method: 'POST',
      url: '/api/connect/shopify',
      headers: auth,
      payload: { shop: 'demo' },
    })
    expect(withToken.statusCode).toBe(200)
  })

  it('rejects a wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { authorization: 'Bearer nope' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('exempts the HMAC-authed webhook route from the broker token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/shopify', payload: {} })
    expect(res.statusCode).not.toBe(401) // 404 in mock mode — but never 401
  })

  it('exempts read-only asset GETs — headerless <img>/<video> sources cannot send the bearer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/assets/does-not-exist' })
    expect(res.statusCode).not.toBe(401) // 404, not 401
  })
})

describe('Host validation (DNS-rebinding guard)', () => {
  let app: FastifyInstance
  let tmpDir: string
  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-host-'))
    // A non-loopback APP_URL exercises the configured-host allowance distinctly
    // from the always-allowed loopback names.
    app = (await buildApp(baseEnv(tmpDir, { APP_URL: 'https://studio.example.com' }))).app
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const health = (host: string) =>
    app.inject({ method: 'GET', url: '/api/health', headers: { host } })

  it('403s a rebound Host that is neither loopback nor the configured origin', async () => {
    const res = await health('attacker.example:4000')
    expect(res.statusCode).toBe(403)
    expect(json(res).error).toBe('Forbidden host')
  })

  it('allows loopback hostnames on any port', async () => {
    expect((await health('localhost:9999')).statusCode).toBe(200)
    expect((await health('127.0.0.1:4000')).statusCode).toBe(200)
  })

  it('allows the APP_URL host', async () => {
    expect((await health('studio.example.com')).statusCode).toBe(200)
  })

  it('403s an unparseable Host header', async () => {
    expect((await health('not a host')).statusCode).toBe(403)
  })

  // The untouched suites above inject without a host header (fastify defaults
  // to localhost:80) — their staying green pins the loopback allowance.
})
