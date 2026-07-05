import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { fetchInputImage } from '../src/providers/imageInput.js'

// Every request gets headers plus a first chunk, then the download stalls
// forever — the failure mode that used to freeze a run past Cancel and pin
// its RUN_CONCURRENCY slot (finding #17).
let server: Server
let base: string

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': '1048576' })
    res.write(Buffer.alloc(2048))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('fetchInputImage cancellation and timeout (finding #17)', () => {
  it('rejects promptly with AbortError when the run signal aborts mid-download', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = fetchInputImage(`${base}/img.png`, { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('times out a stalled download with a retryable (non-Abort) error', async () => {
    let err: unknown
    try {
      await fetchInputImage(`${base}/img.png`, { timeoutMs: 100 })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).not.toBe('AbortError')
    expect((err as Error).message).toMatch(/timed out after 100ms/)
  })
})
