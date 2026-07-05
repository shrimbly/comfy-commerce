/**
 * Staging / review-gate domain.
 *
 * The invariant that defines this product: NOTHING reaches a live store
 * without human approval. `publish` transitions only from `approved`, and
 * `stage` always creates `pending` items — including for headless/automated
 * pipelines.
 *
 * This module owns the domain TYPES and pure read-model helpers only. The
 * gate itself is enforced server-side by the atomic SQL claim in
 * server/src/services/stagingService.ts (publishOne's
 * `UPDATE … WHERE state IN ('approved','failed')`), and is covered by the
 * named gate suite in server/test/gateClaim.test.ts.
 */

import type { MediaItem } from './catalog.js'

export type StagingState =
  | 'pending' //     freshly staged, awaiting human decision
  | 'approved' //    human approved; ready to publish, not yet live
  | 'publishing' //  mutation in flight
  | 'published' //   live on the storefront
  | 'rejected' //    human rejected; will not publish
  | 'failed' //      publish attempt errored; retryable

/**
 * add-featured inserts the result at the featured slot (position 1) while
 * KEEPING the prior featured image (it shifts down); add-new appends the
 * result as additional media. Both are non-destructive — revert deletes the
 * added media. replace-position swaps the live media in place (revert restores
 * a snapshot).
 */
export type StageAction = 'add-featured' | 'replace-position' | 'add-new'

/**
 * One slot in a product's gallery arrangement: either an existing Shopify media
 * (reorder-only) or an approved staging item not yet published (resolved to its
 * published media id at publish time).
 */
export type GallerySlotRef =
  | { kind: 'media'; mediaId: string }
  | { kind: 'staged'; itemId: string }

/** A persisted full-gallery order for one product, set on the Review Approved tab. */
export interface GalleryArrangement {
  storeId: string
  productId: string
  order: GallerySlotRef[]
  updatedAt: string
}

export type StagedMediaType = 'image' | 'video' | 'model3d'

export interface StagingItem {
  id: string
  storeId: string
  productId: string
  productTitle: string
  /** null ⇒ applies to product / "All variants". */
  variantTitle: string | null
  /** The live media being replaced (or the source image, for add-new). */
  beforeUrl: string
  /** The AI-edited result. */
  afterUrl: string
  /** Workflows can emit video and 3D models (GLB) as well as images. */
  mediaType: StagedMediaType
  action: StageAction
  /** Which 1-based media slot is being replaced (insertion point for add-new). */
  targetPosition: number
  /**
   * Live media this item addresses: for replace-position the media that
   * publish deletes; for add-* the source media the result came from.
   * null only on rows staged before identity tracking.
   */
  targetMediaId: string | null
  /** Safety net for revert — snapshotted just before the destructive write. */
  priorMediaSnapshot: MediaItem | null
  /** Media created by an add-new publish — revert deletes it. */
  publishedMediaId: string | null
  state: StagingState
  /** Failure reason from the last publish/revert attempt — null unless `failed`. */
  error: string | null
  /** Workflow that produced the edit, for display/audit (e.g. "Relight"). */
  recipeId: string | null
  /** Run that staged this item (null for direct API stages). */
  runId: string | null
  /**
   * Media the workflow/API ran on — immutable provenance, distinct from
   * targetMediaId (which is re-pointed on revert). null only for rows staged
   * before this column existed.
   */
  sourceMediaId: string | null
  /** 'ui' or 'api' — where the stage call came from. Both land in the same queue. */
  source: 'ui' | 'api'
  createdAt: string
  updatedAt: string
}

export function countByState(items: StagingItem[]): Record<StagingState, number> {
  const counts: Record<StagingState, number> = {
    pending: 0,
    approved: 0,
    publishing: 0,
    published: 0,
    rejected: 0,
    failed: 0,
  }
  for (const item of items) counts[item.state] += 1
  return counts
}
