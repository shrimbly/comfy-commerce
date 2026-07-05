import { CAPTION_WORKFLOW_ID, runCounts, type Run, type StagedMediaType } from '@comfy-commerce/shared'
import { ArrowRight, Box, Check, ChevronDown, ICON, IconBox, Images, ListChecks, OctagonX, RotateCcw, Sparkles } from '../../lib/icons.js'
import { AnimatePresence, motion } from 'motion/react'
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'

import { useCancelRun, useClearRun, usePromoteRun, useRetryRun, useRuns, useSkipRunItem, useStaging } from '../../api/hooks.js'
import { PlayIcon } from '../../lib/animated-icons/PlayIcon.js'
import { useHover } from '../../lib/useHover.js'
import { Button } from '../../components/ui/Button.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { PageHeader } from '../../components/ui/PageHeader.js'
import { Spinner } from '../../components/ui/Spinner.js'
import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'
import { timeAgo } from '../../lib/time.js'
import { useStoreContext } from '../../store/StoreContext.js'

// Filled colour is reserved for failures — the only state that demands a glance.
// Everything else is a quiet dot + label (completed runs show no chip at all).
const STATE_STYLES: Record<Run['state'], { label: string; className: string; dot: string }> = {
  queued: { label: 'Queued', className: 'text-ink-soft', dot: 'bg-ink-faint' },
  running: { label: 'Running', className: 'text-success', dot: 'bg-success animate-pulse' },
  completed: { label: 'Completed', className: 'text-success', dot: 'bg-success' },
  failed: { label: 'Failed', className: 'bg-danger-soft text-danger', dot: 'bg-danger' },
  cancelled: { label: 'Cancelled', className: 'text-ink-faint', dot: 'bg-ink-faint' },
}

// Selection is the default target — only the unusual kinds earn a label.
const TARGET_LABELS: Partial<Record<Run['targetKind'], string>> = {
  products: 'Products',
  catalog: 'Catalog',
}

const PROVIDER_LABELS: Record<string, string> = {
  mock: 'Mock engine',
  'comfy-local': 'Local ComfyUI',
  'comfy-cloud': 'Comfy Cloud',
}

function chainSignature(run: Run): string {
  return [
    run.workflowId,
    run.providerId,
    run.targetKind,
    String(run.sample),
    JSON.stringify(run.params),
    run.items
      .map((i) => i.input.mediaId)
      .sort()
      .join(','),
  ].join('|')
}

/**
 * Fold newest-first runs into retry chains (newest attempt first).
 * Linked runs group by retryOfRunId; rows that predate the linkage field
 * fall back to a strict heuristic — an older failed run identical to the
 * chain directly above it can only be an earlier attempt.
 */
function groupChains(runs: Run[]): Run[][] {
  const chains: Run[][] = []
  const byRoot = new Map<string, Run[]>()
  let previous: { chain: Run[]; signature: string } | null = null
  for (const run of runs) {
    const rootId = run.retryOfRunId ?? run.id
    const signature = chainSignature(run)
    let chain = byRoot.get(rootId)
    if (
      !chain &&
      !run.retryOfRunId &&
      previous &&
      (run.state === 'failed' || run.state === 'cancelled') &&
      signature === previous.signature
    ) {
      chain = previous.chain
    }
    if (chain) {
      chain.push(run)
    } else {
      chain = [run]
      chains.push(chain)
    }
    byRoot.set(rootId, chain)
    previous = { chain, signature }
  }
  return chains
}

