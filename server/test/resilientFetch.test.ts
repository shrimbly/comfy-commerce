import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resilientFetch } from '../src/providers/http.js'

let server: Server
let base: string
let flakyHits = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ hello: 'world' }))
      return
    }
    if (req.url === '/echo' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(body)
      })
      return
    }
    if (req.url === '/flaky') {
      flakyHits += 1
      if (flakyHits < 3) {
        res.writeHead(503)
        res.end('busy')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.url === '/slow') {
      // Never respond — used to exercise the timeout path.
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

describe('resilientFetch', () => {
  it('returns a normal 200 GET unchanged', async () => {
    const res = await resilientFetch(`${base}/ok`, { timeoutMs: 5000, retries: 2 })
    expect(res.ok).toBe(true)
    expect(await res.json()).toEqual({ hello: 'world' })
  })

  it('sends a POST body', async () => {
    const res = await resilientFetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
      timeoutMs: 5000,
    })
    expect(await res.json()).toEqual({ a: 1 })
  })

  it('retries a transient 503 until it succeeds', async () => {
    flakyHits = 0
    const res = await resilientFetch(`${base}/flaky`, { timeoutMs: 5000, retries: 3, retryBaseMs: 5 })
    expect(res.ok).toBe(true)
    expect(flakyHits).toBe(3)
  })

  it('times out a hung request with a retryable (non-Abort) error', async () => {
    let err: unknown
    try {
      await resilientFetch(`${base}/slow`, { timeoutMs: 150, retries: 0 })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).not.toBe('AbortError')
    expect((err as Error).message).toMatch(/timed out after/i)
  })

  it('propagates a caller cancellation as AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      resilientFetch(`${base}/ok`, { timeoutMs: 5000, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
