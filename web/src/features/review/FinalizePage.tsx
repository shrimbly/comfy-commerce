import type { GalleryEditorData } from '../../api/hooks.js'
import { useQueries } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import {
  galleryEditorQuery,
  usePublishGallery,
  useSaveArrangement,
  useStaging,
  useStagingAction,
} from '../../api/hooks.js'
import { UploadCloudIcon } from '../../lib/animated-icons/UploadCloudIcon.js'
import { ArrowLeft, ICON, IconBox, Sparkles, X } from '../../lib/icons.js'
import { easeSoft } from '../../lib/motion.js'
import { useHover } from '../../lib/useHover.js'
import { Button } from '../../components/ui/Button.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { PageHeader } from '../../components/ui/PageHeader.js'
import { Spinner } from '../../components/ui/Spinner.js'
import { useStoreContext } from '../../store/StoreContext.js'
import { buildInitialOrder, refOf } from './galleryOrder.js'
import { applyPattern, describePattern, detectPattern } from './galleryPattern.js'
import { GalleryStrip, type GalleryTile } from './GalleryStrip.js'

/** The add-tiles' arrangement signature (placement + permutation) — compared
 *  to decide "did this drag change how the new images are arranged". */
const signatureOf = (order: string[], addOrder: string[]) =>
  JSON.stringify(detectPattern(order, addOrder))

/**
 * The Finalize step: every staged listing's gallery in one place, drag each
 * into its final order, then publish the whole batch with the order enforced.
 * Reordering the first listing offers to apply the same placement of new
 * images to the remaining untouched listings.
 */
