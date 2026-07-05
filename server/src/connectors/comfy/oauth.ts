import { createHash, randomBytes } from 'node:crypto'

import { fetchWithTimeout } from '../../http.js'

/**
 * Comfy Cloud OAuth 2.0 — Authorization Code + PKCE (S256), public client, no
 * secret. The broker runs the whole flow server-side: it discovers the cloud's
 * endpoints (RFC 8414), mints its own public `comfy-dyn-*` client via Dynamic
 * Client Registration (RFC 7591, loopback redirect → native client), and
 * exchanges/refreshes tokens directly — the browser only visits the authorize
 * page. Verified live against cloud.comfy.org.
 */

/** RFC 8414 authorization-server metadata, the subset the broker uses. */
interface ServerMetadata {
  authorization_endpoint?: string
  token_endpoint?: string
  registration_endpoint?: string
}

export interface ResolvedEndpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
}

/** The token set POST /oauth/token returns, with expiry made absolute. */
export interface OAuthTokens {
  accessToken: string
  /** Epoch ms when the access token expires (derived from expires_in). */
  expiresAt: number
  refreshToken: string | null
  scope: string | null
}

const DISCOVERY_PATH = '/.well-known/oauth-authorization-server'
const REQUEST_TIMEOUT_MS = 15_000

/** Conventional {issuer}/oauth/* paths, used when discovery is unreachable. */
function fallbackEndpoints(issuer: string): ResolvedEndpoints {
  return {
    authorizationEndpoint: `${issuer}/oauth/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
    registrationEndpoint: `${issuer}/oauth/register`,
  }
}

// Discovery rarely changes — cache per issuer for the process lifetime.
const endpointsCache = new Map<string, ResolvedEndpoints>()

/** Resolve authorize/token/register endpoints via discovery, with fallback. */
export async function resolveEndpoints(issuer: string): Promise<ResolvedEndpoints> {
  const cached = endpointsCache.get(issuer)
  if (cached) return cached
  const fb = fallbackEndpoints(issuer)
  try {
    const res = await fetchWithTimeout(`${issuer}${DISCOVERY_PATH}`, {
      headers: { Accept: 'application/json' },
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    if (!res.ok) return fb
    const meta = (await res.json()) as ServerMetadata
    const resolved = {
      authorizationEndpoint: meta.authorization_endpoint ?? fb.authorizationEndpoint,
      tokenEndpoint: meta.token_endpoint ?? fb.tokenEndpoint,
      registrationEndpoint: meta.registration_endpoint ?? fb.registrationEndpoint,
    }
    endpointsCache.set(issuer, resolved)
    return resolved
  } catch {
    return fb // unreachable discovery is not fatal — fall back, don't cache
  }
}

/** Test escape hatch: drop cached discovery results. */
export function clearEndpointsCache(): void {
  endpointsCache.clear()
}

/**
 * Mint a public PKCE client via Dynamic Client Registration. A loopback
 * (http://localhost) redirect registers as a `native` client — the desktop
 * pattern the cloud already permits; https registers as `web`. The caller
 * persists the returned client_id and reuses it across restarts.
 */
export async function registerClient(params: {
  registrationEndpoint: string
  redirectUri: string
  /** Scopes requested for the client's grant (space-joined in the DCR body). */
  scopes: string[]
}): Promise<string> {
  const res = await fetchWithTimeout(params.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      application_type: /^https:/i.test(params.redirectUri) ? 'web' : 'native',
      redirect_uris: [params.redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Comfy Commerce',
      scope: params.scopes.join(' '),
    }),
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  const body = (await res.json().catch(() => null)) as {
    client_id?: string
    error?: string
    error_description?: string
  } | null
  if (!res.ok || !body?.client_id) {
    const reason = body?.error_description ?? body?.error ?? `HTTP ${res.status}`
    throw new Error(`Comfy Cloud client registration failed: ${reason}`)
  }
  return body.client_id
}

export interface PkcePair {
  verifier: string
  challenge: string
}

/** RFC 7636: random verifier + BASE64URL(SHA256(verifier)) challenge. */
export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function buildAuthorizeUrl(params: {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  state: string
  challenge: string
  /** RFC 8707 protected-resource URI — the cloud requires one on authorize. */
  resource: string
  scopes: string[]
}): string {
  const url = new URL(params.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('state', params.state)
  url.searchParams.set('code_challenge', params.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('resource', params.resource)
  if (params.scopes.length > 0) url.searchParams.set('scope', params.scopes.join(' '))
  return url.toString()
}

/** Exchange the authorization code for tokens. Public client: no secret, PKCE only. */
export async function exchangeCode(params: {
  tokenEndpoint: string
  clientId: string
  redirectUri: string
  code: string
  verifier: string
}): Promise<OAuthTokens> {
  return postToken(
    params.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.verifier,
    }),
  )
}

/**
 * Rotate a refresh token for a fresh access token. The cloud returns a NEW
 * refresh token each time and revokes the whole family if an old one is
 * reused — callers must persist the rotated token before using the new access
 * token, and must never run two refreshes concurrently.
 */
export async function refreshTokens(params: {
  tokenEndpoint: string
  clientId: string
  refreshToken: string
}): Promise<OAuthTokens> {
  return postToken(
    params.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      client_id: params.clientId,
    }),
  )
}

/** Thrown when the grant itself is dead (revoked/expired) — re-connect required. */
export class OAuthGrantError extends Error {}

async function postToken(tokenEndpoint: string, body: URLSearchParams): Promise<OAuthTokens> {
  // No retries: authorization codes are single-use and refresh tokens rotate —
  // a blind re-POST can only fail (or worse, trip reuse detection).
  const res = await fetchWithTimeout(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  const json = (await res.json().catch(() => null)) as {
    access_token?: string
    expires_in?: number
    refresh_token?: string
    scope?: string
    error?: string
    error_description?: string
  } | null
  if (!res.ok || !json?.access_token) {
    const reason = json?.error_description ?? json?.error ?? `HTTP ${res.status}`
    if (json?.error === 'invalid_grant') {
      throw new OAuthGrantError(`Comfy Cloud sign-in expired: ${reason}`)
    }
    throw new Error(`Comfy Cloud token request failed: ${reason}`)
  }
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    refreshToken: json.refresh_token ?? null,
    scope: json.scope ?? null,
  }
}
