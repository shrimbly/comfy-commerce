import type { Workflow } from '@comfy-commerce/shared'
import { Download, HardDrive, ICON, IconBox, Pencil, Trash2, TriangleAlert } from '../../lib/icons.js'
import { motion } from 'motion/react'

import { Tooltip } from '../../components/ui/Tooltip.js'
import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'
import { HoverWipe } from './HoverWipe.js'

const ENGINES = [
  { id: 'comfy-local', label: 'Local' },
  { id: 'comfy-cloud', label: 'Cloud' },
] as const

/** A floating action over the thumbnail (edit / delete), revealed on hover. */
function CardAction({
  label,
  onClick,
  danger,
  children,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-7 items-center justify-center rounded-lg bg-surface/80 text-ink-soft backdrop-blur-sm transition-all cursor-pointer',
        danger ? 'hover:bg-danger-soft hover:text-danger' : 'hover:bg-surface hover:text-ink',
      )}
    >
      <IconBox>{children}</IconBox>
    </button>
  )
}

/**
 * Grid-view card: a 4:3 tile whose top is the full-bleed thumbnail (with the
 * hover-wipe comparison) and whose bottom is a white inset panel — floated 4px
 * off the grey card edges — holding the title and description.
 */
export function WorkflowCard({
  workflow,
  onSelect,
  onEdit,
  onDelete,
}: {
  workflow: Workflow
  onSelect?: () => void
  onEdit?: () => void
  onDelete?: () => void
}) {
  const incompatible = ENGINES.filter((engine) => workflow.compat[engine.id]?.compatible === false)
  const anyCompatible = ENGINES.some((engine) => workflow.compat[engine.id]?.compatible === true)
  const compatDetail = incompatible
    .map((engine) => `${engine.label} is missing: ${workflow.compat[engine.id]!.missingNodes.join(', ')}`)
    .join('\n')
  const localBad = incompatible.some((engine) => engine.id === 'comfy-local')
  const compatNote = !anyCompatible
    ? { Icon: TriangleAlert, tone: 'text-danger', label: 'No engine can run this' }
    : localBad
      ? null // "cloud only" no longer surfaced here — the detail view's Runs on table covers it
      : { Icon: HardDrive, tone: 'text-ink-faint', label: 'Local only' }

  const editable = workflow.source === 'user'

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.3, ease: easeSoft }}
      onClick={onSelect}
      className={cn(
        'group relative aspect-[4/3] rounded-2xl border border-line bg-surface-2',
        onSelect && 'cursor-pointer',
      )}
    >
      <HoverWipe
        base={workflow.imageUrl}
        compare={workflow.compareImageUrl}
        seed={workflow.id}
        alt={workflow.name}
        className="absolute inset-0 rounded-2xl"
      />

      {incompatible.length > 0 && compatNote && (
        <span className="absolute top-2 left-2">
          <Tooltip side="top" content={`${compatNote.label}\n${compatDetail}`}>
            <span
              className={cn(
                'flex size-7 items-center justify-center rounded-lg bg-surface/80 backdrop-blur-sm',
                compatNote.tone,
              )}
            >
              <IconBox>
                <compatNote.Icon {...ICON} />
              </IconBox>
            </span>
          </Tooltip>
        </span>
      )}

      <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <a
          href={`/api/workflows/${workflow.id}/download`}
          download
          onClick={(e) => e.stopPropagation()}
          aria-label={`Download ${workflow.name}`}
          title="Download workflow JSON for ComfyUI"
          className="flex size-7 items-center justify-center rounded-lg bg-surface/80 text-ink-soft backdrop-blur-sm transition-all cursor-pointer hover:bg-surface hover:text-ink"
        >
          <IconBox>
            <Download {...ICON} />
          </IconBox>
        </a>
        {editable && onEdit && (
          <CardAction label={`Edit ${workflow.name}`} onClick={onEdit}>
            <Pencil {...ICON} />
          </CardAction>
        )}
        {editable && onDelete && (
          <CardAction label={`Delete ${workflow.name}`} onClick={onDelete} danger>
            <Trash2 {...ICON} />
          </CardAction>
        )}
      </div>

      {/* White text container floating over the bottom of the thumbnail — 4px gap.
          pointer-events-none so the hover-wipe tracks underneath. */}
      <div className="pointer-events-none absolute inset-x-1 bottom-1 rounded-xl bg-surface px-3 py-2">
        <p title={workflow.name} className="truncate text-sm font-medium">
          {workflow.name}
        </p>
        {workflow.description ? (
          <p className="mt-0.5 truncate text-sm text-ink-faint">{workflow.description}</p>
        ) : (
          <p className="mt-0.5 truncate text-sm text-ink-faint">
            {workflow.params.length > 0
              ? `${workflow.params.length} param${workflow.params.length === 1 ? '' : 's'}`
              : 'No parameters'}
          </p>
        )}
      </div>
    </motion.article>
  )
}
