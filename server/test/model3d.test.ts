import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { loadEnv } from '../src/env.js'

let app: FastifyInstance
let tmpDir: string

const json = (res: { payload: string }) => JSON.parse(res.payload)

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-model3d-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({ DATA_DIR: tmpDir, PORT: '0' })
  ;({ app } = await buildApp(env))
  await app.ready()
})

afterAll(async () => {
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('model3d media type', () => {
  it('stages, publishes as featured, and reverts a 3D (GLB) result', async () => {
    const { store } = json(
      await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'model3d-demo' } }),
    )
    await app.inject({
      method: 'PATCH',
      url: `/api/stores/${store.id}/scope`,
      payload: { collectionIds: 'all', tags: [], productStatus: 'active', mediaRole: 'all' },
    })
    const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const product = catalog.products[0]
    const before = product.media.length

    // Stage a 3D result directly — the Zod schema must accept 'model3d'.
    const staged = json(
      await app.inject({
        method: 'POST',
        url: '/api/staging',
        payload: {
          storeId: store.id,
          items: [
            {
              productId: product.id,
              mediaId: product.media[0].id,
              afterUrl: '/api/assets/scene.glb',
              action: 'add-featured',
              mediaType: 'model3d',
            },
          ],
        },
      }),
    )
    const item = staged.items[0]
    expect(item.mediaType).toBe('model3d')

    await app.inject({ method: 'POST', url: '/api/staging/approve', payload: { ids: [item.id] } })
    const publish = json(
      await app.inject({ method: 'POST', url: '/api/staging/publish', payload: { ids: [item.id] } }),
    )
    expect(publish.results[0].ok).toBe(true)
    expect(publish.results[0].state).toBe('published')

    const after = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const afterProduct = after.products.find((p: { id: string }) => p.id === product.id)
    expect(afterProduct.media.length).toBe(before + 1)
    expect(afterProduct.media[0].url).toContain('scene.glb')
    // The published media carries its type through the catalog (MediaItem.mediaType).
    expect(afterProduct.media[0].mediaType).toBe('model3d')

    // Revert deletes the added 3D media (add-featured is non-destructive).
    const revert = json(
      await app.inject({ method: 'POST', url: '/api/staging/revert', payload: { ids: [item.id] } }),
    )
    expect(revert.results[0].ok).toBe(true)
    const final = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const finalProduct = final.products.find((p: { id: string }) => p.id === product.id)
    expect(finalProduct.media.length).toBe(before)
  })
})
