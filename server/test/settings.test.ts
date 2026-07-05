import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { loadEnv } from '../src/env.js'

const json = (res: { payload: string }) => JSON.parse(res.payload)

function baseEnv(tmpDir: string, overrides: Record<string, string | undefined> = {}) {
  process.env.LOG_LEVEL = 'silent'
  return loadEnv({
    DATA_DIR: tmpDir,
    PORT: '0',
    SHOPIFY_API_KEY: undefined as unknown as string,
    // Unreachable so availability resolves fast (connection refused, not a hang).
    COMFY_LOCAL_URL: 'http://127.0.0.1:1',
    COMFY_CLOUD_API_KEY: undefined as unknown as string,
    COMFY_REMOTE_URL: undefined as unknown as string,
    ...overrides,
  })
}

const findRemote = (res: { payload: string }) =>
  json(res).providers.find((p: { id: string }) => p.id === 'comfy-remote')

describe('app settings — Remote ComfyUI URL', () => {
  let app: FastifyInstance
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-settings-'))
    app = (await buildApp(baseEnv(tmpDir))).app
    await app.ready()
  })
  afterEach(async () => {
    await app.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('starts unconfigured', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' })
    expect(res.statusCode).toBe(200)
    expect(json(res).remoteComfyUrl).toBeNull()
  })

  it('saves a URL (trimming a trailing slash) and reads it back', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { remoteComfyUrl: 'http://windows-pc:8188/' },
    })
    expect(patch.statusCode).toBe(200)
    expect(json(patch).remoteComfyUrl).toBe('http://windows-pc:8188')
    const get = await app.inject({ method: 'GET', url: '/api/settings' })
    expect(json(get).remoteComfyUrl).toBe('http://windows-pc:8188')
  })

  it('lists comfy-remote as unconfigured until a URL is set', async () => {
    const before = findRemote(await app.inject({ method: 'GET', url: '/api/providers' }))
    expect(before).toMatchObject({ kind: 'remote', available: false })
    expect(before.detail).toMatch(/set a/i)

    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { remoteComfyUrl: 'http://127.0.0.1:1' },
    })
    const after = findRemote(await app.inject({ method: 'GET', url: '/api/providers' }))
    // Configured now — unreachable host, so not available, but no "set a URL" hint.
    expect(after.available).toBe(false)
    expect(after.detail).not.toMatch(/set a/i)
  })

  it('clears the URL with an empty string', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { remoteComfyUrl: 'http://x:8188' },
    })
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { remoteComfyUrl: '' },
    })
    expect(json(cleared).remoteComfyUrl).toBeNull()
  })

  it('rejects a non-URL value', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { remoteComfyUrl: 'not a url' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a non-http(s) URL scheme', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { remoteComfyUrl: 'ftp://host:8188' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('app settings — COMFY_REMOTE_URL seed', () => {
  it('seeds the URL from the env when the DB is empty', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-settings-seed-'))
    const app = (await buildApp(baseEnv(tmpDir, { COMFY_REMOTE_URL: 'http://seed:8188' }))).app
    await app.ready()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/settings' })
      expect(json(res).remoteComfyUrl).toBe('http://seed:8188')
    } finally {
      await app.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('app settings — Comfy Cloud API key', () => {
  let app: FastifyInstance
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-cloudkey-'))
    app = (await buildApp(baseEnv(tmpDir))).app
    await app.ready()
  })
  afterEach(async () => {
    await app.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('starts unconfigured', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' })
    expect(json(res).cloudApiKey).toEqual({ configured: false, source: null, masked: null })
  })

  it('saves a key (masked, never returned raw) and reports source=ui', async () => {
    const secret = 'comfyui-secret-ABCD1234'
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { cloudApiKey: secret },
    })
    expect(patch.statusCode).toBe(200)
    expect(json(patch).cloudApiKey).toEqual({ configured: true, source: 'ui', masked: '…1234' })
    // The raw secret must never appear in any response body.
    expect(patch.payload).not.toContain(secret)
    const get = await app.inject({ method: 'GET', url: '/api/settings' })
    expect(json(get).cloudApiKey.masked).toBe('…1234')
    expect(get.payload).not.toContain(secret)
  })

  it('clears the key with null or an empty string', async () => {
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { cloudApiKey: 'comfy-xyz9' } })
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { cloudApiKey: null },
    })
    expect(json(cleared).cloudApiKey.configured).toBe(false)
  })

  it('rejects a patch with no fields', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings', payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('lists comfy-cloud as unconfigured until a key is set', async () => {
    const findCloud = (res: { payload: string }) =>
      json(res).providers.find((p: { id: string }) => p.id === 'comfy-cloud')
    const before = findCloud(await app.inject({ method: 'GET', url: '/api/providers' }))
    expect(before).toMatchObject({ kind: 'cloud', available: false })
    expect(before.detail).toMatch(/sign in to comfy cloud or add an api key/i)
  })
})

describe('app settings — COMFY_CLOUD_API_KEY seed', () => {
  it('reports source=env, lets a UI value override, and falls back on clear', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-cloudseed-'))
    const app = (await buildApp(baseEnv(tmpDir, { COMFY_CLOUD_API_KEY: 'env-key-7777' }))).app
    await app.ready()
    try {
      const seeded = json(await app.inject({ method: 'GET', url: '/api/settings' }))
      expect(seeded.cloudApiKey).toEqual({ configured: true, source: 'env', masked: '…7777' })

      const overridden = json(
        await app.inject({
          method: 'PATCH',
          url: '/api/settings',
          payload: { cloudApiKey: 'ui-key-8888' },
        }),
      )
      expect(overridden.cloudApiKey).toEqual({ configured: true, source: 'ui', masked: '…8888' })

      const cleared = json(
        await app.inject({ method: 'PATCH', url: '/api/settings', payload: { cloudApiKey: '' } }),
      )
      expect(cleared.cloudApiKey).toEqual({ configured: true, source: 'env', masked: '…7777' })
    } finally {
      await app.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
