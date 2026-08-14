/**
 * Comfy Cloud provider over @comfyorg/sdk, driven against a stand-in Comfy
 * API v2 server.
 *
 * Deliberately a real HTTP server rather than a stubbed fetch: it exercises
 * the SDK's actual transport — multipart asset upload, the blake3 dedup probe,
 * `core/ASSET` substitution, idempotency headers, poll-to-terminal, and the
 * typed error envelope — instead of a mock of what we assume it does.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ComfyCloudProvider, POLL_FAILURE_TOLERANCE } from '../src/providers/comfyCloud.js'
import { contentTypeForOutput, mediaTypeForOutput } from '../src/providers/comfySdk.js'
import type { WorkflowExecution } from '../src/providers/types.js'
import type { AssetStore } from '../src/services/assetStore.js'
import { isRetryableRunError } from '../src/services/runService.js'

// 1×1 transparent PNG — a real image body for the input fetch.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const OUTPUT_BYTES = Buffer.from('rendered-image-bytes')

const GRAPH = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd15.safetensors' } },
  '2': { class_type: 'LoadImage', inputs: { image: 'product.png' } },
  '20': { class_type: 'LoadImage', inputs: { image: 'reference.png' } },
  '6': { class_type: 'KSampler', inputs: { model: ['1', 0], latent_image: ['2', 0], seed: 7 } },
  '9': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'out' } },
}

const execution = (): WorkflowExecution => ({
  kind: 'graph',
  graph: structuredClone(GRAPH),
  inputNodeId: '2',
  outputNodeId: '9',
  assignments: [],
  fixedImages: [
    { nodeId: '20', bytes: Buffer.from('reference-bytes'), mimeType: 'image/png', filename: 'ref.png' },
  ],
  workflowKey: 'wf-key',
})

/** One committed output, in the v2 shape. */
const output = (over: Record<string, unknown> = {}) => ({
  node_id: '9',
  name: 'ComfyUI_00001_.png',
  type: 'image',
  content_type: 'image/png',
  size_bytes: OUTPUT_BYTES.length,
  id: 'asset-out-1',
  hash: null,
  url: 'about:blank',
  url_expires_at: new Date(Date.now() + 60_000).toISOString(),
  ...over,
})

/** What the stand-in server should do for the next call. Reset per test. */
let scenario: {
  /** Server already holds these bytes — the dedup fast path. */
  assetKnown: boolean
  /** Non-201 submit response, as `[status, errorCode, message]`. */
  submitError: [number, string, string] | null
  /** Terminal job state and payload. */
  jobStatus: string
  jobError: Record<string, unknown> | null
  outputs: Array<Record<string, unknown>>
  /** Force `GET /jobs/:id` to keep answering `running` — exercises the ceiling. */
  neverFinishes: boolean
  /** Drop this many status polls (503) before answering normally. */
  pollFailures: number
  /** Status for the availability probe's `GET /jobs/:id`. */
  probeStatus: number
}

/** Everything the server saw, for assertions. */
let seen: {
  uploads: number
  fromHash: number
  submits: Array<Record<string, any>>
  idempotencyKeys: string[]
  cancels: string[]
}

let server: Server
let base: string

