import { describe, expect, it } from 'vitest'

import type { Run, RunItem } from './runs.js'
import { findRunSourceInput, groupReviewItems } from './review.js'
import type { StagingItem } from './staging.js'

function runItem(productId: string, mediaId: string): RunItem {
  return {
    input: { productId, mediaId },
    productTitle: 'Linen Tee',
    state: 'done',
    afterUrl: `https://cdn.example/after-${mediaId}.png`,
    error: null,
  }
}

const runWith = (...items: RunItem[]): Pick<Run, 'items'> => ({ items })

let nextId = 0
function makeItem(overrides: Partial<StagingItem> = {}): StagingItem {
  nextId += 1
  return {
    id: `item-${nextId}`,
    storeId: 'store-1',
    productId: 'prod-1',
    productTitle: 'Linen Tee',
    variantTitle: null,
    beforeUrl: 'https://cdn.example/before.jpg',
    afterUrl: 'https://cdn.example/after.jpg',
    mediaType: 'image',
    action: 'replace-position',
    targetPosition: 1,
    targetMediaId: null,
    priorMediaSnapshot: null,
    publishedMediaId: null,
    state: 'pending',
    error: null,
    recipeId: 'relight',
    runId: 'run-1',
    sourceMediaId: null,
    source: 'ui',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('findRunSourceInput', () => {
  it('#6 regression: resolves the EXACT source media, not the first item for the product', () => {
    const run = runWith(runItem('prod-1', 'm1'), runItem('prod-1', 'm2'), runItem('prod-1', 'm3'))
    const source = findRunSourceInput(run, makeItem({ sourceMediaId: 'm3' }))
    expect(source).toEqual({ productId: 'prod-1', mediaId: 'm3' })
  })

  it('scopes the media match to the item product', () => {
    // Same media id under a different product must not match.
    const run = runWith(runItem('prod-other', 'm1'), runItem('prod-1', 'm1'))
    const source = findRunSourceInput(run, makeItem({ sourceMediaId: 'm1' }))
    expect(source).toEqual({ productId: 'prod-1', mediaId: 'm1' })
  })

  it('legacy fallback: a null sourceMediaId resolves only when exactly one run item matches the product', () => {
    const single = runWith(runItem('prod-1', 'm1'), runItem('prod-2', 'm9'))
    expect(findRunSourceInput(single, makeItem({ sourceMediaId: null }))).toEqual({
      productId: 'prod-1',
      mediaId: 'm1',
    })
  })

  it('legacy fallback: refuses to guess between several run items for the product', () => {
    const ambiguous = runWith(runItem('prod-1', 'm1'), runItem('prod-1', 'm2'))
    expect(findRunSourceInput(ambiguous, makeItem({ sourceMediaId: null }))).toBeNull()
  })

  it('returns null when the recorded source media is no longer in the run', () => {
    const run = runWith(runItem('prod-1', 'm1'), runItem('prod-1', 'm2'))
    expect(findRunSourceInput(run, makeItem({ sourceMediaId: 'm-gone' }))).toBeNull()
  })
})

describe('groupReviewItems', () => {
  it('#10 regression: rows with different beforeUrls each carry their own sourceUrl', () => {
    const a = makeItem({ beforeUrl: 'https://cdn.example/img-a.jpg' })
    const b = makeItem({ beforeUrl: 'https://cdn.example/img-b.jpg' })
    const groups = groupReviewItems([a, b])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.rows.map((r) => r.sourceUrl)).toEqual([
      'https://cdn.example/img-a.jpg',
      'https://cdn.example/img-b.jpg',
    ])
  })

  it('collapses the source column only for rows that genuinely share a beforeUrl', () => {
    const first = makeItem({ beforeUrl: 'https://cdn.example/shared.jpg' })
    const second = makeItem({ beforeUrl: 'https://cdn.example/shared.jpg' })
    const groups = groupReviewItems([first, second])
    expect(groups[0]!.rows.map((r) => r.sourceUrl)).toEqual([
      'https://cdn.example/shared.jpg',
      null,
    ])
  })

  it('re-partitions interleaved sources into adjacent blocks ordered by first occurrence', () => {
    const a1 = makeItem({ beforeUrl: 'url-a' })
    const b1 = makeItem({ beforeUrl: 'url-b' })
    const a2 = makeItem({ beforeUrl: 'url-a' })
    const groups = groupReviewItems([a1, b1, a2])
    expect(groups[0]!.rows.map((r) => r.item.id)).toEqual([a1.id, a2.id, b1.id])
    expect(groups[0]!.rows.map((r) => r.sourceUrl)).toEqual(['url-a', null, 'url-b'])
  })

  it('keeps the same product staged by different runs in separate groups', () => {
    const fromRun1 = makeItem({ runId: 'run-1' })
    const fromRun2 = makeItem({ runId: 'run-2' })
    const groups = groupReviewItems([fromRun1, fromRun2])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.rows[0]!.item.id).toBe(fromRun1.id)
    expect(groups[1]!.rows[0]!.item.id).toBe(fromRun2.id)
  })

  it('never merges solo items (null runId), even for the same product', () => {
    const solo1 = makeItem({ runId: null })
    const solo2 = makeItem({ runId: null })
    const groups = groupReviewItems([solo1, solo2])
    expect(groups).toHaveLength(2)
  })

  it('preserves group insertion order and separates products within one run', () => {
    const p1 = makeItem({ productId: 'prod-1' })
    const p2 = makeItem({ productId: 'prod-2', productTitle: 'Stoneware Vase' })
    const groups = groupReviewItems([p1, p2])
    expect(groups.map((g) => g.key)).toEqual(['run-1::prod-1', 'run-1::prod-2'])
    expect(groups[1]!.productTitle).toBe('Stoneware Vase')
  })
})
