/**
 * "Apply this arrangement to the rest" — the transferable part of a gallery
 * reorder. Listings differ in gallery length and new-image count, so what
 * carries over is (a) the PLACEMENT of the new (staged) tiles relative to the
 * existing ones and (b) the PERMUTATION of the new tiles among themselves —
 * the k-th generated image on one listing corresponds to the k-th on another,
 * so "second result before first" transfers by sequence index. Detection
 * favours a describable placement (start / end / position k) and falls back
 * to exact slot indexes when the new tiles are scattered.
 */

export type ArrangementPattern =
  /** `seq` is the new tiles' order by DEFAULT sequence index, e.g. [0,2,1]. */
  | { kind: 'start'; seq: number[] }
  | { kind: 'end'; seq: number[] }
  /** A contiguous run of new tiles starting at this 0-based slot. */
  | { kind: 'block'; index: number; seq: number[] }
  /** Scattered new tiles — exact 0-based slots, each with its sequence index. */
  | { kind: 'slots'; slots: Array<{ index: number; seq: number }> }

/**
 * Read the placement + permutation of new tiles out of a final order.
 * `defaultNewOrder` is the listing's new tiles in their canonical sequence
 * (staging order) — it defines both membership and the seq indexes.
 * null ⇒ no new tiles.
 */
export function detectPattern(
  order: string[],
  defaultNewOrder: string[],
): ArrangementPattern | null {
  const seqOf = new Map(defaultNewOrder.map((id, i) => [id, i]))
  const slots: Array<{ index: number; seq: number }> = []
  order.forEach((id, index) => {
    const seq = seqOf.get(id)
    if (seq !== undefined) slots.push({ index, seq })
  })
  if (slots.length === 0) return null
  const contiguous = slots[slots.length - 1]!.index - slots[0]!.index === slots.length - 1
  if (!contiguous) return { kind: 'slots', slots }
  const seq = slots.map((s) => s.seq)
  if (slots[0]!.index === 0) return { kind: 'start', seq }
  if (slots[slots.length - 1]!.index === order.length - 1) return { kind: 'end', seq }
  return { kind: 'block', index: slots[0]!.index, seq }
}

/**
 * The target's new tiles arranged per the source's permutation: sequence
 * indexes the target doesn't have drop out, and its surplus new tiles follow
 * in their own default order.
 */
function permute(seq: number[], defaultNewOrder: string[]): string[] {
  const picked = seq.filter((s) => s < defaultNewOrder.length).map((s) => defaultNewOrder[s]!)
  const used = new Set(picked)
  return [...picked, ...defaultNewOrder.filter((id) => !used.has(id))]
}

/**
 * Re-place another listing's new tiles per the pattern. Existing tiles keep
 * their relative order; new tiles take the source's permutation; positions
 * clamp to the target gallery's length. `slots` pairs new tiles with slots in
 * ascending order — any surplus new tiles follow the last placed one.
 */
export function applyPattern(
  pattern: ArrangementPattern,
  order: string[],
  defaultNewOrder: string[],
): string[] {
  if (defaultNewOrder.length === 0) return order
  const newSet = new Set(defaultNewOrder)
  const existing = order.filter((id) => !newSet.has(id))
  switch (pattern.kind) {
    case 'start':
      return [...permute(pattern.seq, defaultNewOrder), ...existing]
    case 'end':
      return [...existing, ...permute(pattern.seq, defaultNewOrder)]
    case 'block': {
      const at = Math.min(pattern.index, existing.length)
      return [...existing.slice(0, at), ...permute(pattern.seq, defaultNewOrder), ...existing.slice(at)]
    }
    case 'slots': {
      // Ascending inserts land on final-order coordinates directly: each slot
      // index already accounts for the new tiles placed before it.
      const fresh = permute(pattern.slots.map((s) => s.seq), defaultNewOrder)
      const out = [...existing]
      let last = -1
      fresh.forEach((id, i) => {
        const at = Math.min(i < pattern.slots.length ? pattern.slots[i]!.index : last + 1, out.length)
        out.splice(at, 0, id)
        last = at
      })
      return out
    }
  }
}

/** Is the pattern's internal new-image order just the default sequence? */
function isIdentity(seq: number[]): boolean {
  return seq.every((s, i) => s === i)
}

/** The prompt's plain-language name for the pattern. */
export function describePattern(pattern: ArrangementPattern, noun = 'images'): string {
  if (pattern.kind === 'slots') return `Match this listing's ${noun.replace(/s$/, '')} positions`
  const where =
    pattern.kind === 'start'
      ? 'at the start'
      : pattern.kind === 'end'
        ? 'at the end'
        : `at position ${pattern.index + 1}`
  const reordered = isIdentity(pattern.seq) ? '' : ', in this order'
  return `Place new ${noun} ${where}${reordered}`
}
