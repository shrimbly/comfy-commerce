import { randomBytes } from 'node:crypto'

import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  OAuthGrantError,
  refreshTokens,
  registerClient,
  resolveEndpoints,
} from '../connectors/comfy/oauth.js'
import type { Env } from '../env.js'
import { fetchWithTimeout } from '../http.js'
import type { SettingsService } from './settingsService.js'

/**
 * "Sign in with Comfy Cloud" — the broker-side OAuth session. Owns the
 * connect flow (self-registration, PKCE, the callback exchange), the stored
 * grant, and keeping the access token fresh for the cloud provider.
 *
 * Resource strategy: the cloud publishes an `/api` protected resource, but as
 * of 2026-07 dynamically-registered clients are only granted the MCP resource
 * — requesting `/api` bounces with `invalid_scope` before login. beginConnect
 * therefore PREFLIGHTS the authorize URL server-side, asking for `/api`
 * first and falling back to the MCP resource, so connect works today and
 * upgrades itself the day the cloud widens the DCR grant.
 */

/** Scopes for the cloud REST API, from its protected-resource metadata. */
const API_SCOPES = [
  'comfy-cloud:workflows:read',
  'comfy-cloud:workflows:write',
  'comfy-cloud:jobs:read',
  'comfy-cloud:jobs:write',
  'comfy-cloud:files:read',
  'comfy-cloud:files:write',
  'comfy-cloud:user:read',
]
/** Scopes on the MCP resource — the grant every DCR client has today. */
const MCP_SCOPES = ['comfy-mcp:tools:read', 'comfy-mcp:tools:call']

const STATE_TTL_MS = 10 * 60_000
/** Refresh when the access token has less than this long to live. */
const EXPIRY_SLACK_MS = 60_000
const PROBE_TIMEOUT_MS = 8_000

interface PendingState {
  verifier: string
  resource: string
  createdAt: number
}

export interface ComfyAccessToken {
  accessToken: string
  /** Whether this grant was accepted by the cloud REST API at connect time. */
  apiAccess: boolean
}

