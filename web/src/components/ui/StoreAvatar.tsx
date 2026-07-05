import { Store } from '../../lib/icons.js'
import { cn } from '../../lib/cn.js'

/**
 * A connected store's visual: its storefront favicon when we could fetch one,
 * otherwise a Shopify-green fallback mark (dev / password-protected stores and
 * the demo store have no fetchable favicon).
 */
export function StoreAvatar({
  faviconUrl,
  className,
}: {
  faviconUrl?: string | null
  className?: string
}) {
  if (faviconUrl) {
    return (
      <img
        src={faviconUrl}
        alt=""
        className={cn('size-6 shrink-0 rounded-[6px] object-cover', className)}
      />
    )
  }
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-[#5e8e3e] text-white',
        className,
      )}
    >
      <Store size={14} />
    </span>
  )
}
