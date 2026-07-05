import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { loadEnv } from '../src/env.js'
import { BUILTIN_GRAPH_WORKFLOWS } from '../src/workflows/builtin-graphs.js'

let app: FastifyInstance
let tmpDir: string

const json = (res: { payload: string }) => JSON.parse(res.payload)

const USER_GRAPH = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd15.safetensors' } },
  '2': { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  '3': { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: 'studio photo', clip: ['1', 1] } },
  '6': {
    class_type: 'KSampler',
    inputs: { model: ['1', 0], positive: ['4', 0], latent_image: ['3', 0], seed: 7, denoise: 0.5 },
  },
  '9': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'out' } },
}

async function pollRun(runId: string, until: (state: string) => boolean): Promise<unknown> {
  for (let i = 0; i < 120; i++) {
    const { run } = json(await app.inject({ method: 'GET', url: `/api/runs/${runId}` }))
    if (until(run.state)) return run
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('Run did not reach the expected state in time')
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-test-'))
  process.env.LOG_LEVEL = 'silent'
  const env = loadEnv({
    DATA_DIR: tmpDir,
    PORT: '0',
    // No Shopify credentials → mock mode. Unroutable engines → compat unknown.
    SHOPIFY_API_KEY: undefined as unknown as string,
    COMFY_LOCAL_URL: 'http://127.0.0.1:1',
    COMFY_CLOUD_API_KEY: undefined as unknown as string,
  })
  const built = await buildApp(env)
  app = built.app
  await app.ready()
})

