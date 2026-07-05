import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ComfyHttpProvider } from '../src/providers/comfyHttp.js'
import type { AssetStore } from '../src/services/assetStore.js'

// 1×1 transparent PNG — a real image body for the input fetch.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

let server: Server
let base: string
let interruptHits = 0
let queueDeleteHits = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? ''
    if (req.method === 'GET' && url === '/img.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
      return
    }
    if (req.method === 'POST' && url === '/upload/image') {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ name: 'cc-input.png' }))
      })
      return
    }
    if (req.method === 'POST' && url === '/prompt') {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ prompt_id: 'p1' }))
      })
      return
    }
    if (req.method === 'GET' && url.startsWith('/history/')) {
      // The job never finishes — this is what exercises the ceiling.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({}))
      return
    }
    if (req.method === 'GET' && url === '/queue') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ queue_running: [[0, 'p1']], queue_pending: [] }))
      return
    }
    if (req.method === 'POST' && url === '/interrupt') {
      interruptHits += 1
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({}))
      })
      return
    }
    if (req.method === 'POST' && url === '/queue') {
      queueDeleteHits += 1
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({}))
      })
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

describe('ComfyHttpProvider job ceiling (finding #8)', () => {
  it('interrupts the engine exactly once on timeout and throws the terminal message', async () => {
    const provider = new ComfyHttpProvider({
      id: 'comfy-local',
      name: 'Local ComfyUI',
      kind: 'local',
      description: 'test engine',
      resolveBaseUrl: () => base,
      // 1ms ceiling → exactly one ~1.5s poll before hitting maxPolls.
      jobTimeoutMs: 1,
      // The caption path never touches the asset store before timing out.
      assetStore: null as unknown as AssetStore,
    })

    await expect(
      provider.caption({
        imageUrl: `${base}/img.png`,
        model: 'test-vlm',
        prompt: 'describe',
        seedKey: 'seed-1',
      }),
    ).rejects.toThrow(/waiting for ComfyUI to finish \(raise COMFY_JOB_TIMEOUT_MS for long runs\)/)

    // The still-running engine job was interrupted — a retry can't stack on it.
    expect(interruptHits).toBe(1)
    expect(queueDeleteHits).toBe(0) // the job was running, not pending
  }, 15_000)
})
