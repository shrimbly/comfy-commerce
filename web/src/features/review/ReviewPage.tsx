import { groupReviewItems, type StagingItem } from '@comfy-commerce/shared'
import { ArrowRight, Check, ICON, IconBox, ShieldCheck, Sparkles, X } from '../../lib/icons.js'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'

import { useStaging, useStagingAction, type OperationResult } from '../../api/hooks.js'
import { UploadCloudIcon } from '../../lib/animated-icons/UploadCloudIcon.js'
import { useHover } from '../../lib/useHover.js'
import { Button } from '../../components/ui/Button.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { PageHeader } from '../../components/ui/PageHeader.js'
import { Segmented } from '../../components/ui/Segmented.js'
import { Spinner } from '../../components/ui/Spinner.js'
import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'
import { useStoreContext } from '../../store/StoreContext.js'
import { RunSheet } from '../activity/RunSheet.js'
import { ReviewLightbox } from './CompareMedia.js'
import { GroupRow } from './GroupRow.js'
import { ReviewCard } from './ReviewCard.js'
import { RetryDialog, type RerunConfig } from './RetryDialog.js'

const STATE_FILTERS = ['all', 'pending', 'approved', 'published', 'failed'] as const
type StateFilter = (typeof STATE_FILTERS)[number]

/** Adds change the gallery's composition, so their order needs the Finalize step. */
const isAdd = (i: StagingItem) => i.action === 'add-new' || i.action === 'add-featured'

// Zero-count filters stay selectable but don't shout "(0)".
const withCount = (label: string, n: number | undefined) => (n ? `${label} (${n})` : label)

