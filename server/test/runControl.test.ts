import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import type { AppContext } from '../src/context.js'
import { loadEnv } from '../src/env.js'

const json = (res: { payload: string }) => JSON.parse(res.payload)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/** A broker on mock infra (unroutable engines) with a connected demo store. */
async function setup(overrides: Record<string, string | undefined> = {}) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-rc-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({
    DATA_DIR: tmpDir,
    PORT: '0',
    SHOPIFY_API_KEY: undefined as unknown as string,
    COMFY_LOCAL_URL: 'http://127.0.0.1:1',
    COMFY_CLOUD_API_KEY: undefined as unknown as string,
    ...overrides,
  })
  const { app, ctx } = await buildApp(env)
  await app.ready()
  const connect = json(
    await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'demo' } }),
  )
  return { app, ctx, tmpDir, storeId: connect.store.id as string }
}

async function startCatalogRun(app: FastifyInstance, storeId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/runs',
    payload: {
      storeId,
      workflowId: 'builtin:fit-to-768px',
      providerId: 'mock',
      params: {},
      target: { kind: 'catalog' },
    },
  })
  return json(res).run as { id: string }
}

async function teardown(app: FastifyInstance, ctx: AppContext, tmpDir: string, ids: string[]) {
  // Let detached run loops settle before the db file is removed.
  for (let i = 0; i < 60; i++) {
    if (ids.every((id) => TERMINAL.has(ctx.runService.get(id)?.state ?? ''))) break
    await sleep(100)
  }
  await sleep(200)
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
}

describe('run concurrency cap', () => {
  it('runs at most RUN_CONCURRENCY at once; the rest wait queued, then drain', async () => {
    const { app, ctx, tmpDir, storeId } = await setup({ RUN_CONCURRENCY: '1' })
    const stateOf = (id: string) => ctx.runService.get(id)?.state
    const a = await startCatalogRun(app, storeId)
    const b = await startCatalogRun(app, storeId)
    try {
      // Mock edits sleep 250ms+, so A is still on its first item right here.
      expect(stateOf(a.id)).toBe('running')
      expect(stateOf(b.id)).toBe('queued') // the cap held — B waits its turn

      // Free A's slot; the queue must drain and start B.
      await app.inject({ method: 'POST', url: `/api/runs/${a.id}/cancel` })
      for (let i = 0; i < 50 && stateOf(b.id) === 'queued'; i++) await sleep(100)
      expect(stateOf(b.id)).not.toBe('queued') // B left the queue once a slot opened

      await app.inject({ method: 'POST', url: `/api/runs/${b.id}/cancel` })
    } finally {
      await teardown(app, ctx, tmpDir, [a.id, b.id])
    }
  }, 30_000)
})

describe('clearing a run', () => {
  it('refuses an active run, then removes it from history once finished', async () => {
    const { app, ctx, tmpDir, storeId } = await setup({ RUN_CONCURRENCY: '1' })
    const run = await startCatalogRun(app, storeId)
    try {
      // A running run can't be cleared — it must be cancelled first.
      expect(ctx.runService.get(run.id)?.state).toBe('running')
      const blocked = await app.inject({ method: 'DELETE', url: `/api/runs/${run.id}` })
      expect(blocked.statusCode).toBe(400)
      expect(ctx.runService.get(run.id)).not.toBeNull()

      // Cancel, let it settle, then clear it for good.
      await app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` })
      for (let i = 0; i < 50 && !TERMINAL.has(ctx.runService.get(run.id)?.state ?? ''); i++) {
        await sleep(100)
      }
      const cleared = await app.inject({ method: 'DELETE', url: `/api/runs/${run.id}` })
      expect(cleared.statusCode).toBe(200)
      expect(ctx.runService.get(run.id)).toBeNull()

      const list = json(await app.inject({ method: 'GET', url: `/api/runs?storeId=${storeId}` }))
      expect(list.runs.some((r: { id: string }) => r.id === run.id)).toBe(false)
    } finally {
      await teardown(app, ctx, tmpDir, [])
    }
  }, 30_000)
})

describe('graceful shutdown', () => {
  it('marks in-flight runs interrupted', async () => {
    const { app, ctx, tmpDir, storeId } = await setup()
    const run = await startCatalogRun(app, storeId)
    try {
      expect(ctx.runService.get(run.id)?.state).toBe('running')

      ctx.runService.shutdown()

      // Recorded synchronously — boot recovery is only the hard-kill safety net.
      const after = ctx.runService.get(run.id)
      expect(after?.state).toBe('failed')
      expect(after?.items.some((i) => i.state === 'failed')).toBe(true)
    } finally {
      await teardown(app, ctx, tmpDir, [run.id])
    }
  }, 30_000)

  it('awaited shutdown keeps the run interrupted — the executor cannot resume and overwrite it', async () => {
    const { app, ctx, tmpDir, storeId } = await setup()
    const run = await startCatalogRun(app, storeId)
    try {
      expect(ctx.runService.get(run.id)?.state).toBe('running')

      // Await the full drain: the aborted executor unwinds during it. With the
      // regression, it marched through the remaining items (re-issuing work) and
      // flipped the run to 'completed'; the interrupted 'failed' state must win.
      await ctx.runService.shutdown()

      const after = ctx.runService.get(run.id)
      expect(after?.state).toBe('failed') // NOT 'completed' / 'cancelled'
      expect(after?.items.every((i) => i.state !== 'editing')).toBe(true)
    } finally {
      await teardown(app, ctx, tmpDir, [run.id])
    }
  }, 30_000)
})
