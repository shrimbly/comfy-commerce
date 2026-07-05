import type { StagingItem } from '@comfy-commerce/shared'
import { ArrowLeftRight, ChevronLeft, ChevronRight, ICON, IconBox, Maximize2, Plus, X } from '../../lib/icons.js'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Model3DThumb, Model3DViewer } from '../../components/ui/Model3DViewer.js'
import { Segmented } from '../../components/ui/Segmented.js'
import { StatusChip } from '../../components/ui/StatusChip.js'
import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'
import { mediaNoun, StagingActions } from './ReviewCard.js'

/** The "after" side — image, video, or a 3D placeholder (the real viewer is in the lightbox). */
function AfterMedia({ item, className }: { item: StagingItem; className?: string }) {
  if (item.mediaType === 'model3d') {
    return <Model3DThumb className={className} />
  }
  if (item.mediaType === 'video') {
    return (
      <video
        src={item.afterUrl}
        muted
        loop
        playsInline
        autoPlay
        className={cn('h-full w-full object-cover', className)}
      />
    )
  }
  return (
    <img
      src={item.afterUrl}
      alt={`${item.productTitle} — result`}
      loading="lazy"
      className={cn('h-full w-full object-cover', className)}
    />
  )
}

function ExpandButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-label="Expand comparison"
      className={cn(
        'absolute top-3 right-3 flex size-8 items-center justify-center rounded-lg',
        'bg-ink/70 text-white backdrop-blur-sm transition-opacity duration-200 cursor-pointer',
        'opacity-0 group-hover:opacity-100 hover:bg-ink/90 dark:bg-black/60',
      )}
    >
      <IconBox>
        <Maximize2 {...ICON} />
      </IconBox>
    </button>
  )
}

const CAPTION =
  'flex h-6 items-center gap-1 rounded-lg bg-ink/70 px-2 text-sm text-white backdrop-blur-sm dark:bg-black/60'

/**
 * In-card media block. Replacements show a before/after split; additions show
 * the new media as the hero with the source inset — one source image can
 * produce several new media, none of which touch the original.
 */
export function ReviewMedia({ item, onExpand }: { item: StagingItem; onExpand: () => void }) {
  if (item.action === 'add-new') {
    return (
      <div className="group relative cursor-zoom-in bg-surface-2" onClick={onExpand}>
        <div className="aspect-square overflow-hidden">
          <AfterMedia item={item} />
        </div>
        <span className={cn(CAPTION, 'absolute top-3 left-3')}>
          <Plus size={14} strokeWidth={1.5} absoluteStrokeWidth />
          New {mediaNoun(item.mediaType)} · added to the listing
        </span>
        <figure className="absolute bottom-3 left-3 w-16">
          <img
            src={item.beforeUrl}
            alt="Source"
            className="aspect-square w-full rounded-xl border-2 border-surface object-cover shadow-lift"
          />
          <figcaption className="mt-1 rounded-lg bg-ink/70 px-1 text-center text-[11px] leading-4 text-white backdrop-blur-sm dark:bg-black/60">
            Source
          </figcaption>
        </figure>
        <ExpandButton onClick={onExpand} />
      </div>
    )
  }

  return (
    <div className="group relative grid cursor-zoom-in grid-cols-2 gap-px bg-line" onClick={onExpand}>
      <figure className="relative bg-surface-2">
        <div className="aspect-square overflow-hidden">
          <img
            src={item.beforeUrl}
            alt={`${item.productTitle} — before`}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        </div>
        <figcaption className={cn(CAPTION, 'absolute top-3 left-3')}>Before · live</figcaption>
      </figure>
      <figure className="relative bg-surface-2">
        <div className="aspect-square overflow-hidden">
          <AfterMedia item={item} />
        </div>
        <figcaption className={cn(CAPTION, 'absolute top-3 left-3')}>
          After · {item.mediaType === 'image' ? 'edited' : mediaNoun(item.mediaType)}
        </figcaption>
      </figure>
      <span className="absolute top-1/2 left-1/2 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[40px] border border-line bg-surface text-ink-faint shadow-soft">
        <IconBox>
          <ArrowLeftRight {...ICON} />
        </IconBox>
      </span>
      <ExpandButton onClick={onExpand} />
    </div>
  )
}

