/**
 * Minimal Shopify Admin GraphQL client with cost-based throttle retry.
 */

import { fetchWithTimeout } from '../../http.js'

export class ShopifyGraphqlError extends Error {
  constructor(
    message: string,
    public readonly errors: unknown,
  ) {
    super(message)
  }
}

interface GraphqlResponse<T> {
  data?: T
  errors?: Array<{ message: string; extensions?: { code?: string } }>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function shopifyGraphql<T>(params: {
  shop: string
  accessToken: string
  apiVersion: string
  query: string
  variables?: Record<string, unknown>
  /** Per-request deadline (headers + body). */
  timeoutMs?: number
}): Promise<T> {
  const url = `https://${params.shop}/admin/api/${params.apiVersion}/graphql.json`
  let attempt = 0
  for (;;) {
    attempt += 1
    // No transport-level retries: mutations (productCreateMedia …) must never
    // be silently re-sent — the publish pipeline's crash-safe resume assumes a
    // single create call. The 429/THROTTLED loops below are safe: Shopify
    // rejected those requests before executing them.
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': params.accessToken,
      },
      body: JSON.stringify({ query: params.query, variables: params.variables ?? {} }),
      timeoutMs: params.timeoutMs ?? 30_000,
    })
    if (res.status === 429 && attempt <= 4) {
      await sleep(1000 * attempt)
      continue
    }
    if (!res.ok) {
      throw new ShopifyGraphqlError(`Shopify GraphQL HTTP ${res.status}`, await res.text())
    }
    const body = (await res.json()) as GraphqlResponse<T>
    if (body.errors?.length) {
      const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED')
      if (throttled && attempt <= 4) {
        await sleep(1200 * attempt)
        continue
      }
      throw new ShopifyGraphqlError(body.errors.map((e) => e.message).join('; '), body.errors)
    }
    if (!body.data) throw new ShopifyGraphqlError('Empty GraphQL response', body)
    return body.data
  }
}
