import { cn } from '../../lib/cn.js'

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block size-4 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent',
        className,
      )}
      aria-label="Loading"
    />
  )
}