const readBody = (req: import('node:http').IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const fail = (res: import('node:http').ServerResponse, status: number, code: string, message: string) =>
  send(res, status, { error: { code, message } })

const jobPayload = (id: string, status: string) => ({
  id,
  status,
  created_at: new Date().toISOString(),
  started_at: null,
  completed_at: null,
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  queue_position: null,
  progress: null,
  outputs: status === 'succeeded' ? scenario.outputs : [],
  error: status === 'failed' ? scenario.jobError : null,
  urls: {
    self: `/api/v2/jobs/${id}`,
    events: `/api/v2/jobs/${id}/events`,
    cancel: `/api/v2/jobs/${id}/cancel`,
  },
})

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = req.url ?? ''
    const method = req.method ?? 'GET'

    if (method === 'GET' && url === '/img.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
      return
    }

    // -- assets ------------------------------------------------------------
    if (method === 'HEAD' && url.startsWith('/api/v2/assets/by-hash/')) {
      res.writeHead(scenario.assetKnown ? 200 : 404)
      res.end()
      return
    }
    if (method === 'POST' && url === '/api/v2/assets/from-hash') {
      await readBody(req)
      seen.fromHash += 1
      send(res, 200, {
        id: 'asset-in-1',
        hash: 'blake3:deadbeef',
        size_bytes: PNG.length,
        content_type: 'image/png',
        created_new: false,
        created_at: new Date().toISOString(),
        url: 'about:blank',
        url_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      return
    }
    if (method === 'POST' && url === '/api/v2/assets') {
      const body = await readBody(req)
      seen.uploads += 1
      // The multipart body must carry the metadata parts before the file part.
      expect(body.toString('latin1')).toContain('name="content_type"')
      expect(body.toString('latin1')).toContain('name="file"')
      send(res, 201, {
        id: `asset-in-${seen.uploads}`,
        hash: 'blake3:deadbeef',
        size_bytes: body.length,
        content_type: 'image/png',
        created_new: true,
        created_at: new Date().toISOString(),
        url: 'about:blank',
        url_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      return
    }
    if (method === 'GET' && /^\/api\/v2\/assets\/[^/]+\/content$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(OUTPUT_BYTES)
      return
    }

    // -- jobs --------------------------------------------------------------
    if (method === 'POST' && url === '/api/v2/jobs') {
      const body = await readBody(req)
      seen.submits.push(JSON.parse(body.toString('utf8')))
      const key = req.headers['idempotency-key']
      if (typeof key === 'string') seen.idempotencyKeys.push(key)
      if (scenario.submitError) {
        const [status, code, message] = scenario.submitError
        fail(res, status, code, message)
        return
      }
      send(res, 201, jobPayload('job-1', 'queued'))
      return
    }
    const cancelMatch = /^\/api\/v2\/jobs\/([^/]+)\/cancel$/.exec(url)
    if (method === 'POST' && cancelMatch) {
      await readBody(req)
      seen.cancels.push(cancelMatch[1]!)
      send(res, 200, jobPayload(cancelMatch[1]!, 'canceled'))
      return
    }
    const jobMatch = /^\/api\/v2\/jobs\/([^/]+)$/.exec(url)
    if (method === 'GET' && jobMatch) {
      const id = jobMatch[1]!
      if (id === '00000000-0000-0000-0000-000000000000') {
        if (scenario.probeStatus === 200) {
          send(res, 200, jobPayload(id, 'succeeded'))
        } else if (scenario.probeStatus === 401) {
          fail(res, 401, 'unauthorized', 'Invalid API key')
        } else {
          fail(res, 404, 'job_not_found', 'Job not found')
        }
        return
      }
      if (scenario.pollFailures > 0) {
        scenario.pollFailures -= 1
        fail(res, 503, 'error', 'Service Unavailable')
        return
      }
      send(res, 200, jobPayload(id, scenario.neverFinishes ? 'running' : scenario.jobStatus))
      return
    }

    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  scenario = {
    assetKnown: false,
    submitError: null,
    jobStatus: 'succeeded',
    jobError: null,
    outputs: [output()],
    neverFinishes: false,
    pollFailures: 0,
    probeStatus: 404,
  }
  seen = { uploads: 0, fromHash: 0, submits: [], idempotencyKeys: [], cancels: [] }
})

const saved: Array<{ bytes: Buffer; contentType: string }> = []
const assetStore = {
  async save(bytes: Buffer, contentType: string) {
    saved.push({ bytes, contentType })
    return { id: `local-${saved.length}`, url: `/assets/local-${saved.length}` }
  },
} as unknown as AssetStore

const provider = (over: Partial<{ apiKey: string | null; jobTimeoutMs: number }> = {}) =>
  new ComfyCloudProvider({
    apiUrl: base,
    resolveApiKey: () => (over.apiKey === undefined ? 'test-key' : over.apiKey),
    jobTimeoutMs: over.jobTimeoutMs ?? 60_000,
    assetStore,
  })

/** Await a call that must reject, and hand back the error it threw. */
const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  let error: unknown
  try {
    await promise
  } catch (err) {
    error = err
  }
  expect(error).toBeInstanceOf(Error)
  return error as Error
}

const editRequest = () => ({
  imageUrl: `${base}/img.png`,
  altText: 'a product',
  workflow: execution(),
  seedKey: 'seed-1',
})

describe('ComfyCloudProvider on @comfyorg/sdk — edit', () => {
  it('uploads inputs as assets, submits the graph, and takes custody of the outputs', async () => {
    saved.length = 0
    const result = await provider().edit(editRequest())

    // Product image + one fixed reference image, each uploaded once.
    expect(seen.uploads).toBe(2)

    const [submitted] = seen.submits
    expect(submitted).toBeDefined()
    // Bound image inputs are `core/ASSET` references, not filenames.
    expect(submitted!.workflow['2'].inputs.image).toEqual({
      __type: 'core/ASSET',
      info: expect.objectContaining({ id: expect.stringMatching(/^asset-in-/) }),
    })
    expect(submitted!.workflow['20'].inputs.image.__type).toBe('core/ASSET')
    // Partner/API nodes authenticate from extra_data, not the request headers.
    expect(submitted!.extra_data).toEqual({ api_key_comfy_org: 'test-key' })
    // A resend of the same request can't enqueue a second billable job.
    expect(seen.idempotencyKeys).toHaveLength(1)

    expect(result.outputs).toEqual([{ url: '/assets/local-1', mediaType: 'image' }])
    expect(saved[0]!.bytes.equals(OUTPUT_BYTES)).toBe(true)
    expect(saved[0]!.contentType).toBe('image/png')
  })

  it('skips the upload when the platform already holds the bytes', async () => {
    scenario.assetKnown = true
    await provider().edit(editRequest())
    expect(seen.uploads).toBe(0)
    expect(seen.fromHash).toBe(2) // minted over existing bytes instead
  })

  it('stages video and 3D outputs by their v2 output kind', async () => {
    scenario.outputs = [
      output({ id: 'a1', name: 'clip.mp4', type: 'video', content_type: 'video/mp4' }),
      output({ id: 'a2', name: 'mesh.glb', type: 'file', content_type: 'model/gltf-binary' }),
    ]
    const result = await provider().edit(editRequest())
    expect(result.outputs.map((o) => o.mediaType)).toEqual(['video', 'model3d'])
  })

  it('stores by filename when the server sends no content type', async () => {
    // Verified live: Comfy Cloud returns content_type "" for a SaveImage
    // output. Storing that verbatim would leave the asset unservable.
    saved.length = 0
    scenario.outputs = [output({ content_type: '' })]
    const result = await provider().edit(editRequest())
    expect(saved[0]!.contentType).toBe('image/png')
    expect(result.outputs[0]!.mediaType).toBe('image')
  })

  it('ignores non-media outputs and fails when nothing stageable is produced', async () => {
    scenario.outputs = [output({ id: 'a3', name: 'note.txt', type: 'text', content_type: 'text/plain' })]
    await expect(provider().edit(editRequest())).rejects.toThrow(/completed with no outputs/)
  })

  it('refuses to run without a key, before any network call', async () => {
    await expect(provider({ apiKey: null }).edit(editRequest())).rejects.toThrow(
      /API key not configured/,
    )
    expect(seen.submits).toHaveLength(0)
  })
})

describe('ComfyCloudProvider on @comfyorg/sdk — failures', () => {
  it('maps insufficient credits to a message the run service treats as terminal', async () => {
    scenario.submitError = [402, 'insufficient_credits', 'Not enough credits']
    const err = await rejection(provider().edit(editRequest()))
    expect(err.message).toMatch(/insufficient credits/)
    expect(isRetryableRunError(err)).toBe(false)
  })

  it('maps a rejected key to a terminal message', async () => {
    scenario.submitError = [401, 'unauthorized', 'Invalid API key']
    const err = await rejection(provider().edit(editRequest()))
    expect(err.message).toMatch(/rejected the API key/)
    expect(isRetryableRunError(err)).toBe(false)
  })

  it('names the node that failed', async () => {
    scenario.jobStatus = 'failed'
    scenario.jobError = {
      code: 'execution_error',
      message: 'CUDA out of memory',
      node_id: '6',
      class_type: 'KSampler',
    }
    await expect(provider().edit(editRequest())).rejects.toThrow(
      /job failed \(node 6 — KSampler\): CUDA out of memory/,
    )
  })

  it('rides out transient status-poll failures instead of killing the job', async () => {
    scenario.pollFailures = POLL_FAILURE_TOLERANCE
    const result = await provider().edit(editRequest())
    expect(result.outputs).toHaveLength(1)
    expect(seen.cancels).toEqual([]) // the job was never abandoned
  }, 20_000)

  it('gives up once poll failures exceed the tolerance', async () => {
    scenario.pollFailures = POLL_FAILURE_TOLERANCE + 1
    await expect(provider().edit(editRequest())).rejects.toThrow(/Comfy Cloud/)
    expect(seen.cancels).toEqual(['job-1'])
  }, 20_000)

  it('cancels the job and reports terminally when the ceiling is hit', async () => {
    scenario.neverFinishes = true
    await expect(provider({ jobTimeoutMs: 1 }).edit(editRequest())).rejects.toThrow(
      /waiting for Comfy Cloud to finish \(raise COMFY_CLOUD_JOB_TIMEOUT_MS for long runs\)/,
    )
    // The job was stopped — a retry can't stack a second billable run on it.
    expect(seen.cancels).toEqual(['job-1'])
  }, 20_000)

  it('cancels the job and reports Cancelled when the run is aborted', async () => {
    scenario.neverFinishes = true
    const controller = new AbortController()
    const pending = rejection(provider().edit({ ...editRequest(), signal: controller.signal }))
    setTimeout(() => controller.abort(), 300)
    const err = await pending
    expect(err.message).toBe('Cancelled')
    expect(isRetryableRunError(err)).toBe(false)
    expect(seen.cancels).toEqual(['job-1'])
  }, 20_000)
})

describe('ComfyCloudProvider on @comfyorg/sdk — caption', () => {
  it('reads the text a sink node produced', async () => {
    scenario.outputs = [
      output({ id: 'asset-text', node_id: '4', name: 'caption.txt', type: 'text', content_type: 'text/plain' }),
    ]
    const result = await provider().caption({
      imageUrl: `${base}/img.png`,
      model: 'gemini-2.5-flash',
      prompt: 'describe this',
      seedKey: 'seed-2',
    })
    // The stand-in serves OUTPUT_BYTES for any asset content request.
    expect(result.text).toBe(OUTPUT_BYTES.toString('utf8'))

    const [submitted] = seen.submits
    expect(submitted!.workflow['1'].inputs.image.__type).toBe('core/ASSET')
    expect(submitted!.workflow['3'].class_type).toBe('GeminiNode')
  })

  it('fails when the job produced no text', async () => {
    scenario.outputs = [output()]
    await expect(
      provider().caption({
        imageUrl: `${base}/img.png`,
        model: 'gemini-2.5-flash',
        prompt: 'describe this',
        seedKey: 'seed-3',
      }),
    ).rejects.toThrow(/produced no text/)
  })
})

describe('ComfyCloudProvider on @comfyorg/sdk — availability', () => {
  it('is available when the surface answers the probe', async () => {
    expect(await provider().availability()).toEqual({ available: true, detail: null })
  })

  it('reports a rejected key', async () => {
    scenario.probeStatus = 401
    expect(await provider().availability()).toEqual({
      available: false,
      detail: 'Comfy Cloud rejected the API key',
    })
  })

  it('asks for a key before probing', async () => {
    expect(await provider({ apiKey: null }).availability()).toEqual({
      available: false,
      detail: 'Add a Comfy Cloud API key (Connectors → Configure)',
    })
  })
})

describe('mediaTypeForOutput', () => {
  it('maps v2 output kinds to staged media types', () => {
    expect(mediaTypeForOutput({ type: 'image', name: 'a.png', contentType: 'image/png' })).toBe('image')
    expect(mediaTypeForOutput({ type: 'video', name: 'a.mp4', contentType: 'video/mp4' })).toBe('video')
    expect(mediaTypeForOutput({ type: 'file', name: 'a.glb', contentType: 'application/octet-stream' })).toBe('model3d')
    expect(mediaTypeForOutput({ type: 'text', name: 'a.txt', contentType: 'text/plain' })).toBeNull()
    expect(mediaTypeForOutput({ type: 'latent', name: 'a.latent', contentType: 'application/octet-stream' })).toBeNull()
  })

  it('falls back to the filename when the server sends no content type', () => {
    // A video or GLB that lands under the catch-all `file` kind must not be
    // staged as an image just because the MIME was missing.
    expect(mediaTypeForOutput({ type: 'file', name: 'clip.mp4', contentType: '' })).toBe('video')
    expect(mediaTypeForOutput({ type: 'file', name: 'mesh.glb', contentType: '' })).toBe('model3d')
    expect(mediaTypeForOutput({ type: 'image', name: 'a.png', contentType: '' })).toBe('image')
    expect(mediaTypeForOutput({ type: 'text', name: 'caption.txt', contentType: '' })).toBeNull()
  })
})

describe('contentTypeForOutput', () => {
  it('prefers the server MIME, then the filename, then PNG', () => {
    expect(contentTypeForOutput({ name: 'a.bin', contentType: 'video/mp4' })).toBe('video/mp4')
    expect(contentTypeForOutput({ name: 'a.webp', contentType: '' })).toBe('image/webp')
    expect(contentTypeForOutput({ name: 'no-extension', contentType: '' })).toBe('image/png')
  })
})
