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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-addnew-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({ DATA_DIR: tmpDir, PORT: '0' })
  ;({ app } = await buildApp(env))
  await app.ready()
})

afterAll(async () => {
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('add-new stage action', () => {
  it('publishes by appending media and reverts by removing it', async () => {
    const { store } = json(
      await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'addnew-demo' } }),
    )
    // Widen scope so catalog media counts reflect the full product.
    await app.inject({
      method: 'PATCH',
      url: `/api/stores/${store.id}/scope`,
      payload: { collectionIds: 'all', tags: [], productStatus: 'active', mediaRole: 'all' },
    })
    const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const product = catalog.products[0]
    const before = product.media.length

    const { run } = json(
      await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          storeId: store.id,
          workflowId: 'builtin:fit-to-768px',
          providerId: 'mock',
          params: {},
          target: {
            kind: 'selection',
            inputs: [{ productId: product.id, mediaId: product.media[0].id }],
          },
          stageAction: 'add-new',
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
    expect(item.action).toBe('add-new')
    expect(item.mediaType).toBe('image')
    expect(item.state).toBe('pending')

    // Gate still applies to additions.
    const refused = json(
      await app.inject({ method: 'POST', url: '/api/staging/publish', payload: { ids: [item.id] } }),
    )
    expect(refused.results[0].ok).toBe(false)

    await app.inject({ method: 'POST', url: '/api/staging/approve', payload: { ids: [item.id] } })
    const published = json(
      await app.inject({ method: 'POST', url: '/api/staging/publish', payload: { ids: [item.id] } }),
    )
    expect(published.results[0].ok).toBe(true)

    const after = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const afterProduct = after.products.find((p: { id: string }) => p.id === product.id)
    expect(afterProduct.media.length).toBe(before + 1)

    // Revert deletes the added media.
    const reverted = json(
      await app.inject({ method: 'POST', url: '/api/staging/revert', payload: { ids: [item.id] } }),
    )
    expect(reverted.results[0].ok).toBe(true)
    const final = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const finalProduct = final.products.find((p: { id: string }) => p.id === product.id)
    expect(finalProduct.media.length).toBe(before)
  })
})
