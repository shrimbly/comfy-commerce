import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp, type BuildAppResult } from '../src/app.js'
import { stagingItems } from '../src/db/schema.js'
import { loadEnv } from '../src/env.js'

const json = (res: { payload: string }) => JSON.parse(res.payload)

let tmpDir: string | null = null
let openApp: BuildAppResult | null = null

afterEach(async () => {
  if (openApp) {
    await openApp.app.close()
    openApp = null
  }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

async function boot(): Promise<BuildAppResult> {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-staging-error-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({
    DATA_DIR: tmpDir,
    PORT: '0',
    SHOPIFY_API_KEY: undefined as unknown as string,
    COMFY_LOCAL_URL: 'http://127.0.0.1:1',
    COMFY_CLOUD_API_KEY: undefined as unknown as string,
  })
  const built = await buildApp(env)
  await built.app.ready()
  openApp = built
  return built
}

describe('GET /api/staging exposes the recorded failure reason (finding #52)', () => {
  it('returns error: null for healthy items and the persisted message for failed ones', async () => {
    const { app, ctx } = await boot()

    const connect = json(
      await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'err-demo' } }),
    )
    const storeId = connect.store.id as string
    const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
    const product = catalog.products[0]

    const staged = json(
      await app.inject({
        method: 'POST',
        url: '/api/staging',
        payload: {
          storeId,
          items: [
            {
              productId: product.id,
              mediaId: product.media[0].id,
              afterUrl: 'https://cdn.example/after.png',
              action: 'replace-position',
            },
          ],
        },
      }),
    )
    const itemId = staged.items[0].id as string
    // A freshly staged item carries the field, explicitly null.
    expect(staged.items[0].error).toBeNull()

    // Simulate a publish that failed with a connector message (the same shape
    // publishOne records via setState(row.id, 'failed', message)).
    const message = 'Media too large — Shopify rejected the upload'
    ctx.db
      .update(stagingItems)
      .set({ state: 'failed', error: message })
      .where(eq(stagingItems.id, itemId))
      .run()

    const listed = json(await app.inject({ method: 'GET', url: '/api/staging' }))
    const item = listed.items.find((i: { id: string }) => i.id === itemId)
    expect(item.state).toBe('failed')
    expect(item.error).toBe(message)
  })
})
