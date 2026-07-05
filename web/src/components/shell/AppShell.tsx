import { motion } from 'motion/react'
import { useState } from 'react'
import { useLocation } from 'react-router'

import { useStaging } from '../../api/hooks.js'
import { easeSoft } from '../../lib/motion.js'
import { CtaSlotContext, useNavTransition } from '../../lib/navDirection.js'
import { Sidebar } from './Sidebar.js'

/**
 * Per-page content width (px — the Tailwind max-w-3xl/5xl/7xl values). A visual
 * grid wants room; row listings read better capped; settings/timeline content
 * narrower still. Content is centered, so on wide screens it no longer stretches
 * edge to edge. The width is *animated* (see below) rather than a static class.
 */
const PAGE_WIDTHS: Array<[string, number]> = [
  ['/browse', 1280], // max-w-7xl — image grid, give it room
  ['/activity', 1024], // max-w-5xl — run list
  ['/review', 1024],
  ['/workflows', 1024],
  ['/connectors', 768], // max-w-3xl — settings-like
  ['/prompts', 768],
]

export function AppShell({ children }: { children: React.ReactNode }) {
  // Subscribe to just the pending count — the shell (and via this prop the
  // whole sidebar) re-renders only when the badge number changes, not on every
  // staged-item field the 5s poll returns.
  const { data: pending } = useStaging(undefined, { select: (d) => d.counts.pending })
  const pendingCount = pending ?? 0
  const { pathname } = useLocation()
  const maxWidth = PAGE_WIDTHS.find(([path]) => pathname.startsWith(path))?.[1] ?? 1024

  // The single, crisp CTA pill. It sits OUTSIDE the page-blur transition, so its
  // background stays sharp and solid as you navigate; pages portal only their
  // (background-stripped) label into `slot`, where labels blur-crossfade. The
  // pill scales its width to the active page's CTA — a real width animation
  // (not a transform), so the pill never distorts.
  const { widths, activeKey } = useNavTransition()
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const pillWidth = activeKey ? widths[activeKey] : 0

  return (
    <div className="app-bg flex h-screen flex-col overflow-hidden">
      {/* macOS desktop only: a full-width, draggable strip above everything that
          houses the inlaid traffic-light buttons (sized/styled in index.css).
          Zero-height — and so invisible — in the browser and on Windows. */}
      <div className="app-titlebar" />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar pendingCount={pendingCount} />
        {/* No page-level card — each page puts its title/description on the bare
            canvas and wraps only its functionality in its own container, centered
            within a per-page max width. The max-width is animated so navigating
            between pages of different widths *stretches* the content to the new
            width in step with the crossfade, rather than snapping the (still
            visible) outgoing page to the target width before it fades. */}
        <main className="min-w-0 flex-1 overflow-y-auto">
        {/* Top padding is tuned so every page's title bottom-aligns with the
            sidebar's "Comfy Commerce" title (pt-5 + a 3px nudge lower). */}
        <motion.div
          className="relative mx-auto w-full px-8 pt-[23px] pb-7"
          initial={false}
          animate={{ maxWidth }}
          transition={{ duration: 0.4, ease: easeSoft }}
        >
          {/* Crisp CTA pill — aligned to the PageHeader's top-right. */}
          <motion.div
            className="pointer-events-none absolute right-8 top-[23px] z-10 h-8 overflow-hidden rounded-lg bg-accent shadow-soft"
            initial={false}
            animate={{ width: pillWidth, opacity: activeKey ? 1 : 0 }}
            transition={{ duration: 0.34, ease: easeSoft }}
          >
            <div ref={setSlot} className="relative h-full" />
          </motion.div>
          <CtaSlotContext.Provider value={slot}>{children}</CtaSlotContext.Provider>
        </motion.div>
        </main>
      </div>
    </div>
  )
}
