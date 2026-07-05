import type { EngineCompat, Workflow } from '@comfy-commerce/shared'
import { ArrowRight, ChevronDown, Download, ICON, IconBox, X } from '../../lib/icons.js'
import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'

import { useProviders, useWorkflows } from '../../api/hooks.js'
import { Button } from '../../components/ui/Button.js'
import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'
import { HoverWipe } from './HoverWipe.js'

/** One engine row: name + status. A "down" engine expands to list missing nodes. */
function EngineRow({ name, compat }: { name: string; compat?: EngineCompat }) {
  const [expanded, setExpanded] = useState(false)
  const down = compat?.compatible === false
  const ready = compat?.compatible === true

  return (
    <div className="border-t border-line first:border-t-0">
      {down ? (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm cursor-pointer"
        >
          <span className="truncate text-ink">{name}</span>
          <span className="flex shrink-0 items-center gap-1 text-warn">
            <span className="size-1.5 rounded-full bg-warn" />
            Issue
            <IconBox className={cn('transition-transform duration-200', expanded && 'rotate-180')}>
              <ChevronDown {...ICON} />
            </IconBox>
          </span>
        </button>
      ) : (
        <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
          <span className="truncate text-ink">{name}</span>
          <span className="flex shrink-0 items-center gap-1.5 text-ink-soft">
            <span className={cn('size-1.5 rounded-full', ready ? 'bg-success' : 'bg-ink-faint')} />
            {ready ? 'Ready' : 'Unchecked'}
          </span>
        </div>
      )}
      <AnimatePresence initial={false}>
        {down && expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: easeSoft }}
            className="overflow-hidden"
          >
            <p className="px-3 pb-2 text-sm text-ink-faint">
              Missing {compat!.missingNodes.length} node
              {compat!.missingNodes.length === 1 ? '' : 's'}: {compat!.missingNodes.join(', ')}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * Workflow detail modal: a large 4:3 thumbnail (matching the card, with the same
 * hover-wipe) at two-thirds width; the right third holds a fixed title, a
 * scrolling detail area (description, params, a "Runs on" table), and actions
 * pinned to the bottom. The modal is exactly the image's height — the right
 * column fills it via an absolute layer, and a gradient hints when it scrolls.
 *
 * "Runs on" validates against the user's actual engines (same data the run flow
 * uses), re-checked each open.
 */
export function WorkflowDetailDialog({
  workflow,
  onClose,
}: {
  workflow: Workflow | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: providers = [] } = useProviders()
  const { data: workflows = [] } = useWorkflows()

  // Hold the last workflow so the content stays put through the close animation.
  const [shown, setShown] = useState<Workflow | null>(null)
  useEffect(() => {
    if (workflow) setShown(workflow)
  }, [workflow])
  const open = workflow !== null
  const wf = workflow ?? shown
  const detail = workflows.find((w) => w.id === wf?.id) ?? wf

  // Re-validate against the live engines whenever the dialog opens, so a stale
  // "down" (e.g. the local ComfyUI hadn't finished registering nodes) clears.
  useEffect(() => {
    if (workflow) void queryClient.invalidateQueries({ queryKey: ['workflows'] })
  }, [workflow, queryClient])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Scroll affordance: show a bottom gradient while there's more to scroll.
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [canScrollMore, setCanScrollMore] = useState(false)
  const measure = () => {
    const el = scrollRef.current
    if (el) setCanScrollMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1)
  }
  useEffect(() => {
    if (!open || !contentRef.current) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(contentRef.current)
    measure()
    return () => ro.disconnect()
  }, [open])

  const engines = providers.filter((p) => p.id !== 'mock' && p.available)

  return createPortal(
    <AnimatePresence>
      {open && wf && detail && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: easeSoft }}
        >
          <div
            className="absolute inset-0 bg-ink/20 backdrop-blur-[3px] dark:bg-black/50"
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={wf.name}
            className="relative flex w-full max-w-4xl overflow-hidden rounded-2xl border border-line bg-surface shadow-lift"
            initial={{ opacity: 0, scale: 0.96, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.35, ease: easeSoft }}
          >
            <button
              onClick={onClose}
              aria-label="Close"
              className="absolute top-3 right-3 z-10 flex size-7 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink cursor-pointer"
            >
              <IconBox>
                <X {...ICON} />
              </IconBox>
            </button>

            {/* Large thumbnail — two-thirds, 4:3, same hover-wipe as the card, 4px
                off the edges. This defines the modal's height. */}
            <div className="w-2/3 shrink-0 p-1">
              <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl border border-line bg-surface-2">
                <HoverWipe
                  base={wf.imageUrl}
                  compare={wf.compareImageUrl}
                  seed={wf.id}
                  alt={wf.name}
                  className="absolute inset-0"
                />
              </div>
            </div>

            {/* Right third: absolute layer fills the image height; content
                scrolls between a fixed title and bottom-pinned actions. */}
            <div className="relative min-w-0 flex-1">
              <div className="absolute inset-0 flex flex-col p-5">
                <div className="shrink-0 pr-8">
                  <h2 title={wf.name} className="truncate text-lg font-medium">
                    {wf.name}
                  </h2>
                  <p className="mt-1 text-sm text-ink-soft">
                    {wf.source === 'builtin' ? 'Built-in workflow' : 'Your workflow'}
                  </p>
                </div>

                <div className="relative mt-4 min-h-0 flex-1">
                  <div
                    ref={scrollRef}
                    onScroll={measure}
                    className="h-full overflow-y-auto pr-1"
                  >
                    <div ref={contentRef}>
                      <p className="text-sm text-ink-soft">{wf.description || 'No description.'}</p>

                      {wf.params.length > 0 && (
                        <div className="mt-4">
                          <p className="text-sm text-ink-faint">Parameters</p>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {wf.params.map((p) => (
                              <span
                                key={p.id}
                                className="rounded-lg border border-line bg-surface-2 px-2 py-0.5 text-sm text-ink-soft"
                              >
                                {p.label}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {engines.length > 0 && (
                        <div className="mt-4">
                          <p className="text-sm text-ink-faint">Runs on</p>
                          <div className="mt-1.5 overflow-hidden rounded-lg border border-line">
                            {engines.map((e) => (
                              <EngineRow key={e.id} name={e.name} compat={detail.compat?.[e.id]} />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Scroll hint — fades in only when there's more below. */}
                  <div
                    className={cn(
                      'pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface to-transparent transition-opacity duration-200',
                      canScrollMore ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                </div>

                <div className="flex shrink-0 items-center gap-2 pt-4">
                  <a
                    href={`/api/workflows/${wf.id}/download`}
                    download
                    aria-label={`Download ${wf.name}`}
                    title="Download workflow JSON for ComfyUI"
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-ink-soft transition-all duration-200 hover:bg-surface-2 hover:text-ink cursor-pointer"
                  >
                    <IconBox>
                      <Download {...ICON} />
                    </IconBox>
                  </a>
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={() => {
                      onClose()
                      navigate('/browse')
                    }}
                  >
                    Apply to products
                    <IconBox>
                      <ArrowRight {...ICON} />
                    </IconBox>
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
