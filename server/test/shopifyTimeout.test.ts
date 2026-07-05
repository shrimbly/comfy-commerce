import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { exchangeClientCredentials } from '../src/connectors/shopify/clientCredentials.js'
import { shopifyGraphql } from '../src/connectors/shopify/graphql.js'
import { exchangeCodeForToken } from '../src/connectors/shopify/oauth.js'
import { fetchWithTimeout } from '../src/http.js'

// ---------------------------------------------------------------------------
// fetchWithTimeout against a real stalling server (finding #16 transport).
// ---------------------------------------------------------------------------

let server: Server
let base: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.url === '/stall-headers') {
      return // never responds at all
    }
    if (req.url === '/stall-body') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '65536' })
      res.write('{"partial":')
      return // headers arrive, the body never finishes
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

afterEach(() => vi.unstubAllGlobals())

describe('fetchWithTimeout', () => {
  it('returns a fully-buffered response for a normal call', async () => {
    const res = await fetchWithTimeout(`${base}/ok`, { timeoutMs: 5000 })
    expect(res.ok).toBe(true)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('times out with a clear error when the server never sends headers', async () => {
    await expect(fetchWithTimeout(`${base}/stall-headers`, { timeoutMs: 100 })).rejects.toThrow(
      /timed out after 100ms/,
    )
  })

  it('times out with a clear error when the body stalls after headers', async () => {
    await expect(fetchWithTimeout(`${base}/stall-body`, { timeoutMs: 150 })).rejects.toThrow(
      /timed out after 150ms/,
    )
  })
})

// ---------------------------------------------------------------------------
// The Shopify wrappers hand their deadline to fetch and surface it clearly.
// The endpoints are https-only, so a signal-respecting stub stands in for the
// stalling host.
// ---------------------------------------------------------------------------

function stallingFetch() {
  return vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error))
      }),
  )
}

describe('Shopify calls fail with a clear timeout instead of hanging (finding #16)', () => {
  it('shopifyGraphql times out and never re-sends the request (mutation safety)', async () => {
    const fetchMock = stallingFetch()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      shopifyGraphql({
        shop: 'test-shop.myshopify.com',
        accessToken: 'token',
        apiVersion: '2026-01',
        query: 'mutation { productCreateMedia }',
        timeoutMs: 40,
      }),
    ).rejects.toThrow(/timed out after 40ms/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the OAuth code exchange times out with a clear error', async () => {
    vi.stubGlobal('fetch', stallingFetch())
    await expect(
      exchangeCodeForToken({
        shop: 'test-shop.myshopify.com',
        code: 'abc',
        apiKey: 'key',
        apiSecret: 'secret',
        timeoutMs: 40,
      }),
    ).rejects.toThrow(/timed out after 40ms/)
  })

  it('the client-credentials exchange times out with a clear error', async () => {
    vi.stubGlobal('fetch', stallingFetch())
    await expect(
      exchangeClientCredentials({
        shop: 'test-shop.myshopify.com',
        clientId: 'id',
        clientSecret: 'secret',
        timeoutMs: 40,
      }),
    ).rejects.toThrow(/timed out after 40ms/)
  })
})
