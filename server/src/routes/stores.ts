import { countInScope, matchesScope, mediaInScope } from '@comfy-commerce/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { AppContext } from '../context.js'

const scopeProfileSchema = z.object({
  collectionIds: z.union([z.literal('all'), z.array(z.string())]),
  tags: z.array(z.string()),
  productStatus: z.enum(['active', 'draft', 'archived']),
  mediaRole: z.enum(['featured', 'all', 'all-with-video']),
})

const mediaTagsSchema = z.object({
  productId: z.string(),
  mediaId: z.string(),
  tags: z.array(z.string()),
})

export function registerStoreRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { storeService } = ctx

  app.get('/api/stores', async () => ({ stores: storeService.list() }))

  app.delete('/api/stores/:id', async (request) => {
    const { id } = request.params as { id: string }
    await storeService.disconnect(id)
    return { ok: true }
  })

  app.patch('/api/stores/:id/scope', async (request) => {
    const { id } = request.params as { id: string }
    const profile = scopeProfileSchema.parse(request.body)
    const store = storeService.updateScopeProfile(id, profile)
    const counts = await storeService.scopePreview(id, profile)
    return { store, counts }
  })

  app.post('/api/stores/:id/scope-preview', async (request) => {
    const { id } = request.params as { id: string }
    const profile = scopeProfileSchema.parse(request.body)
    return storeService.scopePreview(id, profile)
  })

  /**
   * Catalog for the media browser: full collections/tags for pickers, plus
   * products with their in-scope media annotated.
   */
  app.get('/api/stores/:id/catalog', async (request) => {
    const { id } = request.params as { id: string }
    const store = storeService.requireRow(id)
    const { products, collections } = await storeService.catalog(id)
    const scope = store.scopeProfile
    const tags = [...new Set(products.flatMap((p) => p.tags))].sort()
    const counts = countInScope(products, scope)
    const scopedProducts = products
      .filter((p) => matchesScope(p, scope))
      .map((p) => ({ ...p, media: mediaInScope(p, scope) }))
    return { collections, tags, counts, products: scopedProducts, scopeProfile: scope }
  })

  /** Replace the AI search tags for one image (manual edit in the inspector). */
  app.patch('/api/stores/:id/enrichment/tags', async (request) => {
    const { id } = request.params as { id: string }
    storeService.requireRow(id)
    const { productId, mediaId, tags } = mediaTagsSchema.parse(request.body)
    ctx.enrichmentService.setTags(id, productId, mediaId, tags)
    return { ok: true }
  })
}
