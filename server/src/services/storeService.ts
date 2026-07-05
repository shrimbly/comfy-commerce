import { randomUUID } from 'node:crypto'

import {
  countInScope,
  DEFAULT_SCOPE_PROFILE,
  type ConnectedStore,
  type Product,
  type ScopeProfile,
} from '@comfy-commerce/shared'
import { eq } from 'drizzle-orm'

import type { ConnectorRegistry, StoreRecord } from '../connectors/index.js'
import { exchangeClientCredentials } from '../connectors/shopify/clientCredentials.js'
import { shopifyGraphql } from '../connectors/shopify/graphql.js'
import { encryptSecret } from '../crypto.js'
import type { Db } from '../db/client.js'
import { auditLog, runs, stagingItems, stores } from '../db/schema.js'
import type { Env } from '../env.js'
import type { Audit } from './audit.js'
import type { EnrichmentService } from './enrichmentService.js'

/**
 * Shopify write scopes imply their read counterpart, and granted-scope lists
 * often omit the implied read handle — check accordingly.
 */
function missingScopes(granted: string[]): string[] {
  const READ_PREFIX = 'read_'
  const has = (scope: string) =>
    granted.includes(scope) ||
    (scope.startsWith(READ_PREFIX) && granted.includes(`write_${scope.slice(READ_PREFIX.length)}`))
  return ['read_products', 'write_products'].filter((s) => !has(s))
}

function scopeError(missing: string[], granted: string[]): Error {
  return Object.assign(
    new Error(
      `The app is missing required scopes: ${missing.join(', ')} (granted: ${granted.join(', ') || 'none'})`,
    ),
    { statusCode: 400 },
  )
}

/** Public DTO — never exposes the encrypted token. */
export function toConnectedStore(row: StoreRecord): ConnectedStore {
  return {
    id: row.id,
    domain: row.domain,
    connectorId: row.connectorId,
    status: row.status,
    scopes: row.scopes,
    lastSyncedAt: row.lastSyncedAt,
    scopeProfile: row.scopeProfile,
    shopName: row.shopName ?? null,
    faviconUrl: row.faviconUrl ?? null,
  }
}

/**
 * Best-effort store name + storefront favicon for display. Never throws —
 * connect must still succeed if Shopify is slow or the storefront has no
 * favicon (e.g. a password-protected dev store).
 */
async function fetchShopInfo(
  shop: string,
  accessToken: string,
  apiVersion: string,
): Promise<{ shopName: string | null; faviconUrl: string | null }> {
  try {
    const data = await shopifyGraphql<{ shop: { name: string; primaryDomain: { url: string } | null } }>({
      shop,
      accessToken,
      apiVersion,
      query: `{ shop { name primaryDomain { url } } }`,
    })
    const shopName = data.shop?.name ?? null
    const storefront = data.shop?.primaryDomain?.url ?? `https://${shop}`
    let faviconUrl: string | null = null
    try {
      const res = await fetch(storefront, { redirect: 'follow', signal: AbortSignal.timeout(8000) })
      if (res.ok) faviconUrl = extractFavicon(await res.text(), res.url)
    } catch {
      // favicon is best-effort — a missing one falls back to the Shopify mark.
    }
    return { shopName, faviconUrl }
  } catch {
    return { shopName: null, faviconUrl: null }
  }
}

/** Pull the first `<link rel="...icon...">` href from storefront HTML, absolutised. */
function extractFavicon(html: string, baseUrl: string): string | null {
  for (const tag of html.slice(0, 60000).match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel=["']?[^"'>]*icon/i.test(tag)) continue
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1]
    if (!href) continue
    try {
      return new URL(href, baseUrl).toString()
    } catch {
      return null
    }
  }
  return null
}

