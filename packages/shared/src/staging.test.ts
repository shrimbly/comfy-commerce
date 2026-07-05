import { describe, expect, it } from 'vitest'

import type { StagingItem, StagingState } from './staging.js'
import { countByState } from './staging.js'

// THE GATE (publish only from approved; failed→publishing retry; reject rules)
// is enforced by the atomic SQL claim in server/src/services/stagingService.ts
// and is covered end-to-end by the named gate suite in
// server/test/gateClaim.test.ts. This file tests only the pure read-model
// helpers that remain in the shared domain.

let nextId = 0
function makeItem(state: StagingState): StagingItem {
  nextId += 1
  return {
    id: `item-${nextId}`,
    storeId: 'store-1',
    productId: 'prod-1',
    productTitle: 'Linen Tee',
    variantTitle: null,
    beforeUrl: 'https://cdn.example/before.jpg',
    afterUrl: 'https://cdn.example/after.jpg',
    action: 'add-featured',
    mediaType: 'image',
    targetPosition: 1,
    targetMediaId: null,
    priorMediaSnapshot: null,
    publishedMediaId: null,
    state,
    error: null,
    recipeId: 'relight',
    runId: null,
    sourceMediaId: null,
    source: 'ui',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('staging read model', () => {
  it('counts items by state', () => {
    const items = [
      makeItem('pending'),
      makeItem('pending'),
      makeItem('approved'),
      makeItem('published'),
      makeItem('failed'),
    ]
    expect(countByState(items)).toEqual({
      pending: 2,
      approved: 1,
      publishing: 0,
      published: 1,
      rejected: 0,
      failed: 1,
    })
  })

  it('returns zero for every state on an empty ledger', () => {
    expect(countByState([])).toEqual({
      pending: 0,
      approved: 0,
      publishing: 0,
      published: 0,
      rejected: 0,
      failed: 0,
    })
  })
})
