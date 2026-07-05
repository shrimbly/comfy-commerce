import type { FixedInput, WorkflowInspection, WorkflowParam } from '@comfy-commerce/shared'
import { Check, ICON, IconBox, UploadCloud, Workflow } from '../../lib/icons.js'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { useInspectWorkflow, useSaveWorkflow, useUploadAsset } from '../../api/hooks.js'
import { Button } from '../../components/ui/Button.js'
import { Dialog } from '../../components/ui/Dialog.js'
import { Spinner } from '../../components/ui/Spinner.js'
import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'
import { FixedImageField } from './FixedImageField.js'
import { GradientSparkle } from './GradientSparkle.js'
import { WatchUploadGuide } from './UploadGuide.js'

/** A reference image the author has picked for a fixed input, pre-upload. */
interface FixedDraft {
  file: File
  preview: string
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}

/**
 * Upload a ComfyUI workflow (API-format JSON) as a short stepped flow: name it,
 * bind its image inputs (product + any fixed reference images), then opt in
 * parameters. Unambiguous graphs bind automatically; the Parameters step is
 * skipped when there's nothing to expose.
 */
export function UploadWorkflowDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved?: (workflowId: string) => void
}) {
  const inspect = useInspectWorkflow()
  const save = useSaveWorkflow()
  const uploadAsset = useUploadAsset()

  const [graph, setGraph] = useState<unknown>(null)
  const [fileName, setFileName] = useState('')
  const [inspection, setInspection] = useState<WorkflowInspection | null>(null)
  const [name, setName] = useState('')
  const [inputNodeId, setInputNodeId] = useState<string | null>(null)
  const [outputNodeId, setOutputNodeId] = useState<string | null>(null)
  const [exposed, setExposed] = useState<Set<string>>(new Set())
  /** Fixed reference images keyed by the LoadImage node they feed. */
  const [fixedDrafts, setFixedDrafts] = useState<Record<string, FixedDraft>>({})
  /** Wizard position once a file is inspected. */
  const [step, setStep] = useState(0)
  const [parseError, setParseError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  /** Measured wizard-panel height, animated so the dialog never jumps. */
  const contentRef = useRef<HTMLDivElement>(null)
  const [panelHeight, setPanelHeight] = useState<number | 'auto'>('auto')

  const reset = () => {
    setGraph(null)
    setFileName('')
    setInspection(null)
    setName('')
    setInputNodeId(null)
    setOutputNodeId(null)
    setExposed(new Set())
    setStep(0)
    setPanelHeight('auto')
    setFixedDrafts((prev) => {
      Object.values(prev).forEach((d) => URL.revokeObjectURL(d.preview))
      return {}
    })
    setParseError(null)
    inspect.reset()
    save.reset()
    uploadAsset.reset()
  }

  const pickFixed = (nodeId: string, file: File) =>
    setFixedDrafts((prev) => {
      if (prev[nodeId]) URL.revokeObjectURL(prev[nodeId]!.preview)
      return { ...prev, [nodeId]: { file, preview: URL.createObjectURL(file) } }
    })

  const close = () => {
    reset()
    onClose()
  }

  const handleFile = useCallback(
    (file: File) => {
      setParseError(null)
      file.text().then((text) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          setParseError('That file is not valid JSON.')
          return
        }
        setGraph(parsed)
        setFileName(file.name)
        setName(file.name.replace(/\.json$/i, '').replace(/[-_]+/g, ' '))
        inspect.mutate(parsed, {
          onSuccess: (result) => {
            setInspection(result)
            setStep(0)
            setInputNodeId(result.appMode?.inputNodeId ?? result.autoBinding?.inputNodeId ?? null)
            // Default the output to the chosen binding, else the lone/Save node —
            // so a single-output graph never leaves the field unset.
            setOutputNodeId(
              result.appMode?.outputNodeId ??
                result.autoBinding?.outputNodeId ??
                result.outputCandidates.find((c) => c.classType === 'SaveImage')?.nodeId ??
                result.outputCandidates[0]?.nodeId ??
                null,
            )
            // App Mode inputs are the author's curated surface — expose them all.
            if (result.appMode) {
              setExposed(new Set(result.appMode.params.map((p) => `${p.nodeId}:${p.inputKey}`)))
            }
          },
          onError: (err) => setParseError((err as Error).message),
        })
      })
    },
    [inspect],
  )

  // Track the wizard panel's natural height so the dialog can animate between
  // steps (and the appearing/disappearing file bar) instead of snapping.
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!inspection || !el) return
    const measure = () => setPanelHeight(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [inspection])

  // Every LoadImage that isn't the product slot is a fixed reference image.
  const fixedCandidates =
    inspection?.inputCandidates.filter((c) => c.nodeId !== inputNodeId) ?? []
  const fixedReady = fixedCandidates.every((c) => fixedDrafts[c.nodeId])

  const submit = async () => {
    if (!graph || !inspection || !inputNodeId || !outputNodeId || !fixedReady) return
    const candidates = inspection.appMode?.params ?? inspection.paramCandidates
    const params: WorkflowParam[] = candidates
      .filter((c) => exposed.has(`${c.nodeId}:${c.inputKey}`))
      .map((c) => ({
        id: slugify(`${c.inputKey}-${c.nodeId}`),
        label: c.label,
        type: c.valueType === 'number' ? 'number' : c.valueType === 'select' ? 'select' : 'text',
        nodeId: c.nodeId,
        inputKey: c.inputKey,
        defaultValue: c.currentValue,
        ...(c.options ? { options: c.options } : {}),
      }))
    // Upload each fixed image to the asset store, then save the bindings.
    let fixedInputs: FixedInput[]
    try {
      fixedInputs = await Promise.all(
        fixedCandidates.map(async (c) => ({
          nodeId: c.nodeId,
          assetId: (await uploadAsset.mutateAsync(fixedDrafts[c.nodeId]!.file)).id,
          label: c.label,
        })),
      )
    } catch {
      return // surfaced via uploadAsset.isError below
    }
    save.mutate(
      { name, graph, inputNodeId, outputNodeId, params, fixedInputs },
      {
        onSuccess: (workflow) => {
          onSaved?.(workflow.id)
          close()
        },
      },
    )
  }

  const multiInput = (inspection?.inputCandidates.length ?? 0) > 1
  const paramList = inspection?.appMode?.params ?? inspection?.paramCandidates ?? []
  const busy = save.isPending || uploadAsset.isPending

  // The wizard drops the Parameters step entirely when there's nothing to expose.
  const steps = [
    { key: 'details' as const, label: 'Details' },
    { key: 'inputs' as const, label: 'Image inputs' },
    ...(paramList.length > 0 ? [{ key: 'params' as const, label: 'Parameters' }] : []),
  ]
  const current = steps[step]?.key ?? 'details'
  const inputsValid = Boolean(inputNodeId && outputNodeId && fixedReady)
  const stepValid =
    current === 'details' ? name.trim().length > 0 : current === 'inputs' ? inputsValid : true
  const canSave = name.trim().length > 0 && inputsValid
  const isLast = step >= steps.length - 1

  const subtitle = !inspection
    ? 'Drop a ComfyUI workflow. Workflows with App Mode set up work best, Export (API) works too.'
    : current === 'details'
      ? 'Give this workflow a name.'
      : current === 'inputs'
        ? multiInput
          ? 'Choose the product photo; the other inputs use a fixed image you set now.'
          : 'Confirm where the product photo flows in and the result comes out.'
        : 'Choose which inputs are adjustable when launching a run.'

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Upload workflow"
      subtitle={subtitle}
      className="max-w-xl bg-surface-2"
      headerAction={!inspection ? <WatchUploadGuide /> : undefined}
    >
      <div className="px-5 pb-5">
        {!inspection && (
          <label
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const file = e.dataTransfer.files[0]
              if (file) handleFile(file)
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed bg-surface px-5 py-12 text-center transition-colors',
              dragOver ? 'border-ink bg-surface-2' : 'border-line-strong hover:bg-surface-2',
            )}
          >
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
              }}
            />
            <div className="mb-3 flex size-12 items-center justify-center rounded-xl border border-line bg-surface-2 text-ink-faint">
              <IconBox>
                <UploadCloud {...ICON} />
              </IconBox>
            </div>
            <p className="text-sm font-medium">Drop a workflow JSON here</p>
            <p className="mt-1 text-sm text-ink-soft">or click to browse your files</p>
            {inspect.isPending && <Spinner className="mt-4" />}
            {parseError && <p className="mt-3 text-sm text-danger">{parseError}</p>}
          </label>
        )}

        {inspection && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, height: panelHeight }}
            transition={{ duration: 0.3, ease: easeSoft }}
            className="-mx-4 -mb-4 overflow-hidden rounded-xl"
          >
            <div ref={contentRef} className="relative rounded-xl border border-line bg-surface p-4">
            {/* Stepper. Completed steps are clickable to jump back. */}
            <div className="flex items-center justify-center">
              {steps.map((s, i) => {
                const done = i < step
                const active = i === step
                return (
                  <div key={s.key} className="flex items-center">
                    {i > 0 && (
                      <div className={cn('mx-2 h-px w-6 shrink-0', i <= step ? 'bg-ink/30' : 'bg-line')} />
                    )}
                    <button
                      type="button"
                      onClick={() => done && setStep(i)}
                      className={cn('flex items-center gap-2', done ? 'cursor-pointer' : 'cursor-default')}
                    >
                      <span
                        className={cn(
                          'flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-colors',
                          active
                            ? 'bg-ink text-surface'
                            : done
                              ? 'bg-ink-soft text-surface'
                              : 'border border-line-strong text-ink-faint',
                        )}
                      >
                        {done ? <Check size={13} strokeWidth={2} absoluteStrokeWidth /> : i + 1}
                      </span>
                      <span className={cn('text-sm', active ? 'font-medium text-ink' : 'text-ink-faint')}>
                        {s.label}
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>

            {/* File context — below the stepper, first step only; "Change" swaps the file. */}
            {current === 'details' && (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-line bg-surface-2 py-1.5 pr-2 pl-3">
                <IconBox className="text-ink-soft">
                  <Workflow {...ICON} />
                </IconBox>
                <p className="min-w-0 flex-1 truncate text-sm">{fileName}</p>
                <span className="text-sm text-ink-faint">{inspection.nodeCount} nodes</span>
                <Button variant="ghost" size="sm" onClick={reset}>
                  Change
                </Button>
              </div>
            )}

            {/* Step body. popLayout pops the exiting step out of flow so the new
                step's height settles in one commit — the dialog resizes
                monotonically instead of bouncing. */}
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={current}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.18, ease: easeSoft }}
                className="mt-5"
              >
                {current === 'details' && (
                  <>
                    <p className="mb-2 text-sm font-medium text-ink-soft">Name</p>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Studio relight v2"
                      autoFocus
                      className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-ink"
                    />
                  </>
                )}

                {current === 'inputs' && (
                  <>
                    {inspection.inputCandidates.length === 0 && (
                      <p className="rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm text-danger">
                        This workflow has no LoadImage node — it can't receive a product photo.
                      </p>
                    )}

                    {multiInput ? (
                      <>
                        <div className="grid gap-2">
                          {inspection.inputCandidates.map((c) => {
                            const isProduct = inputNodeId === c.nodeId
                            const draft = fixedDrafts[c.nodeId]
                            return (
                              <div
                                key={c.nodeId}
                                className={cn(
                                  'rounded-xl border p-3 transition-colors',
                                  isProduct ? 'border-ink bg-surface-2' : 'border-line',
                                )}
                              >
                                <button
                                  type="button"
                                  onClick={() => setInputNodeId(c.nodeId)}
                                  className="flex w-full cursor-pointer items-center gap-2.5 text-left"
                                >
                                  <span
                                    className={cn(
                                      'flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                                      isProduct ? 'border-ink' : 'border-line-strong',
                                    )}
                                  >
                                    {isProduct && <span className="size-2 rounded-full bg-ink" />}
                                  </span>
                                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                    {c.label}
                                  </span>
                                  {inputNodeId && (
                                    <span
                                      className={cn(
                                        'shrink-0 rounded-md px-2 py-0.5 text-sm font-medium',
                                        isProduct ? 'bg-accent-soft text-ink' : 'text-ink-faint',
                                      )}
                                    >
                                      {isProduct ? 'Product · per run' : 'Fixed'}
                                    </span>
                                  )}
                                </button>
                                {inputNodeId && !isProduct && (
                                  <div className="mt-3 border-t border-line pt-3">
                                    <FixedImageField
                                      image={draft?.preview ?? null}
                                      fileName={draft?.file.name}
                                      needsImage={!draft}
                                      onPick={(file) => pickFixed(c.nodeId, file)}
                                    />
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>

                        {inspection.outputCandidates.length > 1 && (
                          <>
                            <p className="mt-4 mb-2 text-sm font-medium text-ink-soft">
                              Which node produces the result?
                            </p>
                            <div className="grid gap-2">
                              {inspection.outputCandidates.map((c) => (
                                <button
                                  key={c.nodeId}
                                  onClick={() => setOutputNodeId(c.nodeId)}
                                  className={cn(
                                    'flex h-9 items-center justify-between rounded-lg border px-3 text-sm cursor-pointer transition-colors',
                                    outputNodeId === c.nodeId ? 'border-ink bg-surface-2' : 'border-line hover:bg-surface-2',
                                  )}
                                >
                                  {c.label}
                                  {outputNodeId === c.nodeId && (
                                    <IconBox>
                                      <Check {...ICON} />
                                    </IconBox>
                                  )}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </>
                    ) : (
                      inputNodeId && (
                        <div className="grid gap-1 rounded-xl border border-line p-3 text-sm">
                          <p className="flex items-center justify-between gap-2">
                            <span className="text-ink-soft">Product photo goes to</span>
                            <span className="truncate font-medium">
                              {inspection.inputCandidates.find((c) => c.nodeId === inputNodeId)?.label ??
                                inputNodeId}
                            </span>
                          </p>
                          {outputNodeId && (
                            <p className="flex items-center justify-between gap-2">
                              <span className="text-ink-soft">Result comes from</span>
                              <span className="truncate font-medium">
                                {inspection.outputCandidates.find((c) => c.nodeId === outputNodeId)
                                  ?.label ?? outputNodeId}
                              </span>
                            </p>
                          )}
                        </div>
                      )
                    )}

                    {inspection.appMode && (() => {
                      const curatedInputCount =
                        inspection.appMode.params.length + (inspection.appMode.inputNodeId ? 1 : 0)
                      return (
                        <p className="mt-3 flex items-center gap-1.5 text-sm text-ink-soft">
                          <IconBox className="shrink-0">
                            <GradientSparkle />
                          </IconBox>
                          App Mode detected — using the {curatedInputCount} input
                          {curatedInputCount === 1 ? '' : 's'} you curated in ComfyUI.
                        </p>
                      )
                    })()}
                  </>
                )}

                {current === 'params' && (
                  <>
                    {!inspection.appMode && inspection.paramCandidates.length > 6 && (
                      <p className="mb-3 rounded-xl border border-line bg-surface-2 p-3 text-sm text-ink-soft">
                        Tip: save an <span className="font-medium text-ink">App Mode</span> version in
                        ComfyUI and upload that file — only the inputs you curated will appear here,
                        instead of every literal value in the graph.
                      </p>
                    )}
                    <div className="grid max-h-72 gap-1 overflow-y-auto">
                      {paramList.map((c) => {
                        const key = `${c.nodeId}:${c.inputKey}`
                        const checked = exposed.has(key)
                        return (
                          <label
                            key={key}
                            className="flex h-9 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm transition-colors hover:bg-surface-2"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setExposed((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(key)) next.delete(key)
                                  else next.add(key)
                                  return next
                                })
                              }
                              className="size-4 accent-[var(--ink)]"
                            />
                            <span className="min-w-0 flex-1 truncate">{c.label}</span>
                            <span className="max-w-40 truncate text-ink-faint">{c.currentValue}</span>
                          </label>
                        )
                      })}
                    </div>
                  </>
                )}
              </motion.div>
            </AnimatePresence>

            {(save.isError || uploadAsset.isError) && (
              <p className="mt-3 text-sm text-danger">
                {((save.error ?? uploadAsset.error) as Error | undefined)?.message ?? 'Save failed'}
              </p>
            )}

            <div className="mt-6 flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                onClick={step === 0 ? close : () => setStep((s) => s - 1)}
                disabled={busy}
              >
                {step === 0 ? 'Cancel' : 'Back'}
              </Button>
              {isLast ? (
                <Button variant="primary" onClick={submit} disabled={!canSave || busy}>
                  {busy && <Spinner className="border-accent-ink/40 border-t-accent-ink" />}
                  Save workflow
                </Button>
              ) : (
                <Button variant="primary" onClick={() => setStep((s) => s + 1)} disabled={!stepValid}>
                  Next
                </Button>
              )}
            </div>
            </div>
          </motion.div>
        )}
      </div>
    </Dialog>
  )
}
