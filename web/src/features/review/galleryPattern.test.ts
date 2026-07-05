import { describe, expect, it } from 'vitest'

import { applyPattern, describePattern, detectPattern } from './galleryPattern.js'

// Source listing's new tiles in canonical (staging) order.
const NEW = ['s:1', 's:2', 's:3']

describe('detectPattern', () => {
  it('returns null when there are no new tiles', () => {
    expect(detectPattern(['m:a', 'm:b'], NEW)).toBeNull()
  })

  it('detects a leading block as start, with the identity permutation', () => {
    expect(detectPattern(['s:1', 's:2', 'm:a', 'm:b'], ['s:1', 's:2'])).toEqual({
      kind: 'start',
      seq: [0, 1],
    })
  })

  it('detects a trailing block as end', () => {
    expect(detectPattern(['m:a', 'm:b', 's:1'], ['s:1'])).toEqual({ kind: 'end', seq: [0] })
  })

  it('detects a mid-gallery block with its slot', () => {
    expect(detectPattern(['m:a', 's:1', 's:2', 'm:b'], ['s:1', 's:2'])).toEqual({
      kind: 'block',
      index: 1,
      seq: [0, 1],
    })
  })

  it('an all-new gallery reads as start, not end', () => {
    expect(detectPattern(['s:1', 's:2'], ['s:1', 's:2'])).toEqual({ kind: 'start', seq: [0, 1] })
  })

  it('captures the permutation of new tiles among themselves', () => {
    // [orig, n1, n2, n3] → [n1, n3, n2, orig]: block at start, order 1-3-2.
    expect(detectPattern(['s:1', 's:3', 's:2', 'm:a'], NEW)).toEqual({
      kind: 'start',
      seq: [0, 2, 1],
    })
  })

  it('a permutation-only swap still changes the pattern (same slots)', () => {
    const before = detectPattern(['m:a', 's:1', 's:2', 's:3'], NEW)
    const after = detectPattern(['m:a', 's:2', 's:1', 's:3'], NEW)
    expect(before).toEqual({ kind: 'end', seq: [0, 1, 2] })
    expect(after).toEqual({ kind: 'end', seq: [1, 0, 2] })
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after))
  })

  it('scattered new tiles fall back to exact slots with their sequence', () => {
    expect(detectPattern(['s:2', 'm:a', 's:1', 'm:b'], ['s:1', 's:2'])).toEqual({
      kind: 'slots',
      slots: [
        { index: 0, seq: 1 },
        { index: 2, seq: 0 },
      ],
    })
  })
})

describe('applyPattern', () => {
  it('start puts every new tile first, keeping existing relative order', () => {
    expect(
      applyPattern({ kind: 'start', seq: [0, 1] }, ['m:a', 's:x', 'm:b', 's:y'], ['s:x', 's:y']),
    ).toEqual(['s:x', 's:y', 'm:a', 'm:b'])
  })

  it('end appends the new tiles', () => {
    expect(applyPattern({ kind: 'end', seq: [0] }, ['s:x', 'm:a', 'm:b'], ['s:x'])).toEqual([
      'm:a',
      'm:b',
      's:x',
    ])
  })

  it('transfers the permutation onto the target by sequence index', () => {
    // Source arranged n1, n3, n2 first — target's own k-th adds follow suit.
    expect(
      applyPattern(
        { kind: 'start', seq: [0, 2, 1] },
        ['m:a', 't:1', 't:2', 't:3'],
        ['t:1', 't:2', 't:3'],
      ),
    ).toEqual(['t:1', 't:3', 't:2', 'm:a'])
  })

  it('drops sequence indexes the target lacks and appends its surplus adds', () => {
    // Source permutation over 3 adds, target has 2 → seq 2 drops out.
    expect(
      applyPattern({ kind: 'start', seq: [0, 2, 1] }, ['m:a', 't:1', 't:2'], ['t:1', 't:2']),
    ).toEqual(['t:1', 't:2', 'm:a'])
    // Source permutation over 1 add, target has 3 → extras follow in default order.
    expect(
      applyPattern({ kind: 'start', seq: [0] }, ['m:a', 't:1', 't:2', 't:3'], ['t:1', 't:2', 't:3']),
    ).toEqual(['t:1', 't:2', 't:3', 'm:a'])
  })

  it('block inserts the new tiles as one run at the slot, clamped', () => {
    expect(
      applyPattern({ kind: 'block', index: 1, seq: [0, 1] }, ['m:a', 'm:b', 's:x', 's:y'], ['s:x', 's:y']),
    ).toEqual(['m:a', 's:x', 's:y', 'm:b'])
    expect(applyPattern({ kind: 'block', index: 5, seq: [0] }, ['m:a', 's:x'], ['s:x'])).toEqual([
      'm:a',
      's:x',
    ])
  })

  it('slots land on their final-order coordinates with the permutation', () => {
    expect(
      applyPattern(
        {
          kind: 'slots',
          slots: [
            { index: 1, seq: 1 },
            { index: 3, seq: 0 },
          ],
        },
        ['s:x', 's:y', 'm:a', 'm:b'],
        ['s:x', 's:y'],
      ),
    ).toEqual(['m:a', 's:y', 'm:b', 's:x'])
  })

  it('surplus new tiles follow the last placed slot', () => {
    expect(
      applyPattern(
        { kind: 'slots', slots: [{ index: 1, seq: 0 }] },
        ['t:1', 't:2', 't:3', 'm:a', 'm:b'],
        ['t:1', 't:2', 't:3'],
      ),
    ).toEqual(['m:a', 't:1', 't:2', 't:3', 'm:b'])
  })

  it('a listing with no new tiles is untouched', () => {
    expect(applyPattern({ kind: 'start', seq: [0] }, ['m:a', 'm:b'], [])).toEqual(['m:a', 'm:b'])
  })
})

describe('describePattern', () => {
  it('names each placement in plain language', () => {
    expect(describePattern({ kind: 'start', seq: [0, 1] })).toBe('Place new images at the start')
    expect(describePattern({ kind: 'end', seq: [0] })).toBe('Place new images at the end')
    expect(describePattern({ kind: 'block', index: 1, seq: [0] })).toBe(
      'Place new images at position 2',
    )
    expect(describePattern({ kind: 'slots', slots: [{ index: 0, seq: 0 }] })).toBe(
      "Match this listing's image positions",
    )
    expect(describePattern({ kind: 'end', seq: [0] }, 'media')).toBe('Place new media at the end')
  })

  it('flags a non-identity permutation', () => {
    expect(describePattern({ kind: 'start', seq: [0, 2, 1] })).toBe(
      'Place new images at the start, in this order',
    )
  })
})
