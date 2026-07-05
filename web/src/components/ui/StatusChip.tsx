import type { StagingState } from '@comfy-commerce/shared'

import { cn } from '../../lib/cn.js'

export const STATUS_STYLES: Record<StagingState, { label: string; className: string; dot: string }> = {
  pending: { label: 'Pending', className: 'bg-warn-soft text-warn', dot: 'bg-warn' },
  approved: { label: 'Approved', className: 'bg-success-soft text-success', dot: 'bg-success' },
  publishing: { label: 'Publishing…', className: 'bg-surface-2 text-ink-soft', dot: 'bg-ink-soft animate-pulse' },
  published: { label: 'Published', className: 'bg-success-soft text-success', dot: 'bg-success' },
  rejected: { label: 'Rejected', className: 'bg-surface-2 text-ink-faint', dot: 'bg-ink-faint' },
  failed: { label: 'Failed', className: 'bg-danger-soft text-danger', dot: 'bg-danger' },
}

export function StatusChip({ state, className }: { state: StagingState; className?: string }) {
  const style = STATUS_STYLES[state]
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-2 rounded-lg px-2 text-sm font-medium whitespace-nowrap',
        style.className,
        className,
      )}
    >
      <span className={cn('size-2.5 rounded-full', style.dot)} />
      {style.label}
    </span>
  )
}
