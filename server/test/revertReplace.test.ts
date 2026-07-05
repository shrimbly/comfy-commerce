import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { MockConnector } from '../src/connectors/mock.js'
import type { StoreRecord } from '../src/connectors/types.js'
import type { AppContext } from '../src/context.js'
import { stagingItems } from '../src/db/schema.js'
import { loadEnv } from '../src/env.js'
import { takeCustodyOfUrl } from '../src/services/stagingService.js'

let app: FastifyInstance
let ctx: AppContext
let tmpDir: string

const json = (res: { payload: string }) => JSON.parse(res.payload)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Direct MockConnector access simulates merchant-side edits outside the app. */
const asStore = (storeId: string) => ({ id: storeId }) as StoreRecord

interface Media {
  id: string
  url: string
  position: number
}

interface Item {
  id: string
  productId: string
  state: string
  targetPosition: number
  targetMediaId: string | null
  publishedMediaId: string | null
  priorMediaSnapshot: { id: string; url: string; position: number } | null
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-revertreplace-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({ DATA_DIR: tmpDir, PORT: '0' })
  ;({ app, ctx } = await buildApp(env))
  await app.ready()
})

afterAll(async () => {
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

afterEach(() => {
  MockConnector.failNextReplaceStep = null
  vi.unstubAllGlobals()
})

async function connectStore(shop: string): Promise<string> {
  const { store } = json(
    await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop } }),
  )
  await app.inject({
    method: 'PATCH',
    url: `/api/stores/${store.id}/scope`,
    payload: { collectionIds: 'all', tags: [], productStatus: 'active', mediaRole: 'all' },
  })
  return store.id as string
}

async function getProduct(storeId: string, productId: string): Promise<{ id: string; media: Media[] }> {
  const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
  return catalog.products.find((p: { id: string }) => p.id === productId)
}

async function firstProduct(storeId: string, minMedia = 2): Promise<{ id: string; media: Media[] }> {
  const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
  const product = catalog.products.find((p: { media: Media[] }) => p.media.length >= minMedia)
  expect(product).toBeTruthy()
  return product
}

async function runStage(storeId: string, productId: string, mediaId: string) {
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
        stageAction: 'replace-position',
      },
    }),
  )
  for (let i = 0; i < 100; i++) {
    const { run: fresh } = json(await app.inject({ method: 'GET', url: `/api/runs/${run.id}` }))
    if (fresh.state === 'completed') break
    await sleep(50)
  }
}

/** Stage a replace-position edit of one media via a real run, then approve it. */
async function stageAndApproveReplace(
  storeId: string,
  productId: string,
  mediaId: string,
): Promise<string> {
  await runStage(storeId, productId, mediaId)
  const staged = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${storeId}` }))
  const item = staged.items.find(
    (i: { productId: string; state: string }) => i.productId === productId && i.state === 'pending',
  )
  expect(item).toBeTruthy()
  await app.inject({ method: 'POST', url: '/api/staging/approve', payload: { ids: [item.id] } })
  return item.id as string
}

async function getItem(storeId: string, itemId: string): Promise<Item> {
  const staged = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${storeId}` }))
  return staged.items.find((i: { id: string }) => i.id === itemId)
}

async function publish(ids: string[]) {
  return json(await app.inject({ method: 'POST', url: '/api/staging/publish', payload: { ids } }))
    .results as Array<{ ok: boolean; state: string; error: string | null }>
}

async function revert(ids: string[]) {
  return json(await app.inject({ method: 'POST', url: '/api/staging/revert', payload: { ids } }))
    .results as Array<{ ok: boolean; state: string; error: string | null }>
}

