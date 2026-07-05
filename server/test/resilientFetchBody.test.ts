import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resilientFetch } from '../src/providers/http.js'

// A server that sends headers (and a first chunk) immediately, then stalls
// forever — the transfer shape undici's fetch never times out on by itself,
// because its signal historically only bounded time-to-headers here (finding
// #34: the timer/abort listener were disarmed as soon as headers arrived).
let server: Server
let base: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/stall-body') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': '1048576',
      })
      res.write(Buffer.alloc(1024))
      return // never ends — the body trickle stalls here
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('resilientFetch body reads (finding #34)', () => {
  it('bounds the whole transfer — a stalled body trips the timeout, not just missing headers', async () => {
    const started = Date.now()
    await expect(
      resilientFetch(`${base}/stall-body`, { timeoutMs: 200, retries: 0 }),
    ).rejects.toThrow(/timed out after 200ms/)
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('caller abort cancels a stalled body read as AbortError', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = resilientFetch(`${base}/stall-body`, {
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - started).toBeLessThan(4_000)
  })
})