const MODEL_EXT = /\.(glb|gltf|usdz)(\?|#|$)/i
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i

/** Resolve an output's media type — prefer the stored type, fall back to the URL
 *  extension so runs staged before mediaType was tracked still render correctly. */
function outputType(url: string, known?: StagedMediaType): StagedMediaType {
  if (known) return known
  if (MODEL_EXT.test(url)) return 'model3d'
  if (VIDEO_EXT.test(url)) return 'video'
  return 'image'
}

/** One run output as a thumbnail — a 3D model shows a boxed glyph (its .glb can't
 *  paint in an <img>), video plays a muted frame, everything else is an image. */
function OutputThumb({
  url,
  mediaType,
  className,
  style,
}: {
  url: string
  mediaType?: StagedMediaType
  className: string
  style?: CSSProperties
}) {
  const type = outputType(url, mediaType)
  if (type === 'model3d') {
    return (
      <span
        className={cn('flex items-center justify-center bg-surface-2 text-ink-faint', className)}
        style={style}
      >
        <IconBox>
          <Box {...ICON} />
        </IconBox>
      </span>
    )
  }
  if (type === 'video') {
    return <video src={url} muted playsInline className={className} style={style} />
  }
  return <img src={url} alt="" loading="lazy" className={className} style={style} />
}

/** Generated outputs as a thumbnail — one plain, several as a small fan. */
function RunThumbs({ run, caption }: { run: Run; caption?: boolean }) {
  const outputs = run.items
    .filter((i) => i.afterUrl)
    .map((i) => ({ url: i.afterUrl!, mediaType: i.mediaType }))
    .slice(0, 3)

  // Caption runs produce text, not images — show the enrichment glyph instead.
  if (outputs.length === 0) {
    return (
      <span className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-faint">
        <IconBox>{caption ? <Sparkles {...ICON} /> : <Images {...ICON} />}</IconBox>
      </span>
    )
  }
  if (outputs.length === 1) {
    return (
      <OutputThumb
        {...outputs[0]!}
        className="size-12 shrink-0 rounded-lg border border-line object-cover"
      />
    )
  }
  return (
    <span className="relative flex h-12 w-14 shrink-0 items-center justify-center">
      {outputs.map((output, i) => {
        const spread = i - (outputs.length - 1) / 2
        return (
          <OutputThumb
            key={i}
            {...output}
            className="absolute size-10 rounded-lg border-2 border-surface object-cover shadow-soft"
            style={{ transform: `translateX(${spread * 10}px) rotate(${spread * 9}deg)`, zIndex: i }}
          />
        )
      })}
    </span>
  )
}

/**
 * Cancelling a multi-image batch is two different intents — skip the image
 * that's stuck, or stop the whole run. One button, explicit choice.
 */
function CancelControl({ run, remaining }: { run: Run; remaining: number }) {
  const cancel = useCancelRun()
  const skip = useSkipRunItem()
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // A single-image run has only one thing to cancel — no menu needed.
  if (remaining <= 1) {
    return (
      <Button variant="ghost" size="sm" onClick={() => cancel.mutate(run.id)}>
        <IconBox>
          <OctagonX {...ICON} />
        </IconBox>
        Cancel
      </Button>
    )
  }

  return (
    <>
      <Button
        ref={button}
        variant="ghost"
        size="sm"
        onClick={() => {
          setRect(button.current?.getBoundingClientRect() ?? null)
          setOpen((v) => !v)
        }}
      >
        <IconBox>
          <OctagonX {...ICON} />
        </IconBox>
        Cancel
        <IconBox className={cn('transition-transform duration-200', open && 'rotate-180')}>
          <ChevronDown {...ICON} />
        </IconBox>
      </Button>
      {open &&
        rect &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.22, ease: easeSoft }}
              className="fixed z-50 w-72 rounded-xl border border-line bg-surface p-1 shadow-lift"
              style={{
                top: rect.bottom + 8,
                left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)),
              }}
            >
              <button
                onClick={() => {
                  skip.mutate(run.id)
                  setOpen(false)
                }}
                className="flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-2 cursor-pointer"
              >
                <span className="text-sm font-medium">Skip current image</span>
                <span className="text-sm text-ink-faint">The rest of the batch keeps going</span>
              </button>
              <button
                onClick={() => {
                  cancel.mutate(run.id)
                  setOpen(false)
                }}
                className="flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition-colors hover:bg-danger-soft cursor-pointer"
              >
                <span className="text-sm font-medium text-danger">Cancel entire run</span>
                <span className="text-sm text-ink-faint">
                  {remaining} image{remaining === 1 ? '' : 's'} left
                </span>
              </button>
            </motion.div>
          </>,
          document.body,
        )}
    </>
  )
}

