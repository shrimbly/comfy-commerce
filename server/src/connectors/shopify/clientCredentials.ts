/**
 * Client credentials grant — how Dev Dashboard apps (the post-2026 replacement
 * for legacy custom apps) authenticate against the Admin API. The granted
 * token expires after 24 hours; the broker re-exchanges transparently.
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 */

import { fetchWithTimeout } from '../../http.js'

export interface GrantedToken {
  accessToken: string
  scopes: string[]
  /** ISO timestamp with a 5-minute safety margin before the real expiry. */
  expiresAt: string
}

export async function exchangeClientCredentials(params: {
  shop: string
  clientId: string
  clientSecret: string
  timeoutMs?: number
}): Promise<GrantedToken> {
  const res = await fetchWithTimeout(`https://${params.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: 'client_credentials',
    }),
    timeoutMs: params.timeoutMs ?? 30_000,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw Object.assign(
      new Error(`Shopify rejected the client credentials (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`),
      { statusCode: 400 },
    )
  }
  const body = (await res.json()) as { access_token: string; scope: string; expires_in: number }
  if (!body.access_token) {
    throw Object.assign(new Error('Token exchange returned no access token'), { statusCode: 400 })
  }
  return {
    accessToken: body.access_token,
    scopes: body.scope ? body.scope.split(',').map((s) => s.trim()) : [],
    expiresAt: new Date(Date.now() + Math.max(60, (body.expires_in ?? 86399) - 300) * 1000).toISOString(),
  }
}
