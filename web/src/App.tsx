import type { Catalog } from './api/hooks.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import type { ComponentType } from 'react'
import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'

import { prefetchCatalog, prefetchWorkflows } from './api/hooks.js'
import { AppShell } from './components/shell/AppShell.js'
import { UnlockGate } from './features/auth/UnlockGate.js'
import { ConnectorsPage } from './features/connectors/ConnectorsPage.js'
import { gridPreviewUrl } from './lib/media.js'
import { easeSoft } from './lib/motion.js'
import { NavDirectionProvider } from './lib/navDirection.js'
import { registerRouteWarm } from './lib/routeWarm.js'
import { StoreProvider, useStoreContext } from './store/StoreContext.js'
import { ThemeProvider } from './theme/ThemeProvider.js'

// ConnectorsPage (the boot landing route) stays eager so first open renders in
// one pass; the other five pages are route-split so their code never delays
// frame one. Their chunks are all warmed right after first paint (see WarmBoot
// below) and on sidebar hover, so the null Suspense fallback never actually
// renders on navigation — every route transition finds its module in memory.

/** lazy() with a synchronous fast path: once the preload resolves, the wrapper
 * renders the real component directly — no suspend, no fallback commit, no
 * second render pass landing mid page-transition. React.lazy alone still
 * suspends on its first render even when the chunk is already evaluated. */
function preloadable(loader: () => Promise<ComponentType>) {
  let Ready: ComponentType | null = null
  let promise: Promise<ComponentType> | null = null
  const load = () =>
    (promise ??= loader().then(
      (c) => (Ready = c),
      (err: unknown) => {
        // A transient warm failure must not brick the route: drop the cached
        // rejection so the next hover/mount retries with a fresh import().
        promise = null
        throw err
      },
    ))
  const Lazy = lazy(async () => ({ default: await load() }))
  const Component = () => {
    // Pin the path per mount: flipping Lazy → Ready on a later re-render
    // would change the element type and remount the page (state loss).
    const [Impl] = useState(() => Ready)
    return Impl ? <Impl /> : <Lazy />
  }
  return {
    Component,
    preload: () => {
      load().catch(() => {}) // warm is best-effort; render-path retries fresh
    },
  }
}

const PAGES = {
  '/workflows': preloadable(async () => (await import('./features/workflows/WorkflowsPage.js')).WorkflowsPage),
  '/prompts': preloadable(async () => (await import('./features/prompts/PromptsPage.js')).PromptsPage),
  '/browse': preloadable(async () => (await import('./features/browse/BrowsePage.js')).BrowsePage),
  '/activity': preloadable(async () => (await import('./features/activity/ActivityPage.js')).ActivityPage),
  '/review': preloadable(async () => (await import('./features/review/ReviewPage.js')).ReviewPage),
  '/review/finalize': preloadable(async () => (await import('./features/review/FinalizePage.js')).FinalizePage),
}

for (const [path, page] of Object.entries(PAGES)) registerRouteWarm(path, page.preload)

const WorkflowsPage = PAGES['/workflows'].Component
const PromptsPage = PAGES['/prompts'].Component
const BrowsePage = PAGES['/browse'].Component
const ActivityPage = PAGES['/activity'].Component
const ReviewPage = PAGES['/review'].Component
const FinalizePage = PAGES['/review/finalize'].Component

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

/** Freeze an element at its current rendered width (kept centered), so an
 *  ancestor width animation no longer reflows it. */
function pinWidth(el: HTMLElement) {
  el.style.width = `${el.offsetWidth}px`
  el.style.maxWidth = 'none'
  el.style.justifySelf = 'center'
}

