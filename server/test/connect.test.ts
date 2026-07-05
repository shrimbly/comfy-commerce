import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { eq } from 'drizzle-orm'

import { buildApp, type BuildAppResult } from '../src/app.js'
import { stores } from '../src/db/schema.js'
import { loadEnv } from '../src/env.js'

let app: FastifyInstance
let ctx: BuildAppResult['ctx']
let tmpDir: string

const json = (res: { payload: string }) => JSON.parse(res.payload)

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-connect-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({ DATA_DIR: tmpDir, PORT: '0' })
  ;({ app, ctx } = await buildApp(env))
  await app.ready()
})

afterAll(async () => {
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

afterEach(() => vi.unstubAllGlobals())

/** Stub Shopify's GraphQL endpoint for currentAppInstallation. */
function stubShopify(scopes: string[] | { status: number }) {
  const realFetch = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: unknown) => {
      const url = String(input)
      if (!url.includes('/admin/api/')) return realFetch(input as never, init as never)
      if ('status' in (scopes as object) && !Array.isArray(scopes)) {
        return new Response('unauthorized', { status: (scopes as { status: number }).status })
      }
      return Response.json({
        data: {
          currentAppInstallation: {
            accessScopes: (scopes as string[]).map((handle) => ({ handle })),
          },
        },
      })
    }),
  )
}

describe('admin-token connect', () => {
  it('verifies the token, records scopes, and connects the store', async () => {
    stubShopify(['read_products', 'write_products', 'write_files'])
    const res = await app.inject({
      method: 'POST',
      url: '/api/connect/shopify/token',
      payload: { shop: 'real-test-store', accessToken: 'shpat_0123456789abcdef' },
    })
    expect(res.statusCode).toBe(200)
    const { kind, store } = json(res)
    expect(kind).toBe('connected')
    expect(store.domain).toBe('real-test-store.myshopify.com')
    expect(store.scopes).toContain('write_products')
  })

  it('rejects tokens missing required scopes with a precise message', async () => {
    stubShopify(['read_products'])
    const res = await app.inject({
      method: 'POST',
      url: '/api/connect/shopify/token',
      payload: { shop: 'scopeless', accessToken: 'shpat_0123456789abcdef' },
    })
    expect(res.statusCode).toBe(400)
    expect(json(res).error).toContain('write_products')
  })

  it('rejects invalid tokens without persisting a store', async () => {
    stubShopify({ status: 401 })
    const res = await app.inject({
      method: 'POST',
      url: '/api/connect/shopify/token',
      payload: { shop: 'badtoken', accessToken: 'shpat_wrongwrongwrong' },
    })
    expect(res.statusCode).toBe(400)
    const { stores } = json(await app.inject({ method: 'GET', url: '/api/stores' }))
    expect(stores.some((s: { domain: string }) => s.domain.startsWith('badtoken'))).toBe(false)
  })
})

/** Stub the token-exchange endpoint and the Admin GraphQL endpoint. */
function stubClientCredentials(scope: string) {
  const counters = { exchanges: 0, graphql: 0 }
  let serial = 0
  const realFetch = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: unknown) => {
      const url = String(input)
      if (url.includes('/admin/oauth/access_token')) {
        counters.exchanges += 1
        serial += 1
        return Response.json({ access_token: `cc-token-${serial}`, scope, expires_in: 86399 })
      }
      if (url.includes('/admin/api/')) {
        counters.graphql += 1
        return Response.json({
          data: {
            collections: { edges: [] },
            products: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        })
      }
      return realFetch(input as never, init as never)
    }),
  )
  return counters
}

