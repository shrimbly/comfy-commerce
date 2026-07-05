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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-galleryreorder-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({ DATA_DIR: tmpDir, PORT: '0' })
  ;({ app } = await buildApp(env))
  await app.ready()
})

afterAll(async () => {
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function runStage(
  storeId: string,
  productId: string,
  mediaId: string,
  stageAction: 'add-new' | 'replace-position' = 'add-new',
) {
  const { run } = json(
    await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        storeId,
        workflowId: 'builtin:fit-to-768px',
        providerId: 'mock',
        params: {},
        target: { kind: 'selection', inputs: [{ productId, mediaId }] },
        stageAction,
      },
    }),
  )
  for (let i = 0; i < 100; i++) {
    const { run: fresh } = json(await app.inject({ method: 'GET', url: `/api/runs/${run.id}` }))
    if (fresh.state === 'completed') break
    await sleep(50)
  }
}

describe('gallery reorder', () => {
  it('enforces the saved arrangement (existing + results across runs) on publish', async () => {
    const { store } = json(
      await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'galleryreorder-demo' } }),
    )
    await app.inject({
      method: 'PATCH',
      url: `/api/stores/${store.id}/scope`,
      payload: { collectionIds: 'all', tags: [], productStatus: 'active', mediaRole: 'all' },
    })
    const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const product = catalog.products[0]
    const mediaIds: string[] = product.media.map((m: { id: string }) => m.id)
    expect(mediaIds.length).toBeGreaterThanOrEqual(2)

    // Two separate runs → two approved results for the same product (distinct runs).
    await runStage(store.id, product.id, product.media[0].id)
    await runStage(store.id, product.id, product.media[0].id)

    const staged = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${store.id}` }))
    const items = staged.items.filter((i: { productId: string }) => i.productId === product.id)
    expect(items).toHaveLength(2)
    const itemA = items[0] as { id: string }
    const itemB = items[1] as { id: string }
    await app.inject({
      method: 'POST',
      url: '/api/staging/approve',
      payload: { ids: [itemA.id, itemB.id] },
    })

    // Arrange: result B, existing #2, result A, existing #1.
    await app.inject({
      method: 'POST',
      url: '/api/staging/arrangement',
      payload: {
        storeId: store.id,
        productId: product.id,
        order: [
          { kind: 'staged', itemId: itemB.id },
          { kind: 'media', mediaId: mediaIds[1] },
          { kind: 'staged', itemId: itemA.id },
          { kind: 'media', mediaId: mediaIds[0] },
        ],
      },
    })

    const published = json(
      await app.inject({
        method: 'POST',
        url: '/api/staging/publish-gallery',
        payload: { storeId: store.id, productId: product.id },
      }),
    )
    expect(published.reordered).toBe(true)

    // Resolve each staged item's published media id.
    const after = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${store.id}` }))
    const pub = new Map<string, string>(
      after.items
        .filter((i: { productId: string }) => i.productId === product.id)
        .map((i: { id: string; publishedMediaId: string }) => [i.id, i.publishedMediaId]),
    )

    const final = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const finalProduct = final.products.find((p: { id: string }) => p.id === product.id)
    const finalIds: string[] = finalProduct.media.map((m: { id: string }) => m.id)
    // The arranged four lead the gallery in order; untouched media follow.
    expect(finalIds.slice(0, 4)).toEqual([
      pub.get(itemB.id),
      mediaIds[1],
      pub.get(itemA.id),
      mediaIds[0],
    ])
    expect(finalIds).toContain(mediaIds[2] ?? mediaIds[0])
  })

  it('prunes a rejected result from the saved arrangement', async () => {
    const { store } = json(
      await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'galleryreorder-prune' } }),
    )
    await app.inject({
      method: 'PATCH',
      url: `/api/stores/${store.id}/scope`,
      payload: { collectionIds: 'all', tags: [], productStatus: 'active', mediaRole: 'all' },
    })
    const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const product = catalog.products[0]
    await runStage(store.id, product.id, product.media[0].id)
    const staged = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${store.id}` }))
    const item = staged.items.find((i: { productId: string }) => i.productId === product.id)
    await app.inject({ method: 'POST', url: '/api/staging/approve', payload: { ids: [item.id] } })
    await app.inject({
      method: 'POST',
      url: '/api/staging/arrangement',
      payload: {
        storeId: store.id,
        productId: product.id,
        order: [{ kind: 'staged', itemId: item.id }, { kind: 'media', mediaId: product.media[0].id }],
      },
    })
    await app.inject({ method: 'POST', url: '/api/staging/reject', payload: { ids: [item.id] } })
    const editor = json(
      await app.inject({
        method: 'GET',
        url: `/api/staging/gallery?storeId=${store.id}&productId=${product.id}`,
      }),
    )
    expect(editor.arrangement.some((s: { itemId?: string }) => s.itemId === item.id)).toBe(false)
  })

  it('records the new media id on a replace publish and repositions it per the arrangement', async () => {
    const { store } = json(
      await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'galleryreorder-replace' } }),
    )
    await app.inject({
      method: 'PATCH',
      url: `/api/stores/${store.id}/scope`,
      payload: { collectionIds: 'all', tags: [], productStatus: 'active', mediaRole: 'all' },
    })
    const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const product = catalog.products[0]
    const mediaIds: string[] = product.media.map((m: { id: string }) => m.id)
    expect(mediaIds.length).toBeGreaterThanOrEqual(2)

    // Replace the media at position 1 in place.
    await runStage(store.id, product.id, product.media[0].id, 'replace-position')
    const staged = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${store.id}` }))
    const item = staged.items.find((i: { productId: string }) => i.productId === product.id)
    expect(item.action).toBe('replace-position')
    await app.inject({ method: 'POST', url: '/api/staging/approve', payload: { ids: [item.id] } })

    // Arrange: existing #2 first, then the replacement last.
    await app.inject({
      method: 'POST',
      url: '/api/staging/arrangement',
      payload: {
        storeId: store.id,
        productId: product.id,
        order: [{ kind: 'media', mediaId: mediaIds[1] }, { kind: 'staged', itemId: item.id }],
      },
    })

    const published = json(
      await app.inject({
        method: 'POST',
        url: '/api/staging/publish-gallery',
        payload: { storeId: store.id, productId: product.id },
      }),
    )
    expect(published.reordered).toBe(true)

    // The replace recorded its new media id; the replaced media id is gone.
    const after = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${store.id}` }))
    const publishedItem = after.items.find((i: { id: string }) => i.id === item.id) as {
      state: string
      publishedMediaId: string
    }
    expect(publishedItem.state).toBe('published')
    expect(publishedItem.publishedMediaId).toBeTruthy()

    const final = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const finalProduct = final.products.find((p: { id: string }) => p.id === product.id)
    const finalIds: string[] = finalProduct.media.map((m: { id: string }) => m.id)
    expect(finalIds).not.toContain(mediaIds[0]) // the replaced media is gone
    expect(finalIds.slice(0, 2)).toEqual([mediaIds[1], publishedItem.publishedMediaId])
  })

  it('does not duplicate media when a replace gallery is published twice', async () => {
    const { store } = json(
      await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'galleryreorder-idem' } }),
    )
    await app.inject({
      method: 'PATCH',
      url: `/api/stores/${store.id}/scope`,
      payload: { collectionIds: 'all', tags: [], productStatus: 'active', mediaRole: 'all' },
    })
    const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const product = catalog.products[0]
    const before: number = product.media.length

    await runStage(store.id, product.id, product.media[0].id, 'replace-position')
    const staged = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${store.id}` }))
    const item = staged.items.find((i: { productId: string }) => i.productId === product.id)
    await app.inject({ method: 'POST', url: '/api/staging/approve', payload: { ids: [item.id] } })

    // Publish the same gallery twice (mimics a double-clicked "Publish all").
    await app.inject({
      method: 'POST',
      url: '/api/staging/publish-gallery',
      payload: { storeId: store.id, productId: product.id },
    })
    const second = json(
      await app.inject({
        method: 'POST',
        url: '/api/staging/publish-gallery',
        payload: { storeId: store.id, productId: product.id },
      }),
    )
    // The second publish is a no-op for the already-published item.
    expect(second.results.every((r: { ok: boolean }) => r.ok)).toBe(true)

    const final = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const finalProduct = final.products.find((p: { id: string }) => p.id === product.id)
    // Replace-in-place keeps the count constant — no duplicate from re-publishing.
    expect(finalProduct.media.length).toBe(before)
  })
})
