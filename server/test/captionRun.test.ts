import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { loadEnv } from '../src/env.js'
import { CAPTION_MODEL, parseCaption } from '../src/workflows/caption.js'

const json = (res: { payload: string }) => JSON.parse(res.payload)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

async function setup() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-cap-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({ DATA_DIR: tmpDir, PORT: '0', SHOPIFY_API_KEY: undefined as unknown as string })
  const { app, ctx } = await buildApp(env)
  await app.ready()
  const connect = json(
    await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'demo' } }),
  )
  return { app, ctx, tmpDir, storeId: connect.store.id as string }
}

describe('parseCaption', () => {
  it('splits a caption from a TAGS line and normalizes (lowercase, dedupe)', () => {
    const { caption, tags } = parseCaption('A red linen shirt on a hanger.\nTAGS: Red, Linen, shirt, red')
    expect(caption).toBe('A red linen shirt on a hanger.')
    expect(tags).toEqual(['red', 'linen', 'shirt'])
  })

  it('keeps the whole text as the caption when there is no TAGS line', () => {
    expect(parseCaption('Just a description.')).toEqual({ caption: 'Just a description.', tags: [] })
  })

  it('splits a markerless "description \\n comma-keywords" (Gemini) response', () => {
    const { caption, tags } = parseCaption(
      'A classic navy crew neck t-shirt, offering comfort and style.\n' +
        'navy t-shirt, crew neck, plain tee, cotton, casual, Everyday.',
    )
    expect(caption).toBe('A classic navy crew neck t-shirt, offering comfort and style.')
    expect(tags).toEqual(['navy t-shirt', 'crew neck', 'plain tee', 'cotton', 'casual', 'everyday'])
  })
})

describe('caption (enrichment) run', () => {
  it('captions an image via the mock engine and writes caption + tags to the catalog, not staging', async () => {
    const { app, ctx, tmpDir, storeId } = await setup()
    let runId = ''
    try {
      const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
      const product = catalog.products[0]
      const media = product.media[0]

      const created = json(
        await app.inject({
          method: 'POST',
          url: '/api/runs',
          payload: {
            storeId,
            workflowId: 'builtin:caption',
            providerId: 'mock',
            target: { kind: 'selection', inputs: [{ productId: product.id, mediaId: media.id }] },
          },
        }),
      )
      runId = created.run.id
      for (let i = 0; i < 100 && !TERMINAL.has(ctx.runService.get(runId)?.state ?? ''); i++) {
        await sleep(100)
      }
      expect(ctx.runService.get(runId)?.state).toBe('completed')

      // Enrichment bypasses the review gate — nothing is staged.
      const staging = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${storeId}` }))
      expect(staging.items).toHaveLength(0)

      const rows = ctx.enrichmentService.listForStore(storeId)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.caption).toContain('studio product photo')
      expect(rows[0]!.tags).toContain('product')
      expect(rows[0]!.model).toBe(CAPTION_MODEL)

      // The catalog now hydrates that image with its caption + tags.
      const after = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
      const enriched = after.products
        .find((p: { id: string }) => p.id === product.id)
        .media.find((m: { id: string }) => m.id === media.id)
      expect(enriched.caption).toContain('studio product photo')
      expect(enriched.tags).toContain('studio')
      expect(enriched.enrichedAt).toBeTruthy()

      // Editing tags in the inspector persists and re-hydrates the catalog.
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/stores/${storeId}/enrichment/tags`,
        payload: { productId: product.id, mediaId: media.id, tags: ['studio'] },
      })
      expect(patched.statusCode).toBe(200)
      const refreshed = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
      const reEnriched = refreshed.products
        .find((p: { id: string }) => p.id === product.id)
        .media.find((m: { id: string }) => m.id === media.id)
      expect(reEnriched.tags).toEqual(['studio'])
      expect(reEnriched.caption).toContain('studio product photo') // caption untouched
    } finally {
      for (let i = 0; i < 30 && !TERMINAL.has(ctx.runService.get(runId)?.state ?? ''); i++) await sleep(100)
      await app.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }, 30_000)
})
