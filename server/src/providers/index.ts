import type { ProviderId, ProviderInfo } from '@comfy-commerce/shared'

import type { Env } from '../env.js'
import type { AssetStore } from '../services/assetStore.js'
import type { ComfyAuthService } from '../services/comfyAuthService.js'
import type { SettingsService } from '../services/settingsService.js'
import { ComfyCloudProvider, type CloudAuth } from './comfyCloud.js'
import { ComfyHttpProvider } from './comfyHttp.js'
import { MockProvider } from './mock.js'
import type { GenerationProvider } from './types.js'

export type { EditRequest, EditResult, GenerationProvider } from './types.js'

export function createProviderRegistry(
  env: Env,
  assetStore: AssetStore,
  settings: SettingsService,
  comfyAuth: ComfyAuthService,
) {
  // The Comfy Cloud key doubles as the comfy.org key API nodes authenticate
  // with. Resolve it fresh (UI value wins, env seed otherwise) so saving a key
  // in the UI takes effect everywhere with no restart.
  const resolveComfyOrgApiKey = () => settings.getCloudApiKey()

  // Cloud transport: the OAuth sign-in wins when its grant works on the REST
  // API; otherwise the personal key. The key still rides along for API-node
  // billing (extra_data) either way.
  const resolveCloudAuth = async (): Promise<CloudAuth | null> => {
    const apiKey = settings.getCloudApiKey()
    const oauth = await comfyAuth.getAccessToken()
    if (oauth?.apiAccess) {
      return { headers: { Authorization: `Bearer ${oauth.accessToken}` }, comfyOrgApiKey: apiKey }
    }
    if (apiKey) return { headers: { 'X-API-Key': apiKey }, comfyOrgApiKey: apiKey }
    return null
  }
  const providers: GenerationProvider[] = [
    new MockProvider(),
    new ComfyHttpProvider({
      id: 'comfy-local',
      name: 'Local ComfyUI',
      kind: 'local',
      description: 'Runs edits on your own ComfyUI instance. Images never leave your machine.',
      resolveBaseUrl: () => env.comfyLocalUrl,
      checkpoint: process.env.COMFY_LOCAL_CHECKPOINT,
      resolveComfyOrgApiKey,
      jobTimeoutMs: env.comfyJobTimeoutMs,
      assetStore,
    }),
    new ComfyHttpProvider({
      id: 'comfy-remote',
      name: 'Remote ComfyUI',
      kind: 'remote',
      description: 'Runs edits on a ComfyUI instance on another machine on your network.',
      // Read fresh from settings each call so a URL change takes effect with no restart.
      resolveBaseUrl: () => settings.getRemoteComfyUrl(),
      checkpoint: process.env.COMFY_REMOTE_CHECKPOINT,
      resolveComfyOrgApiKey,
      jobTimeoutMs: env.comfyJobTimeoutMs,
      assetStore,
    }),
    new ComfyCloudProvider({
      apiUrl: env.comfyCloud.apiUrl,
      resolveAuth: resolveCloudAuth,
      checkpoint: process.env.COMFY_CLOUD_CHECKPOINT,
      jobTimeoutMs: env.comfyCloud.jobTimeoutMs,
      assetStore,
    }),
  ]

  // listInfo() is polled by every client and gates the landing page's engines
  // card, but a full sweep awaits live availability probes — up to 4s when a
  // configured engine is asleep. Cache the sweep briefly and serve stale while
  // revalidating, so a request never waits on probes once the cache is warm
  // (index.ts / the desktop shell prime it right after listen). The cache is
  // keyed on the live-resolved settings, so saving a remote URL or cloud key
  // still takes effect immediately — the next request probes fresh.
  const INFO_TTL_MS = 12_000
  let infoCache: { key: string; at: number; value: Promise<ProviderInfo[]> } | null = null
  let infoRevalidating = false

  const infoKey = () => {
    const oauth = settings.getCloudOAuthStatus()
    return `${settings.getRemoteComfyUrl() ?? ''}\n${settings.getCloudApiKey() ?? ''}\n${oauth.connected}:${oauth.apiAccess}`
  }

  function probeInfo(): Promise<ProviderInfo[]> {
    return Promise.all(
      providers.map(async (p) => {
        const availability = await p.availability()
        return {
          id: p.id,
          name: p.name,
          kind: p.kind,
          description: p.description,
          available: availability.available,
          detail: availability.detail,
        }
      }),
    )
  }

  return {
    get(id: ProviderId): GenerationProvider {
      const provider = providers.find((p) => p.id === id)
      if (!provider) {
        throw Object.assign(new Error(`Unknown provider: ${id}`), { statusCode: 400 })
      }
      return provider
    },

    async listInfo(): Promise<ProviderInfo[]> {
      const key = infoKey()
      const cached = infoCache
      if (cached && cached.key === key) {
        if (Date.now() - cached.at >= INFO_TTL_MS && !infoRevalidating) {
          infoRevalidating = true
          probeInfo()
            .then((value) => {
              infoCache = { key, at: Date.now(), value: Promise.resolve(value) }
            })
            .catch(() => {
              /* keep serving the previous sweep */
            })
            .finally(() => {
              infoRevalidating = false
            })
        }
        return cached.value
      }
      // Cold cache or a settings change: probe live (callers need the current
      // shape), sharing one in-flight sweep across concurrent requests.
      const entry = { key, at: Date.now(), value: probeInfo() }
      infoCache = entry
      entry.value.catch(() => {
        if (infoCache === entry) infoCache = null // never cache a failed sweep
      })
      return entry.value
    },
  }
}

export type ProviderRegistry = ReturnType<typeof createProviderRegistry>
