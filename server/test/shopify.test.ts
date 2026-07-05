import { describe, expect, it } from 'vitest'

import { readyTimeoutFor } from '../src/connectors/shopify/real.js'
import { loadEnv } from '../src/env.js'

const timeouts = { mediaReadyTimeoutMs: 60_000, mediaReadyVideoTimeoutMs: 300_000 }

describe('readyTimeoutFor', () => {
  it('uses the image ceiling for images', () => {
    expect(readyTimeoutFor('image', timeouts)).toBe(60_000)
  })

  it('uses the longer video ceiling for video (transcoding is slow)', () => {
    expect(readyTimeoutFor('video', timeouts)).toBe(300_000)
    expect(readyTimeoutFor('video', timeouts)).toBeGreaterThan(readyTimeoutFor('image', timeouts))
  })

  it('uses the longer ceiling for 3D models (optimization is slow)', () => {
    expect(readyTimeoutFor('model3d', timeouts)).toBe(300_000)
    expect(readyTimeoutFor('model3d', timeouts)).toBeGreaterThan(readyTimeoutFor('image', timeouts))
  })

  it('honors env overrides for both ceilings', () => {
    const env = loadEnv({
      SHOPIFY_MEDIA_READY_TIMEOUT_MS: '45000',
      SHOPIFY_MEDIA_READY_VIDEO_TIMEOUT_MS: '600000',
    })
    expect(readyTimeoutFor('image', env.shopify)).toBe(45_000)
    expect(readyTimeoutFor('video', env.shopify)).toBe(600_000)
  })
})

describe('shopify env defaults', () => {
  it('defaults to a supported API version (not the EOL 2025-04)', () => {
    expect(loadEnv().shopify.apiVersion).toBe('2026-01')
  })
})
