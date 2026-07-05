/**
 * Review-screen helpers — pure resolution and grouping logic shared by the
 * web studio and its tests.
 *
 * Both exist because staging items now carry `sourceMediaId` (the media the
 * workflow ran on): retries must re-run the EXACT image the operator is
 * looking at, and group rows must attribute each result to ITS OWN source.
 */

import type { MediaRef, Run } from './runs.js'
import type { StagingItem } from './staging.js'

/**
 * Resolve the run input that produced a staged result — the exact media,
 * never "the first item for this product".
 *
 * Legacy rows (staged before sourceMediaId existed) fall back to a productId
 * match ONLY when the run touched exactly one media of that product; several
 * matches ⇒ null. Refusing an ambiguous retry is safer than re-running the
 * wrong image.
 */
export function findRunSourceInput(
  run: Pick<Run, 'items'>,
  item: Pick<StagingItem, 'productId' | 'sourceMediaId'>,
): MediaRef | null {
  if (item.sourceMediaId) {
    const match = run.items.find(
      (i) => i.input.productId === item.productId && i.input.mediaId === item.sourceMediaId,
    )
    return match?.input ?? null
  }
  const candidates = run.items.filter((i) => i.input.productId === item.productId)
  return candidates.length === 1 ? candidates[0]!.input : null
}

export interface ReviewGroupRow {
  item: StagingItem
  /**
   * Source image for this row — set on the first row of each same-source
   * block; null rows visually attach to the source shown above them.
   */
  sourceUrl: string | null
}

/** One review-screen group: a run's outputs for one product. */
export interface ReviewGroup {
  key: string
  productTitle: string
  rows: ReviewGroupRow[]
}

/**
 * Group staging items for the review list: by run + product (insertion order
 * preserved), then stable-partition each group into adjacent blocks of equal
 * beforeUrl — blocks ordered by first occurrence, row order inside a block
 * preserved. The source column collapses ONLY when rows genuinely share a
 * source; a run that edited several images shows each row's own source.
 */
export function groupReviewItems(items: StagingItem[]): ReviewGroup[] {
  const byKey = new Map<string, { key: string; productTitle: string; items: StagingItem[] }>()
  for (const item of items) {
    const key = `${item.runId ?? `solo-${item.id}`}::${item.productId}`
    const group = byKey.get(key)
    if (group) group.items.push(item)
    else byKey.set(key, { key, productTitle: item.productTitle, items: [item] })
  }
  return [...byKey.values()].map((group) => {
    // Stable partition: adjacency matters because a blank source slot reads
    // as "same source as the row above".
    const blocks = new Map<string, StagingItem[]>()
    for (const item of group.items) {
      const block = blocks.get(item.beforeUrl)
      if (block) block.push(item)
      else blocks.set(item.beforeUrl, [item])
    }
    const rows: ReviewGroupRow[] = []
    for (const block of blocks.values()) {
      block.forEach((item, i) => rows.push({ item, sourceUrl: i === 0 ? item.beforeUrl : null }))
    }
    return { key: group.key, productTitle: group.productTitle, rows }
  })
}
