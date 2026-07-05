import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import type { AppContext } from '../src/context.js'
import { loadEnv } from '../src/env.js'

const json = (res: { payload: string }) => JSON.parse(res.payload)

// 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const SVG_BASE64 = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
).toString('base64')

function baseEnv(tmpDir: string) {
  process.env.LOG_LEVEL = 'silent'
  return loadEnv({
    DATA_DIR: tmpDir,
    PORT: '0',
    SHOPIFY_API_KEY: undefined as unknown as string,
    COMFY_LOCAL_URL: 'http://127.0.0.1:1',
    COMFY_CLOUD_API_KEY: undefined as unknown as string,
  })
}

describe('asset upload + serving security', () => {
  let app: FastifyInstance
  let ctx: AppContext
  let tmpDir: string
  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-assets-'))
    const built = await buildApp(baseEnv(tmpDir))
    app = built.app
    ctx = built.ctx
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const upload = (contentType: string, data: string) =>
    app.inject({ method: 'POST', url: '/api/assets', payload: { contentType, data } })

  it('accepts a benign PNG upload', async () => {
    const res = await upload('image/png', PNG_BASE64)
    expect(res.statusCode).toBe(201)
    const body = json(res)
    expect(typeof body.id).toBe('string')
    expect(body.url).toBe(`/api/assets/${body.id}`)
  })

  it('rejects image/svg+xml with a clear 4xx — stored SVG would be same-origin XSS', async () => {
    const res = await upload('image/svg+xml', SVG_BASE64)
    expect(res.statusCode).toBe(415)
    expect(json(res).error).toMatch(/SVG/i)
  })

  it('rejects SVG regardless of MIME parameters or casing', async () => {
    expect((await upload('image/svg+xml; charset=utf-8', SVG_BASE64)).statusCode).toBe(415)
    expect((await upload('image/SVG+xml', SVG_BASE64)).statusCode).toBe(415)
  })

  it('serves stored assets with defense-in-depth headers and the accurate Content-Type', async () => {
    const { id } = json(await upload('image/png', PNG_BASE64))
    const res = await app.inject({ method: 'GET', url: `/api/assets/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-disposition']).toMatch(/^attachment/)
    // Bytes round-trip untouched — embedding via <img> keeps working.
    expect(res.rawPayload.equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true)
  })

  it('applies the same headers to the auto-exposed HEAD route', async () => {
    const { id } = json(await upload('image/png', PNG_BASE64))
    const res = await app.inject({ method: 'HEAD', url: `/api/assets/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-disposition']).toMatch(/^attachment/)
  })

  it('keeps video assets (provider-custody path) serving with their stored Content-Type', async () => {
    // Provider outputs bypass the upload route; nosniff requires the stored
    // contentType to be accurate for <video> embedding to keep working.
    const saved = await ctx.assetStore.save(Buffer.from('not-a-real-mp4'), 'video/mp4')
    const res = await app.inject({ method: 'GET', url: saved.url })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('video/mp4')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
})