/** Draggable wipe comparison — after revealed right of the divider. */
function Wipe({ item }: { item: StagingItem }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(50)

  const moveTo = useCallback((clientX: number) => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    setPos(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)))
  }, [])

  return (
    <div
      ref={ref}
      className="relative mx-auto w-fit max-w-full touch-none overflow-hidden rounded-xl bg-surface-2 select-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        moveTo(e.clientX)
      }}
      onPointerMove={(e) => e.buttons === 1 && moveTo(e.clientX)}
    >
      {/* In-flow sizer — the before image gives the box its true aspect ratio;
          the after layer is overlaid absolutely and clipped to the divider. */}
      <img
        src={item.beforeUrl}
        alt="Before"
        draggable={false}
        className="block h-auto w-auto max-h-[min(calc(100vh-15rem),56rem)] max-w-[calc(100vw-4.5rem)]"
      />
      <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
        <AfterMedia item={item} className="absolute inset-0" />
      </div>
      <span className={cn(CAPTION, 'absolute top-3 left-3')}>
        {item.action === 'add-new' ? 'Source' : 'Before'}
      </span>
      <span className={cn(CAPTION, 'absolute top-3 right-3')}>
        {item.action === 'add-new' ? 'New' : 'After'}
      </span>
      <div
        className="absolute inset-y-0 w-px bg-white/90 shadow-lift"
        style={{ left: `${pos}%` }}
      >
        <span className="absolute top-1/2 left-1/2 flex size-8 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-[40px] border border-line bg-surface text-ink shadow-lift">
          <IconBox>
            <ArrowLeftRight {...ICON} />
          </IconBox>
        </span>
      </div>
    </div>
  )
}

type CompareMode = 'side' | 'wipe'

/**
 * Full-screen comparison lightbox with side-by-side and wipe modes — plus
 * the full review loop: approve/reject in place and prev/next to walk the
 * queue without closing.
 */