export function createStoreService(
  db: Db,
  env: Env,
  connectors: ConnectorRegistry,
  audit: Audit,
  enrichment: EnrichmentService,
) {
  function getRow(id: string): StoreRecord | null {
    return db.select().from(stores).where(eq(stores.id, id)).get() ?? null
  }

  /**
   * Late-bound run canceller: storeService is constructed before runService
   * (app.ts), so disconnect's cancel-first ordering is wired via
   * bindRunService rather than a constructor cycle.
   */
  let runCanceller: { cancelAllForStore(storeId: string): Promise<void> } | null = null

  /**
   * Single-flight product listing: the UI fires catalog() and scopePreview()
   * together at boot, and each is a full listProducts crawl (paged GraphQL on
   * a live store). While one listing is in flight the other caller shares it
   * instead of starting a second crawl. Entries drop the moment the listing
   * settles, so sequential callers — including any refetch after a publish,
   * revert, or scope change — always read fresh.
   */
  const productsInFlight = new Map<string, Promise<Product[]>>()
  function listProductsShared(row: StoreRecord): Promise<Product[]> {
    const pending = productsInFlight.get(row.id)
    if (pending) return pending
    const listing = connectors
      .forStore(row)
      .listProducts(row)
      .finally(() => productsInFlight.delete(row.id))
    productsInFlight.set(row.id, listing)
    return listing
  }

  return {
    /** Wire the run service in once it exists — see app.ts. */
    bindRunService(rs: { cancelAllForStore(storeId: string): Promise<void> }): void {
      runCanceller = rs
    },

    list(): ConnectedStore[] {
      return db.select().from(stores).all().map(toConnectedStore)
    },

    getRow,

    requireRow(id: string): StoreRecord {
      const row = getRow(id)
      if (!row) throw Object.assign(new Error('Store not found'), { statusCode: 404 })
      return row
    },

    /** Create a demo store backed by the mock adapter — instant connect. */
    createMockStore(domain: string): ConnectedStore {
      const row: typeof stores.$inferInsert = {
        id: randomUUID(),
        domain,
        connectorId: 'shopify',
        adapter: 'mock',
        status: 'connected',
        scopes: ['read_products', 'write_products'],
        accessTokenEncrypted: null,
        scopeProfile: DEFAULT_SCOPE_PROFILE,
        lastSyncedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }
      db.insert(stores).values(row).run()
      audit.record({ storeId: row.id, action: 'store.connect', detail: { domain, adapter: 'mock' } })
      return toConnectedStore(row as StoreRecord)
    },

    /** Create (or refresh) a real Shopify store row, whatever the auth kind. */
    upsertShopifyStore(
      shop: string,
      scopes: string[],
      auth: Pick<
        typeof stores.$inferInsert,
        'authKind' | 'accessTokenEncrypted' | 'clientIdEncrypted' | 'clientSecretEncrypted' | 'tokenExpiresAt'
      >,
    ): ConnectedStore {
      const existing = db.select().from(stores).where(eq(stores.domain, shop)).all()
        .find((s) => s.adapter === 'shopify')
      if (existing) {
        db.update(stores)
          .set({ ...auth, scopes, status: 'connected', lastSyncedAt: new Date().toISOString() })
          .where(eq(stores.id, existing.id))
          .run()
        audit.record({ storeId: existing.id, action: 'store.reconnect', detail: { domain: shop, auth: auth.authKind } })
        return toConnectedStore({ ...existing, scopes, status: 'connected' })
      }
      const row: typeof stores.$inferInsert = {
        id: randomUUID(),
        domain: shop,
        connectorId: 'shopify',
        adapter: 'shopify',
        status: 'connected',
        scopes,
        ...auth,
        scopeProfile: DEFAULT_SCOPE_PROFILE,
        lastSyncedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }
      db.insert(stores).values(row).run()
      audit.record({
        storeId: row.id,
        action: 'store.connect',
        detail: { domain: shop, adapter: 'shopify', auth: auth.authKind },
      })
      return toConnectedStore(row as StoreRecord)
    },

    /** Create (or refresh) a real store after a completed OAuth handshake. */
    upsertOAuthStore(shop: string, accessToken: string, scopes: string[]): ConnectedStore {
      return this.upsertShopifyStore(shop, scopes, {
        authKind: 'token',
        accessTokenEncrypted: encryptSecret(accessToken, env.tokenEncryptionKey),
        clientIdEncrypted: null,
        clientSecretEncrypted: null,
        tokenExpiresAt: null,
      })
    },

    /**
     * Connect a Dev Dashboard app (2026+) with its client ID/secret. The
     * credentials are verified by performing a real token exchange; granted
     * scopes come back in the same response. Tokens expire in 24h — the
     * connector registry re-exchanges transparently from the encrypted
     * credentials.
     */
    async connectWithClientCredentials(
      shop: string,
      clientId: string,
      clientSecret: string,
    ): Promise<ConnectedStore> {
      const granted = await exchangeClientCredentials({ shop, clientId, clientSecret })
      const missing = missingScopes(granted.scopes)
      if (missing.length) throw scopeError(missing, granted.scopes)
      const store = this.upsertShopifyStore(shop, granted.scopes, {
        authKind: 'client-credentials',
        accessTokenEncrypted: encryptSecret(granted.accessToken, env.tokenEncryptionKey),
        clientIdEncrypted: encryptSecret(clientId, env.tokenEncryptionKey),
        clientSecretEncrypted: encryptSecret(clientSecret, env.tokenEncryptionKey),
        tokenExpiresAt: granted.expiresAt,
      })
      return this.attachShopInfo(store, granted.accessToken)
    },

    /** Fetch + persist display metadata (name, favicon) for a connected store. */
    async attachShopInfo(store: ConnectedStore, accessToken: string): Promise<ConnectedStore> {
      const info = await fetchShopInfo(store.domain, accessToken, env.shopify.apiVersion)
      db.update(stores).set(info).where(eq(stores.id, store.id)).run()
      return { ...store, ...info }
    },

    /**
     * Connect a store with an Admin API access token (custom app) — no OAuth
     * app required. The token is verified against Shopify and its granted
     * scopes are recorded before anything is persisted.
     */
    async connectWithToken(shop: string, accessToken: string): Promise<ConnectedStore> {
      const data = await shopifyGraphql<{
        currentAppInstallation: { accessScopes: Array<{ handle: string }> }
      }>({
        shop,
        accessToken,
        apiVersion: env.shopify.apiVersion,
        query: `{ currentAppInstallation { accessScopes { handle } } }`,
      })
      const scopes = data.currentAppInstallation.accessScopes.map((s) => s.handle)
      const missing = missingScopes(scopes)
      if (missing.length) throw scopeError(missing, scopes)
      return this.attachShopInfo(this.upsertOAuthStore(shop, accessToken, scopes), accessToken)
    },

    /** Disconnect removes the store and everything scoped to it. */
    async disconnect(id: string): Promise<void> {
      const row = getRow(id)
      if (!row) return
      // FIRST: cancel the store's runs and await executor teardown (bounded),
      // so no run loop is still touching the catalog when the rows below are
      // purged — deleting mid-execution would strand executors and let the
      // mock connector lazily resurrect the catalog.
      await runCanceller?.cancelAllForStore(id)
      await connectors.forStore(row).disconnect(row)
      db.delete(stagingItems).where(eq(stagingItems.storeId, id)).run()
      db.delete(runs).where(eq(runs.storeId, id)).run()
      enrichment.removeForStore(id)
      db.delete(auditLog).where(eq(auditLog.storeId, id)).run()
      db.delete(stores).where(eq(stores.id, id)).run()
      audit.record({ storeId: id, action: 'store.disconnect', detail: { domain: row.domain } })
    },

    updateScopeProfile(id: string, profile: ScopeProfile): ConnectedStore {
      const row = this.requireRow(id)
      db.update(stores).set({ scopeProfile: profile }).where(eq(stores.id, id)).run()
      audit.record({ storeId: id, action: 'store.scope-update', detail: { profile } })
      return toConnectedStore({ ...row, scopeProfile: profile })
    },

    async catalog(id: string): Promise<{ products: Product[]; collections: { id: string; title: string }[] }> {
      const row = this.requireRow(id)
      const connector = connectors.forStore(row)
      const [products, collections] = await Promise.all([
        listProductsShared(row),
        connector.listCollections(row),
      ])
      db.update(stores).set({ lastSyncedAt: new Date().toISOString() }).where(eq(stores.id, id)).run()
      // Fold any AI caption/tags onto each image so the browser can search/filter them.
      return { products: enrichment.hydrate(id, products), collections }
    },

    async scopePreview(id: string, profile: ScopeProfile) {
      const row = this.requireRow(id)
      const products = await listProductsShared(row)
      return countInScope(products, profile)
    },
  }
}

export type StoreService = ReturnType<typeof createStoreService>
