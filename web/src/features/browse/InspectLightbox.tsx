import type { MediaItem, Product } from '@comfy-commerce/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { useSetMediaTags } from '../../api/hooks.js'
import { Model3DViewer } from '../../components/ui/Model3DViewer.js'
import { ChevronLeft, ChevronRight, ICON, IconBox, Sparkles, X } from '../../lib/icons.js'
import { easeSoft } from '../../lib/motion.js'

/** Show at most this many tags before collapsing behind a "show more" toggle. */
const TAG_LIMIT = 10

export interface InspectItem {
  product: Product
  media: MediaItem
}

/** Filename + extension parsed from a media URL (query string stripped). */
function fileInfo(url: string): { name: string; ext: string } {
  try {
    const { pathname } = new URL(url, window.location.href)
    const base = pathname.slice(pathname.lastIndexOf('/') + 1) || 'image'
    const dot = base.lastIndexOf('.')
    return { name: decodeURIComponent(base), ext: dot > 0 ? base.slice(dot + 1).toLowerCase() : '' }
  } catch {
    return { name: url, ext: '' }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="shrink-0 text-sm text-ink-faint">{label}</span>
      <span className="min-w-0 text-right text-sm font-medium break-words">{value}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line px-5 py-4 first:border-t-0">
      <h3 className="mb-1 text-xs font-medium tracking-wide text-ink-faint uppercase">{title}</h3>
      {children}
    </div>
  )
}

/**
 * Asset inspector: a full-screen lightbox with the image on the left and a
 * right-hand details panel — caption, search tags, file metadata (format,
 * dimensions, size) and catalog info. Walks the visible media with ←/→.
 */
