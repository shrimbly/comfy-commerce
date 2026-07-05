import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { loadEnv } from '../src/env.js'

const json = (res: { payload: string }) => JSON.parse(res.payload)

async function setup() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-enrich-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({ DATA_DIR: tmpDir, PORT: '0', SHOPIFY_API_KEY: undefined as unknown as string })
  const { app, ctx } = await buildApp(env)
  await app.ready()
  const connect = json(
    await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'demo' } }),
  )
  return { app, ctx, tmpDir, storeId: connect.store.id as string }
}

describe('catalog enrichment', () => {
  it('hydrates AI caption + tags onto catalog media; upsert replaces; disconnect clears', async () => {
    const { app, ctx, tmpDir, storeId } = await setup()
    try {
      const before = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
      const product = before.products[0]
      const media = product.media[0]
      expect(media.caption ?? null).toBeNull()

      ctx.enrichmentService.upsert({
        storeId,
        productId: product.id,
        mediaId: media.id,
        caption: 'A linen tee on a plain background.',
        tags: ['linen', 'tee', 'apparel'],
        model: 'Qwen2.5-VL-3B-Instruct',
      })

      const after = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
      const enriched = after.products
        .find((p: { id: string }) => p.id === product.id)
        .media.find((m: { id: string }) => m.id === media.id)
      expect(enriched.caption).toBe('A linen tee on a plain background.')
      expect(enriched.tags).toEqual(['linen', 'tee', 'apparel'])
      expect(enriched.enrichedAt).toBeTruthy()

      // Re-enriching the same image replaces, never duplicates (composite PK).
      ctx.enrichmentService.upsert({
        storeId,
        productId: product.id,
        mediaId: media.id,
        caption: 'Updated caption.',
        tags: ['updated'],
        model: 'm',
      })
      const rows = ctx.enrichmentService.listForStore(storeId)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.caption).toBe('Updated caption.')

      await app.inject({ method: 'DELETE', url: `/api/stores/${storeId}` })
      expect(ctx.enrichmentService.listForStore(storeId)).toHaveLength(0)
    } finally {
      await app.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
