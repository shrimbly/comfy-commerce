import { createContext, useCallback, useContext, useState } from 'react'

/**
 * Backing store for the shell's single, crisp CTA pill. The pill lives in the
 * AppShell (outside the page-blur transition) so its background stays sharp and
 * solid during navigation; each page portals only its *label* into the pill,
 * where labels blur-crossfade. This context carries:
 *  - widths:     natural label width (px) per page, so the pill can scale to the
 *                incoming page's width (a crisp width morph, no distortion).
 *  - activeKey:  which page currently owns the CTA (null when the page has none),
 *                set by the present page — drives the pill's width + visibility.
 */
type NavValue = {
  widths: Record<string, number>
  reportWidth: (key: string, width: number) => void
  activeKey: string | null
  setActiveKey: (key: string | null) => void
}

const Ctx = createContext<NavValue>({
  widths: {},
  reportWidth: () => {},
  activeKey: null,
  setActiveKey: () => {},
})

/** The DOM node inside the shell pill that pages portal their label into. */
export const CtaSlotContext = createContext<HTMLElement | null>(null)

export function NavDirectionProvider({ children }: { children: React.ReactNode }) {
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [activeKey, setActiveKey] = useState<string | null>(null)
  // Equality-guarded so a no-op report returns the SAME object → React bails the
  // re-render (measuring runs every render, so this must never churn state).
  const reportWidth = useCallback((key: string, width: number) => {
    setWidths((cur) => (cur[key] === width ? cur : { ...cur, [key]: width }))
  }, [])
  return <Ctx.Provider value={{ widths, reportWidth, activeKey, setActiveKey }}>{children}</Ctx.Provider>
}

// The pages that carry a header CTA (sidebar order). Used only to give each a
// stable width-cache key (so e.g. /review and /review/* share one entry).
const CTA_PATHS = ['/connectors', '/workflows', '/prompts', '/review']

/** A path's CTA identity — its CTA_PATHS prefix, or the full path otherwise. */
export function ctaKeyOf(path: string): string {
  return CTA_PATHS.find((o) => path.startsWith(o)) ?? path
}

export function useNavTransition(): NavValue {
  return useContext(Ctx)
}

export function useCtaSlot(): HTMLElement | null {
  return useContext(CtaSlotContext)
}
