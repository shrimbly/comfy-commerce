import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { eq } from 'drizzle-orm'

import { buildApp, type BuildAppResult } from '../src/app.js'
import { verifyWebhookHmac } from '../src/connectors/shopify/oauth.js'
import { auditLog, stores } from '../src/db/schema.js'
import { loadEnv } from '../src/env.js'

const SECRET = 'shpss_test_webhook_secret'
const DOMAIN = 'webhook-test.myshopify.com'
/** Fixed past timestamp — "lastSyncedAt updated" means it moved off this. */
const SENTINEL = '2020-01-01T00:00:00.000Z'

let app: FastifyInstance
let ctx: BuildAppResult['ctx']
let tmpDir: string

/** HMAC-SHA256 over the exact string Shopify would send, base64 — what the header carries. */
const sign = (body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('base64')

/** Post a raw STRING payload so the signed bytes are exactly what request.rawBody captures. */
const postWebhook = (body: string, headers: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: '/api/webhooks/shopify',
    payload: body,
    headers: { 'content-type': 'application/json', ...headers },
  })

const storeRow = () => ctx.db.select().from(stores).where(eq(stores.domain, DOMAIN)).get()!

const resetLastSynced = () =>
  ctx.db.update(stores).set({ lastSyncedAt: SENTINEL }).where(eq(stores.domain, DOMAIN)).run()

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-webhooks-'))
  process.env.LOG_LEVEL = 'silent'
  // Shopify credentials flip the broker into live mode — the webhook route
  // 404s without them. Overrides beat dotenv, so this is deterministic.
  const env = loadEnv({
    DATA_DIR: tmpDir,
    PORT: '0',
    SHOPIFY_API_KEY: 'test-api-key',
    SHOPIFY_API_SECRET: SECRET,
    COMFY_LOCAL_URL: 'http://127.0.0.1:1',
    COMFY_CLOUD_API_KEY: undefined as unknown as string,
  })
  ;({ app, ctx } = await buildApp(env))
  await app.ready()

  // Seed a real shopify-adapter store via the token-connect route. The fetch
  // stub is TOTAL: Admin GraphQL answers both the scope check and the shop-info
  // query; every other URL (fetchShopInfo's storefront favicon probe) gets a
  // 404 so nothing ever leaves the process.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/admin/api/')) {
        return Response.json({
          data: {
            currentAppInstallation: {
              accessScopes: ['read_products', 'write_products', 'write_files'].map((handle) => ({
                handle,
              })),
            },
            shop: { name: 'Webhook Test', primaryDomain: null },
          },
        })
      }
      return new Response('', { status: 404 })
    }),
  )
  const res = await app.inject({
    method: 'POST',
    url: '/api/connect/shopify/token',
    payload: { shop: 'webhook-test', accessToken: 'shpat_0123456789abcdef' },
  })
  vi.unstubAllGlobals()
  expect(res.statusCode).toBe(200)
})

afterAll(async () => {
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('POST /api/webhooks/shopify (live mode)', () => {
  it('accepts a correctly signed products/update webhook and refreshes lastSyncedAt', async () => {
    resetLastSynced()
    const body = JSON.stringify({ id: 123 })
    const res = await postWebhook(body, {
      'x-shopify-hmac-sha256': sign(body),
      'x-shopify-topic': 'products/update',
      'x-shopify-shop-domain': DOMAIN,
    })
    expect(res.statusCode).toBe(200)
    const row = storeRow()
    expect(row.lastSyncedAt).not.toBe(SENTINEL)
    expect(row.status).toBe('connected')
    const audits = ctx.db.select().from(auditLog).where(eq(auditLog.storeId, row.id)).all()
    expect(audits.some((a) => a.action === 'webhook.received')).toBe(true)
  })

  it('rejects a tampered payload with 401 and leaves the store untouched', async () => {
    resetLastSynced()
    const body = JSON.stringify({ id: 123 })
    const res = await postWebhook(body + ' ', {
      'x-shopify-hmac-sha256': sign(body),
      'x-shopify-topic': 'products/update',
      'x-shopify-shop-domain': DOMAIN,
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.payload).error).toBe('Invalid webhook HMAC')
    expect(storeRow().lastSyncedAt).toBe(SENTINEL)
  })

  it('rejects a signature computed with the wrong secret', async () => {
    const body = JSON.stringify({ id: 123 })
    const res = await postWebhook(body, {
      'x-shopify-hmac-sha256': sign(body, 'wrong-secret'),
      'x-shopify-topic': 'products/update',
      'x-shopify-shop-domain': DOMAIN,
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects when the HMAC header is missing', async () => {
    const body = JSON.stringify({ id: 123 })
    const res = await postWebhook(body, {
      'x-shopify-topic': 'products/update',
      'x-shopify-shop-domain': DOMAIN,
    })
    expect(res.statusCode).toBe(401)
  })

  it('valid signature for an unknown or missing shop domain is a no-op 200', async () => {
    resetLastSynced()
    const body = JSON.stringify({ id: 123 })
    const unknownShop = await postWebhook(body, {
      'x-shopify-hmac-sha256': sign(body),
      'x-shopify-topic': 'products/update',
      'x-shopify-shop-domain': 'someone-else.myshopify.com',
    })
    expect(unknownShop.statusCode).toBe(200)
    expect(storeRow().lastSyncedAt).toBe(SENTINEL)

    const noShopHeader = await postWebhook(body, {
      'x-shopify-hmac-sha256': sign(body),
      'x-shopify-topic': 'products/update',
    })
    expect(noShopHeader.statusCode).toBe(200)
    expect(storeRow().lastSyncedAt).toBe(SENTINEL)
  })

  // Must run LAST: it wipes the stored token and flips the store to error.
  it('app/uninstalled flips the store to error and wipes the stored token', async () => {
    expect(storeRow().accessTokenEncrypted).toBeTruthy()
    const body = JSON.stringify({ id: 123 })
    const res = await postWebhook(body, {
      'x-shopify-hmac-sha256': sign(body),
      'x-shopify-topic': 'app/uninstalled',
      'x-shopify-shop-domain': DOMAIN,
    })
    expect(res.statusCode).toBe(200)
    const row = storeRow()
    expect(row.status).toBe('error')
    expect(row.accessTokenEncrypted).toBeNull()
  })
})

describe('verifyWebhookHmac', () => {
  it('accepts the exact base64 digest of the body', () => {
    const body = JSON.stringify({ id: 123 })
    expect(verifyWebhookHmac(body, sign(body), SECRET)).toBe(true)
  })

  it('rejects the hex digest of the same body without throwing', () => {
    // Hex sha256 is 64 chars vs 44-char base64 — the length guard must return
    // false rather than let timingSafeEqual throw on mismatched buffer sizes.
    const body = JSON.stringify({ id: 123 })
    const hexDigest = createHmac('sha256', SECRET).update(body).digest('hex')
    expect(verifyWebhookHmac(body, hexDigest, SECRET)).toBe(false)
  })
})