describe('identity-addressed replace publish & revert', () => {
  it("revert after the app's own publish-gallery reorder restores the original and never touches repositioned media", async () => {
    const storeId = await connectStore('revertreplace-reorder')
    const product = await firstProduct(storeId, 3)
    const [m1, m2, m3] = product.media as [Media, Media, Media]

    const itemId = await stageAndApproveReplace(storeId, product.id, m3.id)
    // Saved arrangement moves the replacement to the featured slot.
    await app.inject({
      method: 'POST',
      url: '/api/staging/arrangement',
      payload: {
        storeId,
        productId: product.id,
        order: [
          { kind: 'staged', itemId },
          { kind: 'media', mediaId: m1.id },
          { kind: 'media', mediaId: m2.id },
        ],
      },
    })
    const published = json(
      await app.inject({
        method: 'POST',
        url: '/api/staging/publish-gallery',
        payload: { storeId, productId: product.id },
      }),
    )
    expect(published.results.every((r: { ok: boolean }) => r.ok)).toBe(true)
    expect(published.reordered).toBe(true)

    const publishedItem = await getItem(storeId, itemId)
    const publishedMediaId = publishedItem.publishedMediaId!
    expect(publishedMediaId).toBeTruthy()
    const mid = await getProduct(storeId, product.id)
    expect(mid.media.slice(0, 3).map((m) => m.id)).toEqual([publishedMediaId, m1.id, m2.id])

    const results = await revert([itemId])
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.state).toBe('approved')

    const final = await getProduct(storeId, product.id)
    const finalIds = final.media.map((m) => m.id)
    // The published media is deleted BY ID, wherever it sits...
    expect(finalIds).not.toContain(publishedMediaId)
    // ...and the repositioned bystanders survive (position-addressed revert
    // would have destroyed m2 — the occupant of the snapshot's position 3).
    expect(finalIds).toContain(m1.id)
    expect(finalIds).toContain(m2.id)
    // The original is back, in the published media's slot (position 1).
    expect(final.media[0]!.id).toBe(m3.id)

    const item = await getItem(storeId, itemId)
    expect(item.publishedMediaId).toBeNull()
    expect(item.targetMediaId).toBe(m3.id) // re-pointed at the restored copy
  })

  it('publish after an external (merchant) reorder deletes the staged target, not the position occupant', async () => {
    const storeId = await connectStore('revertreplace-extreorder')
    const product = await firstProduct(storeId)
    const [m1, m2] = product.media as [Media, Media]

    // Staged against m2 at position 2...
    const itemId = await stageAndApproveReplace(storeId, product.id, m2.id)
    expect((await getItem(storeId, itemId)).targetPosition).toBe(2)
    // ...then the merchant reorders in Shopify admin: m2 becomes featured.
    await new MockConnector(ctx.db).reorderMedia(asStore(storeId), product.id, [m2.id, m1.id])

    const results = await publish([itemId])
    expect(results[0]!.ok).toBe(true)

    const item = await getItem(storeId, itemId)
    const final = await getProduct(storeId, product.id)
    const finalIds = final.media.map((m) => m.id)
    expect(finalIds).not.toContain(m2.id) // the approved target was replaced
    expect(finalIds).toContain(m1.id) // position-addressed publish would delete m1
    expect(final.media[0]!.id).toBe(item.publishedMediaId) // m2's slot at publish time
    expect(item.priorMediaSnapshot!.id).toBe(m2.id) // snapshot matches what was deleted
  })

  for (const step of ['move', 'delete'] as const) {
    it(`partial failure before ${step} leaves the created media tracked; retry resumes without double-creating`, async () => {
      const storeId = await connectStore(`revertreplace-fail-${step}`)
      const product = await firstProduct(storeId)
      const before = product.media.length
      const m1 = product.media[0]!
      const itemId = await stageAndApproveReplace(storeId, product.id, m1.id)

      MockConnector.failNextReplaceStep = step
      const failed = await publish([itemId])
      expect(failed[0]!.ok).toBe(false)
      let item = await getItem(storeId, itemId)
      expect(item.state).toBe('failed')
      // The created media id was recorded BEFORE the failing step — the orphan
      // is tracked, so nothing on the live store is untraceable.
      expect(item.publishedMediaId).toBeTruthy()
      const createdId = item.publishedMediaId!
      const mid = await getProduct(storeId, product.id)
      const midIds = mid.media.map((m) => m.id)
      expect(mid.media.length).toBe(before + 1)
      expect(midIds).toContain(m1.id) // target not deleted yet
      expect(midIds).toContain(createdId) // created media live at the tail

      const retried = await publish([itemId])
      expect(retried[0]!.ok).toBe(true)
      item = await getItem(storeId, itemId)
      expect(item.state).toBe('published')
      expect(item.publishedMediaId).toBe(createdId) // resumed, never re-created
      const final = await getProduct(storeId, product.id)
      const finalIds = final.media.map((m) => m.id)
      expect(final.media.length).toBe(before)
      expect(finalIds).not.toContain(m1.id)
      expect(finalIds.filter((id) => id === createdId)).toHaveLength(1)
    })
  }

  it('revert succeeds when the published media was already deleted externally', async () => {
    const storeId = await connectStore('revertreplace-extdelete')
    const product = await firstProduct(storeId)
    const m1 = product.media[0]!
    const itemId = await stageAndApproveReplace(storeId, product.id, m1.id)
    await publish([itemId])
    let item = await getItem(storeId, itemId)
    const publishedMediaId = item.publishedMediaId!

    // Merchant deletes the AI media in Shopify admin before the revert.
    await new MockConnector(ctx.db).removeMedia(asStore(storeId), product.id, publishedMediaId)
    const preRevertIds = (await getProduct(storeId, product.id)).media.map((m) => m.id)

    const results = await revert([itemId])
    expect(results[0]!.ok).toBe(true)
    item = await getItem(storeId, itemId)
    expect(item.state).toBe('approved')

    const final = await getProduct(storeId, product.id)
    // Restored at the (clamped) snapshot slot — m1 was the featured image...
    expect(final.media[0]!.id).toBe(m1.id)
    // ...and NOTHING else was deleted: final set is exactly pre-revert + restored.
    expect(final.media.map((m) => m.id).sort()).toEqual([...preRevertIds, m1.id].sort())
  })

  it('revert refuses without a recorded published media id (legacy rows)', async () => {
    const storeId = await connectStore('revertreplace-legacyrevert')
    const product = await firstProduct(storeId)
    const itemId = await stageAndApproveReplace(storeId, product.id, product.media[0]!.id)
    await publish([itemId])
    // Simulate a row published before published_media_id tracking existed.
    ctx.db.update(stagingItems).set({ publishedMediaId: null }).where(eq(stagingItems.id, itemId)).run()
    const before = (await getProduct(storeId, product.id)).media

    const results = await revert([itemId])
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('No published media id recorded')
    const item = await getItem(storeId, itemId)
    expect(item.state).toBe('published')
    // Refusal is a pure no-op on the live store: no create, no delete.
    expect((await getProduct(storeId, product.id)).media).toEqual(before)
  })

  it('legacy rows (null target_media_id) publish via the beforeUrl fallback and backfill the id', async () => {
    const storeId = await connectStore('revertreplace-legacy-ok')
    const product = await firstProduct(storeId)
    const [m1, m2] = product.media as [Media, Media]
    const itemId = await stageAndApproveReplace(storeId, product.id, m2.id)
    // Simulate a row staged before identity tracking.
    ctx.db.update(stagingItems).set({ targetMediaId: null }).where(eq(stagingItems.id, itemId)).run()

    const results = await publish([itemId])
    expect(results[0]!.ok).toBe(true)
    const item = await getItem(storeId, itemId)
    expect(item.targetMediaId).toBe(m2.id) // adopted from the position+beforeUrl match

    const final = await getProduct(storeId, product.id)
    const finalIds = final.media.map((m) => m.id)
    expect(finalIds).not.toContain(m2.id)
    expect(finalIds).toContain(m1.id)
    expect(final.media[1]!.id).toBe(item.publishedMediaId) // replaced in place at slot 2
  })

  it('legacy rows fail safely when the gallery shifted since staging', async () => {
    const storeId = await connectStore('revertreplace-legacy-shift')
    const product = await firstProduct(storeId)
    const [m1, m2] = product.media as [Media, Media]
    const itemId = await stageAndApproveReplace(storeId, product.id, m2.id)
    ctx.db.update(stagingItems).set({ targetMediaId: null }).where(eq(stagingItems.id, itemId)).run()
    // The gallery shifts after staging — the position+beforeUrl fallback must
    // refuse rather than replace whatever now occupies position 2.
    await new MockConnector(ctx.db).reorderMedia(asStore(storeId), product.id, [m2.id, m1.id])
    const before = (await getProduct(storeId, product.id)).media

    const results = await publish([itemId])
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('Cannot identify the media to replace')
    const item = await getItem(storeId, itemId)
    expect(item.state).toBe('failed')
    expect((await getProduct(storeId, product.id)).media).toEqual(before) // untouched
  })

  it('full replace lifecycle: snapshot identity, revert, re-publish against the restored copy', async () => {
    const storeId = await connectStore('revertreplace-lifecycle')
    const product = await firstProduct(storeId)
    const m1 = product.media[0]!
    const itemId = await stageAndApproveReplace(storeId, product.id, m1.id)

    await publish([itemId])
    let item = await getItem(storeId, itemId)
    expect(item.state).toBe('published')
    expect(item.priorMediaSnapshot).not.toBeNull()
    expect(item.priorMediaSnapshot!.id).toBe(m1.id) // snapshot carries identity...
    expect(item.priorMediaSnapshot!.id).toBe(item.targetMediaId) // ...of the staged target
    expect(item.priorMediaSnapshot!.url).toBe(m1.url)
    const firstPublishedId = item.publishedMediaId!

    const reverted = await revert([itemId])
    expect(reverted[0]!.ok).toBe(true)
    item = await getItem(storeId, itemId)
    expect(item.state).toBe('approved')
    expect(item.publishedMediaId).toBeNull()
    expect(item.targetMediaId).toBe(m1.id) // re-pointed at the restored copy

    // Re-publish the reverted item — must succeed against the restored media
    // (a stale target id pointing at the deleted original would 404 here).
    const republished = await publish([itemId])
    expect(republished[0]!.ok).toBe(true)
    item = await getItem(storeId, itemId)
    expect(item.state).toBe('published')
    const final = await getProduct(storeId, product.id)
    const finalIds = final.media.map((m) => m.id)
    expect(finalIds).toContain(item.publishedMediaId!)
    expect(finalIds).not.toContain(m1.id) // the restored copy was replaced again
    expect(finalIds).not.toContain(firstPublishedId)
  })

  it('a concurrent / double-clicked revert restores once and never duplicates media', async () => {
    const storeId = await connectStore('revertreplace-concurrent')
    const product = await firstProduct(storeId, 2)
    const target = product.media[0]!
    const beforeCount = product.media.length
    const itemId = await stageAndApproveReplace(storeId, product.id, target.id)
    const [pub] = await publish([itemId])
    expect(pub!.ok).toBe(true)

    // Two reverts of the SAME item fired together (the double-click). Without
    // the reentrancy guard both create-and-restore, leaving a duplicate of the
    // original on the live store. Exactly one must take effect.
    const [r1, r2] = await Promise.all([revert([itemId]), revert([itemId])])
    const outcomes = [...r1, ...r2]
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1)
    expect(outcomes.filter((r) => !r.ok)).toHaveLength(1) // the loser is refused, not silently duplicated

    const after = await getProduct(storeId, product.id)
    expect(after.media).toHaveLength(beforeCount) // no duplicate restored media
    expect(after.media.filter((m) => m.id === target.id)).toHaveLength(1)
    expect((await getItem(storeId, itemId)).state).toBe('approved')
  })
})

describe('takeCustodyOfUrl', () => {
  it('returns root-relative URLs unchanged (already broker-owned)', async () => {
    expect(await takeCustodyOfUrl(ctx.assetStore, '/mock-cdn/products/tee-1.svg')).toBe(
      '/mock-cdn/products/tee-1.svg',
    )
  })

  it('saves remote bytes and returns a broker asset URL', async () => {
    const bytes = Buffer.from('fake-png-bytes')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
      ),
    )
    const url = await takeCustodyOfUrl(ctx.assetStore, 'https://cdn.example/original.png')
    expect(url).toMatch(/^\/api\/assets\//)
    const stored = ctx.assetStore.get(url.split('/').pop()!)
    expect(stored).not.toBeNull()
    expect(readFileSync(stored!.path)).toEqual(bytes)
  })

  it('falls back to the CDN URL when the fetch 404s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })))
    expect(await takeCustodyOfUrl(ctx.assetStore, 'https://cdn.example/gone.png')).toBe(
      'https://cdn.example/gone.png',
    )
  })

  it('falls back to the CDN URL when the fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    expect(await takeCustodyOfUrl(ctx.assetStore, 'https://cdn.example/x.png')).toBe(
      'https://cdn.example/x.png',
    )
  })
})
