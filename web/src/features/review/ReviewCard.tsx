import type { StagedMediaType, StagingItem } from '@comfy-commerce/shared'
import { Check, ICON, IconBox, Maximize2, RotateCcw, Undo2, X } from '../../lib/icons.js'
import { motion } from 'motion/react'

import { Button } from '../../components/ui/Button.js'
import { Model3DThumb } from '../../components/ui/Model3DViewer.js'
import { Spinner } from '../../components/ui/Spinner.js'
import { STATUS_STYLES } from '../../components/ui/StatusChip.js'
import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'

/** Adds (new + featured) are non-destructive — reverting removes the published media. */
const isAdd = (item: StagingItem): boolean => item.action === 'add-new' || item.action === 'add-featured'

/** Human label for a media type — used in action copy and captions. */
export function mediaNoun(type: StagedMediaType): string {
  return type === 'video' ? 'video' : type === 'model3d' ? '3D model' : 'image'
}

export function actionLabel(item: StagingItem): string {
  const kind = mediaNoun(item.mediaType)
  const base =
    item.action === 'add-new'
      ? `Add as new ${kind}`
      : item.action === 'add-featured'
        ? `Add as featured ${kind}`
        : `Replace image #${item.targetPosition}`
  return item.state === 'published' && item.priorMediaSnapshot ? `${base} · prior saved` : base
}

/** State-appropriate review actions — shared by list rows and the lightbox. */
export function StagingActions({
  item,
  busy,
  onApprove,
  onReject,
  onPublish,
  onRevert,
  onRetry,
}: {
  item: StagingItem
  busy: boolean
  onApprove: () => void
  onReject: () => void
  onPublish: () => void
  onRevert: () => void
  /** Re-run the workflow that produced this result. Omitted for API-staged
   *  items, which have no source run to re-run. */
  onRetry?: () => void
}) {
  if (busy) return <Spinner />
  // Re-run the source workflow — sits to the left of reject / remove.
  const retry = onRetry && (
    <Button variant="ghost" size="sm" onClick={onRetry}>
      <IconBox>
        <RotateCcw {...ICON} />
      </IconBox>
      Retry
    </Button>
  )
  return (
    <>
      {item.state === 'pending' && (
        <>
          {retry}
          <Button variant="ghost" size="sm" onClick={onReject}>
            <IconBox>
              <X {...ICON} />
            </IconBox>
            Reject
          </Button>
          <Button variant="success" size="sm" onClick={onApprove}>
            <IconBox>
              <Check {...ICON} />
            </IconBox>
            Approve
          </Button>
        </>
      )}
      {item.state === 'approved' && (
        <>
          {retry}
          <Button variant="ghost" size="sm" onClick={onReject}>
            <IconBox>
              <X {...ICON} />
            </IconBox>
            Reject
          </Button>
          {/* Adds change the gallery's composition, so their publish goes
              through the Finalize step (header CTA) where the order is set;
              in-place replacements keep one-click publish. */}
          {item.action === 'replace-position' && (
            <Button variant="primary" size="sm" onClick={onPublish}>
              Publish
            </Button>
          )}
        </>
      )}
      {item.state === 'published' && (
        <>
          {retry}
          <Button
            variant="ghost"
            size="sm"
            onClick={onRevert}
            disabled={
              isAdd(item)
                ? !item.publishedMediaId
                : !item.priorMediaSnapshot || !item.publishedMediaId
            }
          >
            <IconBox>
              <Undo2 {...ICON} />
            </IconBox>
            {isAdd(item) ? 'Remove' : 'Revert'}
          </Button>
        </>
      )}
      {item.state === 'failed' && (
        <>
          <Button variant="ghost" size="sm" onClick={onReject}>
            <IconBox>
              <X {...ICON} />
            </IconBox>
            Reject
          </Button>
          <Button variant="primary" size="sm" onClick={onPublish}>
            <IconBox>
              <RotateCcw {...ICON} />
            </IconBox>
            Retry
          </Button>
        </>
      )}
    </>
  )
}

export function ReviewCard({
  item,
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
        'group flex cursor-pointer items-center gap-4 border-b border-line px-5 py-4 transition-colors select-none last:border-b-0',
        selected ? 'bg-surface-2' : 'hover:bg-surface-2/40',
      )}
    >
      {/* After-image thumbnail. Click it (anywhere but the checkbox) to inspect
          the before / after; click the checkbox to (de)select for bulk actions. */}
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

        {/* Inspect hint — a dim + expand glyph on hover. */}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ink/25 text-surface opacity-0 transition-opacity group-hover/thumb:opacity-100">
          <IconBox>
            <Maximize2 {...ICON} />
          </IconBox>
        </span>

        {/* Bulk-select checkbox — appears on row hover / when selected. */}
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
        <h3 className="truncate text-sm font-medium">
          {item.productTitle}
          {item.variantTitle && (
            <span className="ml-2 font-normal text-ink-faint">{item.variantTitle}</span>
          )}
        </h3>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-faint">
          <span
            title={status.label}
            className={cn('size-2.5 shrink-0 rounded-full', status.dot)}
          />
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

      {/* Row actions stay on the right; their clicks must not toggle selection. */}
      <div
        className="flex shrink-0 items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <StagingActions
          item={item}
          busy={busy}
          onApprove={onApprove}
          onReject={onReject}
          onPublish={onPublish}
          onRevert={onRevert}
          onRetry={onRetry}
        />
      </div>
    </motion.article>
  )
}
