import { createReadStream, existsSync } from 'node:fs'

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { AppContext } from '../context.js'
import { renderMockImage } from '../mock/svg.js'

/**
 * Image-serving routes: the mock CDN (deterministic SVG product shots) and
 * locally-custodied provider outputs.
 */
export function registerMediaRoutes(app: FastifyInstance, ctx: AppContext): void {
  // e.g. /mock-cdn/linen-tee/1.svg?shape=tee&recipe=relight&p_mood=golden-hour
  app.get('/mock-cdn/:productKey/:imageFile', async (request, reply) => {
    const { productKey, imageFile } = request.params as { productKey: string; imageFile: string }
    const query = request.query as Record<string, string>
    const imageIndex = imageFile.replace(/\.svg$/, '')

    const recipeParams: Record<string, string> = {}
    for (const [key, value] of Object.entries(query)) {
      if (key.startsWith('p_')) recipeParams[key.slice(2)] = value
    }

    const svg = renderMockImage({
      key: `${productKey}/${imageIndex}`,
      shape: query.shape,
      recipe: query.recipe,
      params: recipeParams,
    })
    return reply
      .header('Content-Type', 'image/svg+xml')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(svg)
  })

  // Small uploads (workflow thumbnails) arrive as base64 JSON.
  app.post('/api/assets', { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const { contentType, data } = z
      .object({ contentType: z.string().regex(/^image\//), data: z.string().min(1) })
      .parse(request.body)
    // SVG (or any XML image type) can carry <script>; stored and served back
    // same-origin it would be a stored-XSS vector against the studio origin.
    const mime = (contentType.split(';')[0] ?? contentType).trim().toLowerCase()
    if (mime === 'image/svg+xml' || mime.endsWith('+xml')) {
      return reply.status(415).send({ error: 'SVG uploads are not supported' })
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length === 0) return reply.status(400).send({ error: 'Empty image' })
    const saved = await ctx.assetStore.save(bytes, contentType)
    return reply.status(201).send(saved)
  })

  app.get('/api/assets/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const asset = ctx.assetStore.get(id)
    if (!asset || !existsSync(asset.path)) {
      return reply.status(404).send({ error: 'Asset not found' })
    }
    // Defense-in-depth for user-influenced bytes served same-origin: assets are
    // only ever embedded (<img>/<video>/fetch), never navigated to, so a direct
    // navigation downloads instead of rendering, and a navigated response would
    // be inert anyway (CSP applies to navigations, not embedding).
    return reply
      .header('Content-Type', asset.contentType)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${asset.filename}"`)
      .send(createReadStream(asset.path))
  })
}
