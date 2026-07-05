import { motion, useIsPresent } from 'motion/react'
import { cloneElement, isValidElement, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router'

import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'
import { ctaKeyOf, useCtaSlot, useNavTransition } from '../../lib/navDirection.js'

/** Reframed page titles — short action phrases, keyed by route prefix. */
const TITLES: Array<[string, string]> = [
  ['/connectors', 'Connect a store'],
  ['/workflows', 'Manage workflows'],
  ['/prompts', 'Manage prompts'],
  ['/browse', 'Browse products'],
  ['/activity', 'Track activity'],
  // Longest prefix first — TITLES matches by startsWith in order.
  ['/review/finalize', 'Finalize & publish'],
  ['/review', 'Review & publish'],
]

/** Strip a primary Button's own background + shadow so only its label paints —
 *  the crisp shell pill provides the background underneath. (twMerge keeps the
 *  later classes, so bg-accent/shadow-soft are overridden; hover is kept.) */
function stripBackground(actions: React.ReactNode): React.ReactNode {
  if (!isValidElement<{ className?: string }>(actions)) return actions
  return cloneElement(actions, {
    className: cn(actions.props.className, 'bg-transparent shadow-none'),
  })
}

/**
 * The page's title + one-line description, rendered on the bare canvas above
 * the page's content card(s) — not inside a container of its own. The title is
 * derived from the route; the description is passed per page.
 *
 * The CTA (`actions`) is NOT rendered here in-flow — it's portaled into the
 * shell's single crisp pill (see AppShell), which lives outside the page-blur
 * transition. That keeps the button background sharp and solid while only the
 * label blur-crossfades as pages swap.
 */
export function PageHeader({
  subtitle,
  actions,
  inlineActions,
}: {
  subtitle?: string
  /** Single primary CTA, rendered in the shell's animated pill (top-right). */
  actions?: React.ReactNode
  /** Multiple page-level actions, rendered in-flow on the title row instead of
   *  the single pill — use when a page needs more than one button. */
  inlineActions?: React.ReactNode
}) {
  const { pathname } = useLocation()
  const title = TITLES.find(([path]) => pathname.startsWith(path))?.[1] ?? 'Comfy Commerce'
  const present = useIsPresent()
  const key = ctaKeyOf(pathname)
  const slot = useCtaSlot()
  const { reportWidth, setActiveKey } = useNavTransition()

  // The present (incoming) page owns the pill: publish whether it has a CTA and
  // at what key, so the shell pill knows its target width and visibility. The
  // exiting page must not clobber this, hence the `present` guard.
  useLayoutEffect(() => {
    if (present) setActiveKey(actions ? key : null)
  }, [present, actions, key, setActiveKey])

  // Measure the label's natural width so the pill can scale to it (a crisp width
  // morph). The ref callback measures once when the label attaches — pre-paint,
  // so the pill still has its width on the first painted frame — and then a
  // ResizeObserver tracks real size changes without forcing a synchronous
  // layout on every render. reportWidth is equality-guarded.
  const measureRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return
      const report = () => {
        const w = el.offsetWidth
        if (w) reportWidth(key, w)
      }
      report()
      const observer = new ResizeObserver(report)
      observer.observe(el)
      return () => observer.disconnect()
    },
    [key, reportWidth],
  )

  const label = slot && actions
    ? createPortal(
        <motion.div
          // Right-aligned inside the pill, clipped by it during the width morph.
          // Only the label blurs — the pill background stays crisp.
          className="pointer-events-auto absolute inset-y-0 right-0 flex items-center whitespace-nowrap"
          initial={{ opacity: present ? 0 : 1, filter: present ? 'blur(6px)' : 'blur(0px)' }}
          animate={{ opacity: present ? 1 : 0, filter: present ? 'blur(0px)' : 'blur(6px)' }}
          transition={{ duration: 0.34, ease: easeSoft }}
        >
          <div ref={measureRef} className="w-max">
            {stripBackground(actions)}
          </div>
        </motion.div>,
        slot,
      )
    : null

  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: easeSoft }}
        className="min-w-0"
      >
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 max-w-xl text-sm text-ink-soft">{subtitle}</p>}
      </motion.div>
      {inlineActions ? (
        <div className="flex shrink-0 items-center gap-2">{inlineActions}</div>
      ) : (
        label
      )}
    </div>
  )
}
