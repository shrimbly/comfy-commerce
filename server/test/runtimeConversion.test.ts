import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { buildApp, type BuildAppResult } from '../src/app.js'
import { loadEnv } from '../src/env.js'

let app: FastifyInstance
let ctx: BuildAppResult['ctx']
let tmpDir: string

/** Same node class, but the engines disagree on its widget names/order. */
const LOCAL_CATALOG = {
  LoadImage: { input: { required: { image: [['a.png'], { image_upload: true }] } } },
  TestEffect: {
    input: {
      required: {
        image: ['IMAGE', {}],
        strength: ['INT', { default: 1 }],
        mode: [['soft', 'hard'], {}],
      },
    },
  },
  SaveImage: { input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', {}] } } },
}

const CLOUD_CATALOG = {
  ...LOCAL_CATALOG,
  TestEffect: {
    input: {
      required: {
        image: ['IMAGE', {}],
        intensity: ['INT', { default: 1 }],
        mode: [['soft', 'hard'], {}],
      },
    },
  },
}

const EDITOR_FILE = {
  nodes: [
    { id: 1, type: 'LoadImage', widgets_values: ['a.png', 'image'] },
    {
      id: 2,
      type: 'TestEffect',
      inputs: [{ name: 'image', type: 'IMAGE', link: 1 }],
      widgets_values: [5, 'soft'],
    },
    {
      id: 3,
      type: 'SaveImage',
      inputs: [{ name: 'images', type: 'IMAGE', link: 2 }],
      widgets_values: ['out'],
    },
  ],
  links: [
    [1, 1, 0, 2, 0, 'IMAGE'],
    [2, 2, 0, 3, 0, 'IMAGE'],
  ],
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-test-'))
  process.env.LOG_LEVEL = 'silent'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (!url.includes('/object_info')) throw new Error(`Unexpected fetch: ${url}`)
      const catalog = url.includes('local.test') ? LOCAL_CATALOG : CLOUD_CATALOG
      return new Response(JSON.stringify(catalog), {
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  const env = loadEnv({
    DATA_DIR: tmpDir,
    PORT: '0',
    SHOPIFY_API_KEY: undefined as unknown as string,
    COMFY_LOCAL_URL: 'http://local.test',
    COMFY_CLOUD_API_KEY: 'test-key',
  })
  ;({ app, ctx } = await buildApp(env))
  await app.ready()
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await app.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('run-time re-conversion of editor-format workflows', () => {
  let workflowId: string

  it('stores the raw editor file alongside the upload-time conversion', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { name: 'Effect test', graph: EDITOR_FILE },
    })
    expect(res.statusCode).toBe(201)
    workflowId = JSON.parse(res.payload).workflow.id

    // Upload-time conversion uses the merged catalog with local first.
    const resolved = ctx.workflowService.resolve(workflowId)
    if (resolved.execution.kind !== 'graph') throw new Error('expected graph execution')
    expect(resolved.execution.graph['2']!.inputs).toMatchObject({ strength: 5, mode: 'soft' })
  })

  it('re-converts for the executing engine — its node specs win', async () => {
    const resolved = await ctx.workflowService.resolveForRun(workflowId, 'comfy-cloud')
    if (resolved.execution.kind !== 'graph') throw new Error('expected graph execution')
    // Cloud's TestEffect names the widget `intensity`, not `strength`.
    expect(resolved.execution.graph['2']!.inputs).toMatchObject({ intensity: 5, mode: 'soft' })
    expect(resolved.execution.graph['2']!.inputs.strength).toBeUndefined()
  })

  it('falls back to the upload-time conversion when no engine is reachable', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'))
    const resolved = await ctx.workflowService.resolveForRun(workflowId, 'comfy-local')
    if (resolved.execution.kind !== 'graph') throw new Error('expected graph execution')
    expect(resolved.execution.graph['2']!.inputs).toMatchObject({ strength: 5, mode: 'soft' })
  })
})