afterAll(async () => {
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

// Catalog-scale runs poll real timers — give them room when test files
// share CPU (the default 5s flakes under parallel suite load).
describe('broker API — workflows, runs at catalog scale, and the review gate', { timeout: 30_000 }, () => {
  let storeId: string
  let productId: string
  let mediaId: string
  let beforeUrl: string
  let stagedId: string
  let userWorkflowId: string

  it('connects a demo store instantly in mock mode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/connect/shopify',
      payload: { shop: 'demo-store' },
    })
    expect(res.statusCode).toBe(200)
    const body = json(res)
    expect(body.kind).toBe('connected')
    storeId = body.store.id

    // The suite's catalog-scale expectations count one image per product.
    await app.inject({
      method: 'PATCH',
      url: `/api/stores/${storeId}/scope`,
      payload: { collectionIds: 'all', tags: [], productStatus: 'active', mediaRole: 'featured' },
    })

    const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
    productId = catalog.products[0].id
    mediaId = catalog.products[0].media[0].id
    beforeUrl = catalog.products[0].media[0].url
  })

  it('lists built-in workflows', async () => {
    const { workflows } = json(await app.inject({ method: 'GET', url: '/api/workflows' }))
    const builtins = workflows.filter((w: { source: string }) => w.source === 'builtin')
    // Built-ins are exactly the baked graph workflows.
    expect(builtins.length).toBe(BUILTIN_GRAPH_WORKFLOWS.length)
    expect(builtins.map((w: { id: string }) => w.id)).toContain('builtin:fit-to-768px')
  })

  it('inspects and saves an uploaded workflow with auto-binding', async () => {
    const inspect = json(
      await app.inject({ method: 'POST', url: '/api/workflows/inspect', payload: { graph: USER_GRAPH } }),
    )
    expect(inspect.autoBinding).toEqual({ inputNodeId: '2', outputNodeId: '9' })

    const saved = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Studio restyle',
        graph: USER_GRAPH,
        params: [
          { id: 'prompt', label: 'Prompt', type: 'text', nodeId: '4', inputKey: 'text', defaultValue: 'studio photo' },
        ],
      },
    })
    expect(saved.statusCode).toBe(201)
    const { workflow } = json(saved)
    userWorkflowId = workflow.id
    expect(workflow.source).toBe('user')
    expect(workflow.nodeCount).toBe(6)
    // Engines unreachable in tests → compatibility unknown, never false.
    expect(workflow.compat['comfy-local'].compatible).toBeNull()
    expect(workflow.compat.mock.compatible).toBe(true)
  })

  it('accepts a workflow graph larger than the 1 MB Fastify default', async () => {
    const bigGraph = structuredClone(USER_GRAPH)
    // Inflate the JSON well past 1 MB; the raised bodyLimit must allow it.
    bigGraph['4'].inputs.text = 'x'.repeat(2_000_000)
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { name: 'Big graph', graph: bigGraph },
    })
    expect(res.statusCode).toBe(201)
  })

  it('estimates a catalog target from the scope profile', async () => {
    const estimate = json(
      await app.inject({
        method: 'POST',
        url: '/api/runs/estimate',
        payload: { storeId, target: { kind: 'catalog' } },
      }),
    )
    // Default scope: featured image of each active product.
    expect(estimate.images).toBe(8)
    expect(estimate.products).toBe(8)
  })

  it('runs a user workflow on a selection and stages results as pending', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        storeId,
        workflowId: userWorkflowId,
        providerId: 'mock',
        params: { prompt: 'warm editorial photo' },
        target: { kind: 'selection', inputs: [{ productId, mediaId }] },
        stageAction: 'add-featured',
      },
    })
    expect(res.statusCode).toBe(202)
    const { run } = json(res)
    expect(run.workflowName).toBe('Studio restyle')

    const finished = (await pollRun(run.id, (s) => s === 'completed' || s === 'failed')) as {
      state: string
      items: Array<{ state: string; afterUrl: string }>
    }
    expect(finished.state).toBe('completed')
    expect(finished.items[0]!.state).toBe('done')
    expect(finished.items[0]!.afterUrl).toContain('recipe=workflow')

    const staging = json(await app.inject({ method: 'GET', url: '/api/staging' }))
    expect(staging.counts.pending).toBe(1)
    stagedId = staging.items[0].id
    expect(staging.items[0].runId).toBe(run.id)
    expect(staging.items[0].source).toBe('api') // no web header → headless
    // Provenance: the staged item records exactly which media the run edited.
    expect(staging.items[0].sourceMediaId).toBe(mediaId)
  })

  it('THE GATE: refuses to publish a pending item, even from a run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/staging/publish',
      payload: { ids: [stagedId] },
    })
    const { results } = json(res)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('approval is mandatory')
  })

  it('approve → publish adds the result as featured and keeps the prior; revert removes it', async () => {
    await app.inject({ method: 'POST', url: '/api/staging/approve', payload: { ids: [stagedId] } })
    const publish = json(
      await app.inject({ method: 'POST', url: '/api/staging/publish', payload: { ids: [stagedId] } }),
    )
    expect(publish.results[0].state).toBe('published')

    let catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
    let product = catalog.products.find((p: { id: string }) => p.id === productId)
    // The result now occupies the featured slot (default scope shows featured).
    expect(product.media[0].url).toContain('recipe=workflow')

    const revert = json(
      await app.inject({ method: 'POST', url: '/api/staging/revert', payload: { ids: [stagedId] } }),
    )
    expect(revert.results[0].ok).toBe(true)

    catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
    product = catalog.products.find((p: { id: string }) => p.id === productId)
    expect(product.media[0].url).toBe(beforeUrl)
  })

  it('cuts a representative sample from a catalog run and promotes the remainder', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        storeId,
        workflowId: 'builtin:fit-to-768px',
        providerId: 'mock',
        params: { mood: 'golden-hour' },
        target: { kind: 'catalog' },
        sampleSize: 3,
      },
    })
    const { run } = json(res)
    expect(run.sample).toBe(true)
    expect(run.sampleOfTotal).toBe(8)
    expect(run.items).toHaveLength(3)
    // Spread across distinct products, not 3 images of one product.
    const products = new Set(run.items.map((i: { input: { productId: string } }) => i.input.productId))
    expect(products.size).toBe(3)

    await pollRun(run.id, (s) => s === 'completed')

    const promoted = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/promote` })
    expect(promoted.statusCode).toBe(202)
    const { run: fullRun } = json(promoted)
    expect(fullRun.sample).toBe(false)
    expect(fullRun.items).toHaveLength(5) // 8 in catalog − 3 already sampled
    await pollRun(fullRun.id, (s) => s === 'completed')
  })

  it('cancels a running catalog run mid-flight', async () => {
    const { run } = json(
      await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          storeId,
          workflowId: 'builtin:fit-to-768px',
          providerId: 'mock',
          params: {},
          target: { kind: 'catalog' },
        },
      }),
    )
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` })
    const finished = (await pollRun(run.id, (s) => s !== 'queued' && s !== 'running')) as {
      state: string
      items: Array<{ state: string }>
    }
    expect(finished.state).toBe('cancelled')
    expect(finished.items.some((i) => i.state === 'pending')).toBe(true)
  })

  it('retries a cancelled run as a fresh run covering the unfinished items', async () => {
    const { run } = json(
      await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          storeId,
          workflowId: 'builtin:fit-to-768px',
          providerId: 'mock',
          params: {},
          target: { kind: 'catalog' },
        },
      }),
    )
    // Retrying an active run is refused.
    const early = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/retry` })
    expect(early.statusCode).toBe(400)

    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` })
    const cancelled = (await pollRun(run.id, (s) => s !== 'queued' && s !== 'running')) as {
      items: Array<{ state: string }>
    }
    const unfinished = cancelled.items.filter((i) => i.state !== 'done').length
    expect(unfinished).toBeGreaterThan(0)

    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/retry` })
    expect(res.statusCode).toBe(202)
    const { run: retried } = json(res)
    expect(retried.id).not.toBe(run.id)
    expect(retried.items).toHaveLength(unfinished)

    const finished = (await pollRun(retried.id, (s) => s === 'completed')) as {
      items: Array<{ state: string }>
    }
    expect(finished.items.every((i) => i.state === 'done')).toBe(true)

    // A fully completed run has nothing left to retry.
    const empty = await app.inject({ method: 'POST', url: `/api/runs/${retried.id}/retry` })
    expect(empty.statusCode).toBe(400)
  })

  it('records runs and workflow uploads in the audit trail', async () => {
    const audit = json(await app.inject({ method: 'GET', url: '/api/audit' }))
    const actions = audit.entries.map((e: { action: string }) => e.action)
    expect(actions).toContain('workflow.upload')
    expect(actions).toContain('run.created')
    expect(actions).toContain('run.promoted')
    expect(actions).toContain('staging.publish')
  })

  it('staged items record which media each result came from', async () => {
    // The suite scope is featured-only, so read the product's FULL media list
    // through the gallery editor (connector-level, unfiltered). products[0]
    // is the linen tee — a 3-image demo product.
    const gallery = json(
      await app.inject({
        method: 'GET',
        url: `/api/staging/gallery?storeId=${storeId}&productId=${productId}`,
      }),
    )
    const media = gallery.media as Array<{ id: string; url: string }>
    expect(media.length).toBeGreaterThanOrEqual(3)

    // Run over TWO distinct media of the same product — the #6 shape where
    // productId alone can no longer identify the source.
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        storeId,
        workflowId: 'builtin:fit-to-768px',
        providerId: 'mock',
        params: {},
        target: {
          kind: 'selection',
          inputs: [
            { productId, mediaId: media[0]!.id },
            { productId, mediaId: media[2]!.id },
          ],
        },
        stageAction: 'replace-position',
      },
    })
    expect(res.statusCode).toBe(202)
    const { run } = json(res)
    await pollRun(run.id, (s) => s === 'completed')

    const staging = json(await app.inject({ method: 'GET', url: '/api/staging' }))
    const staged = staging.items.filter((i: { runId: string | null }) => i.runId === run.id) as Array<{
      sourceMediaId: string | null
      beforeUrl: string
    }>
    expect(staged).toHaveLength(2)
    // Each staged item carries the exact media it came from…
    expect(new Set(staged.map((i) => i.sourceMediaId))).toEqual(
      new Set([media[0]!.id, media[2]!.id]),
    )
    // …and its beforeUrl is that media's own URL — two distinct sources.
    for (const item of staged) {
      const source = media.find((m) => m.id === item.sourceMediaId)!
      expect(item.beforeUrl).toBe(source.url)
    }
    expect(staged[0]!.beforeUrl).not.toBe(staged[1]!.beforeUrl)
  })
})
