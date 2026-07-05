import type { Collection, MediaItem, Product } from '@comfy-commerce/shared'
import { eq } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { mockCatalogs } from '../db/schema.js'
import { buildMockCatalog, type MockCatalogData } from '../mock/catalog.js'
import type {
  AddMediaParams,
  ReplaceMediaParams,
  RestoreMediaParams,
  StoreConnector,
  StoreRecord,
} from './types.js'

/**
 * Mock-store media is always broker-hosted; persist root-relative paths so
 * catalog URLs stay valid regardless of host/port.
 */
function relativize(url: string): string {
  return url.replace(/^https?:\/\/[^/]+(?=\/)/, '')
}

/** Monotonic suffix so rapid successive adds get distinct media ids (Date.now alone collides). */
let addedSeq = 0

/**
 * Mock Shopify adapter. Serves the seeded demo catalog from SQLite and
 * applies publishes/reverts to it, so the full round-trip — including
 * replace-in-place and snapshot revert — is observable without a real store.
 */
export class MockConnector implements StoreConnector {
  /**
   * One-shot failure injection for replaceMedia partial-failure tests: throws
   * 'Injected failure before <step>' AFTER the preceding step has persisted,
   * reproducing real Shopify's non-atomic create → move → delete sequence.
   * Read-and-cleared on the next replaceMedia call.
   */
  static failNextReplaceStep: 'move' | 'delete' | null = null

  constructor(private db: Db) {}

  private load(storeId: string): MockCatalogData {
    const row = this.db.select().from(mockCatalogs).where(eq(mockCatalogs.storeId, storeId)).get()
    if (row) return row.data
    const data = buildMockCatalog()
    this.db.insert(mockCatalogs).values({ storeId, data }).run()
    return data
  }

  private save(storeId: string, data: MockCatalogData): void {
    this.db
      .update(mockCatalogs)
      .set({ data })
      .where(eq(mockCatalogs.storeId, storeId))
      .run()
  }

  async listCollections(store: StoreRecord): Promise<Collection[]> {
    return this.load(store.id).collections
  }

  async listProducts(store: StoreRecord): Promise<Product[]> {
    return this.load(store.id).products
  }

  async getProduct(store: StoreRecord, productId: string): Promise<Product | null> {
    return this.load(store.id).products.find((p) => p.id === productId) ?? null
  }

  /** Resolve one media BY ID with its current position — null when gone. */
  async snapshotMedia(
    store: StoreRecord,
    productId: string,
    mediaId: string,
  ): Promise<MediaItem | null> {
    const product = await this.getProduct(store, productId)
    return product?.media.find((m) => m.id === mediaId) ?? null
  }

  /**
   * Mirrors the real connector's id-addressed create-before-delete sequence in
   * three separately persisted steps — create at tail (then onCreated), move to
   * the target's current slot, delete the target by id — so injected failures
   * (failNextReplaceStep) leave the same partial states a real Shopify outage
   * would, and resume via createdMediaId is exercised identically.
   */
  async replaceMedia(store: StoreRecord, params: ReplaceMediaParams): Promise<{ mediaId: string }> {
    const failStep = MockConnector.failNextReplaceStep
    MockConnector.failNextReplaceStep = null

    const find = () => {
      const data = this.load(store.id)
      const product = data.products.find((p) => p.id === params.productId)
      if (!product) throw new Error(`Product not found: ${params.productId}`)
      return { data, product }
    }

    let { data, product } = find()
    // Resume: a previous attempt's created media is still on the product.
    let newId =
      params.createdMediaId && product.media.some((m) => m.id === params.createdMediaId)
        ? params.createdMediaId
        : null
    // Fail fast when the target is gone and there is nothing to resume — the
    // item must be re-staged, never degraded to a blind add (mirrors real).
    if (!newId && !product.media.some((m) => m.id === params.targetMediaId)) {
      throw new Error(`Target media not found: ${params.targetMediaId}`)
    }

    // Step 1 — create the new media at the tail, persist, then acknowledge via
    // onCreated (the crash-safe recording hook — fires before move/delete).
    if (!newId) {
      newId = `${params.targetMediaId.split('@')[0]}@${Date.now()}-${(addedSeq += 1)}`
      product.media.push({
        id: newId,
        url: relativize(params.newUrl),
        altText: params.altText,
        position: product.media.length + 1,
        mediaType: params.mediaType,
      })
      this.save(store.id, data)
      await params.onCreated?.(newId)
    }

    if (failStep === 'move') throw new Error('Injected failure before move')

    // Step 2 — move the new media to the target's CURRENT index, persist.
    ;({ data, product } = find())
    if (product.media.some((m) => m.id === params.targetMediaId)) {
      const entry = product.media.find((m) => m.id === newId)!
      product.media = product.media.filter((m) => m.id !== newId)
      const targetIndex = product.media.findIndex((m) => m.id === params.targetMediaId)
      product.media.splice(targetIndex, 0, entry)
      product.media = product.media.map((m, i) => ({ ...m, position: i + 1 }))
      this.save(store.id, data)
    }

    if (failStep === 'delete') throw new Error('Injected failure before delete')

    // Step 3 — remove the target by id, persist. Already gone (resume after an
    // external delete) ⇒ nothing to remove — succeed.
    ;({ data, product } = find())
    if (product.media.some((m) => m.id === params.targetMediaId)) {
      product.media = product.media
        .filter((m) => m.id !== params.targetMediaId)
        .map((m, i) => ({ ...m, position: i + 1 }))
      this.save(store.id, data)
    }

    return { mediaId: newId }
  }

