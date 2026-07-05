import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { fetchWithTimeout } from '../../http.js'

/**
 * Shopify OAuth helpers — authorize URL, callback HMAC verification, and the
 * code→token exchange. The client_secret only ever lives here, server-side.
 */

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

/** Normalize user input ("mystore" or "mystore.myshopify.com") to a full shop domain. */
export function normalizeShopDomain(input: string): string | null {
  const trimmed = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
  const domain = trimmed.includes('.') ? trimmed : `${trimmed}.myshopify.com`
  return SHOP_DOMAIN_RE.test(domain) ? domain : null
}

export function generateOAuthState(): string {
  return randomBytes(24).toString('hex')
}

export function buildAuthorizeUrl(params: {
  shop: string
  apiKey: string
  scopes: string
  redirectUri: string
  state: string
}): string {
  const url = new URL(`https://${params.shop}/admin/oauth/authorize`)
  url.searchParams.set('client_id', params.apiKey)
  url.searchParams.set('scope', params.scopes)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('state', params.state)
  return url.toString()
}

/**
 * Verify the HMAC on an OAuth callback: every query param except `hmac`
 * (and legacy `signature`), sorted lexicographically, joined as a query
 * string, HMAC-SHA256 with the client secret, hex-encoded.
 */
export function verifyCallbackHmac(query: Record<string, string>, apiSecret: string): boolean {
  const { hmac, signature: _signature, ...rest } = query
  if (!hmac) return false
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join('&')
  const digest = createHmac('sha256', apiSecret).update(message).digest('hex')
  const a = Buffer.from(digest, 'utf8')
  const b = Buffer.from(hmac, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Verify an inbound webhook: HMAC-SHA256 of the raw body, base64-encoded. */
export function verifyWebhookHmac(
  rawBody: Buffer | string,
  hmacHeader: string,
  apiSecret: string,
): boolean {
  const digest = createHmac('sha256', apiSecret).update(rawBody).digest('base64')
  const a = Buffer.from(digest, 'utf8')
  const b = Buffer.from(hmacHeader, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface TokenExchangeResult {
  accessToken: string
  scopes: string[]
}

/** Exchange the OAuth code for an offline access token. */
export async function exchangeCodeForToken(params: {
  shop: string
  code: string
  apiKey: string
  apiSecret: string
  timeoutMs?: number
}): Promise<TokenExchangeResult> {
  // No retries: the code is single-use — a blind re-POST can only fail.
  const res = await fetchWithTimeout(`https://${params.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: params.apiKey,
      client_secret: params.apiSecret,
      code: params.code,
    }),
    timeoutMs: params.timeoutMs ?? 30_000,
  })
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { access_token: string; scope: string }
  return { accessToken: body.access_token, scopes: body.scope.split(',').map((s) => s.trim()) }
}
