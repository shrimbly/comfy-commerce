import type { StagedMediaType } from '@comfy-commerce/shared'
import { Reorder } from 'motion/react'

import { Model3DThumb } from '../../components/ui/Model3DViewer.js'
import { cn } from '../../lib/cn.js'
import { X } from '../../lib/icons.js'

export interface GalleryTile {
  url: string
  /** Set on staged (not yet published) results — badges the tile and enables reject. */
  itemId?: string
  mediaType?: StagedMediaType
}

/**
 * One product's gallery as a drag-reorderable strip of tiles: existing media +
 * staged results in the order they'd publish. Purely presentational — the
 * owner holds the order, persists it, and handles rejects.
 */
export function GalleryStrip({
  order,
  tiles,
  onReorder,
  onReject,
}: {
  order: string[]
  tiles: Map<string, GalleryTile>
  onReorder: (next: string[]) => void
  onReject: (itemId: string) => void
}) {
  return (
    <Reorder.Group axis="x" values={order} onReorder={onReorder} className="flex flex-wrap gap-2 px-5 py-3">
      {order.map((id) => {
        const tile = tiles.get(id)
        if (!tile) return null
        return (
          <Reorder.Item
            key={id}
            value={id}
            className={cn(
              'group/tile relative size-20 shrink-0 cursor-grab overflow-hidden rounded-lg border bg-surface-2 active:cursor-grabbing',
              tile.itemId ? 'border-ink' : 'border-line',
            )}
          >
            {tile.mediaType === 'model3d' ? (
              <Model3DThumb />
            ) : tile.mediaType === 'video' ? (
              <video src={tile.url} muted playsInline className="h-full w-full object-cover" />
            ) : (
              <img src={tile.url} alt="" draggable={false} className="h-full w-full object-cover" />
            )}
            {tile.itemId && (
              <>
                <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-ink/55 py-0.5 text-center text-[10px] font-medium text-surface">
                  New
                </span>
                <button
                  onClick={() => onReject(tile.itemId!)}
                  aria-label="Reject"
                  title="Reject"
                  className="absolute top-1 right-1 flex size-5 cursor-pointer items-center justify-center rounded-md bg-surface/90 text-ink opacity-0 shadow-soft transition-opacity group-hover/tile:opacity-100 hover:bg-danger-soft hover:text-danger"
                >
                  <X size={13} strokeWidth={1.5} absoluteStrokeWidth />
                </button>
              </>
            )}
          </Reorder.Item>
        )
      })}
    </Reorder.Group>
  )
}