export function ReviewLightbox({
  items,
  itemId,
  onSelect,
  onClose,
  busyIds,
  onApprove,
  onReject,
  onPublish,
  onRevert,
  onRetry,
}: {
  items: StagingItem[]
  itemId: string | null
  onSelect: (id: string) => void
  onClose: () => void
  busyIds: Set<string>
  onApprove: (item: StagingItem) => void
  onReject: (item: StagingItem) => void
  onPublish: (item: StagingItem) => void
  onRevert: (item: StagingItem) => void
  onRetry?: (item: StagingItem) => void
}) {
  const [mode, setMode] = useState<CompareMode>('side')

  // When an action removes the item from the filtered list, stay at the same
  // position — the next item slides in, which is the natural review rhythm.
  const lastIndex = useRef(0)
  const exactIndex = itemId ? items.findIndex((i) => i.id === itemId) : -1
  useEffect(() => {
    if (exactIndex >= 0) lastIndex.current = exactIndex
  }, [exactIndex])
  const item =
    exactIndex >= 0
      ? items[exactIndex]
      : itemId
        ? items[Math.min(lastIndex.current, items.length - 1)]
        : undefined
  const index = item ? items.indexOf(item) : -1

  useEffect(() => {
    if (itemId && !item) onClose()
    else if (itemId && item && item.id !== itemId) onSelect(item.id)
  }, [itemId, item, onClose, onSelect])

  useEffect(() => {
    if (!item) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft' && index > 0) onSelect(items[index - 1]!.id)
      if (e.key === 'ArrowRight' && index < items.length - 1) onSelect(items[index + 1]!.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, index, items, onClose, onSelect])

  const labels =
    item?.action === 'add-new' ? (['Source', 'New'] as const) : (['Before · live', 'After'] as const)

  // Portal to the body so the overlay covers the whole viewport — rendered in
  // place it would be clipped to AppShell's max-width page container, which is
  // a containing block for `fixed` descendants.
  return createPortal(
    <AnimatePresence>
      {item && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: easeSoft }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-5 backdrop-blur-sm dark:bg-black/80"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.97, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, opacity: 0 }}
            transition={{ duration: 0.3, ease: easeSoft }}
            className="max-h-[calc(100vh-3rem)] w-full max-w-[100rem] overflow-hidden rounded-2xl bg-surface p-4 shadow-lift"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between gap-4 px-1">
              <p className="min-w-0 truncate text-base font-medium">{item.productTitle}</p>
              <div className="flex shrink-0 items-center gap-2">
                {/* Wipe overlays pixels — meaningless for a 3D model, so 3D is side-only. */}
                {item.mediaType !== 'model3d' && (
                  <Segmented<CompareMode>
                    value={mode}
                    onChange={setMode}
                    options={[
                      { value: 'side', label: 'Side by side' },
                      { value: 'wipe', label: 'Wipe' },
                    ]}
                  />
                )}
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink cursor-pointer"
                >
                  <IconBox>
                    <X {...ICON} />
                  </IconBox>
                </button>
              </div>
            </div>

            {mode === 'side' || item.mediaType === 'model3d' ? (
              <div className="flex items-center justify-center gap-2">
                {([0, 1] as const).map((side) => (
                  <figure
                    key={side}
                    className="relative overflow-hidden rounded-xl bg-surface-2"
                  >
                    {side === 0 ? (
                      item.action !== 'add-new' && item.mediaType === 'model3d' ? (
                        <Model3DViewer
                          src={item.beforeUrl}
                          className="block h-[min(calc(100vh-16rem),46rem)] w-[min(calc(50vw-3rem),47rem)]"
                        />
                      ) : (
                        <img
                          src={item.beforeUrl}
                          alt={labels[0]}
                          className="block h-auto w-auto max-h-[min(calc(100vh-16rem),46rem)] max-w-[min(calc(50vw-3rem),47rem)] object-contain"
                        />
                      )
                    ) : item.mediaType === 'model3d' ? (
                      <Model3DViewer
                        src={item.afterUrl}
                        className="block h-[min(calc(100vh-16rem),46rem)] w-[min(calc(50vw-3rem),47rem)]"
                      />
                    ) : (
                      <AfterMedia
                        item={item}
                        className="block h-auto w-auto max-h-[min(calc(100vh-16rem),46rem)] max-w-[min(calc(50vw-3rem),47rem)] object-contain"
                      />
                    )}
                    <figcaption className={cn(CAPTION, 'absolute top-3 left-3')}>
                      {labels[side]}
                    </figcaption>
                  </figure>
                ))}
              </div>
            ) : (
              <Wipe item={item} />
            )}

            <div className="mt-4 flex items-center justify-between gap-4 px-1">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => index > 0 && onSelect(items[index - 1]!.id)}
                  disabled={index <= 0}
                  aria-label="Previous item"
                  className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink cursor-pointer disabled:pointer-events-none disabled:opacity-40"
                >
                  <IconBox>
                    <ChevronLeft {...ICON} />
                  </IconBox>
                </button>
                <span className="px-1 text-sm whitespace-nowrap text-ink-faint">
                  {index + 1} of {items.length}
                </span>
                <button
                  onClick={() => index < items.length - 1 && onSelect(items[index + 1]!.id)}
                  disabled={index >= items.length - 1}
                  aria-label="Next item"
                  className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink cursor-pointer disabled:pointer-events-none disabled:opacity-40"
                >
                  <IconBox>
                    <ChevronRight {...ICON} />
                  </IconBox>
                </button>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StatusChip state={item.state} />
                <StagingActions
                  item={item}
                  busy={busyIds.has(item.id)}
                  onApprove={() => onApprove(item)}
                  onReject={() => onReject(item)}
                  onPublish={() => onPublish(item)}
                  onRevert={() => onRevert(item)}
                  onRetry={onRetry && item.runId ? () => onRetry(item) : undefined}
                />
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
