import { cn } from '../../lib/cn.js'

/**
 * CSS-only tooltip — appears after a 75ms hover (native title waits ~1s),
 * hides instantly. `side="left"` keeps the bubble inside overflow-hidden
 * list cards where a top-positioned tooltip would clip on the first row.
 */
export function Tooltip({
  content,
  side = 'top',
  className,
  children,
}: {
  content: React.ReactNode
  side?: 'top' | 'left'
  className?: string
  children: React.ReactNode
}) {
  return (
    <span className={cn('group/tip relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-30 w-max max-w-72 rounded-lg bg-ink px-3 py-2 text-sm whitespace-pre-line text-surface shadow-lift',
          'opacity-0 transition-opacity duration-150 group-hover/tip:opacity-100 group-hover/tip:delay-75',
          side === 'top' && 'bottom-full left-1/2 mb-2 -translate-x-1/2',
          side === 'left' && 'top-1/2 right-full mr-2 -translate-y-1/2',
        )}
      >
        {content}
      </span>
    </span>
  )
}