function AnimatedRoutes() {
  const location = useLocation()
  const prevPathRef = useRef(location.pathname)

  // Pin the OUTGOING page's width the moment it starts exiting. Otherwise the
  // shell's width animation reflows its image grid every frame, and reflowing
  // under the exit blur is what strobed on Retina. The fading page blurs out at
  // its width instead of shrinking too; the incoming page still resizes as
  // before, and height/scroll are untouched.
  useLayoutEffect(() => {
    if (prevPathRef.current === location.pathname) return
    const outgoing = document.querySelector<HTMLElement>(`[data-route="${CSS.escape(prevPathRef.current)}"]`)
    if (outgoing) pinWidth(outgoing)
    prevPathRef.current = location.pathname
  }, [location.pathname])

  return (
    // Single-cell grid: the outgoing and incoming pages share one cell
    // ([grid-area:1/1]) and blur-cross-dissolve — the old page defocuses + fades
    // out while the new one focuses + fades in. Content is never blank between
    // pages (no "valley"), and the soft blur keeps the overlap gentle. The
    // top-right CTA can't ghost because PageHeader hides the exiting page's
    // actions (useIsPresent); the incoming CTA sharpens in with its page (the
    // parent blur filter applies to it too). AnimatePresence freezes the exiting
    // element, so it keeps rendering its own (old) route.
    //
    // grid-cols-1 (minmax(0,1fr)) + min-w-0 stop the pinned-width outgoing page
    // (see pinWidth above) from dragging the shared column wide via min-content —
    // so the incoming page resizes to its real target while the frozen page just
    // overflows the column as it fades.
    <div className="grid grid-cols-1 min-w-0">
      <AnimatePresence initial={false}>
        <motion.div
          key={location.pathname}
          data-route={location.pathname}
          className="[grid-area:1/1] min-w-0 will-change-[filter,opacity]"
          initial={{ opacity: 0, filter: 'blur(8px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, filter: 'blur(8px)' }}
          transition={{ duration: 0.4, ease: easeSoft }}
        >
          {/* Suspense sits INSIDE the animated container so the container's
              mount timing — and with it every route transition — is unchanged
              by the code splitting. */}
          <Suspense fallback={null}>
            <Routes location={location}>
              <Route path="/" element={<Navigate to="/connectors" replace />} />
              <Route path="/connectors" element={<ConnectorsPage />} />
              <Route path="/workflows" element={<WorkflowsPage />} />
              <Route path="/prompts" element={<PromptsPage />} />
              <Route path="/browse" element={<BrowsePage />} />
              <Route path="/activity" element={<ActivityPage />} />
              <Route path="/review" element={<ReviewPage />} />
              <Route path="/review/finalize" element={<FinalizePage />} />
            </Routes>
          </Suspense>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

/** One-shot warm-up right after first paint, so the first navigation takes the
 * same (smooth) path as a return visit: route chunks are evaluated, the
 * catalog + workflows queries are in cache, and the first screenful of grid
 * images is fetched/decoded — none of that work can land inside a page
 * transition. The idle timeout guarantees the warm runs within 250ms even on
 * a busy boot (an untimed idle callback can lose the race to a fast click). */
function WarmBoot() {
  const { activeStore } = useStoreContext()
  const storeId = activeStore?.id
  useEffect(() => {
    const warm = () => {
      for (const page of Object.values(PAGES)) page.preload()
      void prefetchWorkflows(queryClient)
      if (!storeId) return
      void prefetchCatalog(queryClient, storeId).then(() => {
        const catalog = queryClient.getQueryData<Catalog>(['catalog', storeId])
        const firstScreen = (catalog?.products ?? [])
          .flatMap((p) => p.media)
          .filter((m) => m.mediaType === 'image')
          .slice(0, 12)
        for (const media of firstScreen) {
          const img = new Image()
          img.decoding = 'async'
          img.src = gridPreviewUrl(media.url)
        }
      })
    }
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(warm, { timeout: 250 })
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(warm, 250)
    return () => clearTimeout(id)
  }, [storeId])
  return null
}

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        {/* Token gate for BROKER_API_TOKEN brokers — portals its dialog to
            document.body and only needs the query client, so it sits outside
            the router/store tree. */}
        <UnlockGate />
        <StoreProvider>
          <WarmBoot />
          <BrowserRouter>
            <NavDirectionProvider>
              <AppShell>
                <AnimatedRoutes />
              </AppShell>
            </NavDirectionProvider>
          </BrowserRouter>
        </StoreProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
