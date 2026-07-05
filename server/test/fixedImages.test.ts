import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { loadEnv } from '../src/env.js'
import { buildExecutionGraph, uploadFixedImages } from '../src/providers/comfyGraph.js'
import type { WorkflowExecution } from '../src/providers/types.js'

const json = (res: { payload: string }) => JSON.parse(res.payload)

/** Product image (node 2) + a fixed reference image (node 20) → one output. */
const TWO_INPUT_GRAPH = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd15.safetensors' } },
  '2': { class_type: 'LoadImage', inputs: { image: 'product.png' } },
  '20': { class_type: 'LoadImage', inputs: { image: 'old-model.png' } },
  '3': { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: 'studio photo', clip: ['1', 1] } },
  '6': {
    class_type: 'KSampler',
    inputs: { model: ['1', 0], positive: ['4', 0], latent_image: ['3', 0], seed: 7, denoise: 0.5 },
  },
  '9': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'out' } },
}

describe('fixed reference images — graph binding', () => {
  it('uploads each fixed image and binds product + fixed nodes', async () => {
    const execution: WorkflowExecution = {
      kind: 'graph',
      graph: TWO_INPUT_GRAPH,
      inputNodeId: '2',
      outputNodeId: '9',
      assignments: [],
      fixedImages: [
        { nodeId: '20', bytes: Buffer.from('model-bytes'), mimeType: 'image/png', filename: 'model.png' },
      ],
      workflowKey: 'abcd1234',
    }

    const uploaded: string[] = []
    const bound = await uploadFixedImages(execution, async (bytes, filename, mimeType) => {
      uploaded.push(`${filename}:${mimeType}:${bytes.length}`)
      return `engine-${filename}`
    })
    expect(uploaded).toEqual(['model.png:image/png:11'])
    expect(bound).toEqual([{ nodeId: '20', imageName: 'engine-model.png' }])

    const graph = (await buildExecutionGraph(execution, {
      imageName: 'uploaded-product.png',
      fixedImages: bound,
      seedKey: 'seed-key',
      resolveCheckpoint: async () => 'sd15.safetensors',
    })) as typeof TWO_INPUT_GRAPH

    // Product node gets the per-run image; the fixed node gets its constant.
    expect(graph['2'].inputs.image).toBe('uploaded-product.png')
    expect(graph['20'].inputs.image).toBe('engine-model.png')
  })

  it('is a no-op for caption executions', async () => {
    const caption: WorkflowExecution = { kind: 'caption', model: 'm', prompt: 'p', workflowKey: 'k' }
    expect(await uploadFixedImages(caption, async () => 'never')).toEqual([])
  })
})

describe('fixed reference images — save, validate, run', () => {
  let app: FastifyInstance
  let tmpDir: string
  let storeId: string
  let productId: string
  let mediaId: string
  let assetId: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-fixed-'))
    process.env.LOG_LEVEL = 'silent'
    const env = loadEnv({
      DATA_DIR: tmpDir,
      PORT: '0',
      SHOPIFY_API_KEY: undefined as unknown as string,
      COMFY_LOCAL_URL: 'http://127.0.0.1:1',
      COMFY_CLOUD_API_KEY: undefined as unknown as string,
    })
    app = (await buildApp(env)).app
    await app.ready()

    const connected = json(
      await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'demo-store' } }),
    )
    storeId = connected.store.id
    const catalog = json(await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` }))
    productId = catalog.products[0].id
    mediaId = catalog.products[0].media[0].id

    // Stand in a reference image into the asset store.
    const asset = json(
      await app.inject({
        method: 'POST',
        url: '/api/assets',
        payload: { contentType: 'image/png', data: Buffer.from('model-reference').toString('base64') },
      }),
    )
    assetId = asset.id
  })

  afterAll(async () => {
    await app.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const save = (fixedInputs: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Model try-on',
        graph: TWO_INPUT_GRAPH,
        inputNodeId: '2',
        outputNodeId: '9',
        fixedInputs,
      },
    })

  it('persists a fixed input on a two-LoadImage workflow', async () => {
    const res = await save([{ nodeId: '20', assetId, label: 'Model reference' }])
    expect(res.statusCode).toBe(201)
    const { workflow } = json(res)
    expect(workflow.fixedInputs).toEqual([{ nodeId: '20', assetId, label: 'Model reference' }])
  })

  it('rejects a fixed input on the product node', async () => {
    const res = await save([{ nodeId: '2', assetId }])
    expect(res.statusCode).toBe(422)
    expect(json(res).error).toContain('product input node')
  })

  it('rejects a fixed input on a non-image node', async () => {
    const res = await save([{ nodeId: '6', assetId }])
    expect(res.statusCode).toBe(422)
    expect(json(res).error).toContain('not a LoadImage')
  })

  it('resolves the fixed asset and completes the run', async () => {
    const { workflow } = json(await save([{ nodeId: '20', assetId }]))
    const { run } = json(
      await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          storeId,
          workflowId: workflow.id,
          providerId: 'mock',
          target: { kind: 'selection', inputs: [{ productId, mediaId }] },
          stageAction: 'add-new',
        },
      }),
    )
    let state = run.state
    for (let i = 0; i < 120 && state !== 'completed' && state !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 100))
      state = json(await app.inject({ method: 'GET', url: `/api/runs/${run.id}` })).run.state
    }
    expect(state).toBe('completed')
  })

  it('fails the run with a clear error when a fixed asset is missing', async () => {
    const { workflow } = json(await save([{ nodeId: '20', assetId: 'does-not-exist' }]))
    const { run } = json(
      await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          storeId,
          workflowId: workflow.id,
          providerId: 'mock',
          target: { kind: 'selection', inputs: [{ productId, mediaId }] },
          stageAction: 'add-new',
        },
      }),
    )
    let finished = run
    for (let i = 0; i < 120 && finished.state !== 'completed' && finished.state !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 100))
      finished = json(await app.inject({ method: 'GET', url: `/api/runs/${run.id}` })).run
    }
    expect(finished.state).toBe('failed')
    expect(finished.error).toContain('missing')
  })
})
