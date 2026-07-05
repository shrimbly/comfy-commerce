import { ChevronDown } from '../../lib/icons.js'

import { cn } from '../../lib/cn.js'

/** Styled native select — custom chevron with proper spacing on both sides. */
export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cn('relative inline-flex', className)}>
      <select
        {...props}
        className={cn(
          'h-8 cursor-pointer appearance-none rounded-lg border border-line bg-surface pr-8 pl-3',
          'text-sm text-ink-soft outline-none transition-colors hover:bg-surface-2 focus:border-ink',
        )}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-faint">
        <ChevronDown size={14} strokeWidth={1.5} absoluteStrokeWidth />
      </span>
    </span>
  )
}
