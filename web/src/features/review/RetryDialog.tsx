import { findRunSourceInput, type RunTarget, type StagingItem } from '@comfy-commerce/shared'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { useCreateRun, useRun } from '../../api/hooks.js'
import { Dialog } from '../../components/ui/Dialog.js'
import { Spinner } from '../../components/ui/Spinner.js'
import { ICON, IconBox, Pencil, RotateCcw } from '../../lib/icons.js'
import { cn } from '../../lib/cn.js'

/** Re-run config handed to the RunSheet for the "Change inputs" path. */
export interface RerunConfig {
  workflowId: string
  params: Record<string, string>
  target: RunTarget
}

function Option({
  icon,
  title,
  body,
  onClick,
  disabled,
  busy,
}: {
  icon: React.ReactNode
  title: string
  body: string
  onClick: () => void
  disabled: boolean
  busy?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-start gap-3 rounded-xl border border-line bg-surface p-4 text-left transition-colors',
        'hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-soft">
        {busy ? <Spinner /> : <IconBox>{icon}</IconBox>}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="block text-sm text-ink-soft">{body}</span>
      </span>
    </button>
  )
}

/**
 * Retry a reviewed result: re-run the workflow that produced it. "Reuse inputs"
 * re-runs identically (a fresh generation); "Change inputs" opens the run sheet
 * pre-filled so the prompt/settings can be tweaked first. Both re-resolve the
 * source media from the originating run.
 */
export function RetryDialog({
  item,
  onClose,
  onChangeInputs,
}: {
  item: StagingItem | null
  onClose: () => void
  onChangeInputs: (config: RerunConfig) => void
}) {
  // Persist the last item so the content survives the close animation.
  const [shown, setShown] = useState(item)
  useEffect(() => {
    if (item) setShown(item)
  }, [item])

  const navigate = useNavigate()
  const { data: run, isLoading, isError } = useRun(shown?.runId ?? null)
  const createRun = useCreateRun()

  // The source media for this result lives on the originating run's items —
  // resolved by exact media id, never "the first item for this product" (#6).
  const source = run && shown ? findRunSourceInput(run, shown) : null
  const target: RunTarget | null = source ? { kind: 'selection', inputs: [source] } : null
  const ready = Boolean(run && target)

  const reuse = () => {
    if (!run || !target) return
    createRun.mutate(
      {
        storeId: run.storeId,
        workflowId: run.workflowId,
        providerId: run.providerId,
        params: run.params,
        target,
        stageAction: run.stageAction,
      },
      {
        onSuccess: () => {
          onClose()
          navigate('/activity')
        },
      },
    )
  }

  const change = () => {
    if (!run || !target) return
    onChangeInputs({ workflowId: run.workflowId, params: run.params, target })
    onClose()
  }

  return (
    <Dialog
      open={item !== null}
      onClose={onClose}
      title="Retry"
      subtitle={`Re-run ${shown?.recipeId ?? 'this workflow'} on this image.`}
    >
      <div className="space-y-2 px-5 pb-5">
        <Option
          icon={<Pencil {...ICON} />}
          title="Change inputs"
          body="Tweak the prompt and settings before re-running."
          onClick={change}
          disabled={!ready || createRun.isPending}
        />
        <Option
          icon={<RotateCcw {...ICON} />}
          title="Reuse inputs"
          body="Re-run with the same prompt and settings for a new result."
          onClick={reuse}
          disabled={!ready || createRun.isPending}
          busy={createRun.isPending}
        />
        {isLoading && <p className="px-1 pt-1 text-sm text-ink-faint">Loading the original run…</p>}
        {/* The run was cleared from Activity — explain instead of leaving two
            silently disabled options. */}
        {isError && (
          <p className="px-1 pt-1 text-sm text-danger">
            The original run was cleared from Activity, so its inputs are gone — retry isn't
            available for this item.
          </p>
        )}
        {run && !target && (
          <p className="px-1 pt-1 text-sm text-danger">
            The exact source image for this result couldn't be found in the original run.
          </p>
        )}
      </div>
    </Dialog>
  )
}
