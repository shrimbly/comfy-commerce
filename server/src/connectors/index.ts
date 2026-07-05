import { eq } from 'drizzle-orm'

import { decryptSecret, encryptSecret } from '../crypto.js'
import type { Db } from '../db/client.js'
import { stores } from '../db/schema.js'
import type { Env } from '../env.js'
import { MockConnector } from './mock.js'
import { exchangeClientCredentials } from './shopify/clientCredentials.js'
import { RealShopifyConnector } from './shopify/real.js'
import type { StoreConnector, StoreRecord } from './types.js'

export type { StoreConnector, StoreRecord } from './types.js'

/**
 * Token custody. Static tokens (legacy shpat_ / OAuth offline) decrypt
 * directly; client-credentials stores re-exchange when the 24h token is
 * near expiry, persisting the fresh token before returning it.
 */
export function createAccessTokenResolver(db: Db, env: Env) {
  return async function getAccessToken(store: StoreRecord): Promise<string> {
    if (store.authKind === 'client-credentials') {
      const fresh = db.select().from(stores).where(eq(stores.id, store.id)).get() ?? store
      const valid =
        fresh.accessTokenEncrypted &&
        fresh.tokenExpiresAt &&
        new Date(fresh.tokenExpiresAt).getTime() > Date.now()
      if (valid) return decryptSecret(fresh.accessTokenEncrypted!, env.tokenEncryptionKey)

      if (!fresh.clientIdEncrypted || !fresh.clientSecretEncrypted) {
        throw new Error(`Store ${store.domain} has no client credentials`)
      }
      const granted = await exchangeClientCredentials({
        shop: fresh.domain,
        clientId: decryptSecret(fresh.clientIdEncrypted, env.tokenEncryptionKey),
        clientSecret: decryptSecret(fresh.clientSecretEncrypted, env.tokenEncryptionKey),
      })
      db.update(stores)
        .set({
          accessTokenEncrypted: encryptSecret(granted.accessToken, env.tokenEncryptionKey),
          tokenExpiresAt: granted.expiresAt,
          scopes: granted.scopes,
        })
        .where(eq(stores.id, store.id))
        .run()
      return granted.accessToken
    }

    if (!store.accessTokenEncrypted) {
      throw new Error(`Store ${store.domain} has no access token`)
    }
    return decryptSecret(store.accessTokenEncrypted, env.tokenEncryptionKey)
  }
}

/** Resolve the adapter for a store: demo stores → mock, real stores → Shopify. */
export function createConnectorRegistry(db: Db, env: Env) {
  const mock = new MockConnector(db)
  const shopify = new RealShopifyConnector({
    apiVersion: env.shopify.apiVersion,
    appUrl: env.appUrl,
    mediaReadyTimeoutMs: env.shopify.mediaReadyTimeoutMs,
    mediaReadyVideoTimeoutMs: env.shopify.mediaReadyVideoTimeoutMs,
    getAccessToken: createAccessTokenResolver(db, env),
  })

  return {
    forStore(store: StoreRecord): StoreConnector {
      return store.adapter === 'mock' ? mock : shopify
    },
  }
}

export type ConnectorRegistry = ReturnType<typeof createConnectorRegistry>
