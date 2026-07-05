import { randomUUID } from 'node:crypto'

import { resilientFetch } from './http.js'

/**
 * Fetch a source image for a generation engine. ComfyUI's LoadImage cannot
 * ingest SVG (the demo catalog's mock CDN serves SVG), so vector inputs are
 * rasterized to PNG here before upload.
 *
 * Bounded by a timeout and the run's abort signal — a stuck CDN download must
 * not freeze the run past Cancel (it would pin a RUN_CONCURRENCY slot forever).
 */
export async function fetchInputImage(
  url: string,
  opts: { signal?: AbortSignal | undefined; timeoutMs?: number } = {},
): Promise<{ bytes: Buffer; filename: string; mimeType: string }> {
  const res = await resilientFetch(url, {
    timeoutMs: opts.timeoutMs ?? 60_000,
    retries: 2, // idempotent GET — a transient CDN blip is worth retrying
    signal: opts.signal,
  })
  if (!res.ok) throw new Error(`Could not fetch source image (${res.status})`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type') ?? ''

  const isSvg =
    contentType.includes('svg') ||
    (!contentType.startsWith('image/') && bytes.subarray(0, 256).toString('utf8').includes('<svg'))
  if (isSvg) {
    const { Resvg } = await import('@resvg/resvg-js')
    const png = new Resvg(bytes.toString('utf8'), {
      fitTo: { mode: 'width', value: 1024 },
    })
      .render()
      .asPng()
    return { bytes: Buffer.from(png), filename: `cc-${randomUUID()}.png`, mimeType: 'image/png' }
  }

  const ext = contentType.includes('jpeg')
    ? 'jpg'
    : contentType.includes('webp')
      ? 'webp'
      : 'png'
  return {
    bytes,
    filename: `cc-${randomUUID()}.${ext}`,
    mimeType: contentType.startsWith('image/') ? contentType.split(';')[0]! : 'image/png',
  }
}