describe('client-credentials connect (Dev Dashboard apps)', () => {
  it('exchanges credentials, records granted scopes, and connects', async () => {
    const counters = stubClientCredentials('read_products,write_products,write_files')
    const res = await app.inject({
      method: 'POST',
      url: '/api/connect/shopify/credentials',
      payload: { shop: 'dev-dash-store', clientId: 'client-id-123', clientSecret: 'shhh-secret-456' },
    })
    expect(res.statusCode).toBe(200)
    const { store } = json(res)
    expect(store.domain).toBe('dev-dash-store.myshopify.com')
    expect(store.scopes).toContain('write_products')
    expect(counters.exchanges).toBe(1)
    // No secrets in the public DTO.
    expect(JSON.stringify(store)).not.toContain('shhh-secret')
  })

  it('re-exchanges automatically once the 24h token expires', async () => {
    const counters = stubClientCredentials('read_products,write_products')
    const connectRes = json(
      await app.inject({
        method: 'POST',
        url: '/api/connect/shopify/credentials',
        payload: { shop: 'refresh-store', clientId: 'client-id-123', clientSecret: 'secret-456' },
      }),
    )
    expect(counters.exchanges).toBe(1)

    // Force-expire the stored token; the next Admin API call must refresh.
    ctx.db
      .update(stores)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(stores.id, connectRes.store.id))
      .run()

    const catalog = await app.inject({
      method: 'GET',
      url: `/api/stores/${connectRes.store.id}/catalog`,
    })
    expect(catalog.statusCode).toBe(200)
    expect(counters.exchanges).toBeGreaterThan(1)
    expect(counters.graphql).toBeGreaterThan(0)

    // A second sync within the validity window must NOT re-exchange.
    const exchangesAfterRefresh = counters.exchanges
    const again = await app.inject({
      method: 'GET',
      url: `/api/stores/${connectRes.store.id}/catalog`,
    })
    expect(again.statusCode).toBe(200)
    expect(counters.exchanges).toBe(exchangesAfterRefresh)
  })

  it('accepts write_products without an explicit read_products (write implies read)', async () => {
    stubClientCredentials('write_products,write_files')
    const res = await app.inject({
      method: 'POST',
      url: '/api/connect/shopify/credentials',
      payload: { shop: 'implied-read', clientId: 'client-id-123', clientSecret: 'secret-456' },
    })
    expect(res.statusCode).toBe(200)
    expect(json(res).store.scopes).toContain('write_products')
  })

  it('rejects credentials whose app lacks required scopes', async () => {
    stubClientCredentials('read_products')
    const res = await app.inject({
      method: 'POST',
      url: '/api/connect/shopify/credentials',
      payload: { shop: 'underscoped', clientId: 'client-id-123', clientSecret: 'secret-456' },
    })
    expect(res.statusCode).toBe(400)
    expect(json(res).error).toContain('write_products')
  })
})

describe('disconnect cascade', () => {
  it('removes the store along with its staging items and runs', async () => {
    // Demo store + a mock run that stages results.
    const connect = json(
      await app.inject({
        method: 'POST',
        url: '/api/connect/shopify',
        payload: { shop: 'cascade-demo' },
      }),
    )
    const storeId = connect.store.id as string
    const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
    const product = catalog.products[0]

    const run = json(
      await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          storeId,
          workflowId: 'builtin:fit-to-768px',
          providerId: 'mock',
          params: {},
          target: {
            kind: 'selection',
            inputs: [{ productId: product.id, mediaId: product.media[0].id }],
          },
          stageAction: 'replace-position',
        },
      }),
    ).run
    for (let i = 0; i < 100; i++) {
      const { run: fresh } = json(await app.inject({ method: 'GET', url: `/api/runs/${run.id}` }))
      if (fresh.state === 'completed') break
      await new Promise((r) => setTimeout(r, 100))
    }
    const staged = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${storeId}` }))
    expect(staged.items.length).toBeGreaterThan(0)

    await app.inject({ method: 'DELETE', url: `/api/stores/${storeId}` })

    const after = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${storeId}` }))
    expect(after.items).toHaveLength(0)
    const runsAfter = json(await app.inject({ method: 'GET', url: `/api/runs?storeId=${storeId}` }))
    expect(runsAfter.runs).toHaveLength(0)
  })
})
