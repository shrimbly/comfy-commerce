import type { ProviderInfo, RunTarget, Workflow } from '@comfy-commerce/shared'
import { ArrowLeft, ArrowRight, Cloud, FlaskConical, HardDrive, ICON, IconBox, Monitor, MonitorSmartphone, Search, ShieldCheck, X } from '../../lib/icons.js'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'

import { useCreateRun, useProviders, useRunEstimate, useWorkflows } from '../../api/hooks.js'
import { PlayIcon } from '../../lib/animated-icons/PlayIcon.js'
import { UploadCloudIcon } from '../../lib/animated-icons/UploadCloudIcon.js'
import { useHover } from '../../lib/useHover.js'
import { Button } from '../../components/ui/Button.js'
import { Segmented } from '../../components/ui/Segmented.js'
import { Spinner } from '../../components/ui/Spinner.js'
import { Tooltip } from '../../components/ui/Tooltip.js'
import { cn } from '../../lib/cn.js'
import { gradientFor } from '../../lib/gradient.js'
import { easeSoft } from '../../lib/motion.js'
import { useStoreContext } from '../../store/StoreContext.js'
import { UploadWorkflowDialog } from '../workflows/UploadWorkflowDialog.js'
import { PromptField } from './PromptField.js'

const PROVIDER_ICONS: Record<ProviderInfo['id'], typeof Cloud> = {
  mock: FlaskConical,
  'comfy-local': MonitorSmartphone,
  'comfy-remote': Monitor,
  'comfy-cloud': Cloud,
}

const SAMPLE_SIZE = 5
/** Above this many images, default to a sample-first run. */
const SAMPLE_NUDGE_THRESHOLD = 12

const STAGE_LABELS = {
  'replace-position': 'Replace in place',
  'add-featured': 'Add as featured',
  'add-new': 'Add as new media',
} as const
type StageAction = keyof typeof STAGE_LABELS

function targetLabel(target: RunTarget): string {
  if (target.kind === 'catalog') return 'Entire catalog (in scope)'
  if (target.kind === 'products') return `${target.productIds?.length ?? 0} products`
  return `${target.inputs?.length ?? 0} selected image${(target.inputs?.length ?? 0) === 1 ? '' : 's'}`
}

/** Compact "Missing nodes" line — caps a long list so it can't run off-screen. */
function missingNodesLabel(nodes: string[] = []): string {
  const MAX = 3
  const shown = nodes.slice(0, MAX).join(', ')
  return nodes.length > MAX
    ? `Missing nodes: ${shown} +${nodes.length - MAX} more`
    : `Missing nodes: ${shown}`
}

const STEPS = [
  { id: 1, label: 'Workflow' },
  { id: 2, label: 'Details' },
  { id: 3, label: 'Engine' },
] as const
type Step = (typeof STEPS)[number]['id']

function Stepper({
  step,
  reachable,
  onGo,
}: {
  step: Step
  reachable: Step
  onGo: (s: Step) => void
}) {
  return (
    <nav aria-label="Run setup steps" className="flex items-center gap-2 border-b border-line px-5 py-3">
      {STEPS.map((s, i) => {
        const done = step > s.id
        const current = step === s.id
        const enabled = s.id <= reachable
        return (
          <div key={s.id} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-4 bg-line-strong" />}
            <button
              onClick={() => enabled && onGo(s.id)}
              disabled={!enabled}
              className={cn(
                'flex h-7 items-center gap-2 rounded-[40px] pr-3 pl-1 text-sm font-medium transition-colors',
                enabled && !current && 'cursor-pointer hover:bg-surface-2',
                current ? 'text-ink' : done ? 'text-ink-soft' : 'text-ink-faint',
              )}
            >
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-full border text-sm transition-colors',
                  done && 'border-ink bg-ink text-surface',
                  current && 'border-ink text-ink',
                  !done && !current && 'border-line-strong text-ink-faint',
                )}
              >
                {s.id}
              </span>
              {s.label}
            </button>
          </div>
        )
      })}
    </nav>
  )
}

