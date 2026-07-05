import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp, type BuildAppResult } from '../src/app.js'
import { runs } from '../src/db/schema.js'
import { loadEnv } from '../src/env.js'

let app: FastifyInstance
let ctx: BuildAppResult['ctx']
let tmpDir: string
let storeId: string
let selection: Array<{ productId: string; mediaId: string }>

const json = (res: { payload: string }) => JSON.parse(res.payload)

async function pollRun(runId: string, until: (state: string) => boolean) {
  for (let i = 0; i < 120; i++) {
    const { run } = json(await app.inject({ method: 'GET', url: `/api/runs/${runId}` }))
    if (until(run.state)) return run
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('Run did not reach the expected state in time')
}

async function startSampleRun(target: Record<string, unknown>, sampleSize: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/runs',
    payload: {
      storeId,
      workflowId: 'builtin:fit-to-768px',
      providerId: 'mock',
      params: {},
      target,
      sampleSize,
    },
  })
  expect(res.statusCode).toBe(202)
  return json(res).run as {
    id: string
    sample: boolean
    items: Array<{ input: { productId: string; mediaId: string }; state: string }>
  }
}

/** Null out the persisted target, simulating a run created before the migration. */
function makeLegacy(runId: string): void {
  ctx.db.update(runs).set({ target: null }).where(eq(runs.id, runId)).run()
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-promote-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({
    DATA_DIR: tmpDir,
    PORT: '0',
    SHOPIFY_API_KEY: undefined as unknown as string,
    COMFY_LOCAL_URL: 'http://127.0.0.1:1',
    COMFY_CLOUD_API_KEY: undefined as unknown as string,
  })
  ;({ app, ctx } = await buildApp(env))
  await app.ready()

  const connect = json(
    await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'promote-demo' } }),
  )
  storeId = connect.store.id

  // Two media from each of two multi-image products — 4 refs across 2 products.
  const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
  const multi = (catalog.products as Array<{ id: string; media: Array<{ id: string }> }>).filter(
    (p) => p.media.length >= 2,
  )
  expect(multi.length).toBeGreaterThanOrEqual(2)
  selection = multi
    .slice(0, 2)
    .flatMap((p) => p.media.slice(0, 2).map((m) => ({ productId: p.id, mediaId: m.id })))
  expect(selection).toHaveLength(4)
})

afterAll(async () => {
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('promoting a selection sample (finding #2)', { timeout: 30_000 }, () => {
  it('promotes to the remaining selection items — the exact flow that used to 400', async () => {
    const run = await startSampleRun({ kind: 'selection', inputs: selection }, 2)
    expect(run.sample).toBe(true)
    expect(run.items).toHaveLength(2)
    await pollRun(run.id, (s) => s === 'completed')

    const doneIds = new Set(
      json(await app.inject({ method: 'GET', url: `/api/runs/${run.id}` })).run.items.map(
        (i: { input: { mediaId: string } }) => i.input.mediaId,
      ),
    )

    const promoted = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/promote` })
    expect(promoted.statusCode).toBe(202)
    const { run: fullRun } = json(promoted)
    expect(fullRun.sample).toBe(false)
    expect(fullRun.items).toHaveLength(2) // 4 selected − 2 sampled

    const selectedIds = new Set(selection.map((s) => s.mediaId))
    for (const item of fullRun.items as Array<{ input: { mediaId: string } }>) {
      expect(selectedIds.has(item.input.mediaId)).toBe(true) // stays inside the selection
      expect(doneIds.has(item.input.mediaId)).toBe(false) //   skips what the sample covered
    }
    await pollRun(fullRun.id, (s) => s === 'completed')
  })

  it('refuses a legacy null-target selection sample with an honest 400', async () => {
    const run = await startSampleRun({ kind: 'selection', inputs: selection.slice(0, 3) }, 2)
    await pollRun(run.id, (s) => s === 'completed')
    makeLegacy(run.id)

    const promoted = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/promote` })
    expect(promoted.statusCode).toBe(400)
    expect(json(promoted).error).toContain('predates target persistence')
    expect(json(promoted).error).not.toContain('Nothing left to run')
  })

  it('still promotes a legacy null-target catalog sample (kind alone suffices)', async () => {
    const run = await startSampleRun({ kind: 'catalog' }, 2)
    await pollRun(run.id, (s) => s === 'completed')
    makeLegacy(run.id)

    const promoted = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/promote` })
    expect(promoted.statusCode).toBe(202)
    const { run: fullRun } = json(promoted)
    expect(fullRun.items.length).toBeGreaterThan(0)
    await pollRun(fullRun.id, (s) => s === 'completed')
  })
})
