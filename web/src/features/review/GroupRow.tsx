import type { StagingItem } from '@comfy-commerce/shared'
import { Check, ICON, IconBox, Maximize2 } from '../../lib/icons.js'
import { motion } from 'motion/react'

import { Model3DThumb } from '../../components/ui/Model3DViewer.js'
import { STATUS_STYLES } from '../../components/ui/StatusChip.js'
import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'
import { actionLabel, StagingActions } from './ReviewCard.js'

/**
 * One generated output inside a product group. A row shows its source image
 * alongside its result when the source differs from the row above; rows that
 * share a source leave a blank slot, attaching to the thumbnail above them.
 * Every row keeps its own approve / reject.
 */
export function GroupRow({
  item,
  originalUrl,
  busy,
  selected,
  onToggleSelect,
  onApprove,
  onReject,
  onPublish,
  onRevert,
  onRetry,
  onExpand,
}: {
  item: StagingItem
  /** Source image — set when this row's source differs from the row above; null rows attach to the source above. */
  originalUrl: string | null
  busy: boolean
  selected: boolean
  onToggleSelect: (shift: boolean) => void
  onApprove: () => void
  onReject: () => void
  onPublish: () => void
  onRevert: () => void
  onRetry?: () => void
  onExpand: () => void
}) {
  const status = STATUS_STYLES[item.state]
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.35, ease: easeSoft }}
      onClick={(e) => onToggleSelect(e.shiftKey)}
      className={cn(
        'group flex cursor-pointer items-center gap-4 border-b border-line px-5 py-1.5 transition-colors select-none last:border-b-0',
        selected ? 'bg-surface-2' : 'hover:bg-surface-2/40',
      )}
    >
      {/* Source column: the original on the first row; a blank slot afterwards
          so every result lines up in the same column. */}
      {originalUrl ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onExpand()
          }}
          title="Inspect before / after"
          className="group/thumb relative size-20 shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-line bg-surface-2"
        >
          {item.action !== 'add-new' && item.mediaType === 'model3d' ? (
            <Model3DThumb />
          ) : item.action !== 'add-new' && item.mediaType === 'video' ? (
            <video src={originalUrl} muted playsInline className="h-full w-full object-cover" />
          ) : (
            <img src={originalUrl} alt="Original" loading="lazy" className="h-full w-full object-cover" />
          )}
        </button>
      ) : (
        <div className="size-20 shrink-0" aria-hidden />
      )}

      {/* The generated result — click to inspect, checkbox (on hover) to select. */}
      <div
        onClick={(e) => {
          e.stopPropagation()
          onExpand()
        }}
        title="Inspect before / after"
        className="group/thumb relative size-20 shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-line bg-surface-2"
      >
        {item.mediaType === 'model3d' ? (
          <Model3DThumb />
        ) : item.mediaType === 'video' ? (
          <video src={item.afterUrl} muted playsInline className="h-full w-full object-cover" />
        ) : (
          <img src={item.afterUrl} alt="After" loading="lazy" className="h-full w-full object-cover" />
        )}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ink/25 text-surface opacity-0 transition-opacity group-hover/thumb:opacity-100">
          <IconBox>
            <Maximize2 {...ICON} />
          </IconBox>
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect(e.shiftKey)
          }}
          aria-label={selected ? 'Deselect' : 'Select'}
          className={cn(
            'absolute top-1.5 left-1.5 z-10 flex size-5 cursor-pointer items-center justify-center rounded-md shadow-soft transition-all',
            selected
              ? 'bg-ink text-surface opacity-100'
              : 'pointer-events-none border border-line-strong bg-surface/90 text-ink opacity-0 group-hover:pointer-events-auto group-hover:opacity-100',
          )}
        >
          <Check size={14} strokeWidth={1.5} absoluteStrokeWidth />
        </button>
      </div>

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm text-ink-faint">
          <span title={status.label} className={cn('size-2.5 shrink-0 rounded-full', status.dot)} />
          <span className="truncate">
            {actionLabel(item)}
            {item.source === 'api' && ' · via API'}
          </span>
        </p>
        {item.state === 'failed' && (
          <p className="mt-1 text-sm text-danger" title={item.error ?? undefined}>
            {item.error ? `Publish failed: ${item.error}` : 'Publish failed — retry or reject.'}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <StagingActions
          onRetry={onRetry}
          item={item}
          busy={busy}
          onApprove={onApprove}
          onReject={onReject}
          onPublish={onPublish}
          onRevert={onRevert}
        />
      </div>
    </motion.article>
  )
}
