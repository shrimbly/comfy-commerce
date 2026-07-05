import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchInputImage } from '../src/providers/imageInput.js'

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#7a9b8e"/></svg>`
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

function mockFetch(body: Buffer | string, contentType: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { headers: { 'content-type': contentType } })),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchInputImage', () => {
  it('rasterizes SVG inputs to PNG (ComfyUI LoadImage cannot ingest SVG)', async () => {
    mockFetch(SVG, 'image/svg+xml')
    const result = await fetchInputImage('http://broker/mock-cdn/x/1.svg')
    expect(result.mimeType).toBe('image/png')
    expect(result.filename).toMatch(/\.png$/)
    expect(result.bytes.subarray(0, 4).equals(PNG_MAGIC)).toBe(true)
  })

  it('detects SVG even when the content-type lies', async () => {
    mockFetch(SVG, 'application/octet-stream')
    const result = await fetchInputImage('http://broker/whatever')
    expect(result.mimeType).toBe('image/png')
    expect(result.bytes.subarray(0, 4).equals(PNG_MAGIC)).toBe(true)
  })

  it('passes raster images through untouched', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    mockFetch(jpeg, 'image/jpeg')
    const result = await fetchInputImage('https://cdn.shopify.com/img.jpg')
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.filename).toMatch(/\.jpg$/)
    expect(result.bytes.equals(jpeg)).toBe(true)
  })
})
