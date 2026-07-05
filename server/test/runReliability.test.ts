import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import type { AppContext } from '../src/context.js'
import { loadEnv } from '../src/env.js'
import { isRetryableRunError } from '../src/services/runService.js'

const json = (res: { payload: string }) => JSON.parse(res.payload)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

describe('isRetryableRunError', () => {
  it('retries transient failures', () => {
    expect(isRetryableRunError(new Error('Comfy Cloud responded 503'))).toBe(true)
    // A single hung HTTP request ("timed out after") is transient → retry.
    expect(isRetryableRunError(new Error('Request to x timed out after 30000ms'))).toBe(true)
    expect(isRetryableRunError(new Error('fetch failed'))).toBe(true)
    expect(isRetryableRunError(new Error('The workflow produced no outputs'))).toBe(true)
    expect(isRetryableRunError('a non-Error value')).toBe(true)
  })

  it('does not retry cancellation or terminal failures', () => {
    expect(isRetryableRunError(new Error('Cancelled'))).toBe(false)
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(isRetryableRunError(abort)).toBe(false)
    expect(isRetryableRunError(new Error('Comfy Cloud: insufficient credits'))).toBe(false)
    expect(isRetryableRunError(new Error('Comfy Cloud API key not configured'))).toBe(false)
    expect(isRetryableRunError(new Error('Media no longer exists in the catalog'))).toBe(false)
    expect(isRetryableRunError(new Error('Comfy Cloud job non_retryable_error'))).toBe(false)
    // Hitting the overall job ceiling ("waiting for") is terminal — re-running re-bills.
    expect(
      isRetryableRunError(new Error('Timed out after 15 min waiting for Comfy Cloud to finish')),
    ).toBe(false)
    // The local/remote engine ceiling is terminal too — the engine was
    // interrupted, and a retry would stack a duplicate job (finding #8).
    expect(
      isRetryableRunError(
        new Error(
          'Timed out after 15 min waiting for ComfyUI to finish (raise COMFY_JOB_TIMEOUT_MS for long runs)',
        ),
      ),
    ).toBe(false)
  })
})

let open: { app: FastifyInstance; ctx: AppContext; tmpDir: string } | null = null

afterEach(async () => {
  if (open) {
    await open.app.close()
    rmSync(open.tmpDir, { recursive: true, force: true })
    open = null
  }
})

/** Broker on mock infra with a connected demo store; fast retry backoff. */
async function setup() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-rel-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({
    DATA_DIR: tmpDir,
    PORT: '0',
    RUN_ITEM_RETRY_BASE_MS: '1', // keep the test snappy
    RUN_ITEM_MAX_ATTEMPTS: '3',
  })
  const { app, ctx } = await buildApp(env)
  await app.ready()
  open = { app, ctx, tmpDir }
  const connect = json(
    await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'demo' } }),
  )
  const storeId = connect.store.id as string
  const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
  const product = catalog.products[0]
  return { app, ctx, storeId, productId: product.id as string, mediaId: product.media[0].id as string }
}

async function runOne(app: FastifyInstance, storeId: string, productId: string, mediaId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/runs',
    payload: {
      storeId,
      workflowId: 'builtin:fit-to-768px',
      providerId: 'mock',
      params: {},
      target: { kind: 'selection', inputs: [{ productId, mediaId }] },
    },
  })
  return json(res).run as { id: string }
}

async function waitTerminal(ctx: AppContext, runId: string) {
  for (let i = 0; i < 100; i++) {
    if (TERMINAL.has(ctx.runService.get(runId)?.state ?? '')) break
    await sleep(50)
  }
  return ctx.runService.get(runId)!
}

describe('run-item retry', () => {
  it('recovers a transient provider failure instead of failing the item', async () => {
    const { app, ctx, storeId, productId, mediaId } = await setup()
    const provider = ctx.providers.get('mock')
    const realEdit = provider.edit.bind(provider)
    let calls = 0
    provider.edit = async (req) => {
      calls += 1
      if (calls === 1) throw new Error('Comfy Cloud responded 503') // one transient blip
      return realEdit(req)
    }

    const run = await runOne(app, storeId, productId, mediaId)
    const final = await waitTerminal(ctx, run.id)

    expect(calls).toBe(2) // failed once, retried once, succeeded
    expect(final.state).toBe('completed')
    expect(final.items[0]?.state).toBe('done')
  }, 20_000)

  it('gives up after the attempt ceiling on a persistent transient failure', async () => {
    const { app, ctx, storeId, productId, mediaId } = await setup()
    const provider = ctx.providers.get('mock')
    let calls = 0
    provider.edit = async () => {
      calls += 1
      throw new Error('Comfy Cloud responded 503')
    }

    const run = await runOne(app, storeId, productId, mediaId)
    const final = await waitTerminal(ctx, run.id)

    expect(calls).toBe(3) // RUN_ITEM_MAX_ATTEMPTS
    expect(final.state).toBe('failed')
    expect(final.items[0]?.state).toBe('failed')
  }, 20_000)

  it('does not retry a terminal failure', async () => {
    const { app, ctx, storeId, productId, mediaId } = await setup()
    const provider = ctx.providers.get('mock')
    let calls = 0
    provider.edit = async () => {
      calls += 1
      throw new Error('Comfy Cloud: insufficient credits')
    }

    const run = await runOne(app, storeId, productId, mediaId)
    const final = await waitTerminal(ctx, run.id)

    expect(calls).toBe(1) // terminal — no wasted retries
    expect(final.state).toBe('failed')
    expect(final.items[0]?.error).toContain('insufficient credits')
  }, 20_000)
})
