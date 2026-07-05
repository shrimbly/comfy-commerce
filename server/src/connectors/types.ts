import type { Collection, MediaItem, Product, StagedMediaType } from '@comfy-commerce/shared'

import type { stores } from '../db/schema.js'

export type StoreRecord = typeof stores.$inferSelect

export interface ReplaceMediaParams {
  productId: string
  /**
   * Media id to replace. Resolution and deletion are strictly BY ID — the
   * target's current position at operation time is only the placement hint
   * for the new media. If the target no longer exists and there is nothing to
   * resume via `createdMediaId`, the connector must fail fast (the item needs
   * re-staging against the current catalog), never degrade to a blind add.
   */
  targetMediaId: string
  /** Publicly resolvable URL of the new media. */
  newUrl: string
  altText: string
  mediaType: StagedMediaType
  /**
   * Media created by a previous failed/interrupted attempt — resume it
   * (reuse/await readiness), never create a second copy.
   */
  createdMediaId?: string | null
  /**
   * Fired the moment creation is acknowledged, BEFORE the readiness wait /
   * move / delete — the crash-safe hook for recording the new media id.
   */
  onCreated?: (mediaId: string) => void | Promise<void>
}

export interface AddMediaParams {
  productId: string
  /** Publicly resolvable URL of the media to append. */
  url: string
  altText: string
  mediaType: StagedMediaType
  /**
   * 1-based slot to insert at, keeping existing media (e.g. 1 = featured, prior
   * featured shifts down). Omitted ⇒ append to the end.
   */
  position?: number
  /** Media created by a previous failed/interrupted attempt — resume, never re-create. */
  createdMediaId?: string | null
  /** Fired the moment creation is acknowledged (see ReplaceMediaParams.onCreated). */
  onCreated?: (mediaId: string) => void | Promise<void>
}

export interface RestoreMediaParams {
  productId: string
  /** The media snapshot taken before the destructive write. */
  snapshot: MediaItem
  /**
   * The media the replace publish created — deleted BY ID; its current slot
   * receives the restored media. If it is already gone from the store, the
   * restore still succeeds (goal state achieved) and deletes nothing.
   */
  publishedMediaId: string
}

/**
 * Media-source connector — the read/write adapter for one commerce platform.
 * Shopify is connector #1; the staging ledger and review pipeline never
 * depend on a specific implementation.
 *
 * Destructive operations are ID-ADDRESSED: they resolve, move and delete media
 * strictly by media id. Gallery positions are only ever placement hints
 * resolved at operation time — a reordered gallery must never change WHICH
 * media an operation destroys.
 */
export interface StoreConnector {
  listCollections(store: StoreRecord): Promise<Collection[]>
  /** Full unscoped catalog (scope filtering happens in the service layer). */
  listProducts(store: StoreRecord): Promise<Product[]>
  getProduct(store: StoreRecord, productId: string): Promise<Product | null>
  /**
   * Snapshot one media by id — the revert safety net. Returns the MediaItem
   * with its CURRENT position, or null when the media no longer exists.
   */
  snapshotMedia(store: StoreRecord, productId: string, mediaId: string): Promise<MediaItem | null>
  /**
   * Replace-in-place: destructive, only ever called on approved items.
   * Create-before-delete and resumable via `createdMediaId`/`onCreated`.
   * Returns the new media's id.
   */
  replaceMedia(store: StoreRecord, params: ReplaceMediaParams): Promise<{ mediaId: string }>
  /** Append media to a product (the add-new publish path). */
  addMedia(store: StoreRecord, params: AddMediaParams): Promise<{ mediaId: string }>
  /**
   * Delete a specific media (revert of an add-new publish). Idempotent:
   * a missing media id is a silent no-op, never an error.
   */
  removeMedia(store: StoreRecord, productId: string, mediaId: string): Promise<void>
  /** Force the listed media to positions 1..N in order; unlisted media keep their relative order after. */
  reorderMedia(store: StoreRecord, productId: string, orderedMediaIds: string[]): Promise<void>
  /**
   * Restore a prior-media snapshot (revert of a replace publish): re-create the
   * snapshot media, place it in the published media's current slot and delete
   * the published media by id. Returns the restored media's id.
   */
  restoreMedia(store: StoreRecord, params: RestoreMediaParams): Promise<{ mediaId: string }>
  disconnect(store: StoreRecord): Promise<void>
}
