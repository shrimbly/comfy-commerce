import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { AppContext } from '../context.js'

/** An http(s) URL, an empty string (clears the setting), or null. */
const remoteComfyUrl = z.union([
  z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL'),
  z.literal(''),
  z.null(),
])

/** A free-form secret string, an empty string (clears it), or null. */
const cloudApiKey = z.union([z.string().max(512), z.null()])

// Each field is independently optional so the UI can patch one without the other.
const settingsPatchSchema = z
  .object({ remoteComfyUrl: remoteComfyUrl.optional(), cloudApiKey: cloudApiKey.optional() })
  .refine((b) => b.remoteComfyUrl !== undefined || b.cloudApiKey !== undefined, {
    message: 'Provide remoteComfyUrl and/or cloudApiKey',
  })

/** The full settings view — the URL value (not secret) and the key status (secret-safe). */
function settingsView(s: AppContext['settingsService']) {
  return {
    remoteComfyUrl: s.getRemoteComfyUrl(),
    cloudApiKey: s.getCloudApiKeyStatus(),
    cloudOauth: s.getCloudOAuthStatus(),
  }
}

/**
 * Global app settings — the Remote ComfyUI engine URL and the Comfy Cloud API
 * key, set from the Connectors page. Changes take effect on the next
 * availability poll without a restart. The Cloud key is write-only over the
 * API: GET returns only a masked status, never the raw secret.
 */
export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { settingsService } = ctx

  app.get('/api/settings', async () => settingsView(settingsService))

  app.patch('/api/settings', async (request) => {
    const body = settingsPatchSchema.parse(request.body)
    if (body.remoteComfyUrl !== undefined) settingsService.setRemoteComfyUrl(body.remoteComfyUrl)
    if (body.cloudApiKey !== undefined) settingsService.setCloudApiKey(body.cloudApiKey)
    return settingsView(settingsService)
  })
}
