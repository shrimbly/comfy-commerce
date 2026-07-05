import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp, type BuildAppResult } from '../src/app.js'
import { stagingItems } from '../src/db/schema.js'
import { loadEnv } from '../src/env.js'

const json = (res: { payload: string }) => JSON.parse(res.payload)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

/** Boot a broker on the given DATA_DIR (same dir twice = a restart). */
async function boot(dataDir: string): Promise<BuildAppResult> {
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({
    DATA_DIR: dataDir,
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

/**
 * Connect a demo store, stage one mock edit, approve it, then strand it in
 * 'publishing' (optionally with a recorded publishedMediaId) and "crash" the
 * broker by closing everything without cleanup.
 */
async function stageApproveAndCrash(publishedMediaId: string | null): Promise<string> {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-recover-'))
  const { app, ctx } = await boot(tmpDir)

  const connect = json(
    await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'recover-demo' } }),
  )
  const storeId = connect.store.id as string
  const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
  const product = catalog.products[0]

  const { run } = json(
    await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        storeId,
        workflowId: 'builtin:fit-to-768px',
        providerId: 'mock',
        params: {},
        target: { kind: 'selection', inputs: [{ productId: product.id, mediaId: product.media[0].id }] },
        stageAction: 'replace-position',
      },
    }),
  )
  for (let i = 0; i < 100; i++) {
    const { run: fresh } = json(await app.inject({ method: 'GET', url: `/api/runs/${run.id}` }))
    if (fresh.state === 'completed') break
    await sleep(100)
  }

  const staged = json(await app.inject({ method: 'GET', url: `/api/staging?storeId=${storeId}` }))
  expect(staged.items).toHaveLength(1)
  const itemId = staged.items[0].id as string
  await app.inject({ method: 'POST', url: '/api/staging/approve', payload: { ids: [itemId] } })

  // Fake the crash window: the row is mid-publish when the process dies.
  ctx.db
    .update(stagingItems)
    .set({ state: 'publishing', ...(publishedMediaId ? { publishedMediaId } : {}) })
    .where(eq(stagingItems.id, itemId))
    .run()
  await app.close()
  ctx.db.$client.close()
  openApp = null
  return itemId
}

describe('boot recovery of interrupted publishes (finding #5)', { timeout: 30_000 }, () => {
  it('flips a stranded publishing row to failed and lets it re-publish through the gate', async () => {
    const itemId = await stageApproveAndCrash(null)

    const { app, ctx } = await boot(tmpDir!)
    const staging = json(await app.inject({ method: 'GET', url: '/api/staging' }))
    const item = staging.items.find((i: { id: string }) => i.id === itemId)
    expect(item.state).toBe('failed')

    // #52: the DTO now carries the failure reason, so the UI can show it.
    expect(item.error).toContain('Interrupted — broker restarted mid-publish')
    const row = ctx.db.select().from(stagingItems).where(eq(stagingItems.id, itemId)).get()!
    expect(row.error).toContain('Interrupted — broker restarted mid-publish')
    expect(row.error).not.toContain('may already be live') // no publishedMediaId recorded

    const audit = json(await app.inject({ method: 'GET', url: '/api/audit' }))
    expect(audit.entries.map((e: { action: string }) => e.action)).toContain(
      'staging.publish-interrupted',
    )

    // Recovery must unblock WITHOUT weakening the gate: failed → publishing is
    // the existing atomic claim, and it succeeds because approval already happened.
    const publish = json(
      await app.inject({ method: 'POST', url: '/api/staging/publish', payload: { ids: [itemId] } }),
    )
    expect(publish.results[0].ok).toBe(true)
    expect(publish.results[0].state).toBe('published')
  })

  it('warns that the media may already be live when publishedMediaId was recorded', async () => {
    const itemId = await stageApproveAndCrash('ghost-media-1')

    const { app, ctx } = await boot(tmpDir!)
    const staging = json(await app.inject({ method: 'GET', url: '/api/staging' }))
    const item = staging.items.find((i: { id: string }) => i.id === itemId)
    expect(item.state).toBe('failed') // NEVER auto-promoted to published

    const row = ctx.db.select().from(stagingItems).where(eq(stagingItems.id, itemId)).get()!
    expect(row.error).toContain('the media may already be live on the store')

    const audit = json(await app.inject({ method: 'GET', url: '/api/audit' }))
    const entry = audit.entries.find(
      (e: { action: string }) => e.action === 'staging.publish-interrupted',
    )
    expect(entry).toBeDefined()
    expect(entry.detail.publishedMediaId).toBe('ghost-media-1')
  })
})