  async addMedia(store: StoreRecord, params: AddMediaParams): Promise<{ mediaId: string }> {
    const data = this.load(store.id)
    const product = data.products.find((p) => p.id === params.productId)
    if (!product) throw new Error(`Product not found: ${params.productId}`)
    // Resume: a previous attempt already created the media — never re-create.
    if (params.createdMediaId && product.media.some((m) => m.id === params.createdMediaId)) {
      return { mediaId: params.createdMediaId }
    }
    const mediaId = `${params.productId}-added-${Date.now()}-${(addedSeq += 1)}`
    const entry = {
      id: mediaId,
      url: relativize(params.url),
      altText: params.altText,
      position: 0,
      mediaType: params.mediaType,
    }
    // Insert at the requested 1-based slot (keeping existing media), else append.
    const index =
      params.position === undefined
        ? product.media.length
        : Math.max(0, Math.min(params.position - 1, product.media.length))
    product.media.splice(index, 0, entry)
    product.media = product.media.map((m, i) => ({ ...m, position: i + 1 }))
    this.save(store.id, data)
    await params.onCreated?.(mediaId)
    return { mediaId }
  }

  async removeMedia(store: StoreRecord, productId: string, mediaId: string): Promise<void> {
    const data = this.load(store.id)
    const product = data.products.find((p) => p.id === productId)
    if (!product) throw new Error(`Product not found: ${productId}`)
    product.media = product.media
      .filter((m) => m.id !== mediaId)
      .map((m, i) => ({ ...m, position: i + 1 }))
    this.save(store.id, data)
  }

  async reorderMedia(store: StoreRecord, productId: string, orderedMediaIds: string[]): Promise<void> {
    const data = this.load(store.id)
    const product = data.products.find((p) => p.id === productId)
    if (!product) throw new Error(`Product not found: ${productId}`)
    const byId = new Map(product.media.map((m) => [m.id, m]))
    const head: typeof product.media = []
    for (const id of orderedMediaIds) {
      const m = byId.get(id)
      if (m) {
        head.push(m)
        byId.delete(id)
      }
    }
    const tail = product.media.filter((m) => byId.has(m.id))
    product.media = [...head, ...tail].map((m, i) => ({ ...m, position: i + 1 }))
    this.save(store.id, data)
  }

  /**
   * Id-addressed revert: the restored entry takes the PUBLISHED media's current
   * slot and only the published media is removed; when it is already gone the
   * restored entry lands at the snapshot's (clamped) slot and nothing is
   * deleted. Reuses snapshot.id — a mock-only convenience so tests can assert
   * "the original media id is back" (real Shopify mints a fresh id).
   */
  async restoreMedia(store: StoreRecord, params: RestoreMediaParams): Promise<{ mediaId: string }> {
    const data = this.load(store.id)
    const product = data.products.find((p) => p.id === params.productId)
    if (!product) throw new Error(`Product not found: ${params.productId}`)
    const entry = {
      id: params.snapshot.id,
      url: relativize(params.snapshot.url),
      altText: params.snapshot.altText,
      position: 0,
      mediaType: params.snapshot.mediaType,
    }
    const publishedIndex = product.media.findIndex((m) => m.id === params.publishedMediaId)
    if (publishedIndex !== -1) {
      product.media.splice(publishedIndex, 1, entry)
    } else {
      const index = Math.max(0, Math.min(params.snapshot.position - 1, product.media.length))
      product.media.splice(index, 0, entry)
    }
    product.media = product.media.map((m, i) => ({ ...m, position: i + 1 }))
    this.save(store.id, data)
    return { mediaId: entry.id }
  }

  async disconnect(store: StoreRecord): Promise<void> {
    this.db.delete(mockCatalogs).where(eq(mockCatalogs.storeId, store.id)).run()
  }
}
