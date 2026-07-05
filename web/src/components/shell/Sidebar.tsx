import { Activity, ChevronDown, ICON, IconBox, Images, Link2, NotebookPen, ShieldCheck, Workflow } from '../../lib/icons.js'
import { AnimatePresence, motion } from 'motion/react'
import { memo, useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router'

import { MoonIcon } from '../../lib/animated-icons/MoonIcon.js'
import { SunIcon } from '../../lib/animated-icons/SunIcon.js'
import { animatedIcon } from '../../lib/animated-icons/registry.js'
import { StoreAvatar } from '../ui/StoreAvatar.js'
import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'
import { warmRoute } from '../../lib/routeWarm.js'
import { useStoreContext } from '../../store/StoreContext.js'
import { useTheme } from '../../theme/ThemeProvider.js'
import { BlurDivider } from '../ui/BlurDivider.js'
import { BrandMark } from './BrandMark.js'

const NAV = [
  { to: '/connectors', label: 'Connections', icon: Link2 },
  { to: '/workflows', label: 'Workflows', icon: Workflow },
  { to: '/browse', label: 'Browse products', icon: Images },
  { to: '/prompts', label: 'Prompts', icon: NotebookPen },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/review', label: 'Review & publish', icon: ShieldCheck },
]

/** Strip the `.myshopify.com` suffix so only the store name shows. */
const storeName = (domain: string) => domain.replace(/\.myshopify\.com$/, '')

/** Open/close state for a foot-of-sidebar popover that dismisses on outside click. */
function useDismissablePopover<T extends HTMLElement>() {
  const [open, setOpen] = useState(false)
  const ref = useRef<T>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [])

  return { open, setOpen, ref }
}

/** Active-store selector — lives at the foot of the sidebar, opens upward. */
function StoreSwitcher() {
  const { stores, activeStore, setActiveStoreId } = useStoreContext()
  const { open, setOpen, ref } = useDismissablePopover<HTMLDivElement>()

  if (!activeStore) return null

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full items-center gap-2 rounded-xl border border-line bg-surface px-2 text-sm transition-colors hover:bg-surface-2 cursor-pointer"
      >
        <StoreAvatar faviconUrl={activeStore.faviconUrl} className="size-5" />
        <span className="truncate text-ink-soft">
          {activeStore.shopName || storeName(activeStore.domain)}
        </span>
        <IconBox
          className={cn('ml-auto text-ink-faint transition-transform duration-200', open && 'rotate-180')}
        >
          <ChevronDown {...ICON} />
        </IconBox>
      </button>

      <AnimatePresence>
        {open && stores.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.99 }}
            transition={{ duration: 0.22, ease: easeSoft }}
            className="absolute bottom-full left-0 z-40 mb-2 w-full overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-lift"
          >
            {stores.map((store) => (
              <button
                key={store.id}
                onClick={() => {
                  setActiveStoreId(store.id)
                  setOpen(false)
                }}
                className={cn(
                  'flex h-9 w-full items-center gap-3 rounded-lg px-2 text-left text-sm cursor-pointer',
                  'transition-colors hover:bg-surface-2',
                  store.id === activeStore.id ? 'text-ink' : 'text-ink-soft',
                )}
              >
                <StoreAvatar faviconUrl={store.faviconUrl} className="size-5" />
                <span className="truncate">{store.shopName || storeName(store.domain)}</span>
                {store.id === activeStore.id && (
                  <span className="ml-auto size-2 shrink-0 rounded-full bg-ink" />
                )}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Single light/dark toggle — flips the theme on click. Sits beside the store selector. */
function ThemeToggle() {
  const { resolved, setPreference } = useTheme()
  const isDark = resolved === 'dark'
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode'
  const [hovered, setHovered] = useState(false)
  const state = hovered ? 'hover' : 'rest'

  return (
    <button
      onClick={() => setPreference(isDark ? 'light' : 'dark')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={label}
      aria-label={label}
      className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink cursor-pointer"
    >
      <IconBox>
        {isDark ? <SunIcon size={18} animate={state} /> : <MoonIcon size={18} animate={state} />}
      </IconBox>
    </button>
  )
}

/** A single nav row. Hovering it plays the icon's animation (when one exists). */
function NavItem({
  to,
  label,
  Icon,
  active,
  pendingCount,
}: {
  to: string
  label: string
  Icon: typeof Link2
  active: boolean
  pendingCount: number
}) {
  const [hovered, setHovered] = useState(false)
  // Nav route → animation key is the path without its leading slash.
  const Animated = animatedIcon(to.slice(1))

  return (
    <NavLink
      to={to}
      onMouseEnter={() => {
        setHovered(true)
        warmRoute(to)
      }}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => warmRoute(to)}
      className={cn(
        'relative flex h-9 items-center gap-2 rounded-xl px-2 text-sm font-medium',
        'transition-colors duration-200',
        active ? 'text-ink' : 'text-ink-soft hover:bg-surface-2 hover:text-ink',
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-xl border border-line bg-surface-2"
          transition={{ duration: 0.4, ease: easeSoft }}
        />
      )}
      <IconBox className="relative">
        {Animated ? <Animated size={18} animate={hovered ? 'hover' : 'rest'} /> : <Icon {...ICON} />}
      </IconBox>
      <span className="relative">{label}</span>
      {to === '/review' && pendingCount > 0 && (
        <motion.span
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.3, ease: easeSoft }}
          className="relative ml-auto flex h-5 min-w-5 items-center justify-center rounded-lg bg-info px-1 text-sm font-medium text-surface"
        >
          {pendingCount}
        </motion.span>
      )}
    </NavLink>
  )
}

/** memo: the only prop is the primitive pendingCount, so shell state churn
 *  (CTA width reports, staging polls) skips re-reconciling the ~15 motion
 *  components in here. Route/store/theme updates still propagate — they arrive
 *  via useLocation/useStoreContext/useTheme, and context bypasses memo. */
export const Sidebar = memo(function Sidebar({ pendingCount }: { pendingCount: number }) {
  const location = useLocation()

  return (
    <aside className="sticky top-0 h-full w-64 shrink-0 p-3 pr-0">
      <div className="flex h-full flex-col rounded-2xl border border-line bg-surface shadow-soft">
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <BrandMark className="size-9 shrink-0" />
            <div>
              <span className="block text-sm leading-5 font-medium">Comfy Commerce</span>
              <p className="text-sm leading-5 text-ink-faint">Product media studio</p>
            </div>
          </div>
        </div>

        <BlurDivider className="mx-4 mb-2" />

        <nav className="flex flex-col gap-1 px-2">
          {NAV.map(({ to, label, icon }) => (
            <NavItem
              key={to}
              to={to}
              label={label}
              Icon={icon}
              active={location.pathname.startsWith(to)}
              pendingCount={pendingCount}
            />
          ))}
        </nav>

        <div className="mt-auto px-2 pb-3">
          <div className="flex items-center gap-1">
            <StoreSwitcher />
            <ThemeToggle />
          </div>
          <BlurDivider className="mx-2 my-3" />
          <p className="flex items-center gap-2 px-2 text-sm text-ink-faint">
            <IconBox className="text-success">
              <ShieldCheck {...ICON} />
            </IconBox>
            Private, local, review-gated.
          </p>
        </div>
      </div>
    </aside>
  )
})