export function ReviewPage() {
  const { activeStore } = useStoreContext()
  const { data } = useStaging(activeStore?.id)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const runFilter = searchParams.get('run')
  // Deep-linkable initial tab (?state=published — where Finalize lands after
  // publishing); switching tabs afterwards is local state only.
  const [stateFilter, setStateFilter] = useState<StateFilter>(() => {
    const s = searchParams.get('state') as StateFilter | null
    return s && STATE_FILTERS.includes(s) ? s : 'all'
  })
  const approve = useStagingAction('approve')
  const reject = useStagingAction('reject')
  const publish = useStagingAction('publish')
  const revert = useStagingAction('revert')
  const publishHover = useHover()
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  // #23: the latest action failure — transport error or per-item `ok: false`.
  // Rendered as a dismissible banner; starting a new action replaces it.
  const [actionError, setActionError] = useState<string | null>(null)
  // Retry flow: which item's options dialog is open, and the re-run config the
  // "Change inputs" path hands to a pre-filled RunSheet.
  const [retrying, setRetrying] = useState<StagingItem | null>(null)
  const [rerun, setRerun] = useState<RerunConfig | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)

  const items = data?.items ?? []
  const counts = data?.counts

  const visible = useMemo(() => {
    let list = items
    if (runFilter) list = list.filter((i) => i.runId === runFilter)
    if (stateFilter === 'all') return list.filter((i) => i.state !== 'rejected')
    if (stateFilter === 'published') return list.filter((i) => i.state === 'published' || i.state === 'publishing')
    return list.filter((i) => i.state === stateFilter)
  }, [items, runFilter, stateFilter])

  // Group by run + product: a single run that generates several outputs for one
  // product reads as one group, but the same product staged by a different run
  // (or a direct API stage) stays separate. Each output keeps its own row and
  // its own approve/reject; within a group each row is attributed to ITS OWN
  // source image (#10) — the shared, unit-tested helper owns that logic.
  const groups = useMemo(() => groupReviewItems(visible), [visible])
  // Flattened display order — shift-range selection and the lightbox follow it.
  const ordered = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.item)), [groups])

  const pendingIds = useMemo(
    () => visible.filter((i) => i.state === 'pending').map((i) => i.id),
    [visible],
  )
  // Staged (approved) items — computed over ALL items, not the current view:
  // the Finalize CTA is the flow's next step and must be visible from every
  // tab so the ordering step can't be missed.
  const stagedItems = useMemo(() => items.filter((i) => i.state === 'approved'), [items])
  const stagedHasAdds = stagedItems.some(isAdd)
  const stagedListingCount = useMemo(
    () => new Set(stagedItems.map((i) => i.productId)).size,
    [stagedItems],
  )
  const pendingHasAdds = useMemo(
    () => visible.some((i) => i.state === 'pending' && isAdd(i)),
    [visible],
  )

  // #23: every review mutation funnels through here. The API never throws for
  // per-item failures — it returns `{ id, ok, state, error }` per item — so
  // both transport errors (caught) and `ok: false` results (read) must land in
  // the banner. A failure names the action and the first server message.
  const withBusy = async (
    label: string,
    ids: string[],
    fn: (ids: string[]) => Promise<OperationResult[]>,
  ) => {
    setActionError(null)
    setBusyIds((prev) => new Set([...prev, ...ids]))
    try {
      const failed = (await fn(ids)).filter((r) => !r.ok)
      if (failed.length > 0) {
        const first = failed.find((f) => f.error)?.error ?? 'Unknown error'
        setActionError(
          failed.length === 1
            ? `${label} failed: ${first}`
            : `${label} failed for ${failed.length} items: ${first}`,
        )
      }
    } catch (err) {
      setActionError(`${label} failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev)
        ids.forEach((id) => next.delete(id))
        return next
      })
    }
  }

  const approveAndPublishAll = () =>
    withBusy('Approve & publish', pendingIds, async (ids) => {
      // Two deliberate steps — "Approve & publish" is approve() then publish(),
      // never a bypass of the gate. Only items that actually reached approved
      // move on; approve failures surface alongside publish results.
      const approved = await approve.mutateAsync(ids)
      const approvedOk = approved.filter((r) => r.ok).map((r) => r.id)
      const published = approvedOk.length > 0 ? await publish.mutateAsync(approvedOk) : []
      return [...approved.filter((r) => !r.ok), ...published]
    })

  // When the pending set contains adds, approval only STAGES — the order of
  // the gallery still has to be set on the Finalize step before publishing.
  const approveAll = () => withBusy('Approve', pendingIds, (ids) => approve.mutateAsync(ids))

  // Direct publish for a replace-only staged set: every result swaps in place,
  // so there is no order to set and no reason to detour through Finalize.
  const publishStaged = () =>
    withBusy(
      'Publish',
      stagedItems.map((i) => i.id),
      (ids) => publish.mutateAsync(ids),
    )

  // Bulk selection — approve/reject only act where the state allows it.
  const selectedItems = useMemo(() => items.filter((i) => selectedIds.has(i.id)), [items, selectedIds])
  const approvableIds = selectedItems.filter((i) => i.state === 'pending').map((i) => i.id)
  const rejectableIds = selectedItems
    .filter((i) => i.state === 'pending' || i.state === 'approved')
    .map((i) => i.id)

  const visibleIds = ordered.map((i) => i.id)
  const visibleSelectedCount = visibleIds.filter((id) => selectedIds.has(id)).length
  const allVisibleSelected = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length
  const anyVisibleSelected = visibleSelectedCount > 0

  // Plain click toggles one row and sets the shift-anchor; shift-click adds the
  // whole range from the anchor to the clicked row.
  const toggleSelect = (id: string, shift: boolean) => {
    if (shift && anchorId) {
      const a = ordered.findIndex((i) => i.id === anchorId)
      const b = ordered.findIndex((i) => i.id === id)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        const range = ordered.slice(lo, hi + 1).map((i) => i.id)
        setSelectedIds((prev) => new Set([...prev, ...range]))
        return
      }
    }
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setAnchorId(id)
  }

  const toggleAllVisible = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (anyVisibleSelected) visibleIds.forEach((id) => next.delete(id))
      else visibleIds.forEach((id) => next.add(id))
      return next
    })

  const clearSelection = () => {
    setSelectedIds(new Set())
    setAnchorId(null)
  }

  // Selection is scoped to the current view — reset it when the filter changes.
  useEffect(() => {
    clearSelection()
  }, [stateFilter, runFilter])

  const bulkApprove = async () => {
    if (approvableIds.length === 0) return
    await withBusy('Approve', approvableIds, (ids) => approve.mutateAsync(ids))
    clearSelection()
  }
  const bulkReject = async () => {
    if (rejectableIds.length === 0) return
    await withBusy('Reject', rejectableIds, (ids) => reject.mutateAsync(ids))
    clearSelection()
  }

  const cardHandlers = (item: StagingItem) => ({
    busy: busyIds.has(item.id),
    selected: selectedIds.has(item.id),
    onToggleSelect: (shift: boolean) => toggleSelect(item.id, shift),
    onApprove: () => withBusy('Approve', [item.id], (ids) => approve.mutateAsync(ids)),
    onReject: () => withBusy('Reject', [item.id], (ids) => reject.mutateAsync(ids)),
    onPublish: () => withBusy('Publish', [item.id], (ids) => publish.mutateAsync(ids)),
    onRevert: () => withBusy('Revert', [item.id], (ids) => revert.mutateAsync(ids)),
    // Only items born of a run can be re-run (API-staged items have no source run).
    onRetry: item.runId ? () => setRetrying(item) : undefined,
    onExpand: () => setExpandedId(item.id),
  })

  // Header CTAs. The staged CTA — Finalize when order matters, direct publish
  // for a replace-only set — is the flow's next step and takes the primary
  // slot; the pending CTA rides along as secondary when both apply.
  const stagedCta =
    stagedItems.length > 0 ? (
      stagedHasAdds ? (
        <Button variant="primary" onClick={() => navigate('/review/finalize')}>
          Finalize {stagedListingCount} listing{stagedListingCount === 1 ? '' : 's'}
          <IconBox>
            <ArrowRight {...ICON} />
          </IconBox>
        </Button>
      ) : (
        <Button
          variant="primary"
          onClick={() => void publishStaged()}
          disabled={publish.isPending}
          {...publishHover.props}
        >
          {publish.isPending ? (
            <Spinner className="border-accent-ink/40 border-t-accent-ink" />
          ) : (
            <IconBox>
              <UploadCloudIcon size={18} animate={publishHover.state} />
            </IconBox>
          )}
          Publish all ({stagedItems.length})
        </Button>
      )
    ) : null

  // Approval only STAGES when the pending set contains adds — publishing then
  // goes through Finalize. A replace-only pending set keeps the one-step CTA.
  const pendingCta =
    pendingIds.length > 0 ? (
      <Button
        variant={stagedCta ? 'secondary' : 'primary'}
        onClick={pendingHasAdds ? () => void approveAll() : approveAndPublishAll}
      >
        <IconBox>
          <ShieldCheck {...ICON} />
        </IconBox>
        {pendingHasAdds ? 'Approve all' : 'Approve & publish'} ({pendingIds.length})
      </Button>
    ) : null

  return (
    <>
      <PageHeader
        subtitle="Compare before and after, then approve or publish."
        actions={pendingCta && stagedCta ? undefined : (stagedCta ?? pendingCta ?? undefined)}
        inlineActions={
          pendingCta && stagedCta ? (
            <>
              {pendingCta}
              {stagedCta}
            </>
          ) : undefined
        }
      />

      {/* #23: action failures land here — dismissible, replaced by the next action. */}
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

      {items.length === 0 ? (
        <EmptyState
          icon={<Sparkles {...ICON} />}
          title="The queue is clear"
          body="Edits you stage — from the browser or the headless API — will appear here for before/after review."
          action={
            <Link to="/browse">
              <Button variant="primary">Browse products</Button>
            </Link>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          {/* Header bar — the filter, or bulk actions while rows are selected. */}
          <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-2 px-4 py-3">
            <button
              onClick={toggleAllVisible}
              aria-label={anyVisibleSelected ? 'Deselect all' : 'Select all'}
              title={anyVisibleSelected ? 'Deselect all' : 'Select all'}
              className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-surface"
            >
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-md border transition-colors',
                  allVisibleSelected
                    ? 'border-ink bg-ink text-surface'
                    : anyVisibleSelected
                      ? 'border-ink text-ink'
                      : 'border-line-strong bg-surface text-transparent',
                )}
              >
                {anyVisibleSelected && !allVisibleSelected ? (
                  <span className="size-2 rounded-sm bg-ink" />
                ) : (
                  <Check size={14} strokeWidth={1.5} absoluteStrokeWidth />
                )}
              </span>
            </button>

            {selectedIds.size > 0 ? (
              <>
                <span className="text-sm font-medium">{selectedIds.size} selected</span>
                <div className="ml-auto flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={bulkReject} disabled={rejectableIds.length === 0}>
                    <IconBox>
                      <X {...ICON} />
                    </IconBox>
                    Reject{rejectableIds.length > 0 ? ` (${rejectableIds.length})` : ''}
                  </Button>
                  <Button variant="success" size="sm" onClick={bulkApprove} disabled={approvableIds.length === 0}>
                    <IconBox>
                      <Check {...ICON} />
                    </IconBox>
                    Approve{approvableIds.length > 0 ? ` (${approvableIds.length})` : ''}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Segmented<StateFilter>
                  value={stateFilter}
                  onChange={setStateFilter}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'pending', label: withCount('Pending', counts?.pending) },
                    { value: 'approved', label: withCount('Approved', counts?.approved) },
                    { value: 'published', label: withCount('Published', counts?.published) },
                    { value: 'failed', label: withCount('Failed', counts?.failed) },
                  ]}
                />
                {runFilter && (
                  <button
                    onClick={() => setSearchParams({}, { replace: true })}
                    className="flex h-7 items-center gap-1 rounded-[40px] bg-accent-soft px-3 text-sm font-medium text-ink transition-colors hover:bg-surface-2 cursor-pointer"
                  >
                    Filtered by run
                    <IconBox>
                      <X {...ICON} />
                    </IconBox>
                  </button>
                )}
              </>
            )}
          </div>

          {visible.length === 0 ? (
            <p className="px-5 py-16 text-center text-sm text-ink-soft">Nothing in this view.</p>
          ) : (
            <AnimatePresence mode="popLayout">
              {groups.flatMap((group) => {
                // A lone output keeps the familiar single row.
                if (group.rows.length === 1) {
                  const item = group.rows[0]!.item
                  return [<ReviewCard key={item.id} item={item} {...cardHandlers(item)} />]
                }
                // A run that produced several outputs for one product: a header,
                // then each result stacked beneath its own source — the source
                // thumbnail repeats whenever the source changes (#10).
                return [
                  <motion.div
                    key={`group-${group.key}`}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25, ease: easeSoft }}
                    className="border-b border-line bg-surface-2 px-5 py-2.5"
                  >
                    <h3 className="truncate text-sm font-medium">
                      {group.productTitle}
                      <span className="ml-2 font-normal text-ink-faint">
                        {group.rows.length} results
                      </span>
                    </h3>
                  </motion.div>,
                  ...group.rows.map(({ item, sourceUrl }) => (
                    <GroupRow
                      key={item.id}
                      item={item}
                      originalUrl={sourceUrl}
                      {...cardHandlers(item)}
                    />
                  )),
                ]
              })}
            </AnimatePresence>
          )}
        </div>
      )}

      <ReviewLightbox
        items={ordered}
        itemId={expandedId}
        onSelect={setExpandedId}
        onClose={() => setExpandedId(null)}
        busyIds={busyIds}
        onApprove={(item) => void withBusy('Approve', [item.id], (ids) => approve.mutateAsync(ids))}
        onReject={(item) => void withBusy('Reject', [item.id], (ids) => reject.mutateAsync(ids))}
        onPublish={(item) => void withBusy('Publish', [item.id], (ids) => publish.mutateAsync(ids))}
        onRevert={(item) => void withBusy('Revert', [item.id], (ids) => revert.mutateAsync(ids))}
        onRetry={(item) => item.runId && setRetrying(item)}
      />

      {/* Retry → choose Change / Reuse inputs, then re-run via a pre-filled sheet. */}
      <RetryDialog item={retrying} onClose={() => setRetrying(null)} onChangeInputs={setRerun} />
      <RunSheet
        open={rerun !== null}
        onClose={() => setRerun(null)}
        target={rerun?.target ?? null}
        initialWorkflowId={rerun?.workflowId ?? null}
        initialParams={rerun?.params}
      />
    </>
  )
}
