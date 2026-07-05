import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import type { AppContext } from '../context.js'
import { verifyWebhookHmac } from '../connectors/shopify/oauth.js'
import { stores } from '../db/schema.js'
import { shopifyLiveMode } from '../env.js'

/**
 * Inbound Shopify webhooks (products/update, products/delete, app/uninstalled)
 * keep the live-linked source fresh. HMAC-verified against the raw body.
 */
export function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, env, audit } = ctx

  // The app-level JSON parser (app.ts) stashes the raw bytes on request.rawBody —
  // the HMAC must be computed over the exact payload, not re-serialized JSON.
  app.post('/api/webhooks/shopify', async (request, reply) => {
      if (!shopifyLiveMode(env)) return reply.status(404).send()

      const hmac = request.headers['x-shopify-hmac-sha256']
      const topic = request.headers['x-shopify-topic']
      const shop = request.headers['x-shopify-shop-domain']
      const raw = (request as { rawBody?: Buffer }).rawBody

      if (typeof hmac !== 'string' || !raw || !verifyWebhookHmac(raw, hmac, env.shopify.apiSecret!)) {
        return reply.status(401).send({ error: 'Invalid webhook HMAC' })
      }

      const storeRow =
        typeof shop === 'string'
          ? db.select().from(stores).where(eq(stores.domain, shop)).get()
          : undefined

      if (storeRow) {
        if (topic === 'app/uninstalled') {
          db.update(stores)
            .set({ status: 'error', accessTokenEncrypted: null })
            .where(eq(stores.id, storeRow.id))
            .run()
        } else {
          db.update(stores)
            .set({ lastSyncedAt: new Date().toISOString() })
            .where(eq(stores.id, storeRow.id))
            .run()
        }
        audit.record({
          storeId: storeRow.id,
          action: 'webhook.received',
          detail: { topic: String(topic) },
        })
      }
      return reply.status(200).send()
  })
}