function WorkflowPicker({
  workflows,
  selectedId,
  onPick,
  onUpload,
}: {
  workflows: Workflow[]
  selectedId: string | null
  onPick: (w: Workflow) => void
  onUpload: () => void
}) {
  const [query, setQuery] = useState('')
  const upload = useHover()
  const q = query.trim().toLowerCase()
  const matches = (w: Workflow) =>
    !q || w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q)
  const mine = workflows.filter((w) => w.source === 'user' && matches(w))
  const builtins = workflows.filter((w) => w.source === 'builtin' && matches(w))

  const row = (w: Workflow) => {
    const localBad = w.compat['comfy-local']?.compatible === false
    const cloudBad = w.compat['comfy-cloud']?.compatible === false
    const nowhere = localBad && cloudBad
    const selected = w.id === selectedId
    return (
      <button
        key={w.id}
        onClick={() => !nowhere && onPick(w)}
        disabled={nowhere}
        className={cn(
          'flex w-full items-center gap-3 rounded-xl border p-2 pr-3 text-left transition-all duration-200',
          nowhere ? 'opacity-50' : 'cursor-pointer',
          selected ? 'border-ink bg-surface-2' : 'border-line hover:bg-surface-2',
        )}
      >
        <span className="size-10 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2">
          {w.imageUrl ? (
            <img src={w.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <span className="block h-full w-full" style={gradientFor(w.id)} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{w.name}</span>
          {w.description && (
            <span className="block truncate text-sm text-ink-soft">{w.description}</span>
          )}
        </span>
        {cloudBad && (
          <Tooltip
            side="left"
            content={
              nowhere
                ? 'No engine can run this'
                : `Local only — Cloud is missing: ${w.compat['comfy-cloud']?.missingNodes.join(', ')}`
            }
          >
            <IconBox className={nowhere ? 'text-danger' : 'text-ink-faint'}>
              {nowhere ? <X {...ICON} /> : <HardDrive {...ICON} />}
            </IconBox>
          </Tooltip>
        )}
      </button>
    )
  }

  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium text-ink-soft">Choose a workflow</p>
        <Button variant="ghost" size="sm" onClick={onUpload} {...upload.props}>
          <IconBox>
            <UploadCloudIcon size={18} animate={upload.state} />
          </IconBox>
          Upload new
        </Button>
      </div>
      <div className="field-focus mb-3 flex items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5">
        <IconBox className="text-ink-faint">
          <Search {...ICON} />
        </IconBox>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search workflows"
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint"
        />
      </div>

      {mine.length === 0 && builtins.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-faint">No workflows match your search.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {mine.length > 0 && (
            <>
              <p className="text-sm text-ink-faint">Yours</p>
              {mine.map(row)}
              {builtins.length > 0 && <p className="mt-2 text-sm text-ink-faint">Built-in</p>}
            </>
          )}
          {builtins.map(row)}
        </div>
      )}
    </>
  )
}

/**
 * Launch a run in three steps: choose the workflow, fill in the details
 * (prompts are first-class — multi-line, expandable, saveable), then pick
 * the engine and go. Big targets are nudged toward a small test run first.
 */
