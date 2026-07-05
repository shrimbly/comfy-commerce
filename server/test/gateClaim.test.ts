/**
 * THE GATE — the named suite for the real review gate.
 *
 * The gate is NOT a pure in-memory state machine: it is the atomic SQL claim
 * in server/src/services/stagingService.ts (publishOne's
 * `UPDATE staging_items SET state='publishing' WHERE id=? AND state IN
 * ('approved','failed')`). These tests exercise that claim through the public
 * API, against a real (tmp-dir) SQLite database and the mock connector store:
 *
 *   - pending items are refused publish (approval is mandatory);
 *   - approved → published succeeds;
 *   - failed → publishing (retry) is allowed;
 *   - reject-from-failed is allowed — and a rejected item can never publish;
 *   - a second concurrent publish of the same id loses the claim
 *     (no double-publish, no duplicate media on the live store).
 *
 * A regression that widens the claim (e.g. adding 'pending' to its inArray)
 * fails this suite.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { MockConnector } from '../src/connectors/mock.js'
import { loadEnv } from '../src/env.js'

let app: FastifyInstance
let tmpDir: string
let storeId: string
let products: Array<{ id: string; media: Array<{ id: string; url: string }> }>

const json = (res: { payload: string }) => JSON.parse(res.payload)

interface OperationResult {
  id: string
  ok: boolean
  state: string
  error: string | null
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-gate-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({
    DATA_DIR: tmpDir,
    PORT: '0',
    // No Shopify credentials → mock mode. Unroutable engines → no network.
    SHOPIFY_API_KEY: undefined as unknown as string,
    COMFY_LOCAL_URL: 'http://127.0.0.1:1',
    COMFY_CLOUD_API_KEY: undefined as unknown as string,
  })
  ;({ app } = await buildApp(env))
  await app.ready()

  const connect = json(
    await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'gate-demo' } }),
  )
  storeId = connect.store.id
  const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
  products = catalog.products
})

afterAll(async () => {
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

afterEach(() => {
  MockConnector.failNextReplaceStep = null
})

let productCursor = 0
/** Stage one edit (always lands `pending`) against a fresh product. */
async function stageOne(action: 'add-new' | 'replace-position'): Promise<string> {
  const product = products[productCursor++ % products.length]!
  const res = await app.inject({
    method: 'POST',
    url: '/api/staging',
    payload: {
      storeId,
      items: [
        {
          productId: product.id,
          mediaId: product.media[0]!.id,
          afterUrl: product.media[0]!.url,
          action,
        },
      ],
    },
  })
  expect(res.statusCode).toBe(201)
  const { items } = json(res) as { items: Array<{ id: string; state: string }> }
  expect(items[0]!.state).toBe('pending')
  return items[0]!.id
}

async function itemState(id: string): Promise<string> {
  const staging = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${storeId}` }))
  return staging.items.find((i: { id: string }) => i.id === id)!.state
}

async function approve(ids: string[]): Promise<OperationResult[]> {
  return json(await app.inject({ method: 'POST', url: '/api/staging/approve', payload: { ids } }))
    .results
}

async function publish(ids: string[]): Promise<OperationResult[]> {
  return json(await app.inject({ method: 'POST', url: '/api/staging/publish', payload: { ids } }))
    .results
}

async function reject(ids: string[]): Promise<OperationResult[]> {
  return json(await app.inject({ method: 'POST', url: '/api/staging/reject', payload: { ids } }))
    .results
}

async function mediaCount(productId: string): Promise<number> {
  const gallery = json(
    await app.inject({
      method: 'GET',
      url: `/api/staging/gallery?storeId=${storeId}&productId=${productId}`,
    }),
  )
  return (gallery.media as unknown[]).length
}

describe('THE GATE — the atomic DB claim in stagingService.publishOne', { timeout: 30_000 }, () => {
  it('refuses to publish a pending item — approval is mandatory', async () => {
    const id = await stageOne('add-new')
    const [result] = await publish([id])
    expect(result!.ok).toBe(false)
    expect(result!.state).toBe('pending')
    expect(result!.error).toContain('approval is mandatory')
    expect(await itemState(id)).toBe('pending') // the claim never touched the row
  })

  it('publishes an approved item (approved → publishing → published)', async () => {
    const id = await stageOne('add-new')
    const [approved] = await approve([id])
    expect(approved!.ok).toBe(true)
    const [result] = await publish([id])
    expect(result!.ok).toBe(true)
    expect(result!.state).toBe('published')
    expect(await itemState(id)).toBe('published')
  })

  it('allows the failed → publishing retry edge through the same claim', async () => {
    const id = await stageOne('replace-position')
    await approve([id])

    // A real partial failure (connector dies mid-replace) — not a DB poke.
    MockConnector.failNextReplaceStep = 'move'
    const [failed] = await publish([id])
    expect(failed!.ok).toBe(false)
    expect(failed!.state).toBe('failed')

    const [retried] = await publish([id])
    expect(retried!.ok).toBe(true)
    expect(retried!.state).toBe('published')
  })

  it('allows reject-from-failed, and a rejected item can never publish', async () => {
    const id = await stageOne('replace-position')
    await approve([id])
    MockConnector.failNextReplaceStep = 'move'
    await publish([id])
    expect(await itemState(id)).toBe('failed')

    const [rejected] = await reject([id])
    expect(rejected!.ok).toBe(true)
    expect(rejected!.state).toBe('rejected')

    // 'rejected' is outside the claim's inArray — publish must refuse.
    const [refused] = await publish([id])
    expect(refused!.ok).toBe(false)
    expect(refused!.error).toContain("Cannot publish from 'rejected'")
    expect(await itemState(id)).toBe('rejected')
  })

  it('a second concurrent publish of the same id loses the claim — no double-publish', async () => {
    const product = products[productCursor++ % products.length]!
    const before = await mediaCount(product.id)
    const staged = json(
      await app.inject({
        method: 'POST',
        url: '/api/staging',
        payload: {
          storeId,
          items: [
            {
              productId: product.id,
              mediaId: product.media[0]!.id,
              afterUrl: product.media[0]!.url,
              action: 'add-new',
            },
          ],
        },
      }),
    ).items as Array<{ id: string }>
    const id = staged[0]!.id
    await approve([id])

    // The double-clicked "Publish": two publishes of the SAME id in flight at
    // once. Exactly one wins the approved→publishing claim; the loser claims 0
    // rows and must not run the connector mutation a second time.
    const [r1, r2] = await Promise.all([publish([id]), publish([id])])
    const outcomes = [...r1, ...r2]

    expect(await itemState(id)).toBe('published')
    // At least one caller reports the publish; nobody reports a fresh second
    // one (the loser is either refused mid-flight or sees 'published').
    expect(outcomes.some((r) => r.ok && r.state === 'published')).toBe(true)
    for (const r of outcomes) {
      if (!r.ok) expect(r.error).toContain('Cannot publish from')
    }

    // The live store gained exactly ONE media — the claim stopped the double.
    expect(await mediaCount(product.id)).toBe(before + 1)

    // And the ledger records exactly one publish of this item.
    const audit = json(await app.inject({ method: 'GET', url: '/api/audit' }))
    const publishes = audit.entries.filter(
      (e: { action: string; itemId: string | null }) =>
        e.action === 'staging.publish' && e.itemId === id,
    )
    expect(publishes).toHaveLength(1)
  })
})