export function InspectLightbox({
  items,
  mediaId,
  storeId,
  onSelect,
  onClose,
}: {
  items: InspectItem[]
  mediaId: string | null
  storeId: string
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const setTags = useSetMediaTags()
  const index = mediaId ? items.findIndex((it) => it.media.id === mediaId) : -1
  const current = index >= 0 ? items[index] : undefined

  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [size, setSize] = useState<number | null>(null)
  const [showAllTags, setShowAllTags] = useState(false)
  // Slide direction for navigation (the site's directional-transition contract).
  const [direction, setDirection] = useState(0)

  const go = (toIndex: number) => {
    const target = items[toIndex]
    if (!target) return
    setDirection(toIndex > index ? 1 : -1)
    onSelect(target.media.id)
  }

  const removeTag = (tag: string) => {
    if (!current) return
    const next = (current.media.tags ?? []).filter((t) => t !== tag)
    setTags.mutate({ storeId, productId: current.product.id, mediaId: current.media.id, tags: next })
  }

  // The list can change under us (a refetch after captioning) — if the open
  // media is gone, close.
  useEffect(() => {
    if (mediaId && !current) onClose()
  }, [mediaId, current, onClose])

  const url = current?.media.url
  useEffect(() => {
    setDims(null)
    setSize(null)
    setShowAllTags(false)
    if (!url) return
    const controller = new AbortController()
    // Best-effort byte size; cross-origin CDNs may refuse, which is fine.
    fetch(url, { method: 'HEAD', signal: controller.signal })
      .then((r) => {
        const len = r.headers.get('content-length')
        if (len) setSize(Number(len))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [url])

  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && index > 0) {
        setDirection(-1)
        onSelect(items[index - 1]!.media.id)
      } else if (e.key === 'ArrowRight' && index < items.length - 1) {
        setDirection(1)
        onSelect(items[index + 1]!.media.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, index, items, onClose, onSelect])

  const file = current ? fileInfo(current.media.url) : null

  return createPortal(
    <AnimatePresence>
      {current && file && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: easeSoft }}
          className="fixed inset-0 z-50 flex items-center justify-center p-5"
        >
          <div
            className="absolute inset-0 bg-ink/20 backdrop-blur-[3px] dark:bg-black/50"
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={`${current.product.title} — asset details`}
            initial={{ opacity: 0, scale: 0.96, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.35, ease: easeSoft }}
            className="relative flex max-h-[calc(100vh-2.5rem)] w-full max-w-[72rem] overflow-hidden rounded-2xl border border-line bg-surface shadow-lift"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Image stage — the image slides directionally on prev/next. */}
            <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-surface-2 p-4">
              {current.media.mediaType === 'model3d' ? (
                <Model3DViewer
                  src={current.media.url}
                  className="h-full max-h-[calc(100vh-6rem)] w-full"
                />
              ) : current.media.mediaType === 'video' ? (
                <video
                  src={current.media.url}
                  controls
                  className="block h-auto max-h-[calc(100vh-6rem)] w-auto max-w-full object-contain"
                />
              ) : (
                <AnimatePresence mode="popLayout" initial={false} custom={direction}>
                  <motion.img
                    key={current.media.id}
                    custom={direction}
                    src={current.media.url}
                    alt={current.media.altText}
                    onLoad={(e) =>
                      setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
                    }
                    initial={{ opacity: 0, x: direction * 32 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: direction * -32 }}
                    transition={{ duration: 0.25, ease: easeSoft }}
                    className="block h-auto max-h-[calc(100vh-6rem)] w-auto max-w-full object-contain"
                  />
                </AnimatePresence>
              )}
              {index > 0 && (
                <button
                  onClick={() => go(index - 1)}
                  aria-label="Previous"
                  className="absolute top-1/2 left-3 z-10 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-ink/60 text-white backdrop-blur-sm transition-colors hover:bg-ink/85 cursor-pointer"
                >
                  <IconBox>
                    <ChevronLeft {...ICON} />
                  </IconBox>
                </button>
              )}
              {index < items.length - 1 && (
                <button
                  onClick={() => go(index + 1)}
                  aria-label="Next"
                  className="absolute top-1/2 right-3 z-10 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-ink/60 text-white backdrop-blur-sm transition-colors hover:bg-ink/85 cursor-pointer"
                >
                  <IconBox>
                    <ChevronRight {...ICON} />
                  </IconBox>
                </button>
              )}
            </div>

            {/* Details panel */}
            <aside className="flex w-80 shrink-0 flex-col border-l border-line">
              <header className="flex items-center justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <p className="truncate text-base font-medium">{current.product.title}</p>
                  <p className="text-sm text-ink-faint">
                    {current.media.position === 1 ? 'Featured image' : `Image #${current.media.position}`}
                    {items.length > 1 && ` · ${index + 1} of ${items.length}`}
                  </p>
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink cursor-pointer"
                >
                  <IconBox>
                    <X {...ICON} />
                  </IconBox>
                </button>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto">
                <Section title="Caption">
                  {current.media.caption ? (
                    <p className="text-sm leading-relaxed text-ink-soft">{current.media.caption}</p>
                  ) : (
                    <p className="flex items-center gap-1.5 text-sm text-ink-faint">
                      <Sparkles size={14} strokeWidth={1.5} absoluteStrokeWidth />
                      Not captioned yet — run “Caption images”.
                    </p>
                  )}
                </Section>

                {current.media.tags && current.media.tags.length > 0 && (
                  <Section title={`Search tags · ${current.media.tags.length}`}>
                    <div className="flex flex-wrap gap-1.5">
                      {(showAllTags
                        ? current.media.tags
                        : current.media.tags.slice(0, TAG_LIMIT)
                      ).map((t) => (
                        <span
                          key={t}
                          className="group/tag relative flex h-6 items-center rounded-lg bg-info-soft px-2 text-sm font-medium text-info"
                        >
                          {t}
                          {/* Remove — overlays the tag's right edge on hover, so
                              there's no reserved gap beside the label. */}
                          <button
                            onClick={() => removeTag(t)}
                            aria-label={`Remove ${t}`}
                            title={`Remove ${t}`}
                            style={{
                              backgroundColor:
                                'color-mix(in srgb, var(--color-info) 14%, var(--color-info-soft))',
                            }}
                            className="absolute inset-y-0 right-0 flex w-6 cursor-pointer items-center justify-center rounded-r-lg text-info opacity-0 transition-opacity group-hover/tag:opacity-100 hover:text-ink"
                          >
                            <X size={18} strokeWidth={1.5} absoluteStrokeWidth />
                          </button>
                        </span>
                      ))}
                    </div>
                    {current.media.tags.length > TAG_LIMIT && (
                      <button
                        onClick={() => setShowAllTags((v) => !v)}
                        className="mt-2 cursor-pointer text-sm font-medium text-ink-soft transition-colors hover:text-ink"
                      >
                        {showAllTags
                          ? 'Show less'
                          : `Show ${current.media.tags.length - TAG_LIMIT} more`}
                      </button>
                    )}
                  </Section>
                )}

                <Section title="File">
                  <Field label="Name" value={file.name} />
                  <Field
                    label="Format"
                    value={
                      current.media.mediaType === 'model3d'
                        ? '3D model (GLB)'
                        : current.media.mediaType === 'video'
                          ? 'Video'
                          : file.ext
                            ? file.ext.toUpperCase()
                            : '—'
                    }
                  />
                  <Field
                    label="Dimensions"
                    value={
                      current.media.mediaType && current.media.mediaType !== 'image'
                        ? '—'
                        : dims
                          ? `${dims.w} × ${dims.h} px`
                          : '…'
                    }
                  />
                  <Field label="Size" value={size != null ? formatBytes(size) : '—'} />
                </Section>

                <Section title="Catalog">
                  <Field label="Alt text" value={current.media.altText || '—'} />
                  <Field
                    label="Captioned"
                    value={formatDate(current.media.enrichedAt) ?? 'Not yet'}
                  />
                  {current.media.enrichmentModel && (
                    <Field label="Model" value={current.media.enrichmentModel} />
                  )}
                </Section>
              </div>
            </aside>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
