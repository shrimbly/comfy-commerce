import type { Workflow } from '@comfy-commerce/shared'
import { Download, HardDrive, ICON, IconBox, Pencil, Trash2, TriangleAlert } from '../../lib/icons.js'
import { motion } from 'motion/react'

import { Tooltip } from '../../components/ui/Tooltip.js'
import { cn } from '../../lib/cn.js'
import { gradientFor } from '../../lib/gradient.js'
import { easeSoft } from '../../lib/motion.js'
import { ThumbMedia } from './ThumbMedia.js'

const ENGINES = [
  { id: 'comfy-local', label: 'Local' },
  { id: 'comfy-cloud', label: 'Cloud' },
] as const

function RowAction({
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
        'flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-all cursor-pointer',
        'opacity-0 group-hover:opacity-100',
        danger ? 'hover:bg-danger-soft hover:text-danger' : 'hover:bg-surface-2 hover:text-ink',
      )}
    >
      <IconBox>{children}</IconBox>
    </button>
  )
}

export function WorkflowRow({
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
  // Where it CAN'T run nowhere = a real warning; "cloud only" is just information.
  const compatNote = !anyCompatible
    ? { Icon: TriangleAlert, tone: 'text-danger', label: 'No engine can run this' }
    : localBad
      ? null // "cloud only" no longer surfaced here — the detail view's Runs on table covers it
      : { Icon: HardDrive, tone: 'text-ink-faint', label: 'Local only' }

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.3, ease: easeSoft }}
      onClick={onSelect}
      className={cn(
        'group flex items-center gap-4 border-b border-line px-4 py-3 last:border-b-0',
        onSelect && 'cursor-pointer transition-colors hover:bg-surface-2/50',
      )}
    >
      <div className="size-12 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2">
        {workflow.imageUrl ? (
          <ThumbMedia src={workflow.imageUrl} className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full" style={gradientFor(workflow.id)} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p title={workflow.name} className="truncate text-sm font-medium">
          {workflow.name}
        </p>
        {workflow.description && (
          <p className="mt-1 truncate text-sm text-ink-faint">{workflow.description}</p>
        )}
      </div>

      {/* Slot always reserved so params and actions align down the list. */}
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center',
          (incompatible.length === 0 || !compatNote) && 'invisible',
        )}
      >
        {incompatible.length > 0 && compatNote && (
          <Tooltip side="left" content={`${compatNote.label}\n${compatDetail}`}>
            <IconBox className={compatNote.tone}>
              <compatNote.Icon {...ICON} />
            </IconBox>
          </Tooltip>
        )}
      </span>

      <span className="w-16 shrink-0 text-right text-sm text-ink-faint">
        {workflow.params.length > 0 &&
          `${workflow.params.length} param${workflow.params.length === 1 ? '' : 's'}`}
      </span>

      <a
        href={`/api/workflows/${workflow.id}/download`}
        download
        onClick={(e) => e.stopPropagation()}
        aria-label={`Download ${workflow.name}`}
        title="Download workflow JSON for ComfyUI"
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-all cursor-pointer',
          'opacity-0 group-hover:opacity-100 hover:bg-surface-2 hover:text-ink',
        )}
      >
        <IconBox>
          <Download {...ICON} />
        </IconBox>
      </a>
      {workflow.source === 'user' && onEdit && (
        <RowAction label={`Edit ${workflow.name}`} onClick={onEdit}>
          <Pencil {...ICON} />
        </RowAction>
      )}
      {workflow.source === 'user' && onDelete && (
        <RowAction label={`Delete ${workflow.name}`} onClick={onDelete} danger>
          <Trash2 {...ICON} />
        </RowAction>
      )}
    </motion.article>
  )
}