export function RunSheet({
  open,
  onClose,
  target,
  initialWorkflowId,
  initialParams,
}: {
  open: boolean
  onClose: () => void
  target: RunTarget | null
  /** Pre-select a workflow (skips the picker, opens at the details step) — used
   *  by the review "Retry → Change inputs" flow to re-run a prior result. */
  initialWorkflowId?: string | null
  initialParams?: Record<string, string>
}) {
  const navigate = useNavigate()
  const { activeStore } = useStoreContext()
  const { data: workflows = [] } = useWorkflows()
  const { data: providers = [] } = useProviders()
  const { data: estimate } = useRunEstimate(open ? activeStore?.id : undefined, open ? target : null)
  const createRun = useCreateRun()

  const [[step, direction], setStepState] = useState<[Step, number]>([1, 1])
  const [workflowId, setWorkflowId] = useState<string | null>(null)
  const [params, setParams] = useState<Record<string, string>>({})
  const [providerId, setProviderId] = useState<ProviderInfo['id'] | null>(null)
  const [stageAction, setStageAction] = useState<StageAction>('add-new')
  const [sampleFirst, setSampleFirst] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)

  const goTo = (next: Step) => setStepState(([current]) => [next, next > current ? 1 : -1])

  const workflow: Workflow | undefined = useMemo(
    () => workflows.find((w) => w.id === workflowId),
    [workflows, workflowId],
  )
  const images = estimate?.images ?? 0
  const bigTarget = images > SAMPLE_NUDGE_THRESHOLD

  // On open: a pre-selected workflow (retry → change inputs) jumps straight to
  // the details step with its params loaded; otherwise start at the picker.
  // Keyed on `open` alone so loading the estimate (bigTarget) can't reset edits.
  useEffect(() => {
    if (!open) return
    if (initialWorkflowId) {
      setWorkflowId(initialWorkflowId)
      setParams(initialParams ?? {})
      setStepState([2, 1])
    } else {
      setStepState([1, 1])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open) setSampleFirst(bigTarget)
  }, [open, bigTarget])

  // Auto-select the engine: keep a still-runnable choice, otherwise pick the
  // only (or first) engine that's both available AND compatible with the
  // workflow — so a single viable option needs no manual selection.
  useEffect(() => {
    if (providers.length === 0) return
    const runnable = providers.filter(
      (p) =>
        p.id !== 'mock' && p.available && (!workflow || workflow.compat[p.id]?.compatible !== false),
    )
    setProviderId((current) =>
      runnable.some((p) => p.id === current) ? current : (runnable[0]?.id ?? null),
    )
  }, [providers, workflow])

  // The mock engine still powers demo-store runs under the hood, but it is not
  // offered as a pickable engine — operators choose between local and cloud.
  const selectableProviders = providers.filter((p) => p.id !== 'mock')

  const engineCompatible = (id: ProviderInfo['id']) =>
    !workflow || workflow.compat[id]?.compatible !== false

  // Real engines that could actually run this workflow right now.
  const anyEngineRunnable = selectableProviders.some((p) => p.available && engineCompatible(p.id))
  // A run is only allowed once a real, available, compatible engine is chosen.
  // The mock engine is never selectable, so we must never silently fall back to it.
  const engineReady =
    providerId != null &&
    selectableProviders.some((p) => p.id === providerId && p.available && engineCompatible(p.id))

  const pickWorkflow = (w: Workflow) => {
    if (w.id !== workflowId) setParams({})
    setWorkflowId(w.id)
    goTo(2)
  }

  const launchHover = useHover()

  const launch = () => {
    if (!activeStore || !target || !workflowId || !providerId || !engineReady) return
    const defaults = Object.fromEntries(
      (workflow?.params ?? []).filter((p) => p.defaultValue).map((p) => [p.id, p.defaultValue!]),
    )
    createRun.mutate(
      {
        storeId: activeStore.id,
        workflowId,
        providerId,
        params: { ...defaults, ...params },
        target,
        stageAction,
        ...(sampleFirst && bigTarget ? { sampleSize: SAMPLE_SIZE } : {}),
      },
      {
        onSuccess: () => {
          onClose()
          navigate('/activity')
        },
      },
    )
  }

  // Portal to the body so the sheet and its backdrop span the whole viewport —
  // in place they would be clipped to AppShell's max-width page container,
  // which is a containing block for `fixed` descendants.
  return createPortal(
    <AnimatePresence>
      {open && target && (
        <motion.div
          className="fixed inset-0 z-50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: easeSoft }}
        >
          <div className="absolute inset-0 bg-ink/20 backdrop-blur-[3px] dark:bg-black/50" onClick={onClose} />
          <motion.aside
            role="dialog"
            aria-label="Run workflow"
            initial={{ x: 80, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 80, opacity: 0 }}
            transition={{ duration: 0.35, ease: easeSoft }}
            className="absolute inset-y-3 right-3 flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-lift"
          >
            <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
              <div>
                <h2 className="text-lg font-medium">Run workflow</h2>
                <p className="mt-1 text-sm text-ink-soft">
                  {targetLabel(target)}
                  {estimate && (
                    <span className="text-ink-faint">
                      {' '}
                      · {estimate.images} image{estimate.images === 1 ? '' : 's'} across{' '}
                      {estimate.products} product{estimate.products === 1 ? '' : 's'}
                    </span>
                  )}
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="flex size-7 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink cursor-pointer"
              >
                <IconBox>
                  <X {...ICON} />
                </IconBox>
              </button>
            </header>

            <Stepper step={step} reachable={workflowId ? 3 : 1} onGo={goTo} />

            <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
              <AnimatePresence mode="popLayout" initial={false} custom={direction}>
                <motion.div
                  key={step}
                  custom={direction}
                  initial={{ opacity: 0, x: direction * 32 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: direction * -32 }}
                  transition={{ duration: 0.25, ease: easeSoft }}
                  className="px-5 py-4"
                >
                  {step === 1 && (
                    <WorkflowPicker
                      workflows={workflows}
                      selectedId={workflowId}
                      onPick={pickWorkflow}
                      onUpload={() => setUploadOpen(true)}
                    />
                  )}

                  {step === 2 && workflow && (
                    <div className="grid gap-4">
                      <div>
                        <p className="mb-2 text-sm font-medium text-ink-soft">When published</p>
                        <Segmented
                          value={stageAction}
                          onChange={setStageAction}
                          options={[
                            { value: 'add-new', label: 'Add as new media' },
                            { value: 'replace-position', label: 'Replace in place' },
                            { value: 'add-featured', label: 'Add as featured' },
                          ]}
                        />
                      </div>
                      {workflow.params.length === 0 && (
                        <p className="text-sm text-ink-faint">
                          {workflow.name} has no settings — continue to pick an engine.
                        </p>
                      )}
                      {workflow.params.map((param) =>
                        param.type === 'select' && param.options ? (
                          <div key={param.id}>
                            <p className="mb-2 text-sm font-medium text-ink-soft">{param.label}</p>
                            <div className="flex flex-wrap gap-2">
                              {param.options.map((option) => {
                                const active = (params[param.id] ?? param.defaultValue) === option.value
                                return (
                                  <button
                                    key={option.value}
                                    onClick={() => setParams((p) => ({ ...p, [param.id]: option.value }))}
                                    className={cn(
                                      'h-7 rounded-[40px] border px-3 text-sm font-medium transition-all duration-200 cursor-pointer',
                                      active
                                        ? 'border-ink bg-ink text-surface'
                                        : 'border-line text-ink-soft hover:bg-surface-2 hover:text-ink',
                                    )}
                                  >
                                    {option.label}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        ) : param.type === 'number' ? (
                          <div key={param.id}>
                            <p className="mb-2 text-sm font-medium text-ink-soft">{param.label}</p>
                            <input
                              value={params[param.id] ?? param.defaultValue ?? ''}
                              onChange={(e) => setParams((p) => ({ ...p, [param.id]: e.target.value }))}
                              placeholder={param.placeholder}
                              inputMode="decimal"
                              className="h-9 w-40 rounded-lg border border-line-strong bg-surface px-3 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-ink"
                            />
                          </div>
                        ) : (
                          <PromptField
                            key={param.id}
                            label={param.label}
                            value={params[param.id] ?? param.defaultValue ?? ''}
                            placeholder={param.placeholder}
                            onChange={(next) => setParams((p) => ({ ...p, [param.id]: next }))}
                          />
                        ),
                      )}
                    </div>
                  )}

                  {step === 3 && workflow && (
                    <>
                      {/* What's about to run — last sanity check before launch. */}
                      <div className="mb-4 flex items-center gap-3 rounded-xl border border-line bg-surface-2 p-3">
                        <span className="size-9 shrink-0 overflow-hidden rounded-lg border border-line">
                          {workflow.imageUrl ? (
                            <img src={workflow.imageUrl} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <span className="block h-full w-full" style={gradientFor(workflow.id)} />
                          )}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{workflow.name}</p>
                          <p className="text-sm text-ink-faint">
                            {images} image{images === 1 ? '' : 's'} · {STAGE_LABELS[stageAction]}
                          </p>
                        </div>
                      </div>

                      <p className="mb-2 text-sm font-medium text-ink-soft">Engine — local or cloud</p>
                      <div className="grid grid-cols-1 gap-2">
                        {selectableProviders.map((provider) => {
                          const Icon = PROVIDER_ICONS[provider.id]
                          const active = provider.id === providerId
                          const compatible = engineCompatible(provider.id)
                          const enabled = provider.available && compatible
                          return (
                            <button
                              key={provider.id}
                              onClick={() => enabled && setProviderId(provider.id)}
                              disabled={!enabled}
                              className={cn(
                                'flex items-center gap-3 rounded-xl border p-3 text-left transition-all duration-200',
                                enabled ? 'cursor-pointer' : 'opacity-50',
                                active ? 'border-ink bg-surface-2' : 'border-line hover:bg-surface-2',
                              )}
                            >
                              <IconBox className={active ? 'text-ink' : 'text-ink-faint'}>
                                <Icon {...ICON} />
                              </IconBox>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium">{provider.name}</p>
                                <p className="truncate text-sm text-ink-soft">
                                  {!compatible
                                    ? missingNodesLabel(workflow?.compat[provider.id]?.missingNodes)
                                    : (provider.detail ?? provider.description)}
                                </p>
                              </div>
                              <span
                                className={cn(
                                  'size-2.5 shrink-0 rounded-full',
                                  enabled ? 'bg-success' : 'bg-ink-faint',
                                )}
                              />
                            </button>
                          )
                        })}
                      </div>

                      {!engineReady && (
                        <p className="mt-3 text-sm text-ink-faint">
                          {anyEngineRunnable
                            ? 'Select an engine to run.'
                            : 'No engine available — connect Comfy Local or add a Comfy Cloud key to run.'}
                        </p>
                      )}

                      {bigTarget && (
                        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4 transition-colors hover:bg-surface-2">
                          <input
                            type="checkbox"
                            checked={sampleFirst}
                            onChange={(e) => setSampleFirst(e.target.checked)}
                            className="mt-1 size-4 accent-[var(--ink)]"
                          />
                          <span>
                            <span className="text-sm font-medium">
                              Test on {SAMPLE_SIZE} images first (recommended)
                            </span>
                            <span className="mt-1 block text-sm text-ink-soft">
                              A small spread across products lands in the review queue. One click
                              promotes to the remaining {Math.max(0, images - SAMPLE_SIZE)} images.
                            </span>
                          </span>
                        </label>
                      )}

                      <p className="mt-4 flex items-center gap-2 rounded-xl border border-line bg-surface-2 p-3 text-sm text-ink-soft">
                        <IconBox className="text-success">
                          <ShieldCheck {...ICON} />
                        </IconBox>
                        Results stage for review as they finish — nothing publishes automatically.
                      </p>

                      {createRun.isError && (
                        <p className="mt-3 text-sm text-danger">{(createRun.error as Error).message}</p>
                      )}
                    </>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>

            <footer className="flex items-center justify-between gap-2 border-t border-line px-5 py-4">
              <div>
                {step > 1 && (
                  <Button variant="ghost" onClick={() => goTo((step - 1) as Step)}>
                    <IconBox>
                      <ArrowLeft {...ICON} />
                    </IconBox>
                    Back
                  </Button>
                )}
              </div>
              {step < 3 ? (
                <Button
                  variant="primary"
                  onClick={() => goTo((step + 1) as Step)}
                  disabled={!workflowId}
                >
                  Continue
                  <IconBox>
                    <ArrowRight {...ICON} />
                  </IconBox>
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={launch}
                  disabled={!workflowId || images === 0 || !engineReady || createRun.isPending}
                  {...launchHover.props}
                >
                  {createRun.isPending ? (
                    <Spinner className="border-accent-ink/40 border-t-accent-ink" />
                  ) : (
                    <IconBox>
                      <PlayIcon size={18} animate={launchHover.state} />
                    </IconBox>
                  )}
                  {sampleFirst && bigTarget
                    ? `Run test (${Math.min(SAMPLE_SIZE, images)})`
                    : `Run on ${images} image${images === 1 ? '' : 's'}`}
                </Button>
              )}
            </footer>
          </motion.aside>

          <UploadWorkflowDialog
            open={uploadOpen}
            onClose={() => setUploadOpen(false)}
            onSaved={(id) => {
              setWorkflowId(id)
              setParams({})
              goTo(2)
            }}
          />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
