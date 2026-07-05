import type { GallerySlotRef, StagingItem } from '@comfy-commerce/shared'

import type { GalleryEditorData } from '../../api/hooks.js'

/**
 * Gallery tile ids: existing Shopify media is `m:<mediaId>`, a staged (not yet
 * published) result is `s:<itemId>`.
 */

/** Encode a slot as a stable Reorder value, and back to a ref for persistence. */
export const refOf = (id: string): GallerySlotRef =>
  id.startsWith('m:') ? { kind: 'media', mediaId: id.slice(2) } : { kind: 'staged', itemId: id.slice(2) }

/**
 * Build a faithful default preview of the post-publish gallery, then let any
 * saved arrangement override it. Replace-in-place results take the slot of the
 * media they replace, so that media is hidden — only the new image is shown.
 */
export function buildInitialOrder(data: GalleryEditorData): string[] {
  const replaceByPos = new Map<number, StagingItem>()
  for (const i of data.approvedItems) {
    if (i.action === 'replace-position') replaceByPos.set(i.targetPosition, i)
  }

  // Default order: featured additions · existing media (replaced slots swapped
  // for their new result) · appended additions.
  const defaultOrder: string[] = []
  for (const i of data.approvedItems) if (i.action === 'add-featured') defaultOrder.push(`s:${i.id}`)
  for (const m of [...data.media].sort((a, b) => a.position - b.position)) {
    const rep = replaceByPos.get(m.position)
    defaultOrder.push(rep ? `s:${rep.id}` : `m:${m.id}`)
  }
  for (const i of data.approvedItems) if (i.action === 'add-new') defaultOrder.push(`s:${i.id}`)
  // Safety net: never drop an approved result whose target slot didn't resolve.
  const placed = new Set(defaultOrder)
  for (const i of data.approvedItems) {
    const id = `s:${i.id}`
    if (!placed.has(id)) {
      defaultOrder.push(id)
      placed.add(id)
    }
  }

  // A saved arrangement made purely of existing-media refs (no staged ones) is
  // a post-publish snapshot of the last gallery order. Once a fresh batch of
  // edits is staged, that snapshot is stale: honouring it would shove
  // replace-in-place results to the end instead of into the slot they replace.
  // Drop it and fall back to the in-place default order (which the publish step
  // then persists, since it saves the shown order first).
  const arrangement = data.arrangement ?? []
  const staleSnapshot =
    arrangement.length > 0 &&
    data.approvedItems.length > 0 &&
    !arrangement.some((r) => r.kind === 'staged')

  // Otherwise the saved arrangement wins (valid slots only — stale/replaced
  // refs drop out); anything approved since it was saved trails in default order.
  const valid = new Set(defaultOrder)
  const out = (staleSnapshot ? [] : arrangement)
    .map((r) => (r.kind === 'media' ? `m:${r.mediaId}` : `s:${r.itemId}`))
    .filter((id) => valid.has(id))
  const seen = new Set(out)
  for (const id of defaultOrder) if (!seen.has(id)) out.push(id)
  return out
}