export function createComfyAuthService(env: Env, settings: SettingsService) {
  const issuer = env.comfyCloud.apiUrl
  const redirectUri = `${env.appUrl}/api/connect/comfy/callback`

  // Pending authorize states live in memory: the flow spans seconds, and a
  // broker restart mid-flow just means clicking Sign in again.
  const pending = new Map<string, PendingState>()
  const sweepPending = () => {
    const cutoff = Date.now() - STATE_TTL_MS
    for (const [state, entry] of pending) if (entry.createdAt < cutoff) pending.delete(state)
  }

  /** The stored client id, or a freshly-registered one (persisted before use). */
  async function obtainClientId(registrationEndpoint: string): Promise<string> {
    const stored = settings.getComfyOAuthClient()
    if (stored && stored.issuer === issuer && stored.redirectUri === redirectUri) {
      return stored.clientId
    }
    const clientId = await registerClient({
      registrationEndpoint,
      redirectUri,
      scopes: [...API_SCOPES, ...MCP_SCOPES],
    })
    settings.setComfyOAuthClient({ clientId, issuer, redirectUri })
    return clientId
  }

  /**
   * Preflight an authorize URL without a browser. The cloud validates the
   * client/resource/scope BEFORE login: a good request 302s to its login
   * page; a bad one 302s straight back to our callback with ?error=.
   */
  async function preflight(
    url: string,
  ): Promise<{ ok: true } | { ok: false; error: string; description: string }> {
    const res = await fetchWithTimeout(url, { redirect: 'manual', timeoutMs: PROBE_TIMEOUT_MS })
    const location = res.headers.get('location') ?? ''
    if (res.status >= 300 && res.status < 400 && !location.startsWith(redirectUri)) {
      return { ok: true }
    }
    if (location.startsWith(redirectUri)) {
      const q = new URL(location).searchParams
      return {
        ok: false,
        error: q.get('error') ?? 'unknown',
        description: q.get('error_description') ?? '',
      }
    }
    const body = await res.text().catch(() => '')
    return { ok: false, error: `http_${res.status}`, description: body.slice(0, 200) }
  }

  return {
    /**
     * Start the sign-in: returns the authorize URL the browser should visit.
     * Tries the `/api` resource first, falls back to the MCP resource, and
     * re-registers the client once if the cloud no longer recognises it.
     */
    async beginConnect(): Promise<string> {
      sweepPending()
      const endpoints = await resolveEndpoints(issuer)
      let clientId = await obtainClientId(endpoints.registrationEndpoint)
      let reRegistered = false

      const attempts = [
        { resource: `${issuer}/api`, scopes: API_SCOPES },
        { resource: `${issuer}/mcp`, scopes: MCP_SCOPES },
      ]
      let lastFailure = ''
      for (let i = 0; i < attempts.length; i++) {
        const attempt = attempts[i]!
        const state = randomBytes(24).toString('hex')
        const { verifier, challenge } = generatePkce()
        const url = buildAuthorizeUrl({
          authorizationEndpoint: endpoints.authorizationEndpoint,
          clientId,
          redirectUri,
          state,
          challenge,
          resource: attempt.resource,
          scopes: attempt.scopes,
        })
        const result = await preflight(url)
        if (result.ok) {
          pending.set(state, { verifier, resource: attempt.resource, createdAt: Date.now() })
          return url
        }
        // A 4xx (not a scope bounce) usually means the stored dyn client was
        // wiped cloud-side — mint a new one and retry this same attempt once.
        if (result.error.startsWith('http_') && !reRegistered) {
          settings.setComfyOAuthClient(null)
          clientId = await obtainClientId(endpoints.registrationEndpoint)
          reRegistered = true
          i--
          continue
        }
        lastFailure = `${result.error}${result.description ? `: ${result.description}` : ''}`
      }
      throw new Error(`Comfy Cloud refused the sign-in request (${lastFailure})`)
    },

    /**
     * Complete the callback: validate state, exchange the code, probe whether
     * the grant works on the REST API, and store the whole thing encrypted.
     */
    async completeCallback(query: {
      code?: string
      state?: string
      error?: string
      error_description?: string
    }): Promise<{ apiAccess: boolean; email: string | null }> {
      sweepPending()
      if (query.error) {
        throw new Error(query.error_description || `Comfy Cloud sign-in failed (${query.error})`)
      }
      const entry = query.state ? pending.get(query.state) : undefined
      if (!query.code || !query.state || !entry) {
        throw new Error('Sign-in session expired or invalid — try again')
      }
      pending.delete(query.state) // single-use

      const endpoints = await resolveEndpoints(issuer)
      const client = settings.getComfyOAuthClient()
      if (!client) throw new Error('Sign-in session expired or invalid — try again')
      const tokens = await exchangeCode({
        tokenEndpoint: endpoints.tokenEndpoint,
        clientId: client.clientId,
        redirectUri,
        code: query.code,
        verifier: entry.verifier,
      })

      // Does this grant actually work on the REST API? 401/403 = no (an
      // MCP-audience token the API rejects); anything else (200, or even 429
      // for an inactive subscription) proves the credential is accepted.
      const bearer = { Authorization: `Bearer ${tokens.accessToken}` }
      let apiAccess = false
      try {
        const probe = await fetchWithTimeout(`${issuer}/api/queue`, {
          headers: bearer,
          timeoutMs: PROBE_TIMEOUT_MS,
        })
        apiAccess = probe.status !== 401 && probe.status !== 403
      } catch {
        // Unreachable probe: don't hard-fail the sign-in — assume the best.
        apiAccess = true
      }

      // Best-effort account email, purely for "Connected as …" in the UI.
      let email: string | null = null
      try {
        const me = await fetchWithTimeout(`${issuer}/api/customers/me`, {
          headers: bearer,
          timeoutMs: PROBE_TIMEOUT_MS,
        })
        if (me.ok) {
          email = ((await me.json()) as { email?: string }).email ?? null
        }
      } catch {
        // no email — the UI just says "Connected"
      }

      settings.setComfyOAuthTokens({
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken,
        scope: tokens.scope,
        resource: entry.resource,
        apiAccess,
        email,
      })
      return { apiAccess, email }
    },

    /**
     * A live access token, refreshed if it's about to expire — or null when
     * not signed in. Refreshes are single-flight (rotating refresh tokens:
     * a concurrent second refresh would trip reuse detection and revoke the
     * whole grant) and the rotated token is persisted before use. A dead
     * grant clears the stored sign-in; a transient refresh failure returns
     * the current token if it still has life left, else null (retried on the
     * next call).
     */
    getAccessToken: (() => {
      let refreshing: Promise<ComfyAccessToken | null> | null = null

      const doRefresh = async (): Promise<ComfyAccessToken | null> => {
        const stored = settings.getComfyOAuthTokens()
        if (!stored) return null
        if (stored.expiresAt - Date.now() > EXPIRY_SLACK_MS) {
          return { accessToken: stored.accessToken, apiAccess: stored.apiAccess }
        }
        const client = settings.getComfyOAuthClient()
        if (!stored.refreshToken || !client) {
          settings.setComfyOAuthTokens(null)
          return null
        }
        try {
          const endpoints = await resolveEndpoints(issuer)
          const rotated = await refreshTokens({
            tokenEndpoint: endpoints.tokenEndpoint,
            clientId: client.clientId,
            refreshToken: stored.refreshToken,
          })
          settings.setComfyOAuthTokens({
            ...stored,
            accessToken: rotated.accessToken,
            expiresAt: rotated.expiresAt,
            // Rotation should always return a new refresh token; keep the old
            // one only if the server omitted it.
            refreshToken: rotated.refreshToken ?? stored.refreshToken,
            scope: rotated.scope ?? stored.scope,
          })
          return { accessToken: rotated.accessToken, apiAccess: stored.apiAccess }
        } catch (err) {
          if (err instanceof OAuthGrantError) {
            settings.setComfyOAuthTokens(null) // revoked/expired — sign in again
            return null
          }
          // Transient (network/5xx): limp along on the current token if it
          // hasn't actually expired yet.
          if (stored.expiresAt > Date.now()) {
            return { accessToken: stored.accessToken, apiAccess: stored.apiAccess }
          }
          return null
        }
      }

      return async (): Promise<ComfyAccessToken | null> => {
        const stored = settings.getComfyOAuthTokens()
        if (!stored) return null
        if (stored.expiresAt - Date.now() > EXPIRY_SLACK_MS) {
          return { accessToken: stored.accessToken, apiAccess: stored.apiAccess }
        }
        refreshing ??= doRefresh().finally(() => {
          refreshing = null
        })
        return refreshing
      }
    })(),

    /** Forget the sign-in (the registered client is kept for reuse). */
    disconnect(): void {
      settings.setComfyOAuthTokens(null)
    },
  }
}

export type ComfyAuthService = ReturnType<typeof createComfyAuthService>
