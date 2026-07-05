/**
 * Catalog domain — the connector-agnostic shape of a linked store's media.
 *
 * Shopify is connector #1, so these types are Shopify-shaped, but nothing in
 * the staging/review pipeline depends on Shopify specifically.
 */

import type { StagedMediaType } from './staging.js'

export type StoreStatus = 'connected' | 'connecting' | 'error'
export type ProductStatus = 'active' | 'draft' | 'archived'

/** Which media of each product are exposed to the tool. */
export type MediaRole = 'featured' | 'all' | 'all-with-video'

export interface MediaItem {
  id: string
  /** Publicly fetchable URL (Shopify CDN in real mode; broker mock CDN in mock mode). */
  url: string
  altText: string
  /** 1-based position within the product's media list. */
  position: number
  /** Media kind — absent defaults to image (most catalog media is imagery). */
  mediaType?: StagedMediaType
  /**
   * Catalog-enrichment fields — populated from the media_enrichment store when
   * the image has been captioned. Absent until an enrichment run has run over it.
   */
  caption?: string | null
  tags?: string[]
  /** ISO timestamp of the most recent enrichment for this image. */
  enrichedAt?: string
  /** Model that produced the caption/tags (e.g. "gemini-2.5-flash"). */
  enrichmentModel?: string | null
}

/**
 * AI-generated caption + tags for one product image, keyed by (product, media).
 * Produced by the built-in catalog-enrichment workflow; powers search/filter.
 */
export interface MediaEnrichment {
  productId: string
  mediaId: string
  caption: string | null
  tags: string[]
  /** Engine/model that produced it, e.g. "Qwen2.5-VL-3B-Instruct". */
  model: string
  updatedAt: string
}

export interface ProductVariant {
  id: string
  /** e.g. "White / M" */
  title: string
}

export interface Product {
  id: string
  title: string
  status: ProductStatus
  collectionIds: string[]
  tags: string[]
  media: MediaItem[]
  variants: ProductVariant[]
}

export interface Collection {
  id: string
  title: string
}

/** A saved "what should the tool see" filter, per connected store. */
export interface ScopeProfile {
  collectionIds: string[] | 'all'
  tags: string[]
  productStatus: ProductStatus
  mediaRole: MediaRole
}

export const DEFAULT_SCOPE_PROFILE: ScopeProfile = {
  collectionIds: 'all',
  tags: [],
  productStatus: 'active',
  // Every product image by default — narrowing to featured-only is an
  // explicit choice in the connector's scope settings.
  mediaRole: 'all',
}

export interface ConnectedStore {
  id: string
  /** e.g. mystore.myshopify.com */
  domain: string
  /** Connector that owns this store (e.g. "shopify"). */
  connectorId: string
  status: StoreStatus
  /** Granted access scopes, e.g. ['read_products', 'write_products']. */
  scopes: string[]
  lastSyncedAt: string | null
  scopeProfile: ScopeProfile
  /** Store name from Shopify (`shop.name`), for display over the bare domain. */
  shopName: string | null
  /** Storefront favicon URL (best-effort); null ⇒ fall back to a Shopify mark. */
  faviconUrl: string | null
}

/** Does a product fall inside a store's scope profile? */
export function matchesScope(product: Product, scope: ScopeProfile): boolean {
  if (product.status !== scope.productStatus) return false
  if (scope.collectionIds !== 'all') {
    const inCollection = product.collectionIds.some((id) => scope.collectionIds.includes(id))
    if (!inCollection) return false
  }
  if (scope.tags.length > 0) {
    const hasTag = product.tags.some((tag) => scope.tags.includes(tag))
    if (!hasTag) return false
  }
  return true
}

/** The media of a product exposed by a scope profile's media role. */
export function mediaInScope(product: Product, scope: ScopeProfile): MediaItem[] {
  if (scope.mediaRole === 'featured') {
    const featured = product.media.find((m) => m.position === 1)
    return featured ? [featured] : []
  }
  // 'all' and 'all-with-video' are identical until video/3D media is modeled.
  return product.media
}

export interface ScopeCount {
  products: number
  images: number
}

/** Live "≈ N images across M products" count for a scope profile. */
export function countInScope(products: Product[], scope: ScopeProfile): ScopeCount {
  const scoped = products.filter((p) => matchesScope(p, scope))
  const images = scoped.reduce((sum, p) => sum + mediaInScope(p, scope).length, 0)
  return { products: scoped.length, images }
}
