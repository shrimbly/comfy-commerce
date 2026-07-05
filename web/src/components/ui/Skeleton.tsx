import { cn } from '../../lib/cn.js'

/**
 * A neutral pulsing placeholder block. Compose with width/height/shape utility
 * classes (e.g. `<Skeleton className="h-4 w-32" />`). Defaults to a small radius;
 * pass `rounded-*` to override.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-2', className)} />
}
