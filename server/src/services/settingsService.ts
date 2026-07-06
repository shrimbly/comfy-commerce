import { eq } from 'drizzle-orm'

import { decryptSecret, encryptSecret } from '../crypto.js'
import type { Db } from '../db/client.js'
import { appSettings } from '../db/schema.js'
import type { Env } from '../env.js'

/** Settings key for the Remote ComfyUI engine URL. */
const REMOTE_COMFY_URL_KEY = 'comfy.remote.url'
/** Settings key for the Comfy Cloud API key (a secret — never returned raw). */
const CLOUD_API_KEY_KEY = 'comfy.cloud.apiKey'

/** Drop a single trailing slash so URL origins concatenate predictably. */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, '')
}

/**
 * Secret-safe view of the Comfy Cloud API key: whether one is configured, where
 * it came from, and a short masked hint — but never the key itself.
 */
export interface CloudApiKeyStatus {
  configured: boolean
  /** 'ui' = set on the Connectors page, 'env' = COMFY_CLOUD_API_KEY, null = unset. */
  source: 'ui' | 'env' | null
  /** A `…last4` hint so the operator can recognise which key is in use. */
  masked: string | null
}

/** Last 4 chars only, so the UI can show *which* key without exposing it. */
function maskKey(key: string): string {
  return `…${key.slice(-4)}`
}

/**
 * Global app settings (singleton key-value). Unlike per-store config in the
 * `stores` table, these are app-wide and editable at runtime without a restart
 * — the Remote ComfyUI engine reads its URL through here on every call, so a
 * change saved in the UI takes effect on the next availability poll.
 */
export function createSettingsService(db: Db, env: Env) {
  function getRaw(key: string): string | null {
    return db.select().from(appSettings).where(eq(appSettings.key, key)).get()?.value ?? null
  }

  function setRaw(key: string, value: string | null): void {
    if (value === null) {
      db.delete(appSettings).where(eq(appSettings.key, key)).run()
      return
    }
    db.insert(appSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } })
      .run()
  }

  /**
   * The UI-saved Cloud API key, decrypted — or null if unset or the stored
   * ciphertext can't be decrypted (e.g. TOKEN_ENCRYPTION_KEY changed), in which
   * case callers fall back to the env seed rather than crashing.
   */
  function readCloudKey(): string | null {
    const stored = getRaw(CLOUD_API_KEY_KEY)
    if (!stored) return null
    try {
      return decryptSecret(stored, env.tokenEncryptionKey)
    } catch {
      return null
    }
  }

  return {
    /**
     * The Remote ComfyUI engine URL, or null when unconfigured. A value set in
     * the UI (DB) wins; otherwise the COMFY_REMOTE_URL env seed is used.
     */
    getRemoteComfyUrl(): string | null {
      return getRaw(REMOTE_COMFY_URL_KEY) ?? env.comfyRemoteUrl
    },

    /**
     * Set (or clear, with null/empty) the Remote ComfyUI URL. Returns the
     * resulting effective value (which may fall back to the env seed on clear).
     */
    setRemoteComfyUrl(url: string | null): string | null {
      const trimmed = url?.trim()
      setRaw(REMOTE_COMFY_URL_KEY, trimmed ? trimTrailingSlash(trimmed) : null)
      return this.getRemoteComfyUrl()
    },

    /**
     * The effective Comfy Cloud API key (and the comfy.org key API nodes use):
     * a value set in the UI wins; otherwise the COMFY_CLOUD_API_KEY env seed.
     * Null when neither is set. Read fresh by the providers on every call, so a
     * key saved in the UI takes effect with no restart. Server-side only — never
     * send this to the browser; use {@link getCloudApiKeyStatus} for that.
     */
    getCloudApiKey(): string | null {
      return readCloudKey() ?? env.comfyCloud.apiKey
    },

    /** Secret-safe status of the Cloud API key for the UI (no raw key). */
    getCloudApiKeyStatus(): CloudApiKeyStatus {
      const ui = readCloudKey()
      const effective = ui ?? env.comfyCloud.apiKey
      return {
        configured: Boolean(effective),
        source: ui ? 'ui' : env.comfyCloud.apiKey ? 'env' : null,
        masked: effective ? maskKey(effective) : null,
      }
    },

    /**
     * Set (or clear, with null/empty) the Comfy Cloud API key — encrypted at
     * rest (AES-256-GCM), like Shopify tokens. Clearing falls back to the env
     * seed if one exists. Returns the new secret-safe status.
     */
    setCloudApiKey(key: string | null): CloudApiKeyStatus {
      const trimmed = key?.trim()
      setRaw(CLOUD_API_KEY_KEY, trimmed ? encryptSecret(trimmed, env.tokenEncryptionKey) : null)
      return this.getCloudApiKeyStatus()
    },
  }
}

export type SettingsService = ReturnType<typeof createSettingsService>