function ChainRow({
  chain,
  pendingReview,
  showEngine,
}: {
  chain: Run[]
  pendingReview: number
  showEngine: boolean
}) {
  const promote = usePromoteRun()
  const retry = useRetryRun()
  const clear = useClearRun()
  const runRemaining = useHover()
  const [expanded, setExpanded] = useState(false)
  // #23: a failed Clear must not vanish into an unhandled rejection.
  const [clearError, setClearError] = useState<string | null>(null)

  const run = chain[0]!
  const isCaption = run.workflowId === CAPTION_WORKFLOW_ID
  const earlier = chain.slice(1)
  const counts = runCounts(run)
  const retryable = run.items.filter((i) => i.state !== 'done').length
  const editing = run.items.filter((i) => i.state === 'editing').length
  // In-flight items count half — the bar moves honestly even on 1-item runs.
  const progress =
    counts.total === 0 ? 0 : (counts.done + counts.failed + editing * 0.5) / counts.total
  const active = run.state === 'queued' || run.state === 'running'
  const failures = run.items.filter((i) => i.state === 'failed')
  const stateStyle = STATE_STYLES[run.state]
  const targetLabel = TARGET_LABELS[run.targetKind]
  const expandable = failures.length > 0 || earlier.length > 0

  // Metadata segments, joined by " · ". "1 of 1 done" and the shared engine are
  // dropped — they read the same on nearly every row and only add noise.
  const meta: ReactNode[] = []
  if (counts.total > 1 || counts.failed > 0) meta.push(`${counts.done} of ${counts.total} done`)
  if (active && editing > 0) {
    meta.push(
      <span className="text-ink-soft">
        generating {run.items.find((i) => i.state === 'editing')?.productTitle}…
      </span>,
    )
  }
  if (counts.failed > 0) meta.push(<span className="text-danger">{counts.failed} failed</span>)
  if (showEngine) meta.push(PROVIDER_LABELS[run.providerId] ?? run.providerId)
  meta.push(timeAgo(run.createdAt))
  // A finished run can be cleared from the history. Clearing removes the whole
  // chain (every attempt in this row); any edits it staged stay in review.
  if (!active) {
    meta.push(
      <button
        onClick={() => {
          setClearError(null)
          Promise.all(chain.map((r) => clear.mutateAsync(r.id))).catch((err: unknown) =>
            setClearError(err instanceof Error ? err.message : String(err)),
          )
        }}
        disabled={clear.isPending}
        className="underline underline-offset-2 transition-colors hover:text-danger disabled:opacity-50 cursor-pointer"
      >
        Clear
      </button>,
    )
    if (clearError) meta.push(<span className="text-danger">Clear failed: {clearError}</span>)
  }

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: easeSoft }}
      className="border-b border-line last:border-b-0"
    >
      <div className="flex items-center gap-4 px-5 py-3">
        {!isCaption && counts.done > 0 ? (
          <Link
            to={`/review?run=${run.id}`}
            aria-label="Review this run"
            className="shrink-0 rounded-lg transition-opacity hover:opacity-80"
          >
            <RunThumbs run={run} caption={isCaption} />
          </Link>
        ) : (
          <RunThumbs run={run} caption={isCaption} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-medium">{run.workflowName}</h3>
            {expandable && (
              <button
                onClick={() => setExpanded((v) => !v)}
                aria-label="Show details"
                title={
                  earlier.length > 0
                    ? `${earlier.length} earlier attempt${earlier.length === 1 ? '' : 's'}`
                    : 'Show details'
                }
                className="flex h-6 shrink-0 items-center gap-0.5 rounded-lg px-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink cursor-pointer"
              >
                {earlier.length > 0 && (
                  <span className="text-sm tabular-nums">{earlier.length}</span>
                )}
                <IconBox className={cn('transition-transform duration-200', expanded && 'rotate-180')}>
                  <ChevronDown {...ICON} />
                </IconBox>
              </button>
            )}
            {targetLabel && (
              <span className="flex h-6 shrink-0 items-center rounded-lg border border-line bg-surface-2 px-2 text-sm text-ink-soft">
                {targetLabel}
              </span>
            )}
            {run.sample && (
              <span className="flex h-6 shrink-0 items-center rounded-lg bg-accent-soft px-2 text-sm text-ink">
                Sample of {run.sampleOfTotal}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-ink-faint">
            {meta.map((seg, i) => (
              <Fragment key={i}>
                {i > 0 && ' · '}
                {seg}
              </Fragment>
            ))}
          </p>
          {run.error && (
            <p className="mt-1 truncate text-sm text-danger" title={run.error}>
              {run.error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Status surfaces only when it isn't the happy path — a completed run
              says so through its Review / Reviewed action. */}
          {run.state !== 'completed' && (
            <span
              className={cn(
                'flex h-6 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-sm font-medium',
                stateStyle.className,
              )}
            >
              <span className={cn('size-2.5 rounded-full', stateStyle.dot)} />
              {stateStyle.label}
            </span>
          )}
          {active && (
            <CancelControl run={run} remaining={counts.total - counts.done - counts.failed} />
          )}
          {!active && retryable > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => retry.mutate(run.id)}
              disabled={retry.isPending}
            >
              {retry.isPending ? (
                <Spinner />
              ) : (
                <IconBox>
                  <RotateCcw {...ICON} />
                </IconBox>
              )}
              {counts.done > 0 ? `Retry failed (${retryable})` : 'Retry'}
            </Button>
          )}
          {run.sample && run.state === 'completed' && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => promote.mutate(run.id)}
              disabled={promote.isPending}
              {...runRemaining.props}
            >
              {promote.isPending ? (
                <Spinner />
              ) : (
                <IconBox>
                  <PlayIcon size={18} animate={runRemaining.state} />
                </IconBox>
              )}
              Run remaining {run.sampleOfTotal! - counts.total}
            </Button>
          )}
          {!isCaption && counts.done > 0 && pendingReview > 0 && (
            <Link to={`/review?run=${run.id}`}>
              <Button variant="secondary" size="sm">
                Review ({pendingReview})
                <IconBox>
                  <ArrowRight {...ICON} />
                </IconBox>
              </Button>
            </Link>
          )}
          {!isCaption && counts.done > 0 && pendingReview === 0 && (
            <Link
              to={`/review?run=${run.id}`}
              className="flex h-7 items-center gap-1 rounded-lg px-2 text-sm text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <IconBox>
                <Check {...ICON} />
              </IconBox>
              Reviewed
            </Link>
          )}
        </div>
      </div>

      <motion.div
        className="bg-surface-2"
        initial={false}
        animate={{ height: active ? 4 : 0, opacity: active ? 1 : 0 }}
        transition={{ duration: 0.4, ease: easeSoft }}
      >
        <motion.div
          className={cn('h-full', run.state === 'failed' ? 'bg-danger' : 'bg-ink')}
          initial={false}
          animate={{ width: `${progress * 100}%` }}
          transition={{ duration: 0.8, ease: 'linear' }}
        />
      </motion.div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: easeSoft }}
            className="overflow-hidden border-t border-line bg-surface-2/40"
          >
            {failures.map((item) => (
              <p
                key={item.input.mediaId}
                className="flex items-baseline justify-between gap-4 border-b border-line px-5 py-3 text-sm last:border-b-0"
              >
                <span className="shrink-0 font-medium">{item.productTitle}</span>
                <span className="truncate text-danger">{item.error}</span>
              </p>
            ))}
            {earlier.map((attempt) => {
              const c = runCounts(attempt)
              const style = STATE_STYLES[attempt.state]
              return (
                <p
                  key={attempt.id}
                  className="flex items-center gap-3 border-b border-line px-5 py-3 text-sm text-ink-faint last:border-b-0"
                >
                  <span className={cn('size-2.5 shrink-0 rounded-full', style.dot)} />
                  <span>
                    {style.label.toLowerCase()} · {c.done} of {c.total} done
                    {c.failed > 0 && ` · ${c.failed} failed`}
                  </span>
                  <span className="ml-auto shrink-0">{timeAgo(attempt.createdAt)}</span>
                </p>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  )
}

export function ActivityPage() {
  const { activeStore } = useStoreContext()
  const { data: runs = [] } = useRuns(activeStore?.id)
  const { data: staging } = useStaging(activeStore?.id)

  const pendingByRun = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of staging?.items ?? []) {
      if (item.runId && item.state === 'pending') {
        map.set(item.runId, (map.get(item.runId) ?? 0) + 1)
      }
    }
    return map
  }, [staging])

  const chains = useMemo(() => groupChains(runs), [runs])
  // The provider used by most runs — so the engine label appears only on the
  // odd-one-out rows, not on every run when they nearly all share one engine.
  const dominantProvider = useMemo(() => {
    const tally = new Map<string, number>()
    for (const r of runs) tally.set(r.providerId, (tally.get(r.providerId) ?? 0) + 1)
    let top: string | null = null
    let max = 0
    for (const [provider, n] of tally) {
      if (n > max) {
        max = n
        top = provider
      }
    }
    return top
  }, [runs])

  return (
    <>
      <PageHeader
        subtitle="Every workflow run — results stream into the review queue as they finish."
      />
      {runs.length === 0 ? (
        <EmptyState
          icon={<ListChecks {...ICON} />}
          title="No runs yet"
          body="Select media in Browse (or run the whole catalog) and launch a workflow. Progress shows up here live."
          action={
            <Link to="/browse">
              <Button variant="primary">Browse products</Button>
            </Link>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          <AnimatePresence mode="popLayout">
            {chains.map((chain) => (
              <ChainRow
                key={chain[chain.length - 1]!.id}
                chain={chain}
                pendingReview={chain.reduce((n, r) => n + (pendingByRun.get(r.id) ?? 0), 0)}
                showEngine={chain[0]!.providerId !== dominantProvider}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </>
  )
}