export function FinalizePage() {
  const { activeStore } = useStoreContext()
  const storeId = activeStore?.id
  const navigate = useNavigate()
  const { data } = useStaging(storeId)
  const save = useSaveArrangement()
  const publishGallery = usePublishGallery()
  const reject = useStagingAction('reject')
  const publishHover = useHover()

  // Staged listings: distinct products with at least one approved item.
  const listings = useMemo(() => {
    const byId = new Map<string, string>()
    for (const i of data?.items ?? []) {
      if (i.state === 'approved' && !byId.has(i.productId)) byId.set(i.productId, i.productTitle)
    }
    return [...byId.entries()].map(([productId, productTitle]) => ({ productId, productTitle }))
  }, [data])

  const galleryQueries = useQueries({
    queries: listings.map((l) => ({
      ...galleryEditorQuery(storeId ?? '', l.productId),
      enabled: Boolean(storeId),
    })),
  })

  // Per-listing shown order. Each listing re-syncs to its server-derived
  // initial order whenever that CHANGES (first load, post-save refetch, a
  // reject dropping a tile) — but never while a local reorder is still waiting
  // on its debounced save, so a slow refetch can't clobber a fresh drag.
  const [orders, setOrders] = useState<Record<string, string[]>>({})
  const initialKeys = useRef<Record<string, string>>({})
  const baselines = useRef<Record<string, string[]>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const pendingSaves = useRef<Record<string, string[]>>({})
  const fingerprint = galleryQueries.map((q) => q.dataUpdatedAt).join(',')
  useEffect(() => {
    // Ref updates stay OUTSIDE the setState updater — StrictMode double-invokes
    // updaters, and an impure one would see its own ref writes on the second
    // pass and drop the update.
    const updates: Record<string, string[]> = {}
    listings.forEach((l, i) => {
      const d = galleryQueries[i]?.data
      if (!d || pendingSaves.current[l.productId]) return
      const initial = buildInitialOrder(d)
      const key = JSON.stringify(initial)
      if (initialKeys.current[l.productId] === key) return
      initialKeys.current[l.productId] = key
      updates[l.productId] = initial
      // The session BASELINE — what "unchanged" means for the apply prompt.
      // Refreshed only when the tile SET changes (a reject, a fresh approval),
      // never by our own save round-trips: rebasing it to the last autosave
      // would make "did the user move a new image" forget the session's start.
      const base = baselines.current[l.productId]
      const sameIds = base && [...base].sort().join() === [...initial].sort().join()
      if (!sameIds) baselines.current[l.productId] = initial
    })
    if (Object.keys(updates).length > 0) setOrders((prev) => ({ ...prev, ...updates }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fingerprint covers galleryQueries data
  }, [fingerprint, listings])

  // Only ADD tiles are "new" for placement purposes. A replace-in-place result
  // is bound to the slot of the media it replaces — the pattern must move
  // around it, never move it. The array keeps the canonical staging order, so
  // the k-th add on one listing pairs with the k-th add on another.
  const addOrders = useMemo(() => {
    const map: Record<string, string[]> = {}
    listings.forEach((l, i) => {
      const d = galleryQueries[i]?.data
      if (!d) return
      map[l.productId] = d.approvedItems
        .filter((it) => it.action !== 'replace-position')
        .map((it) => `s:${it.id}`)
    })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fingerprint covers galleryQueries data
  }, [fingerprint, listings])

  // The listing whose reorder the apply prompt follows (the last one dragged);
  // the prompt itself is DERIVED from current state, never event-set.
  const [promptSource, setPromptSource] = useState<string | null>(null)
  // A dismissal only holds while the arrangement it dismissed is still shown.
  const [dismissed, setDismissed] = useState<{ productId: string; signature: string } | null>(null)
  const [applied, setApplied] = useState<{
    productId: string
    prev: Record<string, string[]>
  } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)

  const scheduleSave = (productId: string, order: string[]) => {
    if (!storeId) return
    pendingSaves.current[productId] = order
    if (timers.current[productId]) clearTimeout(timers.current[productId])
    timers.current[productId] = setTimeout(() => {
      delete timers.current[productId]
      delete pendingSaves.current[productId]
      save.mutate({ storeId, productId, order: order.map(refOf) })
    }, 400)
  }

  // Leaving mid-debounce must not lose the last drag — flush it on unmount.
  const flushRef = useRef<() => void>(() => {})
  flushRef.current = () => {
    for (const t of Object.values(timers.current)) clearTimeout(t)
    timers.current = {}
    if (!storeId) return
    for (const [productId, order] of Object.entries(pendingSaves.current)) {
      save.mutate({ storeId, productId, order: order.map(refOf) })
    }
    pendingSaves.current = {}
  }
  useEffect(() => () => flushRef.current(), [])

  const onReorder = (productId: string, next: string[]) => {
    setOrders((prev) => ({ ...prev, [productId]: next }))
    scheduleSave(productId, next)
    setPromptSource(productId)
  }

  // The apply prompt, derived from current state: it sits under the
  // last-reordered listing whenever that listing's NEW-image arrangement
  // (placement or internal order) differs from the session baseline and other
  // listings with adds exist. Deriving — instead of setting it from drag
  // events — keeps it stable across autosave round-trips and edits to other
  // listings; it only leaves when the arrangement returns to baseline, is
  // dismissed, or there is nothing left to apply to.
  const prompt = useMemo(() => {
    if (!promptSource) return null
    const order = orders[promptSource]
    const baseline = baselines.current[promptSource]
    const addOrder = addOrders[promptSource] ?? []
    if (!order || !baseline) return null
    const pattern = detectPattern(order, addOrder)
    if (!pattern) return null
    const signature = signatureOf(order, addOrder)
    if (signature === signatureOf(baseline, addOrder)) return null
    if (dismissed?.productId === promptSource && dismissed.signature === signature) return null
    const targets = listings.filter(
      (l) =>
        l.productId !== promptSource &&
        (addOrders[l.productId]?.length ?? 0) > 0 &&
        orders[l.productId],
    )
    if (targets.length === 0) return null
    return { productId: promptSource, pattern, signature, targets }
    // baselines is a ref, but it only changes together with orders (the sync
    // effect writes both), so this memo never reads a stale baseline.
  }, [promptSource, orders, addOrders, dismissed, listings])

  // Apply targets EVERY other listing with adds — including hand-edited ones
  // (skipping them dead-ends the flow when all listings were touched); Undo
  // restores exactly what each target showed before.
  const applyToRest = () => {
    if (!prompt || !storeId) return
    const prev: Record<string, string[]> = {}
    const nextOrders = { ...orders }
    for (const t of prompt.targets) {
      prev[t.productId] = orders[t.productId]!
      // A target's pending debounced save is superseded by the applied order.
      if (timers.current[t.productId]) clearTimeout(timers.current[t.productId])
      delete timers.current[t.productId]
      delete pendingSaves.current[t.productId]
      // Each target re-places its OWN add tiles — replace-in-place results
      // and existing media hold their relative positions.
      const next = applyPattern(prompt.pattern, orders[t.productId]!, addOrders[t.productId] ?? [])
      nextOrders[t.productId] = next
      save.mutate({ storeId, productId: t.productId, order: next.map(refOf) })
    }
    setOrders(nextOrders)
    setApplied({ productId: prompt.productId, prev })
    // Swap the prompt for the applied/undo affordance until the arrangement
    // changes again.
    setDismissed({ productId: prompt.productId, signature: prompt.signature })
  }

  const undoApply = () => {
    if (!applied || !storeId) return
    setOrders((cur) => ({ ...cur, ...applied.prev }))
    for (const [productId, order] of Object.entries(applied.prev)) {
      save.mutate({ storeId, productId, order: order.map(refOf) })
    }
    setApplied(null)
    // Re-offer the prompt — undoing says "not like that", not "never ask".
    setDismissed(null)
  }

  const handleReject = async (itemId: string) => {
    setActionError(null)
    try {
      const failed = (await reject.mutateAsync([itemId])).find((r) => !r.ok)
      if (failed) setActionError(`Reject failed: ${failed.error ?? 'Unknown error'}`)
    } catch (err) {
      setActionError(`Reject failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Save each listing's SHOWN order first, then publish with the order
  // enforced — sequential so every product's outcome is read (#23, #52).
  const publishAll = async () => {
    if (!storeId) return
    setActionError(null)
    setPublishing(true)
    for (const t of Object.values(timers.current)) clearTimeout(t)
    timers.current = {}
    pendingSaves.current = {}
    const problems: string[] = []
    for (const l of [...listings]) {
      try {
        const order = orders[l.productId]
        if (order) await save.mutateAsync({ storeId, productId: l.productId, order: order.map(refOf) })
        const res = await publishGallery.mutateAsync({ storeId, productId: l.productId })
        const failed = res.results.filter((r) => !r.ok)
        if (failed.length > 0) {
          const first = failed.find((f) => f.error)?.error ?? 'publish failed'
          problems.push(
            `${l.productTitle}: ${first}${failed.length > 1 ? ` (+${failed.length - 1} more)` : ''}`,
          )
        }
        if (res.error) problems.push(`${l.productTitle}: gallery order not applied — ${res.error}`)
      } catch (err) {
        problems.push(`${l.productTitle}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    setPublishing(false)
    if (problems.length > 0) {
      setActionError(
        problems.length === 1
          ? `Publish failed — ${problems[0]}`
          : `Publish failed for ${problems.length} products — ${problems[0]}`,
      )
    } else {
      navigate('/review?state=published')
    }
  }

  return (
    <>
      <PageHeader
        subtitle="Drag each listing's gallery into its final order, then publish everything staged."
        actions={
          listings.length > 0 ? (
            <Button
              variant="primary"
              onClick={() => void publishAll()}
              disabled={publishing}
              {...publishHover.props}
            >
              {publishing ? (
                <Spinner className="border-accent-ink/40 border-t-accent-ink" />
              ) : (
                <IconBox>
                  <UploadCloudIcon size={18} animate={publishHover.state} />
                </IconBox>
              )}
              Publish {listings.length} listing{listings.length === 1 ? '' : 's'}
            </Button>
          ) : undefined
        }
      />

      <Link
        to="/review"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft transition-colors hover:text-ink"
      >
        <IconBox>
          <ArrowLeft {...ICON} />
        </IconBox>
        Back to review
      </Link>

      <AnimatePresence>
        {actionError && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: easeSoft }}
            role="alert"
            className="mb-4 flex items-start justify-between gap-3 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger"
          >
            <p className="min-w-0 break-words">{actionError}</p>
            <button
              onClick={() => setActionError(null)}
              aria-label="Dismiss error"
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-danger/10"
            >
              <IconBox>
                <X {...ICON} />
              </IconBox>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {data && listings.length === 0 ? (
        <EmptyState
          icon={<Sparkles {...ICON} />}
          title="Nothing staged to finalize"
          body="Approve results on the review queue and they'll gather here, ready to arrange and publish."
          action={
            <Link to="/review">
              <Button variant="primary">Back to review</Button>
            </Link>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          {listings.map((l, i) => {
            const gallery = galleryQueries[i]?.data
            const order = orders[l.productId]
            if (!gallery || !order) return null
            const tiles = new Map<string, GalleryTile>()
            gallery.media.forEach((m) => tiles.set(`m:${m.id}`, { url: m.url, mediaType: m.mediaType }))
            gallery.approvedItems.forEach((it) =>
              tiles.set(`s:${it.id}`, { url: it.afterUrl, itemId: it.id, mediaType: it.mediaType }),
            )
            const noun = gallery.approvedItems
              .filter((it) => it.action !== 'replace-position')
              .every((it) => it.mediaType === 'image')
              ? 'images'
              : 'media'
            return (
              <div key={l.productId} className="border-b border-line last:border-b-0">
                <div className="bg-surface-2 px-5 py-2.5">
                  <h3 className="truncate text-sm font-medium">{l.productTitle}</h3>
                </div>
                <GalleryStrip
                  order={order}
                  tiles={tiles}
                  onReorder={(next) => onReorder(l.productId, next)}
                  onReject={(id) => void handleReject(id)}
                />
                {prompt?.productId === l.productId && (
                  <div className="mx-5 mb-3 flex flex-wrap items-center gap-3 rounded-xl bg-accent-soft px-4 py-2.5">
                    <p className="text-sm">
                      {describePattern(prompt.pattern, noun)} — apply to {prompt.targets.length} more
                      listing{prompt.targets.length === 1 ? '' : 's'}?
                    </p>
                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setDismissed({ productId: prompt.productId, signature: prompt.signature })
                        }
                      >
                        Dismiss
                      </Button>
                      <Button size="sm" variant="primary" onClick={applyToRest}>
                        Apply to all
                      </Button>
                    </div>
                  </div>
                )}
                {applied?.productId === l.productId && prompt?.productId !== l.productId && (
                  <div className="mx-5 mb-3 flex flex-wrap items-center gap-3 rounded-xl bg-accent-soft px-4 py-2.5">
                    <p className="text-sm">
                      Applied to {Object.keys(applied.prev).length} listing
                      {Object.keys(applied.prev).length === 1 ? '' : 's'}.
                    </p>
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={undoApply}>
                      Undo
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
