import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generateOAuthState,
  normalizeShopDomain,
  verifyCallbackHmac,
} from '../connectors/shopify/oauth.js'
import { oauthStates } from '../db/schema.js'
import { shopifyLiveMode } from '../env.js'
import type { AppContext } from '../context.js'
import { eq, lt } from 'drizzle-orm'

const connectBody = z.object({ shop: z.string().min(1) })
const tokenBody = z.object({ shop: z.string().min(1), accessToken: z.string().min(10) })
const credentialsBody = z.object({
  shop: z.string().min(1),
  clientId: z.string().min(8),
  clientSecret: z.string().min(8),
})

const INVALID_SHOP_DOMAIN = 'Enter a valid shop domain, e.g. mystore.myshopify.com'

/**
 * Connect flow. With Shopify app credentials configured this is the real
 * one-click OAuth handshake; without them, connects create demo stores
 * backed by the mock adapter so the whole pipeline is testable.
 */
export function registerConnectRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, env, storeService } = ctx

  app.get('/api/connect/shopify/config', async () => ({
    mode: shopifyLiveMode(env) ? 'live' : 'mock',
    scopes: env.shopify.scopes.split(','),
  }))

  app.post('/api/connect/shopify', async (request, reply) => {
    const { shop: rawShop } = connectBody.parse(request.body)

    if (!shopifyLiveMode(env)) {
      const domain = normalizeShopDomain(rawShop) ?? `${rawShop.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')}.myshopify.com`
      const store = storeService.createMockStore(domain)
      return { kind: 'connected' as const, store }
    }

    const shop = normalizeShopDomain(rawShop)
    if (!shop) {
      return reply.status(400).send({ error: INVALID_SHOP_DOMAIN })
    }
    const state = generateOAuthState()
    db.insert(oauthStates)
      .values({ state, shop, createdAt: new Date().toISOString() })
      .run()
    const url = buildAuthorizeUrl({
      shop,
      apiKey: env.shopify.apiKey!,
      scopes: env.shopify.scopes,
      redirectUri: `${env.appUrl}/api/connect/shopify/callback`,
      state,
    })
    return { kind: 'redirect' as const, url }
  })

  /**
   * Connect with an Admin API access token (custom app on the store). Works
   * with zero broker configuration — no OAuth app needed. The token is
   * verified against Shopify before it is encrypted and stored.
   */
  app.post('/api/connect/shopify/token', async (request, reply) => {
    const { shop: rawShop, accessToken } = tokenBody.parse(request.body)
    const shop = normalizeShopDomain(rawShop)
    if (!shop) {
      return reply.status(400).send({ error: INVALID_SHOP_DOMAIN })
    }
    try {
      const store = await ctx.storeService.connectWithToken(shop, accessToken.trim())
      return { kind: 'connected' as const, store }
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode
      if (statusCode === 400) throw err // scope errors carry a precise message
      request.log.warn(err, 'token connect failed')
      return reply.status(400).send({
        error: 'Shopify rejected that token — check the store domain and the Admin API access token.',
      })
    }
  })

  /**
   * Connect a Dev Dashboard app (the post-2026 path) with client ID/secret.
   * The broker performs the client-credentials exchange now and on every
   * 24h expiry — no static token ever exists.
   */
  app.post('/api/connect/shopify/credentials', async (request, reply) => {
    const { shop: rawShop, clientId, clientSecret } = credentialsBody.parse(request.body)
    const shop = normalizeShopDomain(rawShop)
    if (!shop) {
      return reply.status(400).send({ error: INVALID_SHOP_DOMAIN })
    }
    const store = await ctx.storeService.connectWithClientCredentials(
      shop,
      clientId.trim(),
      clientSecret.trim(),
    )
    return { kind: 'connected' as const, store }
  })

  app.get('/api/connect/shopify/callback', async (request, reply) => {
    const query = request.query as Record<string, string>
    const fail = (reason: string) =>
      reply.redirect(`${env.webOrigin}/connectors?error=${encodeURIComponent(reason)}`)

    if (!shopifyLiveMode(env)) return fail('Shopify credentials are not configured')
    const { code, shop, state } = query
    if (!code || !shop || !state) return fail('Missing OAuth parameters')

    // CSRF: state must match one we issued (single-use, 10 minute TTL).
    const stored = db.select().from(oauthStates).where(eq(oauthStates.state, state)).get()
    db.delete(oauthStates)
      .where(lt(oauthStates.createdAt, new Date(Date.now() - 10 * 60_000).toISOString()))
      .run()
    if (!stored || stored.shop !== shop) return fail('Invalid OAuth state')
    db.delete(oauthStates).where(eq(oauthStates.state, state)).run()

    // Integrity: verify the callback HMAC with the client secret.
    if (!verifyCallbackHmac(query, env.shopify.apiSecret!)) return fail('HMAC verification failed')

    try {
      const { accessToken, scopes } = await exchangeCodeForToken({
        shop,
        code,
        apiKey: env.shopify.apiKey!,
        apiSecret: env.shopify.apiSecret!,
      })
      const store = storeService.upsertOAuthStore(shop, accessToken, scopes)
      return reply.redirect(`${env.webOrigin}/connectors?connected=${encodeURIComponent(store.domain)}`)
    } catch (err) {
      request.log.error(err, 'OAuth token exchange failed')
      return fail('Token exchange failed')
    }
  })
}
