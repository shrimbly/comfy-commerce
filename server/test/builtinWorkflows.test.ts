import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import type { AppContext } from '../src/context.js'
import { loadEnv } from '../src/env.js'
import { BUILTIN_GRAPH_WORKFLOWS } from '../src/workflows/builtin-graphs.js'
import { getBuiltin } from '../src/workflows/builtins.js'

let app: FastifyInstance
let ctx: AppContext
let tmpDir: string

const json = (res: { payload: string }) => JSON.parse(res.payload)

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-builtins-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({ DATA_DIR: tmpDir, PORT: '0' })
  ;({ app, ctx } = await buildApp(env))
  await app.ready()
})

afterAll(async () => {
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('baked graph built-in workflows', () => {
  it('has baked workflows to test', () => {
    // A fresh DB has no user rows, so these come purely from code.
    expect(BUILTIN_GRAPH_WORKFLOWS.length).toBeGreaterThan(0)
  })

  it('lists every baked graph as a built-in (source: builtin)', async () => {
    const { workflows } = json(await app.inject({ method: 'GET', url: '/api/workflows' }))
    for (const baked of BUILTIN_GRAPH_WORKFLOWS) {
      const found = workflows.find((w: { id: string }) => w.id === baked.id)
      expect(found, baked.id).toBeTruthy()
      expect(found.source).toBe('builtin')
    }
  })

  it('seeds every built-in fixed-input reference image so runs can resolve them', async () => {
    // Regression: baked built-ins (e.g. the T-Shirt shoot) reference fixed
    // images by asset id. On a fresh DATA_DIR those bytes must be seeded from
    // the shipped web/public/builtins/assets, or toExecution throws "Fixed
    // reference image … is missing" and the run fails with no item-level error.
    const withFixed = BUILTIN_GRAPH_WORKFLOWS.filter((w) => (w.fixedInputs ?? []).length > 0)
    expect(withFixed.length, 'expected at least one built-in with fixed inputs').toBeGreaterThan(0)
    for (const wf of withFixed) {
      for (const fixed of wf.fixedInputs) {
        const asset = await ctx.assetStore.read(fixed.assetId)
        expect(asset?.bytes.length, `${wf.id} / ${fixed.label} (${fixed.assetId})`).toBeGreaterThan(0)
      }
    }
  })

  it('resolves a legacy (old DB) id to the canonical built-in', () => {
    for (const baked of BUILTIN_GRAPH_WORKFLOWS) {
      expect(getBuiltin(baked.legacyId)?.id).toBe(baked.id)
    }
  })

  it('downloads each baked built-in as a loadable ComfyUI workflow (never empty)', async () => {
    for (const baked of BUILTIN_GRAPH_WORKFLOWS) {
      const res = await app.inject({ method: 'GET', url: `/api/workflows/${baked.id}/download` })
      expect(res.statusCode, baked.id).toBe(200)
      expect(res.headers['content-disposition']).toContain('.json')
      // Editor format (`nodes` array) — what ComfyUI's Load expects; never empty.
      const body = json(res)
      expect(Array.isArray(body.nodes), baked.id).toBe(true)
      expect(body.nodes.length, baked.id).toBeGreaterThan(0)
    }
  })

  it('cannot be edited or deleted', async () => {
    const id = BUILTIN_GRAPH_WORKFLOWS[0]!.id
    expect((await app.inject({ method: 'DELETE', url: `/api/workflows/${id}` })).statusCode).toBe(400)
    expect(
      (await app.inject({ method: 'PATCH', url: `/api/workflows/${id}`, payload: { name: 'x' } }))
        .statusCode,
    ).toBe(400)
  })

  it('runs a baked graph built-in end-to-end via the mock engine', async () => {
    const { store } = json(
      await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'builtins-demo' } }),
    )
    const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${store.id}/catalog` }))
    const product = catalog.products[0]

    const { run } = json(
      await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          storeId: store.id,
          workflowId: BUILTIN_GRAPH_WORKFLOWS[0]!.id,
          providerId: 'mock',
          params: {},
          target: { kind: 'selection', inputs: [{ productId: product.id, mediaId: product.media[0].id }] },
          stageAction: 'add-featured',
        },
      }),
    )
    let state = run.state
    for (let i = 0; i < 100 && state !== 'completed' && state !== 'failed'; i++) {
      const { run: fresh } = json(await app.inject({ method: 'GET', url: `/api/runs/${run.id}` }))
      state = fresh.state
      if (state === 'completed' || state === 'failed') break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(state).toBe('completed')
  })
})
