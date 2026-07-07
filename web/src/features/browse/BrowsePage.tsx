import type { MediaItem, Product, RunTarget } from '@comfy-commerce/shared'
import { Check, ChevronLeft, ChevronRight, ICON, IconBox, Images, LayoutGrid, List, Play, RefreshCw, Rows3, Search, Sparkles } from '../../lib/icons.js'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'

import { useCatalog } from '../../api/hooks.js'
import { PlayIcon } from '../../lib/animated-icons/PlayIcon.js'
import { useHover } from '../../lib/useHover.js'
import { Button } from '../../components/ui/Button.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { Model3DThumb } from '../../components/ui/Model3DViewer.js'
import { PageHeader } from '../../components/ui/PageHeader.js'
import { Segmented, type SegmentedOption } from '../../components/ui/Segmented.js'
import { Select } from '../../components/ui/Select.js'
import { Spinner } from '../../components/ui/Spinner.js'
import { cn } from '../../lib/cn.js'
import { gridPreviewUrl } from '../../lib/media.js'
import { easeSoft, staggerChild, staggerParent } from '../../lib/motion.js'
import { tagTone } from '../../lib/tagTone.js'
import { useStoreContext } from '../../store/StoreContext.js'
import { RunSheet } from '../activity/RunSheet.js'
import { EnrichDialog } from './EnrichDialog.js'
import { InspectLightbox, type InspectItem } from './InspectLightbox.js'
import { SelectionBar, type Selection } from './SelectionBar.js'

type ViewMode = 'grouped' | 'grid' | 'list'

const VIEW_OPTIONS: SegmentedOption<ViewMode>[] = [
  { value: 'grouped', label: 'Grouped', icon: <Rows3 {...ICON} /> },
  { value: 'grid', label: 'Grid', icon: <LayoutGrid {...ICON} /> },
  { value: 'list', label: 'List', icon: <List {...ICON} /> },
]

// Products shown per page — keeps a large catalog from rendering and decoding
// its whole grid at once, for a lighter first paint.
const PAGE_SIZE = 12

/** Shared style for the pagination prev/next controls. */
const PAGE_NAV_BUTTON =
  'flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink cursor-pointer disabled:pointer-events-none disabled:opacity-40'

function PaginationBar({
  page,
  pageCount,
  total,
  onChange,
}: {
  page: number
  pageCount: number
  total: number
  onChange: (page: number) => void
}) {
  return (
    <div className="flex items-center justify-between border-t border-line bg-surface-2 px-4 py-2.5">
      <span className="text-sm text-ink-faint">
        {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total} products
      </span>
      <div className="flex items-center gap-1">
        <button onClick={() => onChange(page - 1)} disabled={page === 0} aria-label="Previous page" className={PAGE_NAV_BUTTON}>
          <IconBox>
            <ChevronLeft {...ICON} />
          </IconBox>
        </button>
        <span className="px-1 text-sm tabular-nums text-ink-soft">
          {page + 1} / {pageCount}
        </span>
        <button onClick={() => onChange(page + 1)} disabled={page >= pageCount - 1} aria-label="Next page" className={PAGE_NAV_BUTTON}>
          <IconBox>
            <ChevronRight {...ICON} />
          </IconBox>
        </button>
      </div>
    </div>
  )
}

function selectionsOf(product: Product, media: MediaItem[]): Selection[] {
  return media.map((m) => ({
    productId: product.id,
    mediaId: m.id,
    productTitle: product.title,
    url: m.url,
  }))
}

// Add or remove a batch of selections from the map as a unit: when `remove` is
// true every selection is dropped, otherwise every selection is added.
function withBatch(
  current: Map<string, Selection>,
  selections: Selection[],
  remove: boolean,
): Map<string, Selection> {
  const next = new Map(current)
  for (const selection of selections) {
    if (remove) next.delete(selection.mediaId)
    else next.set(selection.mediaId, selection)
  }
  return next
}

