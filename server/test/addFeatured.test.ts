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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-addfeatured-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({ DATA_DIR: tmpDir, PORT: '0' })
  ;({ app } = await buildApp(env))
  await app.ready()
})

afterAll(async () => {
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('add-featured stage action', () => {
  it('publishes the result into the featured slot, keeps the prior, and reverts cleanly', async () => {
    const { store } = json(
      await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'addfeatured-demo' } }),
    )
    // Widen scope so catalog media reflects the full product, not just featured.
    await app.inject({
      method: 'PATCH',
      url: `/api/stores/${store.id}/scope`,
      payload: { collectionIds: 'all', tags: [], productStatus: 'active', mediaRole: 'all' },
    })
    const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const product = catalog.products[0]
    const before = product.media.length
    const priorFeaturedUrl = product.media[0].url

    const { run } = json(
      await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          storeId: store.id,
          workflowId: 'builtin:fit-to-768px',
          providerId: 'mock',
          params: {},
          target: { kind: 'selection', inputs: [{ productId: product.id, mediaId: product.media[0].id }] },
          stageAction: 'add-featured',
        },
      }),
    )
    for (let i = 0; i < 100; i++) {
      const { run: fresh } = json(await app.inject({ method: 'GET', url: `/api/runs/${run.id}` }))
      if (fresh.state === 'completed') break
      await new Promise((r) => setTimeout(r, 100))
    }

    const staged = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${store.id}` }))
    const item = staged.items[0]
    expect(item.action).toBe('add-featured')

    await app.inject({ method: 'POST', url: '/api/staging/approve', payload: { ids: [item.id] } })
    expect(
      json(await app.inject({ method: 'POST', url: '/api/staging/publish', payload: { ids: [item.id] } }))
        .results[0].ok,
    ).toBe(true)

    const after = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const afterProduct = after.products.find((p: { id: string }) => p.id === product.id)
    // Non-destructive: one more media than before, the result is now featured,
    // and the prior featured is kept — shifted to second position.
    expect(afterProduct.media.length).toBe(before + 1)
    expect(afterProduct.media[0].url).not.toBe(priorFeaturedUrl)
    expect(afterProduct.media[1].url).toBe(priorFeaturedUrl)

    // Revert removes the added result; the prior featured returns to the top.
    expect(
      json(await app.inject({ method: 'POST', url: '/api/staging/revert', payload: { ids: [item.id] } }))
        .results[0].ok,
    ).toBe(true)
    const final = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const finalProduct = final.products.find((p: { id: string }) => p.id === product.id)
    expect(finalProduct.media.length).toBe(before)
    expect(finalProduct.media[0].url).toBe(priorFeaturedUrl)
  })
})