export function BrowsePage() {
  const { activeStore } = useStoreContext()
  const { data: catalog, isLoading, isFetching, refetch } = useCatalog(activeStore?.id)
  const [selected, setSelected] = useState<Map<string, Selection>>(new Map())
  const [runTarget, setRunTarget] = useState<RunTarget | null>(null)
  const [enrichTarget, setEnrichTarget] = useState<RunTarget | null>(null)
  const [inspectId, setInspectId] = useState<string | null>(null)
  const runCatalog = useHover()
  // Anchor tile for shift-click range selection (the last plain-clicked media).
  const [anchorId, setAnchorId] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [collectionId, setCollectionId] = useState('all')
  const [tag, setTag] = useState('all')
  const [view, setView] = useState<ViewMode>(
    () => (localStorage.getItem('cc-browse-view') as ViewMode | null) ?? 'grouped',
  )
  useEffect(() => localStorage.setItem('cc-browse-view', view), [view])
  const [page, setPage] = useState(0)

  // Media-first search: a query keeps only the images that match (by caption or
  // AI tags), so results are about the media, not the product. A product matched
  // by its title or store tags keeps all its images — the whole product is
  // relevant. Word-boundary match so "sun" hits "sun"/"sunlight" but not "unsung".
  const filtered = useMemo<{ product: Product; media: MediaItem[] }[]>(() => {
    if (!catalog) return []
    const q = query.trim().toLowerCase()
    const re = q ? new RegExp('\\b' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null
    const hit = (s: string | null | undefined) => !!s && re!.test(s)
    return catalog.products
      .filter(
        (p) =>
          (collectionId === 'all' || p.collectionIds.includes(collectionId)) &&
          (tag === 'all' || p.tags.includes(tag)),
      )
      .map((product) => {
        if (!re) return { product, media: product.media }
        const media =
          hit(product.title) || product.tags.some(hit)
            ? product.media
            : product.media.filter((m) => hit(m.caption) || (m.tags?.some(hit) ?? false))
        return { product, media }
      })
      .filter((g) => g.media.length > 0)
  }, [catalog, query, collectionId, tag])

  const visibleSelections = useMemo(
    () => filtered.flatMap((g) => selectionsOf(g.product, g.media)),
    [filtered],
  )
  // Flattened, in-display-order media for the inspector's ←/→ navigation.
  const inspectItems = useMemo<InspectItem[]>(
    () => filtered.flatMap((g) => g.media.map((media) => ({ product: g.product, media }))),
    [filtered],
  )
  const filtering = query.trim() !== '' || collectionId !== 'all' || tag !== 'all'

  // Pagination. Only the current page's products are rendered; selection,
  // inspector, and counts still operate over the full filtered set.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const paged = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)
  // Snap back to the first page whenever the result set changes (search, filters,
  // or store switch) so you're never stranded past the last page.
  useEffect(() => setPage(0), [query, collectionId, tag, activeStore?.id])

  if (!activeStore) {
    return (
      <>
        <PageHeader subtitle="Pick product media, then run a workflow on a selection or the whole catalog." />
        <EmptyState
          icon={<Images {...ICON} />}
          title="No store connected"
          body="Connect a Shopify store first — its in-scope media will appear here as a browsable source."
          action={
            <Link to="/connectors">
              <Button variant="primary">Go to Connectors</Button>
            </Link>
          }
        />
      </>
    )
  }

  const toggle = (selection: Selection) => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(selection.mediaId)) next.delete(selection.mediaId)
      else next.set(selection.mediaId, selection)
      return next
    })
  }

  // Shift-click range select: add every tile between the anchor (last plain
  // click) and the shift-clicked tile, inclusive, in display order.
  const selectRange = (toId: string) => {
    const toIdx = visibleSelections.findIndex((s) => s.mediaId === toId)
    const target = visibleSelections[toIdx]
    if (!target) return
    const fromIdx = anchorId ? visibleSelections.findIndex((s) => s.mediaId === anchorId) : -1
    if (fromIdx === -1) {
      toggle(target)
      setAnchorId(toId)
      return
    }
    const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx]
    setSelected((prev) => withBatch(prev, visibleSelections.slice(lo, hi + 1), false))
  }

  const toggleProduct = (product: Product, media: MediaItem[]) => {
    setSelected((prev) => {
      const selections = selectionsOf(product, media)
      const allSelected = selections.every((s) => prev.has(s.mediaId))
      return withBatch(prev, selections, allSelected)
    })
  }

  const mediaTile = (product: Product, media: Product['media'][number]) => {
    const isSelected = selected.has(media.id)
    const select = (shiftKey: boolean) => {
      if (shiftKey) {
        selectRange(media.id)
        return
      }
      toggle({ productId: product.id, mediaId: media.id, productTitle: product.title, url: media.url })
      setAnchorId(media.id)
    }
    return (
      <div
        key={media.id}
        role="button"
        tabIndex={0}
        aria-pressed={isSelected}
        onClick={(e) => select(e.shiftKey)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            select(e.shiftKey)
          }
        }}
        title={`${product.title} — ${media.position === 1 ? 'featured' : `image #${media.position}`}`}
        className={cn(
          'group relative cursor-pointer overflow-hidden rounded-xl border bg-surface text-left select-none',
          'transition-shadow duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink',
          isSelected
            ? 'border-ink shadow-lift ring-2 ring-ink ring-offset-2 ring-offset-surface'
            : 'border-line shadow-soft hover:shadow-lift',
        )}
      >
        <div className="relative aspect-square overflow-hidden bg-surface-2">
          {media.mediaType === 'model3d' ? (
            <Model3DThumb />
          ) : media.mediaType === 'video' ? (
            <>
              <video
                src={media.url}
                muted
                playsInline
                // Pin the browser default: metadata only, never full preload.
                preload="metadata"
                className={cn(
                  'h-full w-full object-cover transition-transform! duration-700! ease-out-soft!',
                  'group-hover:scale-[1.03]',
                  isSelected && 'scale-[1.02]',
                )}
              />
              <span className="absolute bottom-2 left-2 flex h-5 items-center gap-1 rounded-md bg-ink/70 px-1.5 text-[11px] font-medium text-white backdrop-blur-sm">
                <Play size={12} strokeWidth={1.5} absoluteStrokeWidth />
                Video
              </span>
            </>
          ) : (
            <img
              src={gridPreviewUrl(media.url)}
              alt={media.altText}
              loading="lazy"
              decoding="async"
              className={cn(
                'h-full w-full object-cover transition-transform! duration-700! ease-out-soft!',
                'group-hover:scale-[1.03]',
                isSelected && 'scale-[1.02]',
              )}
            />
          )}
        </div>
        {media.position === 1 && (
          <span className="absolute top-2 left-2 size-2 rounded-full border border-line bg-surface shadow-soft" />
        )}
        {/* Inspect — opens the asset details lightbox. Sits left of the check
            badge when the tile is also selected, so the two never overlap. */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            setInspectId(media.id)
          }}
          aria-label="Inspect details"
          title="Inspect details"
          className={cn(
            'absolute top-2 z-10 flex size-6 items-center justify-center rounded-lg bg-ink/70 text-white backdrop-blur-sm',
            'cursor-pointer opacity-0 transition-opacity duration-200 group-hover:opacity-100 hover:bg-ink/90',
            isSelected ? 'right-10' : 'right-2',
          )}
        >
          <Search size={14} strokeWidth={1.5} absoluteStrokeWidth />
        </button>
        <motion.span
          initial={false}
          animate={{ scale: isSelected ? 1 : 0.85, opacity: isSelected ? 1 : 0 }}
          transition={{ duration: 0.2, ease: easeSoft }}
          className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-lg bg-ink text-surface"
        >
          <Check {...ICON} />
        </motion.span>
      </div>
    )
  }

  const visibleSelectedCount = visibleSelections.filter((s) => selected.has(s.mediaId)).length
  const allVisibleSelected =
    visibleSelections.length > 0 && visibleSelectedCount === visibleSelections.length

  const selectAllVisible = () => {
    setSelected((prev) => withBatch(prev, visibleSelections, false))
  }

  const selectionTarget = (): RunTarget => ({
    kind: 'selection',
    inputs: [...selected.values()].map(({ productId, mediaId }) => ({ productId, mediaId })),
  })

  return (
    <>
      <PageHeader
        subtitle="Pick product media, then run a workflow on a selection or the whole catalog."
        inlineActions={
          catalog && catalog.products.length > 0 ? (
            <>
              <Button
                variant="secondary"
                onClick={() => setEnrichTarget({ kind: 'catalog' })}
                disabled={catalog.counts.images === 0}
              >
                <IconBox>
                  <Sparkles {...ICON} />
                </IconBox>
                Caption images
              </Button>
              <Button
                variant="primary"
                onClick={() => setRunTarget({ kind: 'catalog' })}
                disabled={catalog.counts.images === 0}
                {...runCatalog.props}
              >
                <IconBox>
                  <PlayIcon size={18} animate={runCatalog.state} />
                </IconBox>
                Run catalog
              </Button>
            </>
          ) : undefined
        }
      />

      {isLoading && (
        <div className="flex justify-center py-24">
          <Spinner className="size-6" />
        </div>
      )}

      {catalog && catalog.products.length === 0 && (
        <EmptyState
          icon={<Images {...ICON} />}
          title="Nothing in scope"
          body="The current sync profile matches no media. Widen the status, collection or tag filters in Connectors."
          action={
            <Link to="/connectors">
              <Button>Edit scope</Button>
            </Link>
          }
        />
      )}

      {catalog && catalog.products.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          {/* Filter / control bar — the header of the listing card. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-3">
            <div className="field-focus flex h-8 w-56 items-center gap-1 rounded-lg border border-line bg-surface px-2 transition-colors focus-within:border-ink">
              <IconBox className="shrink-0 text-ink-faint">
                <Search {...ICON} />
              </IconBox>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search products, captions…"
                className="h-full w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
              />
            </div>

            {catalog.collections.length > 0 && (
              <Select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                <option value="all">All collections</option>
                {catalog.collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </Select>
            )}

            {catalog.tags.length > 0 && (
              <Select value={tag} onChange={(e) => setTag(e.target.value)}>
                <option value="all">All tags</option>
                {catalog.tags.map((t) => (
                  <option key={t} value={t}>
                    #{t}
                  </option>
                ))}
              </Select>
            )}

            <span className="px-1 text-sm text-ink-faint">
              {filtering
                ? `${visibleSelections.length} image${visibleSelections.length === 1 ? '' : 's'} · ${filtered.length} product${filtered.length === 1 ? '' : 's'}`
                : `${catalog.products.length} products`}
            </span>

            <Segmented
              options={VIEW_OPTIONS}
              value={view}
              onChange={setView}
              className="ml-auto gap-0.5 border-transparent"
            />

            <button
              onClick={() => refetch()}
              disabled={isFetching}
              aria-label="Refresh from store"
              title="Refresh from store"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface hover:text-ink cursor-pointer disabled:pointer-events-none"
            >
              <IconBox className={cn(isFetching && 'animate-spin')}>
                <RefreshCw {...ICON} />
              </IconBox>
            </button>
          </div>

          {filtered.length === 0 ? (
            <div className="px-5 py-16 text-center">
              <p className="text-sm text-ink-soft">No products match your search or filters.</p>
              <Button
                className="mt-3"
                onClick={() => {
                  setQuery('')
                  setCollectionId('all')
                  setTag('all')
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : view === 'grouped' ? (
            <motion.div
              variants={staggerParent}
              initial="initial"
              animate="animate"
              className="space-y-6 p-5"
            >
              {paged.map(({ product, media }) => (
                <motion.section key={product.id} variants={staggerChild}>
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {media[0] && (
                        <img
                          src={media[0].mediaType === 'image' ? gridPreviewUrl(media[0].url) : media[0].url}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="size-6 shrink-0 rounded-lg border border-line object-cover"
                        />
                      )}
                      <h2 className="text-base font-medium">{product.title}</h2>
                      <span className="text-sm text-ink-faint">
                        {product.variants.length} variant{product.variants.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    {product.tags.length > 0 && (
                      <div className="flex gap-2">
                        {product.tags.map((t) => (
                          <span key={t} className="text-sm text-ink-faint">
                            #{t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-5">
                    {media.map((m) => mediaTile(product, m))}
                  </div>
                </motion.section>
              ))}
            </motion.div>
          ) : view === 'grid' ? (
            <motion.div
              variants={staggerParent}
              initial="initial"
              animate="animate"
              className="grid grid-cols-3 gap-3 p-5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7"
            >
              {paged.flatMap(({ product, media }) =>
                media.map((m) => (
                  <motion.div key={m.id} variants={staggerChild}>
                    {mediaTile(product, m)}
                  </motion.div>
                )),
              )}
            </motion.div>
          ) : (
            <motion.ul
              variants={staggerParent}
              initial="initial"
              animate="animate"
              className="space-y-1 p-3"
            >
              {paged.map(({ product, media }) => {
                const selections = selectionsOf(product, media)
                const selectedCount = selections.filter((s) => selected.has(s.mediaId)).length
                const allSelected = selectedCount > 0 && selectedCount === selections.length
                const featured = media[0]
                return (
                  <motion.li key={product.id} variants={staggerChild}>
                    <button
                      onClick={() => toggleProduct(product, media)}
                      className={cn(
                        'flex h-12 w-full cursor-pointer items-center gap-3 rounded-xl px-2 text-left',
                        'transition-colors duration-200 hover:bg-surface-2',
                        allSelected && 'bg-surface-2',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors',
                          allSelected
                            ? 'border-ink bg-ink text-surface'
                            : selectedCount > 0
                              ? 'border-ink text-ink'
                              : 'border-line-strong bg-surface text-transparent',
                        )}
                      >
                        {selectedCount > 0 && !allSelected ? (
                          <span className="size-2 rounded-sm bg-ink" />
                        ) : (
                          <Check size={14} strokeWidth={1.5} absoluteStrokeWidth />
                        )}
                      </span>
                      {featured && (
                        <img
                          src={featured.mediaType === 'image' ? gridPreviewUrl(featured.url) : featured.url}
                          alt={featured.altText}
                          loading="lazy"
                          decoding="async"
                          className="size-9 shrink-0 rounded-lg border border-line object-cover"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{product.title}</span>
                      {product.tags.slice(0, 3).map((t) => (
                        <span
                          key={t}
                          className={cn('hidden h-6 items-center rounded-lg px-2 text-sm font-medium sm:flex', tagTone(t))}
                        >
                          #{t}
                        </span>
                      ))}
                      <span className="w-20 shrink-0 text-right text-sm text-ink-faint">
                        {media.length} image{media.length === 1 ? '' : 's'}
                      </span>
                    </button>
                  </motion.li>
                )
              })}
            </motion.ul>
          )}

          {pageCount > 1 && (
            <PaginationBar page={safePage} pageCount={pageCount} total={filtered.length} onChange={setPage} />
          )}
        </div>
      )}

      <AnimatePresence>
        {selected.size > 0 && (
          <SelectionBar
            count={selected.size}
            allSelected={allVisibleSelected}
            onSelectAll={selectAllVisible}
            onClear={() => setSelected(new Map())}
            onRun={() => setRunTarget(selectionTarget())}
          />
        )}
      </AnimatePresence>

      <InspectLightbox
        items={inspectItems}
        mediaId={inspectId}
        storeId={activeStore.id}
        onSelect={setInspectId}
        onClose={() => setInspectId(null)}
      />

      <RunSheet open={runTarget !== null} onClose={() => setRunTarget(null)} target={runTarget} />
      <EnrichDialog
        open={enrichTarget !== null}
        onClose={() => setEnrichTarget(null)}
        storeId={activeStore.id}
        products={catalog?.products ?? []}
        target={enrichTarget}
      />
    </>
  )
}
